import { describe, expect, it, vi } from "vitest";
import type { Env } from "./env.ts";
import { hasSqlite, testDb } from "../test/sqlite-d1.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
const { app } = await import("./app.ts");
const { saveIcon } = await import("./lib/snapshot.ts");

const ORIGIN = "https://status.example.com";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function instance(vars: Partial<Env> = {}) {
  const db = await testDb();
  const kv = new Map<string, string>();
  const env = {
    DB: db.DB,
    STATUS: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => void kv.set(key, value),
    },
    ASSETS: { fetch: async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }) },
    ...vars,
  } as unknown as Env;
  const request = (path: string, init?: RequestInit) => app.request(`${ORIGIN}${path}`, init, env);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { env, db, request, post };
}

describe.skipIf(!hasSqlite)("response headers", () => {
  it("leaves the versioned icon cacheable for good", async () => {
    const { env, request } = await instance();
    expect((await request("/icon")).status).toBe(404);
    await saveIcon(env, PNG);
    const res = await request("/icon?v=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toMatch(/max-age=31536000/);
  });

  it("keeps a handler's own cache policy and defaults the rest", async () => {
    const { request } = await instance();
    expect((await request("/api/here.json")).headers.get("cache-control")).toBe("private, no-store");
    expect((await request("/api/status.json")).headers.get("cache-control")).toBe("public, max-age=15");
    expect((await request("/")).headers.get("cache-control")).toBe("public, max-age=15");
  });

  it("serves the globe's files by content hash, cacheable only under the hash this deploy has", async () => {
    const { request } = await instance();
    const { globeAssetVersions } = await import("./lib/public-html.ts");
    const { GLOBE_CLIENT_SCRIPT } = await import("./lib/public-globe.ts");
    const v = globeAssetVersions();
    const land = await request(`/api/globe/land.json?v=${v.land}`);
    expect(land.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(land.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await land.json()).toEqual(expect.any(Array));
    const flat = await request(`/api/globe/2d.js?v=${v.flat}`);
    expect(flat.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(flat.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(flat.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await flat.text()).toBe(GLOBE_CLIENT_SCRIPT);
    // A page from another deploy still gets a globe, but its address is not filled with this one's file.
    const other = await request("/api/globe/2d.js?v=0");
    expect(other.status).toBe(200);
    expect(other.headers.get("cache-control")).toBe("no-store");
  });

  it("lets a public page run its own inline scripts by hash and no others", async () => {
    const { createHash } = await import("node:crypto");
    const { request } = await instance();
    for (const path of ["/", "/history", "/incidents/inc99abcdefghijklmnop", "/incidents/!"]) {
      const res = await request(path);
      const csp = res.headers.get("content-security-policy") ?? "";
      const scriptSrc = /script-src ([^;]*);/.exec(csp)?.[1] ?? "";
      expect(scriptSrc).toContain("'self'");
      expect(scriptSrc).not.toContain("unsafe-inline");
      expect(scriptSrc).not.toContain("unsafe-eval");
      const bodies = [...(await res.text()).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
      expect(bodies.length, path).toBeGreaterThan(1);
      for (const body of bodies) {
        expect(scriptSrc, `${path}: ${body.slice(0, 60)}`).toContain(`'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`);
      }
    }
    // Nothing that is not a page needs more than same-origin script, and it gets the same policy.
    expect((await request("/badge.svg")).headers.get("content-security-policy")).toMatch(/script-src 'self' 'sha256-/);
    expect((await request("/feed.xml")).headers.get("content-security-policy")).not.toContain("unsafe-inline'; connect-src");
  });

  it("does not mark a server error as publicly cacheable", async () => {
    const { db, request } = await instance();
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.failing = true;
    const res = await request("/api/heartbeat", { method: "POST", headers: { Authorization: "Bearer some-token" } });
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("no-store");
    vi.restoreAllMocks();
  });

  it("pins HTTPS on admin pages and API, with no cross-origin connections allowed", async () => {
    const { request } = await instance();
    for (const path of ["/admin", "/api/ops/auth", "/api/ops/overview"]) {
      const res = await request(path);
      expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-security-policy")).toContain("connect-src 'self';");
    }
  });
});

describe.skipIf(!hasSqlite)("ops auth routes", () => {
  it("answers a database outage with an error instead of the setup screen", async () => {
    const { db, request, post } = await instance();
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.failing = true;
    const auth = await request("/api/ops/auth");
    expect(auth.status).toBe(500);
    expect(await auth.json()).toMatchObject({ code: "internal" });
    expect((await post("/api/ops/session", { email: "owner@example.com", password: "correct-horse-battery" })).status).toBe(500);
    expect((await request("/api/ops/overview", { headers: { Authorization: "Bearer some-token" } })).status).toBe(500);
    vi.restoreAllMocks();
  });

  it("asks for the setup token only while setup is open and one is configured", async () => {
    const open = await instance();
    expect(await (await open.request("/api/ops/auth")).json()).toEqual({ setup: true, setupToken: false, me: null });

    const { request, post } = await instance({ FOXWATCH_SETUP_TOKEN: "deploy-owner-token" });
    expect(await (await request("/api/ops/auth")).json()).toEqual({ setup: true, setupToken: true, me: null });
    const account = { email: "owner@example.com", password: "correct-horse-battery" };
    const refused = await post("/api/ops/setup", account);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "setup_token" });
    const made = await post("/api/ops/setup", { ...account, setupToken: "deploy-owner-token" });
    expect(made.status).toBe(200);
    expect(made.headers.get("set-cookie")).toMatch(/^foxwatch_ops=/);
    expect(await (await request("/api/ops/auth")).json()).toEqual({ setup: false, setupToken: false, me: null });
  });

  it("changes the password over the API and records lockouts in the audit log", async () => {
    const { db, request, post } = await instance();
    const account = { email: "owner@example.com", password: "correct-horse-battery" };
    const cookie = (await post("/api/ops/setup", account)).headers.get("set-cookie")!.split(";")[0]!;
    const other = (await post("/api/ops/session", account)).headers.get("set-cookie")!.split(";")[0]!;

    expect((await post("/api/ops/me/password", { current: "x", password: "a-brand-new-password" })).status).toBe(401);
    const wrong = await post("/api/ops/me/password", { current: "wrong-password-xx", password: "a-brand-new-password" }, { cookie });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ code: "current_password" });
    expect((await post("/api/ops/me/password", "null", { cookie })).status).toBe(400);
    const changed = await post("/api/ops/me/password", { current: account.password, password: "a-brand-new-password" }, { cookie });
    expect(changed.status).toBe(200);
    expect((await request("/api/ops/overview", { headers: { cookie } })).status).toBe(200);
    expect((await request("/api/ops/overview", { headers: { cookie: other } })).status).toBe(401);

    for (let i = 0; i < 12; i++) await post("/api/ops/session", { ...account, password: "wrong-password-xx" });
    expect((await post("/api/ops/session", { ...account, password: "a-brand-new-password" })).status).toBe(429);
    const actions = db.query<{ action: string; actor: string; meta_json: string | null }>("SELECT action, actor, meta_json FROM audit_log");
    // The attempted email is unverified input, so it is kept out of the actor column.
    expect(actions.filter((a) => a.action === "login-throttled")).toEqual([
      { action: "login-throttled", actor: "anonymous", meta_json: JSON.stringify({ scope: "pair", email: account.email }) },
    ]);

    // Each invented email trips its own limit, but the rows they can add are capped.
    for (let n = 0; n < 5; n++) {
      const headers = { "CF-Connecting-IP": `198.51.100.${n}` };
      for (let i = 0; i < 9; i++) await post("/api/ops/session", { email: `nobody${n}@example.com`, password: "wrong-password-xx" }, headers);
    }
    expect(db.query("SELECT id FROM audit_log WHERE action = 'login-throttled'")).toHaveLength(3);
    expect(actions.map((a) => a.action)).toContain("change-password");
  });
});

describe.skipIf(!hasSqlite)("public origin for alert links", () => {
  const stored = async (env: Env) => env.STATUS.get("origin:public");

  it("is never learned from anonymous traffic, only from a signed-in operator", async () => {
    const { env, request, post } = await instance();
    const account = { email: "owner@example.com", password: "correct-horse-battery" };
    const cookie = (await post("/api/ops/setup", account)).headers.get("set-cookie")!.split(";")[0]!;
    const other = "https://foxwatch.acct.workers.dev";
    for (const path of ["/", "/badge.svg", "/api/status.json", "/api/ops/auth", "/api/ops/overview"]) {
      await app.request(`${other}${path}`, undefined, env);
    }
    await app.request(`${other}/api/ops/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...account, password: "wrong-password-xx" }),
    }, env);
    expect(await stored(env)).toBeNull();

    expect((await request("/api/ops/overview", { headers: { cookie } })).status).toBe(200);
    expect(await stored(env)).toBe(ORIGIN);
    await app.request(`${other}/`, undefined, env);
    expect(await stored(env)).toBe(ORIGIN);
  });

  it("stores the public URL setting as an origin and rejects anything else", async () => {
    const { request, post } = await instance();
    const account = { email: "owner@example.com", password: "correct-horse-battery" };
    const cookie = (await post("/api/ops/setup", account)).headers.get("set-cookie")!.split(";")[0]!;
    const patch = (body: unknown) =>
      request("/api/ops/settings", { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
    const read = async () => (await (await request("/api/ops/settings", { headers: { cookie } })).json()) as { publicUrl: string; siteName: string };

    expect((await read()).publicUrl).toBe("");
    const saved = await patch({ publicUrl: "https://status.acme.test/history" });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ publicUrl: "https://status.acme.test" });
    // Other settings saves leave it alone.
    expect(await (await patch({ siteName: "Acme" })).json()).toMatchObject({ siteName: "Acme", publicUrl: "https://status.acme.test" });
    const bad = await patch({ publicUrl: "javascript:alert(1)" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "invalid_url" });
    expect((await read()).publicUrl).toBe("https://status.acme.test");
    expect(await (await patch({ publicUrl: "" })).json()).toMatchObject({ publicUrl: "" });
  });
});

describe.skipIf(!hasSqlite)("discord alert delivery", () => {
  const WEBHOOK = "https://discord.com/api/webhooks/1/token";

  async function discordInstance() {
    const made = await instance({ DISCORD_URL: WEBHOOK } as Partial<Env>);
    const account = { email: "owner@example.com", password: "correct-horse-battery" };
    const cookie = (await made.post("/api/ops/setup", account)).headers.get("set-cookie")!.split(";")[0]!;
    const channel = { id: "chat", type: "discord_webhook", secretName: "DISCORD_URL", events: ["fail", "recover"] };
    expect((await made.post("/api/ops/alert-channels", channel, { cookie })).status).toBe(200);
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(input).pathname}`);
      return new Response("{}", { status: new URL(input).hostname === "discord.com" ? 200 : 404 });
    });
    return { ...made, cookie, calls };
  }

  it("sends an alert with one request, without renaming the webhook first", async () => {
    const { env, calls } = await discordInstance();
    const { deliverAlert } = await import("./lib/alerts.ts");
    await deliverAlert(env, { type: "discord_webhook", secretName: "DISCORD_URL", events: ["fail"] }, {
      eventId: "evt-12345678",
      event: "fail",
      componentId: "api",
      title: "api is down",
      source: "monitor",
    });
    expect(calls).toEqual(["POST /api/webhooks/1/token"]);
    vi.unstubAllGlobals();
  });

  it("names the webhook when the channel is tested, after the test alert is out", async () => {
    const { post, cookie, calls } = await discordInstance();
    expect((await post("/api/ops/alert-channels/chat/test", {}, { cookie })).status).toBe(200);
    expect(calls[0]).toBe("POST /api/webhooks/1/token");
    await vi.waitFor(() => expect(calls).toContain("PATCH /api/webhooks/1/token"));
    expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});

describe.skipIf(!hasSqlite)("alert channels", () => {
  it("refuses to add a channel over an existing one unless asked to replace it", async () => {
    const { db, post } = await instance();
    const account = { email: "owner@example.com", password: "correct-horse-battery" };
    const cookie = (await post("/api/ops/setup", account)).headers.get("set-cookie")!.split(";")[0]!;
    const row = () => db.query<{ type: string; secret_name: string }>("SELECT type, secret_name FROM alert_channels WHERE id = 'primary-alerts'")[0];
    const slack = { id: "primary-alerts", type: "slack_webhook", secretName: "SLACK_WEBHOOK_URL", events: ["fail"] };
    const discord = { id: "primary-alerts", type: "discord_webhook", secretName: "DISCORD_WEBHOOK_URL", events: ["fail"] };

    expect((await post("/api/ops/alert-channels", slack, { cookie })).status).toBe(200);
    const again = await post("/api/ops/alert-channels", discord, { cookie });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe("exists");
    expect(row()).toEqual({ type: "slack_webhook", secret_name: "SLACK_WEBHOOK_URL" });

    expect((await post("/api/ops/alert-channels", { ...discord, replace: true }, { cookie })).status).toBe(200);
    expect(row()).toEqual({ type: "discord_webhook", secret_name: "DISCORD_WEBHOOK_URL" });
    const actions = db.query<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE '%alert-channel' ORDER BY rowid").map((r) => r.action);
    expect(actions).toEqual(["create-alert-channel", "upsert-alert-channel"]);
  });
});

describe.skipIf(!hasSqlite)("incident updates", () => {
  async function incidents() {
    const made = await instance();
    const account = { email: "owner@example.com", password: "correct-horse-battery" };
    const cookie = (await made.post("/api/ops/setup", account)).headers.get("set-cookie")!.split(";")[0]!;
    const update = async (id: string, body: unknown) => {
      const res = await made.post(`/api/ops/incidents/${id}/updates`, body, { cookie });
      return [res.status, ((await res.json()) as { code?: string }).code];
    };
    const row = (id: string) =>
      made.db.query<{ status: string; resolved_at: number | null }>("SELECT status, resolved_at FROM incidents WHERE id = ?", id)[0]!;
    const updates = (id: string) =>
      made.db.query<{ status: string }>("SELECT status FROM incident_updates WHERE incident_id = ? ORDER BY rowid", id).map((u) => u.status);
    return { ...made, update, row, updates };
  }

  it("keeps a resolved incident resolved unless it is reopened on purpose", async () => {
    const { db, update, row, updates } = await incidents();
    db.query("INSERT INTO incidents (id, status, impact, title, created_at, resolved_at, auto) VALUES ('old', 'resolved', 'degraded', 'Slow', 1000, 5000, 0)");

    // A postmortem note with no status leaves it resolved, at the time it was resolved.
    expect(await update("old", { body: "Postmortem published.", notify: false })).toEqual([200, undefined]);
    expect(row("old")).toEqual({ status: "resolved", resolved_at: 5000 });
    expect(await update("old", { status: "resolved", body: "Root cause added.", notify: false })).toEqual([200, undefined]);
    expect(row("old")).toEqual({ status: "resolved", resolved_at: 5000 });

    expect(await update("old", { status: "monitoring", body: "Typo fix.", notify: false })).toEqual([409, "incident_resolved"]);
    expect(await update("old", { status: "closed", body: "Done.", notify: false })).toEqual([400, "incident_status"]);
    expect(await update("old", { status: 7, body: "Done.", notify: false })).toEqual([400, "incident_status"]);
    expect(row("old")).toEqual({ status: "resolved", resolved_at: 5000 });
    expect(updates("old")).toEqual(["resolved", "resolved"]);

    expect(await update("old", { status: "investigating", body: "It is back.", reopen: true, notify: false })).toEqual([200, undefined]);
    expect(row("old")).toEqual({ status: "investigating", resolved_at: null });
  });

  it("moves an open incident through its statuses and keeps the status on a plain note", async () => {
    const { db, update, row, updates } = await incidents();
    db.query("INSERT INTO incidents (id, status, impact, title, created_at, auto) VALUES ('live', 'investigating', 'failing', 'Down', 1000, 0)");
    expect(await update("live", { status: "identified", body: "Found it.", notify: false })).toEqual([200, undefined]);
    expect(await update("live", { body: "Still working on it.", notify: false })).toEqual([200, undefined]);
    expect(row("live")).toEqual({ status: "identified", resolved_at: null });
    expect(await update("live", { status: "resolved", body: "Fixed.", notify: false })).toEqual([200, undefined]);
    expect(row("live").status).toBe("resolved");
    expect(row("live").resolved_at).toBeGreaterThan(5000);
    expect(updates("live")).toEqual(["identified", "identified", "resolved"]);
  });

  it("writes nothing when reopening would leave two automatic incidents open on a component", async () => {
    const { db, update, row, updates } = await incidents();
    db.query("INSERT INTO incidents (id, component_id, status, impact, title, created_at, resolved_at, auto) VALUES ('first', 'api', 'resolved', 'failing', 'Down', 1000, 5000, 1)");
    db.query("INSERT INTO incidents (id, component_id, status, impact, title, created_at, auto) VALUES ('second', 'api', 'investigating', 'failing', 'Down again', 6000, 1)");
    expect(await update("first", { status: "monitoring", body: "Reopening.", reopen: true, notify: false })).toEqual([409, "incident_open"]);
    expect(row("first")).toEqual({ status: "resolved", resolved_at: 5000 });
    expect(updates("first")).toEqual([]);
  });
});

describe.skipIf(!hasSqlite)("admin incident list", () => {
  type Listed = { id: string; componentIds: string[]; auto: boolean; resolvedAt: number | null; updates: Array<{ status: string; body: string; at: number }> };
  type Page = { open?: Listed[]; resolved: Listed[]; nextCursor: string | null };

  it("needs a signed-in operator", async () => {
    const { request } = await instance();
    expect((await request("/api/ops/incidents")).status).toBe(401);
  });

  it("lists every open incident however old, and pages through the resolved ones", async () => {
    const { db, post, request } = await instance();
    const account = { email: "owner@example.com", password: "correct-horse-battery" };
    const cookie = (await post("/api/ops/setup", account)).headers.get("set-cookie")!.split(";")[0]!;
    const list = async (query = "") => {
      const res = await request(`/api/ops/incidents${query}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      return (await res.json()) as Page;
    };

    // A manual incident left open, then buried under more automatic ones than the public snapshot keeps.
    db.query("INSERT INTO incidents (id, component_ids_json, status, impact, title, created_at, auto) VALUES ('manual', '[\"api\"]', 'monitoring', 'degraded', 'Slow checkout', 1000, 0)");
    db.query("INSERT INTO incident_updates (id, incident_id, status, body, created_at) VALUES ('u2', 'manual', 'monitoring', 'Fix is out.', 1200)");
    db.query("INSERT INTO incident_updates (id, incident_id, status, body, created_at) VALUES ('u1', 'manual', 'investigating', 'Looking.', 1000)");
    for (let n = 0; n < 120; n += 1) {
      const id = `auto${String(n).padStart(3, "0")}`;
      db.query("INSERT INTO incidents (id, component_id, status, impact, title, created_at, resolved_at, auto) VALUES (?, 'api', 'resolved', 'failing', 'Down', ?, ?, 1)", id, 2000 + n, 2500 + n);
      db.query("INSERT INTO incident_updates (id, incident_id, status, body, created_at) VALUES (?, ?, 'resolved', 'Recovered.', ?)", `up-${id}`, id, 2500 + n);
    }

    const first = await list();
    expect(first.open).toEqual([
      {
        id: "manual",
        componentIds: ["api"],
        title: "Slow checkout",
        status: "monitoring",
        impact: "degraded",
        auto: false,
        startedAt: 1000,
        resolvedAt: null,
        updates: [
          { status: "investigating", body: "Looking.", at: 1000 },
          { status: "monitoring", body: "Fix is out.", at: 1200 },
        ],
      },
    ]);
    expect(first.resolved).toHaveLength(50);
    expect(first.resolved[0]!.id).toBe("auto119");
    expect(first.resolved.every((incident) => incident.auto && incident.updates.length === 1)).toBe(true);

    const second = await list(`?cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.open).toBeUndefined();
    expect(second.resolved.map((incident) => incident.id).slice(0, 2)).toEqual(["auto069", "auto068"]);
    const third = await list(`?cursor=${encodeURIComponent(second.nextCursor!)}`);
    expect(third.resolved).toHaveLength(20);
    expect(third.nextCursor).toBeNull();

    // One request can ask for more, so a refresh can keep everything that is on screen.
    const wide = await list("?limit=120");
    expect(wide.resolved).toHaveLength(120);
    expect(wide.nextCursor).toBeNull();
    expect((await request("/api/ops/incidents?cursor=nope", { headers: { cookie } })).status).toBe(400);
  });
});

describe.skipIf(!hasSqlite)("heartbeat pings", () => {
  it("runs the check at once for a first ping or one that ends a miss, and keeps the last ping on rotation", async () => {
    const rescheduled: string[] = [];
    const { db, post } = await instance({
      MONITOR: {
        idFromName: (name: string) => name,
        get: (name: string) => ({ reschedule: async () => void rescheduled.push(name) }),
      } as unknown as Env["MONITOR"],
    });
    const { sha256Hex } = await import("./lib/crypto.ts");
    db.query(
      `INSERT INTO monitors (id, origin, type, name, group_id, group_name, component_id, component_name, config_json, created_at, updated_at)
       VALUES ('job', 'ui', 'heartbeat', 'Job', 'core', 'Core', 'job', 'Job', ?, 0, 0)`,
      JSON.stringify({ type: "heartbeat", id: "job", intervalMs: 600_000, graceMs: 120_000 }),
    );
    db.query("INSERT INTO heartbeats (monitor_id, token_hash, last_ping_at, created_at) VALUES ('job', ?, NULL, 0)", await sha256Hex("tok"));
    const ping = () => post("/api/heartbeat", { token: "tok" });
    const lastPing = () => db.query<{ last_ping_at: number | null }>("SELECT last_ping_at FROM heartbeats")[0]!.last_ping_at;

    expect((await ping()).status).toBe(200);
    expect(rescheduled).toEqual(["monitor:job"]);

    db.query("UPDATE monitors SET confirmed_outcome = 'pass'");
    db.query("UPDATE heartbeats SET last_ping_at = 1");
    expect((await ping()).status).toBe(200);
    expect(rescheduled).toHaveLength(1);

    db.query("UPDATE monitors SET confirmed_outcome = 'fail'");
    db.query("UPDATE heartbeats SET last_ping_at = 1");
    expect((await ping()).status).toBe(200);
    expect(rescheduled).toHaveLength(2);

    const account = { email: "owner@example.com", password: "correct-horse-battery" };
    const cookie = (await post("/api/ops/setup", account)).headers.get("set-cookie")!.split(";")[0]!;
    const before = lastPing();
    expect(before).toBeGreaterThan(1);
    const rotated = await post("/api/ops/heartbeats/job/rotate", {}, { cookie });
    expect(rotated.status).toBe(200);
    expect(lastPing()).toBe(before);
    expect((await ping()).status).toBe(404);
  });
});

describe.skipIf(!hasSqlite)("editing a check", () => {
  it("clears the degrade threshold and body when a PATCH sends them as null, and keeps them when it leaves them out", async () => {
    const { post, request } = await instance({
      MONITOR: {
        idFromName: (name: string) => name,
        get: () => ({ reschedule: async () => {} }),
      } as unknown as Env["MONITOR"],
      STATUS_HUB: { idFromName: (name: string) => name, get: () => ({ push: async () => {} }) } as unknown as Env["STATUS_HUB"],
    });
    const account = { email: "owner@example.com", password: "correct-horse-battery" };
    const cookie = (await post("/api/ops/setup", account)).headers.get("set-cookie")!.split(";")[0]!;
    const patch = (body: unknown) =>
      request("/api/ops/monitors/api", { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
    const stored = async () => {
      const overview = (await (await request("/api/ops/overview", { headers: { cookie } })).json()) as { monitors: Array<{ config: Record<string, unknown> }> };
      return overview.monitors[0]!.config;
    };

    const created = await post(
      "/api/ops/monitors",
      { id: "api", name: "API", type: "http", url: "https://api.example.com/health", method: "POST", body: '{"a":1}', timeout: 5000, degradedIf: { latencyMs: 2000 } },
      { cookie },
    );
    expect(created.status).toBe(200);
    expect(await stored()).toMatchObject({ body: '{"a":1}', degradedIf: { latencyMs: 2000 } });

    // An older client that drops the keys changes nothing.
    expect((await patch({ name: "API" })).status).toBe(200);
    expect(await stored()).toMatchObject({ body: '{"a":1}', degradedIf: { latencyMs: 2000 } });
    // The stale threshold is what used to reject a shorter timeout.
    expect(((await (await patch({ timeout: 1000 })).json()) as { code: string }).code).toBe("latency");

    expect((await patch({ timeout: 1000, degradedIf: null, body: null })).status).toBe(200);
    const config = await stored();
    expect(config.timeoutMs).toBe(1000);
    expect(config.degradedIf).toBeUndefined();
    expect(config.body).toBeUndefined();
  });

  it("accepts what the admin form sends, and reads it back into the same form", async () => {
    const { buildCheckPayload, emptyForm, formFromMonitor } = await import("../../web/src/ops/check-payload.ts");
    type Monitor = Parameters<typeof formFromMonitor>[0];
    const { post, request } = await instance({
      MONITOR: {
        idFromName: (name: string) => name,
        get: () => ({ reschedule: async () => {} }),
      } as unknown as Env["MONITOR"],
      STATUS_HUB: { idFromName: (name: string) => name, get: () => ({ push: async () => {} }) } as unknown as Env["STATUS_HUB"],
    });
    const account = { email: "owner@example.com", password: "correct-horse-battery" };
    const cookie = (await post("/api/ops/setup", account)).headers.get("set-cookie")!.split(";")[0]!;
    const monitors = async () =>
      ((await (await request("/api/ops/overview", { headers: { cookie } })).json()) as { monitors: Monitor[] }).monitors;

    const form = {
      ...emptyForm(),
      name: "Checkout",
      url: "https://api.example.com/health",
      method: "POST" as const,
      headers: [{ key: "Accept", kind: "text" as const, value: "application/json" }],
      body: '{"ping":true}',
      expectStatus: "200, 204",
      bodyIncludes: "ok",
      assertions: [
        { path: "$.status", op: "equals" as const, value: "ok" },
        { path: "$.queue.depth", op: "lt" as const, value: "100" },
        { path: "$.error", op: "not_exists" as const, value: "" },
      ],
      assertionFailThreshold: 2,
      intervalValue: "90",
      intervalUnit: "s" as const,
      timeout: "5",
      regions: ["wnam", "weur"],
      groupName: "Payments",
      critical: true,
      retries: "1",
      followRedirects: false,
      failWhen: "any" as const,
      confirmFails: "2",
      latencyThreshold: "1500",
      allowedHosts: "api.example.com",
    };
    const built = buildCheckPayload(form, null, []);
    if (!built.ok) throw new Error(built.error);
    const created = await post("/api/ops/monitors", built.payload, { cookie });
    expect(await created.json()).toMatchObject({ ok: true });
    expect(created.status).toBe(200);

    const saved = (await monitors())[0]!;
    expect(saved).toMatchObject({ id: built.id, name: "Checkout", groupName: "Payments", critical: true });
    expect(saved.config).toMatchObject({
      url: "https://api.example.com/health",
      method: "POST",
      body: '{"ping":true}',
      intervalMs: 90_000,
      timeoutMs: 5_000,
      regions: ["wnam", "weur"],
      degradedIf: { latencyMs: 1500 },
    });

    // Opening the saved check and saving it untouched changes nothing.
    const reopened = formFromMonitor(saved);
    const again = buildCheckPayload(reopened, saved, await monitors());
    if (!again.ok) throw new Error(again.error);
    const patched = await request(`/api/ops/monitors/${saved.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(again.payload),
    });
    expect(patched.status).toBe(200);
    expect((await monitors())[0]!.config).toEqual(saved.config);
  });
});

describe.skipIf(!hasSqlite)("malformed request bodies", () => {
  it("treats a non-string heartbeat token as an unknown token", async () => {
    const { post } = await instance();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const body of [{ token: 1 }, { token: { a: 1 } }, "null", "[1]", "{not json"]) {
      expect((await post("/api/heartbeat", body)).status).toBe(404);
    }
    expect(error).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("answers 400 or 404, never 500, on ops routes", async () => {
    const { db, post, request } = await instance();
    const account = { email: "owner@example.com", password: "correct-horse-battery" };
    const cookie = (await post("/api/ops/setup", account)).headers.get("set-cookie")!.split(";")[0]!;
    db.query("INSERT INTO incidents (id, status, impact, title, created_at, auto) VALUES ('inc-1', 'investigating', 'degraded', 'Down', 1, 0)");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const send = async (method: string, path: string, body: unknown) => {
      const res = await request(path, {
        method,
        headers: { "content-type": "application/json", cookie },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
      return [res.status, ((await res.json()) as { code: string }).code];
    };

    for (const body of ["", "{not json", "null", "[]", "7"]) {
      expect(await send("POST", "/api/ops/monitors", body)).toEqual([400, "invalid"]);
      expect(await send("POST", "/api/ops/monitors/test-request", body)).toEqual([400, "invalid"]);
      expect(await send("POST", "/api/ops/incidents", body)).toEqual([400, "invalid"]);
      expect(await send("POST", "/api/ops/incidents/inc-1/updates", body)).toEqual([400, "invalid"]);
      expect(await send("POST", "/api/ops/users", body)).toEqual([400, "invalid_email"]);
      expect(await send("POST", "/api/ops/monitors/missing/mute", body)).toEqual([404, "not_found"]);
      expect(await send("PATCH", "/api/ops/monitors/missing", body)).toEqual([404, "not_found"]);
    }
    expect(await send("POST", "/api/ops/incidents", { title: 123 })).toEqual([400, "title"]);
    expect(await send("POST", "/api/ops/incidents", { title: { a: 1 }, body: 5 })).toEqual([400, "title"]);
    expect(await send("POST", "/api/ops/incidents", { title: "Down", componentId: 5 })).toEqual([400, "component"]);
    expect(await send("POST", "/api/ops/incidents/inc-1/updates", { body: 5 })).toEqual([400, "update_body"]);
    expect(await send("POST", "/api/ops/incidents/inc-1/updates", { status: "resolved" })).toEqual([400, "update_body"]);
    expect(db.query("SELECT id FROM incident_updates")).toHaveLength(0);
    expect(error).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
