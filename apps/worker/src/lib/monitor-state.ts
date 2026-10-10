import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { ComponentStatus, RunOutcome } from "@foxwatch/config";
import { advanceMonitor, componentTransition, type ComponentEffect } from "@foxwatch/engine";
import type { Env } from "../env.ts";
import * as schema from "../db/schema.ts";
import { bumpUptime } from "./snapshot.ts";
import { newId } from "./crypto.ts";
import type { AlertBody, AlertRegion } from "./alerts.ts";

/** How soon a check runs again while its latest result is unconfirmed or its side effects are owed. */
export const RECHECK_MS = 60_000;
/** Run history is diagnostic only; the admin UI shows the last few rows. */
export const RUN_HISTORY_MS = 7 * 86_400_000;
const PRUNE_BATCH = 5000;
const PRUNE_BATCHES_PER_TICK = 4;
const EFFECT_LEASE_MS = 60_000;
const ALERT_MAX_AGE_MS = 86_400_000;

export type RegionResult = {
  region: string;
  outcome: string;
  latencyMs: number;
  statusCode: number | null;
  colo: string | null;
  errorClass?: string;
  errorSnippet?: string;
};

export type RunInput = {
  monitorId: string;
  /** The stored config the results came from. A run of an edited or deleted check is dropped. */
  configJson: string;
  checkType: "http" | "heartbeat";
  results: RegionResult[];
  /** Null records the results without a verdict, leaving monitor state alone. */
  outcome: RunOutcome | null;
  confirmFails: number;
  /** False keeps the results out of run history. */
  history?: boolean;
};

export type RunSettlement = {
  /** False when the run was dropped because the check changed or is gone. */
  applied: boolean;
  /** False while the latest run disagrees with the confirmed outcome. */
  settled: boolean;
  /** False when incident or alert side effects are still owed. */
  delivered: boolean;
};

/** One incident or alert side effect owed for a component status change. */
type PendingEffect = ComponentEffect & {
  eventId: string;
  at: number;
  componentName: string;
  checkType: "http" | "heartbeat";
  consecutiveFails: number;
  regions: AlertRegion[];
  incidentId?: string;
  durationMs?: number;
};

async function changes(statement: D1PreparedStatement): Promise<number> {
  return (await statement.run()).meta.changes ?? 0;
}

/**
 * Applies one finished run: stores the regional results, advances the
 * monitor's confirmation state, and moves the component to its new status.
 * The status change and the side effects it owes are written in one
 * statement, so an incident or alert is neither lost when a later step fails
 * nor repeated when two checks of one component change in the same instant.
 */
