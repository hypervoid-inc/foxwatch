export const INCIDENT_PAGE_SIZE = 50;
/** The most the list endpoint returns in one request. */
const INCIDENT_PAGE_MAX = 200;

/** Page size for a refresh: enough to keep every resolved incident already on screen, up to the endpoint's limit. */
export function incidentRefreshLimit(shown: number): number {
  return Math.min(INCIDENT_PAGE_MAX, Math.max(INCIDENT_PAGE_SIZE, shown));
}

export function incidentsPath(opts: { cursor?: string | null; limit?: number } = {}): string {
  const q = new URLSearchParams({ limit: String(opts.limit ?? INCIDENT_PAGE_SIZE) });
  if (opts.cursor) q.set("cursor", opts.cursor);
  return `/api/ops/incidents?${q}`;
}

/** Adds an older page to the list, skipping anything already there. */
export function appendIncidents<T extends { id: string }>(current: T[], older: T[]): T[] {
  const seen = new Set(current.map((incident) => incident.id));
  return [...current, ...older.filter((incident) => !seen.has(incident.id))];
}

export type ResolvedList<T> = { resolved: T[]; nextCursor: string | null };

/**
 * Puts a fresh first page on top of the list already showing. One request returns a limited number of rows,
 * so anything on screen that is older than the fresh page stays, along with the cursor that continues from it.
 */
export function mergeRefreshedIncidents<T extends { id: string; startedAt: number }>(
  current: ResolvedList<T>,
  fresh: ResolvedList<T>,
  openIds: Iterable<string> = [],
): ResolvedList<T> {
  const last = fresh.resolved[fresh.resolved.length - 1];
  // No cursor means the fresh page is the whole history.
  if (!last || fresh.nextCursor == null) return fresh;
  const reopened = new Set(openIds);
  // Same order as the endpoint: newest first, then by id.
  const older = current.resolved.filter(
    (incident) =>
      !reopened.has(incident.id) &&
      (incident.startedAt < last.startedAt || (incident.startedAt === last.startedAt && incident.id < last.id)),
  );
  if (older.length === 0) return fresh;
  return { resolved: [...fresh.resolved, ...older], nextCursor: current.nextCursor };
}

/**
 * Body for posting an incident update. The status goes along only when the operator picked one;
 * without it the server keeps the incident where it is, so a note never moves it back to what a stale tab showed.
 */
export function incidentUpdatePayload(opts: { status: string | null; body: string; notify: boolean }): { status?: string; body: string; notify: boolean } {
  const { status, body, notify } = opts;
  return status == null ? { body, notify } : { status, body, notify };
}
