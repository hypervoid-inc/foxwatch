import { drizzle } from "drizzle-orm/d1";
import { and, desc, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { sanitizeText } from "@foxwatch/engine";
import type { Env } from "../env.ts";
import * as schema from "../db/schema.ts";
import { auditPageFromRows, type AuditCursor } from "./audit-page.ts";
import { incidentComponentIds } from "./snapshot.ts";

export const OPS_INCIDENT_PAGE_DEFAULT = 50;
export const OPS_INCIDENT_PAGE_MAX = 200;
/** Far above what an instance has open at once; a bound on the query, not a display cap. */
const OPS_INCIDENT_OPEN_MAX = 500;
/** D1 allows 100 bound parameters in one statement. */
const ID_CHUNK = 90;

export type OpsIncident = {
  id: string;
  componentIds: string[];
  title: string;
  status: string;
  impact: string;
  auto: boolean;
  startedAt: number;
  resolvedAt: number | null;
  updates: Array<{ status: string; body: string; at: number }>;
};

export type OpsIncidentPage = {
  /** Every unresolved incident. Sent with the first page only. */
  open?: OpsIncident[];
  resolved: OpsIncident[];
  nextCursor: string | null;
};

export function parseIncidentLimit(raw: string | undefined): number {
  if (raw == null || raw === "") return OPS_INCIDENT_PAGE_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return OPS_INCIDENT_PAGE_DEFAULT;
  return Math.min(n, OPS_INCIDENT_PAGE_MAX);
}

/**
 * The admin incident list, read from D1. The public snapshot keeps only the newest
 * incidents, so an open one can fall out of it while it still drives the banner.
 */
export async function loadOpsIncidents(env: Env, opts: { cursor: AuditCursor | null; limit: number }): Promise<OpsIncidentPage> {
  const db = drizzle(env.DB, { schema });
  const newestFirst = [desc(schema.incidents.createdAt), desc(schema.incidents.id)] as const;
  const open = opts.cursor
    ? null
    : await db.select().from(schema.incidents).where(isNull(schema.incidents.resolvedAt)).orderBy(...newestFirst).limit(OPS_INCIDENT_OPEN_MAX);
  const older = opts.cursor
    ? or(
        lt(schema.incidents.createdAt, opts.cursor.createdAt),
        and(eq(schema.incidents.createdAt, opts.cursor.createdAt), lt(schema.incidents.id, opts.cursor.id)),
      )
    : undefined;
  const page = auditPageFromRows(
    await db
      .select()
      .from(schema.incidents)
      .where(and(isNotNull(schema.incidents.resolvedAt), older))
      .orderBy(...newestFirst)
      .limit(opts.limit + 1),
    opts.limit,
  );

  const ids = [...(open ?? []), ...page.entries].map((incident) => incident.id);
  const updates = new Map<string, Array<typeof schema.incidentUpdates.$inferSelect>>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const rows = await db.select().from(schema.incidentUpdates).where(inArray(schema.incidentUpdates.incidentId, ids.slice(i, i + ID_CHUNK)));
    for (const row of rows) updates.set(row.incidentId, [...(updates.get(row.incidentId) ?? []), row]);
  }
  // An incident with no components of its own covers the whole page, as it does in the public snapshot.
  const allComponentIds = [...new Set((await db.select({ id: schema.monitors.componentId }).from(schema.monitors)).map((row) => row.id))];

  const shape = (incident: typeof schema.incidents.$inferSelect): OpsIncident => {
    const explicit = incidentComponentIds(incident);
    return {
      id: incident.id,
      componentIds: explicit.length ? explicit : allComponentIds,
      title: sanitizeText(incident.title, 200),
      status: incident.status,
      impact: incident.impact,
      auto: incident.auto === 1,
      startedAt: incident.createdAt,
      resolvedAt: incident.resolvedAt,
      updates: (updates.get(incident.id) ?? [])
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((update) => ({ status: update.status, body: sanitizeText(update.body, 2000), at: update.createdAt })),
    };
  };
  return {
    ...(open ? { open: open.map(shape) } : {}),
    resolved: page.entries.map(shape),
    nextCursor: page.nextCursor,
  };
}
