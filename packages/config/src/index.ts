export const REGIONS = [
  "wnam",
  "enam",
  "sam",
  "weur",
  "eeur",
  "apac",
  "oc",
  "afr",
  "me",
] as const;

export type Region = (typeof REGIONS)[number];

export const MAX_MONITORS = 100;
export const MIN_INTERVAL_MS = 30_000;
export const MAX_TIMEOUT_MS = 30_000;
export const MAX_REGIONS = REGIONS.length;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_RETRIES = 2;
export const DEFAULT_CONFIRM_FAILS = 3;
export const BODY_READ_LIMIT = 64 * 1024;
export const SNIPPET_LIMIT = 2048;

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type CheckType = "http" | "heartbeat";
export type Origin = "git" | "ui";
export type RunOutcome = "pass" | "degraded" | "fail";
export type ComponentStatus = "unknown" | "operational" | "degraded" | "failing" | "maintenance";
export type BannerStatus = "unknown" | "fully_operational" | "degraded" | "failing";
export type FailWhen = "majority" | "any" | "all";
export type IncidentStatus = "investigating" | "identified" | "monitoring" | "resolved";
export type AlertEvent = "fail" | "degrade" | "recover";

export const SECRET_REF = "__foxwatch_secret__" as const;

export type SecretRef = { [SECRET_REF]: string };

export function secret(name: string): SecretRef {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) {
    throw new Error(`Invalid secret name "${name}". Use UPPER_SNAKE_CASE.`);
  }
  return { [SECRET_REF]: name };
}

export function isSecretRef(value: unknown): value is SecretRef {
  return (
    typeof value === "object" &&
    value !== null &&
    SECRET_REF in value &&
    typeof (value as SecretRef)[SECRET_REF] === "string"
  );
}

export function secretName(value: unknown): string | null {
  return isSecretRef(value) ? value[SECRET_REF] : null;
}

export const ASSERTION_OPS = [
  "exists",
  "not_exists",
  "equals",
  "not_equals",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "not_contains",
  "matches",
] as const;

export type AssertionOp = (typeof ASSERTION_OPS)[number];

export type Assertion = {
  path: string;
  op: AssertionOp;
  value?: string | number | boolean | null;
};

export const MAX_ASSERTIONS = 20;

export type HttpExpect = {
  status?: number | number[];
  header?: Record<string, string>;
  bodyIncludes?: string;
  /** @deprecated Use assertions[] instead */
  jsonPath?: { path: string; equals?: string | number | boolean; exists?: boolean };
  assertions?: Assertion[];
  assertionFailThreshold?: number;
};

export type HttpCheck = {
  type: "http";
  id: string;
  name?: string;
  url: string;
  method?: "GET" | "HEAD" | "POST";
  allowedHosts: string[];
  regions: Region[];
  intervalMs: number;
  timeoutMs: number;
  retries: number;
  followRedirects: boolean;
  headers: Record<string, string | SecretRef>;
  body?: string;
  expect: HttpExpect;
  degradedIf?: { latencyMs: number };
  failWhen?: FailWhen;
  confirmFails?: number;
  critical?: boolean;
};

export type HeartbeatCheck = {
  type: "heartbeat";
  id: string;
  name?: string;
  intervalMs: number;
  graceMs: number;
  confirmFails?: number;
  critical?: boolean;
};

export type Check = HttpCheck | HeartbeatCheck;

export type ComponentDef = {
  id: string;
  name: string;
  description?: string;
  critical?: boolean;
  checks: Check[];
};

export type GroupDef = {
  id: string;
  name: string;
  components: ComponentDef[];
};

export type AlertChannelDef = {
  id: string;
  type: "slack_webhook" | "webhook";
  secretName: string;
  events: AlertEvent[];
};

export type FoxwatchConfig = {
  site: {
    name: string;
    publicUrl?: string;
  };
  secrets: string[];
  regions: Region[];
  defaults: {
    intervalMs: number;
    timeoutMs: number;
    retries: number;
    degradedIf?: { latencyMs: number };
    failWhen: FailWhen;
    confirmFails: number;
  };
  groups: GroupDef[];
  alerts: AlertChannelDef[];
};

export type FlattenedMonitor = {
  id: string;
  origin: Origin;
  type: CheckType;
  name: string;
  groupId: string;
  groupName: string;
  componentId: string;
  componentName: string;
  critical: boolean;
  check: Check;
};

