import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { Check, HeartbeatCheck, HttpCheck, Region } from "@foxwatch/config";
import { secretName } from "@foxwatch/config";
import { componentStatus, hasQuorum, heartbeatOutcome, heartbeatRecheckMs } from "@foxwatch/engine";
import type { Env } from "../env.ts";
import * as schema from "../db/schema.ts";
import { probeStub } from "./probe.ts";
import type { Scheduler } from "./scheduler.ts";
import { publishSnapshot } from "../lib/snapshot.ts";
import { loadSecretMap } from "../lib/secret-store.ts";
import { deliverPending, RECHECK_MS, settleRun, type RegionResult, type RunInput } from "../lib/monitor-state.ts";

type MonitorRow = typeof schema.monitors.$inferSelect;

/** What a finished run hands to settleRun, and when to run again if sooner than the interval. */
type RunPlan = { run: Omit<RunInput, "monitorId" | "configJson">; recheckMs: number | null };

function asCheck(json: string): Check {
  return JSON.parse(json) as Check;
}

export class Monitor extends DurableObject<Env> {
  private running: Promise<number | null> | null = null;
  private effectsOwed = false;

  async ensureAlarm(intervalMs: number): Promise<void> {
    await this.rememberName();
    const current = await this.ctx.storage.getAlarm();
    if (current == null) await this.ctx.storage.setAlarm(Date.now() + intervalMs);
  }

  async reschedule(intervalMs: number): Promise<void> {
    await this.rememberName();
    await this.ctx.storage.setAlarm(Date.now() + intervalMs);
  }

  async runNow(): Promise<void> {
    const recheckMs = await this.runOnce();
    if (recheckMs != null) await this.scheduleWithin(recheckMs);
  }

