export const DURATION_UNITS = ["ms", "s", "m"] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

export const UNIT_MS: Record<DurationUnit, number> = { ms: 1, s: 1_000, m: 60_000 };
export const UNIT_LABEL: Record<DurationUnit, string> = { ms: "ms", s: "sec", m: "min" };

export function splitDuration(ms: number): { value: string; unit: DurationUnit } {
  if (!Number.isFinite(ms) || ms <= 0) return { value: "10", unit: "s" };
  const n = Math.round(ms);
  if (n % 60_000 === 0 && n >= 60_000) return { value: String(n / 60_000), unit: "m" };
  if (n % 1_000 === 0) return { value: String(n / 1_000), unit: "s" };
  return { value: String(n), unit: "ms" };
}

export function durationMs(value: string, unit: DurationUnit): number | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return null;
  return n * UNIT_MS[unit];
}

export function maxAmount(unit: DurationUnit, capMs: number): number {
  return Math.floor(capMs / UNIT_MS[unit]);
}

export function unitsForCap(capMs: number, min = 1): DurationUnit[] {
  return DURATION_UNITS.filter((unit) => maxAmount(unit, capMs) >= min);
}

/** Keep only a whole number in min…max. Rejects letters, signs, decimals, exponent. */
export function sanitizeInt(raw: string, max: number, min = 0): string | undefined {
  if (raw === "") return "";
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return undefined;
  if (n < min) return String(min);
  return String(Math.min(n, max));
}

export function convertDuration(value: string, from: DurationUnit, to: DurationUnit, capMs: number, min = 1): string {
  const ms = durationMs(value, from);
  if (ms == null) return value;
  const raw = ms / UNIT_MS[to];
  const n = Number.isInteger(raw) ? raw : Math.round(raw);
  const max = maxAmount(to, capMs);
  if (max < min) return "";
  return String(Math.min(Math.max(n, min), max));
}

export function clampDuration(value: string, unit: DurationUnit, capMs: number): { value: string; unit: DurationUnit } {
  if (value === "") return { value: "", unit };
  const ms = durationMs(value, unit);
  if (ms == null) return { value: "", unit };
  const allowed = unitsForCap(capMs);
  if (ms <= capMs && allowed.includes(unit)) return { value, unit };
  const split = splitDuration(Math.min(ms, capMs));
  if (allowed.includes(split.unit)) return split;
  const fallback = allowed[0] ?? "ms";
  return { value: convertDuration(split.value, split.unit, fallback, capMs), unit: fallback };
}