function parseDuration(input: string | number, field: string): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) throw new Error(`${field} must be positive`);
    return input;
  }
  const m = /^(\d+)(ms|s|m|h)$/.exec(input.trim());
  if (!m) throw new Error(`${field} must look like 30s, 1m, or 10m`);
  const n = Number(m[1]);
  const unit = m[2];
  const ms = unit === "ms" ? n : unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : n * 3_600_000;
  return ms;
}

function dumpDuration(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

function assertId(id: string, label: string) {
  if (!ID_RE.test(id)) {
    throw new Error(`${label} id "${id}" must match ${ID_RE}`);
  }
}

function resolveHosts(url: string, allowedHosts?: string[]): string[] {
  const parsed = new URL(url);
  if (!parsed.hostname || !["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("check URL must be an http(s) URL without credentials");
  }
  const host = parsed.hostname.toLowerCase();
  const hosts = (allowedHosts ?? [host]).map((h) => h.toLowerCase());
  if (!hosts.includes(host)) {
    throw new Error(`url host ${host} must be listed in allowedHosts`);
  }
  return hosts;
}

export type HttpInput = {
  url: string;
  name?: string;
  method?: HttpCheck["method"];
  allowedHosts?: string[];
  regions?: Region[];
  interval?: string | number;
  timeout?: string | number;
  retries?: number;
  followRedirects?: boolean;
  headers?: Record<string, string | SecretRef>;
  body?: string;
  expect?: HttpExpect;
  degradedIf?: { latencyMs: number };
  failWhen?: FailWhen;
  confirmFails?: number;
  critical?: boolean;
};

export type HeartbeatInput = {
  name?: string;
  interval: string | number;
  grace?: string | number;
  confirmFails?: number;
  critical?: boolean;
};

export function http(id: string, input: HttpInput): HttpCheck {
  assertId(id, "check");
  const allowedHosts = resolveHosts(input.url, input.allowedHosts);
  return {
    type: "http",
    id,
    name: input.name,
    url: input.url,
    method: input.method ?? "GET",
    allowedHosts,
    regions: input.regions ?? [],
    intervalMs: input.interval != null ? parseDuration(input.interval, "interval") : 0,
    timeoutMs: input.timeout != null ? parseDuration(input.timeout, "timeout") : 0,
    retries: input.retries ?? -1,
    followRedirects: input.followRedirects ?? true,
    headers: input.headers ?? {},
    body: input.body,
    expect: input.expect ?? { status: 200 },
    degradedIf: input.degradedIf,
    failWhen: input.failWhen,
    confirmFails: input.confirmFails,
    critical: input.critical,
  };
}

export function heartbeat(id: string, input: HeartbeatInput): HeartbeatCheck {
  assertId(id, "check");
  return {
    type: "heartbeat",
    id,
    name: input.name,
    intervalMs: parseDuration(input.interval, "interval"),
    graceMs: parseDuration(input.grace ?? "2m", "grace"),
    confirmFails: input.confirmFails,
    critical: input.critical,
  };
}

export type DefineConfigInput = {
  site: { name: string; publicUrl?: string };
  secrets?: string[];
  regions?: Region[];
  defaults?: {
    interval?: string | number;
    timeout?: string | number;
    retries?: number;
    degradedIf?: { latencyMs: number };
    failWhen?: FailWhen;
    confirmFails?: number;
  };
  groups: GroupDef[];
  alerts?: AlertChannelDef[];
};

function fillCheck(check: Check, defaults: FoxwatchConfig["defaults"], fallbackRegions: Region[]): Check {
  if (check.type === "heartbeat") {
    if (check.intervalMs < MIN_INTERVAL_MS) {
      throw new Error(`check ${check.id} interval must be >= ${MIN_INTERVAL_MS}ms`);
    }
    const confirmFails = check.confirmFails ?? defaults.confirmFails;
    if (!Number.isInteger(confirmFails) || confirmFails < 1 || confirmFails > 10) {
      throw new Error(`check ${check.id} confirmFails must be an integer from 1 to 10`);
    }
    return { ...check, confirmFails };
  }
  const regions = (check.regions.length ? check.regions : fallbackRegions).slice(0, MAX_REGIONS);
  const intervalMs = check.intervalMs || defaults.intervalMs;
  const timeoutMs = Math.min(check.timeoutMs || defaults.timeoutMs, MAX_TIMEOUT_MS);
  const retries = check.retries < 0 ? defaults.retries : check.retries;
  if (intervalMs < MIN_INTERVAL_MS) {
    throw new Error(`check ${check.id} interval must be >= ${MIN_INTERVAL_MS}ms`);
  }
  if (!Number.isInteger(retries) || retries < 0 || retries > 5) {
    throw new Error(`check ${check.id} retries must be an integer from 0 to 5`);
  }
  if (timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`check ${check.id} timeout must be from 1ms to ${MAX_TIMEOUT_MS}ms`);
  }
  const confirmFails = check.confirmFails ?? defaults.confirmFails;
  if (!Number.isInteger(confirmFails) || confirmFails < 1 || confirmFails > 10) {
    throw new Error(`check ${check.id} confirmFails must be an integer from 1 to 10`);
  }
  for (const r of regions) {
    if (!REGIONS.includes(r)) throw new Error(`unknown region ${r}`);
  }
  if (Object.keys(check.headers).length > 50) throw new Error(`check ${check.id} has too many headers`);
  for (const [name, value] of Object.entries(check.headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)) throw new Error(`check ${check.id} has an invalid header name`);
    if (typeof value === "string" && value.length > 8192) throw new Error(`check ${check.id} header value is too large`);
    if (/authorization|proxy-authorization|api[-_]?key|token|secret|cookie/i.test(name) && typeof value === "string") {
      throw new Error(`check ${check.id} sensitive header ${name} must use secret()`);
    }
  }
  if (check.body && new TextEncoder().encode(check.body).byteLength > BODY_READ_LIMIT) {
    throw new Error(`check ${check.id} body must be <= ${BODY_READ_LIMIT} bytes`);
  }
  const degradedIf = check.degradedIf ?? defaults.degradedIf;
  if (degradedIf && degradedIf.latencyMs >= timeoutMs) {
    throw new Error(`check ${check.id} degrade-above must be below timeout`);
  }
  return {
    ...check,
    regions,
    intervalMs,
    timeoutMs,
    retries,
    degradedIf,
    failWhen: check.failWhen ?? defaults.failWhen,
    confirmFails,
  };
}

