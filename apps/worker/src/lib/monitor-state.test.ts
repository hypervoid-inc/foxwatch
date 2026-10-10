import { describe, expect, it, vi } from "vitest";
import { http } from "@foxwatch/config";
import type { Env } from "../env.ts";
import type { AlertBody } from "./alerts.ts";
import { hasSqlite, testDb, type TestDb } from "../../test/sqlite-d1.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
const { deliverPending, pruneRunHistory, RUN_HISTORY_MS, settleRun } = await import("./monitor-state.ts");

const CONFIG = JSON.stringify(http("api", { url: "https://example.com/health", regions: ["wnam", "weur", "apac"] }));
const DAY = 86_400_000;

async function instance() {
  const db = await testDb();
  const sent: AlertBody[] = [];
  const queue = { failing: false };
  const env = {
    DB: db.DB,
    ALERTS: {
      send: async (body: AlertBody) => {
        if (queue.failing) throw new Error("queue unavailable");
        sent.push(body);
      },
    },
  } as unknown as Env;
  let clock = Date.parse("2026-03-01T00:00:00Z");
  const addMonitor = (id: string, componentId = "api", configJson = CONFIG) =>
    db.query(
      `INSERT INTO monitors (id, origin, type, name, group_id, group_name, component_id, component_name, config_json, created_at, updated_at)
       VALUES (?, 'ui', 'http', ?, 'core', 'Core', ?, 'API', ?, 0, 0)`,
      id,
      id,
      componentId,
      configJson,
    );
  const run = (monitorId: string, outcome: "pass" | "degraded" | "fail" | null, confirmFails = 2, configJson = CONFIG) => {
    clock += 60_000;
    return settleRun(env, {
      monitorId,
      configJson,
      checkType: "http",
      results: [{ region: "wnam", outcome: outcome ?? "pass", latencyMs: 40, statusCode: 200, colo: "SJC" }],
      outcome,
      confirmFails,
    }, clock);
  };
  const state = (componentId = "api") =>
    db.query<{ status: string; pending_json: string | null; pending_lease: number | null }>(
      "SELECT status, pending_json, pending_lease FROM component_state WHERE component_id = ?",
      componentId,
    )[0];
  const incidents = () =>
    db.query<{ id: string; auto: number; impact: string; status: string; resolved_at: number | null; created_at: number }>(
      "SELECT id, auto, impact, status, resolved_at, created_at FROM incidents ORDER BY created_at, rowid",
    );
  const monitor = (id: string) =>
    db.query<{ confirmed_outcome: string | null; consecutive_fails: number; consecutive_changes: number }>(
      "SELECT confirmed_outcome, consecutive_fails, consecutive_changes FROM monitors WHERE id = ?",
      id,
    )[0];
  return { db, env, sent, queue, addMonitor, run, state, incidents, monitor, now: () => clock };
}

function failD1Once(db: TestDb, matching: RegExp) {
  const prepare = db.DB.prepare.bind(db.DB);
  let armed = true;
  (db.DB as { prepare: unknown }).prepare = (sql: string) => {
    if (armed && matching.test(sql)) {
      armed = false;
      throw new Error("D1_ERROR: transient");
    }
    return prepare(sql);
  };
}

