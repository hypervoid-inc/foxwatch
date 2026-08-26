import { drizzle } from "drizzle-orm/d1";
import type { Env } from "./env.ts";
import { app } from "./app.ts";
import { Probe } from "./do/probe.ts";
import { Monitor } from "./do/monitor.ts";
import { Scheduler, schedulerStub } from "./do/scheduler.ts";
import { StatusHub, statusHubStub } from "./do/hub.ts";
import * as schema from "./db/schema.ts";
import { deliverAlert, type AlertBody } from "./lib/alerts.ts";
import { isWorkerPath } from "./lib/routes.ts";
import { ensureSchema } from "./lib/ensure-schema.ts";

export { Probe, Monitor, Scheduler, StatusHub };

async function maybeBootstrap(env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(
    schedulerStub(env)
      .tick()
      .catch((err: unknown) => console.error("bootstrap failed", err)),
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!isWorkerPath(url.pathname)) {
      return env.ASSETS.fetch(request);
    }
    if (url.pathname === "/live") {
      return statusHubStub(env).fetch(request);
    }
    await ensureSchema(env.DB);
    const cached = await env.STATUS.get("snapshot:public");
    if (!cached) await maybeBootstrap(env, ctx);
    return app.fetch(request, env, ctx);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await ensureSchema(env.DB);
    ctx.waitUntil(
      schedulerStub(env)
        .tick()
        .catch((err: unknown) => console.error("scheduled tick failed", err)),
    );
  },

  async queue(batch: MessageBatch<AlertBody>, env: Env): Promise<void> {
    const db = drizzle(env.DB, { schema });
    const channels = await db.select().from(schema.alertChannels);
    for (const msg of batch.messages) {
      for (const ch of channels) {
        await deliverAlert(env, {
          type: ch.type,
          secretName: ch.secretName,
          events: JSON.parse(ch.eventsJson) as string[],
        }, msg.body);
      }
      msg.ack();
    }
  },
} satisfies ExportedHandler<Env, AlertBody>;
