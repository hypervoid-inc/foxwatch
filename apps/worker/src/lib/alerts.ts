import { assertSafeUrl } from "@foxwatch/engine";
import type { Env } from "../env.ts";
import { resolveSecret } from "./secret-store.ts";

export type AlertBody = {
  eventId: string;
  event: "fail" | "degrade" | "recover";
  componentId: string;
  title: string;
  channelId?: string;
};

export async function deliverAlert(
  env: Env,
  channel: { type: string; secretName: string; events: string[] },
  body: AlertBody,
): Promise<void> {
  if (!channel.events.includes(body.event)) return;
  const url = await resolveSecret(env, channel.secretName);
  if (!url) throw new Error(`missing alert secret ${channel.secretName}`);
  try {
    assertSafeUrl(url, { allowHttpLocal: false });
  } catch (error) {
    throw new Error("unsafe alert endpoint", { cause: error });
  }
  const { channelId: _channelId, ...eventBody } = body;
  const payload =
    channel.type === "slack_webhook"
      ? { text: `[Foxwatch] ${body.title}` }
      : channel.type === "discord_webhook"
        ? {
            content: null,
            embeds: [{
              title: body.title,
              description: `Component: ${body.componentId}`,
              color: body.event === "fail" ? 0xc75c6e : body.event === "degrade" ? 0xd4a04a : 0x5eb89a,
              footer: { text: `Foxwatch · ${body.event === "recover" ? "Recovered" : body.event === "degrade" ? "Degraded" : "Outage"}` },
            }],
            allowed_mentions: { parse: [] },
          }
      : { source: "foxwatch", ...eventBody };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-foxwatch-event-id": body.eventId },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`alert endpoint returned ${response.status}`);
  } finally {
    clearTimeout(timer);
  }
}
