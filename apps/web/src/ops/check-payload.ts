import { MAX_ASSERTION_VALUE_LENGTH, MAX_BODY_INCLUDES_LENGTH, MAX_INTERVAL_MS, MAX_TIMEOUT_MS, MIN_INTERVAL_MS, parseJsonPath } from "@foxwatch/config";
import { clampDuration, durationMs, splitDuration, type DurationUnit } from "./duration.ts";

export const METHODS = ["GET", "HEAD", "POST"] as const;
export const DEFAULT_REGIONS = ["wnam", "weur", "apac"];
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

export const ASSERTION_OPS = [
  { value: "exists", label: "Exists" },
  { value: "not_exists", label: "Does not exist" },
  { value: "equals", label: "Equals" },
  { value: "not_equals", label: "Not equals" },
  { value: "gt", label: ">" },
  { value: "gte", label: ">=" },
  { value: "lt", label: "<" },
  { value: "lte", label: "<=" },
  { value: "contains", label: "Contains" },
  { value: "not_contains", label: "Does not contain" },
  { value: "matches", label: "Matches (wildcard)" },
] as const;

export type AssertionOp = (typeof ASSERTION_OPS)[number]["value"];
export type AssertionRow = { path: string; op: AssertionOp; value: string };
type AssertionValue = string | number | boolean | null;

export type SecretRef = { __foxwatch_secret__: string };

export type HttpConfig = {
  type?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string | SecretRef>;
  body?: string;
  expect?: {
    status?: number | number[];
    bodyIncludes?: string;
    jsonPath?: { path: string; equals?: string | number | boolean; exists?: boolean };
    assertions?: Array<{ path: string; op: string; value?: AssertionValue }>;
    assertionFailThreshold?: number;
  };
  intervalMs?: number;
  timeoutMs?: number;
  graceMs?: number;
  retries?: number;
  followRedirects?: boolean;
  failWhen?: "majority" | "any" | "all";
  confirmFails?: number;
  degradedIf?: { latencyMs?: number };
  regions?: string[];
  allowedHosts?: string[];
};

export type Monitor = {
  id: string;
  origin: string;
  drifted: boolean;
  type: string;
  name: string;
  groupId?: string;
  groupName: string;
  componentId?: string;
  componentName: string;
  critical: boolean;
  mutedUntil: number | null;
  confirmedOutcome?: "pass" | "degraded" | "fail" | null;
  consecutiveFails?: number;
  config: HttpConfig & Record<string, unknown>;
};

/** What placing a check needs to know about the others. */
export type PlacedMonitor = Pick<Monitor, "id" | "groupId" | "groupName" | "componentId" | "componentName">;

export type HeaderRow = { key: string; kind: "text" | "secret"; value: string };
export type CheckKind = "http" | "heartbeat";

export type CheckFormState = {
  checkType: CheckKind;
  name: string;
  url: string;
  method: (typeof METHODS)[number];
  headers: HeaderRow[];
  body: string;
  expectStatus: string;
  bodyIncludes: string;
  assertions: AssertionRow[];
  assertionFailThreshold: number;
  /** Heartbeat interval token. HTTP checks use intervalValue and intervalUnit. */
  interval: string;
  intervalValue: string;
  intervalUnit: DurationUnit;
  timeout: string;
  timeoutUnit: DurationUnit;
  grace: string;
  regions: string[];
  groupName: string;
  componentName: string;
  critical: boolean;
  retries: string;
  followRedirects: boolean;
  failWhen: "majority" | "any" | "all";
  confirmFails: string;
  latencyThreshold: string;
  latencyUnit: DurationUnit;
  allowedHosts: string;
};

function intervalFromMs(ms?: number): string {
  if (ms === 30_000) return "30s";
  if (ms === 300_000) return "5m";
  if (ms === 600_000) return "10m";
  if (ms === 900_000) return "15m";
  if (ms && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms && ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms && ms % 1000 === 0) return `${ms / 1000}s`;
  return "1m";
}

