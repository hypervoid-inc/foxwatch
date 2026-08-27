import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray, lt } from "drizzle-orm";
import type { Check, HeartbeatCheck, HttpCheck, Region } from "@foxwatch/config";
import { secretName } from "@foxwatch/config";
import { componentStatus, confirmFlip, heartbeatOutcome } from "@foxwatch/engine";
import type { Env } from "../env.ts";
import * as schema from "../db/schema.ts";
import { probeStub } from "./probe.ts";
import { bumpUptime, publishSnapshot } from "../lib/snapshot.ts";
import { loadSecretMap } from "../lib/secret-store.ts";
import { newId } from "../lib/crypto.ts";

function asCheck(json: string): Check {
  return JSON.parse(json) as Check;
}

export class Monitor extends DurableObject<Env> {
  async ensureAlarm(intervalMs: number): Promise<void> {
    const name = this.ctx.id.name?.replace(/^monitor:/, "");
    if (name) await this.ctx.storage.put("monitorId", name);
    const current = await this.ctx.storage.getAlarm();
    if (current == null) await this.ctx.storage.setAlarm(Date.now() + intervalMs);
  }

  async reschedule(intervalMs: number): Promise<void> {
    const name = this.ctx.id.name?.replace(/^monitor:/, "");
    if (name) await this.ctx.storage.put("monitorId", name);
    await this.ctx.storage.setAlarm(Date.now() + intervalMs);
  }

  async runNow(): Promise<void> {
    await this.execute();
  }

  async alarm(): Promise<void> {
    const id = await this.monitorId();
    const db = drizzle(this.env.DB, { schema });
    const row = (await db.select().from(schema.monitors).where(eq(schema.monitors.id, id)))[0];
    if (!row) return;
    // Install a recovery alarm before parsing untrusted persisted config. A
    // malformed row must never permanently stop this Durable Object.
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    try {
      const check = asCheck(row.configJson);
      const interval = "intervalMs" in check ? check.intervalMs : 60_000;
      // Schedule before I/O so probe duration does not accumulate as drift.
      await this.ctx.storage.setAlarm(Date.now() + interval);
      await this.execute();
    } catch (err) {
      console.error("monitor alarm failed", err);
    }
  }

  private async monitorId(): Promise<string> {
    const named = this.ctx.id.name?.replace(/^monitor:/, "");
    if (named) return named;
    const stored = await this.ctx.storage.get<string>("monitorId");
    return stored ?? "";
  }

  private async execute(): Promise<void> {
    const id = await this.monitorId();
    if (!id) return;
    const db = drizzle(this.env.DB, { schema });
    const rows = await db.select().from(schema.monitors).where(eq(schema.monitors.id, id));
    const row = rows[0];
    if (!row) return;
    if (row.mutedUntil && row.mutedUntil > Date.now()) return;
    const maintenance = await db
      .select({ startAt: schema.maintenance.startAt, endAt: schema.maintenance.endAt })
      .from(schema.maintenance)
      .where(and(eq(schema.maintenance.componentId, row.componentId)));
    const now = Date.now();
    if (maintenance.some((w) => w.startAt <= now && now < w.endAt)) return;
    const check = asCheck(row.configJson);
    if (check.type === "heartbeat") {
      await this.runHeartbeat(row.componentId, check, row.consecutiveFails, row.confirmedOutcome);
      return;
    }
    await this.runHttp(row.id, row.componentId, check, row.consecutiveFails, row.confirmedOutcome);
  }

  private async runHeartbeat(
    componentId: string,
    check: HeartbeatCheck,
    consecutiveFails: number,
    confirmedOutcome: "pass" | "degraded" | "fail" | null,
  ): Promise<void> {
    const db = drizzle(this.env.DB, { schema });
    const id = await this.monitorId();
    const hb = (await db.select().from(schema.heartbeats).where(eq(schema.heartbeats.monitorId, id)))[0];
    const outcome = heartbeatOutcome(hb?.lastPingAt ?? null, Date.now(), check.intervalMs, check.graceMs);
    await this.record(id, "global", {
      outcome,
      latencyMs: 0,
      statusCode: null,
      colo: null,
      errorClass: outcome === "fail" ? "heartbeat" : undefined,
    });
    await this.afterRuns(componentId, consecutiveFails, confirmedOutcome, outcome, check.confirmFails ?? 3, []);
  }

