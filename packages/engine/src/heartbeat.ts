import type { RunOutcome } from "@foxwatch/config";

export function heartbeatOutcome(
  lastPingAt: number | null,
  now: number,
  intervalMs: number,
  graceMs: number,
): RunOutcome {
  if (lastPingAt == null) return "fail";
  return now - lastPingAt <= intervalMs + graceMs ? "pass" : "fail";
}

/**
 * When to look at a passing heartbeat again: just after its deadline, so a
 * missed ping is seen when it happens rather than up to an interval later.
 */
export function heartbeatRecheckMs(
  lastPingAt: number,
  now: number,
  intervalMs: number,
  graceMs: number,
): number {
  const untilDeadline = lastPingAt + intervalMs + graceMs - now;
  return Math.min(intervalMs, Math.max(1000, untilDeadline + 1000));
}
