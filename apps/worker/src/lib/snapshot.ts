import { drizzle } from "drizzle-orm/d1";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { BannerStatus, ComponentStatus, FailWhen } from "@foxwatch/config";
import { bannerStatus, componentStatus, publicSnapshot, sanitizeText, parseHomepageUrl, type PublicSnapshot } from "@foxwatch/engine";
import type { Env } from "../env.ts";
import * as schema from "../db/schema.ts";
import { renderLivePayload } from "./public-html.ts";
import { statusHubStub } from "../do/hub.ts";
import { sniffIconMime } from "./crypto.ts";

function utcDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function daysBack(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export type InstanceSettings = {
  siteName: string;
  secrets: string[];
  homepageUrl: string | null;
  iconUpdatedAt: number | null;
};

const DEFAULT_SETTINGS: InstanceSettings = { siteName: "Foxwatch", secrets: [], homepageUrl: null, iconUpdatedAt: null };
const MAX_ICON_BYTES = 256 * 1024;
const ICON_KEY = "icon";

function toBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function parseSettings(raw: string): InstanceSettings {
  try {
    const parsed = JSON.parse(raw) as Partial<InstanceSettings>;
    const secrets = Array.isArray(parsed.secrets)
      ? parsed.secrets.filter((n): n is string => typeof n === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(n))
      : [];
    const siteName = sanitizeText(typeof parsed.siteName === "string" ? parsed.siteName : DEFAULT_SETTINGS.siteName, 80);
    let homepageUrl: string | null = null;
    try {
      homepageUrl = parseHomepageUrl(parsed.homepageUrl ?? null);
    } catch {
      homepageUrl = null;
    }
    const iconUpdatedAt =
      typeof parsed.iconUpdatedAt === "number" && Number.isFinite(parsed.iconUpdatedAt) && parsed.iconUpdatedAt > 0
        ? Math.round(parsed.iconUpdatedAt)
        : null;
    return {
      siteName: siteName || DEFAULT_SETTINGS.siteName,
      secrets: [...new Set(secrets)].sort(),
      homepageUrl,
      iconUpdatedAt,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function iconPublicUrl(updatedAt: number | null): string | null {
  return updatedAt ? `/icon?v=${updatedAt}` : null;
}

export async function loadSettings(env: Env): Promise<InstanceSettings> {
  try {
    const db = drizzle(env.DB, { schema });
    const rows = await db.select().from(schema.siteSettings).where(eq(schema.siteSettings.key, "settings"));
    if (rows[0]) return parseSettings(rows[0].valueJson);
  } catch {
    /* schema may not exist yet */
  }
  return { ...DEFAULT_SETTINGS };
}

export async function saveSettings(env: Env, next: InstanceSettings): Promise<InstanceSettings> {
  const settings = parseSettings(JSON.stringify(next));
  const db = drizzle(env.DB, { schema });
  await db
    .insert(schema.siteSettings)
    .values({ key: "settings", valueJson: JSON.stringify(settings) })
    .onConflictDoUpdate({ target: schema.siteSettings.key, set: { valueJson: JSON.stringify(settings) } });
  return settings;
}

export async function rememberSecretNames(env: Env, names: string[]): Promise<void> {
  const valid = names.filter((n) => /^[A-Z][A-Z0-9_]{0,127}$/.test(n));
  if (!valid.length) return;
  const current = await loadSettings(env);
  await saveSettings(env, { ...current, secrets: [...new Set([...current.secrets, ...valid])].sort() });
}

type StoredIcon = { mime: string; b64: string; updatedAt: number };

export async function loadIcon(env: Env): Promise<{ mime: string; bytes: Uint8Array; updatedAt: number } | null> {
  try {
    const db = drizzle(env.DB, { schema });
    const rows = await db.select().from(schema.siteSettings).where(eq(schema.siteSettings.key, ICON_KEY));
    if (!rows[0]) return null;
    const parsed = JSON.parse(rows[0].valueJson) as Partial<StoredIcon>;
    if (typeof parsed.b64 !== "string" || typeof parsed.mime !== "string") return null;
    const bytes = fromBase64(parsed.b64);
    if (!sniffIconMime(bytes)) return null;
    return { mime: parsed.mime, bytes, updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0 };
  } catch {
    return null;
  }
}

export async function saveIcon(env: Env, bytes: Uint8Array): Promise<InstanceSettings> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ICON_BYTES) throw new Error("icon");
  const mime = sniffIconMime(bytes);
  if (!mime) throw new Error("icon");
  const updatedAt = Date.now();
  const db = drizzle(env.DB, { schema });
  await db
    .insert(schema.siteSettings)
    .values({ key: ICON_KEY, valueJson: JSON.stringify({ mime, b64: toBase64(bytes), updatedAt } satisfies StoredIcon) })
    .onConflictDoUpdate({
      target: schema.siteSettings.key,
      set: { valueJson: JSON.stringify({ mime, b64: toBase64(bytes), updatedAt } satisfies StoredIcon) },
    });
  const current = await loadSettings(env);
  return saveSettings(env, { ...current, iconUpdatedAt: updatedAt });
}

export async function deleteIcon(env: Env): Promise<InstanceSettings> {
  const db = drizzle(env.DB, { schema });
  await db.delete(schema.siteSettings).where(eq(schema.siteSettings.key, ICON_KEY));
  const current = await loadSettings(env);
  return saveSettings(env, { ...current, iconUpdatedAt: null });
}

export async function isStale(env: Env, now = Date.now()): Promise<{ stale: boolean; lastTick: number | null }> {
  try {
    const db = drizzle(env.DB, { schema });
    const rows = await db.select().from(schema.meta).where(eq(schema.meta.key, "last_tick"));
    const lastTick = rows[0] ? Number(rows[0].value) : null;
    return { lastTick, stale: lastTick == null || now - lastTick > 3 * 60_000 };
  } catch {
    return { lastTick: null, stale: true };
  }
}

export async function buildPublicSnapshot(env: Env): Promise<PublicSnapshot> {
  const db = drizzle(env.DB, { schema });
  const settings = await loadSettings(env);
  const failWhen: FailWhen = "majority";
  const siteName = settings.siteName;
  const { stale, lastTick } = await isStale(env);
  const monitors = await db.select().from(schema.monitors);
  const states = await db.select().from(schema.componentState);
  const stateBy = new Map(states.map((s) => [s.componentId, s.status as ComponentStatus]));
  const now = Date.now();
  let windows: Array<{ componentId: string; startAt: number; endAt: number }> = [];
  try {
    windows = await db.select({
      componentId: schema.maintenance.componentId,
      startAt: schema.maintenance.startAt,
      endAt: schema.maintenance.endAt,
    }).from(schema.maintenance);
  } catch {
    windows = [];
  }
  const activeMaintenance = new Set(windows.filter((w) => w.startAt <= now && now < w.endAt).map((w) => w.componentId));
  const latest = await db.select().from(schema.checkLatest);
  const dates = daysBack(90);
  const uptime = await db.select().from(schema.dailyUptime).where(gte(schema.dailyUptime.date, dates[0]!));
  const incidentsOpen = await db
    .select()
    .from(schema.incidents)
    .orderBy(desc(schema.incidents.createdAt))
    .limit(50);
  const incidentIds = incidentsOpen.map((i) => i.id);
  const updates =
    incidentIds.length === 0
      ? []
      : await db.select().from(schema.incidentUpdates).where(inArray(schema.incidentUpdates.incidentId, incidentIds));

  const incidentDays = new Set(
    incidentsOpen.map((i) => utcDate(i.createdAt)),
  );

  const groupsMap = new Map<
    string,
    { id: string; name: string; components: Map<string, typeof monitors> }
  >();
  for (const m of monitors) {
    let g = groupsMap.get(m.groupId);
    if (!g) {
      g = { id: m.groupId, name: m.groupName, components: new Map() };
      groupsMap.set(m.groupId, g);
    }
    const list = g.components.get(m.componentId) ?? [];
    list.push(m);
    g.components.set(m.componentId, list);
  }

  const componentsForBanner: Array<{ status: ComponentStatus; critical: boolean }> = [];
  const groups = [...groupsMap.values()].map((g) => {
    const components = [...g.components.entries()].map(([cid, mons]) => {
      const runs = latest
        .filter((r) => mons.some((m) => m.id === r.monitorId))
        .map((r) => ({ region: r.region, outcome: r.outcome as "pass" | "degraded" | "fail" }));
      const critical = mons.some((m) => m.critical === 1);
      const inMaintenance = activeMaintenance.has(cid);
      const computed = componentStatus(runs, failWhen, inMaintenance);
      const stored = stateBy.get(cid);
      const status = inMaintenance ? computed : (stored ?? computed);
      componentsForBanner.push({ status, critical });
      const rows = uptime.filter((u) => u.componentId === cid);
      const byDate = new Map(rows.map((u) => [u.date, u]));
      const days = dates.map((date) => {
        const u = byDate.get(date);
        const uptimePct = u && u.total > 0 ? u.ok / u.total : null;
        const latencyCount = u?.latencyCount ?? 0;
        const latencySum = u?.latencySum ?? 0;
        const latencyMs = latencyCount > 0 ? Math.round(latencySum / latencyCount) : null;
        const checks = u && u.total > 0 ? u.total : null;
        return {
          date,
          uptime: uptimePct,
          incident: incidentDays.has(date),
          checks,
          latencyMs,
          latencyMinMs: u?.latencyMin ?? null,
          latencyMaxMs: u?.latencyMax ?? null,
        };
      });
      const tot = rows.reduce((a, u) => a + u.total, 0);
      const ok = rows.reduce((a, u) => a + u.ok, 0);
      return {
        id: cid,
        name: mons[0]!.componentName,
        groupId: g.id,
        groupName: g.name,
        status,
        uptime90: tot ? ok / tot : null,
        days,
      };
    });
    const tot = components.reduce((a, c) => a + (c.uptime90 == null ? 0 : 1), 0);
    const sum = components.reduce((a, c) => a + (c.uptime90 ?? 0), 0);
    return {
      id: g.id,
      name: g.name,
      uptime90: tot ? sum / tot : null,
      components,
    };
  });

  const banner: BannerStatus = bannerStatus(componentsForBanner);
  const incidents = incidentsOpen.map((i) => ({
    id: i.id,
    title: sanitizeText(i.title, 200),
    status: i.status,
    impact: i.impact,
    startedAt: i.createdAt,
    resolvedAt: i.resolvedAt,
    updates: updates
      .filter((u) => u.incidentId === i.id)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((u) => ({ status: u.status, body: sanitizeText(u.body, 2000), at: u.createdAt })),
  }));

  return publicSnapshot({
    siteName,
    homepageUrl: settings.homepageUrl,
    iconUrl: iconPublicUrl(settings.iconUpdatedAt),
    banner,
    stale,
    lastTick,
    generatedAt: now,
    groups,
    incidents,
  });
}

export async function publishSnapshot(env: Env): Promise<PublicSnapshot> {
  const snap = await buildPublicSnapshot(env);
  await env.STATUS.put("snapshot:public", JSON.stringify(snap), { expirationTtl: 60 });
  try {
    await statusHubStub(env).push(renderLivePayload(snap));
  } catch {
    /* live fan-out is best-effort; the HTML page still works */
  }
  return snap;
}

export async function readSnapshot(env: Env): Promise<PublicSnapshot> {
  const cached = await env.STATUS.get("snapshot:public");
  if (cached) return JSON.parse(cached) as PublicSnapshot;
  return publishSnapshot(env);
}

function latencySamples(ms: number[]): number[] {
  return ms.filter((n) => Number.isFinite(n) && n > 0).map((n) => Math.round(n));
}

export async function bumpUptime(
  env: Env,
  componentId: string,
  ok: boolean,
  latencies: number[] = [],
  now = Date.now(),
): Promise<void> {
  const date = utcDate(now);
  const samples = latencySamples(latencies);
  const addSum = samples.reduce((a, b) => a + b, 0);
  const addCount = samples.length;
  const addMin = addCount ? Math.min(...samples) : null;
  const addMax = addCount ? Math.max(...samples) : null;
  const db = drizzle(env.DB, { schema });
  const existing = (
    await db
      .select()
      .from(schema.dailyUptime)
      .where(and(eq(schema.dailyUptime.componentId, componentId), eq(schema.dailyUptime.date, date)))
  )[0];
  if (!existing) {
    await db.insert(schema.dailyUptime).values({
      componentId,
      date,
      ok: ok ? 1 : 0,
      total: 1,
      latencySum: addSum,
      latencyCount: addCount,
      latencyMin: addMin,
      latencyMax: addMax,
    });
    return;
  }
  const nextMin =
    addMin == null ? existing.latencyMin : existing.latencyMin == null ? addMin : Math.min(existing.latencyMin, addMin);
  const nextMax =
    addMax == null ? existing.latencyMax : existing.latencyMax == null ? addMax : Math.max(existing.latencyMax, addMax);
  await db
    .update(schema.dailyUptime)
    .set({
      ok: existing.ok + (ok ? 1 : 0),
      total: existing.total + 1,
      latencySum: (existing.latencySum ?? 0) + addSum,
      latencyCount: (existing.latencyCount ?? 0) + addCount,
      latencyMin: nextMin,
      latencyMax: nextMax,
    })
    .where(and(eq(schema.dailyUptime.componentId, componentId), eq(schema.dailyUptime.date, date)));
}

export async function writeLastTick(env: Env, now = Date.now()): Promise<void> {
  const db = drizzle(env.DB, { schema });
  await db
    .insert(schema.meta)
    .values({ key: "last_tick", value: String(now) })
    .onConflictDoUpdate({ target: schema.meta.key, set: { value: String(now) } });
}
