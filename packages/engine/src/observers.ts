import { REGIONS } from "@foxwatch/config";
import { LAND } from "./land.ts";
import { regionLabel, regionTitle } from "./regions.ts";

export type PublicObserver = {
  region: string;
  label: string;
  title: string;
  colo: string | null;
  outcome: "pass" | "degraded" | "fail" | "unknown";
  latencyMs: number | null;
  checkedAt: number | null;
};

export type ObserverRun = {
  region: string;
  outcome: string;
  latencyMs?: number | null;
  colo?: string | null;
  checkedAt?: number | null;
};

/** Typical Cloudflare colo for each Workers region, used only to place dots. */
export const REGION_COORDS: Record<string, { lat: number; lng: number }> = {
  wnam: { lat: 37.36, lng: -121.93 },
  enam: { lat: 40.69, lng: -74.17 },
  sam: { lat: -23.43, lng: -46.47 },
  weur: { lat: 51.47, lng: -0.45 },
  eeur: { lat: 52.17, lng: 20.97 },
  apac: { lat: 1.35, lng: 103.99 },
  oc: { lat: -33.95, lng: 151.18 },
  afr: { lat: -26.13, lng: 28.23 },
  me: { lat: 25.25, lng: 55.36 },
};

/** Cropped equirectangular view, percent of the plot. */
export const MESH_PROJ = {
  west: -170,
  east: 170,
  north: 62,
  south: -46,
  x0: 3,
  x1: 97,
  y0: 6,
  y1: 94,
} as const;

export function meshProjAttr(): string {
  const p = MESH_PROJ;
  return `${p.west},${p.east},${p.north},${p.south},${p.x0},${p.x1},${p.y0},${p.y1}`;
}

export function projectPct(lng: number, lat: number): { x: number; y: number } {
  const p = MESH_PROJ;
  const x = p.x0 + ((lng - p.west) / (p.east - p.west)) * (p.x1 - p.x0);
  const y = p.y0 + ((p.north - lat) / (p.north - p.south)) * (p.y1 - p.y0);
  return {
    x: round2(clamp(x, 1, 99)),
    y: round2(clamp(y, 1, 99)),
  };
}

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function nearestRegion(lat: number, lng: number, regions: string[]): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const region of regions) {
    const coord = REGION_COORDS[region];
    if (!coord) continue;
    const d = haversineKm({ lat, lng }, coord);
    if (d < bestD) {
      bestD = d;
      best = region;
    }
  }
  return best;
}

function outcomeRank(outcome: string): number {
  if (outcome === "fail") return 3;
  if (outcome === "degraded") return 2;
  if (outcome === "pass") return 1;
  return 0;
}

function asOutcome(outcome: string): PublicObserver["outcome"] {
  if (outcome === "fail" || outcome === "degraded" || outcome === "pass") return outcome;
  return "unknown";
}

/** One public dot per configured HTTP region. Skips heartbeat `global`. Stable REGIONS order. */
export function publicObservers(expected: string[], runs: ObserverRun[]): PublicObserver[] {
  const wanted = new Set(expected.filter((region) => region in REGION_COORDS));
  const byRegion = new Map<string, ObserverRun[]>();
  for (const run of runs) {
    if (!wanted.has(run.region)) continue;
    const list = byRegion.get(run.region) ?? [];
    list.push(run);
    byRegion.set(run.region, list);
  }
  const out: PublicObserver[] = [];
  for (const region of REGIONS) {
    if (!wanted.has(region)) continue;
    const list = byRegion.get(region) ?? [];
    const picked = [...list].sort((a, b) => {
      const rank = outcomeRank(b.outcome) - outcomeRank(a.outcome);
      if (rank) return rank;
      return (b.checkedAt ?? 0) - (a.checkedAt ?? 0);
    })[0];
    const colo = picked?.colo && /^[A-Z0-9]{3,4}$/i.test(picked.colo) ? picked.colo.toUpperCase() : null;
    const latency = picked?.latencyMs != null && Number.isFinite(picked.latencyMs) && picked.latencyMs > 0
      ? Math.round(picked.latencyMs)
      : null;
    out.push({
      region,
      label: regionLabel(region),
      title: regionTitle(region),
      colo,
      outcome: picked ? asOutcome(picked.outcome) : "unknown",
      latencyMs: latency,
      checkedAt: picked?.checkedAt != null && Number.isFinite(picked.checkedAt) ? picked.checkedAt : null,
    });
  }
  return out;
}

export type MeshArc = { a: string; b: string; d: string };

