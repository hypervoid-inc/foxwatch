import type { BannerStatus, ComponentStatus, FailWhen, RunOutcome } from "@foxwatch/config";

export type RegionRun = {
  region: string;
  outcome: RunOutcome;
};

export function componentStatus(
  runs: RegionRun[],
  failWhen: FailWhen = "majority",
  inMaintenance = false,
): ComponentStatus {
  if (inMaintenance) return "maintenance";
  if (runs.length === 0) return "operational";
  const fails = runs.filter((r) => r.outcome === "fail").length;
  const degraded = runs.some((r) => r.outcome === "degraded");
  const failThreshold =
    failWhen === "any" ? 1 : failWhen === "all" ? runs.length : Math.floor(runs.length / 2) + 1;
  if (fails >= failThreshold) return "failing";
  if (fails > 0 || degraded) return "degraded";
  return "operational";
}

export function bannerStatus(
  components: Array<{ status: ComponentStatus; critical: boolean }>,
): BannerStatus {
  if (components.some((c) => c.critical && c.status === "failing")) return "failing";
  if (components.some((c) => c.status === "failing" || c.status === "degraded")) return "degraded";
  return "fully_operational";
}

/** Saturated tab-dot colors; distinct from the washed page tokens so a 16px favicon still reads. */
export const STATUS_DOT_COLOR = {
  fully_operational: "#0f9d7a",
  degraded: "#d97706",
  failing: "#e11d48",
} as const;

export function statusDotColor(banner: string): string {
  if (banner === "failing") return STATUS_DOT_COLOR.failing;
  if (banner === "degraded") return STATUS_DOT_COLOR.degraded;
  return STATUS_DOT_COLOR.fully_operational;
}

export function confirmFlip(
  consecutiveFails: number,
  next: RunOutcome,
  needed: number,
): { consecutiveFails: number; confirmedFail: boolean } {
  if (next === "pass" || next === "degraded") {
    return { consecutiveFails: 0, confirmedFail: false };
  }
  const n = consecutiveFails + 1;
  return { consecutiveFails: n, confirmedFail: n >= needed };
}