export function defineConfig(input: DefineConfigInput): FoxwatchConfig {
  if (!input.site?.name?.trim()) throw new Error("site.name is required");
  const secrets = [...new Set(input.secrets ?? [])];
  for (const name of secrets) secret(name);

  const regions = input.regions?.length ? input.regions : (["wnam", "weur", "apac"] as Region[]);
  if (regions.length > MAX_REGIONS) throw new Error(`at most ${MAX_REGIONS} regions`);

  const defaults = {
    intervalMs: parseDuration(input.defaults?.interval ?? "1m", "defaults.interval"),
    timeoutMs: Math.min(parseDuration(input.defaults?.timeout ?? "10s", "defaults.timeout"), MAX_TIMEOUT_MS),
    retries: input.defaults?.retries ?? DEFAULT_RETRIES,
    degradedIf: input.defaults?.degradedIf,
    failWhen: input.defaults?.failWhen ?? "majority",
    confirmFails: input.defaults?.confirmFails ?? DEFAULT_CONFIRM_FAILS,
  };
  if (!Number.isInteger(defaults.retries) || defaults.retries < 0 || defaults.retries > 5) {
    throw new Error("defaults.retries must be an integer from 0 to 5");
  }
  if (defaults.degradedIf && defaults.degradedIf.latencyMs >= defaults.timeoutMs) {
    throw new Error("defaults degrade-above must be below timeout");
  }
  if (!Number.isInteger(defaults.confirmFails) || defaults.confirmFails < 1 || defaults.confirmFails > 10) {
    throw new Error("defaults.confirmFails must be an integer from 1 to 10");
  }

  const seen = new Set<string>();
  const groups: GroupDef[] = input.groups.map((g) => {
    assertId(g.id, "group");
    return {
      ...g,
      components: g.components.map((c) => {
        assertId(c.id, "component");
        return {
          ...c,
          checks: c.checks.map((ch) => {
            if (seen.has(ch.id)) throw new Error(`duplicate check id ${ch.id}`);
            seen.add(ch.id);
            const filled = fillCheck(ch, defaults, regions);
            if (filled.type === "http") {
              for (const value of Object.values(filled.headers)) {
                const n = secretName(value);
                if (n && !secrets.includes(n)) {
                  throw new Error(`check ${filled.id} references secret ${n} which is not in config.secrets`);
                }
              }
            }
            return filled;
          }),
        };
      }),
    };
  });

  const count = [...seen].length;
  if (count > MAX_MONITORS) throw new Error(`at most ${MAX_MONITORS} monitors`);

  const alerts = (input.alerts ?? []).map((a) => {
    assertId(a.id, "alert");
    secret(a.secretName);
    if (!secrets.includes(a.secretName)) {
      throw new Error(`alert ${a.id} references secret ${a.secretName} which is not in config.secrets`);
    }
    return { ...a, events: a.events.length ? a.events : (["fail", "degrade", "recover"] as AlertEvent[]) };
  });

  return { site: input.site, secrets, regions, defaults, groups, alerts };
}

