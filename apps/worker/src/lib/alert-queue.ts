import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../env.ts";
import * as schema from "../db/schema.ts";
import { AlertDeliveryError, deliverAlert, type AlertBody } from "./alerts.ts";
import { newId } from "./crypto.ts";

/** Deliveries tried for one channel before the alert is given up. Keep `max_retries` in wrangler.jsonc one below. */
export const ALERT_MAX_ATTEMPTS = 6;

/** 30s, 1m, 2m, 4m, 8m: long enough for a rate limit or a short outage to pass. */
export function alertRetryDelaySeconds(attempt: number): number {
  return Math.min(900, 30 * 2 ** Math.max(0, attempt - 1));
}

type Failure = { channelId: string; reason: string; retryable: boolean };

function failureOf(channelId: string, error: unknown): Failure {
  if (error instanceof AlertDeliveryError) return { channelId, reason: error.reason, retryable: error.retryable };
  // Timeouts and network errors carry no verdict from the endpoint.
  return { channelId, reason: "network", retryable: true };
}

async function deliverToChannel(
  env: Env,
  channel: typeof schema.alertChannels.$inferSelect,
  body: AlertBody,
): Promise<Failure | null> {
  try {
    let events: unknown;
    try {
      events = JSON.parse(channel.eventsJson);
    } catch {
      events = null;
    }
    if (!Array.isArray(events)) throw new AlertDeliveryError("invalid_channel", false, `invalid alert channel ${channel.id}`);
    await deliverAlert(env, { type: channel.type, secretName: channel.secretName, events: events.map(String) }, body);
    return null;
  } catch (error) {
    console.error(`alert delivery to ${channel.id} failed`, error);
    return failureOf(channel.id, error);
  }
}

// A dropped alert leaves a row in Activity. Only the reason class is stored,
// never the endpoint or its response.
async function recordDropped(env: Env, body: AlertBody, failures: Failure[]): Promise<void> {
  if (!failures.length) return;
  try {
    const db = drizzle(env.DB, { schema });
    const now = Date.now();
    await db.insert(schema.auditLog).values(failures.map((failure) => ({
      id: newId(),
      actor: "system",
      action: "alert-delivery-failed",
      monitorId: null,
      metaJson: JSON.stringify({ channelId: failure.channelId, reason: failure.reason, event: body.event, eventId: body.eventId }),
      createdAt: now,
    })));
  } catch (error) {
    console.error("could not record dropped alert", error);
  }
}

export async function consumeAlerts(batch: MessageBatch<AlertBody>, env: Env): Promise<void> {
  const db = drizzle(env.DB, { schema });
  const channels = await db.select().from(schema.alertChannels);
  for (const msg of batch.messages) {
    const body = msg.body;
    const eligible = body.channelId ? channels.filter((channel) => channel.id === body.channelId) : channels;
    const failures = (await Promise.all(eligible.map((channel) => deliverToChannel(env, channel, body))))
      .filter((failure): failure is Failure => failure != null);
    const retryable = failures.filter((failure) => failure.retryable);
    await recordDropped(env, body, failures.filter((failure) => !failure.retryable));
    if (!retryable.length) {
      msg.ack();
      continue;
    }
    if (msg.attempts >= ALERT_MAX_ATTEMPTS) {
      await recordDropped(env, body, retryable);
      msg.ack();
      continue;
    }
    const delaySeconds = alertRetryDelaySeconds(msg.attempts);
    if (eligible.length === 1) {
      msg.retry({ delaySeconds });
      continue;
    }
    // Several channels shared this message. Retrying it would post again to the
    // ones that succeeded, so each failed channel gets a message of its own.
    try {
      await env.ALERTS.sendBatch(retryable.map((failure) => ({
        body: { ...body, channelId: failure.channelId },
        delaySeconds,
      })));
      msg.ack();
    } catch (error) {
      console.error("could not requeue failed alert channels", error);
      msg.retry({ delaySeconds });
    }
  }
}
