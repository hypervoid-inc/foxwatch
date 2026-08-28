import { describe, expect, it } from "vitest";
import { http, secret } from "@foxwatch/config";
import {
  assertSafeUrl,
  bannerStatus,
  componentStatus,
  confirmFlip,
  statusDotColor,
  evaluateHttp,
  heartbeatOutcome,
  parseHomepageUrl,
  redactText,
  resolveHeaders,
  runHttpProbe,
  stripForbiddenHeaders,
  UrlPolicyError,
} from "./index.ts";

describe("url policy", () => {
  it("rejects userinfo, http, and private hosts", () => {
    expect(() => assertSafeUrl("https://user:pass@example.com")).toThrow(UrlPolicyError);
    expect(() => assertSafeUrl("http://example.com")).toThrow(/https_required/);
    expect(() => assertSafeUrl("https://127.0.0.1/health")).toThrow(/private_address/);
    expect(() => assertSafeUrl("https://192.168.1.1/")).toThrow(/private_address/);
    expect(() => assertSafeUrl("https://169.254.169.254/latest")).toThrow(/private_address/);
    expect(() => assertSafeUrl("file:///etc/passwd")).toThrow(/https_required/);
  });

  it("allows https public hosts and optional local http", () => {
    expect(assertSafeUrl("https://api.example.com/health").hostname).toBe("api.example.com");
    expect(assertSafeUrl("http://127.0.0.1:8787/health", { allowHttpLocal: true }).hostname).toBe(
      "127.0.0.1",
    );
  });

  it("treats homepage urls as links, not fetch targets", () => {
    expect(parseHomepageUrl("")).toBe(null);
    expect(parseHomepageUrl("https://construct.com/app")).toBe("https://construct.com/app");
    expect(parseHomepageUrl("http://example.com")).toBe("http://example.com/");
    expect(() => parseHomepageUrl("javascript:alert(1)")).toThrow(UrlPolicyError);
    expect(() => parseHomepageUrl("https://user:pass@evil.example/")).toThrow(UrlPolicyError);
  });
});

describe("secrets", () => {
  it("does not attach secrets off allowed hosts", () => {
    const { headers } = resolveHeaders(
      { Authorization: secret("API_HEALTH_TOKEN") },
      { API_HEALTH_TOKEN: "sekrit" },
      "evil.example",
      ["api.example.com"],
    );
    expect(headers.Authorization).toBeUndefined();
  });

  it("fails closed when the secret is missing on an allowed host", () => {
    const res = resolveHeaders(
      { Authorization: secret("API_HEALTH_TOKEN") },
      {},
      "api.example.com",
      ["api.example.com"],
    );
    expect(res.missingSecret).toBe("API_HEALTH_TOKEN");
  });

  it("strips hop-by-hop and cookie headers", () => {
    const out = stripForbiddenHeaders({
      Host: "evil",
      Cookie: "a=b",
      "CF-Connecting-IP": "1.1.1.1",
      Authorization: "Bearer x",
    });
    expect(out.Host).toBeUndefined();
    expect(out.Cookie).toBeUndefined();
    expect(out.Authorization).toBe("Bearer x");
  });

  it("redacts tokens from snippets", () => {
    expect(redactText("Authorization: Bearer abc.def", ["abc.def"])).not.toContain("abc.def");
    expect(redactText("Bearer super-secret-token")).toContain("[redacted]");
  });
});

