import { assertSafeUrl, redactText, regionLabel } from "@foxwatch/engine";
import { drizzle } from "drizzle-orm/d1";
import { eq, inArray } from "drizzle-orm";
import type { Env } from "../env.ts";
import * as schema from "../db/schema.ts";
import { resolveSecret } from "./secret-store.ts";
import { sniffIconMime } from "./crypto.ts";

export const PUBLIC_ORIGIN_KEY = "origin:public";

export type AlertRegion = {
  region: string;
  outcome: string;
  latencyMs?: number | null;
  statusCode?: number | null;
  colo?: string | null;
  errorClass?: string | null;
  errorSnippet?: string | null;
};

export type AlertBody = {
  eventId: string;
  event: "fail" | "degrade" | "recover";
  componentId: string;
  title: string;
  channelId?: string;
  occurredAt?: number;
  publicOrigin?: string;
  source?: "monitor" | "incident" | "test";
  componentName?: string;
  componentIds?: string[];
  componentNames?: string[];
  incidentId?: string;
  incidentStatus?: string;
  incidentImpact?: string;
  updateBody?: string;
  checkType?: "http" | "heartbeat";
  consecutiveFails?: number;
  durationMs?: number;
  regions?: AlertRegion[];
};

export type DiscordPayloadContext = {
  siteName: string;
  origin?: string | null;
  iconUrl?: string | null;
};

type DiscordField = { name: string; value: string; inline?: boolean };

type DiscordLinkButton = { type: 2; style: 5; label: string; url: string };

export const FOXWATCH_GITHUB = "https://github.com/hypervoid-inc/foxwatch";
export const FOXWATCH_AVATAR_URL = "https://raw.githubusercontent.com/hypervoid-inc/foxwatch/main/public/fox.png";
const FOXWATCH_AVATAR_MIRRORS = [
  FOXWATCH_AVATAR_URL,
  "https://cdn.jsdelivr.net/gh/hypervoid-inc/foxwatch@main/public/fox.png",
];
const DISCORD_AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/gif"]);

export type DiscordWebhookPayload = {
  content: null;
  username: string;
  avatar_url?: string;
  embeds: Array<{
    title: string;
    url?: string;
    description: string;
    color: number;
    timestamp?: string;
    footer?: { text: string; icon_url?: string };
    author?: { name: string; url?: string; icon_url?: string };
    fields: DiscordField[];
  }>;
  components?: Array<{ type: 1; components: DiscordLinkButton[] }>;
  allowed_mentions: { parse: [] };
};

const TITLE_MAX = 256;
const DESC_MAX = 4096;
const FIELD_VALUE_MAX = 1024;
const USERNAME_MAX = 80;
const SNIPPET_MAX = 300;
const EMBED_TOTAL_MAX = 6000;
const BUTTON_URL_MAX = 512;
const BUTTON_LABEL_MAX = 80;

const ISSUE_LABELS: Record<string, string> = {
  timeout: "timeout",
  connect: "connect",
  heartbeat: "missed ping",
  status: "status",
  header: "header",
  body: "body",
  json: "json",
  jsonpath: "json",
  assertion: "assertion",
  redirect: "redirect",
  redirect_host: "redirect",
  latency: "latency",
};

/** Why a delivery failed, and whether sending the same alert again can help. */
export class AlertDeliveryError extends Error {
  constructor(
    readonly reason: string,
    readonly retryable: boolean,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AlertDeliveryError";
  }
}

export function isPublicOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.host);
  } catch {
    return false;
  }
}

// One KV read per isolate: a request on the origin already stored costs nothing.
const rememberedOrigins = new WeakMap<object, string>();

/**
 * Stores the origin an operator is signed in on, as the fallback for alert links
 * when no public URL is set. Callers must have authenticated the request:
 * anyone can reach the Worker on its workers.dev host.
 */
export async function rememberPublicOrigin(env: Env, origin: string): Promise<void> {
  if (!isPublicOrigin(origin)) return;
  try {
    if (rememberedOrigins.get(env.STATUS) === origin) return;
    const current = await env.STATUS.get(PUBLIC_ORIGIN_KEY);
    if (current !== origin) await env.STATUS.put(PUBLIC_ORIGIN_KEY, origin);
    rememberedOrigins.set(env.STATUS, origin);
  } catch {
    /* KV may be unbound in tests */
  }
}

