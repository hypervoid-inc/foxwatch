import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.ts";
import type { LiveNotice } from "../lib/public-html.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      protected ctx: unknown,
      protected env: unknown,
    ) {}
  },
}));
const { StatusHub, QUIET_MS, clientNetwork, closeCode, sameOrigin } = await import("./hub.ts");

type Socket = { readyState: number; sent: string[]; tags: string[]; send: (body: string) => void; close: (code?: number, reason?: string) => void };

function socket(tags: string[] = []): Socket {
  const sent: string[] = [];
  return { readyState: 1, sent, tags, send: (body) => void sent.push(body), close: vi.fn() };
}

function hubState() {
  const store = new Map<string, unknown>();
  const sockets: Socket[] = [];
  let alarm: number | null = null;
  const ctx = {
    setWebSocketAutoResponse: () => {},
    getWebSockets: (tag?: string) => (tag ? sockets.filter((s) => s.tags.includes(tag)) : sockets),
    acceptWebSocket: (ws: Socket, tags: string[] = []) => {
      ws.tags = tags;
      sockets.push(ws);
    },
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string | Record<string, unknown>, value?: unknown) => {
        if (typeof key === "string") store.set(key, value);
        else for (const [k, v] of Object.entries(key)) store.set(k, v);
      },
      delete: async (keys: string[]) => {
        for (const key of keys) store.delete(key);
      },
      getAlarm: async () => alarm,
      setAlarm: async (when: number) => void (alarm = when),
    },
  };
  const hub = new StatusHub(ctx as unknown as DurableObjectState, {} as Env);
  return {
    hub,
    store,
    sockets,
    alarmAt: () => alarm,
    /** Runs the alarm the way the runtime does: once, clearing it first. */
    fire: async () => {
      alarm = null;
      await hub.alarm();
    },
  };
}

function notice(over: Partial<LiveNotice> = {}): LiveNotice {
  return {
    etag: "e1",
    stable: "s1",
    generatedAt: 1_000,
    title: "Acme status",
    description: "We're fully operational.",
    icon: "/fox.png",
    status: "fully_operational",
    revs: { banner: "1", brand: "2", maintenance: "3", history: "4", systems: "5", mesh: "6" },
    banner: '<div data-rev="1" id="live-banner"></div>',
    ...over,
  };
}

const NOW = Date.parse("2026-10-10T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal("WebSocketRequestResponsePair", class {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("StatusHub.push", () => {
  it("stores the notice it is given and nothing larger, and sends it to open pages shortly after", async () => {
    const { hub, store, sockets, alarmAt, fire } = hubState();
    sockets.push(socket(), socket());
    store.set("payload", "x".repeat(10));
    store.set("etag", "old");
    await hub.push(notice());
    expect(store.has("payload")).toBe(false);
    expect(store.has("etag")).toBe(false);
    expect(store.get("notice")).toBe(JSON.stringify(notice()));
    expect(alarmAt()).toBe(NOW + 400);
    await fire();
    for (const ws of sockets) expect(ws.sent).toEqual([JSON.stringify(notice())]);
    expect(store.get("sent")).toBe(JSON.stringify(notice()));
    expect(store.get("sentInfo")).toEqual({ at: NOW, stable: "s1" });
  });

  it("ignores a repeat and a notice built before the one it holds", async () => {
    const { hub, store, alarmAt, fire } = hubState();
    await hub.push(notice({ etag: "e2", generatedAt: 2_000 }));
    await fire();
    await hub.push(notice({ etag: "e2", generatedAt: 2_500 }));
    await hub.push(notice({ etag: "e1", generatedAt: 1_000, status: "failing" }));
    expect(JSON.parse(store.get("notice") as string)).toMatchObject({ etag: "e2", generatedAt: 2_000 });
    expect(alarmAt()).toBeNull();
  });

  it("holds back a change that only moves the numbers, and sends the newest one when the wait is over", async () => {
    const { hub, sockets, alarmAt, fire } = hubState();
    const ws = socket();
    sockets.push(ws);
    await hub.push(notice());
    await fire();
    vi.setSystemTime(NOW + 30_000);
    await hub.push(notice({ etag: "e2", generatedAt: 2_000 }));
    expect(alarmAt()).toBe(NOW + QUIET_MS);
    vi.setSystemTime(NOW + 60_000);
    await hub.push(notice({ etag: "e3", generatedAt: 3_000 }));
    expect(alarmAt()).toBe(NOW + QUIET_MS);
    vi.setSystemTime(NOW + QUIET_MS);
    await fire();
    expect(ws.sent.map((body) => (JSON.parse(body) as LiveNotice).etag)).toEqual(["e1", "e3"]);
  });

  it("does not make a status change wait behind a held-back one", async () => {
    const { hub, sockets, alarmAt, fire } = hubState();
    const ws = socket();
    sockets.push(ws);
    await hub.push(notice());
    await fire();
    vi.setSystemTime(NOW + 30_000);
    await hub.push(notice({ etag: "e2", generatedAt: 2_000 }));
    vi.setSystemTime(NOW + 40_000);
    await hub.push(notice({ etag: "e3", stable: "s2", generatedAt: 3_000, status: "failing" }));
    expect(alarmAt()).toBe(NOW + 40_400);
    await fire();
    expect(JSON.parse(ws.sent.at(-1)!)).toMatchObject({ etag: "e3", status: "failing" });
    // Back to the earlier state is a change too, measured against what pages were last sent.
    vi.setSystemTime(NOW + 50_000);
    await hub.push(notice({ etag: "e4", stable: "s1", generatedAt: 4_000 }));
    expect(alarmAt()).toBe(NOW + 50_400);
  });
});