/** The interval field has no ms unit: a sub-second remainder rounds to whole seconds. */
function intervalPartsFromMs(ms?: number): { value: string; unit: DurationUnit } {
  const parts = splitDuration(ms && ms > 0 ? ms : 60_000);
  if (parts.unit !== "ms") return parts;
  return { value: String(Math.max(1, Math.round(Number(parts.value) / 1000))), unit: "s" };
}

function timeoutFromMs(ms?: number): { value: string; unit: DurationUnit } {
  return splitDuration(ms && ms > 0 ? ms : 10_000);
}

function graceFromMs(ms?: number): string {
  if (ms === 30_000) return "30s";
  if (ms === 60_000) return "1m";
  if (ms === 300_000) return "5m";
  if (ms && ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms && ms % 1000 === 0) return `${ms / 1000}s`;
  return "2m";
}

function headersToRows(headers: HttpConfig["headers"]): HeaderRow[] {
  const rows = Object.entries(headers ?? {}).map(([key, value]) => {
    if (value && typeof value === "object" && "__foxwatch_secret__" in value) {
      return { key, kind: "secret" as const, value: value.__foxwatch_secret__ };
    }
    return { key, kind: "text" as const, value: String(value ?? "") };
  });
  return rows.length ? rows : [{ key: "", kind: "text", value: "" }];
}

function rowsToHeaders(rows: HeaderRow[]): Record<string, string | SecretRef> {
  const out: Record<string, string | SecretRef> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key || !row.value.trim()) continue;
    out[key] = row.kind === "secret" ? { __foxwatch_secret__: row.value.trim() } : row.value;
  }
  return out;
}

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 62);
  return s || `check-${Date.now().toString(36)}`;
}

const isValueless = (op: AssertionOp) => op === "exists" || op === "not_exists";
const isNumberOp = (op: AssertionOp) => op === "gt" || op === "gte" || op === "lt" || op === "lte";
const isTextOp = (op: AssertionOp) => op === "contains" || op === "not_contains" || op === "matches";

/**
 * Typed value for an assertion row, or undefined when the operator cannot use
 * what was typed. Text operators always compare text and number operators
 * always compare numbers. Equals reads true, false, null and numbers by type;
 * wrapping the value in double quotes keeps it text ("200").
 */
export function parseAssertionValue(op: AssertionOp, raw: string): AssertionValue | undefined {
  const v = raw.trim();
  if (isTextOp(op)) return v;
  if (isNumberOp(op)) return v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined;
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (typeof parsed === "string") return parsed;
    } catch {
      /* not JSON escaping: take what is between the quotes */
    }
    return v.slice(1, -1);
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (v !== "" && Number.isFinite(Number(v))) return Number(v);
  return v;
}

/** What to show in the value field so that saving it again stores the same value. */
export function assertionValueText(op: AssertionOp, value: AssertionValue | undefined): string {
  if (isValueless(op) || value === undefined) return "";
  if (isNumberOp(op) || isTextOp(op)) return value === null ? "" : String(value);
  if (typeof value === "string") return parseAssertionValue(op, value) === value ? value : JSON.stringify(value);
  return String(value);
}

/** The fail threshold can never exceed the number of assertions it counts. */
export function clampAssertionThreshold(threshold: number, count: number): number {
  const n = Number.isInteger(threshold) ? threshold : 1;
  return Math.max(1, Math.min(n, Math.max(1, count)));
}

export function emptyForm(): CheckFormState {
  return {
    checkType: "http",
    name: "",
    url: "https://",
    method: "GET",
    headers: [{ key: "", kind: "text", value: "" }],
    body: "",
    expectStatus: "200",
    bodyIncludes: "",
    assertions: [],
    assertionFailThreshold: 1,
    interval: "10m",
    intervalValue: "1",
    intervalUnit: "m",
    timeout: "10",
    timeoutUnit: "s",
    grace: "2m",
    regions: [...DEFAULT_REGIONS],
    groupName: "API",
    componentName: "",
    critical: false,
    retries: "2",
    followRedirects: true,
    failWhen: "majority",
    confirmFails: "3",
    latencyThreshold: "",
    latencyUnit: "ms",
    allowedHosts: "",
  };
}