/** Two geographically nearest neighbors per region, undirected, no dateline wrap. */
export function meshArcs(regions: string[]): MeshArc[] {
  const pts = regions
    .map((region) => {
      const coord = REGION_COORDS[region];
      if (!coord) return null;
      return { region, ...coord, ...projectPct(coord.lng, coord.lat) };
    })
    .filter((p): p is { region: string; lat: number; lng: number; x: number; y: number } => p != null);
  const seen = new Set<string>();
  const arcs: MeshArc[] = [];
  const add = (a: (typeof pts)[number], b: (typeof pts)[number]) => {
    const key = a.region < b.region ? `${a.region}|${b.region}` : `${b.region}|${a.region}`;
    if (seen.has(key)) return;
    seen.add(key);
    arcs.push({ a: a.region, b: b.region, d: arcPath(a, b) });
  };
  for (const p of pts) {
    const others = pts
      .filter((o) => o.region !== p.region)
      .map((o) => ({ o, d: haversineKm(p, o) }))
      .sort((a, b) => a.d - b.d);
    if (others[0]) add(p, others[0].o);
    if (others[1]) add(p, others[1].o);
  }
  return arcs;
}

export function meshCaption(observers: PublicObserver[]): string {
  if (!observers.length) return "";
  const n = observers.length;
  const regions = n === 1 ? "1 region" : `${n} regions`;
  const lats = observers.map((o) => o.latencyMs).filter((ms): ms is number => ms != null && ms > 0);
  const range = lats.length
    ? Math.min(...lats) === Math.max(...lats)
      ? `${Math.round(lats[0]!)}ms`
      : `${Math.min(...lats)}–${Math.max(...lats)}ms`
    : null;
  const fails = observers.filter((o) => o.outcome === "fail").length;
  const deg = observers.filter((o) => o.outcome === "degraded").length;
  if (fails) return `${fails === 1 ? "1 region" : `${fails} regions`} failing${range ? ` · ${range}` : ""}`;
  if (deg) return `${deg === 1 ? "1 region" : `${deg} regions`} degraded${range ? ` · ${range}` : ""}`;
  return range ? `Observed from ${regions} · ${range}` : `Observed from ${regions}`;
}

export function observerReadout(observer: PublicObserver): string {
  const parts = [observer.title];
  if (observer.colo) parts.push(observer.colo);
  if (observer.outcome === "fail") parts.push(observer.latencyMs ? `failing · ${observer.latencyMs}ms` : "failing");
  else if (observer.outcome === "degraded") parts.push(observer.latencyMs ? `${observer.latencyMs}ms · slow` : "degraded");
  else if (observer.latencyMs) parts.push(`${observer.latencyMs}ms`);
  else if (observer.outcome === "unknown") parts.push("no sample yet");
  else parts.push("operational");
  return parts.join(" · ");
}

export function observerKind(outcome: PublicObserver["outcome"]): "ok" | "warn" | "bad" | "empty" {
  if (outcome === "fail") return "bad";
  if (outcome === "degraded") return "warn";
  if (outcome === "pass") return "ok";
  return "empty";
}

export function ringRem(latencyMs: number | null, maxLatency: number): string | null {
  if (latencyMs == null || latencyMs <= 0 || maxLatency <= 0) return null;
  const t = Math.min(1, latencyMs / maxLatency);
  return `${(1.2 + t * 1.6).toFixed(2)}rem`;
}

function arcPath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const bulge = Math.min(11, dist * 0.16);
  const cx = mx + (-dy / dist) * bulge;
  const cy = my + (dx / dist) * bulge;
  return `M${round2(a.x)} ${round2(a.y)} Q${round2(cx)} ${round2(cy)} ${round2(b.x)} ${round2(b.y)}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function landRings(): number[][][] {
  return LAND;
}

export function landPaths(): string[] {
  return LAND.filter((ring) =>
    ring.some((pt) => {
      const lat = pt[1] ?? 0;
      return lat >= MESH_PROJ.south && lat <= MESH_PROJ.north;
    }),
  ).map((ring) => {
    const pts = ring.map(([lng, lat]) => projectPct(lng!, lat!));
    return pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ") + " Z";
  });
}

export function graticuleLines(): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  const lines: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  for (let lng = -160; lng <= 160; lng += 20) {
    const x = projectPct(lng, 0).x;
    lines.push({ x1: x, y1: 0, x2: x, y2: 100 });
  }
  for (const lat of [60, 40, 20, 0, -20, -40]) {
    const y = projectPct(0, lat).y;
    lines.push({ x1: 0, y1: y, x2: 100, y2: y });
  }
  return lines;
}
