import { DurableObject } from "cloudflare:workers";
import type { Check } from "@foxwatch/config";
import type { Env } from "../env.ts";
import { publishSnapshot } from "../lib/snapshot.ts";
import { pruneAuthTables } from "../auth/accounts.ts";
import { pruneRunHistory, RECHECK_MS } from "../lib/monitor-state.ts";
import { monitorStub } from "./monitor.ts";

const PUBLISH_DEBOUNCE_MS = 3000;
const BOOTSTRAP_MIN_GAP_MS = 30_000;

/** A check is overdue when it has no result newer than its interval plus slack. */
export function overdueMonitors(
  rows: Array<{ id: string; config_json: string; last_checked: number | null }>,
  now: number,
): Array<{ id: string; intervalMs: number }> {
  const overdue: Array<{ id: string; intervalMs: number }> = [];
  for (const row of rows) {
    let intervalMs = 60_000;
    try {
      const check = JSON.parse(row.config_json) as Check;
      intervalMs = "intervalMs" in check ? check.intervalMs : 60_000;
    } catch (error) {
      console.error(`invalid monitor config for ${row.id}`, error);
    }
    if (row.last_checked == null || now - row.last_checked > intervalMs + RECHECK_MS) {
      overdue.push({ id: row.id, intervalMs });
    }
  }
  return overdue;
}

/** How soon an overdue check runs: within a minute, spread so a batch does not fire at once. */
export function overdueDelayMs(intervalMs: number, random = Math.random()): number {
  return Math.max(1, Math.round(Math.min(intervalMs, RECHECK_MS) * random));
}

export class Scheduler extends DurableObject<Env> {
  private ticking: Promise<void> | null = null;
  private lastTickAt = 0;

  // Concurrent callers share one tick.
  tick(): Promise<void> {
    this.ticking ??= this.runTick().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  /** The unauthenticated first-request path: at most one tick per gap. */
  async bootstrap(): Promise<void> {
    if (Date.now() - this.lastTickAt < BOOTSTRAP_MIN_GAP_MS) return;
    await this.tick();
  }

  /** Coalesces the publishes of checks that finish close together into one rebuild. */
  async requestPublish(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current == null) await this.ctx.storage.setAlarm(Date.now() + PUBLISH_DEBOUNCE_MS);
  }

  async alarm(): Promise<void> {
    try {
      await publishSnapshot(this.env, { retry: false });
    } catch (error) {
      console.error("snapshot publish failed", error);
    }
  }

  private async runTick(): Promise<void> {
    this.lastTickAt = Date.now();
    // Each check keeps its own alarm. This is only the watchdog for an alarm
    // that was lost, so checks that reported on time are not woken.
    const rows = (await this.env.DB.prepare(`SELECT m.id, m.config_json, MAX(l.checked_at) AS last_checked
      FROM monitors m LEFT JOIN check_latest l ON l.monitor_id = m.id GROUP BY m.id`)
      .all<{ id: string; config_json: string; last_checked: number | null }>()).results;
    const now = Date.now();
    await Promise.all(overdueMonitors(rows, now).map(async ({ id, intervalMs }) => {
      try {
        // Already late by definition, so do not wait another whole interval.
        await monitorStub(this.env, id).ensureAlarm(overdueDelayMs(intervalMs));
      } catch (error) {
        console.error(`could not arm monitor ${id}`, error);
      }
    }));
    const lastPruned = await this.ctx.storage.get<number>("lastAuthPrune");
    if (!lastPruned || now - lastPruned > 3_600_000) {
      // Housekeeping must never hold up scheduling or the public snapshot.
      try {
        await pruneAuthTables(this.env, now);
        await this.ctx.storage.put("lastAuthPrune", now);
      } catch (error) {
        console.error("auth table prune failed", error);
      }
    }
    const lastHistoryPrune = await this.ctx.storage.get<number>("lastHistoryPrune");
    if (!lastHistoryPrune || now - lastHistoryPrune > 86_400_000) {
      try {
        // A backlog is worked off over the next ticks before the daily wait starts.
        if (await pruneRunHistory(this.env, now)) await this.ctx.storage.put("lastHistoryPrune", now);
      } catch (error) {
        console.error("run history prune failed", error);
      }
    }
    await publishSnapshot(this.env);
  }
}

export function schedulerStub(env: Env) {
  return env.SCHEDULER.get(env.SCHEDULER.idFromName("main")) as DurableObjectStub<Scheduler>;
}
