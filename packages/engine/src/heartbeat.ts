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
