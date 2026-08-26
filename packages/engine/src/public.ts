import type { BannerStatus, ComponentStatus } from "@foxwatch/config";

export type PublicDay = {
  date: string;
  uptime: number | null;
  incident: boolean;
  /** Monitor runs recorded that UTC day; null when the day has no samples. */
  checks: number | null;
  /** Daily average probe latency in ms; null when no latency samples exist. */
  latencyMs: number | null;
  latencyMinMs: number | null;
  latencyMaxMs: number | null;
};

export type PublicComponent = {
  id: string;
  name: string;
  groupId: string;
  groupName: string;
  status: ComponentStatus;
  uptime90: number | null;
  days: PublicDay[];
};

export type PublicIncident = {
  id: string;
  title: string;
  status: string;
  impact: string;
  startedAt: number;
  resolvedAt: number | null;
  updates: Array<{ status: string; body: string; at: number }>;
};

export type PublicSnapshot = {
  siteName: string;
  /** Product homepage; public header links here when set. Distinct from the status page URL. */
  homepageUrl?: string | null;
  /** Same-origin icon path, e.g. `/icon?v=123`. Null uses the default mark. */
  iconUrl?: string | null;
  banner: BannerStatus;
  stale: boolean;
  lastTick: number | null;
  generatedAt: number;
  groups: Array<{
    id: string;
    name: string;
    uptime90: number | null;
    components: PublicComponent[];
  }>;
  incidents: PublicIncident[];
};

export function publicSnapshot(input: PublicSnapshot): PublicSnapshot {
  return {
    siteName: input.siteName,
    homepageUrl: input.homepageUrl ?? null,
    iconUrl: input.iconUrl ?? null,
    banner: input.banner,
    stale: input.stale,
    lastTick: input.lastTick,
    generatedAt: input.generatedAt,
    groups: input.groups.map((g) => ({
      id: g.id,
      name: g.name,
      uptime90: g.uptime90,
      components: g.components.map((c) => ({
        id: c.id,
        name: c.name,
        groupId: c.groupId,
        groupName: c.groupName,
        status: c.status,
        uptime90: c.uptime90,
        days: c.days,
      })),
    })),
    incidents: input.incidents.map((i) => ({
      id: i.id,
      title: i.title,
      status: i.status,
      impact: i.impact,
      startedAt: i.startedAt,
      resolvedAt: i.resolvedAt,
      updates: i.updates.map((u) => ({ status: u.status, body: u.body, at: u.at })),
    })),
  };
}
