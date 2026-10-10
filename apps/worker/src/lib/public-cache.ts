// Public pages are rendered from one KV snapshot that changes about once a
// minute, so the edge can answer most hits without running the Worker's routes.

import { LIVE_JSON_PATH } from "./public-html.ts";

/** Routes rendered from the snapshot alone. The answer is the same for every visitor. */
const CACHED_PATHS = new Set(["/", "/history", "/badge.svg", "/feed.xml", "/api/status.json", "/api/status/live.json", LIVE_JSON_PATH]);

export function isCacheablePublicGet(method: string, pathname: string): boolean {
  return method === "GET" && CACHED_PATHS.has(pathname);
}

/** Reads outside the admin API. They can be answered from the KV snapshot while D1 is unavailable. */
export function isPublicRead(method: string, pathname: string): boolean {
  return (method === "GET" || method === "HEAD") && !pathname.startsWith("/api/ops");
}

// There is no edge cache outside the Workers runtime, and on workers.dev it stores nothing.
function edgeCache(): Cache | null {
  try {
    return typeof caches === "undefined" ? null : caches.default;
  } catch {
    return null;
  }
}

// The query string is ignored by these routes, so it is left out of the key and
// cannot be used to fill the cache with copies or to skip it.
function cacheKey(request: Request): Request {
  const url = new URL(request.url);
  return new Request(`${url.origin}${url.pathname}`, { method: "GET" });
}

async function withEtag(response: Response): Promise<Response> {
  if (response.status !== 200 || response.headers.has("etag")) return response;
  const body = await response.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  const tag = [...digest.subarray(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const headers = new Headers(response.headers);
  headers.set("etag", `"${tag}"`);
  return new Response(body, { status: 200, headers });
}

function etagMatches(header: string | null, etag: string | null): boolean {
  if (!header || !etag) return false;
  const bare = (value: string) => value.trim().replace(/^W\//, "");
  return header.split(",").some((candidate) => candidate.trim() === "*" || bare(candidate) === bare(etag));
}

function conditional(request: Request, response: Response): Response {
  if (response.status !== 200 || !etagMatches(request.headers.get("if-none-match"), response.headers.get("etag"))) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(null, { status: 304, headers });
}

/**
 * Answers a cacheable public GET from the edge cache when it can, and stores a
 * fresh answer for as long as its own cache-control allows. Either way the
 * response carries an ETag and a matching If-None-Match gets a 304.
 */
export async function servePublicCached(
  request: Request,
  ctx: Pick<ExecutionContext, "waitUntil">,
  render: () => Promise<Response>,
): Promise<Response> {
  const cache = edgeCache();
  const key = cacheKey(request);
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return conditional(request, hit);
    } catch (error) {
      console.error("public cache read failed", error);
    }
  }
  const fresh = await withEtag(await render());
  if (cache && fresh.status === 200 && (fresh.headers.get("cache-control") ?? "").startsWith("public")) {
    ctx.waitUntil(cache.put(key, fresh.clone()).catch((error: unknown) => console.error("public cache write failed", error)));
  }
  return conditional(request, fresh);
}
