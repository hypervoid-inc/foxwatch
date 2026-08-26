export const AUDIT_PAGE_DEFAULT = 100;
export const AUDIT_PAGE_MAX = 100;

export type AuditCursor = { createdAt: number; id: string };

export function parseAuditLimit(raw: string | undefined): number {
  if (raw == null || raw === "") return AUDIT_PAGE_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return AUDIT_PAGE_DEFAULT;
  return Math.min(n, AUDIT_PAGE_MAX);
}

export function encodeAuditCursor(row: AuditCursor): string {
  return `${row.createdAt}:${row.id}`;
}

export function parseAuditCursor(raw: string | undefined): AuditCursor | null | "invalid" {
  if (raw == null || raw === "") return null;
  const split = raw.indexOf(":");
  if (split < 1) return "invalid";
  const createdAt = Number(raw.slice(0, split));
  const id = raw.slice(split + 1);
  if (!Number.isInteger(createdAt) || createdAt < 0 || !id) return "invalid";
  return { createdAt, id };
}

/** True when `row` is older than `cursor` in newest-first (createdAt DESC, id DESC) order. */
export function olderThanAuditCursor(row: AuditCursor, cursor: AuditCursor): boolean {
  return row.createdAt < cursor.createdAt || (row.createdAt === cursor.createdAt && row.id < cursor.id);
}

export function auditPageFromRows<T extends AuditCursor>(rows: T[], limit: number): { entries: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const entries = hasMore ? rows.slice(0, limit) : rows;
  const last = entries[entries.length - 1];
  return {
    entries,
    nextCursor: hasMore && last ? encodeAuditCursor(last) : null,
  };
}
