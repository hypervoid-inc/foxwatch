import type { ApiResult } from "./api.ts";

export const POLL_MS = 30_000;
const POLL_MAX_MS = 5 * 60_000;

/** Wait before the next background refresh: the usual interval, doubled for each failure in a row. */
export function pollDelay(failures: number): number {
  const n = Math.max(0, Math.floor(failures));
  return n >= 4 ? POLL_MAX_MS : Math.min(POLL_MAX_MS, POLL_MS * 2 ** n);
}

export type LoadVerdict = "ready" | "signed-out" | "unreachable";

/**
 * What a load means for the screen. Only an answer that says so signs the operator out:
 * no account on the session, or a 401. Anything else that fails is a connection problem.
 */
export function loadVerdict(auth: ApiResult<{ me: unknown }>, overview: ApiResult<unknown> | null): LoadVerdict {
  if (!auth.ok) return auth.status === 401 ? "signed-out" : "unreachable";
  if (!auth.data.me) return "signed-out";
  if (!overview) return "unreachable";
  if (!overview.ok) return overview.status === 401 ? "signed-out" : "unreachable";
  return "ready";
}
