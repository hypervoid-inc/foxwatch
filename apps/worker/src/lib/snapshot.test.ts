import { describe, expect, it, vi } from "vitest";
import type { Env } from "../env.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
const { forgetSecretName, loadSettings, publishSnapshot, readSnapshot, rememberSecretNames, updateSettings } = await import("./snapshot.ts");
const { hasSqlite, testDb } = await import("../../test/sqlite-d1.ts");

// The settings writers are single SQL statements, so they run against real
// SQLite. node:sqlite is missing or flagged on older Node 22 releases.
const sqlite = await import("node:sqlite").catch(() => null);

function settingsDb(failReads: () => boolean = () => false) {
  const db = new sqlite!.DatabaseSync(":memory:");
  db.exec("CREATE TABLE site_settings (key TEXT PRIMARY KEY NOT NULL, value_json TEXT NOT NULL)");
  const prepare = (sql: string) => {
    let args: Array<string | number | null> = [];
    const statement = {
      bind: (...values: Array<string | number | null>) => {
        args = values;
        return statement;
      },
      run: async () => {
        db.prepare(sql).run(...args);
        return { success: true, meta: {}, results: [] };
      },
      raw: async () => {
        if (failReads()) throw new Error("D1_ERROR");
        return db.prepare(sql).all(...args).map((row) => Object.values(row));
      },
    };
    return statement;
  };
  const stored = () =>
    (db.prepare("SELECT value_json FROM site_settings WHERE key = 'settings'").get() as { value_json: string } | undefined)?.value_json;
  const store = (json: string) =>
    db.prepare("INSERT INTO site_settings (key, value_json) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(json);
  return { env: { DB: { prepare } } as unknown as Env, stored, store };
}

describe.skipIf(!sqlite)("settings row", () => {
  it("registers and forgets secret names without touching other settings", async () => {
    const { env, stored } = settingsDb();
    await forgetSecretName(env, "API_TOKEN");
    expect(stored()).toBeUndefined();
    await rememberSecretNames(env, ["B_TOKEN", "A_TOKEN", "bad name", "FOXWATCH_CF_API_TOKEN"]);
    expect((await loadSettings(env)).secrets).toEqual(["A_TOKEN", "B_TOKEN"]);
    await updateSettings(env, { siteName: "Acme", homepageUrl: "https://acme.test/", globe: false });
    await rememberSecretNames(env, ["A_TOKEN", "C_TOKEN"]);
    await forgetSecretName(env, "B_TOKEN");
    expect(await loadSettings(env)).toEqual({
      siteName: "Acme",
      secrets: ["A_TOKEN", "C_TOKEN"],
      homepageUrl: "https://acme.test/",
      publicUrl: null,
      iconUpdatedAt: null,
      globe: false,
    });
  });

  it("writes only the keys in a settings patch", async () => {
    const { env } = settingsDb();
    await updateSettings(env, { siteName: "Acme", homepageUrl: "https://acme.test/", publicUrl: "https://status.acme.test/history", iconUpdatedAt: 5 });
    // A name registered after another request read the row survives that request's write.
    await rememberSecretNames(env, ["API_TOKEN"]);
    const next = await updateSettings(env, { homepageUrl: null, globe: false });
    expect(next).toEqual({
      siteName: "Acme",
      secrets: ["API_TOKEN"],
      homepageUrl: null,
      publicUrl: "https://status.acme.test",
      iconUpdatedAt: 5,
      globe: false,
    });
  });

  it("skips the write when every name is already registered", async () => {
    const { env, stored } = settingsDb();
    await rememberSecretNames(env, ["API_TOKEN"]);
    const before = stored();
    await rememberSecretNames(env, ["API_TOKEN", "API_TOKEN"]);
    expect(stored()).toBe(before);
  });

  it("never saves an empty registry after a failed read", async () => {
    let failing = false;
    const { env, stored } = settingsDb(() => failing);
    await rememberSecretNames(env, ["API_TOKEN"]);
    const before = stored();
    failing = true;
    await expect(rememberSecretNames(env, ["OTHER_TOKEN"])).rejects.toThrow();
    await expect(updateSettings(env, {})).rejects.toThrow();
    expect((await loadSettings(env)).secrets).toEqual([]);
    expect(stored()).toBe(before);
    failing = false;
    expect((await loadSettings(env)).secrets).toEqual(["API_TOKEN"]);
  });

  it("treats an unreadable row as empty", async () => {
    for (const row of ["not json", "[]", '"text"']) {
      const { env, store } = settingsDb();
      store(row);
      await rememberSecretNames(env, ["API_TOKEN"]);
      await forgetSecretName(env, "MISSING");
      expect(await updateSettings(env, { globe: false })).toMatchObject({ secrets: ["API_TOKEN"], globe: false });
    }
  });
});

describe.skipIf(!hasSqlite)("snapshot cache", () => {
  async function instance() {
    const db = await testDb();
    const kv = new Map<string, string>();
    const cache = { failing: false, puts: 0, ttl: 0 };
    const requested = { publishes: 0 };
    const env = {
      DB: db.DB,
      STATUS: {
        get: async (key: string) => kv.get(key) ?? null,
        put: async (key: string, value: string, opts: { expirationTtl: number }) => {
          if (cache.failing) throw new Error("KV PUT failed: 429 Too Many Requests");
          cache.puts += 1;
          cache.ttl = opts.expirationTtl;
          kv.set(key, value);
        },
      },
      SCHEDULER: {
        idFromName: (name: string) => name,
        get: () => ({ requestPublish: async () => void (requested.publishes += 1) }),
      },
    } as unknown as Env;
    return { env, kv, cache, requested };
  }

  it("returns the snapshot and asks for a later publish when the cache write fails", async () => {
    const { env, kv, cache, requested } = await instance();
    vi.spyOn(console, "error").mockImplementation(() => {});
    cache.failing = true;
    const snap = await publishSnapshot(env);
    expect(snap.banner).toBe("unknown");
    expect(kv.size).toBe(0);
    expect(requested.publishes).toBe(1);
    // The coalesced publish itself must not ask for another one.
    await publishSnapshot(env, { retry: false });
    expect(requested.publishes).toBe(1);
    vi.restoreAllMocks();
  });

  it("pushes a notice for the snapshot to the hub, and says so when the push fails", async () => {
    const { env } = await instance();
    const pushed: Array<Record<string, unknown>> = [];
    const hub = { failing: false };
    (env as unknown as { STATUS_HUB: unknown }).STATUS_HUB = {
      idFromName: (name: string) => name,
      get: () => ({
        push: async (notice: Record<string, unknown>) => {
          if (hub.failing) throw new Error("hub unavailable");
          pushed.push(notice);
        },
      }),
    };
    const snap = await publishSnapshot(env);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ generatedAt: snap.generatedAt, status: snap.banner });
    expect(pushed[0]!.etag).toEqual(expect.any(String));
    expect(pushed[0]!.banner).toContain('id="live-banner"');
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    hub.failing = true;
    expect((await publishSnapshot(env)).banner).toBe(snap.banner);
    expect(errors).toHaveBeenCalledWith("live push failed", expect.any(Error));
    vi.restoreAllMocks();
  });

  it("keeps the cache well past one cron period and rebuilds once it is too old", async () => {
    const { env, kv, cache } = await instance();
    const first = await readSnapshot(env);
    expect(cache.puts).toBe(1);
    expect(cache.ttl).toBeGreaterThanOrEqual(300);
    expect((await readSnapshot(env)).generatedAt).toBe(first.generatedAt);
    expect(cache.puts).toBe(1);
    kv.set("snapshot:public", JSON.stringify({ ...first, generatedAt: Date.now() - 10 * 60_000, siteName: "Old" }));
    const rebuilt = await readSnapshot(env);
    expect(rebuilt.siteName).toBe("Foxwatch");
    expect(cache.puts).toBe(2);
  });

  it("serves the cached copy, marked stale, when it is too old and the database cannot be read", async () => {
    const { env, kv, cache } = await instance();
    const first = await readSnapshot(env);
    const old = Date.now() - 5 * 60_000;
    kv.set("snapshot:public", JSON.stringify({ ...first, generatedAt: old, siteName: "Old" }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const down = () => {
      throw new Error("D1_ERROR: unavailable");
    };
    const broken = { ...env, DB: { prepare: down, batch: down } } as unknown as Env;
    expect(await readSnapshot(broken)).toMatchObject({ siteName: "Old", generatedAt: old, stale: true });
    expect(cache.puts).toBe(1);
    expect(errors).toHaveBeenCalledWith("snapshot rebuild failed, serving the cached copy", expect.any(Error));
    // The next visitors get the same copy without another rebuild attempt.
    errors.mockClear();
    expect((await readSnapshot(broken)).stale).toBe(true);
    expect(errors).not.toHaveBeenCalled();
    // With nothing cached there is nothing to fall back on.
    kv.clear();
    await expect(readSnapshot(broken)).rejects.toThrow(/unavailable/);
    vi.restoreAllMocks();
  });
});
