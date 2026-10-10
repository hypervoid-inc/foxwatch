import type { Env } from "./env.ts";
import { app } from "./app.ts";
import { Probe } from "./do/probe.ts";
import { Monitor } from "./do/monitor.ts";
import { Scheduler, schedulerStub } from "./do/scheduler.ts";
import { StatusHub, statusHubStub } from "./do/hub.ts";
import type { AlertBody } from "./lib/alerts.ts";
import { consumeAlerts } from "./lib/alert-queue.ts";
import { isWorkerPath } from "./lib/routes.ts";
import { ensureSchema } from "./lib/ensure-schema.ts";
import { internalErrorResponse } from "./lib/ops-error.ts";
import { isCacheablePublicGet, isPublicRead, servePublicCached } from "./lib/public-cache.ts";
import { LIVE_VERSION } from "./lib/public-html.ts";

export { Probe, Monitor, Scheduler, StatusHub };

// A public read is rendered from the KV snapshot, so it is still answered when
// D1 cannot be reached. Anything that writes or needs the admin API is not.
async function schemaReady(request: Request, env: Env, pathname: string): Promise<void> {
  try {
    await ensureSchema(env.DB);
  } catch (err) {
    if (!isPublicRead(request.method, pathname)) throw err;
    console.error("schema check failed", err);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (!isWorkerPath(url.pathname)) {
        return env.ASSETS.fetch(request);
      }
      if (url.pathname === "/live") {
        // A page from before the live blocks changed shape. Refused, it falls back to polling /api/status/live.json.
        if (url.searchParams.get("v") !== LIVE_VERSION) return new Response("Reload the page", { status: 426 });
        return statusHubStub(env).fetch(request);
      }
      const render = async () => {
        await schemaReady(request, env, url.pathname);
        return app.fetch(request, env, ctx);
      };
      if (isCacheablePublicGet(request.method, url.pathname)) return await servePublicCached(request, ctx, render);
      return await render();
    } catch (err) {
      console.error("fetch failed", err);
      return internalErrorResponse();
    }
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
    await consumeAlerts(batch, env);
  },
} satisfies ExportedHandler<Env, AlertBody>;