export async function settleRun(env: Env, run: RunInput, now = Date.now()): Promise<RunSettlement> {
  const db = drizzle(env.DB, { schema });
  const dropped: RunSettlement = { applied: false, settled: true, delivered: true };
  const row = (await db.select().from(schema.monitors).where(eq(schema.monitors.id, run.monitorId)))[0];
  if (!row || row.configJson !== run.configJson) return dropped;
  await recordResults(env, run.monitorId, run.results, now, run.history !== false);
  if (run.outcome == null) return { applied: true, settled: true, delivered: true };

  // The row was read after the probes finished, so the counters are current.
  const next = advanceMonitor(row, run.outcome, run.confirmFails);
  const updated = await changes(
    env.DB.prepare(`UPDATE monitors SET consecutive_fails = ?, confirmed_outcome = ?, consecutive_changes = ?, updated_at = ?
      WHERE id = ? AND config_json = ?`)
      .bind(next.consecutiveFails, next.confirmedOutcome, next.consecutiveChanges, now, row.id, run.configJson),
  );
  if (updated === 0) return dropped;

  const componentId = row.componentId;
  const monitors = await db.select().from(schema.monitors).where(eq(schema.monitors.componentId, componentId));
  const active = monitors.filter((m) => !m.mutedUntil || m.mutedUntil <= now);
  // A check with no verdict and no failing or degraded run under way (a
  // heartbeat still waiting for its first ping, a check that has not run yet)
  // says nothing about the component, so it does not hold back the others.
  const statuses = active
    .map((m) => m.id === row.id ? next : m)
    .filter((m) => m.confirmedOutcome != null || m.consecutiveFails > 0 || m.consecutiveChanges > 0)
    .map((m) => m.confirmedOutcome);
  const status: ComponentStatus = statuses.some((s) => s === "fail")
    ? "failing"
    : statuses.some((s) => s === "degraded")
      ? "degraded"
      : statuses.length > 0 && statuses.every((s) => s === "pass")
        ? "operational"
        : "unknown";
  const prev = (await db.select().from(schema.componentState).where(eq(schema.componentState.componentId, componentId)))[0];
  await bumpUptime(env, componentId, status === "operational" || status === "degraded", run.results.map((result) => result.latencyMs), now);

  let owed = prev?.pendingJson != null;
  const queued = (effect: ComponentEffect): PendingEffect => ({
    ...effect,
    eventId: newId(),
    at: now,
    componentName: row.componentName,
    checkType: run.checkType,
    consecutiveFails: next.consecutiveFails,
    regions: run.results.map((result) => ({
      region: result.region,
      outcome: result.outcome,
      latencyMs: result.latencyMs,
      statusCode: result.statusCode,
      colo: result.colo,
      errorClass: result.errorClass ?? null,
      errorSnippet: result.errorSnippet ?? null,
    })),
  });
  // "unknown" is a check without a verdict yet. It is never stored, so the
  // status a failing component had is still there when its checks pass again.
  if (status !== "unknown" && status !== prev?.status) {
    const effect = componentTransition(prev?.status ?? null, status);
    const pending = effect && queued(effect);
    const json = pending ? JSON.stringify(pending) : null;
    // Only the run that moves the stored status owes the side effects.
    const won = prev
      ? await changes(
          env.DB.prepare(`UPDATE component_state SET status = ?1, updated_at = ?2,
              pending_json = CASE WHEN ?3 IS NULL THEN pending_json ELSE json_insert(COALESCE(pending_json, '[]'), '$[#]', json(?3)) END
            WHERE component_id = ?4 AND status = ?5`)
            .bind(status, now, json, componentId, prev.status),
        )
      : await changes(
          env.DB.prepare(`INSERT INTO component_state (component_id, status, updated_at, pending_json)
            VALUES (?1, ?2, ?3, CASE WHEN ?4 IS NULL THEN NULL ELSE json_array(json(?4)) END)
            ON CONFLICT(component_id) DO NOTHING`)
            .bind(componentId, status, now, json),
        );
    if (won > 0 && pending) owed = true;
  } else if (status === "operational" || status === "degraded") {
    // The status did not move, so nothing above closes an auto incident that
    // an earlier version, or a dropped effect, left open on a component that
    // is no longer failing. The incident table decides, not the stored status.
    const leftover = queued({ event: status === "operational" ? "recover" : "degrade", incident: "resolve", onlyIfResolved: true });
    const healing = await changes(
      env.DB.prepare(`UPDATE component_state SET pending_json = json_array(json(?1))
        WHERE component_id = ?2 AND status = ?3 AND pending_json IS NULL
          AND EXISTS (SELECT 1 FROM incidents WHERE component_id = ?2 AND auto = 1 AND resolved_at IS NULL)`)
        .bind(JSON.stringify(leftover), componentId, status),
    );
    if (healing > 0) owed = true;
  }
  const delivered = owed ? await deliverPending(env, componentId, now) : true;
  return { applied: true, settled: next.settled, delivered };
}