  private async runHttp(
    monitorId: string,
    componentId: string,
    check: HttpCheck,
    consecutiveFails: number,
    confirmedOutcome: "pass" | "degraded" | "fail" | null,
  ): Promise<void> {
    const secretNames = [
      ...new Set(
        Object.values(check.headers)
          .map((v) => secretName(v))
          .filter((n): n is string => Boolean(n)),
      ),
    ];
    const secrets = await loadSecretMap(this.env, secretNames);
    const retries = Math.max(0, check.retries);
    const regionResults = await Promise.all((check.regions as Region[]).map(async (region) => {
      let result = await probeStub(this.env, region, monitorId).run(check, secrets);
      for (let i = 0; i < retries && result.outcome === "fail"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** i + Math.floor(Math.random() * 100)));
        result = await probeStub(this.env, region, monitorId).run(check, secrets);
      }
      await this.record(monitorId, region, result);
      try {
        this.env.METRICS.writeDataPoint({
          blobs: [monitorId, region, result.colo ?? "", result.outcome, result.errorClass ?? ""],
          doubles: [result.latencyMs, result.statusCode ?? 0],
          indexes: [monitorId],
        });
      } catch {
        // WAE is optional for the public page
      }
      return result;
    }));
    const outcomes = regionResults.map((result) => ({ region: "", outcome: result.outcome }));
    const rawStatus = componentStatus(outcomes, check.failWhen ?? "majority");
    const outcome = rawStatus === "failing" ? "fail" : rawStatus === "degraded" ? "degraded" : "pass";
    const latencies = regionResults.map((result) => result.latencyMs).filter((ms) => ms > 0);
    await this.afterRuns(componentId, consecutiveFails, confirmedOutcome, outcome, check.confirmFails ?? 3, latencies);
  }

  private async record(
    monitorId: string,
    region: string,
    result: {
      outcome: string;
      latencyMs: number;
      statusCode: number | null;
      colo: string | null;
      errorClass?: string;
      errorSnippet?: string;
    },
  ): Promise<void> {
    const db = drizzle(this.env.DB, { schema });
    const now = Date.now();
    await db
      .insert(schema.checkLatest)
      .values({
        monitorId,
        region,
        outcome: result.outcome,
        latencyMs: result.latencyMs,
        statusCode: result.statusCode,
        colo: result.colo,
        errorClass: result.errorClass ?? null,
        errorSnippet: result.errorSnippet ?? null,
        checkedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.checkLatest.monitorId, schema.checkLatest.region],
        set: {
          outcome: result.outcome,
          latencyMs: result.latencyMs,
          statusCode: result.statusCode,
          colo: result.colo,
          errorClass: result.errorClass ?? null,
          errorSnippet: result.errorSnippet ?? null,
          checkedAt: now,
        },
      });
    await db.insert(schema.checkRuns).values({
      id: newId(),
      monitorId,
      region,
      outcome: result.outcome,
      latencyMs: result.latencyMs,
      statusCode: result.statusCode,
      colo: result.colo,
      errorClass: result.errorClass ?? null,
      errorSnippet: result.errorSnippet ?? null,
      checkedAt: now,
    });
    const lastPruned = await this.ctx.storage.get<number>("lastHistoryPrune");
    if (!lastPruned || now - lastPruned > 86_400_000) {
      await db.delete(schema.checkRuns).where(lt(schema.checkRuns.checkedAt, now - 90 * 86_400_000));
      await this.ctx.storage.put("lastHistoryPrune", now);
    }
  }

  private async afterRuns(
    componentId: string,
    consecutiveFails: number,
    confirmedOutcome: "pass" | "degraded" | "fail" | null,
    outcome: "pass" | "degraded" | "fail",
    confirmFails: number,
    latencies: number[],
  ): Promise<void> {
    const flip = confirmFlip(consecutiveFails, outcome, Math.max(1, confirmFails));
    const nextConfirmed = outcome === "fail" && !flip.confirmedFail ? confirmedOutcome : outcome;
    const db = drizzle(this.env.DB, { schema });
    const id = await this.monitorId();
    await db
      .update(schema.monitors)
      .set({ consecutiveFails: flip.consecutiveFails, confirmedOutcome: nextConfirmed, updatedAt: Date.now() })
      .where(eq(schema.monitors.id, id));

    const now = Date.now();
    const monitors = await db.select().from(schema.monitors).where(eq(schema.monitors.componentId, componentId));
    const active = monitors.filter((m) => !m.mutedUntil || m.mutedUntil <= now);
    const critical = active.some((m) => m.critical === 1);
    const statuses = active.map((m) => m.id === id ? nextConfirmed : m.confirmedOutcome);
    const status = statuses.some((s) => s === "fail")
      ? "failing"
      : statuses.some((s) => s === "degraded")
        ? "degraded"
        : statuses.length > 0 && statuses.every((s) => s === "pass")
          ? "operational"
          : "unknown";
    const prev = (await db.select().from(schema.componentState).where(eq(schema.componentState.componentId, componentId)))[0];
    await db
      .insert(schema.componentState)
      .values({ componentId, status, updatedAt: now })
      .onConflictDoUpdate({
        target: schema.componentState.componentId,
        set: { status, updatedAt: now },
      });
    await bumpUptime(this.env, componentId, status === "operational" || status === "degraded", latencies);

    if (prev?.status !== "failing" && status === "failing") {
      await this.openIncident(componentId, critical);
    }
    if ((prev?.status === "failing" || prev?.status === "degraded") && status === "operational") {
      await this.resolveIncidents(componentId);
      await this.alert("recover", componentId);
    } else if (prev?.status !== status && status === "degraded") {
      await this.alert("degrade", componentId);
    } else if (prev?.status !== "failing" && status === "failing") {
      await this.alert("fail", componentId);
    }

    await publishSnapshot(this.env);
  }

  private async openIncident(componentId: string, _critical = false): Promise<void> {
    const db = drizzle(this.env.DB, { schema });
    const open = await db
      .select()
      .from(schema.incidents)
      .where(
        and(
          eq(schema.incidents.componentId, componentId),
          inArray(schema.incidents.status, ["investigating", "identified", "monitoring"]),
        ),
      );
    if (open.some((i) => !i.resolvedAt)) return;
    const id = newId();
    const now = Date.now();
    const componentName = (await db.select({ name: schema.monitors.componentName }).from(schema.monitors).where(eq(schema.monitors.componentId, componentId)))[0]?.name ?? componentId;
    try {
      await db.insert(schema.incidents).values({
        id,
        componentId,
        componentIdsJson: JSON.stringify([componentId]),
        status: "investigating",
        impact: "failing",
        title: `${componentName} is failing`,
        createdAt: now,
        resolvedAt: null,
        auto: 1,
      });
    } catch (error) {
      // A second monitor for this component may cross the threshold at the
      // same instant. The partial unique index makes that transition idempotent.
      const winner = await db.select({ id: schema.incidents.id }).from(schema.incidents).where(
        and(
          eq(schema.incidents.componentId, componentId),
          eq(schema.incidents.auto, 1),
          inArray(schema.incidents.status, ["investigating", "identified", "monitoring"]),
        ),
      );
      if (winner.some((incident) => incident.id !== id)) return;
      throw error;
    }
    await db.insert(schema.incidentUpdates).values({
      id: newId(),
      incidentId: id,
      status: "investigating",
      body: "Automatically opened after confirmed check failures.",
      createdAt: now,
    });
  }

  private async resolveIncidents(componentId: string): Promise<void> {
    const db = drizzle(this.env.DB, { schema });
    const rows = await db.select().from(schema.incidents).where(eq(schema.incidents.componentId, componentId));
    const now = Date.now();
    for (const row of rows) {
      if (row.resolvedAt || row.auto !== 1) continue;
      await db
        .update(schema.incidents)
        .set({ status: "resolved", resolvedAt: now })
        .where(eq(schema.incidents.id, row.id));
      await db.insert(schema.incidentUpdates).values({
        id: newId(),
        incidentId: row.id,
        status: "resolved",
        body: "Automatically resolved when checks recovered.",
        createdAt: now,
      });
    }
  }

  private async alert(event: "fail" | "degrade" | "recover", componentId: string): Promise<void> {
    try {
      await this.env.ALERTS.send({ eventId: newId(), event, componentId, title: `${componentId} ${event}` });
    } catch {
      // Queue may be unbound in local tests
    }
  }
}

export function monitorStub(env: Env, monitorId: string) {
  return env.MONITOR.get(env.MONITOR.idFromName(`monitor:${monitorId}`)) as DurableObjectStub<Monitor>;
}
