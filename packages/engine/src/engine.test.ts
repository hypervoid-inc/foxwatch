import { describe, expect, it } from "vitest";
import { http, secret } from "@foxwatch/config";
import {
  assertSafeUrl,
  bannerStatus,
  componentStatus,
  confirmFlip,
  regionImpact,
  statusDotColor,
  publicObservers,
  meshArcs,
  meshCaption,
  observerReadout,
  projectPct,
  nearestRegion,
  ringRem,
  landPaths,
  landRings,
  graticuleLines,
  latLngToVec,
  rotateYawPitch,
  lookAtYawPitch,
  slerp,
  sampleTrajectory,
  evaluateHttp,
  heartbeatOutcome,
  parseHomepageUrl,
  redactText,
  resolveHeaders,
  runHttpProbe,
  stripForbiddenHeaders,
  UrlPolicyError,
  DEFAULT_PROBE_USER_AGENT,
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
  it("sends a User-Agent when the check does not set one", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      seen.push(new Headers(init?.headers).get("User-Agent") ?? "");
      return new Response("", { status: 200 });
    };
    const check = http("homepage", {
      url: "https://httpbingo.org/status/200",
      timeout: "5s",
      interval: "1m",
    });
    const result = await runHttpProbe(check, {
      secrets: {},
      allowHttpLocal: false,
      fetchImpl,
      colo: "DEL",
    });
    expect(result.outcome).toBe("pass");
    expect(seen).toEqual([DEFAULT_PROBE_USER_AGENT]);
  });

  it("keeps an explicit User-Agent", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      seen.push(new Headers(init?.headers).get("User-Agent") ?? "");
      return new Response("", { status: 200 });
    };
    const check = http("homepage", {
      url: "https://example.com/health",
      headers: { "User-Agent": "StatusBot/2" },
      timeout: "5s",
      interval: "1m",
    });
    await runHttpProbe(check, {
      secrets: {},
      allowHttpLocal: false,
      fetchImpl,
      colo: "SFO",
    });
    expect(seen).toEqual(["StatusBot/2"]);
  });

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

describe("region impact", () => {
  it("lists degraded regions with latency and collapses to all", () => {
    const partial = regionImpact(
      ["wnam", "weur", "apac", "enam"],
      [
        { region: "apac", outcome: "degraded", latencyMs: 12082, errorClass: "latency" },
        { region: "weur", outcome: "pass", latencyMs: 4687 },
        { region: "enam", outcome: "degraded", latencyMs: 11920, errorClass: "latency" },
        { region: "wnam", outcome: "pass", latencyMs: 5369 },
      ],
    );
    expect(partial).toEqual({
      all: false,
      items: [
        { region: "apac", label: "APAC", detail: "12082ms", outcome: "degraded" },
        { region: "enam", label: "East NA", detail: "11920ms", outcome: "degraded" },
      ],
    });

    const all = regionImpact(
      ["wnam", "weur"],
      [
        { region: "wnam", outcome: "degraded", latencyMs: 9000 },
        { region: "weur", outcome: "fail", errorClass: "timeout", latencyMs: 10_000 },
      ],
    );
    expect(all?.all).toBe(true);
    expect(all?.items.map((item) => item.region)).toEqual(["wnam", "weur"]);
    expect(all?.items[1]?.detail).toBe("timeout");
  });

  it("keeps a single-region failure as a pill, not all", () => {
    expect(regionImpact(["global"], [{ region: "global", outcome: "fail", errorClass: "heartbeat" }])).toEqual({
      all: false,
      items: [{ region: "global", label: "Global", detail: "missed", outcome: "fail" }],
    });
    expect(regionImpact(["wnam"], [{ region: "wnam", outcome: "pass", latencyMs: 20 }])).toBe(null);
    expect(
      regionImpact(["wnam"], [{ region: "wnam", outcome: "fail", errorClass: "status", statusCode: 503 }])?.items[0]
        ?.detail,
    ).toBe("HTTP 503");
  });

  it("keeps the worse of two runs in the same region", () => {
    const impact = regionImpact(
      ["apac"],
      [
        { region: "apac", outcome: "degraded", latencyMs: 8000, errorClass: "latency" },
        { region: "apac", outcome: "fail", errorClass: "timeout", latencyMs: 10_000 },
      ],
    );
    expect(impact?.items[0]).toMatchObject({ outcome: "fail", detail: "timeout" });
  });
});

