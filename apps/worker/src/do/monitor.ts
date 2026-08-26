import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray } from "drizzle-orm";
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

  async runNow(): Promise<void> {
    await this.execute();
  }

  async alarm(): Promise<void> {
    try {
      await this.execute();
    } catch (err) {
      console.error("monitor alarm failed", err);
    }
    const id = await this.monitorId();
    const db = drizzle(this.env.DB, { schema });
    const rows = await db.select().from(schema.monitors).where(eq(schema.monitors.id, id));
    const row = rows[0];
    const check = row ? asCheck(row.configJson) : null;
    const interval = check && "intervalMs" in check ? check.intervalMs : 60_000;
    await this.ctx.storage.setAlarm(Date.now() + interval);
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
    const check = asCheck(row.configJson);
    if (check.type === "heartbeat") {
      await this.runHeartbeat(row.componentId, check, row.consecutiveFails);
      return;
    }
    await this.runHttp(row.id, row.componentId, row.critical === 1, check, row.consecutiveFails);
  }

  private async runHeartbeat(
    componentId: string,
    check: HeartbeatCheck,
    consecutiveFails: number,
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
    await this.afterRuns(componentId, consecutiveFails, [outcome], check.critical === true, []);
  }

  private async runHttp(
    monitorId: string,
    componentId: string,
    critical: boolean,
    check: HttpCheck,
    consecutiveFails: number,
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
    const outcomes: Array<"pass" | "degraded" | "fail"> = [];
    const latencies: number[] = [];
    for (const region of check.regions as Region[]) {
      let result = await probeStub(this.env, region, monitorId).run(check, secrets);
      for (let i = 0; i < retries && result.outcome === "fail"; i++) {
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
      outcomes.push(result.outcome);
      if (result.latencyMs > 0) latencies.push(result.latencyMs);
    }
    await this.afterRuns(componentId, consecutiveFails, outcomes, critical, latencies);
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
  }

  private async afterRuns(
    componentId: string,
    consecutiveFails: number,
    outcomes: Array<"pass" | "degraded" | "fail">,
    critical: boolean,
    latencies: number[],
  ): Promise<void> {
    const worst = outcomes.includes("fail") ? "fail" : outcomes.includes("degraded") ? "degraded" : "pass";
    const flip = confirmFlip(consecutiveFails, worst, 3);
    const db = drizzle(this.env.DB, { schema });
    const id = await this.monitorId();
    await db
      .update(schema.monitors)
      .set({ consecutiveFails: flip.consecutiveFails, updatedAt: Date.now() })
      .where(eq(schema.monitors.id, id));

    const failWhen = "majority" as const;
    const now = Date.now();
    const latest = await db.select().from(schema.checkLatest);
    const monitors = await db.select().from(schema.monitors).where(eq(schema.monitors.componentId, componentId));
    const runs = latest
      .filter((r) => monitors.some((m) => m.id === r.monitorId))
      .map((r) => ({ region: r.region, outcome: r.outcome as "pass" | "degraded" | "fail" }));
    const status = componentStatus(runs, failWhen);
    const prev = (await db.select().from(schema.componentState).where(eq(schema.componentState.componentId, componentId)))[0];
    await db
      .insert(schema.componentState)
      .values({ componentId, status, updatedAt: now })
      .onConflictDoUpdate({
        target: schema.componentState.componentId,
        set: { status, updatedAt: now },
      });
    await bumpUptime(this.env, componentId, status === "operational" || status === "degraded", latencies);

    if (flip.confirmedFail && status === "failing") {
      await this.openIncident(componentId, critical);
    }
    if (prev?.status === "failing" && status === "operational") {
      await this.resolveIncidents(componentId);
      await this.alert("recover", componentId);
    } else if (prev?.status !== status && status === "degraded") {
      await this.alert("degrade", componentId);
    } else if (flip.confirmedFail && status === "failing") {
      await this.alert("fail", componentId);
    }

    await publishSnapshot(this.env);
  }

  private async openIncident(componentId: string, _critical: boolean): Promise<void> {
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
    await db.insert(schema.incidents).values({
      id,
      componentId,
      status: "investigating",
      impact: "failing",
      title: `${componentId} is failing`,
      createdAt: now,
      resolvedAt: null,
      auto: 1,
    });
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
      if (row.resolvedAt) continue;
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
      await this.env.ALERTS.send({ event, componentId, title: `${componentId} ${event}` });
    } catch {
      // Queue may be unbound in local tests
    }
  }
}

export function monitorStub(env: Env, monitorId: string) {
  return env.MONITOR.get(env.MONITOR.idFromName(`monitor:${monitorId}`)) as DurableObjectStub<Monitor>;
}