describe("http eval", () => {
  it("passes, degrades on latency, fails on status", () => {
    expect(
      evaluateHttp({
        status: 200,
        headers: {},
        body: '{"ok":true}',
        latencyMs: 80,
        expect: { status: 200, jsonPath: { path: "$.ok", equals: true } },
      }).outcome,
    ).toBe("pass");
    expect(
      evaluateHttp({
        status: 200,
        headers: {},
        body: "ok",
        latencyMs: 10_000,
        expect: { status: 200 },
        timeoutMs: 10_000,
        degradedIf: { latencyMs: 200 },
      }).outcome,
    ).toBe("fail");
    expect(
      evaluateHttp({
        status: 200,
        headers: {},
        body: "ok",
        latencyMs: 900,
        expect: { status: 200 },
        timeoutMs: 10_000,
        degradedIf: { latencyMs: 200 },
      }).outcome,
    ).toBe("degraded");
    expect(
      evaluateHttp({
        status: 500,
        headers: {},
        body: "err",
        latencyMs: 10,
        expect: { status: 200 },
      }).outcome,
    ).toBe("fail");
  });

  it("rejects recursive jsonpath", () => {
    expect(
      evaluateHttp({
        status: 200,
        headers: {},
        body: "{}",
        latencyMs: 1,
        expect: { jsonPath: { path: "$..foo" } },
      }).errorClass,
    ).toBe("jsonpath");
  });
});

describe("runHttpProbe redirects", () => {
  it("strips secret headers when the redirect leaves allowedHosts", async () => {
    const seen: Array<{ url: string; auth?: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("cdn-cgi/trace")) {
        return new Response("colo=SFO\n");
      }
      const auth = new Headers(init?.headers).get("Authorization") ?? undefined;
      seen.push({ url, auth });
      if (url === "https://api.example.com/health") {
        return new Response(null, { status: 302, headers: { Location: "https://attacker.example/steal" } });
      }
      return new Response("gotcha", { status: 200 });
    };
    const check = http("api-health", {
      url: "https://api.example.com/health",
      allowedHosts: ["api.example.com"],
      headers: { Authorization: secret("API_HEALTH_TOKEN") },
      timeout: "5s",
      interval: "1m",
    });
    check.retries = 0;
    const result = await runHttpProbe(check, {
      secrets: { API_HEALTH_TOKEN: "sekrit-value" },
      allowHttpLocal: false,
      fetchImpl,
    });
    expect(seen[0]?.auth).toBe("sekrit-value");
    expect(seen).toHaveLength(1);
    expect(result.errorClass).toBe("redirect_host");
    expect(result.errorSnippet ?? "").not.toContain("sekrit-value");
  });
});

describe("status math", () => {
  it("uses majority quorum and critical banner", () => {
    expect(
      componentStatus([
        { region: "wnam", outcome: "fail" },
        { region: "weur", outcome: "pass" },
        { region: "apac", outcome: "pass" },
      ]),
    ).toBe("degraded");
    expect(
      componentStatus([
        { region: "wnam", outcome: "fail" },
        { region: "weur", outcome: "fail" },
        { region: "apac", outcome: "pass" },
      ]),
    ).toBe("failing");
    expect(bannerStatus([{ status: "failing", critical: true }])).toBe("failing");
    expect(bannerStatus([{ status: "failing", critical: false }])).toBe("degraded");
    expect(statusDotColor("fully_operational")).toBe("#0f9d7a");
    expect(statusDotColor("degraded")).toBe("#d97706");
    expect(statusDotColor("failing")).toBe("#e11d48");
    expect(statusDotColor("unknown")).toBe("#64748b");
    expect(statusDotColor("unexpected")).toBe("#64748b");
    expect(componentStatus([])).toBe("unknown");
    expect(bannerStatus([])).toBe("unknown");
    expect(bannerStatus([{ status: "unknown", critical: true }])).toBe("unknown");
    expect(componentStatus([], "majority", true)).toBe("maintenance");
    expect(bannerStatus([{ status: "maintenance", critical: true }])).toBe("fully_operational");
    expect(confirmFlip(2, "fail", 3).confirmedFail).toBe(true);
    expect(heartbeatOutcome(Date.now() - 1000, Date.now(), 60_000, 5_000)).toBe("pass");
    expect(heartbeatOutcome(null, Date.now(), 60_000, 5_000)).toBe("fail");
  });
});