describe("StatusHub sockets", () => {
  function upgrade(headers: Record<string, string> = {}) {
    return new Request("https://status.example.com/live", { headers: { Upgrade: "websocket", ...headers } });
  }

  /** Node's Response cannot carry a 101 or a socket, so the accepted path gets a stand-in. */
  function acceptable() {
    const server = socket();
    vi.stubGlobal("WebSocketPair", class { 0 = {}; 1 = server; });
    vi.stubGlobal("Response", class { status: number; constructor(_body: unknown, init: { status: number }) { this.status = init.status; } });
    return server;
  }

  it("turns away plain requests and browsers on another site", async () => {
    const { hub } = hubState();
    expect((await hub.fetch(new Request("https://status.example.com/live"))).status).toBe(426);
    expect((await hub.fetch(upgrade({ Origin: "https://evil.example" }))).status).toBe(403);
  });

  it("replays what pages were last sent to a new socket, not a notice still held back", async () => {
    const { hub, sockets, fire } = hubState();
    await hub.push(notice());
    await fire();
    await hub.push(notice({ etag: "e2", generatedAt: 2_000 }));
    const server = acceptable();
    const res = await hub.fetch(upgrade({ Origin: "https://status.example.com", "CF-Connecting-IP": "203.0.113.7" }));
    expect(res.status).toBe(101);
    expect(sockets).toContain(server);
    expect(server.tags).toEqual([expect.stringMatching(/^ip:[0-9a-f]{24}$/)]);
    expect(server.sent.map((body) => (JSON.parse(body) as LiveNotice).etag)).toEqual(["e1"]);
  });

  it("caps the sockets one address may hold and leaves other visitors alone", async () => {
    const { hub, sockets } = hubState();
    acceptable();
    await hub.fetch(upgrade({ "CF-Connecting-IP": "203.0.113.7" }));
    const tag = sockets[0]!.tags[0]!;
    for (let i = 1; i < 100; i++) sockets.push(socket([tag]));
    expect((await hub.fetch(upgrade({ "CF-Connecting-IP": "203.0.113.7" }))).status).toBe(429);
    expect((await hub.fetch(upgrade({ "CF-Connecting-IP": "203.0.113.8" }))).status).toBe(101);
  });

  it("answers a close without echoing a code that cannot be sent, and never throws", async () => {
    const { hub } = hubState();
    const gone = socket();
    await hub.webSocketClose(gone as unknown as WebSocket, 1006, "");
    expect(gone.close).toHaveBeenCalledWith(1000, "");
    const polite = socket();
    await hub.webSocketClose(polite as unknown as WebSocket, 4001, "bye");
    expect(polite.close).toHaveBeenCalledWith(4001, "bye");
    const dead = socket();
    dead.close = () => {
      throw new TypeError("WebSocket already closed");
    };
    await expect(hub.webSocketClose(dead as unknown as WebSocket, 1000, "")).resolves.toBeUndefined();
    await expect(hub.webSocketError(dead as unknown as WebSocket)).resolves.toBeUndefined();
  });
});

describe("hub helpers", () => {
  it("maps reserved and protocol close codes to a normal close", () => {
    expect([1000, 1001, 1005, 1006, 1015, 2999, 3000, 4999, 5000].map(closeCode)).toEqual([1000, 1000, 1000, 1000, 1000, 1000, 3000, 4999, 1000]);
  });

  it("accepts the page's own origin and clients that send none", () => {
    const at = (origin?: string, host?: string) =>
      sameOrigin(new Request("https://status.example.com/live", { headers: { ...(origin ? { Origin: origin } : {}), ...(host ? { Host: host } : {}) } }));
    expect(at()).toBe(true);
    expect(at("https://status.example.com")).toBe(true);
    expect(at("https://other.example.com")).toBe(false);
    expect(at("null")).toBe(false);
    // A dev proxy may rewrite the URL but keeps the Host the browser used.
    expect(at("http://localhost:5173", "localhost:5173")).toBe(true);
  });

  it("counts an IPv6 client by its /64 and an IPv4 client by its address", () => {
    expect(clientNetwork(null)).toBeNull();
    expect(clientNetwork("203.0.113.7")).toBe("203.0.113.7");
    expect(clientNetwork("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2");
    expect(clientNetwork("2001:0db8:0001:0002::1")).toBe("2001:db8:1:2");
    expect(clientNetwork("2001:db8::1")).toBe("2001:db8:0:0");
    expect(clientNetwork("::1")).toBe("0:0:0:0");
  });
});
