import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env.ts";
import { hasSqlite, testDb } from "../test/sqlite-d1.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
const { default: worker } = await import("./index.ts");

const ORIGIN = "https://status.example.com";

function kvStore() {
  const store = new Map<string, string>();
  const reads: string[] = [];
  const STATUS = {
    get: async (key: string) => {
      reads.push(key);
      return store.get(key) ?? null;
    },
    put: async (key: string, value: string) => void store.set(key, value),
  };
  return { STATUS, store, reads };
}

function context() {
  const pending: Array<Promise<unknown>> = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext;
  return { ctx, settle: () => Promise.all(pending) };
}

/** A D1 binding that is down: every statement and batch rejects. */
function brokenDb() {
  const calls = { count: 0 };
  const down = async () => {
    calls.count++;
    throw new Error("D1_ERROR: unavailable");
  };
  const statement = { bind: () => statement, run: down, all: down, raw: down, first: down };
  return { DB: { prepare: () => statement, batch: down } as unknown as D1Database, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(!hasSqlite)("worker request path", () => {
  it("reads the snapshot once per public hit and checks the schema once per isolate", async () => {
    const db = await testDb({ schema: false });
    const statements: string[] = [];
    const prepare = db.DB.prepare.bind(db.DB);
    db.DB.prepare = ((sql: string) => {
      statements.push(sql);
      return prepare(sql);
    }) as D1Database["prepare"];
    const { STATUS, reads } = kvStore();
    const bootstrap = vi.fn(async () => {});
    const env = {
      DB: db.DB,
      STATUS,
      SCHEDULER: { idFromName: (name: string) => name, get: () => ({ bootstrap }) },
    } as unknown as Env;
    const { ctx, settle } = context();

    // First request after a deploy: the schema is built, the cache is empty, the schedule is started.
    expect((await worker.fetch(new Request(`${ORIGIN}/`), env, ctx)).status).toBe(200);
    await settle();
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(statements.some((sql) => sql.includes("schema_version"))).toBe(true);

    for (const path of ["/", "/badge.svg", "/feed.xml", "/api/status.json", "/api/status/live.json", "/api/status/live.v2.json"]) {
      statements.length = 0;
      reads.length = 0;
      const res = await worker.fetch(new Request(`${ORIGIN}${path}`), env, ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get("etag")).toBeTruthy();
      expect(reads).toEqual(["snapshot:public"]);
      expect(statements).toEqual([]);
    }
    await settle();
    expect(bootstrap).toHaveBeenCalledOnce();
  });

  it("opens the live socket only for pages that ask for the current block shape", async () => {
    const hub = vi.fn(async () => new Response("hub"));
    const env = { STATUS_HUB: { idFromName: (name: string) => name, get: () => ({ fetch: hub }) } } as unknown as Env;
    const { ctx } = context();
    const upgrade = { headers: { Upgrade: "websocket" } };

    // A page left open across the deploy that changed the uptime bars.
    expect((await worker.fetch(new Request(`${ORIGIN}/live`, upgrade), env, ctx)).status).toBe(426);
    expect((await worker.fetch(new Request(`${ORIGIN}/live?v=1`, upgrade), env, ctx)).status).toBe(426);
    expect(hub).not.toHaveBeenCalled();

    expect(await (await worker.fetch(new Request(`${ORIGIN}/live?v=2`, upgrade), env, ctx)).text()).toBe("hub");
    expect(hub).toHaveBeenCalledOnce();
  });

  it("serves public pages from the cached snapshot while D1 is down, and nothing else", async () => {
    const healthy = await testDb();
    const { STATUS } = kvStore();
    const { ctx } = context();
    await worker.fetch(new Request(`${ORIGIN}/`), { DB: healthy.DB, STATUS } as unknown as Env, ctx);

    vi.spyOn(console, "error").mockImplementation(() => {});
    const { DB, calls } = brokenDb();
    const env = { DB, STATUS } as unknown as Env;
    for (const path of ["/", "/history", "/badge.svg", "/feed.xml", "/api/status.json"]) {
      expect((await worker.fetch(new Request(`${ORIGIN}${path}`), env, ctx)).status).toBe(200);
    }
    // The failed check is not remembered: every request tried again.
    expect(calls.count).toBeGreaterThanOrEqual(5);

    const ops = await worker.fetch(new Request(`${ORIGIN}/api/ops/overview`), env, ctx);
    expect(ops.status).toBe(500);
    expect(await ops.json()).toMatchObject({ code: "internal" });
    const ping = await worker.fetch(
      new Request(`${ORIGIN}/api/heartbeat`, { method: "POST", headers: { Authorization: "Bearer some-token" } }),
      env,
      ctx,
    );
    expect(ping.status).toBe(500);
  });
});