export function flattenConfig(config: FoxwatchConfig, origin: Origin = "git"): FlattenedMonitor[] {
  const out: FlattenedMonitor[] = [];
  for (const group of config.groups) {
    for (const component of group.components) {
      for (const check of component.checks) {
        out.push({
          id: check.id,
          origin,
          type: check.type,
          name: check.name ?? check.id,
          groupId: group.id,
          groupName: group.name,
          componentId: component.id,
          componentName: component.name,
          critical: Boolean(check.critical ?? component.critical),
          check,
        });
      }
    }
  }
  return out;
}

export type MonitorRecord = {
  id: string;
  origin: Origin;
  drifted: boolean;
  type: CheckType;
  name: string;
  groupId: string;
  groupName: string;
  componentId: string;
  componentName: string;
  critical: boolean;
  configJson: string;
};

export function monitorFromFlat(m: FlattenedMonitor): MonitorRecord {
  return {
    id: m.id,
    origin: m.origin,
    drifted: false,
    type: m.type,
    name: m.name,
    groupId: m.groupId,
    groupName: m.groupName,
    componentId: m.componentId,
    componentName: m.componentName,
    critical: m.critical,
    configJson: JSON.stringify(m.check),
  };
}

export type ApplyPlan = {
  upsert: MonitorRecord[];
  remove: string[];
  unchanged: string[];
};

export function planApply(
  current: MonitorRecord[],
  desired: MonitorRecord[],
  opts: { keepDrift?: boolean } = {},
): ApplyPlan {
  const currentById = new Map(current.map((m) => [m.id, m]));
  const desiredIds = new Set(desired.map((m) => m.id));
  const upsert: MonitorRecord[] = [];
  const unchanged: string[] = [];
  const remove: string[] = [];

  for (const next of desired) {
    const prev = currentById.get(next.id);
    if (prev?.origin === "ui") {
      throw new Error(`cannot apply git monitor "${next.id}": id is owned by the UI`);
    }
    if (prev?.origin === "git" && prev.drifted && opts.keepDrift) {
      unchanged.push(next.id);
      continue;
    }
    upsert.push({ ...next, origin: "git", drifted: false });
  }

  for (const prev of current) {
    if (prev.origin === "git" && !desiredIds.has(prev.id)) {
      remove.push(prev.id);
    }
  }

  return { upsert, remove, unchanged };
}

export function markDrifted(record: MonitorRecord, patch: Partial<MonitorRecord>): MonitorRecord {
  return { ...record, ...patch, origin: record.origin, drifted: record.origin === "git" };
}

function parseSecretValue(raw: unknown): string | SecretRef {
  if (isSecretRef(raw)) return raw;
  if (typeof raw === "string" && raw.startsWith("secret:")) {
    return secret(raw.slice("secret:".length));
  }
  if (typeof raw === "string") return raw;
  throw new Error("header values must be strings or secret:NAME");
}

