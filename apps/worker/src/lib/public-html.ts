import type { ComponentStatus } from "@foxwatch/config";
import type { PublicComponent, PublicSnapshot, RegionImpact } from "@foxwatch/engine";
import {
  escapeHtml,
  impactAriaLabel,
  impactTitle,
  impactTone,
  statusDotColor,
  meshArcs,
  meshCaption,
  meshProjAttr,
  observerKind,
  observerReadout,
  projectPct,
  ringRem,
  landPaths,
  landRings,
  graticuleLines,
  REGION_COORDS,
} from "@foxwatch/engine";
import { GLOBE_CLIENT_SCRIPT } from "./public-globe.ts";

export const GLOBE_MODULE_SRC = import.meta.env.DEV
  ? "/apps/web/src/status-globe/main.ts"
  : "/assets/globe.js";

type PublicDay = PublicComponent["days"][number];
type PublicIncident = PublicSnapshot["incidents"][number];

const LABELS: Record<PublicSnapshot["banner"], string> = {
  unknown: "Monitoring is initializing.",
  fully_operational: "We're fully operational.",
  degraded: "We're experiencing degraded performance.",
  failing: "We're experiencing an outage.",
};

const BODY: Record<PublicSnapshot["banner"], string> = {
  unknown: "We do not have enough fresh monitoring data to report current availability yet.",
  fully_operational: "We're not aware of any issues affecting our systems.",
  degraded: "Some systems are impacted. We're investigating and will post updates here.",
  failing: "Some systems are currently unavailable. We're working to restore service.",
};

const INCIDENT_STATUS: Record<string, string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
};

const IMPACT: Record<string, string> = {
  degraded: "Degraded",
  failing: "Outage",
};

function pct(n: number | null): string {
  if (n == null) return "-";
  return `${(n * 100).toFixed(2)}%`;
}

