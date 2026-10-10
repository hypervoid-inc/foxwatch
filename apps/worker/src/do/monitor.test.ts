import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heartbeat, http, type Check } from "@foxwatch/config";
import type { ProbeResult } from "@foxwatch/engine";
import type { Env } from "../env.ts";
import type { AlertBody } from "../lib/alerts.ts";
import { hasSqlite, testDb } from "../../test/sqlite-d1.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
const { Monitor } = await import("./monitor.ts");

const START = Date.parse("2026-03-01T00:00:00Z");
const DAY = 86_400_000;
const PASS: ProbeResult = { outcome: "pass", latencyMs: 40, statusCode: 200, colo: "SJC" };
const FAIL: ProbeResult = { outcome: "fail", latencyMs: 0, statusCode: null, colo: "SJC", errorClass: "timeout" };

async function harness(check: Check) {
  const db = await testDb();
  const sent: AlertBody[] = [];
  const stored = new Map<string, unknown>();
  const state = { alarm: null as number | null, publishes: 0, probes: 0, probesCleared: 0 };
  let probe: (region: string) => Promise<ProbeResult> | ProbeResult = () => PASS;
  const ctx = {
    id: { name: `monitor:${check.id}` },
    storage: {
      get: async (key: string) => stored.get(key),
      put: async (key: string, value: unknown) => void stored.set(key, value),
      getAlarm: async () => state.alarm,
      setAlarm: async (when: number) => void (state.alarm = when),
      deleteAlarm: async () => void (state.alarm = null),
      deleteAll: async () => stored.clear(),
    },
  };
  const env = {
    DB: db.DB,
    ALERTS: { send: async (body: AlertBody) => void sent.push(body) },
    METRICS: { writeDataPoint: () => {} },
    PROBE: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        run: async () => {
          state.probes += 1;
          return probe(name.split(":")[1]!);
        },
        destroy: async () => void (state.probesCleared += 1),
      }),
    },
    SCHEDULER: {
      idFromName: (name: string) => name,
      get: () => ({ requestPublish: async () => void (state.publishes += 1) }),
    },
  } as unknown as Env;
  db.query(
    `INSERT INTO monitors (id, origin, type, name, group_id, group_name, component_id, component_name, config_json, created_at, updated_at)
     VALUES (?, 'ui', ?, 'Check', 'core', 'Core', 'api', 'API', ?, 0, 0)`,
    check.id,
    check.type,
    JSON.stringify(check),
  );
  const monitor = Object.assign(new Monitor(undefined as never, undefined as never), { ctx, env });
  const row = () =>
    db.query<{ confirmed_outcome: string | null; consecutive_fails: number }>(
      "SELECT confirmed_outcome, consecutive_fails FROM monitors WHERE id = ?",
      check.id,
    )[0]!;
  /** Fires the alarm at its scheduled time and returns the delay until the next one. */
  const fire = async () => {
    if (state.alarm != null) vi.setSystemTime(state.alarm);
    await monitor.alarm();
    return state.alarm! - Date.now();
  };
  return { db, monitor, sent, stored, state, row, fire, setProbe: (next: typeof probe) => void (probe = next) };
}

