export function bannerMark(banner: string): "ok" | "warn" | "bad" | "empty" {
  if (banner === "unknown") return "empty";
  if (banner === "fully_operational") return "ok";
  if (banner === "failing") return "bad";
  return "warn";
}

export function bannerLabel(banner: string): string {
  if (banner === "unknown") return "Unknown";
  if (banner === "fully_operational") return "Fully operational";
  if (banner === "failing") return "Outage";
  return "Degraded";
}

export function outcomeMark(outcome: string): "ok" | "warn" | "bad" | "empty" {
  if (outcome === "pass") return "ok";
  if (outcome === "fail") return "bad";
  if (outcome === "degraded") return "warn";
  return "empty";
}

export function outcomeLabel(outcome: string): string {
  if (outcome === "pass") return "passing";
  if (outcome === "fail") return "failing";
  if (outcome === "degraded") return "degraded";
  return outcome;
}

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

export function regionLabel(region: string): string {
  return REGION_LABELS[region] ?? region;
}

export function regionTitle(region: string): string {
  return REGION_TITLES[region] ?? region;
}

export function incidentStatusLabel(status: string): string {
  if (status === "investigating") return "Investigating";
  if (status === "identified") return "Identified";
  if (status === "monitoring") return "Monitoring";
  if (status === "resolved") return "Resolved";
  return status;
}

export function impactLabel(impact: string): string {
  if (impact === "failing") return "Outage";
  if (impact === "degraded") return "Degraded";
  return impact;
}

export function timelineTone(status: string): "warn" | "ok" | "ink" {
  if (status === "resolved") return "ok";
  if (status === "monitoring") return "ink";
  return "warn";
}

const CLIENT_MUTATION_ERRORS: Record<string, string> = {
  decode: "That file could not be read as an image.",
  icon: "Could not save that icon.",
  too_large: "That image is still too large after resizing.",
};

export function mutationError(error?: string, fallback = "Something went wrong. Try again."): string {
  if (!error) return fallback;
  return CLIENT_MUTATION_ERRORS[error] ?? error;
}