function parseUtc(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

function formatMonthYear(iso: string): string {
  return parseUtc(iso).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function dateRange(days: PublicDay[]): string | null {
  const first = days[0]?.date;
  const last = days[days.length - 1]?.date;
  if (!first || !last) return null;
  const a = formatMonthYear(first);
  const b = formatMonthYear(last);
  return a === b ? a : `${a} – ${b}`;
}

function dayKind(uptime: number | null, incident: boolean, incidentImpact?: "degraded" | "failing" | null): "ok" | "warn" | "bad" | "empty" {
  if (incidentImpact === "failing" || (incident && !incidentImpact) || (uptime != null && uptime < 0.95)) return "bad";
  if (incidentImpact === "degraded") return "warn";
  if (uptime == null) return "empty";
  if (uptime >= 0.999) return "ok";
  return "warn";
}

const DAY_CAPTIONS: Record<ReturnType<typeof dayKind>, string> = {
  ok: "No incidents",
  warn: "Degraded performance",
  bad: "Outage",
  empty: "No data",
};

function groupStatus(components: PublicComponent[]): ComponentStatus {
  if (components.some((c) => c.status === "failing")) return "failing";
  if (components.some((c) => c.status === "degraded")) return "degraded";
  if (components.some((c) => c.status === "maintenance")) return "maintenance";
  if (components.length === 0 || components.some((c) => c.status === "unknown")) return "unknown";
  return "operational";
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function affectedGroupNames(snap: PublicSnapshot): string[] {
  return snap.groups
    .filter((group) => {
      const status = groupStatus(group.components);
      return status === "degraded" || status === "failing";
    })
    .map((group) => group.name);
}

function bannerBody(snap: PublicSnapshot): string {
  if (snap.banner !== "degraded" && snap.banner !== "failing") return BODY[snap.banner];
  const names = affectedGroupNames(snap);
  if (!names.length) return BODY[snap.banner];
  const verb = snap.banner === "failing" ? "unavailable" : "impacted";
  return `${joinNames(names)} ${names.length === 1 ? "is" : "are"} ${verb}.`;
}

function mergeDays(components: PublicComponent[]): PublicDay[] {
  const first = components[0]?.days ?? [];
  return first.map((d, i) => {
    const slices = components.map((c) => c.days[i]).filter((s): s is PublicDay => Boolean(s));
    const uptimes = slices.map((s) => s.uptime).filter((u): u is number => u != null);
    const withLat = slices.filter((s) => s.latencyMs != null && s.latencyMs > 0);
    const weight = (s: PublicDay) => (s.checks && s.checks > 0 ? s.checks : 1);
    const weightSum = withLat.reduce((a, s) => a + weight(s), 0);
    const mins = slices.map((s) => s.latencyMinMs).filter((n): n is number => n != null);
    const maxs = slices.map((s) => s.latencyMaxMs).filter((n): n is number => n != null);
    const checks = slices.reduce((a, s) => a + (s.checks ?? 0), 0);
    return {
      date: d.date,
      uptime: uptimes.length ? Math.min(...uptimes) : null,
      incident: slices.some((s) => s.incident),
      incidentImpact: slices.some((s) => s.incidentImpact === "failing") ? "failing" : slices.some((s) => s.incidentImpact === "degraded") ? "degraded" : null,
      checks: checks || null,
      latencyMs: withLat.length
        ? Math.round(withLat.reduce((a, s) => a + (s.latencyMs ?? 0) * weight(s), 0) / weightSum)
        : null,
      latencyMinMs: mins.length ? Math.min(...mins) : null,
      latencyMaxMs: maxs.length ? Math.max(...maxs) : null,
    };
  });
}

function incidentStatusLabel(status: string): string {
  return INCIDENT_STATUS[status] ?? status;
}

function impactLabel(impact: string): string {
  return IMPACT[impact] ?? impact;
}

function timelineClass(status: string): string {
  if (status === "resolved") return "ok";
  if (status === "monitoring") return "ink";
  return "warn";
}

function pageIcon(snap: PublicSnapshot): string {
  return snap.iconUrl || "/fox.png";
}

const FOX_MARK = `<img class="fox" src="/fox.png" alt="" width="24" height="24"/>`;
const FOOT_FOX = `<img class="foot-fox" src="/fox.png" alt="" width="16" height="16"/>`;

function fnv1a(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/**
 * Stamps a live block with a hash of its own markup. The browser compares the
 * stamp on the element it has with the one in an update and leaves the block
 * alone when they match, so focus, selection and open tooltips survive.
 */
function withRev(html: string): string {
  return html.replace(/^<[a-z]+/, (tag) => `${tag} data-rev="${fnv1a(html)}"`);
}

export function blockRev(html: string): string {
  return /^<[a-z]+ data-rev="([0-9a-f]+)"/.exec(html)?.[1] ?? "";
}

export function renderBrand(snap: PublicSnapshot): string {
  const href = snap.homepageUrl || "/";
  const mark = snap.iconUrl
    ? `<img class="site-icon" src="${escapeHtml(snap.iconUrl)}" alt="" width="24" height="24"/>`
    : FOX_MARK;
  return `<a class="brand" href="${escapeHtml(href)}">${mark}<span class="brand-name">${escapeHtml(snap.siteName)}</span></a>`;
}

export function renderBrandBlock(snap: PublicSnapshot): string {
  return withRev(`<div id="live-brand">${renderBrand(snap)}</div>`);
}

function utcDayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function formatDayHeading(iso: string): string {
  return parseUtc(iso).toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function mark(status: ComponentStatus | "ok" | "warn" | "bad" | "empty"): string {
  if (status === "maintenance") {
    return `<svg class="mark warn" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10"/><path d="M12.4 5.6a2.3 2.3 0 0 1 2.2 3.7L8.8 14.9H6.1v-2.6l5.7-5.8a2.3 2.3 0 0 1 .6-.9zM7.4 13.2l4.6-4.6" fill="none" stroke="var(--on-accent)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  const kind =
    status === "operational" || status === "ok"
      ? "ok"
      : status === "failing" || status === "bad"
        ? "bad"
        : status === "empty" || status === "unknown"
          ? "empty"
          : "warn";
  if (kind === "ok") {
    return `<svg class="mark ok" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10"/><path d="M6 10.4 8.6 13 14.2 7.4" fill="none" stroke="var(--on-accent)" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  if (kind === "bad") {
    return `<svg class="mark bad" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10"/><path d="M7 7l6 6M13 7l-6 6" fill="none" stroke="var(--on-accent)" stroke-width="1.85" stroke-linecap="round"/></svg>`;
  }
  if (kind === "empty") {
    return `<svg class="mark empty" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
  }
  return `<svg class="mark warn" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10"/><path d="M10 6v5.2M10 14.2h.01" fill="none" stroke="var(--on-accent)" stroke-width="1.85" stroke-linecap="round"/></svg>`;
}

const TICK_EMPTY = 22;
const TICK_MIN = 36;
const TICK_MAX = 100;

/** Map a day's latency onto bar height. Taller = slower; empty days stay shortest. */
export function tickHeightPct(
  latencyMs: number | null | undefined,
  maxLatency: number,
  hasData = false,
): number {
  if (latencyMs == null || latencyMs <= 0 || maxLatency <= 0) {
    return hasData ? TICK_MIN : TICK_EMPTY;
  }
  const t = Math.min(1, latencyMs / maxLatency);
  return Math.round(TICK_MIN + t * (TICK_MAX - TICK_MIN));
}

function nextUtcDay(iso: string): string {
  const d = parseUtc(iso);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** What a reader who cannot open the per-day tooltips still needs: how many days went wrong. */
function barSummary(days: PublicDay[]): string {
  let bad = 0;
  let warn = 0;
  for (const d of days) {
    const kind = dayKind(d.uptime, d.incident, d.incidentImpact);
    if (kind === "bad") bad++;
    else if (kind === "warn") warn++;
  }
  return `${bad ? `, ${plural(bad, "day")} with an outage` : ""}${warn ? `, ${plural(warn, "day")} degraded` : ""}`;
}

/**
 * One element per day and nothing inside it. The tooltip is built in the
 * browser from the data attributes (see DAY_TIP_SCRIPT), so a bar costs a few
 * kilobytes instead of a tooltip's worth of markup for each of its 90 days.
 * `data-l` is "avg,min,max" in ms. The date comes from the bar's `data-from`
 * and the day's position; a day carries its own `data-d` only when the run of
 * dates has a gap.
 */
function renderBar(days: PublicDay[], label: string, extraClass = ""): string {
  const maxLatency = days.reduce((m, d) => Math.max(m, d.latencyMs ?? 0), 0);
  const from = days[0]?.date;
  const gapless = days.every((d, i) => i === 0 || d.date === nextUtcDay(days[i - 1]!.date));
  const cells = days
    .map((d) => {
      const kind = dayKind(d.uptime, d.incident, d.incidentImpact);
      const hasData = d.uptime != null || d.incident;
      const h = tickHeightPct(d.latencyMs, maxLatency, hasData);
      const date = gapless ? "" : ` data-d="${escapeHtml(d.date)}"`;
      const checks = d.checks != null && d.checks > 0 ? ` data-c="${d.checks}"` : "";
      const avg = d.latencyMs != null && d.latencyMs > 0 ? d.latencyMs : null;
      const min = d.latencyMinMs != null && d.latencyMinMs > 0 ? d.latencyMinMs : avg;
      const max = d.latencyMaxMs != null && d.latencyMaxMs > 0 ? d.latencyMaxMs : avg;
      const latency = avg != null ? ` data-l="${avg},${min},${max}"` : "";
      return `<span class="day ${kind}" style="--h:${h}%"${date}${checks}${latency}></span>`;
    })
    .join("");
  const start = from ? ` data-from="${escapeHtml(from)}"` : "";
  return `<div class="bar${extraClass ? ` ${extraClass}` : ""}" role="img" aria-label="${escapeHtml(`${label}${barSummary(days)}`)}" tabindex="0"${start}>${cells}</div>`;
}

function maintLabel(status: ComponentStatus): string {
  return status === "maintenance" ? `<span class="maint-label">Under maintenance</span>` : "";
}

function renderImpact(impact: RegionImpact | undefined): string {
  if (!impact?.items.length) return "";
  const tone = impactTone(impact);
  const pills = impact.all
    ? `<li><span class="impact-pill ${tone}" title="${escapeHtml(impactTitle(impact))}">All</span></li>`
    : impact.items
        .map((item) => {
          const kind = item.outcome === "fail" ? "bad" : "warn";
          return `<li><span class="impact-pill ${kind}" data-region="${escapeHtml(item.region)}">${escapeHtml(item.label)} <span class="impact-detail">${escapeHtml(item.detail)}</span></span></li>`;
        })
        .join("");
  return `<ul class="impact" aria-label="${escapeHtml(impactAriaLabel(impact))}">${pills}</ul>`;
}

function renderService(group: PublicSnapshot["groups"][number]): string {
  const expandable = group.components.length > 1;
  const status = groupStatus(group.components);
  const days = group.days ?? mergeDays(group.components);
  const count = `${group.components.length} component${group.components.length === 1 ? "" : "s"}`;
  const nested = expandable
    ? `<div class="nested"><div class="nested-inner">${group.components
        .map(
          (c) => `<article class="component">
        <div class="svc-row">
          <div class="svc-label">
            ${mark(c.status)}
            <span class="name">${escapeHtml(c.name)}</span>
            ${renderImpact(c.impact)}
            ${maintLabel(c.status)}
          </div>
          <span class="uptime">${escapeHtml(pct(c.uptime90))}<span class="uptime-word"> uptime</span></span>
        </div>
        ${renderBar(c.days, `${c.name} 90-day history, ${pct(c.uptime90)} uptime`)}
      </article>`,
        )
        .join("")}</div></div>`
    : "";
  const chev = expandable
    ? `<svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    : "";
  const countEl = expandable ? `<span class="count">${escapeHtml(count)}</span>` : "";
  const label = `<div class="svc-label">${mark(status)}<span class="name">${escapeHtml(group.name)}</span>${renderImpact(group.impact)}${maintLabel(status)}${countEl}${chev}</div>`;
  const uptime = `<span class="uptime">${escapeHtml(pct(group.uptime90))}<span class="uptime-word"> uptime</span></span>`;
  const bar = renderBar(days, `${group.name} 90-day history, ${pct(group.uptime90)} uptime`, expandable ? "group-bar" : "");
  if (!expandable) {
    return `<div class="service" data-group="${escapeHtml(group.id)}"><div class="svc-row">${label}${uptime}</div>${bar}</div>`;
  }
  return `<div class="service" data-group="${escapeHtml(group.id)}">
    <details>
      <summary class="svc-row">${label}${uptime}</summary>
      ${nested}
    </details>
    ${bar}
  </div>`;
}

function renderTimeline(incident: PublicIncident): string {
  const items = incident.updates.length
    ? [...incident.updates].reverse()
    : [{ status: incident.status, body: "", at: incident.startedAt }];
  return `<ol class="timeline">${items
    .map(
      (u) =>
        `<li class="timeline-item ${timelineClass(u.status)}"><p class="update-meta">${escapeHtml(incidentStatusLabel(u.status))} · <time datetime="${new Date(u.at).toISOString()}">${escapeHtml(new Date(u.at).toUTCString())}</time></p>${u.body ? `<p class="update-body">${escapeHtml(u.body)}</p>` : ""}</li>`,
    )
    .join("")}</ol>`;
}

function incidentDuration(incident: PublicIncident): string {
  if (!incident.resolvedAt) return "";
  const ms = incident.resolvedAt - incident.startedAt;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function incidentPath(id: string): string {
  return `/incidents/${encodeURIComponent(id)}`;
}

function renderIncidentArticle(i: PublicIncident, opts: { linked?: boolean; heading?: boolean } = {}): string {
  const linked = opts.linked !== false;
  const heading = opts.heading !== false;
  const statusBadge = `<span class="badge badge-${escapeHtml(i.status)}">${escapeHtml(incidentStatusLabel(i.status))}</span>`;
  const impactBadge = `<span class="badge badge-${escapeHtml(i.impact)}">${escapeHtml(impactLabel(i.impact))}</span>`;
  const duration = i.resolvedAt ? `<p class="incident-duration">Duration: ${escapeHtml(incidentDuration(i))}</p>` : "";
  const components = i.componentNames?.length ? `<span class="badge badge-monitoring">${escapeHtml(i.componentNames.join(", "))}</span>` : "";
  const title = linked
    ? `<h3><a href="${escapeHtml(incidentPath(i.id))}">${escapeHtml(i.title)}</a></h3>`
    : `<h3>${escapeHtml(i.title)}</h3>`;
  const header = heading ? `<div class="incident-header">${title}</div>` : "";
  return `<article class="incident" id="incident-${escapeHtml(i.id)}">
    ${header}
    <div class="incident-badges">${statusBadge}${impactBadge}${components}</div>
    ${duration}
    ${renderTimeline(i)}
  </article>`;
}

function renderIncidentsByDay(incidents: PublicIncident[]): string {
  const byDay = new Map<string, PublicIncident[]>();
  for (const incident of incidents) {
    const key = utcDayKey(incident.startedAt);
    const list = byDay.get(key) ?? [];
    list.push(incident);
    byDay.set(key, list);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, dayIncidents]) => {
      const articles = dayIncidents.map((incident) => renderIncidentArticle(incident)).join("");
      return `<div class="incident-day"><p class="incident-date">${escapeHtml(formatDayHeading(day))}</p>${articles}</div>`;
    })
    .join("");
}

function renderIncidents(incidents: PublicIncident[]): string {
  if (!incidents.length) return `<p class="quiet">No incidents reported.</p>`;
  return renderIncidentsByDay(incidents);
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function renderTodayIncidents(incidents: PublicIncident[]): string {
  const today = todayKey();
  const todayIncidents = incidents.filter((i) => {
    // Show incidents that are active (unresolved) or started today
    if (!i.resolvedAt) return true;
    return utcDayKey(i.startedAt) === today || utcDayKey(i.resolvedAt) === today;
  });
  if (!todayIncidents.length) return `<p class="quiet">No incidents today.</p>`;
  return renderIncidentsByDay(todayIncidents);
}

function hasOlderIncidents(incidents: PublicIncident[]): boolean {
  const today = todayKey();
  return incidents.some((i) => {
    if (!i.resolvedAt) return false;
    return utcDayKey(i.startedAt) !== today && utcDayKey(i.resolvedAt) !== today;
  });
}

const STYLES = `
@property --bg { syntax: "<color>"; inherits: true; initial-value: #efece6; }
@property --card { syntax: "<color>"; inherits: true; initial-value: #f7f4ee; }
@property --ink { syntax: "<color>"; inherits: true; initial-value: #3a3732; }
@property --muted { syntax: "<color>"; inherits: true; initial-value: #6d6860; }
@property --line { syntax: "<color>"; inherits: true; initial-value: #ddd8ce; }
@property --hover { syntax: "<color>"; inherits: true; initial-value: #e8e4dc; }
@property --ok { syntax: "<color>"; inherits: true; initial-value: #2f8f73; }
@property --ok-ink { syntax: "<color>"; inherits: true; initial-value: #1e4a3d; }
@property --ok-bg { syntax: "<color>"; inherits: true; initial-value: #dceee6; }
@property --ok-line { syntax: "<color>"; inherits: true; initial-value: #b7d8c9; }
@property --warn { syntax: "<color>"; inherits: true; initial-value: #c4841d; }
@property --warn-ink { syntax: "<color>"; inherits: true; initial-value: #6b4a16; }
@property --warn-bg { syntax: "<color>"; inherits: true; initial-value: #f3ead6; }
@property --warn-line { syntax: "<color>"; inherits: true; initial-value: #e2d0a8; }
@property --bad { syntax: "<color>"; inherits: true; initial-value: #c75c6e; }
@property --bad-ink { syntax: "<color>"; inherits: true; initial-value: #7a2e3c; }
@property --bad-bg { syntax: "<color>"; inherits: true; initial-value: #f3dde2; }
@property --bad-line { syntax: "<color>"; inherits: true; initial-value: #e4b8c1; }
@property --empty { syntax: "<color>"; inherits: true; initial-value: #e4dfd6; }
@property --on-accent { syntax: "<color>"; inherits: true; initial-value: #f7f4ee; }
:root, html[data-theme="light"] {
  color-scheme: light;
  --bg: #efece6;
  --ink: #3a3732;
  --muted: #6d6860;
  --line: #ddd8ce;
  --card: #f7f4ee;
  --hover: #e8e4dc;
  --on-accent: #f7f4ee;
  --ok: #2f8f73;
  --ok-ink: #1e4a3d;
  --ok-bg: #dceee6;
  --ok-line: #b7d8c9;
  --warn: #c4841d;
  --warn-ink: #6b4a16;
  --warn-bg: #f3ead6;
  --warn-line: #e2d0a8;
  --bad: #c75c6e;
  --bad-ink: #7a2e3c;
  --bad-bg: #f3dde2;
  --bad-line: #e4b8c1;
  --empty: #e4dfd6;
  --radius: 10px;
  --max: 42rem;
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
  --duration-ui: 150ms;
  --duration-press: 160ms;
  --duration-panel: 200ms;
  --duration-enter: 700ms;
}
html[data-theme="dark"] {
  color-scheme: dark;
  --bg: #2c2b28;
  --ink: #e4e0d8;
  --muted: #a8a39a;
  --line: #4a4842;
  --card: #363530;
  --hover: #3f3e39;
  --on-accent: #f7f4ee;
  --ok: #5eb89a;
  --ok-ink: #c5e8da;
  --ok-bg: #2f423b;
  --ok-line: #3d5a4e;
  --warn: #d4a04a;
  --warn-ink: #ecd9b0;
  --warn-bg: #3f3728;
  --warn-line: #5a4d32;
  --bad: #e07a8a;
  --bad-ink: #f0c4cb;
  --bad-bg: #433033;
  --bad-line: #5c4046;
  --empty: #4a4842;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #2c2b28;
    --ink: #e4e0d8;
    --muted: #a8a39a;
    --line: #4a4842;
    --card: #363530;
    --hover: #3f3e39;
    --on-accent: #f7f4ee;
    --ok: #5eb89a;
    --ok-ink: #c5e8da;
    --ok-bg: #2f423b;
    --ok-line: #3d5a4e;
    --warn: #d4a04a;
    --warn-ink: #ecd9b0;
    --warn-bg: #3f3728;
    --warn-line: #5a4d32;
    --bad: #e07a8a;
    --bad-ink: #f0c4cb;
    --bad-bg: #433033;
    --bad-line: #5c4046;
    --empty: #4a4842;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--ink); min-height: 100%; overflow-x: hidden; }
html.theme-ready {
  transition:
    --bg var(--duration-ui) var(--ease-out),
    --card var(--duration-ui) var(--ease-out),
    --ink var(--duration-ui) var(--ease-out),
    --muted var(--duration-ui) var(--ease-out),
    --line var(--duration-ui) var(--ease-out),
    --hover var(--duration-ui) var(--ease-out),
    --on-accent var(--duration-ui) var(--ease-out),
    --ok var(--duration-ui) var(--ease-out),
    --ok-ink var(--duration-ui) var(--ease-out),
    --ok-bg var(--duration-ui) var(--ease-out),
    --ok-line var(--duration-ui) var(--ease-out),
    --warn var(--duration-ui) var(--ease-out),
    --warn-ink var(--duration-ui) var(--ease-out),
    --warn-bg var(--duration-ui) var(--ease-out),
    --warn-line var(--duration-ui) var(--ease-out),
    --bad var(--duration-ui) var(--ease-out),
    --bad-ink var(--duration-ui) var(--ease-out),
    --bad-bg var(--duration-ui) var(--ease-out),
    --bad-line var(--duration-ui) var(--ease-out),
    --empty var(--duration-ui) var(--ease-out);
}
body {
  min-height: 100vh;
  min-height: 100dvh;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 15px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; }
.wrap {
  max-width: var(--max); margin: 0 auto; padding: 1.5rem 1.25rem 3.5rem;
  min-height: 100vh; min-height: 100dvh;
  display: flex; flex-direction: column;
  position: relative; z-index: 1;
}
main { flex: 1 0 auto; }
.top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem 1rem; margin-bottom: 1.25rem; }
#live-brand { min-width: 0; flex: 1 1 12rem; }
.brand {
  display: flex; align-items: center; gap: 0.55rem; min-width: 0;
  font-weight: 650; font-size: 1.125rem; letter-spacing: -0.03em; line-height: 1;
  text-decoration: none;
}
.brand-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fox { width: 1.5rem; height: 1.5rem; object-fit: contain; flex: none; }
.foot-fox { width: 1rem; height: 1rem; object-fit: contain; flex: none; }
.site-icon {
  width: 1.5rem; height: 1.5rem; flex: none;
  object-fit: cover; border-radius: 26%;
}
@supports (corner-shape: squircle) {
  .site-icon { border-radius: 32%; corner-shape: squircle; }
}
.brand:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
.theme-toggle {
  flex: none; margin-left: auto;
  position: relative; width: 2rem; height: 2rem; padding: 0;
  display: grid; place-items: center;
  border: 1px solid var(--line); background: var(--card); color: var(--ink);
  border-radius: 6px; cursor: pointer;
  transition: transform var(--duration-press) var(--ease-out);
}
@media (hover: hover) and (pointer: fine) {
  .theme-toggle:hover {
    background: var(--hover);
    transition: background-color var(--duration-ui) var(--ease-out), transform var(--duration-press) var(--ease-out);
  }
}
.theme-toggle:active { transform: scale(0.97); }
.theme-toggle:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
.theme-icon {
  grid-area: 1 / 1; width: 1rem; height: 1rem; background: currentColor;
  -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
  -webkit-mask-position: center; mask-position: center;
  -webkit-mask-size: contain; mask-size: contain;
  transition: opacity var(--duration-ui) var(--ease-out), transform var(--duration-ui) var(--ease-out);
}
.theme-icon-moon {
  -webkit-mask-image: url("/moon.png"); mask-image: url("/moon.png");
  opacity: 1; transform: rotate(0deg);
}
.theme-icon-sun {
  -webkit-mask-image: url("/sun.png"); mask-image: url("/sun.png");
  opacity: 0; transform: rotate(45deg);
}
html[data-theme="dark"] .theme-icon-moon { opacity: 0; transform: rotate(45deg); }
html[data-theme="dark"] .theme-icon-sun { opacity: 1; transform: rotate(0deg); }
.banner { border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.banner-head { display: flex; align-items: center; gap: 0.7rem; padding: 1.1rem 1.15rem 1rem; }
.banner-head h1 { margin: 0; font-size: 1.25rem; font-weight: 650; letter-spacing: -0.03em; line-height: 1.25; }
.banner-head .mark { width: 1.35rem; height: 1.35rem; }
.banner-body { margin: 0; padding: 0.85rem 1.15rem 1rem; border-top: 1px solid var(--line); color: var(--muted); background: var(--card); font-size: 0.925rem; }
.banner-fully_operational { border-color: var(--ok-line); }
.banner-fully_operational .banner-head { background: var(--ok-bg); color: var(--ok-ink); }
.banner-degraded { border-color: var(--warn-line); }
.banner-degraded .banner-head { background: var(--warn-bg); color: var(--warn-ink); }
.banner-failing { border-color: var(--bad-line); }
.banner-failing .banner-head { background: var(--bad-bg); color: var(--bad-ink); }
.banner-unknown { border-color: var(--line); }
.banner-unknown .banner-head { background: var(--hover); color: var(--ink); }
.stale {
  margin: 0.65rem 0 0; padding: 0.55rem 0.85rem;
  border: 1px solid var(--warn-line); border-radius: 8px;
  color: var(--warn-ink); background: var(--warn-bg); font-size: 0.8125rem;
}
.mesh { margin: 1.5rem 0 0; }
.mesh .card-head { padding-bottom: 0.35rem; }
.mesh-plot {
  position: relative; height: 13.25rem; margin: 0 0.35rem 0.15rem;
  border-radius: 8px; overflow: hidden; background: var(--card);
  touch-action: manipulation;
}
.mesh-plot svg {
  position: absolute; inset: 0; width: 100%; height: 100%; display: block;
}
.mesh-ocean { fill: var(--card); }
.mesh-land {
  fill: color-mix(in srgb, var(--empty) 72%, var(--line) 28%);
  stroke: var(--line); stroke-width: 0.22; stroke-linejoin: round;
}
.mesh-grid { stroke: var(--line); fill: none; stroke-width: 0.12; opacity: 0.42; }
.mesh-arc {
  fill: none; stroke: var(--line); stroke-width: 0.34; opacity: 0.9;
  transition: opacity var(--duration-ui) var(--ease-out), stroke var(--duration-ui) var(--ease-out);
}
.mesh-hop {
  fill: none; stroke: var(--ink); stroke-width: 0.28; stroke-dasharray: 0.9 0.9; opacity: 0.4;
  transition: opacity var(--duration-ui) var(--ease-out);
}
.mesh-hits { position: absolute; inset: 0; }
.mesh-node {
  position: absolute; width: 1.75rem; height: 1.75rem; margin: 0; padding: 0;
  border: 0; background: transparent; color: var(--ok); cursor: pointer;
  transform: translate(-50%, -50%);
  transition: transform var(--duration-press) var(--ease-out), opacity var(--duration-ui) var(--ease-out);
}
.mesh-node.warn { color: var(--warn); }
.mesh-node.bad { color: var(--bad); }
.mesh-node.empty { color: var(--muted); }
.mesh-node::before {
  content: ""; position: absolute; left: 50%; top: 50%;
  width: 0.62rem; height: 0.62rem;
  transform: translate(-50%, -50%);
  border-radius: 50%; background: currentColor;
  box-shadow: 0 0 0 2px var(--card);
}
.mesh-node.empty::before {
  background: var(--empty); box-shadow: 0 0 0 1px var(--line), 0 0 0 2px var(--card);
}
.mesh-node.has-ring::after {
  content: ""; position: absolute; left: 50%; top: 50%;
  width: var(--ring, 1.4rem); height: var(--ring, 1.4rem);
  transform: translate(-50%, -50%);
  border: 1px solid currentColor; border-radius: 50%; opacity: 0.38;
  pointer-events: none;
}
.mesh-node:active { transform: translate(-50%, -50%) scale(0.97); }
@media (hover: hover) and (pointer: fine) {
  .mesh-node:hover { transform: translate(-50%, -50%) scale(1.08); }
}
.mesh-node:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; border-radius: 50%; }
.mesh-you {
  position: absolute; width: 0.5rem; height: 0.5rem;
  transform: translate(-50%, -50%) rotate(45deg);
  background: var(--ink); pointer-events: none; z-index: 2;
}
.mesh-plot.is-hot .mesh-arc { opacity: 0.14; }
.mesh-plot.is-hot .mesh-arc.is-on { opacity: 0.95; stroke: var(--ink); }
.mesh-plot.is-hot .mesh-hop { opacity: 0.12; }
.mesh-plot.is-hot .mesh-node { opacity: 0.38; }
.mesh-plot.is-hot .mesh-node.is-on { opacity: 1; }
.mesh-plot.is-hot .mesh-you { opacity: 0.35; }
.mesh-readout {
  margin: 0; padding: 0.45rem 1.15rem 0.95rem;
  color: var(--muted); font-size: 0.8125rem;
  font-variant-numeric: tabular-nums; min-height: 2.35rem;
}
.mesh-sr {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
}
.globe-stage {
  display: none;
  position: fixed; inset: 0; z-index: 0;
  pointer-events: none;
  user-select: none;
  overflow: hidden;
  transform-origin: var(--globe-cx, 70%) var(--globe-cy, 38%);
}
.globe-stage:not([hidden]):not(.is-in):not(.is-ready) { opacity: 0; }
.globe-stage.is-in {
  animation:
    globe-fade var(--duration-enter) linear both,
    globe-settle var(--duration-enter) linear both,
    globe-focus var(--duration-enter) linear both;
  will-change: opacity, filter, transform;
}
.globe-stage canvas {
  position: absolute; inset: 0;
  width: 100%; height: 100%; display: block;
  pointer-events: auto; cursor: grab; touch-action: none;
}
.globe-stage.is-drag canvas { cursor: grabbing; }
canvas.globe-labels {
  display: none;
  position: fixed; inset: 0;
  width: 100%; height: 100%;
  z-index: 20;
  pointer-events: none;
  user-select: none;
  opacity: 0;
  transition: opacity 400ms linear;
}
@keyframes globe-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes globe-settle {
  from { transform: scale(0.97); }
  to { transform: none; }
}
@keyframes globe-focus {
  0% { filter: blur(12px); }
  40% { filter: blur(5px); }
  70% { filter: blur(2px); }
  100% { filter: blur(0); }
}
@keyframes globe-arrive-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@media (min-width: 1100px) and (hover: hover) and (pointer: fine) {
  html:has(#globe-stage) { overflow-y: scroll; scrollbar-gutter: stable; }
  .globe-stage:not([hidden]) { display: block; }
  body:has(#globe-stage:not([hidden])) canvas.globe-labels { display: block; }
  body:has(#globe-stage.is-ready) canvas.globe-labels { opacity: 1; }
  /* The globe stands in for the map here. The section stays in the document, clipped like .mesh-sr, so its heading and the list of regions still reach a screen reader; the plot and its buttons, which would be unseen tab stops, do not. */
  html.globe-on body:has(#globe-stage) #live-mesh.mesh {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
  }
  html.globe-on body:has(#globe-stage) #live-mesh .mesh-plot { display: none; }
  html.globe-on body:has(#globe-stage) .wrap {
    margin-right: auto;
    margin-left: max(0px, min(
      calc((100% - var(--max)) / 2),
      calc(var(--globe-left, calc(100% - clamp(22rem, 42vw, 38rem))) - var(--max) - 1.25rem)
    ));
  }
  body:has(#globe-stage:not([hidden])) .wrap { pointer-events: none; }
  body:has(#globe-stage:not([hidden])) .top,
  body:has(#globe-stage:not([hidden])) .foot,
  body:has(#globe-stage:not([hidden])) .card,
  body:has(#globe-stage:not([hidden])) .banner,
  body:has(#globe-stage:not([hidden])) .stale { pointer-events: auto; }
}
.systems { margin: 1.5rem 0; }
.card { border: 1px solid var(--line); border-radius: var(--radius); background: var(--card); overflow: visible; }
.card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; padding: 0.9rem 1.15rem 0.7rem; }
.card-head h1, .card-head h2 { margin: 0; font-size: 0.95rem; font-weight: 650; letter-spacing: -0.02em; }
.range { margin: 0; color: var(--muted); font-size: 0.8125rem; }
.service { padding: 0.85rem 1.15rem 1rem; border-top: 1px solid var(--line); overflow: visible; }
.service details { margin: 0; }
.service summary { list-style: none; cursor: pointer; }
.service summary::-webkit-details-marker { display: none; }
.service summary:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; border-radius: 4px; }
.svc-row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.5rem; }
.svc-label { display: flex; align-items: center; flex-wrap: wrap; gap: 0.4rem 0.5rem; min-width: 0; flex: 1 1 auto; cursor: default; }
summary .svc-label { cursor: pointer; }
.name { font-weight: 600; font-size: 0.925rem; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 0 1 auto; }
.impact { display: flex; flex-wrap: wrap; gap: 0.3rem; margin: 0; padding: 0; list-style: none; min-width: 0; }
.impact-pill {
  display: inline-flex; align-items: baseline; gap: 0.28rem;
  font-size: 0.6875rem; font-weight: 600; line-height: 1.3;
  padding: 0.12rem 0.4rem; border-radius: 999px; white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.impact-pill.warn { background: var(--warn-bg); color: var(--warn-ink); }
.impact-pill.bad { background: var(--bad-bg); color: var(--bad-ink); }
.impact-pill.is-on { box-shadow: 0 0 0 1px currentColor; }
.impact-detail { font-weight: 500; opacity: 0.82; }
.maint-label { color: var(--warn-ink); font-size: 0.75rem; font-weight: 600; flex: none; }
.count { color: var(--muted); font-size: 0.8rem; font-weight: 400; flex: none; }
.chev { width: 0.7rem; height: 0.7rem; flex: none; color: var(--muted); transition: transform var(--duration-ui) var(--ease-out); }
.count + .chev { margin-inline-start: -0.3rem; }
details[open] .chev { transform: rotate(180deg); }
.uptime { color: var(--muted); font-size: 0.8125rem; white-space: nowrap; font-variant-numeric: tabular-nums; flex: none; }
.mark { width: 1rem; height: 1rem; flex: none; display: block; }
.mark.ok { color: var(--ok); fill: var(--ok); }
.mark.warn { color: var(--warn); fill: var(--warn); }
.mark.bad { color: var(--bad); fill: var(--bad); }
.mark.empty { color: var(--muted); }
.bar { display: flex; align-items: stretch; gap: 1px; height: 1.5rem; position: relative; }
.day {
  position: relative; flex: 1 1 0; min-width: 0; height: 100%;
  display: flex; align-items: flex-end; background: transparent;
}
.day::before {
  content: ""; display: block; width: 100%; height: var(--h, 22%);
  border-radius: 1px; background: var(--empty); pointer-events: none;
}
.day.ok::before { background: var(--ok); }
.day.warn::before { background: var(--warn); }
.day.bad::before { background: var(--bad); }
.bar:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; border-radius: 4px; }
.tip {
  position: absolute; bottom: calc(100% + 8px); left: 50%;
  opacity: 0; visibility: hidden; pointer-events: none;
  transform: translateX(-50%) translateY(4px);
  background: var(--card); color: var(--muted);
  border: 1px solid var(--line); border-radius: 8px; padding: 0.5rem 0.65rem;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.2); white-space: nowrap; min-width: 13.5rem;
  transition: opacity var(--duration-ui) var(--ease-out), transform var(--duration-ui) var(--ease-out), visibility var(--duration-ui) var(--ease-out);
}
.bar .day:nth-child(-n+24) .tip { left: 0; transform: translateY(4px); }
.bar .day:nth-last-child(-n+24) .tip { left: auto; right: 0; transform: translateY(4px); }
/* One tooltip for the page, moved into the day that is hovered, tapped or reached with the arrow keys. */
.day.is-tip { z-index: 3; }
.tip.is-on { opacity: 1; visibility: visible; transform: translateX(-50%) translateY(0); transition-duration: 0ms; }
.bar .day:nth-child(-n+24) .tip.is-on, .bar .day:nth-last-child(-n+24) .tip.is-on { transform: translateY(0); }
.tip-date { display: block; font-size: 0.75rem; margin-bottom: 0.25rem; }
.tip-row { display: flex; align-items: center; gap: 0.35rem; font-size: 0.8rem; color: var(--ink); }
.tip-row .mark { width: 0.85rem; height: 0.85rem; }
.tip-checks { display: block; margin-top: 0.4rem; font-size: 0.75rem; color: var(--muted); font-variant-numeric: tabular-nums; }
.tip-checks b { font-weight: 500; color: var(--ink); }
.tip-lat { position: relative; display: block; width: 12.75rem; margin-top: 0.65rem; padding-top: 0.95rem; padding-bottom: 1.15rem; }
.tip-lat-track { position: relative; display: block; height: 0.9rem; }
.tip-lat-track::before {
  content: ""; position: absolute; left: 0; right: 0; top: 50%;
  height: 2px; margin-top: -1px; background: var(--empty); border-radius: 1px;
}
.tip-lat-range {
  position: absolute; top: 50%; height: 2px; margin-top: -1px;
  background: var(--ink); opacity: 0.18; border-radius: 1px;
}
.tip-lat-mark {
  position: absolute; top: 0; bottom: 0; width: 2px; border-radius: 1px;
  transform: translateX(-50%);
}
.tip-lat-mark.min { background: var(--ok); }
.tip-lat-mark.avg { background: var(--warn); }
.tip-lat-mark.max { background: var(--bad); }
.tip-lat-avg {
  position: absolute; top: 0; font-size: 0.6875rem; font-weight: 500;
  color: var(--ink); font-variant-numeric: tabular-nums; white-space: nowrap;
}
.tip-lat-avg .k { color: var(--muted); font-weight: 400; }
.tip-lat-end {
  position: absolute; bottom: 0; font-size: 0.6875rem; font-weight: 500;
  color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap;
}
.nested-inner { min-height: 0; }
details[open] ~ .group-bar { display: none; }
/* ponytail: accordion must move siblings (height), not clip-path. Ceiling: ::details-content + interpolate-size; older browsers snap. */
@supports selector(::details-content) {
  details::details-content {
    interpolate-size: allow-keywords;
    height: 0;
    overflow: clip;
    opacity: 0;
    transition:
      height var(--duration-panel) var(--ease-out),
      opacity var(--duration-ui) var(--ease-out),
      content-visibility var(--duration-panel) allow-discrete,
      overflow 0s;
  }
  details[open]::details-content {
    height: auto;
    overflow: visible;
    opacity: 1;
    transition:
      height var(--duration-panel) var(--ease-out),
      opacity var(--duration-ui) var(--ease-out),
      content-visibility var(--duration-panel) allow-discrete,
      overflow 0s var(--duration-panel) allow-discrete;
  }
  @starting-style {
    details[open]::details-content {
      height: 0;
      opacity: 0;
    }
  }
  .group-bar {
    transition:
      height var(--duration-panel) var(--ease-out),
      opacity var(--duration-ui) var(--ease-out),
      overflow 0s var(--duration-panel) allow-discrete;
  }
  details[open] ~ .group-bar {
    display: flex;
    height: 0;
    opacity: 0;
    overflow: clip;
    pointer-events: none;
    /* Collapsed, not removed, so it is taken out of the tab order once the collapse has played. */
    visibility: hidden;
    transition:
      height var(--duration-panel) var(--ease-out),
      opacity var(--duration-ui) var(--ease-out),
      visibility 0s var(--duration-panel),
      overflow 0s allow-discrete;
  }
  #live-systems.is-restoring details::details-content,
  #live-systems.is-restoring details[open]::details-content,
  #live-systems.is-restoring .group-bar,
  #live-systems.is-restoring details[open] ~ .group-bar,
  #live-systems.is-restoring .chev {
    transition: none;
  }
}
.component { padding: 0.85rem 0 0.15rem; margin-left: 0.15rem; }
.component + .component { border-top: 1px solid var(--line); margin-top: 0.7rem; padding-top: 0.85rem; }
#live-history { margin-bottom: 2rem; }
.incident-day { border-top: 1px solid var(--line); }
.incident-date { margin: 0; padding: 0.85rem 1.15rem 0.25rem; color: var(--muted); font-size: 0.75rem; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; }
.incident { padding: 0.55rem 1.15rem 1rem; }
.incident h3 { margin: 0; font-size: 0.95rem; letter-spacing: -0.01em; }
.incident .meta { margin: 0 0 0.55rem; color: var(--muted); font-size: 0.8rem; }
.timeline { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 0.55rem; }
.timeline-item { border-left: 2px solid var(--line); padding: 0 0 0 0.75rem; background: none; }
.timeline-item.warn { border-left-color: var(--warn); }
.timeline-item.ok { border-left-color: var(--ok); }
.timeline-item.ink { border-left-color: var(--ink); }
.update-meta { margin: 0 0 0.15rem; color: var(--muted); font-size: 0.75rem; }
.update-body { margin: 0; font-size: 0.875rem; }
.quiet { margin: 0; padding: 0.85rem 1.15rem 1.1rem; color: var(--muted); font-size: 0.875rem; }
.history-link {
  display: flex; align-items: center; justify-content: center; gap: 0.4rem;
  margin: 0; padding: 0.75rem 1.15rem; border-top: 1px solid var(--line);
  color: var(--muted); font-size: 0.8125rem; font-weight: 500; text-decoration: none;
  transition: background var(--duration-ui) var(--ease-out), color var(--duration-ui) var(--ease-out);
}
.history-link:hover { background: var(--hover); color: var(--ink); }
.history-link svg { width: 0.75rem; height: 0.75rem; flex: none; }
.badge {
  display: inline-flex; align-items: center; gap: 0.3rem;
  font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.01em;
  padding: 0.15rem 0.45rem; border-radius: 4px; line-height: 1.4;
  text-transform: uppercase; white-space: nowrap;
}
.badge-investigating { background: var(--warn-bg); color: var(--warn-ink); }
.badge-identified { background: var(--warn-bg); color: var(--warn-ink); }
.badge-monitoring { background: var(--ok-bg); color: var(--ok-ink); }
.badge-resolved { background: var(--ok-bg); color: var(--ok-ink); }
.badge-degraded { background: var(--warn-bg); color: var(--warn-ink); }
.badge-failing { background: var(--bad-bg); color: var(--bad-ink); }
.incident-header { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.3rem; }
.incident-header h3 { margin: 0; font-size: 0.95rem; letter-spacing: -0.01em; }
.incident-header a { color: inherit; text-decoration: none; }
.incident-header a:hover { text-decoration: underline; }
.incident-badges { display: flex; align-items: center; gap: 0.35rem; margin: 0.3rem 0 0.45rem; flex-wrap: wrap; }
.incident-duration { color: var(--muted); font-size: 0.75rem; margin: 0 0 0.55rem; }
.back-link {
  display: inline-flex; align-items: center; gap: 0.35rem;
  color: var(--muted); font-size: 0.8125rem; font-weight: 500; text-decoration: none;
  margin-bottom: 1rem;
  transition: color var(--duration-ui) var(--ease-out);
}
.back-link:hover { color: var(--ink); }
.back-link svg { width: 0.75rem; height: 0.75rem; flex: none; }
.foot { text-align: center; color: var(--muted); font-size: 0.75rem; margin-top: auto; flex: none; }
.foot .by { display: inline-flex; align-items: center; gap: 0.4rem; font-weight: 500; color: var(--ink); margin: 0 0 0.5rem; text-decoration: none; }
.disclaimer { margin: 0 auto; max-width: 32rem; line-height: 1.55; }
.empty-card { padding: 1.15rem; color: var(--muted); font-size: 0.875rem; }
@media (max-width: 640px) {
  .wrap { padding: 1.25rem 1rem 2.5rem; }
  .banner-head h1 { font-size: 1.1rem; }
  .bar { height: 1.1rem; }
  .mesh-plot { height: 10.25rem; }
  .uptime { font-size: 0.75rem; }
  .count { display: none; }
  .uptime-word { font-size: 0.7rem; }
}
@media (prefers-reduced-motion: reduce) {
  html.theme-ready { transition: none; }
  .globe-stage.is-in {
    animation: globe-arrive-fade var(--duration-panel) var(--ease-out) both;
    will-change: opacity;
  }
  canvas.globe-labels { transition-duration: var(--duration-ui); }
  .chev, .tip, .theme-toggle, .theme-icon { transform: none; }
  .mesh-node, .mesh-node:active, .mesh-node:hover { transform: translate(-50%, -50%); }
  .chev, .tip, .theme-toggle, .mesh-arc, .mesh-hop, .mesh-node { transition-property: opacity, visibility, color, background-color, border-color, stroke; }
  .theme-icon { transition: opacity var(--duration-ui) var(--ease-out); }
  html[data-theme="dark"] .theme-icon-moon, html[data-theme="dark"] .theme-icon-sun { transform: none; }
  details::details-content,
  details[open]::details-content,
  .group-bar,
  details[open] ~ .group-bar {
    transition: opacity var(--duration-ui) var(--ease-out);
  }
}
`;

function renderNotices(snap: PublicSnapshot): string {
  const stale = snap.stale
    ? `<p class="stale" role="status">Monitoring data may be stale. Last observer tick: ${snap.lastTick ? `<time datetime="${new Date(snap.lastTick).toISOString()}">${escapeHtml(new Date(snap.lastTick).toUTCString())}</time>` : "never"}.</p>`
    : "";
  const maintenance = snap.groups.some((g) => g.components.some((c) => c.status === "maintenance"))
    ? `<p class="stale" role="status">Scheduled maintenance is in progress on some systems.</p>`
    : "";
  return `${stale}${maintenance}`;
}

export function renderBannerBlock(snap: PublicSnapshot, notice = ""): string {
  return withRev(`<div id="live-banner"><section class="banner banner-${escapeHtml(snap.banner)}" aria-live="polite">
        <div class="banner-head">
          ${mark(snap.banner === "unknown" ? "empty" : snap.banner === "fully_operational" ? "operational" : snap.banner === "failing" ? "failing" : "degraded")}
          <h1>${escapeHtml(LABELS[snap.banner])}</h1>
        </div>
        <p class="banner-body">${escapeHtml(bannerBody(snap))}</p>
      </section>${renderNotices(snap)}${notice}</div>`);
}

export function renderMeshBlock(snap: PublicSnapshot): string {
  const observers = snap.observers ?? [];
  if (!observers.length) return withRev(`<section id="live-mesh" hidden></section>`);
  const maxLatency = observers.reduce((m, o) => Math.max(m, o.latencyMs ?? 0), 0);
  const regions = observers.map((o) => o.region);
  const arcs = meshArcs(regions);
  const land = landPaths()
    .map((d) => `<path d="${d}"/>`)
    .join("");
  const grid = graticuleLines()
    .map((l) => `<line x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}"/>`)
    .join("");
  const arcEls = arcs
    .map((a) => `<path class="mesh-arc" data-a="${escapeHtml(a.a)}" data-b="${escapeHtml(a.b)}" d="${a.d}"/>`)
    .join("");
  const nodes = observers
    .map((o) => {
      const coord = REGION_COORDS[o.region];
      if (!coord) return "";
      const p = projectPct(coord.lng, coord.lat);
      const kind = observerKind(o.outcome);
      const ring = ringRem(o.latencyMs, maxLatency);
      const read = observerReadout(o);
      const ringAttr = ring ? ` style="left:${p.x}%;top:${p.y}%;--ring:${ring}"` : ` style="left:${p.x}%;top:${p.y}%"`;
      const ringClass = ring ? " has-ring" : "";
      return `<button type="button" class="mesh-node ${kind}${ringClass}" data-region="${escapeHtml(o.region)}" data-label="${escapeHtml(o.label)}" data-read="${escapeHtml(read)}" data-lat="${coord.lat}" data-lng="${coord.lng}"${ringAttr} aria-label="${escapeHtml(read)}"></button>`;
    })
    .join("");
  const caption = meshCaption(observers);
  const sr = `<ul class="mesh-sr">${observers.map((o) => `<li>${escapeHtml(observerReadout(o))}</li>`).join("")}</ul>`;
  return withRev(`<section class="card mesh" id="live-mesh" aria-labelledby="mesh-title">
        <div class="card-head">
          <h2 id="mesh-title">From the edge</h2>
          <p class="range">Live</p>
        </div>
        <div class="mesh-plot" data-proj="${meshProjAttr()}">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
            <rect class="mesh-ocean" width="100" height="100"/>
            <g class="mesh-grid">${grid}</g>
            <g class="mesh-land">${land}</g>
            <g class="mesh-arcs">${arcEls}</g>
            <path class="mesh-hop" hidden></path>
          </svg>
          <div class="mesh-hits">${nodes}</div>
          <span class="mesh-you" hidden></span>
        </div>
        ${sr}
        <p class="mesh-readout" data-base="${escapeHtml(caption)}">${escapeHtml(caption)}</p>
      </section>`);
}

export function renderSystemsBlock(snap: PublicSnapshot): string {
  const range =
    dateRange(snap.groups.flatMap((g) => g.components[0]?.days ?? [])) ?? "Last 90 days";
  const groups = snap.groups.map(renderService).join("");
  return withRev(`<section class="card systems" id="live-systems" aria-labelledby="systems-title">
        <div class="card-head">
          <h2 id="systems-title">System status</h2>
          <p class="range">${escapeHtml(range)}</p>
        </div>
        ${groups || `<p class="empty-card">No components configured yet.</p>`}
      </section>`);
}

export function renderHistoryBlock(snap: PublicSnapshot): string {
  const historyLink = hasOlderIncidents(snap.incidents)
    ? `<a class="history-link" href="/history">View full incident history<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></a>`
    : "";
  return withRev(`<section class="card" id="live-history" aria-labelledby="history-title">
        <div class="card-head"><h2 id="history-title">Incident history</h2></div>
        ${renderTodayIncidents(snap.incidents)}
        ${historyLink}
      </section>`);
}

export function renderMaintenanceBlock(snap: PublicSnapshot): string {
  const maintenance = snap.maintenance ?? [];
  if (!maintenance.length) return withRev(`<section id="live-maintenance" hidden></section>`);
  const items = maintenance.map((window) => {
    const active = window.startAt <= snap.generatedAt && snap.generatedAt < window.endAt;
    return `<li class="incident"><h3>${escapeHtml(window.componentName)}</h3><p class="meta">${active ? "In progress" : "Scheduled"} · <time datetime="${new Date(window.startAt).toISOString()}">${escapeHtml(new Date(window.startAt).toUTCString())}</time> – <time datetime="${new Date(window.endAt).toISOString()}">${escapeHtml(new Date(window.endAt).toUTCString())}</time></p>${window.note ? `<p class="update-body">${escapeHtml(window.note)}</p>` : ""}</li>`;
  }).join("");
  return withRev(`<section class="card systems" id="live-maintenance" aria-labelledby="maintenance-title"><div class="card-head"><h2 id="maintenance-title">Scheduled maintenance</h2></div><ul class="timeline">${items}</ul></section>`);
}

export function snapshotEtag(snap: PublicSnapshot): string {
  return fnv1a(JSON.stringify({
    banner: snap.banner,
    stale: snap.stale,
    siteName: snap.siteName,
    homepageUrl: snap.homepageUrl ?? null,
    iconUrl: snap.iconUrl ?? null,
    globe: snap.globe !== false,
    lastTick: snap.lastTick,
    groups: snap.groups,
    incidents: snap.incidents,
    maintenance: snap.maintenance ?? [],
    observers: snap.observers ?? [],
  }));
}

/**
 * Like snapshotEtag, but blind to what moves on every probe run: check counts,
 * latency and the tick time. Two snapshots with the same key read the same to
 * a visitor apart from those numbers, so the hub does not hurry to send the
 * second one.
 */
export function snapshotStableKey(snap: PublicSnapshot): string {
  const day = (d: PublicDay) => `${d.date}:${dayKind(d.uptime, d.incident, d.incidentImpact)}`;
  const maintenance = snap.maintenance ?? [];
  return fnv1a(JSON.stringify({
    banner: snap.banner,
    stale: snap.stale,
    siteName: snap.siteName,
    homepageUrl: snap.homepageUrl ?? null,
    iconUrl: snap.iconUrl ?? null,
    globe: snap.globe !== false,
    lastTick: snap.stale ? snap.lastTick : null,
    groups: snap.groups.map((g) => ({
      id: g.id,
      name: g.name,
      uptime: pct(g.uptime90),
      impact: g.impact ?? null,
      days: g.days?.map(day) ?? null,
      components: g.components.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        uptime: pct(c.uptime90),
        impact: c.impact ?? null,
        days: c.days.map(day),
      })),
    })),
    incidents: snap.incidents,
    maintenance,
    maintenanceActive: maintenance.map((w) => w.startAt <= snap.generatedAt && snap.generatedAt < w.endAt),
    observers: (snap.observers ?? []).map((o) => ({ region: o.region, label: o.label, colo: o.colo, outcome: o.outcome })),
  }));
}

/**
 * The shape of the live blocks. Pages rendered by this version listen at the
 * two addresses below, and both move whenever a block stops working with the
 * stylesheet or script of pages that are already open, so a page is never
 * handed markup it cannot draw.
 */
export const LIVE_VERSION = "2";
export const LIVE_JSON_PATH = `/api/status/live.v${LIVE_VERSION}.json`;
export const LIVE_SOCKET_PATH = `/live?v=${LIVE_VERSION}`;

/** Live blocks, most urgent first. This is the order a notice fills its size budget in. */
export const LIVE_BLOCKS = ["banner", "brand", "maintenance", "history", "systems", "mesh"] as const;
export type LiveBlock = (typeof LIVE_BLOCKS)[number];

export type LivePayload = {
  etag: string;
  stable: string;
  generatedAt: number;
  title: string;
  description: string;
  icon: string;
  status: PublicSnapshot["banner"];
  /** The data-rev stamp of every block, so a reader can tell which ones it already shows. */
  revs: Record<LiveBlock, string>;
} & Record<LiveBlock, string>;

/** What the hub stores and sends: the payload with the blocks that did not fit left out. */
export type LiveNotice = Omit<LivePayload, LiveBlock> & Partial<Record<LiveBlock, string>>;

export function renderLivePayload(snap: PublicSnapshot): LivePayload {
  const blocks: Record<LiveBlock, string> = {
    brand: renderBrandBlock(snap),
    banner: renderBannerBlock(snap),
    systems: renderSystemsBlock(snap),
    mesh: renderMeshBlock(snap),
    history: renderHistoryBlock(snap),
    maintenance: renderMaintenanceBlock(snap),
  };
  return {
    etag: snapshotEtag(snap),
    stable: snapshotStableKey(snap),
    generatedAt: snap.generatedAt,
    title: `${snap.siteName} status`,
    description: LABELS[snap.banner],
    icon: pageIcon(snap),
    status: snap.banner,
    revs: {
      brand: blockRev(blocks.brand),
      banner: blockRev(blocks.banner),
      systems: blockRev(blocks.systems),
      mesh: blockRev(blocks.mesh),
      history: blockRev(blocks.history),
      maintenance: blockRev(blocks.maintenance),
    },
    ...blocks,
  };
}

const RELOAD_NOTICE = `<p class="stale" role="status">This page is out of date. Reload it to see the current status of each system.</p>`;

/**
 * What /api/status/live.json answers. Only pages rendered before LIVE_VERSION
 * read it: their socket is refused, so they poll here. Their stylesheet cannot
 * draw the uptime bars as they are sent now, so the systems block is left out.
 * Such a page keeps the bars it has, takes every other block, and says that it
 * needs a reload.
 */
export function renderLegacyLivePayload(snap: PublicSnapshot): Omit<LivePayload, "systems" | "revs" | "stable" | "generatedAt"> {
  return {
    etag: snapshotEtag(snap),
    title: `${snap.siteName} status`,
    description: LABELS[snap.banner],
    icon: pageIcon(snap),
    status: snap.banner,
    brand: renderBrandBlock(snap),
    banner: renderBannerBlock(snap, RELOAD_NOTICE),
    mesh: renderMeshBlock(snap),
    history: renderHistoryBlock(snap),
    maintenance: renderMaintenanceBlock(snap),
  };
}

/** Markup one notice may carry, in JSON characters. The hub sends it to every open page at once. */
export const LIVE_NOTICE_BUDGET = 64 * 1024;

/**
 * The message pushed over the socket. It always says which snapshot is current
 * and carries the blocks that fit the budget, the banner first. A page that is
 * missing a block it does not already show fetches LIVE_JSON_PATH, so
 * the size of a status page never decides whether the hub can store or send it.
 */
export function liveNotice(payload: LivePayload, budget = LIVE_NOTICE_BUDGET): LiveNotice {
  const notice: LiveNotice = {
    etag: payload.etag,
    stable: payload.stable,
    generatedAt: payload.generatedAt,
    title: payload.title,
    description: payload.description,
    icon: payload.icon,
    status: payload.status,
    revs: payload.revs,
  };
  let left = budget;
  for (const block of LIVE_BLOCKS) {
    const size = JSON.stringify(payload[block]).length;
    if (size > left) continue;
    left -= size;
    notice[block] = payload[block];
  }
  return notice;
}

/**
 * Builds the per-day tooltip in the browser from a day's data attributes. Kept
 * apart from the rest of the client so the markup it produces can be tested.
 */
export const DAY_TIP_SCRIPT = `
  var MARKS={ok:${JSON.stringify(mark("ok"))},warn:${JSON.stringify(mark("warn"))},bad:${JSON.stringify(mark("bad"))},empty:${JSON.stringify(mark("empty"))}};
  var CAPTIONS=${JSON.stringify(DAY_CAPTIONS)};
  function ms(n){ return Math.round(n)+"ms"; }
  function axisX(value, span){ return span<=0?50:Math.round((8+Math.max(0,value)/span*84)*100)/100; }
  function shift(x){ return "translateX("+(x<12?"0":x>88?"-100%":"-50%")+")"; }
  function longDate(iso){
    var p=String(iso).split("-");
    return new Date(Date.UTC(+p[0]||1970,(+p[1]||1)-1,+p[2]||1)).toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric",year:"numeric",timeZone:"UTC"});
  }
  function latencyHtml(lat){
    var avg=lat[0], lo=Math.min(lat[0],lat[1],lat[2]), hi=Math.max(lat[0],lat[1],lat[2]);
    var minX=axisX(lo,hi), avgX=axisX(avg,hi), maxX=axisX(hi,hi);
    var marks='<span class="tip-lat-mark avg" style="left:'+avgX+'%"></span>', ends="";
    if (hi-lo>=2){
      marks='<span class="tip-lat-range" style="left:'+minX+'%;width:'+Math.max(0.8,maxX-minX)+'%"></span><span class="tip-lat-mark min" style="left:'+minX+'%"></span>'+marks+'<span class="tip-lat-mark max" style="left:'+maxX+'%"></span>';
      ends='<span class="tip-lat-end min" style="left:'+minX+'%;transform:'+shift(minX)+'">'+ms(lo)+'</span><span class="tip-lat-end max" style="left:'+maxX+'%;transform:'+shift(maxX)+'">'+ms(hi)+'</span>';
    }
    return '<span class="tip-lat" role="img" aria-label="min '+ms(lo)+', avg '+ms(avg)+', max '+ms(hi)+'"><span class="tip-lat-avg" style="left:'+avgX+'%;transform:'+shift(avgX)+'">'+ms(avg)+'<span class="k"> avg</span></span><span class="tip-lat-track">'+marks+'</span>'+ends+'</span>';
  }
  function parseLatency(raw){
    var p=String(raw||"").split(",");
    if (p.length!==3) return null;
    for (var i=0;i<3;i++){ p[i]=+p[i]; if (!isFinite(p[i]) || p[i]<=0) return null; }
    return p;
  }
  function tipHtml(kind, iso, checks, lat){
    var html='<span class="tip-date">'+longDate(iso)+'</span><span class="tip-row">'+(MARKS[kind]||MARKS.empty)+'<span>'+(CAPTIONS[kind]||CAPTIONS.empty)+'</span></span>';
    if (checks>0) html+='<span class="tip-checks"><b>'+checks+'</b> checks</span>';
    if (lat) html+=latencyHtml(lat);
    return html;
  }
  function tipText(kind, iso, checks, lat){
    var text=longDate(iso)+". "+(CAPTIONS[kind]||CAPTIONS.empty)+".";
    if (checks>0) text+=" "+checks+" checks.";
    if (lat) text+=" Latency min "+ms(Math.min(lat[0],lat[1],lat[2]))+", avg "+ms(lat[0])+", max "+ms(Math.max(lat[0],lat[1],lat[2]))+".";
    return text;
  }
`;

/**
 * Turns the UTC times the server writes into the reader's own. Kept apart from
 * the rest of the client so the wording can be tested. Times within a day also
 * say how long ago, or how far off, they are.
 */
export const LOCAL_TIME_SCRIPT = `
  function timeAgo(at, now){
    var d=now-at, a=Math.abs(d);
    if (!isFinite(a) || a>=86400000) return "";
    if (a<45000) return "just now";
    var n=a<3600000?Math.max(1, Math.floor(a/60000)):Math.floor(a/3600000), unit=a<3600000?"min":"hr";
    return d>0?n+" "+unit+" ago":"in "+n+" "+unit;
  }
  function localTime(at, zone){
    try {
      return new Intl.DateTimeFormat(undefined, {year:"numeric", month:"short", day:"numeric", hour:"numeric", minute:"2-digit", timeZoneName:"short", timeZone:zone}).format(new Date(at));
    } catch (e) { return ""; }
  }
  /* The UTC text stays as the tooltip, and is all a reader without scripting sees. A notice that is read out when it changes gets no running "ago". */
  function localTimes(){
    var list=document.querySelectorAll("time[datetime]"), now=Date.now();
    for (var i=0;i<list.length;i++){
      var el=list[i], at=Date.parse(el.getAttribute("datetime")||""), text=isFinite(at)?localTime(at):"";
      if (!text) continue;
      if (!el.title) el.title=el.textContent;
      var ago=el.closest('[role="status"]')?"":timeAgo(at, now);
      if (ago) text+=" ("+ago+")";
      if (el.textContent!==text) el.textContent=text;
    }
  }
`;

/**
 * What every public page runs, the history and incident pages included: the
 * appearance toggle and local times. These are statements, not a program.
 * LIVE_CLIENT_SCRIPT carries them inside its own scope and PAGE_CLIENT_SCRIPT
 * wraps them for the pages that have no live blocks.
 */
const PAGE_CLIENT = `
  function theme(){ return document.documentElement.getAttribute("data-theme")==="dark"?"dark":"light"; }
  function syncThemeBtn(){
    var b=document.querySelector(".theme-toggle");
    if (!b) return;
    var t=theme();
    b.setAttribute("aria-label", t==="dark"?"Use light appearance":"Use dark appearance");
    if (window.__fwGlobe) window.__fwGlobe.paint();
  }
  function applyTheme(t){
    document.documentElement.setAttribute("data-theme", t);
    document.documentElement.style.colorScheme=t;
    try { localStorage.setItem("foxwatch-theme", t); } catch (e) {}
    var m=document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", t==="dark"?"#2c2b28":"#efece6");
    syncThemeBtn();
  }
  document.addEventListener("click", function(e){
    var el=e.target;
    if (!el || !el.closest) return;
    var b=el.closest(".theme-toggle");
    if (!b) return;
    applyTheme(theme()==="dark"?"light":"dark");
  });
  window.addEventListener("storage", function(e){
    if (e.key==="foxwatch-theme" && (e.newValue==="light"||e.newValue==="dark")) applyTheme(e.newValue);
  });
  syncThemeBtn();
  ${LOCAL_TIME_SCRIPT}
  localTimes();
  setInterval(localTimes, 60000);
`;

export const PAGE_CLIENT_SCRIPT = `(function(){${PAGE_CLIENT}})();`;

/**
 * Page client. The socket carries small notices from the hub (see liveNotice);
 * anything a notice leaves out is fetched from LIVE_JSON_PATH, which is
 * also what the page falls back to while the socket is down.
 */
export const LIVE_CLIENT_SCRIPT = `(function(){
  var doc=document.documentElement;
  var etag=doc.getAttribute("data-etag")||"", at=+doc.getAttribute("data-at")||0;
  var iconSrc, faviconGen=0;
  function fileDrag(e){ return e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.indexOf("Files")>=0; }
  window.addEventListener("dragover", function(e){ if (fileDrag(e)) e.preventDefault(); });
  window.addEventListener("drop", function(e){ if (fileDrag(e)) e.preventDefault(); });
  ${PAGE_CLIENT}
  function statusDot(b){
    return b==="failing"?"${statusDotColor("failing")}":b==="degraded"?"${statusDotColor("degraded")}":b==="fully_operational"?"${statusDotColor("fully_operational")}":"${statusDotColor("unknown")}";
  }
  function clipSquircle(ctx,ox,oy,size){
    var n=5, steps=64, rad=size/2, i, t, c, s, x, y;
    ctx.beginPath();
    for (i=0;i<=steps;i++){
      t=i/steps*Math.PI*2;
      c=Math.cos(t); s=Math.sin(t);
      x=ox+rad+(c<0?-1:1)*rad*Math.pow(Math.abs(c),2/n);
      y=oy+rad+(s<0?-1:1)*rad*Math.pow(Math.abs(s),2/n);
      if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.closePath();
    ctx.clip();
  }
  function setStatusFavicon(src,banner){
    if (!src) return;
    iconSrc=src;
    var gen=++faviconGen;
    var img=new Image();
    img.onload=function(){
      if (gen!==faviconGen) return;
      var size=64, icon=50, origin=(size-icon)/2, c=document.createElement("canvas");
      c.width=size; c.height=size;
      var ctx=c.getContext("2d");
      if (!ctx) return;
      var iw=img.naturalWidth||icon, ih=img.naturalHeight||icon;
      var s=Math.max(icon/iw, icon/ih), w=iw*s, h=ih*s;
      ctx.save();
      clipSquircle(ctx,origin,origin,icon);
      ctx.drawImage(img, origin+(icon-w)/2, origin+(icon-h)/2, w, h);
      ctx.restore();
      var r=8, stroke=3, overlap=3, x=Math.min(size-r-stroke/2, origin+icon-overlap), y=x;
      ctx.beginPath();
      ctx.arc(x,y,r,0,Math.PI*2);
      ctx.fillStyle=statusDot(banner);
      ctx.fill();
      ctx.lineWidth=stroke;
      ctx.strokeStyle="#f7f4ee";
      ctx.stroke();
      var links=document.querySelectorAll('link[rel="icon"]');
      for (var i=0;i<links.length;i++) links[i].parentNode.removeChild(links[i]);
      var link=document.createElement("link");
      link.rel="icon";
      link.type="image/png";
      link.href=c.toDataURL("image/png");
      document.head.appendChild(link);
    };
    img.src=src;
  }
  var iconLink=document.querySelector('link[rel="icon"]');
  iconSrc=iconLink && iconLink.getAttribute("href") || "/fox.png";
  setStatusFavicon(iconSrc, doc.getAttribute("data-banner")||"unknown");
  function groups(){
    var out=[], nodes=document.querySelectorAll("#live-systems details[open]");
    for (var i=0;i<nodes.length;i++){
      var wrap=nodes[i].closest("[data-group]");
      if (wrap && wrap.getAttribute("data-group")) out.push(wrap.getAttribute("data-group"));
    }
    return out;
  }
  function groupEl(root, id){
    var all=root.querySelectorAll("[data-group]");
    for (var i=0;i<all.length;i++) if (all[i].getAttribute("data-group")===id) return all[i];
    return null;
  }
  function restore(ids){
    var root=document.getElementById("live-systems");
    if (!root || !ids.length) return;
    root.classList.add("is-restoring");
    for (var i=0;i<ids.length;i++){
      var wrap=groupEl(root, ids[i]), el=wrap && wrap.querySelector("details");
      if (el) el.open=true;
    }
    requestAnimationFrame(function(){
      requestAnimationFrame(function(){ root.classList.remove("is-restoring"); });
    });
  }
  var BLOCKS=[["banner","live-banner"],["brand","live-brand"],["systems","live-systems"],["mesh","live-mesh"],["history","live-history"],["maintenance","live-maintenance"]];
  var LIVE="#live-banner,#live-brand,#live-systems,#live-mesh,#live-history,#live-maintenance";
  var FOCUSABLE="summary,a[href],button,[tabindex]";
  /* Where keyboard focus sits inside a live block, in terms that survive the block being replaced. */
  function focusMark(){
    var el=document.activeElement, block=el && el.closest ? el.closest(LIVE) : null;
    if (!block) return null;
    var wrap=el.closest("[data-group]"), list=(wrap||block).querySelectorAll(FOCUSABLE), index=-1;
    for (var i=0;i<list.length;i++) if (list[i]===el) index=i;
    return { id:block.id, group:wrap?wrap.getAttribute("data-group"):null, region:el.getAttribute("data-region"), index:index };
  }
  function refocus(m){
    if (!m) return;
    var now=document.activeElement;
    if (now && now!==document.body && now!==doc) return;
    var block=document.getElementById(m.id), el=null;
    if (!block) return;
    if (m.region){
      var nodes=block.querySelectorAll(".mesh-node");
      for (var i=0;i<nodes.length;i++) if (nodes[i].getAttribute("data-region")===m.region) el=nodes[i];
    } else if (m.index>=0){
      var scope=m.group?groupEl(block, m.group):block;
      if (scope) el=scope.querySelectorAll(FOCUSABLE)[m.index]||null;
    }
    if (el && el.focus){ try { el.focus({preventScroll:true}); } catch (e) {} }
  }
  /* The banner section is the page's live region. It stays in the document and only its contents change, so a screen reader announces a new status once and nothing when the status is the same. */
  function patchBanner(el, next){
    var cur=el.querySelector(".banner"), neu=next.querySelector(".banner");
    if (!cur || !neu){ el.replaceWith(next); return; }
    if (cur.className!==neu.className) cur.className=neu.className;
    if (cur.innerHTML!==neu.innerHTML) cur.innerHTML=neu.innerHTML;
    while (cur.nextSibling) el.removeChild(cur.nextSibling);
    while (neu.nextSibling) el.appendChild(neu.nextSibling);
    el.setAttribute("data-rev", next.getAttribute("data-rev")||"");
  }
  /* 0: the block is out of date and the message has no markup for it. 1: already current. 2: replaced. */
  function swap(id, html, rev){
    var el=document.getElementById(id);
    if (!el) return 1;
    if (rev && el.getAttribute("data-rev")===rev) return 1;
    if (!html) return 0;
    var box=document.createElement("div");
    box.innerHTML=html;
    var next=box.firstElementChild;
    if (!next) return 0;
    if (id==="live-banner") patchBanner(el, next); else el.replaceWith(next);
    return 2;
  }
  var behind=false;
  function apply(msg){
    if (!msg || !msg.etag || msg.etag===etag) return;
    /* Older than what is on screen: a notice replayed to a page that was rendered after it, or an edge copy that has not caught up. */
    if (msg.generatedAt<at) return;
    if (msg.generatedAt) at=msg.generatedAt;
    var revs=msg.revs||{}, open=groups(), focus=focusMark(), done={}, missing=false;
    for (var i=0;i<BLOCKS.length;i++){
      var key=BLOCKS[i][0];
      done[key]=swap(BLOCKS[i][1], msg[key], revs[key]);
      if (!done[key]) missing=true;
    }
    if (done.systems===2){ dropTip(); restore(open); }
    if (done.mesh===2){ bindMesh(); placeYou(hereCache); }
    refocus(focus);
    localTimes();
    if (msg.title) document.title=msg.title;
    if (msg.icon) iconSrc=msg.icon;
    if (msg.status){
      doc.setAttribute("data-banner", msg.status);
      setStatusFavicon(iconSrc, msg.status);
    } else if (msg.icon){
      setStatusFavicon(iconSrc, doc.getAttribute("data-banner")||"unknown");
    }
    if (msg.description){
      var meta=document.querySelector('meta[name="description"]');
      if (meta) meta.setAttribute("content", msg.description);
    }
    behind=missing;
    if (!missing){ etag=msg.etag; pullWait=0; }
  }
  var pulling=false, pullTimer=0, pullAt=0, pullWait=0;
  function jitter(n){ return n*(0.5+Math.random()); }
  function later(wait){
    var when=Date.now()+wait;
    if (pullTimer){
      if (pullAt<=when) return;
      clearTimeout(pullTimer);
    }
    pullAt=when;
    pullTimer=setTimeout(pull, wait);
  }
  function settle(){
    /* Still missing blocks: the copy at the edge was older than the notice. Ask again, a little slower each time. */
    if (behind){ pullWait=Math.min((pullWait||2500)*2, 30000); later(jitter(pullWait)); }
    else if (!ws || ws.readyState!==1) later(jitter(60000));
  }
  function pull(){
    pullTimer=0;
    if (pulling) return;
    pulling=true;
    fetch("${LIVE_JSON_PATH}", {headers:{accept:"application/json"}, cache:"no-cache"})
      .then(function(r){ return r.ok?r.json():null; })
      .then(function(p){ pulling=false; if (p){ heard(); apply(p); } settle(); })
      .catch(function(){ pulling=false; settle(); });
  }
  var ws=null, pinger=0, retry=0, delay=1000, seen=Date.now(), woke=Date.now();
  var QUIET_MS=70000, STALE_MS=90000;
  function heard(){ seen=Date.now(); showConn(); }
  /* Says so when nothing has been heard from the server for a while, so an old "operational" is not read as current. */
  function showConn(){
    var el=document.getElementById("live-conn");
    if (!el) return;
    if (Date.now()-Math.max(seen, woke)<=STALE_MS){ if (!el.hidden) el.hidden=true; return; }
    var text="Live updates are paused. Last updated "+new Date(seen).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"})+". Reconnecting.";
    if (el.textContent!==text) el.textContent=text;
    if (el.hidden) el.hidden=false;
  }
  function reconnect(){
    if (!retry) retry=setTimeout(function(){ retry=0; connect(); }, jitter(delay));
    delay=Math.min(delay*2, 30000);
  }
  function closed(sock){
    if (sock!==ws) return;
    ws=null;
    if (pinger){ clearInterval(pinger); pinger=0; }
    /* Every page loses the socket together when the Worker is deployed, so neither the fallback poll nor the reconnect runs on a fixed beat. */
    later(Math.random()*10000);
    reconnect();
  }
  /* A socket that has gone quiet is not waited on: its close handshake may never finish. */
  function drop(){
    var sock=ws;
    if (!sock) return;
    sock.onopen=sock.onmessage=sock.onclose=sock.onerror=null;
    try { sock.close(); } catch (e) {}
    closed(sock);
  }
  function connect(){
    if (ws) return;
    var sock;
    try {
      sock=new WebSocket((location.protocol==="https:"?"wss:":"ws:")+"//"+location.host+"${LIVE_SOCKET_PATH}");
    } catch (e) {
      reconnect();
      return;
    }
    ws=sock;
    sock.onopen=function(){
      delay=1000;
      heard();
      if (pullTimer && !behind){ clearTimeout(pullTimer); pullTimer=0; }
    };
    sock.onmessage=function(ev){
      heard();
      if (ev.data==="pong") return;
      try { apply(JSON.parse(ev.data)); } catch (e) {}
      if (behind){ pullWait=0; later(Math.random()*3000); }
    };
    sock.onclose=function(){ closed(sock); };
    pinger=setInterval(function(){
      if (sock.readyState!==1) return;
      if (Date.now()-seen>QUIET_MS){ drop(); return; }
      try { sock.send("ping"); } catch (e) {}
    }, 25000);
  }
  /* Back from sleep, a hidden tab or a lost network: do not sit out a backoff, and do not trust a socket that only looks open. */
  function wake(){
    if (document.visibilityState==="hidden") return;
    woke=Date.now();
    if (!ws){
      if (retry){ clearTimeout(retry); retry=0; }
      delay=1000;
      connect();
      return;
    }
    if (ws.readyState>1){ drop(); return; }
    if (ws.readyState!==1) return;
    var sock=ws, asked=Date.now();
    try { sock.send("ping"); } catch (e) {}
    setTimeout(function(){ if (sock===ws && seen<asked) drop(); }, 5000);
  }
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", wake);
  window.addEventListener("pageshow", function(e){ if (e.persisted) wake(); });
  setInterval(showConn, 15000);
  var hereCache=null, meshBound=null;
  function projectHere(plot, lng, lat){
    var p=(plot.getAttribute("data-proj")||"").split(",");
    if (p.length<8) return null;
    var west=+p[0], east=+p[1], north=+p[2], south=+p[3], x0=+p[4], x1=+p[5], y0=+p[6], y1=+p[7];
    if (!(east-west) || !(north-south)) return null;
    var x=x0+(lng-west)/(east-west)*(x1-x0);
    var y=y0+(north-lat)/(north-south)*(y1-y0);
    return { x:Math.max(1,Math.min(99,x)), y:Math.max(1,Math.min(99,y)) };
  }
  function km(aLat, aLng, bLat, bLng){
    var r=Math.PI/180, dLat=(bLat-aLat)*r, dLng=(bLng-aLng)*r;
    var s=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(aLat*r)*Math.cos(bLat*r)*Math.sin(dLng/2)*Math.sin(dLng/2);
    return 2*6371*Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function meshRoot(){ return document.getElementById("live-mesh"); }
  function setMeshOn(id){
    var root=meshRoot();
    if (!root || root.hasAttribute("hidden")) return;
    var plot=root.querySelector(".mesh-plot");
    var out=root.querySelector(".mesh-readout");
    if (!plot || !out) return;
    var base=out.getAttribute("data-base")||"";
    var nodes=plot.querySelectorAll(".mesh-node");
    var arcs=plot.querySelectorAll(".mesh-arc");
    var on=false, read=base;
    for (var i=0;i<nodes.length;i++){
      var n=nodes[i];
      var match=!!id && n.getAttribute("data-region")===id;
      n.classList.toggle("is-on", match);
      if (match){ on=true; read=n.getAttribute("data-read")||base; }
    }
    for (var j=0;j<arcs.length;j++){
      var a=arcs[j];
      a.classList.toggle("is-on", !!id && (a.getAttribute("data-a")===id || a.getAttribute("data-b")===id));
    }
    plot.classList.toggle("is-hot", on);
    out.textContent=on?read:base;
    var pills=document.querySelectorAll(".impact-pill[data-region]");
    for (var k=0;k<pills.length;k++) pills[k].classList.toggle("is-on", !!id && pills[k].getAttribute("data-region")===id);
  }
  function bindMesh(){
    var root=meshRoot();
    if (meshBound){ meshBound(); meshBound=null; }
    if (!root || root.hasAttribute("hidden")) return;
    var plot=root.querySelector(".mesh-plot");
    if (!plot) return;
    var fine=window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    var onMove=function(e){
      var nodes=plot.querySelectorAll(".mesh-node");
      var r=plot.getBoundingClientRect();
      if (!r.width || !r.height || !nodes.length) return;
      var x=(e.clientX-r.left)/r.width*100, y=(e.clientY-r.top)/r.height*100;
      var best=null, bestD=1e9;
      for (var i=0;i<nodes.length;i++){
        var n=nodes[i], nx=parseFloat(n.style.left), ny=parseFloat(n.style.top);
        var d=(nx-x)*(nx-x)+(ny-y)*(ny-y);
        if (d<bestD){ bestD=d; best=n.getAttribute("data-region"); }
      }
      setMeshOn(best);
    };
    var onLeave=function(){ setMeshOn(null); };
    var onFocus=function(e){
      var t=e.target;
      if (t && t.getAttribute) setMeshOn(t.getAttribute("data-region"));
    };
    if (fine){
      plot.addEventListener("pointermove", onMove);
      plot.addEventListener("pointerleave", onLeave);
    }
    var onClick=function(e){
      var t=e.target;
      if (!t || !t.closest) return;
      var n=t.closest(".mesh-node");
      if (n) setMeshOn(n.getAttribute("data-region"));
    };
    plot.addEventListener("focusin", onFocus);
    plot.addEventListener("focusout", onLeave);
    plot.addEventListener("click", onClick);
    meshBound=function(){
      plot.removeEventListener("pointermove", onMove);
      plot.removeEventListener("pointerleave", onLeave);
      plot.removeEventListener("focusin", onFocus);
      plot.removeEventListener("focusout", onLeave);
      plot.removeEventListener("click", onClick);
    };
  }
  function placeYou(h){
    if (h){ hereCache=h; window.__fwHere=h; }
    var root=meshRoot();
    if (!root || root.hasAttribute("hidden") || !h){
      if (window.__fwGlobe) window.__fwGlobe.refresh();
      return;
    }
    var plot=root.querySelector(".mesh-plot");
    var out=root.querySelector(".mesh-readout");
    var you=root.querySelector(".mesh-you");
    var hop=root.querySelector(".mesh-hop");
    if (!plot || !out){
      if (window.__fwGlobe) window.__fwGlobe.refresh();
      return;
    }
    var base=out.getAttribute("data-base")||"";
    var youName=h.city||h.colo;
    var nodes=plot.querySelectorAll(".mesh-node");
    var nearest=null, nearestNode=null, nearestD=1e9;
    if (h.lat!=null && h.lng!=null){
      for (var i=0;i<nodes.length;i++){
        var n=nodes[i], lat=+n.getAttribute("data-lat"), lng=+n.getAttribute("data-lng");
        if (!isFinite(lat) || !isFinite(lng)) continue;
        var d=km(h.lat, h.lng, lat, lng);
        if (d<nearestD){ nearestD=d; nearest=n.getAttribute("data-region"); nearestNode=n; }
      }
    }
    if (youName){
      var extra="You · "+youName;
      if (nearestNode) extra+=" · nearest "+(nearestNode.getAttribute("data-label")||nearest);
      var next=base?base+" · "+extra:extra;
      out.setAttribute("data-base", next);
      if (!plot.classList.contains("is-hot")) out.textContent=next;
    }
    if (you && h.lat!=null && h.lng!=null){
      var p=projectHere(plot, h.lng, h.lat);
      if (p){
        you.style.left=p.x+"%";
        you.style.top=p.y+"%";
        you.hidden=false;
        if (hop && nearestNode){
          var nx=parseFloat(nearestNode.style.left), ny=parseFloat(nearestNode.style.top);
          hop.setAttribute("d", "M"+p.x.toFixed(2)+" "+p.y.toFixed(2)+" L"+nx+" "+ny);
          hop.removeAttribute("hidden");
        }
      }
    }
    if (window.__fwGlobe) window.__fwGlobe.refresh();
  }
  function fetchHere(){
    fetch("/api/here.json", {headers:{accept:"application/json"}}).then(function(r){ return r.ok?r.json():null; }).then(placeYou).catch(function(){});
  }
  ${DAY_TIP_SCRIPT}
  var tip=null, tipDay=null, say=null;
  function dayKind(d){
    return d.classList.contains("ok")?"ok":d.classList.contains("warn")?"warn":d.classList.contains("bad")?"bad":"empty";
  }
  function dayDate(d){
    var own=d.getAttribute("data-d");
    if (own) return own;
    var from=d.parentNode && d.parentNode.getAttribute("data-from");
    if (!from) return "";
    var i=0, n=d, p=from.split("-");
    while ((n=n.previousElementSibling)) i++;
    return new Date(Date.UTC(+p[0],(+p[1]||1)-1,(+p[2]||1)+i)).toISOString().slice(0,10);
  }
  function dropTip(){
    if (tip) tip.classList.remove("is-on");
    if (tipDay) tipDay.classList.remove("is-tip");
    tipDay=null;
  }
  function showTip(d, spoken){
    if (tipDay===d && tip && tip.parentNode===d) return;
    if (!tip){
      tip=document.createElement("span");
      tip.className="tip";
      tip.setAttribute("aria-hidden","true");
    }
    var kind=dayKind(d), iso=dayDate(d), checks=+d.getAttribute("data-c")||0, lat=parseLatency(d.getAttribute("data-l"));
    if (tipDay) tipDay.classList.remove("is-tip");
    tip.innerHTML=tipHtml(kind, iso, checks, lat);
    tip.style.translate="";
    d.appendChild(tip);
    d.classList.add("is-tip");
    tip.classList.add("is-on");
    tipDay=d;
    /* On a narrow screen a tooltip near the middle of the bar is wider than the room beside it. */
    var r=tip.getBoundingClientRect(), room=doc.clientWidth-8;
    var dx=r.left<8?8-r.left:r.right>room?room-r.right:0;
    if (dx) tip.style.translate=Math.round(dx)+"px 0";
    if (spoken){
      if (!say){
        say=document.createElement("div");
        say.className="mesh-sr";
        say.setAttribute("aria-live","polite");
        document.body.appendChild(say);
      }
      say.textContent=tipText(kind, iso, checks, lat);
    }
  }
  function barOf(t){ return t && t.classList && t.classList.contains("bar") ? t : null; }
  function dayOf(t){ return t && t.closest ? t.closest(".day") : null; }
  function inBar(t){ return !!(t && t.closest && t.closest(".bar")); }
  function byKeyboard(el){ try { return el.matches(":focus-visible"); } catch (e) { return true; } }
  /* Mouse and pen hover; a touch has no hover and is handled as a tap below. */
  document.addEventListener("pointerover", function(e){
    if (e.pointerType==="touch") return;
    var d=dayOf(e.target);
    if (d) showTip(d);
    else if (tipDay && !inBar(e.target)) dropTip();
  });
  document.addEventListener("click", function(e){
    var d=dayOf(e.target);
    if (d) showTip(d);
    else if (tipDay && !inBar(e.target)) dropTip();
  });
  /* A bar is one tab stop. The arrow keys, Home and End walk its days. */
  document.addEventListener("focusin", function(e){
    var bar=barOf(e.target);
    if (bar && bar.lastElementChild && byKeyboard(bar)) showTip(bar.lastElementChild, true);
  });
  document.addEventListener("focusout", function(e){ if (barOf(e.target)) dropTip(); });
  document.addEventListener("keydown", function(e){
    var bar=barOf(e.target);
    if (!bar) return;
    if (e.key==="Escape"){ dropTip(); return; }
    var days=bar.children, last=days.length-1, i=last;
    if (last<0) return;
    if (e.key!=="ArrowLeft" && e.key!=="ArrowRight" && e.key!=="Home" && e.key!=="End") return;
    e.preventDefault();
    if (tipDay && tipDay.parentNode===bar){
      var n=tipDay;
      i=0;
      while ((n=n.previousElementSibling)) i++;
      if (e.key==="ArrowLeft") i--;
      else if (e.key==="ArrowRight") i++;
    }
    if (e.key==="Home") i=0;
    else if (e.key==="End") i=last;
    showTip(days[Math.max(0, Math.min(last, i))], true);
  });
  window.__fwPickRegion = setMeshOn;
  bindMesh();
  fetchHere();
  connect();
})();`;

const THEME_BOOT = `(function(){try{var k="foxwatch-theme",t=localStorage.getItem(k);if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.setAttribute("data-theme",t);document.documentElement.style.colorScheme=t;var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",t==="dark"?"#2c2b28":"#efece6");}catch(e){}requestAnimationFrame(function(){document.documentElement.classList.add("theme-ready");});})();`;

/**
 * Runs before the first paint on a page that carries the globe. It marks the
 * document as one where a globe is on its way, which is what lets the
 * stylesheet put the flat map aside, and reserves the room the globe will take.
 * Without scripting the mark is never made and the map is shown as usual.
 */
export const GUTTER_BOOT = `(function(){try{document.documentElement.classList.add("globe-on");if(!matchMedia("(min-width: 1100px) and (hover: hover) and (pointer: fine)").matches)return;var w=Math.max(1,Math.round(document.documentElement.clientWidth||innerWidth)),h=Math.max(1,Math.round(document.documentElement.clientHeight||innerHeight)),rem=parseFloat(getComputedStyle(document.documentElement).fontSize)||16,pad=24,envelope=1.16;function mix(a,b,t){t=t<0?0:t>1?1:t;return a+(b-a)*t;}var t1280=(w-1100)/180,t1440=(w-1280)/160,widthFrac=mix(0.4,mix(0.43,0.46,t1440),t1280),radius=Math.min(h*mix(0.7,0.78,t1280),rem*mix(32,38,t1280))*0.48,targetCy=h*mix(0.36,0.4,t1280),maxR=Math.min((w*widthFrac)/envelope,Math.max(8,(targetCy-pad)/envelope),Math.max(8,(h-pad-targetCy)/envelope));if(maxR>0&&radius>maxR)radius=maxR;if(!(radius>0)||!isFinite(radius))radius=80;var cy=targetCy,minCy=pad+radius*envelope,maxCy=h-pad-radius*envelope;if(minCy<=maxCy)cy=Math.min(maxCy,Math.max(minCy,cy));else cy=h/2;var cx=w-pad-radius*envelope;if(cx+radius*envelope>w-pad)cx=w-pad-radius*envelope;if(cx-radius*envelope<pad)radius=Math.max(8,Math.min(radius,(cx-pad)/envelope));var root=document.documentElement;root.style.setProperty("--globe-left",Math.round(cx-radius)+"px");root.style.setProperty("--globe-cx",Math.round(cx)+"px");root.style.setProperty("--globe-cy",Math.round(cy)+"px");}catch(e){}})();`;

/** Incidents used to be anchors on the status page. A link to one is sent on to the incident's own page. */
const INCIDENT_HASH_REDIRECT = `(function(){var m=location.hash.match(/^#incident-([A-Za-z0-9_-]{8,64})$/);if(m)location.replace("/incidents/"+m[1]);})();`;

const THEME_TOGGLE = `<button type="button" class="theme-toggle" aria-label="Use dark appearance"><span class="theme-icon theme-icon-moon" aria-hidden="true"></span><span class="theme-icon theme-icon-sun" aria-hidden="true"></span></button>`;

type PageHead = {
  title: string;
  description: string;
  /** The page's own address, e.g. "/history". With the origin it makes the canonical and og:url. */
  path: string;
  /** Scheme and host the page was asked for at. Link previews need absolute addresses; without it they are left out. */
  origin?: string;
  type?: "website" | "article";
  /** A page that stands for nothing, such as an incident that is gone. */
  noindex?: boolean;
};

/**
 * The part of <head> the three pages share. Link previews (Slack, Discord,
 * social cards) read the og: and twitter: tags, and feed readers find
 * /feed.xml through the alternate link.
 */
function renderHead(snap: PublicSnapshot, head: PageHead): string {
  const origin = head.origin?.replace(/\/+$/, "");
  const title = escapeHtml(head.title);
  const description = escapeHtml(head.description);
  const absolute = origin
    ? `
  <link rel="canonical" href="${escapeHtml(origin + head.path)}"/>
  <meta property="og:url" content="${escapeHtml(origin + head.path)}"/>
  <meta property="og:image" content="${escapeHtml(origin + pageIcon(snap))}"/>`
    : "";
  return `<meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="theme-color" content="#efece6"/>
  <title>${title}</title>
  <meta name="description" content="${description}"/>${head.noindex ? `
  <meta name="robots" content="noindex"/>` : ""}
  <meta property="og:site_name" content="${escapeHtml(snap.siteName)}"/>
  <meta property="og:type" content="${head.type ?? "website"}"/>
  <meta property="og:title" content="${title}"/>
  <meta property="og:description" content="${description}"/>${absolute}
  <meta name="twitter:card" content="summary"/>
  <link rel="alternate" type="application/rss+xml" title="${escapeHtml(`${snap.siteName} incidents`)}" href="/feed.xml"/>
  <link rel="icon" href="${escapeHtml(pageIcon(snap))}"/>
  <script>${THEME_BOOT}</script>`;
}

const PREVIEW_MAX = 200;

/** What a link preview says about an incident: where it stands, then the latest update in the operator's words. */
function incidentSummary(incident: PublicIncident): string {
  const state = `${incidentStatusLabel(incident.status)} - ${impactLabel(incident.impact)}`;
  const latest = incident.updates[incident.updates.length - 1]?.body.replace(/\s+/g, " ").trim() ?? "";
  if (!latest) return state;
  return `${state}. ${latest.length > PREVIEW_MAX ? `${latest.slice(0, PREVIEW_MAX - 1).trimEnd()}…` : latest}`;
}

function globeEnabled(snap: PublicSnapshot): boolean {
  return snap.globe !== false;
}

let globeLand: string | undefined;

/** Coastlines for the globe, as the JSON both renderers read from #globe-land. */
export function globeLandJson(): string {
  return (globeLand ??= JSON.stringify(landRings()));
}

let globeVersions: { land: string; flat: string } | undefined;

/** Both globe files change only with a deploy, so each is addressed by a hash of its content. */
export function globeAssetVersions(): { land: string; flat: string } {
  return (globeVersions ??= { land: fnv1a(globeLandJson()), flat: fnv1a(GLOBE_CLIENT_SCRIPT) });
}

/**
 * The globe stands in for the flat region map on a wide screen with a mouse;
 * everywhere else the map is what is shown. So the coastlines and both
 * renderers are fetched only once that media query matches, and a phone
 * downloads none of them. The canvas renderer goes first because the WebGPU
 * module hands over to it when it cannot start. If neither renderer arrives,
 * the mark GUTTER_BOOT made is taken back and the flat map is shown after all.
 */
function globeLoaderScript(): string {
  const v = globeAssetVersions();
  return `(function(){
  var mq=window.matchMedia("(min-width: 1100px) and (hover: hover) and (pointer: fine)"), started=false;
  function load(src, module, done){
    var el=document.createElement("script");
    if (module) el.type="module";
    el.src=src;
    if (done){ el.onload=done; el.onerror=done; }
    document.body.appendChild(el);
  }
  function noGlobe(){ document.documentElement.classList.remove("globe-on"); }
  function start(){
    if (started || !mq.matches) return;
    started=true;
    fetch("/api/globe/land.json?v=${v.land}").then(function(r){ return r.ok?r.text():"[]"; }).catch(function(){ return "[]"; }).then(function(land){
      var el=document.createElement("script");
      el.type="application/json";
      el.id="globe-land";
      el.textContent=land;
      document.body.appendChild(el);
      load("/api/globe/2d.js?v=${v.flat}", false, function(e){
        /* Without the canvas renderer only WebGPU can draw the globe. If that cannot start either, the flat map comes back. */
        var flat=!(e && e.type==="error");
        if (!flat) window.addEventListener("fw-globe-fallback", noGlobe);
        load("${GLOBE_MODULE_SRC}", true, function(e){ if (!flat && e && e.type==="error") noGlobe(); });
      });
    });
  }
  mq.addEventListener("change", start);
  start();
})();`;
}

/**
 * Every inline script a public page can carry, character for character as it
 * sits between its tags. The Content-Security-Policy lists a hash of each and
 * allows no other inline script, so a script that is added to a page and not
 * to this list does not run.
 */
export function publicInlineScripts(): string[] {
  return [
    THEME_BOOT,
    INCIDENT_HASH_REDIRECT,
    GUTTER_BOOT,
    LIVE_CLIENT_SCRIPT,
    `${LIVE_CLIENT_SCRIPT}${globeLoaderScript()}`,
    PAGE_CLIENT_SCRIPT,
  ];
}

function renderGlobeScripts(snap: PublicSnapshot): string {
  if (!globeEnabled(snap)) return `<script>${LIVE_CLIENT_SCRIPT}</script>`;
  return `<aside class="globe-stage" id="globe-stage" hidden aria-hidden="true"></aside>
  <script>${LIVE_CLIENT_SCRIPT}${globeLoaderScript()}</script>`;
}

export function renderPublicHtml(snap: PublicSnapshot, origin?: string): string {
  const globe = globeEnabled(snap);
  return `<!doctype html>
<html lang="en" data-banner="${escapeHtml(snap.banner)}" data-etag="${snapshotEtag(snap)}" data-at="${Number(snap.generatedAt) || 0}">
<head>
  ${renderHead(snap, { title: `${snap.siteName} status`, description: LABELS[snap.banner], path: "/", origin })}
  <script>${INCIDENT_HASH_REDIRECT}</script>
  <style>${STYLES}</style>
  ${globe ? `<script>${GUTTER_BOOT}</script>` : ""}
  <noscript><meta http-equiv="refresh" content="60"/></noscript>
</head>
<body>
  <div class="wrap">
    <header class="top">
      ${renderBrandBlock(snap)}
      ${THEME_TOGGLE}
    </header>
    <main>
      ${renderBannerBlock(snap)}
      <p class="stale" id="live-conn" role="status" hidden></p>
      ${renderMeshBlock(snap)}
      ${renderSystemsBlock(snap)}
      ${renderMaintenanceBlock(snap)}
      ${renderHistoryBlock(snap)}
    </main>
    <footer class="foot">
      <p><a class="by" href="https://github.com/hypervoid-inc/foxwatch" target="_blank" rel="noopener noreferrer">${FOOT_FOX}Powered by Foxwatch</a></p>
      <p class="disclaimer">Availability is measured from Cloudflare's edge. Figures are aggregated across regions and checks; individual experience may vary by path and location.</p>
    </footer>
  </div>
  ${renderGlobeScripts(snap)}
</body>
</html>`;
}

export function renderHistoryPage(snap: PublicSnapshot, origin?: string): string {
  return `<!doctype html>
<html lang="en" data-banner="${escapeHtml(snap.banner)}">
<head>
  ${renderHead(snap, { title: `Incident history - ${snap.siteName}`, description: `Full incident history for ${snap.siteName}`, path: "/history", origin })}
  <style>${STYLES}</style>
</head>
<body>
  <div class="wrap">
    <header class="top">
      ${renderBrandBlock(snap)}
      ${THEME_TOGGLE}
    </header>
    <main>
      <a class="back-link" href="/"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M7.5 2.5 4 6l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>Back to status</a>
      <section class="card" aria-labelledby="history-title">
        <div class="card-head"><h1 id="history-title">Incident history</h1></div>
        ${renderIncidents(snap.incidents)}
      </section>
    </main>
    <footer class="foot">
      <p><a class="by" href="https://github.com/hypervoid-inc/foxwatch" target="_blank" rel="noopener noreferrer">${FOOT_FOX}Powered by Foxwatch</a></p>
      <p class="disclaimer">Availability is measured from Cloudflare's edge. Figures are aggregated across regions and checks; individual experience may vary by path and location.</p>
    </footer>
  </div>
  <script>${PAGE_CLIENT_SCRIPT}</script>
</body>
</html>`;
}

export function renderIncidentPage(snap: PublicSnapshot, incident: PublicIncident | null, origin?: string): string {
  const title = incident ? incident.title : "Incident not found";
  const body = incident
    ? renderIncidentArticle(incident, { linked: false, heading: false })
    : `<p class="quiet">That incident is gone, or the link is no longer valid.</p>`;
  return `<!doctype html>
<html lang="en" data-banner="${escapeHtml(snap.banner)}">
<head>
  ${renderHead(snap, {
    title: `${title} - ${snap.siteName}`,
    description: incident ? incidentSummary(incident) : `Incident page for ${snap.siteName}`,
    // A missing incident has no address of its own to point a preview or a search engine at.
    path: incident ? incidentPath(incident.id) : "/",
    origin: incident ? origin : undefined,
    type: incident ? "article" : "website",
    noindex: !incident,
  })}
  <style>${STYLES}</style>
</head>
<body>
  <div class="wrap">
    <header class="top">
      ${renderBrandBlock(snap)}
      ${THEME_TOGGLE}
    </header>
    <main>
      <a class="back-link" href="/"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M7.5 2.5 4 6l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>Back to status</a>
      <section class="card" aria-labelledby="incident-title">
        <div class="card-head"><h1 id="incident-title">${escapeHtml(title)}</h1></div>
        ${body}
      </section>
    </main>
    <footer class="foot">
      <p><a class="by" href="https://github.com/hypervoid-inc/foxwatch" target="_blank" rel="noopener noreferrer">${FOOT_FOX}Powered by Foxwatch</a></p>
      <p class="disclaimer">Availability is measured from Cloudflare's edge. Figures are aggregated across regions and checks; individual experience may vary by path and location.</p>
    </footer>
  </div>
  <script>${PAGE_CLIENT_SCRIPT}</script>
</body>
</html>`;
}

/**
 * Badge fills. The favicon dots (statusDotColor) are too light under white
 * 12px text for the two states a badge shows most, so those two are darkened
 * until every fill clears 4.5:1.
 */
export const BADGE_FILL: Record<PublicSnapshot["banner"], string> = {
  unknown: "#64748b",
  fully_operational: "#0b7a5e",
  degraded: "#b45309",
  failing: "#e11d48",
};

const BADGE_MAX_WIDTH = 480;
const BADGE_PAD = 24;
const BADGE_CHAR = 7;

/**
 * Sized from the text as it is read, not as it is escaped, and never wider
 * than BADGE_MAX_WIDTH: a long site name is cut short so the status after it
 * is always shown whole. The full text stays in the label and the tooltip.
 */
export function renderBadge(snap: PublicSnapshot): string {
  const label = LABELS[snap.banner].replace(/\.$/, "");
  const room = Math.floor((BADGE_MAX_WIDTH - BADGE_PAD) / BADGE_CHAR) - label.length - 2;
  const name = [...snap.siteName];
  const shown = name.length > room ? `${name.slice(0, room - 1).join("").trimEnd()}…` : snap.siteName;
  const text = `${shown}: ${label}`;
  const full = escapeHtml(`${snap.siteName}: ${label}`);
  const width = BADGE_PAD + [...text].length * BADGE_CHAR;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${full}">
  <title>${full}</title>
  <rect width="${width}" height="20" rx="3" fill="${BADGE_FILL[snap.banner]}"/>
  <text x="8" y="14" fill="#ffffff" font-size="12" font-family="ui-sans-serif, system-ui, sans-serif">${escapeHtml(text)}</text>
</svg>`;
}

const FEED_MAX_ITEMS = 100;

/**
 * One item per incident update, newest first. A feed reader shows an item once
 * and tells items apart by guid, so an item per incident would announce that an
 * incident opened and never that it moved on or was resolved.
 */
export function renderFeed(snap: PublicSnapshot, origin: string): string {
  const entries = snap.incidents
    .flatMap((i) => {
      const link = `${origin}${incidentPath(i.id)}`;
      const updates = i.updates.length ? i.updates : [{ status: i.status, body: "", at: i.startedAt }];
      return updates.map((u) => ({
        link,
        at: u.at,
        title: `[${incidentStatusLabel(u.status)}] ${i.title}`,
        body: u.body || `${incidentStatusLabel(u.status)} - ${impactLabel(i.impact)}`,
      }));
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, FEED_MAX_ITEMS);
  const items = entries
    .map((e) => `<item>
        <title>${escapeHtml(e.title)}</title>
        <link>${escapeHtml(e.link)}</link>
        <guid isPermaLink="false">${escapeHtml(`${e.link}#${e.at}`)}</guid>
        <pubDate>${escapeHtml(new Date(e.at).toUTCString())}</pubDate>
        <description>${escapeHtml(e.body)}</description>
      </item>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeHtml(snap.siteName)} status</title>
    <link>${escapeHtml(origin)}</link>
    <description>Incident feed</description>
    <atom:link href="${escapeHtml(`${origin}/feed.xml`)}" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${escapeHtml(new Date(entries[0]?.at ?? snap.generatedAt).toUTCString())}</lastBuildDate>
    <ttl>5</ttl>
    ${items}
  </channel>
</rss>`;
}