export function formFromMonitor(m: Monitor): CheckFormState {
  const cfg = m.config;
  const expect = cfg.expect ?? {};
  const status = Array.isArray(expect.status) ? expect.status.join(", ") : expect.status;
  // Load assertions, converting legacy jsonPath if present
  let assertions: AssertionRow[] = [];
  if (expect.assertions?.length) {
    assertions = expect.assertions.map((a) => ({
      path: a.path,
      op: a.op as AssertionOp,
      value: assertionValueText(a.op as AssertionOp, a.value),
    }));
  } else if (expect.jsonPath) {
    const jp = expect.jsonPath;
    if (jp.exists) {
      assertions = [{ path: jp.path, op: "exists", value: "" }];
    } else if (jp.equals !== undefined) {
      assertions = [{ path: jp.path, op: "equals", value: assertionValueText("equals", jp.equals) }];
    }
  }
  const timeout = timeoutFromMs(cfg.timeoutMs);
  const timeoutMs = durationMs(timeout.value, timeout.unit) ?? 10_000;
  const degradeRaw = cfg.degradedIf?.latencyMs ? splitDuration(cfg.degradedIf.latencyMs) : { value: "", unit: "ms" as const };
  const degrade = clampDuration(degradeRaw.value, degradeRaw.unit, Math.max(1, timeoutMs - 1));
  const heartbeat = m.type === "heartbeat";
  const interval = heartbeat ? { value: "1", unit: "m" as const } : intervalPartsFromMs(cfg.intervalMs);
  return {
    checkType: heartbeat ? "heartbeat" : "http",
    name: m.name,
    url: String(cfg.url ?? "https://"),
    method: (METHODS.includes(cfg.method as (typeof METHODS)[number]) ? cfg.method : "GET") as (typeof METHODS)[number],
    headers: headersToRows(cfg.headers),
    body: String(cfg.body ?? ""),
    expectStatus: String(status ?? 200),
    bodyIncludes: String(expect.bodyIncludes ?? ""),
    assertions,
    assertionFailThreshold: clampAssertionThreshold(expect.assertionFailThreshold ?? 1, assertions.length),
    interval: heartbeat ? intervalFromMs(cfg.intervalMs) : "10m",
    intervalValue: interval.value,
    intervalUnit: interval.unit,
    timeout: timeout.value,
    timeoutUnit: timeout.unit,
    grace: graceFromMs(cfg.graceMs),
    regions: (cfg.regions?.length ? cfg.regions : [...DEFAULT_REGIONS]).slice(),
    groupName: m.groupName,
    componentName: m.componentName,
    critical: m.critical,
    retries: String(Number.isInteger(Number(cfg.retries)) ? Number(cfg.retries) : 2),
    followRedirects: cfg.followRedirects !== false,
    failWhen: cfg.failWhen ?? "majority",
    confirmFails: String(Number.isInteger(Number(cfg.confirmFails)) && Number(cfg.confirmFails) >= 1 ? Number(cfg.confirmFails) : 3),
    latencyThreshold: degrade.value,
    latencyUnit: degrade.unit,
    allowedHosts: (cfg.allowedHosts ?? []).join(", "),
  };
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function freshId(name: string, taken: Set<string | undefined>): string {
  const base = slugify(name);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const id = `${base.slice(0, 63 - suffix.length)}${suffix}`;
    if (!taken.has(id)) return id;
  }
}

export type Placement = { groupId: string; groupName: string; componentId: string; componentName: string };

/**
 * Where a check sits on the public page. A group or component is the id every
 * member row carries, so typing the name of an existing one joins it under its
 * id and its spelling. A new name renames in place when this check is the only
 * member, and otherwise splits the check off under a fresh id. Names that were
 * not edited keep their ids.
 */