export async function readPublicOrigin(env: Env): Promise<string | null> {
  try {
    const value = await env.STATUS.get(PUBLIC_ORIGIN_KEY);
    return value && isPublicOrigin(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Origin for the links in an alert: the public URL from settings, then the
 * origin of the admin request that raised the alert, then the remembered one.
 */
export async function alertOrigin(env: Env, configured: string | null, requestOrigin?: string): Promise<string | null> {
  if (configured && isPublicOrigin(configured)) return configured;
  if (requestOrigin && isPublicOrigin(requestOrigin)) return requestOrigin;
  return readPublicOrigin(env);
}

export function discordUsername(siteName: string): string {
  const name = siteName.replace(/\s+/g, " ").trim().slice(0, USERNAME_MAX);
  if (!name || /discord|clyde/i.test(name)) return "Foxwatch";
  return name;
}

/** Discord markdown timestamp; unix seconds, rendered in each reader's locale. */
export function discordTimestamp(atMs: number, style: "f" | "R" = "R"): string {
  const seconds = Math.floor(atMs / 1000);
  if (!Number.isFinite(seconds)) return "";
  return `<t:${seconds}:${style}>`;
}

export function discordExecuteUrl(webhookUrl: string, withComponents: boolean): string {
  const parsed = new URL(webhookUrl);
  parsed.searchParams.set("wait", "true");
  if (withComponents) parsed.searchParams.set("with_components", "true");
  else parsed.searchParams.delete("with_components");
  return parsed.toString();
}

export function discordWebhookResourceUrl(webhookUrl: string): string {
  const parsed = new URL(webhookUrl);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  if (hours < 24) return remMin ? `${hours}h ${remMin}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

export function regionLine(run: AlertRegion): string {
  const label = regionLabel(run.region);
  const colo = run.colo?.trim();
  const place = colo ? `${label} (${colo})` : label;
  return `${place} · ${regionDetail(run)}`;
}

export function discordPayload(body: AlertBody, ctx: DiscordPayloadContext): DiscordWebhookPayload {
  const names = displayNames(body);
  const origin = resolveOrigin(ctx.origin ?? body.publicOrigin);
  const title = embedTitle(body, names);
  let description = embedDescription(body);
  const fields = embedFields(body, names);
  const url = statusLink(origin, body.incidentId);
  const occurredAt = body.occurredAt ?? Date.now();
  const stamp = clip(
    `${body.eventId.slice(0, 8)} · ${discordTimestamp(occurredAt, "f")} · ${discordTimestamp(occurredAt, "R")}`,
    FIELD_VALUE_MAX,
  );
  if (stamp) fields.push({ name: "\u200b", value: stamp, inline: false });
  const authorName = discordUsername(ctx.siteName);
  const budgetUsed = title.length + (authorName === "Foxwatch" ? 0 : authorName.length)
    + fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  if (budgetUsed + description.length > EMBED_TOTAL_MAX) {
    description = clip(description, Math.max(0, EMBED_TOTAL_MAX - budgetUsed));
  }
  const buttons = actionButtons(origin, body.incidentId);
  const payload: DiscordWebhookPayload = {
    content: null,
    username: "Foxwatch",
    avatar_url: FOXWATCH_AVATAR_URL,
    embeds: [{
      title,
      description,
      color: body.event === "fail" ? 0xc75c6e : body.event === "degrade" ? 0xd4a04a : 0x5eb89a,
      fields,
    }],
    allowed_mentions: { parse: [] },
  };
  if (url) payload.embeds[0]!.url = url;
  if (authorName !== "Foxwatch") {
    const icon = authorIconUrl(origin, ctx.iconUrl);
    payload.embeds[0]!.author = {
      name: authorName,
      ...(origin ? { url: origin } : {}),
      ...(icon ? { icon_url: icon } : {}),
    };
  }
  if (buttons.length) payload.components = [{ type: 1, components: buttons }];
  return payload;
}

export async function deliverAlert(
  env: Env,
  channel: { type: string; secretName: string; events: string[] },
  body: AlertBody,
): Promise<void> {
  if (!channel.events.includes(body.event)) return;
  const url = await resolveSecret(env, channel.secretName);
  if (!url) throw new AlertDeliveryError("missing_secret", false, `missing alert secret ${channel.secretName}`);
  try {
    assertSafeUrl(url, { allowHttpLocal: false });
  } catch (error) {
    throw new AlertDeliveryError("unsafe_endpoint", false, "unsafe alert endpoint", { cause: error });
  }
  const { channelId: _channelId, ...eventBody } = body;
  let payload: unknown;
  let executeUrl = url;
  if (channel.type === "slack_webhook") {
    const text = body.source === "incident" && body.updateBody
      ? `[Foxwatch] ${body.title}: ${body.updateBody}`
      : `[Foxwatch] ${body.title}`;
    payload = { text };
  } else if (channel.type === "discord_webhook") {
    const settings = await loadSiteBrand(env);
    const origin = await alertOrigin(env, settings.publicUrl, body.publicOrigin);
    const enriched = await enrichAlertBody(env, body);
    const discord = discordPayload(enriched, {
      siteName: settings.siteName,
      origin,
      iconUrl: settings.iconUrl,
    });
    executeUrl = discordExecuteUrl(url, Boolean(discord.components?.length));
    payload = discord;
  } else {
    payload = { source: "foxwatch", ...eventBody };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(executeUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-foxwatch-event-id": body.eventId },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const snippet = text.replace(/\s+/g, " ").trim().slice(0, 180);
      // A rejected request stays rejected. Only a busy or broken endpoint is worth another try.
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw new AlertDeliveryError(
        `http_${response.status}`,
        retryable,
        snippet ? `alert endpoint returned ${response.status}: ${snippet}` : `alert endpoint returned ${response.status}`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

async function loadSiteBrand(env: Env): Promise<{ siteName: string; iconUrl: string | null; publicUrl: string | null }> {
  const { loadSettings, iconPublicUrl } = await import("./snapshot.ts");
  const settings = await loadSettings(env);
  return { siteName: settings.siteName, iconUrl: iconPublicUrl(settings.iconUpdatedAt), publicUrl: settings.publicUrl };
}

function clip(value: string, max: number): string {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  if (max === 1) return "…";
  return `${value.slice(0, max - 1)}…`;
}

function idsOf(body: AlertBody): string[] {
  if (body.componentIds?.length) {
    return body.componentIds.filter((id) => id && id !== "global" && id !== "test");
  }
  if (!body.componentId || body.componentId === "test" || body.componentId === "global") return [];
  if (body.componentId.includes(",")) {
    return body.componentId.split(",").map((id) => id.trim()).filter((id) => id && id !== "global");
  }
  return [body.componentId];
}

function displayNames(body: AlertBody): string[] {
  if (body.componentNames?.length) return body.componentNames;
  if (body.componentName) return [body.componentName];
  return idsOf(body);
}

function resolveOrigin(origin: string | null | undefined): string | undefined {
  if (!origin || !isPublicOrigin(origin)) return;
  return new URL(origin).origin;
}

function statusLink(origin: string | undefined, incidentId?: string): string | undefined {
  if (!origin) return;
  if (incidentId) return `${origin}/incidents/${encodeURIComponent(incidentId)}`;
  return origin;
}

function authorIconUrl(origin: string | undefined, iconUrl?: string | null): string | undefined {
  if (!origin || !origin.startsWith("https:") || !iconUrl) return;
  try {
    return new URL(iconUrl, `${origin}/`).toString();
  } catch {
    return;
  }
}

function actionButtons(origin: string | undefined, incidentId?: string): DiscordLinkButton[] {
  const buttons: DiscordLinkButton[] = [];
  const primary = statusButton(origin, incidentId);
  if (primary) buttons.push(primary);
  if (FOXWATCH_GITHUB.length <= BUTTON_URL_MAX) {
    buttons.push({
      type: 2,
      style: 5,
      label: clip("What is Foxwatch", BUTTON_LABEL_MAX),
      url: FOXWATCH_GITHUB,
    });
  }
  return buttons;
}

function statusButton(origin: string | undefined, incidentId?: string): DiscordLinkButton | undefined {
  const url = statusLink(origin, incidentId);
  if (!url || url.length > BUTTON_URL_MAX) return;
  return {
    type: 2,
    style: 5,
    label: clip(incidentId ? "Open incident" : "Open status page", BUTTON_LABEL_MAX),
    url,
  };
}

/**
 * Names the channel's webhook and sets its avatar. Every card already carries
 * its own username and avatar, so this runs when a channel is tested, never on
 * the delivery path. It does not throw.
 */
export async function brandDiscordChannel(env: Env, channel: { type: string; secretName: string }): Promise<void> {
  if (channel.type !== "discord_webhook") return;
  try {
    const url = await resolveSecret(env, channel.secretName);
    if (!url) return;
    assertSafeUrl(url, { allowHttpLocal: false });
    await brandDiscordWebhook(url, env);
  } catch {
    /* cosmetic only */
  }
}

export async function brandDiscordWebhook(webhookUrl: string, env?: Env, png?: Uint8Array): Promise<void> {
  const avatar = pngAvatarDataUri(png) ?? await foxAvatarDataUri(env);
  const body: { name: string; avatar?: string } = { name: "Foxwatch" };
  if (avatar) body.avatar = avatar;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(discordWebhookResourceUrl(webhookUrl), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`discord webhook brand failed ${response.status} ${text.slice(0, 120)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export function pngAvatarDataUri(bytes: Uint8Array | undefined): string | null {
  if (!bytes || bytes.byteLength < 32 || bytes.byteLength > 256 * 1024) return null;
  const type = sniffIconMime(bytes);
  if (!type || !DISCORD_AVATAR_TYPES.has(type)) return null;
  return `data:${type};base64,${bytesToBase64(bytes)}`;
}

async function foxAvatarDataUri(env?: Env): Promise<string | null> {
  const tries: Array<() => Promise<Response>> = [];
  if (env?.ASSETS) {
    tries.push(() => env.ASSETS.fetch(new Request("https://foxwatch.internal/fox.png")));
  }
  for (const url of FOXWATCH_AVATAR_MIRRORS) {
    tries.push(() => fetch(url, { signal: AbortSignal.timeout(5_000) }));
  }
  for (const get of tries) {
    try {
      const res = await get();
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const avatar = pngAvatarDataUri(bytes);
      if (avatar) return avatar;
    } catch {
      /* try the next source */
    }
  }
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function embedTitle(body: AlertBody, names: string[]): string {
  if (body.source === "test") return clip(body.title || "Test alert, delivery is configured", TITLE_MAX);
  if (body.source === "incident") return clip(body.title, TITLE_MAX);
  const name = names[0] ?? body.componentId;
  if (body.event === "fail") return clip(`${name} is down`, TITLE_MAX);
  if (body.event === "degrade") return clip(`${name} is degraded`, TITLE_MAX);
  return clip(`${name} recovered`, TITLE_MAX);
}

function embedDescription(body: AlertBody): string {
  let sentence: string;
  if (body.source === "test") {
    sentence = "This channel is configured and can receive Foxwatch events.";
  } else if (body.source === "incident") {
    sentence = (body.updateBody ?? "").trim() || (body.event === "recover" ? "Incident resolved." : "Investigating.");
  } else if (body.checkType === "heartbeat" && body.event === "fail") {
    sentence = "Missed heartbeat.";
  } else if (body.event === "fail") {
    const n = body.consecutiveFails;
    sentence = n && n > 0
      ? `Confirmed after ${n} failing check${n === 1 ? "" : "s"}.`
      : "Confirmed outage after check failures.";
  } else if (body.event === "degrade") {
    sentence = "Confirmed degradation.";
  } else {
    sentence = "Checks recovered.";
  }
  const snippet = pickSnippet(body.regions);
  if (!snippet) return clip(sentence, DESC_MAX);
  return clip(`${sentence}\n\n${fenceSnippet(snippet)}`, DESC_MAX);
}

function embedFields(body: AlertBody, names: string[]): DiscordField[] {
  const fields: DiscordField[] = [
    { name: "Status", value: clip(statusLabel(body.event), FIELD_VALUE_MAX), inline: true },
    { name: "Component", value: clip(componentHeader(body, names), FIELD_VALUE_MAX), inline: true },
    { name: "Source", value: clip(sourceLabel(body), FIELD_VALUE_MAX), inline: true },
  ];
  const regions = body.regions ?? [];
  if (regions.length) {
    fields.push({
      name: "Regions",
      value: clip(regions.map(regionLine).join("\n"), FIELD_VALUE_MAX),
      inline: false,
    });
  }
  if (body.event === "recover" && body.durationMs != null && body.durationMs >= 0) {
    fields.push({ name: "Duration", value: clip(formatDuration(body.durationMs), FIELD_VALUE_MAX), inline: false });
  }
  const listed = names.length >= 2 ? names : idsOf(body).length >= 2 ? displayNames(body) : [];
  if (listed.length >= 2) {
    fields.push({ name: "Components", value: clip(listed.join("\n"), FIELD_VALUE_MAX), inline: false });
  }
  return fields;
}

function statusLabel(event: AlertBody["event"]): string {
  if (event === "fail") return "Outage";
  if (event === "degrade") return "Degraded";
  return "Recovered";
}

function sourceLabel(body: AlertBody): string {
  if (body.source === "test") return "Test";
  if (body.source === "incident") return "Incident";
  if (body.checkType === "heartbeat") return "Heartbeat";
  if (body.checkType === "http") return "HTTP";
  return "Monitor";
}

function componentHeader(body: AlertBody, names: string[]): string {
  if (body.source === "test") return "Test";
  const ids = idsOf(body);
  if (ids.length === 0) return "All components";
  const first = names[0] ?? ids[0] ?? body.componentId;
  const extra = Math.max(names.length, ids.length) - 1;
  if (extra > 0) return `${first} +${extra}`;
  return first;
}

function regionDetail(run: AlertRegion): string {
  const ms = run.latencyMs != null && run.latencyMs > 0 ? `${Math.round(run.latencyMs)}ms` : null;
  if (run.outcome === "pass") return ms ?? "ok";
  if (run.errorClass === "missing_secret" || run.errorClass === "invalid_url") {
    return run.outcome === "fail" ? "failing" : "degraded";
  }
  if (run.errorClass === "status" && run.statusCode) return `HTTP ${run.statusCode}`;
  if (run.errorClass === "heartbeat") return "missed ping";
  if (run.errorClass === "latency" && ms) return ms;
  const issue = run.errorClass ? ISSUE_LABELS[run.errorClass] : undefined;
  if (issue) return issue;
  if (ms) return ms;
  return run.outcome === "fail" ? "failing" : "degraded";
}

function pickSnippet(regions: AlertRegion[] | undefined): string | undefined {
  if (!regions?.length) return;
  const ranked = [...regions].sort((a, b) => outcomeRank(b.outcome) - outcomeRank(a.outcome));
  const snippet = ranked.find((run) => run.errorSnippet?.trim())?.errorSnippet?.trim();
  return snippet || undefined;
}

function outcomeRank(outcome: string): number {
  if (outcome === "fail") return 2;
  if (outcome === "degraded") return 1;
  return 0;
}

function fenceSnippet(raw: string): string {
  const clean = redactText(raw).replaceAll("```", "'''").slice(0, SNIPPET_MAX);
  return `\`\`\`\n${clean}\n\`\`\``;
}

async function enrichAlertBody(env: Env, body: AlertBody): Promise<AlertBody> {
  try {
    const ids = idsOf(body);
    let next = body;
    if (ids.length && (!body.componentNames?.length || !body.componentName)) {
      const names = await lookupComponentNames(env, ids);
      if (names.length) next = { ...next, componentNames: names, componentName: names[0] };
    }
    if (!next.regions?.length) {
      const primary = ids[0];
      if (primary) {
        const regions = await lookupLatestRegions(env, primary);
        if (regions?.length) next = { ...next, regions };
      }
    }
    return next;
  } catch {
    return body;
  }
}

async function lookupComponentNames(env: Env, ids: string[]): Promise<string[]> {
  const db = drizzle(env.DB, { schema });
  const rows = await db
    .select({ id: schema.monitors.componentId, name: schema.monitors.componentName })
    .from(schema.monitors)
    .where(inArray(schema.monitors.componentId, ids));
  const byId = new Map<string, string>();
  for (const row of rows) {
    if (!byId.has(row.id)) byId.set(row.id, row.name);
  }
  return ids.map((id) => byId.get(id) ?? id);
}

async function lookupLatestRegions(env: Env, componentId: string): Promise<AlertRegion[] | undefined> {
  const db = drizzle(env.DB, { schema });
  const monitors = await db
    .select({ id: schema.monitors.id })
    .from(schema.monitors)
    .where(eq(schema.monitors.componentId, componentId));
  if (!monitors.length) return;
  const rows = await db
    .select()
    .from(schema.checkLatest)
    .where(inArray(schema.checkLatest.monitorId, monitors.map((row) => row.id)));
  if (!rows.length) return;
  const worst = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const prev = worst.get(row.region);
    if (!prev || row.checkedAt >= prev.checkedAt) worst.set(row.region, row);
  }
  return [...worst.values()].map((row) => ({
    region: row.region,
    outcome: row.outcome,
    latencyMs: row.latencyMs,
    statusCode: row.statusCode,
    colo: row.colo,
    errorClass: row.errorClass,
    errorSnippet: row.errorSnippet,
  }));
}
