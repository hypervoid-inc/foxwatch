import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.ts";
import { hasSqlite, testDb } from "../../test/sqlite-d1.ts";
import { ALERT_MAX_ATTEMPTS, alertRetryDelaySeconds, consumeAlerts } from "./alert-queue.ts";
import type { AlertBody } from "./alerts.ts";

const GOOD = "https://hooks.example.com/good";
const BAD = "https://hooks.example.com/bad";

const BODY: AlertBody = { eventId: "evt-1", event: "fail", componentId: "api", title: "api is down" };

type Sent = { body: AlertBody; delaySeconds?: number };

async function setup(channels: Array<{ id: string; secretName: string; events?: string }>, secrets: Record<string, string>) {
  const db = await testDb();
  for (const channel of channels) {
    db.query(
      "INSERT INTO alert_channels (id, type, secret_name, events_json) VALUES (?, 'webhook', ?, ?)",
      channel.id,
      channel.secretName,
      channel.events ?? '["fail","degrade","recover"]',
    );
  }
  const registered = JSON.stringify({ secrets: channels.map((channel) => channel.secretName) });
  db.query("INSERT INTO site_settings (key, value_json) VALUES ('settings', ?)", registered);
  const sent: Sent[] = [];
  const queue = { failing: false };
  const env = {
    DB: db.DB,
    ALERTS: {
      sendBatch: async (messages: Sent[]) => {
        if (queue.failing) throw new Error("queue unavailable");
        sent.push(...messages);
      },
    },
    ...secrets,
  } as unknown as Env;
  return { db, env, sent, queue };
}

function message(body: AlertBody, attempts = 1) {
  const msg = { body, attempts, ack: vi.fn(), retry: vi.fn() };
  return { msg, batch: { messages: [msg] } as unknown as MessageBatch<AlertBody> };
}

/** Answers each endpoint with a fixed status and counts the posts it received. */
function endpoints(statuses: Record<string, number | "throw">) {
  const posts: Record<string, number> = {};
  vi.stubGlobal("fetch", async (input: string) => {
    posts[input] = (posts[input] ?? 0) + 1;
    const status = statuses[input] ?? 200;
    if (status === "throw") throw new Error("connection reset");
    return new Response(status === 200 ? "ok" : "nope", { status });
  });
  return posts;
}

function dropped(db: Awaited<ReturnType<typeof testDb>>) {
  return db
    .query<{ meta_json: string }>("SELECT meta_json FROM audit_log WHERE action = 'alert-delivery-failed' ORDER BY rowid")
    .map((row) => JSON.parse(row.meta_json) as { channelId: string; reason: string });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("alert retry delay", () => {
  it("backs off and stays under the queue's delay limit", () => {
    expect(alertRetryDelaySeconds(1)).toBe(30);
    expect(alertRetryDelaySeconds(2)).toBe(60);
    expect(alertRetryDelaySeconds(5)).toBe(480);
    expect(alertRetryDelaySeconds(40)).toBe(900);
  });
});

describe.skipIf(!hasSqlite)("alert queue consumer", () => {
  it("acks when every channel accepts the alert", async () => {
    const { env, sent } = await setup(
      [{ id: "chat", secretName: "CHAT_URL" }, { id: "pager", secretName: "PAGER_URL" }],
      { CHAT_URL: GOOD, PAGER_URL: BAD },
    );
    const posts = endpoints({});
    const { msg, batch } = message(BODY);
    await consumeAlerts(batch, env);
    expect(posts).toEqual({ [GOOD]: 1, [BAD]: 1 });
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("requeues only the channel that failed, so the healthy one is not posted to again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { env, sent } = await setup(
      [{ id: "chat", secretName: "CHAT_URL" }, { id: "pager", secretName: "PAGER_URL" }],
      { CHAT_URL: GOOD, PAGER_URL: BAD },
    );
    const posts = endpoints({ [BAD]: 503 });
    const first = message(BODY);
    await consumeAlerts(first.batch, env);
    expect(first.msg.ack).toHaveBeenCalledOnce();
    expect(first.msg.retry).not.toHaveBeenCalled();
    expect(sent).toEqual([{ body: { ...BODY, channelId: "pager" }, delaySeconds: 30 }]);

    // The requeued message reaches the failed channel alone and backs off in place.
    const second = message(sent[0]!.body, 2);
    await consumeAlerts(second.batch, env);
    expect(second.msg.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(second.msg.ack).not.toHaveBeenCalled();
    expect(posts).toEqual({ [GOOD]: 1, [BAD]: 2 });
  });

  it("drops a permanent failure without a retry and records it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, env, sent } = await setup(
      [{ id: "chat", secretName: "CHAT_URL" }, { id: "pager", secretName: "PAGER_URL" }, { id: "gone", secretName: "GONE_URL" }],
      // PAGER_URL is registered but not set on the Worker yet.
      { CHAT_URL: GOOD, GONE_URL: BAD },
    );
    const posts = endpoints({ [BAD]: 404 });
    const { msg, batch } = message(BODY);
    await consumeAlerts(batch, env);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(posts).toEqual({ [GOOD]: 1, [BAD]: 1 });
    expect(dropped(db)).toEqual([
      { channelId: "pager", reason: "missing_secret", event: "fail", eventId: "evt-1" },
      { channelId: "gone", reason: "http_404", event: "fail", eventId: "evt-1" },
    ]);
  });

  it("retries a rate limit and a network error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const status of [429, "throw"] as const) {
      const { db, env } = await setup([{ id: "chat", secretName: "CHAT_URL" }], { CHAT_URL: BAD });
      endpoints({ [BAD]: status });
      const { msg, batch } = message(BODY, 3);
      await consumeAlerts(batch, env);
      expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
      expect(msg.ack).not.toHaveBeenCalled();
      expect(dropped(db)).toEqual([]);
    }
  });

  it("gives up after the last attempt and records it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, env } = await setup([{ id: "chat", secretName: "CHAT_URL" }], { CHAT_URL: BAD });
    endpoints({ [BAD]: 500 });
    const { msg, batch } = message(BODY, ALERT_MAX_ATTEMPTS);
    await consumeAlerts(batch, env);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(dropped(db)).toMatchObject([{ channelId: "chat", reason: "http_500" }]);
  });

  it("falls back to retrying the message when the failed channels cannot be requeued", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { env, queue } = await setup(
      [{ id: "chat", secretName: "CHAT_URL" }, { id: "pager", secretName: "PAGER_URL" }],
      { CHAT_URL: GOOD, PAGER_URL: BAD },
    );
    endpoints({ [BAD]: 502 });
    queue.failing = true;
    const { msg, batch } = message(BODY);
    await consumeAlerts(batch, env);
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it("skips channels not subscribed to the event and ones deleted since", async () => {
    const { env } = await setup([{ id: "chat", secretName: "CHAT_URL", events: '["recover"]' }], { CHAT_URL: GOOD });
    const posts = endpoints({});
    const unsubscribed = message(BODY);
    await consumeAlerts(unsubscribed.batch, env);
    const deleted = message({ ...BODY, event: "recover", channelId: "removed" });
    await consumeAlerts(deleted.batch, env);
    expect(posts).toEqual({});
    expect(unsubscribed.msg.ack).toHaveBeenCalledOnce();
    expect(deleted.msg.ack).toHaveBeenCalledOnce();
  });
});