  /** Called when the check is deleted, so nothing is left to wake up for. */
  async destroy(regions: Region[] = []): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    const id = this.ctx.id.name?.replace(/^monitor:/, "");
    if (!id) return;
    await Promise.allSettled(regions.map(async (region) => probeStub(this.env, region, id).destroy()));
  }

  async alarm(): Promise<void> {
    // Install a recovery alarm before any I/O or parsing of persisted config.
    // The runtime gives up on an alarm that keeps throwing, so neither a D1
    // outage nor a malformed row may leave this Durable Object without one.
    await this.ctx.storage.setAlarm(Date.now() + RECHECK_MS);
    try {
      const id = await this.monitorId();
      const db = drizzle(this.env.DB, { schema });
      const row = (await db.select().from(schema.monitors).where(eq(schema.monitors.id, id)))[0];
      if (!row) {
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        return;
      }
      const check = asCheck(row.configJson);
      const interval = "intervalMs" in check ? check.intervalMs : 60_000;
      // Schedule before I/O so probe duration does not accumulate as drift.
      await this.ctx.storage.setAlarm(Date.now() + interval);
      const recheckMs = await this.runOnce();
      if (recheckMs != null) await this.scheduleWithin(recheckMs);
    } catch (err) {
      console.error("monitor alarm failed", err);
      // A failed run must not cost a long-interval check a whole interval.
      try {
        await this.scheduleWithin(RECHECK_MS);
      } catch {
        /* the alarm set above still stands */
      }
    }
  }

  private async rememberName(): Promise<void> {
    const name = this.ctx.id.name?.replace(/^monitor:/, "");
    if (name && (await this.ctx.storage.get<string>("monitorId")) !== name) {
      await this.ctx.storage.put("monitorId", name);
    }
  }

  private async monitorId(): Promise<string> {
    const named = this.ctx.id.name?.replace(/^monitor:/, "");
    if (named) return named;
    const stored = await this.ctx.storage.get<string>("monitorId");
    return stored ?? "";
  }

  /** Brings the next alarm forward; never pushes an earlier one back. */
  private async scheduleWithin(ms: number): Promise<void> {
    const when = Date.now() + ms;
    const current = await this.ctx.storage.getAlarm();
    if (current == null || current > when) await this.ctx.storage.setAlarm(when);
  }

  // A manual run that arrives while the alarm run is still probing joins it,
  // so two runs never advance the confirmation counters from the same state.
  private runOnce(): Promise<number | null> {
    this.running ??= this.execute().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Runs the check once. Returns how soon to run again when that is sooner than the interval. */
  private async execute(): Promise<number | null> {
    const id = await this.monitorId();
    if (!id) return null;
    const db = drizzle(this.env.DB, { schema });
    const rows = await db.select().from(schema.monitors).where(eq(schema.monitors.id, id));
    const row = rows[0];
    if (!row) return null;
    // Side effects a previous run could not deliver are owed even while muted.
    if (this.effectsOwed) this.effectsOwed = !(await deliverPending(this.env, row.componentId));
    const idle = () => (this.effectsOwed ? RECHECK_MS : null);
    if (row.mutedUntil && row.mutedUntil > Date.now()) return idle();
    const maintenance = await db
      .select({ startAt: schema.maintenance.startAt, endAt: schema.maintenance.endAt })
      .from(schema.maintenance)
      .where(eq(schema.maintenance.componentId, row.componentId));
    const now = Date.now();
    if (maintenance.some((w) => w.startAt <= now && now < w.endAt)) return idle();
    const check = asCheck(row.configJson);
    const plan = check.type === "heartbeat" ? await this.runHeartbeat(row, check) : await this.runHttp(row, check);
    const settlement = await settleRun(this.env, { ...plan.run, monitorId: row.id, configJson: row.configJson });
    // The check was edited or deleted while it ran. Run the new config shortly;
    // a deleted check clears itself on that alarm.
    if (!settlement.applied) return 1000;
    if (plan.run.outcome != null) this.effectsOwed = !settlement.delivered;
    await this.requestPublish();
    if (!settlement.settled || this.effectsOwed) {
      return Math.min(RECHECK_MS, plan.recheckMs ?? RECHECK_MS);
    }
    return plan.recheckMs;
  }

  private async runHeartbeat(row: MonitorRow, check: HeartbeatCheck): Promise<RunPlan> {
    const db = drizzle(this.env.DB, { schema });
    const hb = (await db.select().from(schema.heartbeats).where(eq(schema.heartbeats.monitorId, row.id)))[0];
    const lastPingAt = hb?.lastPingAt ?? null;
    const result = (outcome: string): RegionResult => ({
      region: "global",
      outcome,
      latencyMs: 0,
      statusCode: null,
      colo: null,
      errorClass: outcome === "fail" ? "heartbeat" : undefined,
    });
    const base = { checkType: "heartbeat" as const, confirmFails: check.confirmFails ?? 3 };
    if (lastPingAt == null && row.confirmedOutcome == null) {
      // No ping has ever arrived, so there is no schedule to have missed yet.
      // The first ping runs this check at once (see /api/heartbeat).
      return { run: { ...base, results: [result("pending")], outcome: null, history: false }, recheckMs: null };
    }
    const now = Date.now();
    const outcome = heartbeatOutcome(lastPingAt, now, check.intervalMs, check.graceMs);
    return {
      run: { ...base, results: [result(outcome)], outcome },
      recheckMs: outcome === "pass" && lastPingAt != null
        ? heartbeatRecheckMs(lastPingAt, now, check.intervalMs, check.graceMs)
        : null,
    };
  }

  private async runHttp(row: MonitorRow, check: HttpCheck): Promise<RunPlan> {
    const monitorId = row.id;
    const secretNames = [
      ...new Set(
        Object.values(check.headers)
          .map((v) => secretName(v))
          .filter((n): n is string => Boolean(n)),
      ),
    ];
    const secrets = await loadSecretMap(this.env, secretNames);
    const retries = Math.max(0, check.retries);
    const regions = check.regions as Region[];
    const probed = await Promise.all(regions.map(async (region): Promise<RegionResult | null> => {
      try {
        let result = await probeStub(this.env, region, monitorId).run(check, secrets);
        for (let i = 0; i < retries && result.outcome === "fail"; i++) {
          await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** i + Math.floor(Math.random() * 100)));
          result = await probeStub(this.env, region, monitorId).run(check, secrets);
        }
        try {
          this.env.METRICS.writeDataPoint({
            blobs: [monitorId, region, result.colo ?? "", result.outcome, result.errorClass ?? ""],
            doubles: [result.latencyMs, result.statusCode ?? 0],
            indexes: [monitorId],
          });
        } catch {
          // WAE is optional for the public page
        }
        return {
          region,
          outcome: result.outcome,
          latencyMs: result.latencyMs,
          statusCode: result.statusCode,
          colo: result.colo,
          errorClass: result.errorClass,
          errorSnippet: result.errorSnippet,
        };
      } catch (error) {
        // The probe itself broke, which says nothing about the target. Leave
        // this region out so the others can still reach a verdict.
        console.error(`probe ${region} for ${monitorId} failed`, error);
        return null;
      }
    }));
    const results = probed.filter((result): result is RegionResult => result != null);
    const base = { checkType: "http" as const, confirmFails: check.confirmFails ?? 3, results };
    if (!hasQuorum(results.length, regions.length)) {
      return { run: { ...base, outcome: null }, recheckMs: RECHECK_MS };
    }
    const rawStatus = componentStatus(
      results.map((result) => ({ region: result.region, outcome: result.outcome as "pass" | "degraded" | "fail" })),
      check.failWhen ?? "majority",
    );
    const outcome = rawStatus === "failing" ? "fail" : rawStatus === "degraded" ? "degraded" : "pass";
    return { run: { ...base, outcome }, recheckMs: null };
  }

  // Many checks finish in the same second. The scheduler rebuilds the public
  // snapshot once for all of them instead of once per run.
  private async requestPublish(): Promise<void> {
    try {
      const scheduler = this.env.SCHEDULER.get(this.env.SCHEDULER.idFromName("main")) as DurableObjectStub<Scheduler>;
      await scheduler.requestPublish();
    } catch (error) {
      console.error("could not queue a snapshot publish", error);
      try {
        await publishSnapshot(this.env);
      } catch (err) {
        console.error("snapshot publish failed", err);
      }
    }
  }
}

export function monitorStub(env: Env, monitorId: string) {
  return env.MONITOR.get(env.MONITOR.idFromName(`monitor:${monitorId}`)) as DurableObjectStub<Monitor>;
}
