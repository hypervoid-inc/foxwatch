import { describe, expect, it } from "vitest";
import { http, secret, MAX_ASSERTION_VALUE_LENGTH, MAX_BODY_INCLUDES_LENGTH } from "@foxwatch/config";
import {
  assertSafeUrl,
  bannerStatus,
  componentStatus,
  confirmFlip,
  advanceMonitor,
  componentTransition,
  hasQuorum,
  heartbeatRecheckMs,
  type MonitorState,
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
  isPrivateHostname,
  parseHomepageUrl,
  parsePublicUrl,
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

  it("only applies IPv6 prefix rules to IPv6 literals", () => {
    for (const host of ["fd.io", "fdic.gov", "fcbarcelona.com", "fc2.com", "fe80.example.com"]) {
      expect(assertSafeUrl(`https://${host}/`).hostname).toBe(host);
      expect(isPrivateHostname(host)).toBe(false);
    }
    expect(assertSafeUrl("https://[2606:4700:4700::1111]/").hostname).toBe("[2606:4700:4700::1111]");
    expect(assertSafeUrl("https://[::ffff:8.8.8.8]/").hostname).toBe("[::ffff:808:808]");
  });

  it("rejects private, loopback and IPv4-embedding IPv6 literals", () => {
    for (const host of [
      "[::1]",
      "[0:0:0:0:0:0:0:1]",
      "[::]",
      "[fc00::1]",
      "[fd12:3456:789a::1]",
      "[fe80::1]",
      "[fe90::1]",
      "[febf::1]",
      "[fec0::1]",
      "[::ffff:127.0.0.1]",
      "[::ffff:7f00:1]",
      "[::ffff:169.254.169.254]",
      "[::ffff:a9fe:a9fe]",
      "[::ffff:10.0.0.1]",
      "[::127.0.0.1]",
      "[64:ff9b::a9fe:a9fe]",
      "[64:ff9b::10.0.0.1]",
      "[64:ff9b:1::1]",
      "[2002:7f00:1::1]",
      "[2002:c0a8:101::]",
    ]) {
      expect(() => assertSafeUrl(`https://${host}/`), host).toThrow(/private_address/);
    }
    // Raw forms the URL parser would have normalised, and ones it cannot read.
    expect(isPrivateHostname("::ffff:192.168.1.1")).toBe(true);
    expect(isPrivateHostname("0:0:0:0:0:ffff:7f00:1")).toBe(true);
    expect(isPrivateHostname("fc::1")).toBe(true);
    expect(isPrivateHostname("1:2:3")).toBe(true);
    expect(isPrivateHostname("::1::")).toBe(true);
    expect(isPrivateHostname("64:ff9b::8.8.8.8")).toBe(false);
    expect(isPrivateHostname("2002:808:808::1")).toBe(false);
  });

  it("ignores a trailing dot on the hostname", () => {
    expect(() => assertSafeUrl("https://localhost./")).toThrow(/private_address/);
    expect(() => assertSafeUrl("https://app.localhost./")).toThrow(/private_address/);
    expect(() => assertSafeUrl("https://db.internal./")).toThrow(/private_address/);
    expect(() => assertSafeUrl("https://127.0.0.1./")).toThrow(/private_address/);
    expect(isPrivateHostname("10.0.0.1.")).toBe(true);
    expect(() => assertSafeUrl("http://localhost./", { allowHttpLocal: true })).toThrow(UrlPolicyError);
    expect(assertSafeUrl("https://example.com./").hostname).toBe("example.com.");
  });

  it("treats homepage urls as links, not fetch targets", () => {
    expect(parseHomepageUrl("")).toBe(null);
    expect(parseHomepageUrl("https://construct.com/app")).toBe("https://construct.com/app");
    expect(parseHomepageUrl("http://example.com")).toBe("http://example.com/");
    expect(() => parseHomepageUrl("javascript:alert(1)")).toThrow(UrlPolicyError);
    expect(() => parseHomepageUrl("https://user:pass@evil.example/")).toThrow(UrlPolicyError);
  });

  it("keeps the public url as an origin", () => {
    expect(parsePublicUrl("")).toBe(null);
    expect(parsePublicUrl(null)).toBe(null);
    expect(parsePublicUrl(" https://status.example.com/history?x=1 ")).toBe("https://status.example.com");
    expect(parsePublicUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(() => parsePublicUrl("javascript:alert(1)")).toThrow(UrlPolicyError);
    expect(() => parsePublicUrl("https://user:pass@evil.example/")).toThrow(UrlPolicyError);
    expect(() => parsePublicUrl(5)).toThrow(UrlPolicyError);
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

  it("strips hop-by-hop and network-owned headers", () => {
    const out = stripForbiddenHeaders({
      Host: "evil",
      "Set-Cookie": "a=b",
      "Proxy-Authorization": "Basic x",
      "CF-Connecting-IP": "1.1.1.1",
      "X-Forwarded-For": "1.1.1.1",
      Authorization: "Bearer x",
    });
    expect(out).toEqual({ Authorization: "Bearer x" });
  });

  it("sends a secret-backed Cookie to allowed hosts only", () => {
    const headers = { Cookie: secret("SESSION_COOKIE") };
    const env = { SESSION_COOKIE: "sid=abc" };
    expect(resolveHeaders(headers, env, "app.example.com", ["app.example.com"]).headers).toEqual({ Cookie: "sid=abc" });
    expect(resolveHeaders(headers, env, "evil.example.com", ["app.example.com"]).headers).toEqual({});
    // A literal cookie never follows a redirect off the allowlist either.
    expect(resolveHeaders({ Cookie: "sid=abc" }, {}, "evil.example.com", ["app.example.com"]).headers).toEqual({});
  });

  it("redacts tokens from snippets", () => {
    expect(redactText("Authorization: Bearer abc.def", ["abc.def"])).not.toContain("abc.def");
    expect(redactText("Bearer super-secret-token")).toBe("Bearer [redacted]");
  });

  it("redacts every credential value, not the key name", () => {
    const out = redactText('{"access_token":"abc123456","refresh_token":"zzz99999","password":"hunter2","user":"bob"}');
    expect(out).toBe('{"access_token":[redacted],"refresh_token":[redacted],"password":[redacted],"user":"bob"}');
    expect(redactText("grant_type=password&client_secret=s3cr3t&api_key=K123&page=2")).toBe(
      "grant_type=password&client_secret=[redacted]&api_key=[redacted]&page=2",
    );
    expect(redactText(String.raw`{"detail":"{\"token\":\"esc123\"}"}`)).not.toContain("esc123");
  });

  it("redacts header lines, JWTs and long hex keys", () => {
    const out = redactText("Set-Cookie: sid=abc123; Path=/\nCookie: a=b; c=d\nX-Api-Key: k-123\nAuthorization: Basic dXNlcjpwYXNz\nX-Other: fine");
    for (const leaked of ["abc123", "a=b", "c=d", "k-123", "dXNlcjpwYXNz"]) expect(out).not.toContain(leaked);
    expect(out).toContain("X-Other: fine");
    expect(redactText("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sflKxwRJSMeKKF2QT4 ok")).toBe("jwt [redacted] ok");
    expect(redactText("key 0123456789abcdef0123456789abcdef sha 0123abc")).toBe("key [redacted] sha 0123abc");
  });

  it("redacts header values to the end of the line, whatever the scheme", () => {
    expect(redactText("Authorization: Token abc123secretvalue")).toBe("Authorization: [redacted]");
    expect(redactText("authorization: ApiKey zzz-key-value\nHost: example.com")).toBe("authorization: [redacted]\nHost: example.com");
    expect(redactText("> Proxy-Authorization: Digest username=bob, response=6629fae4\r\n> Accept: */*")).toBe(
      "> Proxy-Authorization: [redacted]\r\n> Accept: */*",
    );
    expect(redactText("user: bob\npassword: my pass phrase\n  X-Auth-Token: part one two\nstatus: locked")).toBe(
      "user: bob\npassword: [redacted]\n  X-Auth-Token: [redacted]\nstatus: locked",
    );
    // Quoted and inline forms keep their own, narrower handling.
    expect(redactText('{"authorization": "Token abc123", "user": "bob"}')).toBe('{"authorization": [redacted], "user": "bob"}');
    expect(redactText("invalid token: abc123, retry later")).toBe("invalid token: [redacted], retry later");
    expect(redactText('{"log":"Authorization: Token abc123","ok":false}')).toBe('{"log":"Authorization: [redacted]","ok":false}');
  });

  it("keeps snippets bounded on large bodies", () => {
    expect(redactText("z".repeat(70_000) + ' "token":"late"').length).toBe(2048);
    // A value cut off by the limit is still a value.
    expect(redactText("x".repeat(2030) + ' "token":"abcdefghijklmnop"')).not.toContain("abcd");
  });

  it("stays fast on bodies that repeat a credential keyword", () => {
    // Each of these took hundreds of ms when the key match could restart inside a word run.
    const bodies = ["token".repeat(410), "token.".repeat(342), "apikey".repeat(342), "tokensecret".repeat(187)];
    const started = performance.now();
    for (const body of bodies) expect(redactText(body)).toBe(body.slice(0, 2048));
    expect(performance.now() - started).toBeLessThan(100);
    // Long keys still redact: the match begins at the keyword, not at the start of the key.
    expect(redactText(`${"a.".repeat(200)}access_token=abc123`)).toBe(`${"a.".repeat(200)}access_token=[redacted]`);
    expect(redactText(`${"token".repeat(40)}=abc123`)).toBe(`${"token".repeat(40)}=[redacted]`);
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

describe("json path assertions", () => {
  const evalBody = (body: unknown, expect: Parameters<typeof evaluateHttp>[0]["expect"]) =>
    evaluateHttp({ status: 200, headers: {}, body: JSON.stringify(body), latencyMs: 1, expect });

  it("fails an unsupported segment instead of dropping it", () => {
    const body = { data: { id: 1 }, status: "ok" };
    for (const path of ["$.data.user-id", "$[status]", "$.data..", "$x-y", "$.data[*]"]) {
      const res = evalBody(body, { assertions: [{ path, op: "exists" }] });
      expect(res.outcome, path).toBe("fail");
      expect(res.errorClass).toBe("assertion");
      expect(res.reason).toContain("invalid path");
    }
    expect(evalBody(body, { jsonPath: { path: "$.data.user-id", exists: true } }).errorClass).toBe("jsonpath");
  });

  it("keeps evaluating the bare-key, dotted-index and trailing-dot paths older checks were saved with", () => {
    const body = { data: { items: [{ id: 5 }] }, status: "ok" };
    expect(evalBody(body, { assertions: [{ path: "$status", op: "equals", value: "ok" }] }).outcome).toBe("pass");
    expect(evalBody(body, { assertions: [{ path: "$data.items[0].id", op: "equals", value: 5 }] }).outcome).toBe("pass");
    expect(evalBody(body, { assertions: [{ path: "$.status.", op: "equals", value: "ok" }] }).outcome).toBe("pass");
    expect(evalBody(body, { assertions: [{ path: "$status", op: "equals", value: "down" }] }).outcome).toBe("fail");
    expect(evalBody(body, { jsonPath: { path: "$status", equals: "ok" } }).outcome).toBe("pass");
    expect(evalBody(body, { assertions: [{ path: "$.data.items.[0].id", op: "equals", value: 5 }] }).outcome).toBe("pass");
    expect(evalBody(body, { assertions: [{ path: "$.data.items.[1]", op: "exists" }] }).outcome).toBe("fail");
    expect(evalBody(body, { jsonPath: { path: "$.data.items.[0]", exists: true } }).outcome).toBe("pass");
    expect(evalBody([{ id: 5 }], { assertions: [{ path: "$.[0].id", op: "equals", value: 5 }] }).outcome).toBe("pass");
  });

  it("reads quoted keys and chained indexes", () => {
    const body = { data: { "user-id": 7, "a.b": [[1, 2], [3, 4]] }, status: "ok" };
    expect(evalBody(body, { assertions: [{ path: "$.data['user-id']", op: "equals", value: 7 }] }).outcome).toBe("pass");
    expect(evalBody(body, { assertions: [{ path: `$["status"]`, op: "equals", value: "ok" }] }).outcome).toBe("pass");
    expect(evalBody(body, { assertions: [{ path: "$.data['a.b'][1][0]", op: "equals", value: 3 }] }).outcome).toBe("pass");
    expect(evalBody(body, { assertions: [{ path: "$.data['missing-key']", op: "exists" }] }).outcome).toBe("fail");
    expect(evalBody(body, { assertions: [{ path: "$.data['a.b'].length", op: "equals", value: 2 }] }).outcome).toBe("pass");
  });

  it("does not resolve inherited properties", () => {
    const body = { data: {}, list: [] };
    for (const path of ["$.constructor", "$.data.toString", "$.data.__proto__", "$.list.map", "$.data.hasOwnProperty"]) {
      expect(evalBody(body, { assertions: [{ path, op: "exists" }] }).outcome, path).toBe("fail");
      expect(evalBody(body, { assertions: [{ path, op: "not_exists" }] }).outcome, path).toBe("pass");
    }
  });

  it("runs everything the save-time limits accept", () => {
    const key = "k".repeat(200);
    const needle = "n".repeat(MAX_BODY_INCLUDES_LENGTH);
    const body = { [key]: needle, v: `a${"b".repeat(MAX_ASSERTION_VALUE_LENGTH - 1)}` };
    expect(evalBody(body, { bodyIncludes: needle }).outcome).toBe("pass");
    expect(evalBody(body, { bodyIncludes: `${needle}n` }).errorClass).toBe("body");
    expect(evalBody(body, { assertions: [{ path: `$.${key}`, op: "exists" }] }).outcome).toBe("pass");
    expect(
      evalBody(body, { assertions: [{ path: "$.v", op: "matches", value: `?${"b".repeat(MAX_ASSERTION_VALUE_LENGTH - 1)}` }] }).outcome,
    ).toBe("pass");
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

describe("runHttpProbe redirect handling", () => {
  type Seen = { url: string; method: string; body: string | null; contentType: string | null; auth: string | null };
  function recorder(respond: (url: string, n: number) => Response) {
    const seen: Seen[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : null,
        contentType: headers.get("Content-Type"),
        auth: headers.get("Authorization"),
      });
      return respond(String(input), seen.length);
    };
    return { seen, fetchImpl };
  }
  const redirect = (status: number, to: string) => new Response(null, { status, headers: { Location: to } });
  const run = (check: ReturnType<typeof http>, fetchImpl: typeof fetch) =>
    runHttpProbe(check, { secrets: { API_TOKEN: "sekrit-value" }, allowHttpLocal: false, fetchImpl, colo: "SFO" });

  it("fails a redirect loop as a redirect error, whatever status is expected", async () => {
    for (const expectation of [{}, { status: 302 }, { status: 200 }]) {
      const { seen, fetchImpl } = recorder((url) => redirect(302, url.endsWith("/a") ? "/b" : "/a"));
      const check = http("loop", { url: "https://example.com/a", timeout: "5s", interval: "1m", expect: expectation });
      const result = await run(check, fetchImpl);
      expect(result.outcome).toBe("fail");
      expect(result.errorClass).toBe("redirect");
      expect(result.statusCode).toBe(302);
      expect(seen).toHaveLength(6);
    }
  });

  it("still follows five redirects to a final response", async () => {
    const { seen, fetchImpl } = recorder((_url, n) => (n <= 5 ? redirect(302, `/hop${n}`) : new Response("ok", { status: 200 })));
    const check = http("chain", { url: "https://example.com/start", timeout: "5s", interval: "1m" });
    const result = await run(check, fetchImpl);
    expect(result.outcome).toBe("pass");
    expect(seen).toHaveLength(6);
    expect(seen[5]?.url).toBe("https://example.com/hop5");
  });

  it("evaluates a 3xx as the response when redirects are not followed", async () => {
    const { seen, fetchImpl } = recorder(() => redirect(301, "/elsewhere"));
    const check = http("moved", {
      url: "https://example.com/old",
      timeout: "5s",
      interval: "1m",
      followRedirects: false,
      expect: { status: 301 },
    });
    expect((await run(check, fetchImpl)).outcome).toBe("pass");
    expect(seen).toHaveLength(1);
  });

  it("turns a POST into a bodiless GET on 301, 302 and 303", async () => {
    for (const status of [301, 302, 303]) {
      const { seen, fetchImpl } = recorder((_url, n) => (n === 1 ? redirect(status, "/done") : new Response("ok", { status: 200 })));
      const check = http("submit", {
        url: "https://example.com/submit",
        method: "POST",
        body: '{"a":1}',
        headers: { "Content-Type": "application/json", Authorization: secret("API_TOKEN") },
        timeout: "5s",
        interval: "1m",
      });
      const result = await run(check, fetchImpl);
      expect(result.outcome).toBe("pass");
      expect(seen[0]).toMatchObject({ method: "POST", body: '{"a":1}', contentType: "application/json" });
      expect(seen[1]).toMatchObject({
        url: "https://example.com/done",
        method: "GET",
        body: null,
        contentType: null,
        auth: "sekrit-value",
      });
    }
  });

  it("replays method and body on 307 and 308, and keeps HEAD on 303", async () => {
    for (const status of [307, 308]) {
      const { seen, fetchImpl } = recorder((_url, n) => (n === 1 ? redirect(status, "/done") : new Response("ok", { status: 200 })));
      const check = http("submit", {
        url: "https://example.com/submit",
        method: "POST",
        body: "payload",
        headers: { "Content-Type": "text/plain" },
        timeout: "5s",
        interval: "1m",
      });
      await run(check, fetchImpl);
      expect(seen[1]).toMatchObject({ method: "POST", body: "payload", contentType: "text/plain" });
    }
    const { seen, fetchImpl } = recorder((_url, n) => (n === 1 ? redirect(303, "/done") : new Response(null, { status: 200 })));
    await run(http("head", { url: "https://example.com/x", method: "HEAD", timeout: "5s", interval: "1m" }), fetchImpl);
    expect(seen.map((s) => s.method)).toEqual(["HEAD", "HEAD"]);
  });

  it("cancels the body of a redirect it follows", async () => {
    let cancelled = 0;
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith("/start")) {
        const stream = new ReadableStream<Uint8Array>({
          cancel() {
            cancelled++;
          },
        });
        return new Response(stream, { status: 302, headers: { Location: "/end" } });
      }
      return new Response("ok", { status: 200 });
    };
    const result = await run(http("c", { url: "https://example.com/start", timeout: "5s", interval: "1m" }), fetchImpl);
    expect(result.outcome).toBe("pass");
    expect(cancelled).toBe(1);
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

describe("monitor state machine", () => {
  const fresh: MonitorState = { confirmedOutcome: null, consecutiveFails: 0, consecutiveChanges: 0 };
  const run = (state: MonitorState, outcomes: Array<"pass" | "degraded" | "fail">, confirmFails = 3) =>
    outcomes.reduce<MonitorState & { settled: boolean }>(
      (current, outcome) => advanceMonitor(current, outcome, confirmFails),
      { ...state, settled: true },
    );

  it("confirms a failure after confirmFails consecutive failing runs", () => {
    const passing = run(fresh, ["pass"]);
    expect(passing).toMatchObject({ confirmedOutcome: "pass", settled: true });
    expect(run(passing, ["fail", "fail"])).toMatchObject({ confirmedOutcome: "pass", consecutiveFails: 2, settled: false });
    expect(run(passing, ["fail", "fail", "fail"])).toMatchObject({ confirmedOutcome: "fail", consecutiveFails: 3, settled: true });
    expect(run(passing, ["fail", "fail", "pass", "fail"])).toMatchObject({ confirmedOutcome: "pass", consecutiveFails: 1 });
    expect(run(passing, ["fail"], 1)).toMatchObject({ confirmedOutcome: "fail", settled: true });
    expect(run(passing, ["fail"], 0)).toMatchObject({ confirmedOutcome: "fail" });
  });

  it("takes the first pass as is and stays unknown until a failure is confirmed", () => {
    expect(run(fresh, ["pass"])).toMatchObject({ confirmedOutcome: "pass", settled: true });
    expect(run(fresh, ["fail"])).toMatchObject({ confirmedOutcome: null, consecutiveFails: 1, settled: false });
    expect(run(fresh, ["fail", "pass"])).toMatchObject({ confirmedOutcome: "pass", consecutiveFails: 0, settled: true });
    expect(run(fresh, ["degraded"])).toMatchObject({ confirmedOutcome: null, settled: false });
    expect(run(fresh, ["degraded", "degraded"])).toMatchObject({ confirmedOutcome: "degraded", settled: true });
  });

  it("ignores a single degraded run and a single recovered run", () => {
    const passing = run(fresh, ["pass"]);
    expect(run(passing, ["degraded"])).toMatchObject({ confirmedOutcome: "pass", consecutiveChanges: 1, settled: false });
    expect(run(passing, ["degraded", "pass"])).toMatchObject({ confirmedOutcome: "pass", consecutiveChanges: 0, settled: true });
    expect(run(passing, ["degraded", "pass", "degraded", "pass"])).toMatchObject({ confirmedOutcome: "pass" });
    const degraded = run(passing, ["degraded", "degraded"]);
    expect(degraded).toMatchObject({ confirmedOutcome: "degraded", settled: true });
    expect(run(degraded, ["pass"])).toMatchObject({ confirmedOutcome: "degraded", settled: false });
    expect(run(degraded, ["pass", "fail", "pass"])).toMatchObject({ confirmedOutcome: "degraded", consecutiveChanges: 1 });
    expect(run(degraded, ["pass", "pass"])).toMatchObject({ confirmedOutcome: "pass", settled: true });
  });

  it("needs two non-failing runs to leave a confirmed failure", () => {
    const failing = run(fresh, ["fail"], 1);
    expect(run(failing, ["pass"], 1)).toMatchObject({ confirmedOutcome: "fail", consecutiveFails: 0, settled: false });
    expect(run(failing, ["pass", "fail"], 1)).toMatchObject({ confirmedOutcome: "fail", consecutiveChanges: 0, settled: true });
    expect(run(failing, ["pass", "pass"], 1)).toMatchObject({ confirmedOutcome: "pass", settled: true });
    // A service that came back but is slow must not stay failing because its runs alternate.
    expect(run(failing, ["pass", "degraded"], 1)).toMatchObject({ confirmedOutcome: "degraded", settled: true });
    expect(run(failing, ["degraded", "pass"], 1)).toMatchObject({ confirmedOutcome: "pass", settled: true });
  });

  it("confirms degraded when runs alternate between failing and degraded", () => {
    const passing = run(fresh, ["pass"]);
    // One or two of three regions down: never three failing runs in a row, never a pass.
    expect(run(passing, ["fail", "fail", "degraded"])).toMatchObject({ confirmedOutcome: "degraded", consecutiveChanges: 0, settled: true });
    expect(run(passing, ["degraded", "fail", "degraded"])).toMatchObject({ confirmedOutcome: "degraded", settled: true });
    expect(run(passing, ["fail", "degraded"])).toMatchObject({ confirmedOutcome: "degraded", settled: true });
    expect(run(fresh, ["fail", "degraded"])).toMatchObject({ confirmedOutcome: "degraded", settled: true });
    const degraded = run(passing, ["fail", "fail", "degraded", "fail", "fail", "degraded"]);
    expect(degraded).toMatchObject({ confirmedOutcome: "degraded", consecutiveFails: 0, consecutiveChanges: 0, settled: true });
    expect(run(degraded, ["fail", "fail", "fail"])).toMatchObject({ confirmedOutcome: "fail", settled: true });
  });

  it("does not report degraded on the way to a confirmed failure, or after a failing blip", () => {
    const passing = run(fresh, ["pass"]);
    expect(run(passing, ["fail", "fail"])).toMatchObject({ confirmedOutcome: "pass", consecutiveChanges: 2, settled: false });
    expect(run(passing, ["fail", "fail", "pass"])).toMatchObject({ confirmedOutcome: "pass", consecutiveChanges: 0, settled: true });
    expect(run(passing, ["fail", "pass", "degraded"])).toMatchObject({ confirmedOutcome: "pass", consecutiveChanges: 1, settled: false });
    // A failing run is no step towards recovery for a check that is already degraded or failing.
    const degraded = run(passing, ["degraded", "degraded"]);
    expect(run(degraded, ["fail", "pass"])).toMatchObject({ confirmedOutcome: "degraded", consecutiveChanges: 1, settled: false });
    const failing = run(passing, ["fail", "fail", "fail"]);
    expect(run(failing, ["pass", "fail", "pass"])).toMatchObject({ confirmedOutcome: "fail", consecutiveChanges: 1, settled: false });
  });

  it("requires answers from half of the regions", () => {
    expect(hasQuorum(0, 1)).toBe(false);
    expect(hasQuorum(1, 1)).toBe(true);
    expect(hasQuorum(1, 2)).toBe(true);
    expect(hasQuorum(1, 3)).toBe(false);
    expect(hasQuorum(2, 3)).toBe(true);
    expect(hasQuorum(4, 9)).toBe(false);
  });

  it("looks at a passing heartbeat again right after its deadline", () => {
    const now = 1_000_000;
    expect(heartbeatRecheckMs(now - 50_000, now, 60_000, 5_000)).toBe(16_000);
    expect(heartbeatRecheckMs(now, now, 60_000, 120_000)).toBe(60_000);
    expect(heartbeatRecheckMs(now - 64_999, now, 60_000, 5_000)).toBe(1_001);
    expect(heartbeatRecheckMs(now - 65_000, now, 60_000, 5_000)).toBe(1_000);
  });
});

describe("component transitions", () => {
  it("opens an incident and alerts once when a component starts failing", () => {
    for (const prev of [null, "unknown", "operational", "degraded"]) {
      expect(componentTransition(prev, "failing")).toEqual({ event: "fail", incident: "open", onlyIfResolved: false });
    }
    expect(componentTransition("failing", "failing")).toBeNull();
  });

  it("ends the outage when a failing component is only degraded", () => {
    expect(componentTransition("failing", "degraded")).toEqual({ event: "degrade", incident: "resolve", onlyIfResolved: false });
    expect(componentTransition("operational", "degraded")).toEqual({ event: "degrade", incident: null, onlyIfResolved: false });
    for (const prev of [null, "unknown"]) {
      expect(componentTransition(prev, "degraded")).toEqual({ event: "degrade", incident: "resolve", onlyIfResolved: false });
    }
    expect(componentTransition("degraded", "degraded")).toBeNull();
  });

  it("resolves on recovery, and closes a leftover incident without a known previous status", () => {
    expect(componentTransition("failing", "operational")).toEqual({ event: "recover", incident: "resolve", onlyIfResolved: false });
    expect(componentTransition("degraded", "operational")).toEqual({ event: "recover", incident: "resolve", onlyIfResolved: false });
    expect(componentTransition("unknown", "operational")).toEqual({ event: "recover", incident: "resolve", onlyIfResolved: true });
    expect(componentTransition(null, "operational")).toEqual({ event: "recover", incident: "resolve", onlyIfResolved: true });
    expect(componentTransition("operational", "operational")).toBeNull();
  });

  it("never treats a missing verdict as a transition", () => {
    expect(componentTransition("failing", "unknown")).toBeNull();
    expect(componentTransition("operational", "unknown")).toBeNull();
    expect(componentTransition(null, "maintenance")).toBeNull();
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
