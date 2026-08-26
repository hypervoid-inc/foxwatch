export function bannerMark(banner: string): "ok" | "warn" | "bad" {
  if (banner === "fully_operational") return "ok";
  if (banner === "failing") return "bad";
  return "warn";
}

export function bannerLabel(banner: string): string {
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

export function mutationError(error?: string, fallback = "Something went wrong."): string {
  if (error === "not_found") return "That item is gone.";
  if (error === "forbidden" || error === "auth") return "You do not have permission to do that.";
  if (error === "quota") return "Monitor quota reached.";
  if (error === "exists") return "A check with this name already exists.";
  if (error === "overlap") return "This component already has scheduled maintenance.";
  if (error === "end_at") return "Pick an end time in the future, within 90 days.";
  if (error === "interval") return "Interval is too short.";
  if (error === "last_superadmin") return "You cannot remove the last superadmin.";
  if (error === "self") return "You cannot remove your own account.";
  if (error === "invalid_url") return "Use an http(s) address, without a username.";
  if (error === "icon") return "Could not save that icon.";
  if (error === "decode") return "That file could not be read as an image.";
  if (error === "too_large") return "That image is still too large after resizing.";
  if (error === "secret") return "Use a name like API_TOKEN and a value up to 8 KB.";
  return fallback;
}
