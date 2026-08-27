import type { ComponentStatus } from "@foxwatch/config";
import type { PublicComponent, PublicSnapshot } from "@foxwatch/engine";
import { escapeHtml, statusDotColor } from "@foxwatch/engine";

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
  if (n == null) return "—";
  return `${(n * 100).toFixed(2)}%`;
}

function parseUtc(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

function formatLongDate(iso: string): string {
  return parseUtc(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
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

function dayCaption(uptime: number | null, incident: boolean, incidentImpact?: "degraded" | "failing" | null): string {
  const kind = dayKind(uptime, incident, incidentImpact);
  if (kind === "ok") return "No incidents";
  if (kind === "warn") return "Degraded performance";
  if (kind === "bad") return "Outage";
  return "No data";
}

function groupStatus(components: PublicComponent[]): ComponentStatus {
  if (components.some((c) => c.status === "failing")) return "failing";
  if (components.some((c) => c.status === "degraded")) return "degraded";
  if (components.some((c) => c.status === "maintenance")) return "maintenance";
  if (components.length === 0 || components.some((c) => c.status === "unknown")) return "unknown";
  return "operational";
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

function bannerColor(banner: PublicSnapshot["banner"]): string {
  return statusDotColor(banner);
}

function pageIcon(snap: PublicSnapshot): string {
  return snap.iconUrl || "/fox.png";
}

const FOX_MARK = `<img class="fox" src="/fox.png" alt="" width="24" height="24"/>`;
const FOOT_FOX = `<img class="foot-fox" src="/fox.png" alt="" width="16" height="16"/>`;

export function renderBrand(snap: PublicSnapshot): string {
  const href = snap.homepageUrl || "/";
  const mark = snap.iconUrl
    ? `<img class="site-icon" src="${escapeHtml(snap.iconUrl)}" alt="" width="24" height="24"/>`
    : FOX_MARK;
  return `<a class="brand" href="${escapeHtml(href)}">${mark}<span class="brand-name">${escapeHtml(snap.siteName)}</span></a>`;
}

export function renderBrandBlock(snap: PublicSnapshot): string {
  return `<div id="live-brand">${renderBrand(snap)}</div>`;
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

function formatMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}

/** Place a latency value on a 0–max axis, with padding so end labels don't clip. */
export function latencyAxisX(value: number, span: number, pad = 8): number {
  if (span <= 0) return 50;
  return Math.round((pad + (Math.max(0, value) / span) * (100 - pad * 2)) * 100) / 100;
}

function markTransform(x: number): string {
  if (x < 12) return "translateX(0)";
  if (x > 88) return "translateX(-100%)";
  return "translateX(-50%)";
}

function renderLatencyRange(min: number, avg: number, max: number): string {
  const lo = Math.min(min, avg, max);
  const hi = Math.max(min, avg, max);
  const minX = latencyAxisX(lo, hi);
  const avgX = latencyAxisX(avg, hi);
  const maxX = latencyAxisX(hi, hi);
  const rangeW = Math.max(0.8, maxX - minX);
  const tight = hi - lo < 2;
  const aria = `min ${formatMs(lo)}, avg ${formatMs(avg)}, max ${formatMs(hi)}`;
  const marks = tight
    ? `<span class="tip-lat-mark avg" style="left:${avgX}%"></span>`
    : `<span class="tip-lat-range" style="left:${minX}%;width:${rangeW}%"></span>
      <span class="tip-lat-mark min" style="left:${minX}%"></span>
      <span class="tip-lat-mark avg" style="left:${avgX}%"></span>
      <span class="tip-lat-mark max" style="left:${maxX}%"></span>`;
  const ends = tight
    ? ""
    : `<span class="tip-lat-end min" style="left:${minX}%;transform:${markTransform(minX)}">${escapeHtml(formatMs(lo))}</span>
      <span class="tip-lat-end max" style="left:${maxX}%;transform:${markTransform(maxX)}">${escapeHtml(formatMs(hi))}</span>`;
  return `<span class="tip-lat" role="img" aria-label="${escapeHtml(aria)}">
    <span class="tip-lat-avg" style="left:${avgX}%;transform:${markTransform(avgX)}">${escapeHtml(formatMs(avg))}<span class="k"> avg</span></span>
    <span class="tip-lat-track">${marks}</span>
    ${ends}
  </span>`;
}

function renderTipStats(d: PublicDay): string {
  const parts: string[] = [];
  if (d.checks != null && d.checks > 0) {
    parts.push(`<span class="tip-checks"><b>${d.checks}</b> checks</span>`);
  }
  const avg = d.latencyMs != null && d.latencyMs > 0 ? d.latencyMs : null;
  if (avg != null) {
    const min = d.latencyMinMs != null && d.latencyMinMs > 0 ? d.latencyMinMs : avg;
    const max = d.latencyMaxMs != null && d.latencyMaxMs > 0 ? d.latencyMaxMs : avg;
    parts.push(renderLatencyRange(min, avg, max));
  }
  return parts.join("");
}

function renderBar(days: PublicDay[], label: string, extraClass = ""): string {
  const maxLatency = days.reduce((m, d) => Math.max(m, d.latencyMs ?? 0), 0);
  const cells = days
    .map((d) => {
      const kind = dayKind(d.uptime, d.incident, d.incidentImpact);
      const caption = dayCaption(d.uptime, d.incident, d.incidentImpact);
      const hasData = d.uptime != null || d.incident;
      const h = tickHeightPct(d.latencyMs, maxLatency, hasData);
      return `<span class="day ${kind}" style="--h:${h}%"><span class="tick"></span><span class="tip" aria-hidden="true"><span class="tip-date">${escapeHtml(formatLongDate(d.date))}</span><span class="tip-row">${mark(kind)}<span>${escapeHtml(caption)}</span></span>${renderTipStats(d)}</span></span>`;
    })
    .join("");
  return `<div class="bar${extraClass ? ` ${extraClass}` : ""}" role="img" aria-label="${escapeHtml(label)}">${cells}</div>`;
}

function maintLabel(status: ComponentStatus): string {
  return status === "maintenance" ? `<span class="maint-label">Under maintenance</span>` : "";
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
  const label = `<span class="svc-label">${mark(status)}<span class="name">${escapeHtml(group.name)}</span>${maintLabel(status)}${countEl}${chev}</span>`;
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
    ? incident.updates
    : [{ status: incident.status, body: "", at: incident.startedAt }];
  return `<ol class="timeline">${items
    .map(
      (u) =>
        `<li class="timeline-item ${timelineClass(u.status)}"><p class="update-meta">${escapeHtml(incidentStatusLabel(u.status))} · <time datetime="${new Date(u.at).toISOString()}">${escapeHtml(new Date(u.at).toUTCString())}</time></p>${u.body ? `<p class="update-body">${escapeHtml(u.body)}</p>` : ""}</li>`,
    )
    .join("")}</ol>`;
}

function renderIncidents(incidents: PublicIncident[]): string {
  if (!incidents.length) return `<p class="quiet">No incidents reported.</p>`;
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
      const articles = dayIncidents
        .map(
          (i) => `<article class="incident" id="incident-${escapeHtml(i.id)}">
            <h3>${escapeHtml(i.title)}</h3>
            <p class="meta">${escapeHtml(incidentStatusLabel(i.status))} · ${escapeHtml(impactLabel(i.impact))}${i.componentNames?.length ? ` · ${escapeHtml(i.componentNames.join(", "))}` : ""}</p>
            ${renderTimeline(i)}
          </article>`,
        )
        .join("");
      return `<div class="incident-day"><p class="incident-date">${escapeHtml(formatDayHeading(day))}</p>${articles}</div>`;
    })
    .join("");
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
html, body { margin: 0; background: var(--bg); color: var(--ink); min-height: 100%; }
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
.systems { margin: 1.5rem 0; }
.card { border: 1px solid var(--line); border-radius: var(--radius); background: var(--card); overflow: visible; }
.card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; padding: 0.9rem 1.15rem 0.7rem; }
.card-head h2 { margin: 0; font-size: 0.95rem; font-weight: 650; letter-spacing: -0.02em; }
.range { margin: 0; color: var(--muted); font-size: 0.8125rem; }
.service { padding: 0.85rem 1.15rem 1rem; border-top: 1px solid var(--line); overflow: visible; }
.service details { margin: 0; }
.service summary { list-style: none; cursor: pointer; }
.service summary::-webkit-details-marker { display: none; }
.service summary:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; border-radius: 4px; }
.svc-row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.5rem; }
.svc-label { display: flex; align-items: center; gap: 0.5rem; min-width: 0; cursor: default; }
summary .svc-label { cursor: pointer; }
.name { font-weight: 600; font-size: 0.925rem; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
.day .tick {
  display: block; width: 100%; height: var(--h, 22%);
  border-radius: 1px; background: var(--empty); pointer-events: none;
}
.day.ok .tick { background: var(--ok); }
.day.warn .tick { background: var(--warn); }
.day.bad .tick { background: var(--bad); }
.tip {
  position: absolute; bottom: calc(100% + 8px); left: 50%;
  opacity: 0; visibility: hidden; pointer-events: none;
  transform: translateX(-50%) translateY(4px);
  background: var(--card); color: var(--muted);
  border: 1px solid var(--line); border-radius: 8px; padding: 0.5rem 0.65rem;
  box-shadow: 0 8px 24px color-mix(in srgb, var(--ink) 12%, transparent); white-space: nowrap; min-width: 13.5rem;
  transition: opacity var(--duration-ui) var(--ease-out), transform var(--duration-ui) var(--ease-out), visibility var(--duration-ui) var(--ease-out);
}
.bar:hover .tip { transition-duration: 0ms; }
.bar .day:nth-child(-n+24) .tip { left: 0; transform: translateY(4px); }
.bar .day:nth-last-child(-n+24) .tip { left: auto; right: 0; transform: translateY(4px); }
@media (hover: hover) and (pointer: fine) {
  .day:hover { z-index: 3; }
  .day:hover .tip { opacity: 1; visibility: visible; transform: translateX(-50%) translateY(0); }
  .bar .day:nth-child(-n+24):hover .tip, .bar .day:nth-last-child(-n+24):hover .tip { transform: translateY(0); }
}
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
.component { padding: 0.85rem 0 0.15rem; margin-left: 0.15rem; }
.component + .component { border-top: 1px solid var(--line); margin-top: 0.7rem; padding-top: 0.85rem; }
#live-history { margin-bottom: 2rem; }
.incident-day { border-top: 1px solid var(--line); }
.incident-date { margin: 0; padding: 0.85rem 1.15rem 0.25rem; color: var(--muted); font-size: 0.75rem; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; }
.incident { padding: 0.55rem 1.15rem 1rem; }
.incident h3 { margin: 0 0 0.2rem; font-size: 0.95rem; letter-spacing: -0.01em; }
.incident .meta { margin: 0 0 0.55rem; color: var(--muted); font-size: 0.8rem; }
.timeline { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 0.55rem; }
.timeline-item { border-left: 2px solid var(--line); padding: 0 0 0 0.75rem; background: none; }
.timeline-item.warn { border-left-color: var(--warn); }
.timeline-item.ok { border-left-color: var(--ok); }
.timeline-item.ink { border-left-color: var(--ink); }
.update-meta { margin: 0 0 0.15rem; color: var(--muted); font-size: 0.75rem; }
.update-body { margin: 0; font-size: 0.875rem; }
.quiet { margin: 0; padding: 0.85rem 1.15rem 1.1rem; color: var(--muted); font-size: 0.875rem; }
.foot { text-align: center; color: var(--muted); font-size: 0.75rem; margin-top: auto; flex: none; }
.foot .by { display: inline-flex; align-items: center; gap: 0.4rem; font-weight: 500; color: var(--ink); margin: 0 0 0.5rem; text-decoration: none; }
.disclaimer { margin: 0 auto; max-width: 32rem; line-height: 1.55; }
.empty-card { padding: 1.15rem; color: var(--muted); font-size: 0.875rem; }
@media (max-width: 640px) {
  .wrap { padding: 1.25rem 1rem 2.5rem; }
  .banner-head h1 { font-size: 1.1rem; }
  .bar { height: 1.1rem; }
  .uptime { font-size: 0.75rem; }
  .count { display: none; }
  .uptime-word { font-size: 0.7rem; }
}
@media (prefers-reduced-motion: reduce) {
  html.theme-ready { transition: none; }
  .chev, .tip, .theme-toggle, .theme-icon { transform: none; }
  .chev, .tip, .theme-toggle { transition-property: opacity, visibility, color, background-color, border-color; }
  .theme-icon { transition: opacity var(--duration-ui) var(--ease-out); }
  html[data-theme="dark"] .theme-icon-moon, html[data-theme="dark"] .theme-icon-sun { transform: none; }
}
`;

function renderNotices(snap: PublicSnapshot): string {
  const stale = snap.stale
    ? `<p class="stale" role="status">Monitoring data may be stale. Last observer tick: ${snap.lastTick ? escapeHtml(new Date(snap.lastTick).toUTCString()) : "never"}.</p>`
    : "";
  const maintenance = snap.groups.some((g) => g.components.some((c) => c.status === "maintenance"))
    ? `<p class="stale" role="status">Scheduled maintenance is in progress on some systems.</p>`
    : "";
  return `${stale}${maintenance}`;
}

export function renderBannerBlock(snap: PublicSnapshot): string {
  return `<div id="live-banner"><section class="banner banner-${escapeHtml(snap.banner)}" aria-live="polite">
        <div class="banner-head">
          ${mark(snap.banner === "unknown" ? "empty" : snap.banner === "fully_operational" ? "operational" : snap.banner === "failing" ? "failing" : "degraded")}
          <h1>${escapeHtml(LABELS[snap.banner])}</h1>
        </div>
        <p class="banner-body">${escapeHtml(BODY[snap.banner])}</p>
      </section>${renderNotices(snap)}</div>`;
}

export function renderSystemsBlock(snap: PublicSnapshot): string {
  const range =
    dateRange(snap.groups.flatMap((g) => g.components[0]?.days ?? [])) ?? "Last 90 days";
  const groups = snap.groups.map(renderService).join("");
  return `<section class="card systems" id="live-systems" aria-labelledby="systems-title">
        <div class="card-head">
          <h2 id="systems-title">System status</h2>
          <p class="range">${escapeHtml(range)}</p>
        </div>
        ${groups || `<p class="empty-card">No components configured yet.</p>`}
      </section>`;
}

export function renderHistoryBlock(snap: PublicSnapshot): string {
  return `<section class="card" id="live-history" aria-labelledby="history-title">
        <div class="card-head"><h2 id="history-title">Incident history</h2></div>
        ${renderIncidents(snap.incidents)}
      </section>`;
}

export function renderMaintenanceBlock(snap: PublicSnapshot): string {
  const maintenance = snap.maintenance ?? [];
  if (!maintenance.length) return `<section id="live-maintenance" hidden></section>`;
  const items = maintenance.map((window) => {
    const active = window.startAt <= snap.generatedAt && snap.generatedAt < window.endAt;
    return `<li class="incident"><h3>${escapeHtml(window.componentName)}</h3><p class="meta">${active ? "In progress" : "Scheduled"} · <time datetime="${new Date(window.startAt).toISOString()}">${escapeHtml(new Date(window.startAt).toUTCString())}</time> – <time datetime="${new Date(window.endAt).toISOString()}">${escapeHtml(new Date(window.endAt).toUTCString())}</time></p>${window.note ? `<p class="update-body">${escapeHtml(window.note)}</p>` : ""}</li>`;
  }).join("");
  return `<section class="card systems" id="live-maintenance" aria-labelledby="maintenance-title"><div class="card-head"><h2 id="maintenance-title">Scheduled maintenance</h2></div><ul class="timeline">${items}</ul></section>`;
}

export function snapshotEtag(snap: PublicSnapshot): string {
  const s = JSON.stringify({
    banner: snap.banner,
    stale: snap.stale,
    siteName: snap.siteName,
    homepageUrl: snap.homepageUrl ?? null,
    iconUrl: snap.iconUrl ?? null,
    lastTick: snap.lastTick,
    groups: snap.groups,
    incidents: snap.incidents,
    maintenance: snap.maintenance ?? [],
  });
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

export type LivePayload = {
  etag: string;
  title: string;
  description: string;
  icon: string;
  status: PublicSnapshot["banner"];
  brand: string;
  banner: string;
  systems: string;
  history: string;
  maintenance: string;
};

export function renderLivePayload(snap: PublicSnapshot): LivePayload {
  return {
    etag: snapshotEtag(snap),
    title: `${snap.siteName} status`,
    description: LABELS[snap.banner],
    icon: pageIcon(snap),
    status: snap.banner,
    brand: renderBrandBlock(snap),
    banner: renderBannerBlock(snap),
    systems: renderSystemsBlock(snap),
    history: renderHistoryBlock(snap),
    maintenance: renderMaintenanceBlock(snap),
  };
}

/** Tiny WS client: one connection, no polling. Hibernating DO replies to "ping". */
export const LIVE_CLIENT_SCRIPT = `(function(){
  var etag="", delay=1000, ws, timer, poller, iconSrc, faviconGen=0;
  function fileDrag(e){ return e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.indexOf("Files")>=0; }
  window.addEventListener("dragover", function(e){ if (fileDrag(e)) e.preventDefault(); });
  window.addEventListener("drop", function(e){ if (fileDrag(e)) e.preventDefault(); });
  function theme(){ return document.documentElement.getAttribute("data-theme")==="dark"?"dark":"light"; }
  function syncThemeBtn(){
    var b=document.querySelector(".theme-toggle");
    if (!b) return;
    var t=theme();
    b.setAttribute("aria-label", t==="dark"?"Use light appearance":"Use dark appearance");
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
  setStatusFavicon(iconSrc, document.documentElement.getAttribute("data-banner")||"unknown");
  function groups(){
    var out=[], nodes=document.querySelectorAll("#live-systems details[open]");
    for (var i=0;i<nodes.length;i++){
      var wrap=nodes[i].closest("[data-group]");
      if (wrap && wrap.getAttribute("data-group")) out.push(wrap.getAttribute("data-group"));
    }
    return out;
  }
  function restore(ids){
    for (var i=0;i<ids.length;i++){
      var el=document.querySelector('#live-systems [data-group="'+ids[i]+'"] details');
      if (el) el.open=true;
    }
  }
  function swap(id, html){
    var el=document.getElementById(id);
    if (!el || !html) return;
    var box=document.createElement("div");
    box.innerHTML=html;
    var next=box.firstElementChild;
    if (next) el.replaceWith(next);
  }
  function apply(msg){
    if (!msg || msg.etag===etag) return;
    etag=msg.etag;
    var open=groups();
    swap("live-banner", msg.banner);
    swap("live-systems", msg.systems);
    swap("live-history", msg.history);
    swap("live-maintenance", msg.maintenance);
    swap("live-brand", msg.brand);
    restore(open);
    if (msg.title) document.title=msg.title;
    if (msg.icon) iconSrc=msg.icon;
    if (msg.status){
      document.documentElement.setAttribute("data-banner", msg.status);
      setStatusFavicon(iconSrc, msg.status);
    } else if (msg.icon){
      setStatusFavicon(iconSrc, document.documentElement.getAttribute("data-banner")||"unknown");
    }
    if (msg.description){
      var meta=document.querySelector('meta[name="description"]');
      if (meta) meta.setAttribute("content", msg.description);
    }
  }
  function connect(){
    var proto=location.protocol==="https:"?"wss:":"ws:";
    ws=new WebSocket(proto+"//"+location.host+"/live");
    ws.onmessage=function(ev){
      if (ev.data==="pong") return;
      try { apply(JSON.parse(ev.data)); } catch (e) {}
    };
    ws.onopen=function(){ delay=1000; if(poller){clearInterval(poller);poller=null;} };
    ws.onclose=function(){
      if (timer){ clearInterval(timer); timer=null; }
      if (!poller){
        var poll=function(){fetch("/api/status/live.json",{headers:{accept:"application/json"}}).then(function(r){return r.ok?r.json():null;}).then(apply).catch(function(){});};
        poll(); poller=setInterval(poll,60000);
      }
      setTimeout(connect, delay);
      delay=Math.min(delay*2, 15000);
    };
    timer=setInterval(function(){ if (ws && ws.readyState===1) ws.send("ping"); }, 25000);
  }
  connect();
})();`;

const THEME_BOOT = `(function(){try{var k="foxwatch-theme",t=localStorage.getItem(k);if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.setAttribute("data-theme",t);document.documentElement.style.colorScheme=t;var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",t==="dark"?"#2c2b28":"#efece6");}catch(e){}requestAnimationFrame(function(){document.documentElement.classList.add("theme-ready");});})();`;

const THEME_TOGGLE = `<button type="button" class="theme-toggle" aria-label="Use dark appearance"><span class="theme-icon theme-icon-moon" aria-hidden="true"></span><span class="theme-icon theme-icon-sun" aria-hidden="true"></span></button>`;

export function renderPublicHtml(snap: PublicSnapshot): string {
  return `<!doctype html>
<html lang="en" data-banner="${escapeHtml(snap.banner)}">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="theme-color" content="#efece6"/>
  <title>${escapeHtml(snap.siteName)} status</title>
  <meta name="description" content="${escapeHtml(LABELS[snap.banner])}"/>
  <link rel="icon" href="${pageIcon(snap)}"/>
  <script>${THEME_BOOT}</script>
  <style>${STYLES}</style>
</head>
<body>
  <div class="wrap">
    <header class="top">
      ${renderBrandBlock(snap)}
      ${THEME_TOGGLE}
    </header>
    <main>
      ${renderBannerBlock(snap)}
      ${renderSystemsBlock(snap)}
      ${renderMaintenanceBlock(snap)}
      ${renderHistoryBlock(snap)}
    </main>
    <footer class="foot">
      <p><a class="by" href="https://github.com/hypervoid-inc/foxwatch" target="_blank" rel="noopener noreferrer">${FOOT_FOX}Powered by Foxwatch</a></p>
      <p class="disclaimer">Availability is measured from Cloudflare’s edge. Figures are aggregated across regions and checks; individual experience may vary by path and location.</p>
    </footer>
  </div>
  <script>${LIVE_CLIENT_SCRIPT}</script>
</body>
</html>`;
}

export function renderBadge(snap: PublicSnapshot): string {
  const label = LABELS[snap.banner].replace(/\.$/, "");
  const color = bannerColor(snap.banner);
  const text = escapeHtml(`${snap.siteName}: ${label}`);
  const width = Math.min(480, 24 + text.length * 7);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${text}">
  <rect width="${width}" height="20" rx="3" fill="${color}"/>
  <text x="8" y="14" fill="#ffffff" font-size="12" font-family="ui-sans-serif, system-ui, sans-serif">${text}</text>
</svg>`;
}

export function renderFeed(snap: PublicSnapshot, origin: string): string {
  const items = snap.incidents
    .map((i) => {
      const link = `${origin}/#incident-${encodeURIComponent(i.id)}`;
      return `<item>
        <title>${escapeHtml(i.title)}</title>
        <link>${escapeHtml(link)}</link>
        <guid>${escapeHtml(link)}</guid>
        <pubDate>${escapeHtml(new Date(i.startedAt).toUTCString())}</pubDate>
        <description>${escapeHtml(incidentStatusLabel(i.status))} — ${escapeHtml(impactLabel(i.impact))}</description>
      </item>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeHtml(snap.siteName)} status</title>
    <link>${escapeHtml(origin)}</link>
    <description>Incident feed</description>
    ${items}
  </channel>
</rss>`;
}
