import { afterEach, describe, expect, it, vi } from "vitest";
import { isCacheablePublicGet, isPublicRead, servePublicCached } from "./public-cache.ts";

const HEADERS = { "content-type": "text/html", "cache-control": "public, max-age=15" };

function edge() {
  const store = new Map<string, Response>();
  const cache = {
    match: async (key: Request) => store.get(key.url)?.clone(),
    put: async (key: Request, value: Response) => void store.set(key.url, value),
  };
  vi.stubGlobal("caches", { default: cache });
  return store;
}

function context() {
  const pending: Array<Promise<unknown>> = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) }, settle: () => Promise.all(pending) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("public route classes", () => {
  it("caches only snapshot-rendered GETs", () => {
    for (const path of ["/", "/history", "/badge.svg", "/feed.xml", "/api/status.json", "/api/status/live.json", "/api/status/live.v2.json"]) {
      expect(isCacheablePublicGet("GET", path)).toBe(true);
    }
    expect(isCacheablePublicGet("POST", "/")).toBe(false);
    for (const path of ["/api/here.json", "/icon", "/incidents/abc12345", "/admin", "/api/ops/overview", "/api/heartbeat"]) {
      expect(isCacheablePublicGet("GET", path)).toBe(false);
    }
  });

  it("treats reads outside the admin API as servable without D1", () => {
    expect(isPublicRead("GET", "/")).toBe(true);
    expect(isPublicRead("HEAD", "/badge.svg")).toBe(true);
    expect(isPublicRead("GET", "/api/ops/overview")).toBe(false);
    expect(isPublicRead("POST", "/api/heartbeat")).toBe(false);
  });
});

describe("servePublicCached", () => {
  it("renders once and answers the next hits from the edge, whatever the query string", async () => {
    const store = edge();
    const { ctx, settle } = context();
    const render = vi.fn(async () => new Response("<p>ok</p>", { headers: HEADERS }));
    const first = await servePublicCached(new Request("https://status.example.com/"), ctx, render);
    expect(await first.text()).toBe("<p>ok</p>");
    expect(first.headers.get("etag")).toMatch(/^"[0-9a-f]{24}"$/);
    await settle();
    expect([...store.keys()]).toEqual(["https://status.example.com/"]);

    const second = await servePublicCached(new Request("https://status.example.com/?bust=1"), ctx, render);
    expect(await second.text()).toBe("<p>ok</p>");
    expect(second.headers.get("etag")).toBe(first.headers.get("etag"));
    expect(render).toHaveBeenCalledOnce();

    // Another hostname is another page (the feed links to its own origin).
    await servePublicCached(new Request("https://foxwatch.acct.workers.dev/"), ctx, render);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("answers a matching If-None-Match with 304 and keeps the headers", async () => {
    edge();
    const { ctx, settle } = context();
    const render = async () => new Response("<p>ok</p>", { headers: { ...HEADERS, "x-frame-options": "DENY" } });
    const etag = (await servePublicCached(new Request("https://status.example.com/"), ctx, render)).headers.get("etag")!;
    await settle();
    for (const sent of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const res = await servePublicCached(new Request("https://status.example.com/", { headers: { "if-none-match": sent } }), ctx, render);
      expect(res.status).toBe(304);
      expect(await res.text()).toBe("");
      expect(res.headers.get("etag")).toBe(etag);
      expect(res.headers.get("cache-control")).toBe("public, max-age=15");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
    }
    const changed = await servePublicCached(new Request("https://status.example.com/", { headers: { "if-none-match": '"stale"' } }), ctx, render);
    expect(changed.status).toBe(200);
  });

  it("changes the ETag with the body", async () => {
    const { ctx } = context();
    const tag = async (body: string) =>
      (await servePublicCached(new Request("https://status.example.com/"), ctx, async () => new Response(body, { headers: HEADERS }))).headers.get("etag");
    expect(await tag("a")).not.toBe(await tag("b"));
    expect(await tag("a")).toBe(await tag("a"));
  });

  it("never stores an error or a private answer", async () => {
    const store = edge();
    const { ctx, settle } = context();
    const url = "https://status.example.com/";
    const failed = await servePublicCached(new Request(url), ctx, async () => new Response("no", { status: 500, headers: { "cache-control": "no-store" } }));
    expect(failed.status).toBe(500);
    expect(failed.headers.has("etag")).toBe(false);
    await servePublicCached(new Request(url), ctx, async () => new Response("me", { headers: { "cache-control": "private, no-store" } }));
    await settle();
    expect(store.size).toBe(0);
  });

  it("works without an edge cache, and when the cache fails", async () => {
    const { ctx, settle } = context();
    const render = async () => new Response("ok", { headers: HEADERS });
    expect(await (await servePublicCached(new Request("https://status.example.com/"), ctx, render)).text()).toBe("ok");

    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("caches", {
      default: {
        match: async () => { throw new Error("cache down"); },
        put: async () => { throw new Error("cache down"); },
      },
    });
    expect(await (await servePublicCached(new Request("https://status.example.com/"), ctx, render)).text()).toBe("ok");
    await settle();
  });
});