describe("edge observers", () => {
  it("aggregates live observers and places them on the map", () => {
    const observers = publicObservers(
      ["global", "wnam", "weur", "apac", "wnam"],
      [
        { region: "wnam", outcome: "pass", latencyMs: 42, colo: "sjc", checkedAt: 10 },
        { region: "wnam", outcome: "degraded", latencyMs: 900, colo: "SFO", checkedAt: 9 },
        { region: "weur", outcome: "pass", latencyMs: 80, colo: "LHR", checkedAt: 10 },
        { region: "global", outcome: "fail", colo: "XXX", checkedAt: 10 },
      ],
    );
    expect(observers.map((o) => o.region)).toEqual(["wnam", "weur", "apac"]);
    expect(observers[0]).toMatchObject({ outcome: "degraded", colo: "SFO", latencyMs: 900 });
    expect(observers[1]).toMatchObject({ outcome: "pass", colo: "LHR", latencyMs: 80 });
    expect(observers[2]).toMatchObject({ outcome: "unknown", colo: null, latencyMs: null });
    expect(meshCaption(observers)).toBe("1 region degraded · 80–900ms");
    expect(observerReadout(observers[0]!)).toBe("West North America · SFO · 900ms · slow");

    const sfo = projectPct(-121.93, 37.36);
    const ewr = projectPct(-74.17, 40.69);
    const syd = projectPct(151.18, -33.95);
    expect(sfo.x).toBeLessThan(ewr.x);
    expect(syd.x).toBeGreaterThan(ewr.x);
    expect(syd.y).toBeGreaterThan(sfo.y);
    expect(sfo.x).toBeGreaterThan(1);
    expect(sfo.x).toBeLessThan(99);

    const arcs = meshArcs(["wnam", "enam", "weur", "apac"]);
    const keys = arcs.map((a) => (a.a < a.b ? `${a.a}|${a.b}` : `${a.b}|${a.a}`));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("enam|wnam");
    expect(arcs.length).toBeGreaterThanOrEqual(3);
    expect(arcs.length).toBeLessThan(8);
    expect(nearestRegion(19.07, 72.88, ["wnam", "weur", "apac"])).toBe("apac");
    expect(ringRem(null, 100)).toBe(null);
    expect(ringRem(100, 100)).toBe("2.80rem");
    expect(ringRem(0, 100)).toBe(null);
  });

  it("draws denser land and a graticule for the public map", () => {
    const rings = landRings();
    const pts = rings.reduce((n, ring) => n + ring.length, 0);
    expect(rings.length).toBeGreaterThan(80);
    expect(pts).toBeGreaterThan(3000);
    expect(rings.some((ring) => ring.some(([lng, lat]) => (lng ?? 0) < -80 && (lng ?? 0) > -90 && (lat ?? 0) > 24 && (lat ?? 0) < 31))).toBe(true);
    expect(landPaths().every((d) => d.startsWith("M") && d.endsWith("Z"))).toBe(true);
    expect(graticuleLines().length).toBeGreaterThan(16);
  });
});

describe("globe math", () => {
  it("maps lat/lng onto a unit sphere and great-circle hops", () => {
    const eq = latLngToVec(0, 0);
    expect(eq.z).toBeCloseTo(1, 5);
    expect(eq.x).toBeCloseTo(0, 5);
    expect(latLngToVec(0, 90).x).toBeCloseTo(1, 5);
    expect(latLngToVec(90, 0).y).toBeCloseTo(1, 5);
    const faced = rotateYawPitch(latLngToVec(0, 90), lookAtYawPitch(0, 90).yaw, 0);
    expect(faced.z).toBeGreaterThan(0.9);
    const ny = latLngToVec(40.7, -74.2);
    const lon = latLngToVec(51.5, -0.1);
    const mid = slerp(ny, lon, 0.5);
    expect(mid.y).toBeGreaterThan(0.5);
    const hop = sampleTrajectory(ny, lon, 8);
    expect(hop[0]).toEqual(ny);
    const peak = hop[4]!;
    expect(Math.hypot(peak.x, peak.y, peak.z)).toBeGreaterThan(1.05);
  });
});