describe.skipIf(!hasSqlite)("settleRun", () => {
  it("opens one incident and alerts once on a confirmed failure, then resolves on confirmed recovery", async () => {
    const t = await instance();
    t.addMonitor("api");
    expect(await t.run("api", "pass")).toEqual({ applied: true, settled: true, delivered: true });
    expect(await t.run("api", "fail")).toMatchObject({ settled: false });
    expect(t.state()!.status).toBe("operational");
    expect(t.sent).toHaveLength(0);
    expect(await t.run("api", "fail")).toMatchObject({ settled: true, delivered: true });
    expect(t.state()).toMatchObject({ status: "failing", pending_json: null, pending_lease: null });
    expect(t.incidents()).toMatchObject([{ auto: 1, impact: "failing", status: "investigating", resolved_at: null }]);
    expect(t.sent).toMatchObject([{ event: "fail", title: "API is down", consecutiveFails: 2, incidentId: t.incidents()[0]!.id }]);
    await t.run("api", "fail");
    expect(t.sent).toHaveLength(1);
    expect(t.incidents()).toHaveLength(1);

    expect(await t.run("api", "pass")).toMatchObject({ settled: false });
    expect(t.state()!.status).toBe("failing");
    expect(await t.run("api", "pass")).toMatchObject({ settled: true });
    expect(t.state()!.status).toBe("operational");
    expect(t.incidents()[0]).toMatchObject({ status: "resolved", resolved_at: t.now() });
    expect(t.sent[1]).toMatchObject({ event: "recover", incidentId: t.incidents()[0]!.id, durationMs: 3 * 60_000 });
    expect(t.db.query("SELECT status FROM incident_updates ORDER BY created_at").map((row) => row.status)).toEqual(["investigating", "resolved"]);
  });

  it("does not alert on a single degraded run or a single recovered run", async () => {
    const t = await instance();
    t.addMonitor("api");
    await t.run("api", "pass");
    for (const outcome of ["degraded", "pass", "degraded", "pass"] as const) await t.run("api", outcome);
    expect(t.sent).toHaveLength(0);
    await t.run("api", "degraded");
    await t.run("api", "degraded");
    expect(t.sent.map((alert) => alert.event)).toEqual(["degrade"]);
    await t.run("api", "pass");
    await t.run("api", "degraded");
    expect(t.sent).toHaveLength(1);
    await t.run("api", "pass");
    await t.run("api", "pass");
    expect(t.sent.map((alert) => alert.event)).toEqual(["degrade", "recover"]);
    expect(t.incidents()).toHaveLength(0);
  });

  it("resolves the incident after an edit reset the check to unknown mid-outage", async () => {
    const t = await instance();
    t.addMonitor("api");
    await t.run("api", "fail", 1);
    expect(t.state()!.status).toBe("failing");
    // PATCH with an execution change clears the confirmed outcome and counters.
    t.db.query("UPDATE monitors SET confirmed_outcome = NULL, consecutive_fails = 0 WHERE id = 'api'");
    await t.run("api", "fail", 3);
    expect(t.monitor("api")).toMatchObject({ confirmed_outcome: null, consecutive_fails: 1 });
    expect(t.state()!.status).toBe("failing");
    await t.run("api", "pass", 3);
    expect(t.state()!.status).toBe("operational");
    expect(t.incidents()[0]!.resolved_at).not.toBeNull();
    expect(t.sent.map((alert) => alert.event)).toEqual(["fail", "recover"]);
  });

  it("closes an incident left open by a stored unknown status, alerting only if one was open", async () => {
    const t = await instance();
    t.addMonitor("api");
    t.addMonitor("web", "web");
    t.db.query("INSERT INTO component_state (component_id, status, updated_at) VALUES ('api', 'unknown', 0)");
    t.db.query(`INSERT INTO incidents (id, component_id, component_ids_json, status, impact, title, created_at, auto)
      VALUES ('stuck', 'api', '["api"]', 'investigating', 'failing', 'API is failing', 1, 1)`);
    await t.run("api", "pass");
    await t.run("web", "pass");
    expect(t.incidents()[0]).toMatchObject({ id: "stuck", status: "resolved" });
    expect(t.sent).toMatchObject([{ event: "recover", componentId: "api", incidentId: "stuck" }]);
  });

  it("closes an incident an earlier version left open on a component stored as operational", async () => {
    const t = await instance();
    t.addMonitor("a");
    t.addMonitor("b");
    await t.run("a", "pass");
    await t.run("b", "pass");
    t.db.query(`INSERT INTO incidents (id, component_id, component_ids_json, status, impact, title, created_at, auto)
      VALUES ('stuck', 'api', '["api"]', 'investigating', 'failing', 'API is failing', 1, 1)`);
    t.db.query(`INSERT INTO incidents (id, component_id, component_ids_json, status, impact, title, created_at, auto)
      VALUES ('manual', 'api', '["api"]', 'investigating', 'degraded', 'Slow responses', 1, 0)`);
    expect(await t.run("a", "pass")).toEqual({ applied: true, settled: true, delivered: true });
    expect(t.state()).toMatchObject({ status: "operational", pending_json: null, pending_lease: null });
    expect(t.incidents().find((incident) => incident.id === "stuck")).toMatchObject({ status: "resolved", resolved_at: t.now() });
    expect(t.incidents().find((incident) => incident.id === "manual")!.resolved_at).toBeNull();
    expect(t.sent).toMatchObject([{ event: "recover", incidentId: "stuck" }]);
    await t.run("b", "pass");
    await t.run("a", "pass");
    expect(t.sent).toHaveLength(1);
    expect(t.db.query("SELECT 1 FROM incident_updates WHERE status = 'resolved'")).toHaveLength(1);
  });

  it("closes a leftover incident while the component is only degraded, but not while it is failing", async () => {
    const t = await instance();
    t.addMonitor("api");
    t.db.query("INSERT INTO component_state (component_id, status, updated_at) VALUES ('api', 'unknown', 0)");
    t.db.query(`INSERT INTO incidents (id, component_id, component_ids_json, status, impact, title, created_at, auto)
      VALUES ('stuck', 'api', '["api"]', 'investigating', 'failing', 'API is failing', 1, 1)`);
    await t.run("api", "degraded");
    await t.run("api", "degraded");
    expect(t.state()!.status).toBe("degraded");
    expect(t.incidents()[0]).toMatchObject({ id: "stuck", status: "resolved" });
    expect(t.sent).toMatchObject([{ event: "degrade", incidentId: "stuck" }]);

    t.db.query("UPDATE incidents SET status = 'investigating', resolved_at = NULL WHERE id = 'stuck'");
    await t.run("api", "degraded");
    expect(t.incidents()[0]!.resolved_at).not.toBeNull();
    expect(t.sent.map((alert) => alert.event)).toEqual(["degrade", "degrade"]);

    await t.run("api", "fail", 1);
    await t.run("api", "fail", 1);
    expect(t.incidents().filter((incident) => incident.resolved_at == null)).toHaveLength(1);
    expect(t.sent.map((alert) => alert.event)).toEqual(["degrade", "degrade", "fail"]);
  });

  it("ends the outage when a failing component is only degraded", async () => {
    const t = await instance();
    t.addMonitor("api");
    await t.run("api", "fail", 1);
    await t.run("api", "degraded", 1);
    await t.run("api", "degraded", 1);
    expect(t.state()!.status).toBe("degraded");
    expect(t.incidents()[0]!.resolved_at).not.toBeNull();
    expect(t.sent.map((alert) => alert.event)).toEqual(["fail", "degrade"]);
    await t.run("api", "fail", 1);
    expect(t.incidents().filter((incident) => incident.resolved_at == null)).toHaveLength(1);
    expect(t.incidents()).toHaveLength(2);
  });

  it("opens its own incident next to an operator's manual one", async () => {
    const t = await instance();
    t.addMonitor("api");
    t.db.query(`INSERT INTO incidents (id, component_id, component_ids_json, status, impact, title, created_at, auto)
      VALUES ('manual', 'api', '["api"]', 'investigating', 'degraded', 'Slow responses', 1, 0)`);
    await t.run("api", "fail", 1);
    const auto = t.incidents().find((incident) => incident.auto === 1)!;
    expect(auto).toMatchObject({ impact: "failing", resolved_at: null });
    expect(t.sent[0]!.incidentId).toBe(auto.id);
    await t.run("api", "pass", 1);
    await t.run("api", "pass", 1);
    expect(t.incidents().find((incident) => incident.id === "manual")!.resolved_at).toBeNull();
    expect(t.incidents().find((incident) => incident.auto === 1)!.resolved_at).not.toBeNull();
    expect(t.sent[1]).toMatchObject({ event: "recover", incidentId: auto.id });
  });

  it("delivers a failed alert on the next run without repeating the incident", async () => {
    const t = await instance();
    vi.spyOn(console, "error").mockImplementation(() => {});
    t.addMonitor("api");
    t.queue.failing = true;
    expect(await t.run("api", "fail", 1)).toMatchObject({ settled: true, delivered: false });
    expect(t.state()).toMatchObject({ status: "failing", pending_lease: null });
    expect(JSON.parse(t.state()!.pending_json!)).toMatchObject([{ event: "fail", incident: null, incidentId: t.incidents()[0]!.id }]);
    expect(await t.run("api", "fail", 1)).toMatchObject({ delivered: false });
    t.queue.failing = false;
    expect(await t.run("api", "fail", 1)).toMatchObject({ delivered: true });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ event: "fail", incidentId: t.incidents()[0]!.id });
    expect(t.incidents()).toHaveLength(1);
    expect(t.state()!.pending_json).toBeNull();
    vi.restoreAllMocks();
  });

  it("keeps the incident and duration on a recover alert that had to be retried", async () => {
    const t = await instance();
    vi.spyOn(console, "error").mockImplementation(() => {});
    t.addMonitor("api");
    await t.run("api", "fail", 1);
    await t.run("api", "pass", 1);
    t.queue.failing = true;
    expect(await t.run("api", "pass", 1)).toMatchObject({ delivered: false });
    expect(t.incidents()[0]!.resolved_at).not.toBeNull();
    t.queue.failing = false;
    expect(await deliverPending(t.env, "api", t.now() + 1000)).toBe(true);
    expect(t.sent.map((alert) => alert.event)).toEqual(["fail", "recover"]);
    expect(t.sent[1]).toMatchObject({ incidentId: t.incidents()[0]!.id, durationMs: 2 * 60_000 });
    expect(t.db.query("SELECT 1 FROM incident_updates WHERE status = 'resolved'")).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("retries the incident when the database fails after the status was stored", async () => {
    const t = await instance();
    vi.spyOn(console, "error").mockImplementation(() => {});
    t.addMonitor("api");
    failD1Once(t.db, /INSERT INTO incidents/);
    expect(await t.run("api", "fail", 1)).toMatchObject({ delivered: false });
    expect(t.state()!.status).toBe("failing");
    expect(t.incidents()).toHaveLength(0);
    expect(await t.run("api", "fail", 1)).toMatchObject({ delivered: true });
    expect(t.incidents()).toHaveLength(1);
    expect(t.sent).toMatchObject([{ event: "fail", incidentId: t.incidents()[0]!.id }]);
    vi.restoreAllMocks();
  });

  it("sends queued alerts in order once delivery works again", async () => {
    const t = await instance();
    vi.spyOn(console, "error").mockImplementation(() => {});
    t.addMonitor("api");
    t.queue.failing = true;
    await t.run("api", "fail", 1);
    await t.run("api", "pass", 1);
    await t.run("api", "pass", 1);
    expect(JSON.parse(t.state()!.pending_json!)).toHaveLength(2);
    t.queue.failing = false;
    expect(await deliverPending(t.env, "api", t.now())).toBe(true);
    expect(t.sent.map((alert) => alert.event)).toEqual(["fail", "recover"]);
    expect(t.incidents()).toMatchObject([{ status: "resolved" }]);
    vi.restoreAllMocks();
  });

  it("resolves the incident on recovery while an earlier alert still cannot be sent", async () => {
    const t = await instance();
    vi.spyOn(console, "error").mockImplementation(() => {});
    t.addMonitor("api");
    t.queue.failing = true;
    await t.run("api", "fail", 1);
    const openedAt = t.now();
    await t.run("api", "pass", 1);
    expect(await t.run("api", "pass", 1)).toMatchObject({ settled: true, delivered: false });
    const recoveredAt = t.now();
    expect(t.state()!.status).toBe("operational");
    expect(t.incidents()).toMatchObject([{ status: "resolved", created_at: openedAt, resolved_at: recoveredAt }]);
    expect(JSON.parse(t.state()!.pending_json!)).toMatchObject([
      { event: "fail", incident: null },
      { event: "recover", incident: null, incidentId: t.incidents()[0]!.id, durationMs: 2 * 60_000 },
    ]);
    // A later failure opens a new incident behind the two unsent alerts.
    await t.run("api", "fail", 1);
    expect(t.incidents().map((incident) => incident.resolved_at)).toEqual([recoveredAt, null]);
    t.queue.failing = false;
    expect(await deliverPending(t.env, "api", t.now() + 10 * 60_000)).toBe(true);
    expect(t.sent.map((alert) => alert.event)).toEqual(["fail", "recover", "fail"]);
    expect(t.sent[1]).toMatchObject({ incidentId: t.incidents()[0]!.id, durationMs: 2 * 60_000 });
    expect(t.sent[2]!.incidentId).toBe(t.incidents()[1]!.id);
    expect(t.incidents()[0]!.resolved_at).toBe(recoveredAt);
    expect(t.db.query("SELECT 1 FROM incident_updates WHERE status = 'resolved'")).toHaveLength(1);
    expect(t.state()!.pending_json).toBeNull();
    vi.restoreAllMocks();
  });

  it("stamps a late resolution with the time of the recovery", async () => {
    const t = await instance();
    vi.spyOn(console, "error").mockImplementation(() => {});
    t.addMonitor("api");
    await t.run("api", "fail", 1);
    await t.run("api", "pass", 1);
    failD1Once(t.db, /UPDATE incidents SET status = 'resolved'/);
    expect(await t.run("api", "pass", 1)).toMatchObject({ delivered: false });
    const recoveredAt = t.now();
    expect(t.incidents()[0]!.resolved_at).toBeNull();
    expect(await deliverPending(t.env, "api", recoveredAt + 30 * 60_000)).toBe(true);
    expect(t.incidents()[0]).toMatchObject({ status: "resolved", resolved_at: recoveredAt });
    expect(t.sent[1]).toMatchObject({ event: "recover", durationMs: 2 * 60_000 });
    vi.restoreAllMocks();
  });

  it("lets only one check of a component announce a shared change", async () => {
    const t = await instance();
    t.addMonitor("a");
    t.addMonitor("b");
    await Promise.all([t.run("a", "fail", 1), t.run("b", "fail", 1)]);
    expect(t.sent.map((alert) => alert.event)).toEqual(["fail"]);
    expect(t.incidents()).toHaveLength(1);
    // A delivery already in progress elsewhere is left to its owner.
    t.db.query("UPDATE component_state SET pending_json = '[{\"event\":\"fail\"}]', pending_lease = ? WHERE component_id = 'api'", t.now() + 30_000);
    expect(await deliverPending(t.env, "api", t.now())).toBe(true);
    expect(t.sent).toHaveLength(1);
  });

  it("stays failing until every check of the component has recovered", async () => {
    const t = await instance();
    t.addMonitor("a");
    t.addMonitor("b");
    await t.run("a", "fail", 1);
    await t.run("b", "fail", 1);
    await t.run("a", "pass", 1);
    await t.run("a", "pass", 1);
    expect(t.state()!.status).toBe("failing");
    await t.run("b", "pass", 1);
    await t.run("b", "pass", 1);
    expect(t.state()!.status).toBe("operational");
    expect(t.sent.map((alert) => alert.event)).toEqual(["fail", "recover"]);
  });

  it("recovers next to a heartbeat that is still waiting for its first ping", async () => {
    const t = await instance();
    t.addMonitor("api");
    t.addMonitor("hb");
    await t.run("hb", null);
    await t.run("api", "fail", 1);
    expect(t.state()!.status).toBe("failing");
    await t.run("api", "pass", 1);
    await t.run("hb", null);
    expect(await t.run("api", "pass", 1)).toMatchObject({ settled: true, delivered: true });
    expect(t.monitor("hb")!.confirmed_outcome).toBeNull();
    expect(t.state()!.status).toBe("operational");
    expect(t.incidents()).toMatchObject([{ status: "resolved", resolved_at: t.now() }]);
    expect(t.sent.map((alert) => alert.event)).toEqual(["fail", "recover"]);
  });

  it("stays failing while another check without a verdict has a failing run under way", async () => {
    const t = await instance();
    t.addMonitor("a");
    t.addMonitor("b");
    await t.run("a", "fail", 1);
    await t.run("b", "fail", 3);
    expect(t.monitor("b")).toMatchObject({ confirmed_outcome: null, consecutive_fails: 1 });
    await t.run("a", "pass", 1);
    await t.run("a", "pass", 1);
    expect(t.state()!.status).toBe("failing");
    expect(t.incidents()[0]!.resolved_at).toBeNull();
    await t.run("b", "pass", 3);
    expect(t.state()!.status).toBe("operational");
    expect(t.incidents()[0]!.resolved_at).not.toBeNull();
    expect(t.sent.map((alert) => alert.event)).toEqual(["fail", "recover"]);
  });

  it("drops a run whose check was edited or deleted while it was probing", async () => {
    const t = await instance();
    t.addMonitor("api");
    expect(await t.run("api", "fail", 1, "{\"stale\":true}")).toEqual({ applied: false, settled: true, delivered: true });
    expect(await t.run("gone", "fail", 1)).toMatchObject({ applied: false });
    expect(t.db.query("SELECT 1 FROM check_latest")).toHaveLength(0);
    expect(t.db.query("SELECT 1 FROM check_runs")).toHaveLength(0);
    expect(t.state()).toBeUndefined();
    expect(t.monitor("api")).toMatchObject({ confirmed_outcome: null, consecutive_fails: 0 });
  });

  it("records a run without a verdict and leaves state alone", async () => {
    const t = await instance();
    t.addMonitor("api");
    await t.run("api", "pass");
    expect(await t.run("api", null)).toEqual({ applied: true, settled: true, delivered: true });
    expect(t.monitor("api")).toMatchObject({ confirmed_outcome: "pass" });
    expect(t.db.query("SELECT 1 FROM check_latest")).toHaveLength(1);
    expect(t.db.query("SELECT 1 FROM check_runs")).toHaveLength(2);
  });

  it("works without an alert queue", async () => {
    const t = await instance();
    delete (t.env as { ALERTS?: unknown }).ALERTS;
    t.addMonitor("api");
    expect(await t.run("api", "fail", 1)).toMatchObject({ delivered: true });
    expect(t.incidents()).toHaveLength(1);
    expect(t.state()!.pending_json).toBeNull();
  });
});

describe.skipIf(!hasSqlite)("pruneRunHistory", () => {
  it("removes only runs past retention", async () => {
    const t = await instance();
    const now = 100 * DAY;
    const insert = (id: string, at: number) =>
      t.db.query("INSERT INTO check_runs (id, monitor_id, region, outcome, checked_at) VALUES (?, 'api', 'wnam', 'pass', ?)", id, at);
    insert("old", now - RUN_HISTORY_MS - 1);
    insert("edge", now - RUN_HISTORY_MS);
    insert("new", now - 1000);
    expect(await pruneRunHistory(t.env, now)).toBe(true);
    expect(t.db.query<{ id: string }>("SELECT id FROM check_runs ORDER BY id").map((row) => row.id)).toEqual(["edge", "new"]);
  });
});