async function recordResults(
  env: Env,
  monitorId: string,
  results: RegionResult[],
  now: number,
  history: boolean,
): Promise<void> {
  if (results.length === 0) return;
  const statements: D1PreparedStatement[] = [];
  for (const result of results) {
    const values = [
      monitorId,
      result.region,
      result.outcome,
      result.latencyMs,
      result.statusCode,
      result.colo,
      result.errorClass ?? null,
      result.errorSnippet ?? null,
      now,
    ];
    statements.push(
      env.DB.prepare(`INSERT INTO check_latest
        (monitor_id, region, outcome, latency_ms, status_code, colo, error_class, error_snippet, checked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(monitor_id, region) DO UPDATE SET
          outcome = excluded.outcome,
          latency_ms = excluded.latency_ms,
          status_code = excluded.status_code,
          colo = excluded.colo,
          error_class = excluded.error_class,
          error_snippet = excluded.error_snippet,
          checked_at = excluded.checked_at`).bind(...values),
    );
    if (history) {
      statements.push(
        env.DB.prepare(`INSERT INTO check_runs
          (id, monitor_id, region, outcome, latency_ms, status_code, colo, error_class, error_snippet, checked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(newId(), ...values),
      );
    }
  }
  await env.DB.batch(statements);
}

/**
 * Delivers the side effects owed for a component: incident steps first, then
 * alerts oldest first. Returns false when a step failed and the caller should
 * try again soon. A lease keeps the checks of one component from delivering
 * the same effect twice.
 */
export async function deliverPending(env: Env, componentId: string, now = Date.now()): Promise<boolean> {
  const lease = now + EFFECT_LEASE_MS;
  try {
    const leased = await changes(
      env.DB.prepare(`UPDATE component_state SET pending_lease = ?1
        WHERE component_id = ?2 AND pending_json IS NOT NULL AND (pending_lease IS NULL OR pending_lease < ?3)`)
        .bind(lease, componentId, now),
    );
    // Nothing is owed, or another run is delivering it and retries on its own.
    if (leased === 0) return true;
  } catch (error) {
    console.error(`could not claim side effects for ${componentId}`, error);
    return false;
  }
  try {
    for (;;) {
      const stored = await env.DB.prepare("SELECT pending_json FROM component_state WHERE component_id = ?")
        .bind(componentId)
        .first<{ pending_json: string | null }>();
      let queue: PendingEffect[] = [];
      try {
        const parsed = JSON.parse(stored?.pending_json ?? "[]") as unknown;
        if (Array.isArray(parsed)) queue = parsed as PendingEffect[];
      } catch {
        /* an unreadable queue is dropped below rather than retried forever */
      }
      if (!queue[0]) {
        if (stored?.pending_json != null) {
          await env.DB.prepare("UPDATE component_state SET pending_json = NULL WHERE component_id = ?").bind(componentId).run();
        }
        return true;
      }
      // Incident steps of every queued effect come first, so an alert that
      // cannot be sent never keeps a later incident from opening or resolving.
      for (const [index, entry] of queue.entries()) {
        if (!entry.incident) continue;
        const incident = entry.incident === "open"
          ? { incidentId: await openIncident(env, componentId, entry.componentName, entry.at) }
          : await resolveIncidents(env, componentId, entry.event === "recover", entry.at);
        queue[index] = { ...entry, ...incident, incident: null };
        // Keep the incident step with the effect so a retried alert neither repeats nor forgets it.
        // Runs only append while the lease is held, so the index still points at this effect.
        await env.DB.prepare(`UPDATE component_state SET pending_json = json_replace(pending_json, '$[${index}]', json(?)) WHERE component_id = ?`)
          .bind(JSON.stringify(queue[index]), componentId)
          .run();
      }
      const effect = queue[0];
      if (!(effect.onlyIfResolved && !effect.incidentId)) await sendAlert(env, componentId, effect, now);
      await env.DB.prepare(`UPDATE component_state
        SET pending_json = CASE WHEN json_array_length(pending_json) > 1 THEN json_remove(pending_json, '$[0]') ELSE NULL END
        WHERE component_id = ?`)
        .bind(componentId)
        .run();
    }
  } catch (error) {
    console.error(`side effects for ${componentId} failed and will be retried`, error);
    return false;
  } finally {
    try {
      await env.DB.prepare("UPDATE component_state SET pending_lease = NULL WHERE component_id = ? AND pending_lease = ?")
        .bind(componentId, lease)
        .run();
    } catch {
      /* the lease expires on its own */
    }
  }
}

async function openAutoIncident(env: Env, componentId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT id FROM incidents WHERE component_id = ? AND auto = 1 AND resolved_at IS NULL LIMIT 1")
    .bind(componentId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

// Operator-written incidents are left alone: an outage confirmed by checks
// always gets its own auto incident, which is what downtime is measured from.
async function openIncident(env: Env, componentId: string, componentName: string, at: number): Promise<string> {
  const existing = await openAutoIncident(env, componentId);
  if (existing) return existing;
  const id = newId();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO incidents (id, component_id, component_ids_json, status, impact, title, created_at, resolved_at, auto)
        VALUES (?, ?, ?, 'investigating', 'failing', ?, ?, NULL, 1)`)
        .bind(id, componentId, JSON.stringify([componentId]), `${componentName} is failing`, at),
      env.DB.prepare("INSERT INTO incident_updates (id, incident_id, status, body, created_at) VALUES (?, ?, 'investigating', ?, ?)")
        .bind(newId(), id, "Automatically opened after confirmed check failures.", at),
    ]);
  } catch (error) {
    // Another writer may have opened it in the same instant. The partial
    // unique index makes that transition idempotent.
    const winner = await openAutoIncident(env, componentId);
    if (winner) return winner;
    throw error;
  }
  return id;
}

