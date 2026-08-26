import { assertSafeUrl } from "@foxwatch/engine";
import type { Env } from "../env.ts";
import { resolveSecret } from "./secret-store.ts";

export type AlertBody = {
  event: "fail" | "degrade" | "recover";
  componentId: string;
  title: string;
};

export async function deliverAlert(
  env: Env,
  channel: { type: string; secretName: string; events: string[] },
  body: AlertBody,
): Promise<void> {
  if (!channel.events.includes(body.event)) return;
  const url = await resolveSecret(env, channel.secretName);
  if (!url) return;
  try {
    assertSafeUrl(url, { allowHttpLocal: false });
  } catch {
    return;
  }
  const payload =
    channel.type === "slack_webhook"
      ? { text: `[Foxwatch] ${body.title}` }
      : { source: "foxwatch", ...body };
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}
