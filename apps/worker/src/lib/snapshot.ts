import { drizzle } from "drizzle-orm/d1";
import { desc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import type { BannerStatus, Check, ComponentStatus } from "@foxwatch/config";
import {
  bannerStatus,
  publicSnapshot,
  sanitizeText,
  parseHomepageUrl,
  regionImpact,
  type PublicSnapshot,
  type RegionImpact,
  type RegionRunDetail,
} from "@foxwatch/engine";
import type { Env } from "../env.ts";
import * as schema from "../db/schema.ts";
import { renderLivePayload } from "./public-html.ts";
import { statusHubStub } from "../do/hub.ts";
import { sniffIconMime } from "./crypto.ts";

function utcDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function incidentComponentIds(incident: { componentId: string | null; componentIdsJson: string | null }): string[] {
  try {
    const parsed = JSON.parse(incident.componentIdsJson ?? "null") as unknown;
    if (Array.isArray(parsed)) return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    /* legacy incident; fall through to the original single component */
  }
  return incident.componentId ? [incident.componentId] : [];
}

function overlapDuration(
  intervals: Array<{ start: number; end: number }>,
  rangeStart: number,
  rangeEnd: number,
): number {
  const clipped = intervals
    .map(({ start, end }) => ({ start: Math.max(start, rangeStart), end: Math.min(end, rangeEnd) }))
    .filter(({ start, end }) => end > start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let currentStart = 0;
  let currentEnd = 0;
  for (const interval of clipped) {
    if (currentEnd === 0 || interval.start > currentEnd) {
      if (currentEnd > currentStart) total += currentEnd - currentStart;
      currentStart = interval.start;
      currentEnd = interval.end;
    } else {
      currentEnd = Math.max(currentEnd, interval.end);
    }
  }
  if (currentEnd > currentStart) total += currentEnd - currentStart;
  return total;
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
    const monitors = await db.select().from(schema.monitors);
    const latest = await db.select().from(schema.checkLatest);
    const windows = await db.select().from(schema.maintenance);
    const active = monitors.filter((m) => {
      if (m.mutedUntil && m.mutedUntil > now) return false;
      return !windows.some((w) => w.componentId === m.componentId && w.startAt <= now && now < w.endAt);
    });
    if (active.length === 0) return { lastTick: null, stale: false };
    const lastTick = latest.reduce<number | null>((max, row) => max == null || row.checkedAt > max ? row.checkedAt : max, null);
    const stale = active.some((monitor) => {
      const check = JSON.parse(monitor.configJson) as Check;
      const expected = monitorExpectedRegions(check);
      const freshAfter = now - monitorFreshnessMs(check);
      const seen = new Set(
        latest
          .filter((row) => row.monitorId === monitor.id && row.checkedAt >= freshAfter)
          .map((row) => row.region),
      );
      return expected.some((region) => !seen.has(region));
    });
    return { lastTick, stale };
  } catch {
    return { lastTick: null, stale: true };
  }
}

export function monitorFreshnessMs(check: Check): number {
  const attemptBudget = check.type === "http" ? check.timeoutMs * (Math.max(0, check.retries) + 1) : check.graceMs;
  return Math.max(check.intervalMs * 2.5, check.intervalMs + attemptBudget + 30_000);
}

function monitorExpectedRegions(check: Check): string[] {
  return check.type === "heartbeat" ? ["global"] : check.regions;
}

function impactForMonitors(
  monitors: Array<typeof schema.monitors.$inferSelect>,
  latest: Array<typeof schema.checkLatest.$inferSelect>,
  now: number,
): RegionImpact | undefined {
  const expected: string[] = [];
  const seen = new Set<string>();
  const runs: RegionRunDetail[] = [];
  for (const monitor of monitors) {
    if (monitor.mutedUntil && monitor.mutedUntil > now) continue;
    let check: Check;
    try {
      check = JSON.parse(monitor.configJson) as Check;
    } catch {
      continue;
    }
    for (const region of monitorExpectedRegions(check)) {
      if (seen.has(region)) continue;
      seen.add(region);
      expected.push(region);
    }
    const freshAfter = now - monitorFreshnessMs(check);
    for (const row of latest) {
      if (row.monitorId !== monitor.id || row.checkedAt < freshAfter) continue;
      runs.push({
        region: row.region,
        outcome: row.outcome,
        latencyMs: row.latencyMs,
        errorClass: row.errorClass,
        statusCode: row.statusCode,
      });
    }
  }
  return regionImpact(expected, runs) ?? undefined;
}

function monitorPublicStatus(
  monitor: typeof schema.monitors.$inferSelect,
  latest: Array<typeof schema.checkLatest.$inferSelect>,
  now: number,
): ComponentStatus {
  if (monitor.mutedUntil && monitor.mutedUntil > now) return "unknown";
  let check: Check;
  try {
    check = JSON.parse(monitor.configJson) as Check;
  } catch {
    return "unknown";
  }
  const expected = monitorExpectedRegions(check);
  const freshAfter = now - monitorFreshnessMs(check);
  const seen = new Set(
    latest.filter((row) => row.monitorId === monitor.id && row.checkedAt >= freshAfter).map((row) => row.region),
  );
  if (expected.length === 0 || expected.some((region) => !seen.has(region))) return "unknown";
  if (monitor.confirmedOutcome === "fail") return "failing";
  if (monitor.confirmedOutcome === "degraded") return "degraded";
  if (monitor.confirmedOutcome === "pass") return "operational";
  return "unknown";
}

function combinedMonitorStatus(statuses: ComponentStatus[]): ComponentStatus {
  if (statuses.some((status) => status === "failing")) return "failing";
  if (statuses.some((status) => status === "degraded")) return "degraded";
  if (statuses.length === 0 || statuses.some((status) => status === "unknown")) return "unknown";
  return "operational";
}

export async function buildPublicSnapshot(env: Env): Promise<PublicSnapshot> {
  const db = drizzle(env.DB, { schema });
  const settings = await loadSettings(env);
  const siteName = settings.siteName;
  const { stale, lastTick } = await isStale(env);
  const monitors = await db.select().from(schema.monitors);
  const now = Date.now();
  let windows: Array<{ id: string; componentId: string; startAt: number; endAt: number; note: string }> = [];
  try {
    windows = await db.select({
      id: schema.maintenance.id,
      componentId: schema.maintenance.componentId,
      startAt: schema.maintenance.startAt,
      endAt: schema.maintenance.endAt,
      note: schema.maintenance.note,
    }).from(schema.maintenance);
  } catch {
    windows = [];
  }
  const activeMaintenance = new Set(windows.filter((w) => w.startAt <= now && now < w.endAt).map((w) => w.componentId));
  const latest = await db.select().from(schema.checkLatest);
  const dates = daysBack(90);
  const uptime = await db.select().from(schema.dailyUptime).where(gte(schema.dailyUptime.date, dates[0]!));
  const historyStart = Date.parse(`${dates[0]}T00:00:00.000Z`);
  const incidentsAll = await db
    .select()
    .from(schema.incidents)
    .where(or(gte(schema.incidents.createdAt, historyStart), gte(schema.incidents.resolvedAt, historyStart), isNull(schema.incidents.resolvedAt)))
    .orderBy(desc(schema.incidents.createdAt))
    .limit(1000);
  const incidentsForDisplay = incidentsAll.slice(0, 50);
  const incidentIds = incidentsForDisplay.map((i) => i.id);
  const updates =
    incidentIds.length === 0
      ? []
      : await db.select().from(schema.incidentUpdates).where(inArray(schema.incidentUpdates.incidentId, incidentIds));

  const allComponentIds = new Set(monitors.map((monitor) => monitor.componentId));
  const incidentScopes = incidentsAll.map((incident) => {
    const explicit = incidentComponentIds(incident);
    return {
      incident,
      componentIds: explicit.length ? explicit : [...allComponentIds],
    };
  });

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
      const activeMons = mons.filter((monitor) => !monitor.mutedUntil || monitor.mutedUntil <= now);
      const critical = activeMons.some((m) => m.critical === 1);
      const inMaintenance = activeMaintenance.has(cid);
      const openIncidents = incidentScopes
        .filter(({ incident, componentIds }) => !incident.resolvedAt && componentIds.includes(cid))
        .map(({ incident }) => incident);
      const incidentImpact = openIncidents.some((incident) => incident.impact === "failing")
        ? "failing"
        : openIncidents.some((incident) => incident.impact === "degraded")
          ? "degraded"
          : null;
      const monitorStatus = combinedMonitorStatus(activeMons.map((monitor) => monitorPublicStatus(monitor, latest, now)));
      const status: ComponentStatus = incidentImpact === "failing"
        ? "failing"
        : incidentImpact === "degraded"
          ? "degraded"
          : inMaintenance
            ? "maintenance"
            : monitorStatus;
      componentsForBanner.push({
        status,
        critical: critical || openIncidents.some((incident) => incident.auto === 0 && incident.impact === "failing"),
      });
      const rows = uptime.filter((u) => u.componentId === cid);
      const byDate = new Map(rows.map((u) => [u.date, u]));
      const days = dates.map((date) => {
        const u = byDate.get(date);
        const dayStart = Date.parse(`${date}T00:00:00.000Z`);
        const dayEnd = Math.min(dayStart + 86_400_000, now);
        const affectingIncidents = incidentScopes
          .filter(({ componentIds }) => componentIds.includes(cid))
          .map(({ incident }) => incident);
        const outages = affectingIncidents
          .filter((incident) => incident.impact === "failing")
          .map((incident) => ({ start: incident.createdAt, end: incident.resolvedAt ?? now }));
        const downtimeMs = overlapDuration(outages, dayStart, dayEnd);
        const overlapsDay = (incident: typeof incidentsAll[number]) =>
          incident.createdAt < dayEnd && (incident.resolvedAt ?? now) > dayStart;
        const incidentImpact: "failing" | "degraded" | null = affectingIncidents.some((incident) => overlapsDay(incident) && incident.impact === "failing")
          ? "failing"
          : affectingIncidents.some((incident) => overlapsDay(incident) && incident.impact === "degraded")
            ? "degraded"
            : null;
        const hasData = Boolean(u && u.total > 0) || incidentImpact != null;
        const observedMs = Math.max(0, dayEnd - dayStart);
        const uptimePct = hasData && observedMs > 0 ? Math.max(0, 1 - downtimeMs / observedMs) : null;
        const latencyCount = u?.latencyCount ?? 0;
        const latencySum = u?.latencySum ?? 0;
        const latencyMs = latencyCount > 0 ? Math.round(latencySum / latencyCount) : null;
        const checks = u && u.total > 0 ? u.total : null;
        return {
          date,
          uptime: uptimePct,
          incident: incidentImpact != null,
          incidentImpact,
          checks,
          latencyMs,
          latencyMinMs: u?.latencyMin ?? null,
          latencyMaxMs: u?.latencyMax ?? null,
        };
      });
      let observed = 0;
      let available = 0;
      for (const day of days) {
        if (day.uptime == null) continue;
        const start = Date.parse(`${day.date}T00:00:00.000Z`);
        const duration = Math.max(0, Math.min(start + 86_400_000, now) - start);
        observed += duration;
        available += duration * day.uptime;
      }
      return {
        id: cid,
        name: mons[0]!.componentName,
        groupId: g.id,
        groupName: g.name,
        status,
        uptime90: observed ? available / observed : null,
        days,
        impact: status === "degraded" || status === "failing" ? impactForMonitors(activeMons, latest, now) : undefined,
      };
    });
    const groupComponentIds = new Set(components.map((component) => component.id));
    const groupIncidents = incidentScopes
      .filter(({ componentIds }) => componentIds.some((componentId) => groupComponentIds.has(componentId)))
      .map(({ incident }) => incident);
    const groupDays = dates.map((date, index) => {
      const slices = components.map((component) => component.days[index]).filter((day): day is NonNullable<typeof day> => Boolean(day));
      const dayStart = Date.parse(`${date}T00:00:00.000Z`);
      const dayEnd = Math.min(dayStart + 86_400_000, now);
      const overlapsDay = (incident: typeof incidentsAll[number]) =>
        incident.createdAt < dayEnd && (incident.resolvedAt ?? now) > dayStart;
      const incidentImpact: "failing" | "degraded" | null = groupIncidents.some(
        (incident) => overlapsDay(incident) && incident.impact === "failing",
      )
        ? "failing"
        : groupIncidents.some((incident) => overlapsDay(incident) && incident.impact === "degraded")
          ? "degraded"
          : null;
      const outages = groupIncidents
        .filter((incident) => incident.impact === "failing")
        .map((incident) => ({ start: incident.createdAt, end: incident.resolvedAt ?? now }));
      const observedMs = Math.max(0, dayEnd - dayStart);
      const hasData = slices.some((day) => day.uptime != null) || incidentImpact != null;
      const uptimePct = hasData && observedMs > 0
        ? Math.max(0, 1 - overlapDuration(outages, dayStart, dayEnd) / observedMs)
        : null;
      const withLatency = slices.filter((day) => day.latencyMs != null && day.latencyMs > 0);
      const weight = (day: typeof slices[number]) => day.checks && day.checks > 0 ? day.checks : 1;
      const weightSum = withLatency.reduce((total, day) => total + weight(day), 0);
      const checks = slices.reduce((total, day) => total + (day.checks ?? 0), 0);
      const latencyMins = slices.map((day) => day.latencyMinMs).filter((value): value is number => value != null);
      const latencyMaxes = slices.map((day) => day.latencyMaxMs).filter((value): value is number => value != null);
      return {
        date,
        uptime: uptimePct,
        incident: incidentImpact != null,
        incidentImpact,
        checks: checks || null,
        latencyMs: withLatency.length
          ? Math.round(withLatency.reduce((total, day) => total + (day.latencyMs ?? 0) * weight(day), 0) / weightSum)
          : null,
        latencyMinMs: latencyMins.length ? Math.min(...latencyMins) : null,
        latencyMaxMs: latencyMaxes.length ? Math.max(...latencyMaxes) : null,
      };
    });
    let groupObserved = 0;
    let groupAvailable = 0;
    for (const day of groupDays) {
      if (day.uptime == null) continue;
      const start = Date.parse(`${day.date}T00:00:00.000Z`);
      const duration = Math.max(0, Math.min(start + 86_400_000, now) - start);
      groupObserved += duration;
      groupAvailable += duration * day.uptime;
    }
    return {
      id: g.id,
      name: g.name,
      uptime90: groupObserved ? groupAvailable / groupObserved : null,
      days: groupDays,
      impact: components.some((component) => component.status === "degraded" || component.status === "failing")
        ? impactForMonitors(
            [...g.components.values()].flat().filter((monitor) => !monitor.mutedUntil || monitor.mutedUntil <= now),
            latest,
            now,
          )
        : undefined,
      components,
    };
  });

  const globalOpenImpact = incidentsAll
    .filter((incident) => !incident.resolvedAt && incidentComponentIds(incident).length === 0)
    .some((incident) => incident.impact === "failing")
    ? "failing"
    : incidentsAll.some((incident) => !incident.resolvedAt && incidentComponentIds(incident).length === 0 && incident.impact === "degraded")
      ? "degraded"
      : null;
  const banner: BannerStatus = globalOpenImpact === "failing"
    ? "failing"
    : globalOpenImpact === "degraded"
      ? "degraded"
      : bannerStatus(componentsForBanner);
  const componentNames = new Map(monitors.map((monitor) => [monitor.componentId, monitor.componentName]));
  const incidents = incidentsForDisplay.map((i) => ({
    id: i.id,
    componentIds: incidentScopes.find(({ incident }) => incident.id === i.id)?.componentIds ?? [],
    componentNames: (incidentScopes.find(({ incident }) => incident.id === i.id)?.componentIds ?? [])
      .map((componentId) => componentNames.get(componentId) ?? componentId),
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
  const publicMaintenance = windows
    .filter((window) => window.endAt > now)
    .sort((a, b) => a.startAt - b.startAt)
    .map((window) => ({
      ...window,
      componentName: componentNames.get(window.componentId) ?? window.componentId,
      note: sanitizeText(window.note, 500),
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
    maintenance: publicMaintenance,
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
  if (cached) {
    const parsed = JSON.parse(cached) as PublicSnapshot;
    return publicSnapshot({
      ...parsed,
      maintenance: parsed.maintenance ?? [],
      incidents: parsed.incidents.map((incident) => ({ ...incident, componentIds: incident.componentIds ?? [] })),
    });
  }
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
  await env.DB.prepare(`INSERT INTO daily_uptime
    (component_id, date, ok, total, latency_sum, latency_count, latency_min, latency_max)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(component_id, date) DO UPDATE SET
      ok = ok + excluded.ok,
      total = total + 1,
      latency_sum = latency_sum + excluded.latency_sum,
      latency_count = latency_count + excluded.latency_count,
      latency_min = CASE
        WHEN excluded.latency_min IS NULL THEN latency_min
        WHEN latency_min IS NULL THEN excluded.latency_min
        ELSE MIN(latency_min, excluded.latency_min)
      END,
      latency_max = CASE
        WHEN excluded.latency_max IS NULL THEN latency_max
        WHEN latency_max IS NULL THEN excluded.latency_max
        ELSE MAX(latency_max, excluded.latency_max)
      END`)
    .bind(componentId, date, ok ? 1 : 0, addSum, addCount, addMin, addMax)
    .run();
}

export async function writeLastTick(env: Env, now = Date.now()): Promise<void> {
  const db = drizzle(env.DB, { schema });
  await db
    .insert(schema.meta)
    .values({ key: "last_tick", value: String(now) })
    .onConflictDoUpdate({ target: schema.meta.key, set: { value: String(now) } });
}