// `at` is when the status changed, not when this is delivered, so a late
// delivery does not count as downtime.
async function resolveIncidents(
  env: Env,
  componentId: string,
  recovered: boolean,
  at: number,
): Promise<{ incidentId?: string; durationMs?: number }> {
  const rows = (await env.DB.prepare("SELECT id, created_at FROM incidents WHERE component_id = ? AND auto = 1 AND resolved_at IS NULL")
    .bind(componentId)
    .all<{ id: string; created_at: number }>()).results;
  let resolved: { incidentId?: string; durationMs?: number } = {};
  for (const row of rows) {
    await env.DB.batch([
      env.DB.prepare("UPDATE incidents SET status = 'resolved', resolved_at = ? WHERE id = ? AND resolved_at IS NULL").bind(at, row.id),
      env.DB.prepare("INSERT INTO incident_updates (id, incident_id, status, body, created_at) VALUES (?, ?, 'resolved', ?, ?)")
        .bind(
          newId(),
          row.id,
          recovered
            ? "Automatically resolved when checks recovered."
            : "Automatically resolved: checks are no longer failing, but the component is still degraded.",
          at,
        ),
    ]);
    if (!resolved.incidentId) {
      resolved = { incidentId: row.id, durationMs: Math.max(0, at - row.created_at) };
    }
  }
  return resolved;
}

async function sendAlert(env: Env, componentId: string, effect: PendingEffect, now: number): Promise<void> {
  // No queue is bound in some local setups; there is nowhere to deliver to.
  if (typeof env.ALERTS?.send !== "function") return;
  if (now - effect.at > ALERT_MAX_AGE_MS) {
    console.error(`dropping ${effect.event} alert for ${componentId}: undeliverable for a day`);
    return;
  }
  const title = effect.event === "fail"
    ? `${effect.componentName} is down`
    : effect.event === "degrade"
      ? `${effect.componentName} is degraded`
      : `${effect.componentName} recovered`;
  const body: AlertBody = {
    eventId: effect.eventId,
    event: effect.event,
    componentId,
    title,
    occurredAt: effect.at,
    source: "monitor",
    componentName: effect.componentName,
    componentIds: [componentId],
    checkType: effect.checkType,
    consecutiveFails: effect.consecutiveFails,
    regions: effect.regions,
    incidentId: effect.incidentId,
    durationMs: effect.durationMs,
  };
  await env.ALERTS.send(body);
}

/**
 * Deletes run history past its retention in bounded batches. Returns true
 * once nothing old is left, so a large backlog is worked off over several ticks.
 */
export async function pruneRunHistory(env: Env, now: number): Promise<boolean> {
  for (let i = 0; i < PRUNE_BATCHES_PER_TICK; i++) {
    const removed = await changes(
      env.DB.prepare("DELETE FROM check_runs WHERE id IN (SELECT id FROM check_runs WHERE checked_at < ? LIMIT ?)")
        .bind(now - RUN_HISTORY_MS, PRUNE_BATCH),
    );
    if (removed < PRUNE_BATCH) return true;
  }
  return false;
}
