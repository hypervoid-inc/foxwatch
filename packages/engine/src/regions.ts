const REGION_LABELS: Record<string, string> = {
  wnam: "West NA",
  enam: "East NA",
  weur: "West EU",
  eeur: "East EU",
  apac: "APAC",
  oc: "Oceania",
  sam: "S. America",
  afr: "Africa",
  me: "Middle East",
  global: "Global",
};

const REGION_TITLES: Record<string, string> = {
  wnam: "West North America",
  enam: "East North America",
  weur: "West Europe",
  eeur: "East Europe",
  apac: "Asia Pacific",
  oc: "Oceania",
  sam: "South America",
  afr: "Africa",
  me: "Middle East",
  global: "Global",
};

/** Public-safe issue text. Internal classes like missing_secret stay generic. */
const ISSUE_LABELS: Record<string, string> = {
  timeout: "timeout",
  connect: "connect",
  heartbeat: "missed",
  status: "status",
  header: "header",
  body: "body",
  json: "json",
  jsonpath: "json",
  assertion: "assertion",
  redirect: "redirect",
  redirect_host: "redirect",
};

export type RegionRunDetail = {
  region: string;
  outcome: string;
  latencyMs?: number | null;
  errorClass?: string | null;
  statusCode?: number | null;
};

export type RegionImpactItem = {
  region: string;
  label: string;
  detail: string;
  outcome: "degraded" | "fail";
};

export type RegionImpact = {
  all: boolean;
  items: RegionImpactItem[];
};

export function regionLabel(region: string): string {
  return REGION_LABELS[region] ?? region;
}

export function regionTitle(region: string): string {
  return REGION_TITLES[region] ?? region;
}

export function impactTone(impact: RegionImpact): "warn" | "bad" {
  return impact.items.some((item) => item.outcome === "fail") ? "bad" : "warn";
}

export function impactAriaLabel(impact: RegionImpact): string {
  const kind = impactTone(impact) === "bad" ? "Failing" : "Degraded";
  if (impact.all) return `${kind} in all regions`;
  return `${kind} in ${impact.items.map((item) => `${item.label} ${item.detail}`).join(", ")}`;
}

export function impactTitle(impact: RegionImpact): string {
  return impact.items.map((item) => `${item.label} ${item.detail}`).join(" · ");
}

function outcomeRank(outcome: string): number {
  if (outcome === "fail") return 2;
  if (outcome === "degraded") return 1;
  return 0;
}

function impactDetail(run: RegionRunDetail): string {
  const ms = run.latencyMs != null && run.latencyMs > 0 ? `${Math.round(run.latencyMs)}ms` : null;
  if (run.outcome === "degraded" && ms) return ms;
  if (run.errorClass === "status" && run.statusCode) return `HTTP ${run.statusCode}`;
  if (run.errorClass === "latency" && ms) return ms;
  const issue = run.errorClass ? ISSUE_LABELS[run.errorClass] : undefined;
  if (issue) return issue;
  if (ms) return ms;
  return run.outcome === "fail" ? "failing" : "degraded";
}

/** Worst current result per expected region. Null when nothing is degraded or failing. */
export function regionImpact(expected: string[], runs: RegionRunDetail[]): RegionImpact | null {
  const wanted = new Set(expected);
  const worst = new Map<string, RegionRunDetail>();
  for (const run of runs) {
    if (!wanted.has(run.region)) continue;
    const prev = worst.get(run.region);
    if (!prev) {
      worst.set(run.region, run);
      continue;
    }
    const rank = outcomeRank(run.outcome) - outcomeRank(prev.outcome);
    if (rank > 0 || (rank === 0 && (run.latencyMs ?? 0) > (prev.latencyMs ?? 0))) {
      worst.set(run.region, run);
    }
  }
  const items: RegionImpactItem[] = [];
  for (const region of expected) {
    const run = worst.get(region);
    if (!run || (run.outcome !== "degraded" && run.outcome !== "fail")) continue;
    items.push({
      region,
      label: regionLabel(region),
      detail: impactDetail(run),
      outcome: run.outcome,
    });
  }
  if (items.length === 0) return null;
  return { all: expected.length > 1 && items.length === expected.length, items };
}
