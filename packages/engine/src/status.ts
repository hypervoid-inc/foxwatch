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
  if (runs.length === 0) return "unknown";
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
  if (components.length === 0 || components.some((c) => c.status === "unknown")) return "unknown";
  return "fully_operational";
}

/** Saturated tab-dot colors; distinct from the washed page tokens so a 16px favicon still reads. */
export const STATUS_DOT_COLOR = {
  unknown: "#64748b",
  fully_operational: "#0f9d7a",
  degraded: "#d97706",
  failing: "#e11d48",
} as const;

export function statusDotColor(banner: string): string {
  if (banner === "failing") return STATUS_DOT_COLOR.failing;
  if (banner === "degraded") return STATUS_DOT_COLOR.degraded;
  if (banner === "fully_operational") return STATUS_DOT_COLOR.fully_operational;
  return STATUS_DOT_COLOR.unknown;
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

/** Consecutive runs that must disagree with the confirmed outcome before it changes to degraded or pass. */
export const CONFIRM_CHANGES = 2;

export type MonitorState = {
  confirmedOutcome: RunOutcome | null;
  consecutiveFails: number;
  /** Consecutive runs that disagree with confirmedOutcome without confirming a failure. */
  consecutiveChanges: number;
};

/**
 * One run of the monitor state machine. A failure is confirmed after
 * `confirmFails` consecutive failing runs. Degradation and recovery are
 * confirmed by a non-failing run that is at least the CONFIRM_CHANGES-th
 * consecutive run to disagree with the confirmed outcome, so one slow or
 * flaky run does not flip it. An unconfirmed failing run is not a pass
 * either: it keeps that streak going for a check that is not yet degraded,
 * so runs that alternate between failing and degraded confirm degraded. The
 * first passing run of a check with no confirmed outcome is taken as is.
 * `settled` is false while the latest run still disagrees with the confirmed
 * outcome; the caller re-checks soon instead of waiting a full interval.
 */
export function advanceMonitor(
  state: MonitorState,
  outcome: RunOutcome,
  confirmFails: number,
): MonitorState & { settled: boolean } {
  if (outcome === "fail") {
    const flip = confirmFlip(state.consecutiveFails, outcome, Math.max(1, confirmFails));
    const confirmedOutcome = flip.confirmedFail ? "fail" : state.confirmedOutcome;
    // Only a degraded run confirms degraded, so a real outage still alerts once, as a failure.
    const unhealthy = confirmedOutcome === "fail" || confirmedOutcome === "degraded";
    return {
      confirmedOutcome,
      consecutiveFails: flip.consecutiveFails,
      consecutiveChanges: unhealthy ? 0 : state.consecutiveChanges + 1,
      settled: confirmedOutcome === "fail",
    };
  }
  const agreed = { confirmedOutcome: outcome, consecutiveFails: 0, consecutiveChanges: 0, settled: true };
  if (outcome === state.confirmedOutcome) return agreed;
  if (state.confirmedOutcome == null && outcome === "pass") return agreed;
  const consecutiveChanges = state.consecutiveChanges + 1;
  if (consecutiveChanges >= CONFIRM_CHANGES) return agreed;
  return { confirmedOutcome: state.confirmedOutcome, consecutiveFails: 0, consecutiveChanges, settled: false };
}

/** A run needs answers from at least half of its regions before it can change monitor state. */
export function hasQuorum(answered: number, expected: number): boolean {
  return answered > 0 && answered * 2 >= expected;
}

export type ComponentEffect = {
  event: "fail" | "degrade" | "recover";
  incident: "open" | "resolve" | null;
  /** Alert only when an auto incident was actually resolved. */
  onlyIfResolved: boolean;
};

/**
 * Side effects owed when a component's confirmed status moves from `prev`
 * (the last status acted on, null when none) to `next`. "unknown" is the
 * absence of a verdict, never a transition.
 */
export function componentTransition(prev: string | null, next: ComponentStatus): ComponentEffect | null {
  if (next === prev) return null;
  if (next === "failing") return { event: "fail", incident: "open", onlyIfResolved: false };
  if (next === "degraded") {
    // The outage is over once the component is only degraded, so downtime stops here.
    // From no known status, an auto incident an earlier run left open is closed too.
    return { event: "degrade", incident: prev === "operational" ? null : "resolve", onlyIfResolved: false };
  }
  if (next === "operational") {
    const wasDown = prev === "failing" || prev === "degraded";
    // Coming from no known status, close any auto incident an earlier run left open.
    return { event: "recover", incident: "resolve", onlyIfResolved: !wasDown };
  }
  return null;
}