describe.skipIf(!hasSqlite)("Monitor", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("re-checks within a minute while a daily check is unconfirmed, then returns to its interval", async () => {
    const t = await harness(http("api", { url: "https://example.com/", interval: "24h", regions: ["wnam"], retries: 0, confirmFails: 3 }));
    expect(await t.fire()).toBe(DAY);
    expect(t.row().confirmed_outcome).toBe("pass");

    t.setProbe(() => FAIL);
    expect(await t.fire()).toBe(60_000);
    expect(await t.fire()).toBe(60_000);
    expect(t.sent).toHaveLength(0);
    expect(await t.fire()).toBe(DAY);
    expect(t.row()).toMatchObject({ confirmed_outcome: "fail", consecutive_fails: 3 });
    expect(t.sent.map((alert) => alert.event)).toEqual(["fail"]);
    // Confirmed two minutes after the first failing run, not two days.
    expect(Date.now() - START).toBe(DAY + 2 * 60_000);

    t.setProbe(() => PASS);
    expect(await t.fire()).toBe(60_000);
    expect(t.row().confirmed_outcome).toBe("fail");
    expect(await t.fire()).toBe(DAY);
    expect(t.sent.map((alert) => alert.event)).toEqual(["fail", "recover"]);
    expect(t.state.publishes).toBe(6);
  });

  it("waits for a heartbeat's first ping, then notices a miss at its deadline", async () => {
    const t = await harness(heartbeat("job", { interval: "10m", grace: "2m", confirmFails: 2 }));
    expect(await t.fire()).toBe(600_000);
    expect(await t.fire()).toBe(600_000);
    expect(t.row()).toMatchObject({ confirmed_outcome: null, consecutive_fails: 0 });
    expect(t.db.query("SELECT outcome FROM check_latest")).toEqual([{ outcome: "pending" }]);
    expect(t.db.query("SELECT 1 FROM check_runs")).toHaveLength(0);
    expect(t.sent).toHaveLength(0);

    const ping = Date.now() + 5000;
    vi.setSystemTime(ping);
    t.db.query("INSERT INTO heartbeats (monitor_id, token_hash, last_ping_at, created_at) VALUES ('job', 'hash', ?, ?)", ping, ping);
    await t.monitor.reschedule(1);
    expect(await t.fire()).toBe(600_000);
    expect(t.row().confirmed_outcome).toBe("pass");
    // Ten minutes in, the deadline is two minutes away: look again right after it.
    expect(await t.fire()).toBe(120_000 + 1000 - 1);
    expect(await t.fire()).toBe(60_000);
    expect(t.row()).toMatchObject({ confirmed_outcome: "pass", consecutive_fails: 1 });
    expect(await t.fire()).toBe(600_000);
    expect(t.sent).toMatchObject([{ event: "fail", checkType: "heartbeat" }]);
    expect(Date.now() - ping).toBe(12 * 60_000 + 1000 + 60_000);

    // The next ping reschedules the check, and recovery is confirmed a minute later.
    t.db.query("UPDATE heartbeats SET last_ping_at = ? WHERE monitor_id = 'job'", Date.now());
    await t.monitor.reschedule(1);
    expect(await t.fire()).toBe(60_000);
    await t.fire();
    expect(t.sent.map((alert) => alert.event)).toEqual(["fail", "recover"]);
  });

  it("reaches a verdict from the regions that answered when one probe breaks", async () => {
    const t = await harness(http("api", { url: "https://example.com/", regions: ["wnam", "weur", "apac"], retries: 0, confirmFails: 1 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    t.setProbe((region) => {
      if (region === "apac") throw new Error("Durable Object reset");
      return FAIL;
    });
    await t.fire();
    expect(t.row().confirmed_outcome).toBe("fail");
    expect(t.db.query<{ region: string }>("SELECT region FROM check_latest ORDER BY region").map((r) => r.region)).toEqual(["weur", "wnam"]);
    expect(t.sent.map((alert) => alert.event)).toEqual(["fail"]);
  });

  it("changes nothing and retries soon when too few regions answered", async () => {
    const t = await harness(http("api", { url: "https://example.com/", interval: "1h", regions: ["wnam", "weur", "apac"], retries: 0, confirmFails: 1 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    t.setProbe((region) => {
      if (region !== "wnam") throw new Error("Durable Object reset");
      return FAIL;
    });
    expect(await t.fire()).toBe(60_000);
    expect(t.row()).toMatchObject({ confirmed_outcome: null, consecutive_fails: 0 });
    expect(t.sent).toHaveLength(0);
  });

  it("joins a manual run to the run already in flight", async () => {
    const t = await harness(http("api", { url: "https://example.com/", regions: ["wnam"], retries: 0, confirmFails: 3 }));
    let release: (result: ProbeResult) => void = () => {};
    t.setProbe(() => new Promise<ProbeResult>((resolve) => (release = resolve)));
    const alarm = t.monitor.alarm();
    await vi.waitFor(() => expect(t.state.probes).toBe(1));
    const manual = t.monitor.runNow();
    release(FAIL);
    await Promise.all([alarm, manual]);
    expect(t.state.probes).toBe(1);
    expect(t.row().consecutive_fails).toBe(1);
  });

  it("retries soon after a run that threw, and clears itself once the check is deleted", async () => {
    const t = await harness(http("api", { url: "https://example.com/", interval: "24h", regions: ["wnam"], retries: 0 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await t.monitor.ensureAlarm(DAY);
    expect(t.stored.get("monitorId")).toBe("api");
    // The check's own row cannot be read: retry in a minute, not in a day.
    t.db.failing = true;
    expect(await t.fire()).toBe(60_000);
    t.db.failing = false;
    const prepare = t.db.DB.prepare.bind(t.db.DB);
    (t.db.DB as { prepare: unknown }).prepare = (sql: string) => {
      if (/check_latest/.test(sql)) throw new Error("D1_ERROR: transient");
      return prepare(sql);
    };
    expect(await t.fire()).toBe(60_000);
    (t.db.DB as { prepare: unknown }).prepare = prepare;

    t.db.query("DELETE FROM monitors");
    await t.monitor.alarm();
    expect(t.stored.size).toBe(0);
    expect(t.state.alarm).toBeNull();
    t.stored.set("monitorId", "api");
    await t.monitor.destroy(["wnam"]);
    expect(t.stored.size).toBe(0);
    expect(t.state.alarm).toBeNull();
    expect(t.state.probesCleared).toBe(1);
  });
});
