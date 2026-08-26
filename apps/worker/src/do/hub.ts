import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import type { LivePayload } from "../lib/public-html.ts";

const MAX_VIEWERS = 24_000;
const COALESCE_MS = 400;

export class StatusHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    if (this.ctx.getWebSockets().length >= MAX_VIEWERS) {
      return new Response("Too many viewers", { status: 503 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    if (!client || !server) return new Response("WebSocket failed", { status: 500 });
    this.ctx.acceptWebSocket(server);
    const pending = await this.ctx.storage.get<string>("payload");
    if (pending) {
      try {
        server.send(pending);
      } catch {
        /* socket closed during accept */
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async push(payload: LivePayload): Promise<void> {
    const body = JSON.stringify(payload);
    const last = await this.ctx.storage.get<string>("etag");
    await this.ctx.storage.put("payload", body);
    if (last === payload.etag) return;
    await this.ctx.storage.put("etag", payload.etag);
    const when = Date.now() + COALESCE_MS;
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm == null || alarm > when) await this.ctx.storage.setAlarm(when);
  }

  async alarm(): Promise<void> {
    const body = await this.ctx.storage.get<string>("payload");
    if (!body) return;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        if (ws.readyState === 1) ws.send(body);
      } catch {
        /* drop dead sockets; runtime reaps them */
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }
}

export function statusHubStub(env: Env) {
  return env.STATUS_HUB.get(env.STATUS_HUB.idFromName("public")) as DurableObjectStub<StatusHub>;
}