export function resolvePlacement(
  typed: { groupName: string; componentName: string },
  editing: PlacedMonitor | null,
  monitors: PlacedMonitor[],
): Placement {
  const others = monitors.filter((m) => m.id !== editing?.id);

  let groupName = typed.groupName;
  let groupId: string;
  const groupMatch = others.find((m) => m.groupId && sameName(m.groupName, groupName));
  if (editing?.groupId && groupName === editing.groupName) {
    groupId = editing.groupId;
  } else if (groupMatch?.groupId) {
    groupId = groupMatch.groupId;
    groupName = groupMatch.groupName;
  } else if (editing?.groupId && !others.some((m) => m.groupId === editing.groupId)) {
    groupId = editing.groupId;
  } else {
    groupId = freshId(groupName, new Set(others.map((m) => m.groupId)));
  }

  let componentName = typed.componentName;
  let componentId: string;
  // Component ids are global, but a component lives in one group.
  const componentMatch = others.find((m) => m.componentId && m.groupId === groupId && sameName(m.componentName, componentName));
  if (editing?.componentId && componentName === editing.componentName && groupId === editing.groupId) {
    componentId = editing.componentId;
  } else if (componentMatch?.componentId) {
    componentId = componentMatch.componentId;
    componentName = componentMatch.componentName;
  } else if (editing?.componentId && !others.some((m) => m.componentId === editing.componentId)) {
    componentId = editing.componentId;
  } else {
    componentId = freshId(componentName, new Set(others.map((m) => m.componentId)));
  }

  return { groupId, groupName, componentId, componentName };
}

export type Built = { ok: true; payload: Record<string, unknown> } | { ok: false; error: string };

const invalid = (error: string): Built => ({ ok: false, error });

/**
 * The request and its expectations, exactly as a save stores them. Save and
 * "Send test request" both send this, so a test probes what the check will.
 * Cleared optional fields go out as null: the server merges a PATCH over the
 * stored check, and a key JSON drops would leave the old value in place.
 */
