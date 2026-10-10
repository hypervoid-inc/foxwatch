import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import type { LiveNotice } from "../lib/public-html.ts";

const MAX_VIEWERS = 24_000;
/** Open sockets one address may hold. Generous, because an office or a mobile carrier shares one. */
const MAX_PER_CLIENT = 100;
const COALESCE_MS = 400;
/** How often a change that only moves check counts and latency is sent on. */
export const QUIET_MS = 5 * 60_000;

type Sent = { at: number; stable: string };

/** Close codes a peer may be sent. 1005, 1006 and 1015 only ever describe a close; they cannot be put in one. */
export function closeCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
}

/** A browser on another site may not hold our sockets open. Clients that send no Origin are not browsers. */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    const host = new URL(origin).host;
    return host === new URL(request.url).host || host === request.headers.get("Host");
  } catch {
    return false;
  }
}

/** The address a socket is counted under: the IPv4 address, or the /64 an IPv6 client can roam within. */
export function clientNetwork(ip: string | null): string | null {
  if (!ip) return null;
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":");
}

/** Socket tag for a client network. Hashed so the object does not keep visitor addresses. */
async function clientTag(request: Request): Promise<string | null> {
  const network = clientNetwork(request.headers.get("CF-Connecting-IP"));
  if (!network) return null;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(network)));
  return `ip:${[...digest.subarray(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export class StatusHub extends DurableObject<Env> {
  /** Open sockets. Counted here so a connect does not list every socket; the broadcast corrects any drift. */
  private viewers: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.viewers = this.ctx.getWebSockets().length;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    if (!sameOrigin(request)) return new Response("Forbidden", { status: 403 });
    if (this.viewers >= MAX_VIEWERS) {
      return new Response("Too many viewers", { status: 503 });
    }
    const tag = await clientTag(request);
    if (tag && this.ctx.getWebSockets(tag).length >= MAX_PER_CLIENT) {
      return new Response("Too many connections", { status: 429 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    if (!client || !server) return new Response("WebSocket failed", { status: 500 });
    this.ctx.acceptWebSocket(server, tag ? [tag] : []);
    this.viewers++;
    // What every other open page was last told. A page rendered after it ignores it as older.
    const sent = await this.ctx.storage.get<string>("sent");
    if (sent) {
      try {
        server.send(sent);
      } catch {
        /* socket closed during accept */
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Takes the notice for the newest snapshot. Only the notice is stored, never
   * a rendered page, so its size does not grow with the number of components.
   */
  async push(notice: LiveNotice): Promise<void> {
    const stored = await this.ctx.storage.get<string>("notice");
    if (stored) {
      const last = JSON.parse(stored) as LiveNotice;
      // Unchanged, or built before the one already held: publishes can finish out of order.
      if (last.etag === notice.etag || notice.generatedAt < last.generatedAt) return;
    } else {
      // Left by the version that stored the whole rendered page.
      await this.ctx.storage.delete(["payload", "etag"]);
    }
    await this.ctx.storage.put("notice", JSON.stringify(notice));
    const now = Date.now();
    const sent = await this.ctx.storage.get<Sent>("sentInfo");
    // A change a visitor would notice goes out at once. One that only moves the
    // numbers waits, so a quiet page is not redrawn on every probe run.
    const when = sent && sent.stable === notice.stable ? Math.max(now + COALESCE_MS, sent.at + QUIET_MS) : now + COALESCE_MS;
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm == null || alarm > when) await this.ctx.storage.setAlarm(when);
  }

  async alarm(): Promise<void> {
    const body = await this.ctx.storage.get<string>("notice");
    if (!body) return;
    const notice = JSON.parse(body) as LiveNotice;
    await this.ctx.storage.put({ sent: body, sentInfo: { at: Date.now(), stable: notice.stable } satisfies Sent });
    const sockets = this.ctx.getWebSockets();
    this.viewers = sockets.length;
    for (const ws of sockets) {
      try {
        if (ws.readyState === 1) ws.send(body);
      } catch {
        /* drop dead sockets; runtime reaps them */
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.viewers = Math.max(0, this.viewers - 1);
    try {
      ws.close(closeCode(code), closeCode(code) === code ? reason : "");
    } catch {
      /* already closed, or the runtime answered the close frame itself */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.viewers = Math.max(0, this.viewers - 1);
    try {
      ws.close(1011, "error");
    } catch {
      /* already closed */
    }
  }
}

export function statusHubStub(env: Env) {
  return env.STATUS_HUB.get(env.STATUS_HUB.idFromName("public")) as DurableObjectStub<StatusHub>;
}
