import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import type { Check } from "@foxwatch/config";
import type { Env } from "../env.ts";
import * as schema from "../db/schema.ts";
import { publishSnapshot, writeLastTick } from "../lib/snapshot.ts";
import { monitorStub } from "./monitor.ts";

export class Scheduler extends DurableObject<Env> {
  async tick(): Promise<void> {
    const db = drizzle(this.env.DB, { schema });
    const rows = await db.select().from(schema.monitors);
    await Promise.all(rows.map(async (row) => {
      let interval = 60_000;
      try {
        const check = JSON.parse(row.configJson) as Check;
        interval = "intervalMs" in check ? check.intervalMs : 60_000;
      } catch (error) {
        console.error(`invalid monitor config for ${row.id}`, error);
      }
      await monitorStub(this.env, row.id).ensureAlarm(interval);
    }));
    await writeLastTick(this.env);
    await publishSnapshot(this.env);
  }
}

export function schedulerStub(env: Env) {
  return env.SCHEDULER.get(env.SCHEDULER.idFromName("main")) as DurableObjectStub<Scheduler>;
}