export function buildHttpRequest(form: CheckFormState): Built {
  let url: URL;
  try {
    url = new URL(form.url);
  } catch {
    return invalid("Enter a valid URL, including https://");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) {
    return invalid("Use HTTPS. Plain HTTP is only available for local development targets.");
  }
  const headers = rowsToHeaders(form.headers);
  for (const row of form.headers) {
    if (row.kind === "secret" && row.value.trim() && !SECRET_NAME_RE.test(row.value.trim())) {
      return invalid("Secret names must look like API_TOKEN (A-Z, 0-9, _).");
    }
  }
  let body = form.body.trim();
  if (form.method === "POST" && body) {
    try {
      body = JSON.stringify(JSON.parse(body));
    } catch {
      return invalid("Request JSON is not valid.");
    }
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/json";
    }
  }
  const expectedStatuses = form.expectStatus.split(",").map((value) => Number(value.trim())).filter((value) => Number.isFinite(value));
  if (!expectedStatuses.length || expectedStatuses.length > 20 || expectedStatuses.some((status) => !Number.isInteger(status) || status < 100 || status > 599)) {
    return invalid("Expected statuses must be comma-separated HTTP status codes.");
  }
  const timeoutMs = durationMs(form.timeout, form.timeoutUnit);
  if (timeoutMs == null || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    return invalid("Timeout must be from 1ms to 60 seconds.");
  }
  const latencyThreshold = form.latencyThreshold ? durationMs(form.latencyThreshold, form.latencyUnit) : null;
  if (form.latencyThreshold !== "" && (latencyThreshold == null || latencyThreshold < 1 || latencyThreshold >= timeoutMs)) {
    return invalid("Degrade-above must be at least 1ms and below the timeout. At or past timeout is a failure.");
  }
  const allowedHosts = [...new Set(form.allowedHosts.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean))];
  if (!allowedHosts.includes(url.hostname.toLowerCase())) allowedHosts.unshift(url.hostname.toLowerCase());
  // Build assertions payload
  const assertions: Array<{ path: string; op: AssertionOp; value?: AssertionValue }> = [];
  for (const row of form.assertions) {
    const path = row.path.trim();
    if (!path) continue;
    try {
      parseJsonPath(path);
    } catch {
      return invalid(`JSON path ${path} is not valid. Use $.key, $.list[0] or $['any key'].`);
    }
    if (isValueless(row.op)) {
      assertions.push({ path, op: row.op });
      continue;
    }
    const value = parseAssertionValue(row.op, row.value);
    if (value === undefined) return invalid(`Assertion ${path} needs a number to compare against.`);
    if (typeof value === "string" && isTextOp(row.op) && value.length > MAX_ASSERTION_VALUE_LENGTH) {
      return invalid(`Assertion ${path} is limited to ${MAX_ASSERTION_VALUE_LENGTH} characters.`);
    }
    assertions.push({ path, op: row.op, value });
  }
  if (assertions.length > 20) {
    return invalid("Maximum 20 assertions per check.");
  }
  if (form.bodyIncludes.trim().length > MAX_BODY_INCLUDES_LENGTH) {
    return invalid("Must include is limited to 8192 characters.");
  }
  return {
    ok: true,
    payload: {
      url: url.toString(),
      method: form.method,
      body: form.method === "POST" && body ? body : null,
      headers,
      allowedHosts,
      timeout: timeoutMs,
      followRedirects: form.followRedirects,
      degradedIf: latencyThreshold ? { latencyMs: latencyThreshold } : null,
      expect: {
        status: expectedStatuses.length === 1 ? expectedStatuses[0] : expectedStatuses,
        bodyIncludes: form.bodyIncludes.trim() || undefined,
        assertions: assertions.length ? assertions : undefined,
        assertionFailThreshold: assertions.length > 1 ? clampAssertionThreshold(form.assertionFailThreshold, assertions.length) : undefined,
      },
    },
  };
}

export type BuiltCheck = { ok: true; id: string; payload: Record<string, unknown> } | { ok: false; error: string };

/** The body of a create (POST) or an edit (PATCH), or the first thing wrong with the form. */
export function buildCheckPayload(form: CheckFormState, editing: Monitor | null, monitors: PlacedMonitor[]): BuiltCheck {
  const name = form.name.trim();
  if (!name) return { ok: false, error: "Name is required." };
  const id = editing?.id ?? slugify(name);
  const shared = {
    id,
    name,
    ...resolvePlacement({ groupName: form.groupName.trim() || "API", componentName: form.componentName.trim() || name }, editing, monitors),
    critical: form.critical,
  };

  const confirmFails = Number(form.confirmFails);
  if (!Number.isInteger(confirmFails) || confirmFails < 1 || confirmFails > 10) {
    return { ok: false, error: "Confirm after must be from 1 to 10 failures." };
  }

  if (form.checkType === "heartbeat") {
    return { ok: true, id, payload: { ...shared, type: "heartbeat", interval: form.interval, grace: form.grace, confirmFails } };
  }

  const request = buildHttpRequest(form);
  if (!request.ok) return request;
  const intervalMs = durationMs(form.intervalValue, form.intervalUnit);
  if (intervalMs == null || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
    return { ok: false, error: "Interval must be from 30 seconds to 24 hours." };
  }
  const retries = Number(form.retries);
  if (!Number.isInteger(retries) || retries < 0 || retries > 5) {
    return { ok: false, error: "Retries must be from 0 to 5." };
  }
  return {
    ok: true,
    id,
    payload: {
      ...(editing?.config ?? {}),
      ...shared,
      type: "http",
      ...request.payload,
      regions: form.regions.length ? form.regions : ["wnam"],
      interval: `${form.intervalValue}${form.intervalUnit}`,
      retries,
      failWhen: form.failWhen,
      confirmFails,
    },
  };
}