export function configFromYamlLike(raw: unknown): FoxwatchConfig {
  if (!raw || typeof raw !== "object") throw new Error("config must be an object");
  const r = raw as Record<string, unknown>;
  const site = r.site as { name: string; publicUrl?: string };
  const groupsIn = (r.groups as Array<Record<string, unknown>>) ?? [];
  const groups: GroupDef[] = groupsIn.map((g) => ({
    id: String(g.id),
    name: String(g.name),
    components: ((g.components as Array<Record<string, unknown>>) ?? []).map((c) => ({
      id: String(c.id),
      name: String(c.name),
      description: c.description ? String(c.description) : undefined,
      critical: Boolean(c.critical),
      checks: ((c.checks as Array<Record<string, unknown>>) ?? []).map((ch) => {
        const id = String(ch.id);
        const type = ch.type === "heartbeat" ? "heartbeat" : "http";
        if (type === "heartbeat") {
          return heartbeat(id, {
            name: ch.name ? String(ch.name) : undefined,
            interval: (ch.interval as string | number) ?? "10m",
            grace: (ch.grace as string | number) ?? "2m",
            critical: Boolean(ch.critical),
            confirmFails: ch.confirmFails as number | undefined,
          });
        }
        const headersIn = (ch.headers as Record<string, unknown>) ?? {};
        const headers: Record<string, string | SecretRef> = {};
        for (const [k, v] of Object.entries(headersIn)) {
          headers[k] = parseSecretValue(v);
        }
        return http(id, {
          url: String(ch.url),
          name: ch.name ? String(ch.name) : undefined,
          method: ch.method as HttpCheck["method"],
          allowedHosts: ch.allowedHosts as string[] | undefined,
          regions: ch.regions as Region[] | undefined,
          interval: ch.interval as string | number | undefined,
          timeout: ch.timeout as string | number | undefined,
          retries: ch.retries as number | undefined,
          followRedirects: ch.followRedirects as boolean | undefined,
          headers,
          body: ch.body ? String(ch.body) : undefined,
          expect: (ch.expect as HttpExpect) ?? { status: 200 },
          degradedIf: ch.degradedIf as { latencyMs: number } | undefined,
          failWhen: ch.failWhen as FailWhen | undefined,
          confirmFails: ch.confirmFails as number | undefined,
          critical: Boolean(ch.critical),
        });
      }),
    })),
  }));

  const alertsIn = (r.alerts as Array<Record<string, unknown>>) ?? [];
  return defineConfig({
    site,
    secrets: r.secrets as string[] | undefined,
    regions: r.regions as Region[] | undefined,
    defaults: r.defaults as DefineConfigInput["defaults"],
    groups,
    alerts: alertsIn.map((a) => ({
      id: String(a.id),
      type: a.type === "webhook" ? "webhook" : "slack_webhook",
      secretName: String(a.secretName ?? a.url_secret ?? a.secret_name),
      events: (a.events as AlertEvent[]) ?? ["fail", "degrade", "recover"],
    })),
  });
}

export function configHash(config: FoxwatchConfig): string {
  return JSON.stringify(config);
}

export function dumpConfig(config: FoxwatchConfig): unknown {
  return {
    site: config.site,
    secrets: config.secrets,
    regions: config.regions,
    defaults: {
      interval: `${config.defaults.intervalMs / 1000}s`,
      timeout: dumpDuration(config.defaults.timeoutMs),
      retries: config.defaults.retries,
      degradedIf: config.defaults.degradedIf,
      failWhen: config.defaults.failWhen,
      confirmFails: config.defaults.confirmFails,
    },
    groups: config.groups.map((g) => ({
      id: g.id,
      name: g.name,
      components: g.components.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        critical: c.critical,
        checks: c.checks.map((ch) => {
          if (ch.type === "heartbeat") {
            return {
              id: ch.id,
              type: "heartbeat",
              interval: `${ch.intervalMs / 1000}s`,
              grace: `${ch.graceMs / 1000}s`,
              confirmFails: ch.confirmFails,
              critical: ch.critical,
            };
          }
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(ch.headers)) {
            headers[k] = isSecretRef(v) ? `secret:${v[SECRET_REF]}` : v;
          }
          return {
            id: ch.id,
            type: "http",
            url: ch.url,
            allowedHosts: ch.allowedHosts,
            regions: ch.regions,
            method: ch.method,
            interval: `${ch.intervalMs / 1000}s`,
            timeout: dumpDuration(ch.timeoutMs),
            retries: ch.retries,
            headers,
            expect: ch.expect,
            degradedIf: ch.degradedIf,
            failWhen: ch.failWhen,
            confirmFails: ch.confirmFails,
            critical: ch.critical,
          };
        }),
      })),
    })),
    alerts: config.alerts,
  };
}
