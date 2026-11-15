import { describe, expect, it, vi } from "vitest";
import type { Env } from "./env.ts";
import { hasSqlite, testDb } from "../test/sqlite-d1.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
const { app, TOKEN_PROBE_LIMIT } = await import("./app.ts");

const ORIGIN = "https://status.example.com";
const OWNER = { email: "owner@example.com", password: "correct-horse-battery" };

async function signedIn() {
  const db = await testDb();
  const kv = new Map<string, string>();
  const env = {
    DB: db.DB,
    STATUS: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => void kv.set(key, value),
    },
    MONITOR: {
      idFromName: (name: string) => name,
      get: () => ({ reschedule: async () => {}, runNow: async () => {}, destroy: async () => {} }),
    },
    STATUS_HUB: { idFromName: (name: string) => name, get: () => ({ push: async () => {} }) },
  } as unknown as Env;
  const request = (path: string, init: RequestInit = {}) => app.request(`${ORIGIN}${path}`, init, env);
  const json = (method: string, path: string, body: unknown, headers: Record<string, string>) =>
    request(path, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const cookie = (await json("POST", "/api/ops/setup", OWNER, {})).headers.get("set-cookie")!.split(";")[0]!;
  const newToken = async (name = "claude") => {
    const res = await json("POST", "/api/ops/tokens", { name }, { cookie });
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string; apiToken: { id: string } });
  };
  return { db, request, json, cookie, newToken };
}

/** One JSON-RPC message to the MCP endpoint, answered over SSE or JSON. */
async function rpc(request: (path: string, init?: RequestInit) => Response | Promise<Response>, auth: Record<string, string>, method: string, params: unknown = {}) {
  const res = await request("/api/ops/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...auth },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.text();
  const data = /^data: (.*)$/m.exec(body)?.[1] ?? body;
  return { status: res.status, message: JSON.parse(data) as { result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean } } };
}

describe.skipIf(!hasSqlite)("API tokens", () => {
  it("act as their owner, never above admin, and are kept only as a hash", async () => {
    const { db, request, json, cookie, newToken } = await signedIn();
    const { token } = await newToken();
    expect(token).toMatch(/^fxw_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(db.query("SELECT * FROM ops_tokens"))).not.toContain(token.slice(4));

    const bearer = { authorization: `Bearer ${token}` };
    const overview = (await (await request("/api/ops/overview", { headers: bearer })).json()) as { me: { email: string; role: string } };
    expect(overview.me).toMatchObject({ email: "owner@example.com via claude", role: "admin" });
    // The owner is a superadmin; the token is not.
    expect((await request("/api/ops/users", { headers: { cookie } })).status).toBe(200);
    expect((await request("/api/ops/users", { headers: bearer })).status).toBe(403);
    expect((await json("POST", "/api/ops/secrets", { name: "NEW_SECRET" }, bearer)).status).toBe(403);
    // A token cannot mint another one.
    expect((await json("POST", "/api/ops/tokens", { name: "more" }, bearer)).status).toBe(403);

    expect((await json("POST", "/api/ops/monitors", { id: "api", url: "https://example.com/health" }, bearer)).status).toBe(200);
    const actors = db.query<{ actor: string }>("SELECT actor FROM audit_log WHERE action = 'create-monitor'");
    expect(actors).toEqual([{ actor: "owner@example.com via claude" }]);
  });

  it("stop working once revoked or expired, and never work as a cookie", async () => {
    const { db, request, cookie, newToken } = await signedIn();
    const revoked = await newToken("revoked");
    const expired = await newToken("expired");
    const live = await newToken("live");
    const overview = (token: string) => request("/api/ops/overview", { headers: { authorization: `Bearer ${token}` } });
    expect((await overview(revoked.token)).status).toBe(200);

    expect((await request(`/api/ops/tokens/${revoked.apiToken.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(200);
    db.query("UPDATE ops_tokens SET expires_at = ? WHERE id = ?", Date.now() - 1, expired.apiToken.id);
    for (const token of [revoked.token, expired.token]) {
      const res = await overview(token);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: "auth" });
    }
    expect((await request("/api/ops/overview", { headers: { cookie: `foxwatch_ops=${live.token}` } })).status).toBe(401);
    expect((await overview(live.token)).status).toBe(200);
  });

  it("limit run-now per token and say when to retry", async () => {
    const { request, json, newToken } = await signedIn();
    const { token } = await newToken();
    const bearer = { authorization: `Bearer ${token}` };
    await json("POST", "/api/ops/monitors", { id: "api", url: "https://example.com/health" }, bearer);
    for (let i = 0; i < TOKEN_PROBE_LIMIT; i++) {
      expect((await json("POST", "/api/ops/monitors/api/run", {}, bearer)).status).toBe(200);
    }
    const limited = await json("POST", "/api/ops/monitors/api/run", {}, bearer);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await request("/api/ops/overview", { headers: bearer })).status).toBe(200);
  });
});

describe.skipIf(!hasSqlite)("MCP endpoint", () => {
  it("answers only API tokens", async () => {
    const { request, cookie } = await signedIn();
    expect((await rpc(request, {}, "tools/list")).status).toBe(401);
    expect((await rpc(request, { cookie }, "tools/list")).status).toBe(401);
    // A browser session's token sent as a Bearer is still a session.
    expect((await rpc(request, { authorization: `Bearer ${decodeURIComponent(cookie.split("=")[1]!)}` }, "tools/list")).status).toBe(401);
  });

  it("lists its tools, creates a check through the admin API, and will not delete without confirm", async () => {
    const { request, newToken } = await signedIn();
    const auth = { authorization: `Bearer ${(await newToken()).token}` };

    const listed = await rpc(request, auth, "tools/list");
    expect(listed.status).toBe(200);
    const names = listed.message.result!.tools!.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["list_checks", "create_check", "delete_check", "update_incident"]));
    expect(names).not.toEqual(expect.arrayContaining(["create_secret"]));

    const created = await rpc(request, auth, "tools/call", {
      name: "create_check",
      arguments: { id: "health", url: "https://example.com/health", groupId: "api", groupName: "API", interval: "5m" },
    });
    expect(created.message.result!.isError).toBeFalsy();
    const checks = await rpc(request, auth, "tools/call", { name: "list_checks", arguments: {} });
    expect(JSON.parse(checks.message.result!.content![0]!.text)).toEqual([
      expect.objectContaining({ id: "health", group: { id: "api", name: "API" }, url: "https://example.com/health", intervalMs: 300_000 }),
    ]);

    const refused = await rpc(request, auth, "tools/call", { name: "delete_check", arguments: { id: "health" } });
    expect(refused.message.result!.isError).toBe(true);
    const still = await rpc(request, auth, "tools/call", { name: "list_checks", arguments: {} });
    expect(JSON.parse(still.message.result!.content![0]!.text)).toHaveLength(1);
  });
});
