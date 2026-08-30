import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { api } from "./api.ts";
import {
  clampDuration,
  convertDuration,
  durationMs,
  maxAmount,
  parseDurationToken,
  sanitizeInt,
  splitDuration,
  unitsForCap,
  UNIT_LABEL,
  type DurationUnit,
} from "./duration.ts";
import { MAX_INTERVAL_MS, MAX_REGIONS, MAX_TIMEOUT_MS, MIN_INTERVAL_MS, REGIONS } from "@foxwatch/config";
import { regionLabel, regionTitle } from "./labels.ts";
import { CopyPanel, ErrorText, InfoTip, Mark, Seg, useActionFlash } from "./ui.tsx";

function rejectNonDigitKey(e: KeyboardEvent<HTMLInputElement>) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.length === 1 && !/\d/.test(e.key)) e.preventDefault();
}

const METHODS = ["GET", "HEAD", "POST"] as const;
const INTERVALS_HB = ["1m", "5m", "10m", "15m"] as const;
const INTERVAL_UNITS: DurationUnit[] = ["s", "m", "h"];
const GRACES = ["30s", "1m", "2m", "5m"] as const;
const DEFAULT_REGIONS = ["wnam", "weur", "apac"];
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

const ASSERTION_OPS = [
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

type AssertionOp = (typeof ASSERTION_OPS)[number]["value"];
type AssertionRow = { path: string; op: AssertionOp; value: string };

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
    assertions?: Array<{ path: string; op: string; value?: string | number | boolean | null }>;
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

type HeaderRow = { key: string; kind: "text" | "secret"; value: string };
type CheckKind = "http" | "heartbeat";

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

type CheckFormState = {
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
  interval: string;
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

function emptyForm(): CheckFormState {
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
    interval: "1m",
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

function formFromMonitor(m: Monitor): CheckFormState {
  const cfg = m.config;
  const expect = cfg.expect ?? {};
  const status = Array.isArray(expect.status) ? expect.status.join(", ") : expect.status;
  // Load assertions, converting legacy jsonPath if present
  let assertions: AssertionRow[] = [];
  if (expect.assertions?.length) {
    assertions = expect.assertions.map((a) => ({
      path: a.path,
      op: a.op as AssertionOp,
      value: a.value == null ? "" : String(a.value),
    }));
  } else if (expect.jsonPath) {
    const jp = expect.jsonPath;
    if (jp.exists) {
      assertions = [{ path: jp.path, op: "exists", value: "" }];
    } else if (jp.equals !== undefined) {
      assertions = [{ path: jp.path, op: "equals", value: String(jp.equals) }];
    }
  }
  const timeout = timeoutFromMs(cfg.timeoutMs);
  const timeoutMs = durationMs(timeout.value, timeout.unit) ?? 10_000;
  const degradeRaw = cfg.degradedIf?.latencyMs ? splitDuration(cfg.degradedIf.latencyMs) : { value: "", unit: "ms" as const };
  const degrade = clampDuration(degradeRaw.value, degradeRaw.unit, Math.max(1, timeoutMs - 1));
  return {
    checkType: m.type === "heartbeat" ? "heartbeat" : "http",
    name: m.name,
    url: String(cfg.url ?? "https://"),
    method: (METHODS.includes(cfg.method as (typeof METHODS)[number]) ? cfg.method : "GET") as (typeof METHODS)[number],
    headers: headersToRows(cfg.headers),
    body: String(cfg.body ?? ""),
    expectStatus: String(status ?? 200),
    bodyIncludes: String(expect.bodyIncludes ?? ""),
    assertions,
    assertionFailThreshold: expect.assertionFailThreshold ?? 1,
    interval: intervalFromMs(cfg.intervalMs),
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

type TestResult = {
  outcome: string;
  latencyMs: number | null;
  statusCode: number | null;
  colo: string | null;
  errorClass: string | null;
  responseSnippet: string | null;
};

function IntInput({
  id,
  value,
  min,
  max,
  required,
  placeholder,
  onChange,
}: {
  id: string;
  value: string;
  min: number;
  max: number;
  required?: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      id={id}
      className="check-plain check-plain-num"
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={1}
      required={required}
      placeholder={placeholder}
      autoComplete="off"
      value={value}
      onKeyDown={rejectNonDigitKey}
      onChange={(e) => {
        const next = sanitizeInt(e.target.value, max, min);
        if (next === undefined) return;
        onChange(next);
      }}
    />
  );
}

function DurationInput({
  id,
  value,
  unit,
  capMs,
  required,
  placeholder,
  units: unitList,
  min = 1,
  onChange,
}: {
  id: string;
  value: string;
  unit: DurationUnit;
  capMs: number;
  required?: boolean;
  placeholder?: string;
  units?: DurationUnit[];
  min?: number;
  onChange: (value: string, unit: DurationUnit) => void;
}) {
  const units = (unitList ?? unitsForCap(capMs)).filter((u) => maxAmount(u, capMs) >= min);
  const max = Math.max(min, maxAmount(unit, capMs));
  return (
    <span className="check-duration">
      <IntInput id={id} value={value} min={min} max={max} required={required} placeholder={placeholder} onChange={(next) => onChange(next, unit)} />
      <select
        className="check-plain check-unit"
        aria-label="Unit"
        value={units.includes(unit) ? unit : (units[0] ?? "ms")}
        onChange={(e) => {
          const next = e.target.value as DurationUnit;
          onChange(convertDuration(value, unit, next, capMs, min), next);
        }}
      >
        {units.map((id) => (
          <option key={id} value={id}>
            {UNIT_LABEL[id]}
          </option>
        ))}
      </select>
    </span>
  );
}

export function CheckForm({
  monitor,
  secrets,
  onDone,
  onCancel,
}: {
  monitor: Monitor | null;
  secrets: string[];
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const editing = monitor;
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [curl, setCurl] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testPending, setTestPending] = useState(false);
  const { flash, flashOkThen } = useActionFlash();

  useEffect(() => {
    const next = editing ? formFromMonitor(editing) : emptyForm();
    setForm(next);
    setError(null);
    setCurl(null);
    setTestResult(null);
    setAdvancedOpen(false);
  }, [editing?.id]);

  const host = useMemo(() => {
    try {
      return new URL(form.url).hostname;
    } catch {
      return "";
    }
  }, [form.url]);

  function set<K extends keyof CheckFormState>(key: K, value: CheckFormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function setKind(checkType: CheckKind) {
    if (editing) return;
    setForm((f) => ({ ...f, checkType, interval: checkType === "heartbeat" ? "10m" : "1m" }));
  }

  function toggleRegion(id: string) {
    setForm((f) => {
      if (f.regions.includes(id)) {
        if (f.regions.length === 1) return f;
        return { ...f, regions: f.regions.filter((r) => r !== id) };
      }
      return { ...f, regions: [...f.regions, id] };
    });
  }

  async function sendTestRequest() {
    setTestResult(null);
    setError(null);
    let url: URL;
    try {
      url = new URL(form.url);
    } catch {
      setError("Enter a valid URL to test.");
      return;
    }
    setTestPending(true);
    const headers = rowsToHeaders(form.headers);
    const body = form.method === "POST" && form.body.trim() ? form.body.trim() : undefined;
    const res = await api<TestResult>("/api/ops/monitors/test-request", {
      method: "POST",
      body: JSON.stringify({
        url: url.toString(),
        method: form.method,
        headers,
        body,
        timeout: durationMs(form.timeout, form.timeoutUnit) ?? 10_000,
        expect: { status: Number(form.expectStatus.split(",")[0]) || 200 },
      }),
    });
    setTestPending(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setTestResult(res.data);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const name = form.name.trim();
    if (!name) {
      setError("Name is required.");
      return;
    }
    const id = editing?.id ?? slugify(name);
    const componentName = form.componentName.trim() || name;
    const shared = {
      id,
      name,
      groupId: editing?.groupId ?? slugify(form.groupName.trim() || "api"),
      groupName: form.groupName.trim() || "API",
      componentId: editing?.componentId ?? slugify(componentName),
      componentName,
      critical: form.critical,
    };

    const confirmFails = Number(form.confirmFails);
    if (!Number.isInteger(confirmFails) || confirmFails < 1 || confirmFails > 10) {
      setError("Confirm after must be from 1 to 10 failures.");
      return;
    }

    let payload: Record<string, unknown>;
    if (form.checkType === "heartbeat") {
      payload = { ...shared, type: "heartbeat", interval: form.interval, grace: form.grace, confirmFails };
    } else {
      let url: URL;
      try {
        url = new URL(form.url);
      } catch {
        setError("Enter a valid URL, including https://");
        return;
      }
      if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) {
        setError("Use HTTPS. Plain HTTP is only available for local development targets.");
        return;
      }
      const headers = rowsToHeaders(form.headers);
      for (const row of form.headers) {
        if (row.kind === "secret" && row.value.trim() && !SECRET_NAME_RE.test(row.value.trim())) {
          setError("Secret names must look like API_TOKEN (A-Z, 0-9, _).");
          return;
        }
      }
      let body = form.body.trim();
      if (form.method === "POST" && body) {
        try {
          body = JSON.stringify(JSON.parse(body));
        } catch {
          setError("Request JSON is not valid.");
          return;
        }
        if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
          headers["Content-Type"] = "application/json";
        }
      }
      const expectedStatuses = form.expectStatus.split(",").map((value) => Number(value.trim())).filter((value) => Number.isFinite(value));
      if (!expectedStatuses.length || expectedStatuses.length > 20 || expectedStatuses.some((status) => !Number.isInteger(status) || status < 100 || status > 599)) {
        setError("Expected statuses must be comma-separated HTTP status codes.");
        return;
      }
      const timeoutMs = durationMs(form.timeout, form.timeoutUnit);
      if (timeoutMs == null || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
        setError("Timeout must be from 1ms to 60 seconds.");
        return;
      }
      const intervalMs = parseDurationToken(form.interval);
      if (intervalMs == null || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
        setError("Interval must be from 30 seconds to 24 hours.");
        return;
      }
      const retries = Number(form.retries);
      if (!Number.isInteger(retries) || retries < 0 || retries > 5) {
        setError("Retries must be from 0 to 5.");
        return;
      }
      const latencyThreshold = form.latencyThreshold ? durationMs(form.latencyThreshold, form.latencyUnit) : null;
      if (form.latencyThreshold !== "" && (latencyThreshold == null || latencyThreshold < 1 || latencyThreshold >= timeoutMs)) {
        setError("Degrade-above must be at least 1ms and below the timeout. At or past timeout is a failure.");
        return;
      }
      const allowedHosts = [...new Set(form.allowedHosts.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean))];
      if (!allowedHosts.includes(url.hostname.toLowerCase())) allowedHosts.unshift(url.hostname.toLowerCase());
      // Build assertions payload
      const validAssertions = form.assertions
        .filter((a) => a.path.trim())
        .map((a) => {
          const base: { path: string; op: string; value?: string | number | boolean | null } = { path: a.path.trim(), op: a.op };
          if (a.op === "exists" || a.op === "not_exists") return base;
          // Try to parse as number or boolean
          const v = a.value.trim();
          if (v === "true") base.value = true;
          else if (v === "false") base.value = false;
          else if (v === "null") base.value = null;
          else if (v !== "" && Number.isFinite(Number(v))) base.value = Number(v);
          else base.value = v;
          return base;
        });
      if (validAssertions.length > 20) {
        setError("Maximum 20 assertions per check.");
        return;
      }
      payload = {
        ...(editing?.config ?? {}),
        ...shared,
        type: "http",
        url: url.toString(),
        method: form.method,
        body: form.method === "POST" && body ? body : undefined,
        headers,
        allowedHosts,
        regions: form.regions.length ? form.regions : ["wnam"],
        interval: form.interval,
        timeout: timeoutMs,
        retries,
        followRedirects: form.followRedirects,
        failWhen: form.failWhen,
        confirmFails,
        degradedIf: latencyThreshold ? { latencyMs: latencyThreshold } : undefined,
        expect: {
          status: expectedStatuses.length === 1 ? expectedStatuses[0] : expectedStatuses,
          bodyIncludes: form.bodyIncludes.trim() || undefined,
          assertions: validAssertions.length ? validAssertions : undefined,
          assertionFailThreshold: validAssertions.length > 1 ? form.assertionFailThreshold : undefined,
        },
      };
    }

    setPending(true);
    const res = editing
      ? await api<{ ok: boolean }>(`/api/ops/monitors/${editing.id}`, { method: "PATCH", body: JSON.stringify(payload) })
      : await api<{ ok: boolean }>("/api/ops/monitors", { method: "POST", body: JSON.stringify(payload) });
    if (!res.ok) {
      setPending(false);
      setError(res.error);
      return;
    }
    setPending(false);
    if (!editing && form.checkType === "heartbeat") {
      const rot = await api<{ token: string; curl: string }>(`/api/ops/heartbeats/${id}/rotate`, { method: "POST", body: "{}" });
      if (rot.ok) {
        setCurl(rot.data.curl);
        return;
      }
    }
    flashOkThen(() => {
      void onDone();
    });
  }

  const intervalParts = splitDuration(parseDurationToken(form.interval) ?? 60_000);
  const intervalUnit = INTERVAL_UNITS.includes(intervalParts.unit) ? intervalParts.unit : "m";

  return (
    <form className="card check-form" onSubmit={submit}>
      <div className="check-form-head">
        <h2 className="section-title">{editing ? "Edit check" : "New check"}</h2>
      </div>

      {/* Section 1: Identity */}
      <section className="check-sheet" aria-label="Check identity">
        <div className="check-row">
          <span className="check-row-k" id="check-type-label">
            Type
            <InfoTip>HTTP polls an endpoint on a schedule. Heartbeat waits for your service to ping in.</InfoTip>
          </span>
          <Seg
            labelledBy="check-type-label"
            value={form.checkType}
            options={[
              { id: "http", label: "HTTP" },
              { id: "heartbeat", label: "Heartbeat" },
            ]}
            disabled={Boolean(editing)}
            onChange={(id) => setKind(id as CheckKind)}
          />
        </div>
        <label className="check-row" htmlFor="check-name">
          <span className="check-row-k">
            Name
            <InfoTip>Display name on the public status page and in alerts.</InfoTip>
          </span>
          <input
            id="check-name"
            className="check-plain"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Checkout API"
            required
            autoComplete="off"
          />
        </label>
        <label className="check-row" htmlFor="check-group">
          <span className="check-row-k">
            Group
            <InfoTip>Groups organize checks on the public page (e.g. API, Web, Database).</InfoTip>
          </span>
          <input id="check-group" className="check-plain" value={form.groupName} onChange={(e) => set("groupName", e.target.value)} placeholder="API" autoComplete="off" />
        </label>
      </section>

      {/* Section 2: Request config */}
      {form.checkType === "http" ? (
        <section className="check-sheet" aria-label="Request">
          <div className="check-req-block">
            <div className="check-req" role="group" aria-label="Request">
              <Seg label="Method" value={form.method} options={METHODS.map((m) => ({ id: m, label: m }))} onChange={(id) => set("method", id as (typeof METHODS)[number])} />
              <input
                id="check-url"
                className="check-plain check-plain-mono"
                value={form.url}
                onChange={(e) => set("url", e.target.value)}
                placeholder="https://api.example.com/health"
                required
                aria-label="URL"
                autoComplete="off"
              />
            </div>
          </div>
          <div className="check-split">
            <label className="check-row" htmlFor="check-status">
              <span className="check-row-k">
                Expect
                <InfoTip>HTTP status codes to treat as healthy. Comma-separate multiples (200, 204).</InfoTip>
              </span>
              <input id="check-status" className="check-plain" inputMode="text" value={form.expectStatus} onChange={(e) => set("expectStatus", e.target.value)} placeholder="200, 204" />
            </label>
            <label className="check-row" htmlFor="check-interval">
              <span className="check-row-k">
                Every
                <InfoTip>How often to probe this endpoint. Type a whole number and pick sec, min, or hr (30 seconds to 24 hours).</InfoTip>
              </span>
              <DurationInput
                id="check-interval"
                value={intervalParts.value}
                unit={intervalUnit}
                capMs={MAX_INTERVAL_MS}
                units={INTERVAL_UNITS}
                min={intervalUnit === "s" ? 30 : 1}
                required
                onChange={(value, unit) => set("interval", `${value}${unit}`)}
              />
            </label>
          </div>
          <div className="check-row check-row-stack">
            <span className="check-row-k" id="check-regions-label">
              Probe from
              <InfoTip>Regions where probes run. At least 1. More regions = fewer false positives.</InfoTip>
            </span>
            <div className="region-picks" role="group" aria-labelledby="check-regions-label">
              {REGIONS.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="region-chip"
                  aria-pressed={form.regions.includes(id)}
                  disabled={!form.regions.includes(id) && form.regions.length >= MAX_REGIONS}
                  title={regionTitle(id)}
                  onClick={() => toggleRegion(id)}
                >
                  {regionLabel(id)}
                </button>
              ))}
            </div>
          </div>
          {/* Test Request */}
          <div className="check-test-block">
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              disabled={testPending || !host}
              onClick={() => void sendTestRequest()}
            >
              {testPending ? "Sending…" : "Send test request"}
            </button>
            <span className="text-xs text-muted">Does not count toward monitoring.</span>
          </div>
        </section>
      ) : (
        <section className="check-sheet" aria-label="Heartbeat">
          <div className="check-split">
            <label className="check-row" htmlFor="check-interval">
              <span className="check-row-k">
                Ping every
                <InfoTip>Expected interval between heartbeat pings from your service.</InfoTip>
              </span>
              <select id="check-interval" className="check-plain check-plain-end" value={form.interval} onChange={(e) => set("interval", e.target.value)}>
                {!INTERVALS_HB.includes(form.interval as never) ? <option value={form.interval}>{form.interval}</option> : null}
                {INTERVALS_HB.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="check-row" htmlFor="check-grace">
              <span className="check-row-k">
                Late by
                <InfoTip>Grace period after the expected ping before marking as failed.</InfoTip>
              </span>
              <select id="check-grace" className="check-plain check-plain-end" value={form.grace} onChange={(e) => set("grace", e.target.value)}>
                {!GRACES.includes(form.grace as never) ? <option value={form.grace}>{form.grace}</option> : null}
                {GRACES.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="check-sheet-note">Your job POSTs a ping. Later than interval plus grace, the check fails.</p>
        </section>
      )}

      {/* Test result panel */}
      {testResult ? (
        <div className="test-result-panel">
          <div className="test-result-head">
            <Mark status={testResult.errorClass ? "bad" : testResult.outcome === "pass" ? "ok" : testResult.outcome === "degraded" ? "warn" : "bad"} />
            <span className="test-result-status">
              {testResult.errorClass ? testResult.errorClass : testResult.statusCode ? `HTTP ${testResult.statusCode}` : testResult.outcome}
            </span>
            {testResult.latencyMs != null ? <span className="test-result-latency">{testResult.latencyMs}ms</span> : null}
            {testResult.colo ? <span className="test-result-latency">{testResult.colo}</span> : null}
            <button className="check-quiet" type="button" onClick={() => setTestResult(null)}>Dismiss</button>
          </div>
          {testResult.responseSnippet ? (
            <TestResponseBody text={testResult.responseSnippet} />
          ) : null}
        </div>
      ) : null}

      {/* Advanced section */}
      <details className="advanced" open={advancedOpen} onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}>
        <summary>
          Advanced
          <svg className="chev" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </summary>
        <div className="advanced-body">
          <div className="advanced-inner">
            {form.checkType === "http" ? (
              <>
                <div className="check-adv-cluster">
                  <p className="check-adv-label">Request</p>
                  <div className="check-hdrs">
                    <span className="check-row-k">
                      Headers
                      <InfoTip>Sent with each probe. Use Secret for values stored in the vault.</InfoTip>
                    </span>
                    {form.headers.map((row, i) => (
                    <div key={i} className="check-hdr">
                      <input
                        className="check-plain"
                        placeholder="Header"
                        value={row.key}
                        onChange={(e) => set("headers", form.headers.map((h, j) => (j === i ? { ...h, key: e.target.value } : h)))}
                        aria-label="Header name"
                      />
                      <select
                        className="check-plain check-plain-end"
                        value={row.kind}
                        onChange={(e) => set("headers", form.headers.map((h, j) => (j === i ? { ...h, kind: e.target.value as HeaderRow["kind"], value: "" } : h)))}
                        aria-label="Header value type"
                      >
                        <option value="text">Text</option>
                        <option value="secret">Secret</option>
                      </select>
                      {row.kind === "secret" ? (
                        <input
                          className="check-plain check-plain-mono"
                          list="secret-names"
                          placeholder="API_TOKEN"
                          value={row.value}
                          onChange={(e) => set("headers", form.headers.map((h, j) => (j === i ? { ...h, value: e.target.value.toUpperCase() } : h)))}
                          aria-label="Secret name"
                          autoComplete="off"
                        />
                      ) : (
                        <input
                          className="check-plain"
                          placeholder="Value"
                          value={row.value}
                          onChange={(e) => set("headers", form.headers.map((h, j) => (j === i ? { ...h, value: e.target.value } : h)))}
                          aria-label="Header value"
                        />
                      )}
                      <button
                        type="button"
                        className="check-quiet"
                        onClick={() => set("headers", form.headers.filter((_, j) => j !== i).length ? form.headers.filter((_, j) => j !== i) : [{ key: "", kind: "text", value: "" }])}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <button type="button" className="check-quiet check-quiet-ink" onClick={() => set("headers", [...form.headers, { key: "", kind: "text", value: "" }])}>
                    Add header
                  </button>
                  <datalist id="secret-names">
                    {secrets.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                </div>
                {form.method === "POST" ? (
                  <label className="check-row check-row-stack" htmlFor="check-body">
                    <span className="check-row-k">JSON body</span>
                    <textarea id="check-body" className="input input-code" value={form.body} onChange={(e) => set("body", e.target.value)} placeholder={'{\n  "check": true\n}'} />
                  </label>
                ) : null}
                  <label className="check-row" htmlFor="check-redirects">
                    <span className="check-row-k check-row-k-wide">
                      Redirects
                      <InfoTip>Follow HTTP redirects to allowed hosts automatically.</InfoTip>
                    </span>
                    <span className="check-row-hint">Follow safe redirects</span>
                    <input id="check-redirects" type="checkbox" checked={form.followRedirects} onChange={(e) => set("followRedirects", e.target.checked)} />
                  </label>
                </div>
                <div className="check-adv-cluster">
                  <p className="check-adv-label">Response</p>
                  <label className="check-row" htmlFor="check-includes">
                    <span className="check-row-k">
                      Must include
                      <InfoTip>String that must appear in the response body for the check to pass.</InfoTip>
                    </span>
                    <input id="check-includes" className="check-plain" value={form.bodyIncludes} onChange={(e) => set("bodyIncludes", e.target.value)} placeholder='e.g. "ok"' />
                  </label>
                  <div className="check-assertions">
                    <span className="check-row-k">
                      Assertions
                      <InfoTip>JSON path assertions on the response body. Use $.key.nested[0] syntax. Wildcard matching uses * and ? characters.</InfoTip>
                    </span>
                    {form.assertions.map((row, i) => (
                      <div key={i} className="check-assertion-row">
                        <input
                          className="check-assertion-path"
                          placeholder="$.data.status"
                          value={row.path}
                          onChange={(e) => set("assertions", form.assertions.map((a, j) => j === i ? { ...a, path: e.target.value } : a))}
                          aria-label="JSON path"
                        />
                        <select
                          className="check-assertion-op"
                          value={row.op}
                          onChange={(e) => set("assertions", form.assertions.map((a, j) => j === i ? { ...a, op: e.target.value as AssertionOp } : a))}
                          aria-label="Operator"
                        >
                          {ASSERTION_OPS.map((op) => (
                            <option key={op.value} value={op.value}>{op.label}</option>
                          ))}
                        </select>
                        {row.op !== "exists" && row.op !== "not_exists" ? (
                          <input
                            className="check-assertion-val"
                            placeholder={row.op === "contains" || row.op === "not_contains" ? "substring" : row.op === "matches" ? "pattern*" : "value"}
                            value={row.value}
                            onChange={(e) => set("assertions", form.assertions.map((a, j) => j === i ? { ...a, value: e.target.value } : a))}
                            aria-label="Expected value"
                          />
                        ) : null}
                        <button
                          type="button"
                          className="check-assertion-rm"
                          onClick={() => set("assertions", form.assertions.filter((_, j) => j !== i))}
                          aria-label="Remove assertion"
                        >
                          &times;
                        </button>
                      </div>
                    ))}
                    <button type="button" className="check-assertion-add" onClick={() => set("assertions", [...form.assertions, { path: "", op: "exists" as AssertionOp, value: "" }])}>
                      + Add assertion
                    </button>
                    {form.assertions.length > 1 ? (
                      <label className="check-row check-assertion-threshold" htmlFor="check-assert-threshold">
                        <span className="check-row-k">
                          Fail threshold
                          <InfoTip>Number of assertions that must fail before the check is marked as failed.</InfoTip>
                        </span>
                        <input
                          id="check-assert-threshold"
                          className="check-plain check-plain-num"
                          type="number"
                          min={1}
                          max={form.assertions.length}
                          value={form.assertionFailThreshold}
                          onChange={(e) => set("assertionFailThreshold", Math.max(1, Math.min(form.assertions.length, Number(e.target.value) || 1)))}
                        />
                      </label>
                    ) : null}
                  </div>
                </div>
                <div className="check-adv-cluster">
                  <p className="check-adv-label">Timing</p>
                  <label className="check-row" htmlFor="check-timeout">
                    <span className="check-row-k">
                      Timeout
                      <InfoTip>Max wait for a response. The probe fails at or past this limit (up to 60 seconds). Type a whole number and pick ms or sec.</InfoTip>
                    </span>
                    <DurationInput
                      id="check-timeout"
                      value={form.timeout}
                      unit={form.timeoutUnit}
                      capMs={MAX_TIMEOUT_MS}
                      required
                      onChange={(timeout, timeoutUnit) =>
                        setForm((f) => {
                          const timeoutMs = durationMs(timeout, timeoutUnit) ?? MAX_TIMEOUT_MS;
                          const next = clampDuration(f.latencyThreshold, f.latencyUnit, Math.max(1, timeoutMs - 1));
                          return { ...f, timeout, timeoutUnit, latencyThreshold: next.value, latencyUnit: next.unit };
                        })
                      }
                    />
                  </label>
                  <label className="check-row" htmlFor="check-latency">
                    <span className="check-row-k">
                      Degrade above
                      <InfoTip>Latency that marks the check degraded, not failed. Must be below timeout. At or past timeout is a failure. Leave empty to turn off.</InfoTip>
                    </span>
                    <DurationInput
                      id="check-latency"
                      value={form.latencyThreshold}
                      unit={form.latencyUnit}
                      capMs={Math.max(1, (durationMs(form.timeout, form.timeoutUnit) ?? MAX_TIMEOUT_MS) - 1)}
                      placeholder="off"
                      onChange={(latencyThreshold, latencyUnit) => setForm((f) => ({ ...f, latencyThreshold, latencyUnit }))}
                    />
                  </label>
                </div>
              </>
            ) : null}
            <div className="check-adv-cluster">
              <p className="check-adv-label">Failures</p>
              {form.checkType === "http" ? (
                <>
                  <label className="check-row" htmlFor="check-retries">
                    <span className="check-row-k">
                      Retries
                      <InfoTip>Number of immediate retries before counting a probe as failed (0–5).</InfoTip>
                    </span>
                    <IntInput id="check-retries" value={form.retries} min={0} max={5} required onChange={(retries) => set("retries", retries)} />
                  </label>
                  <label className="check-row" htmlFor="check-fail-when">
                    <span className="check-row-k">
                      Fail when
                      <InfoTip>How many probe regions must fail before the check is considered failing.</InfoTip>
                    </span>
                    <select id="check-fail-when" className="check-plain check-plain-end" value={form.failWhen} onChange={(e) => set("failWhen", e.target.value as CheckFormState["failWhen"])}>
                      <option value="majority">Most regions fail</option>
                      <option value="any">Any region fails</option>
                      <option value="all">All regions fail</option>
                    </select>
                  </label>
                </>
              ) : null}
              <label className="check-row" htmlFor="check-confirm-fails">
                <span className="check-row-k">
                  Confirm after
                  <InfoTip>Consecutive failures before the public status changes (1–10). Prevents flapping.</InfoTip>
                </span>
                <IntInput id="check-confirm-fails" value={form.confirmFails} min={1} max={10} required onChange={(confirmFails) => set("confirmFails", confirmFails)} />
              </label>
            </div>
            <div className="check-adv-cluster">
              <p className="check-adv-label">Status page</p>
              <label className="check-row" htmlFor="check-component">
                <span className="check-row-k">
                  Component
                  <InfoTip>Public-facing component name. Defaults to the check name. Multiple checks can share one component.</InfoTip>
                </span>
                <input id="check-component" className="check-plain" value={form.componentName} onChange={(e) => set("componentName", e.target.value)} placeholder="Same as name" />
              </label>
              <label className="check-row" htmlFor="check-critical">
                <span className="check-row-k check-row-k-wide">
                  Critical
                  <InfoTip>When critical, a failure marks the entire public page as "Outage" immediately.</InfoTip>
                </span>
                <span className="check-row-hint">Failures take the public page to failing</span>
                <input id="check-critical" type="checkbox" checked={form.critical} onChange={(e) => set("critical", e.target.checked)} />
              </label>
            </div>
          </div>
        </div>
      </details>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {curl ? <CopyPanel curl={curl} onDismiss={() => void onDone()} /> : null}
      <div className="check-form-actions">
        <button className="btn btn-primary btn-flash" disabled={pending || Boolean(curl)} type="submit">
          {pending ? "Saving…" : flash ? "Saved" : editing ? "Save check" : "Create check"}
        </button>
        <button className="btn btn-secondary" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/* --- Response viewer --- */

function TestResponseBody({ text }: { text: string }) {
  const { type, formatted } = useMemo(() => formatResponseText(text), [text]);

  if (type === "json") {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return <pre className="test-result-body">{formatted}</pre>; }
    return (
      <div className="json-view-wrap">
        <JsonNode value={parsed} depth={0} defaultOpen />
      </div>
    );
  }

  if (type === "xml" || type === "html") {
    return <pre className="test-result-body markup-highlight" dangerouslySetInnerHTML={{ __html: highlightMarkup(formatted) }} />;
  }

  return <pre className="test-result-body">{formatted}</pre>;
}

function highlightMarkup(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/&lt;(\/?)([a-zA-Z0-9-]+)/g, '&lt;$1<span class="markup-tag">$2</span>')
    .replace(/\s([a-zA-Z-]+)=/g, ' <span class="markup-attr">$1</span>=')
    .replace(/="([^"]*)"/g, '="<span class="markup-val">$1</span>"');
}

function formatResponseText(text: string): { type: "json" | "xml" | "html" | "text"; formatted: string } {
  const trimmed = text.trim();

  // JSON
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return { type: "json", formatted: JSON.stringify(JSON.parse(trimmed), null, 2) };
    } catch { /* fall through */ }
  }

  // HTML or XML
  if (trimmed.startsWith("<")) {
    const isHtml = /<!doctype html|<html[\s>]/i.test(trimmed.slice(0, 100));
    return { type: isHtml ? "html" : "xml", formatted: prettyMarkup(trimmed) };
  }

  return { type: "text", formatted: text };
}

function prettyMarkup(raw: string): string {
  let out = "";
  let indent = 0;
  const tab = "  ";
  // Tokenize into tags and text
  const tokens = raw.match(/(<[^>]+>)|([^<]+)/g);
  if (!tokens) return raw;
  for (const token of tokens) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("</")) {
      // Closing tag
      indent = Math.max(0, indent - 1);
      out += tab.repeat(indent) + trimmed + "\n";
    } else if (trimmed.startsWith("<") && !trimmed.startsWith("<!")) {
      // Opening or self-closing tag
      out += tab.repeat(indent) + trimmed + "\n";
      if (!trimmed.endsWith("/>") && !isVoidTag(trimmed)) {
        indent++;
      }
    } else if (trimmed.startsWith("<!")) {
      // Doctype, comment
      out += tab.repeat(indent) + trimmed + "\n";
    } else {
      // Text content
      out += tab.repeat(indent) + trimmed + "\n";
    }
  }
  return out.trimEnd();
}

function isVoidTag(tag: string): boolean {
  const name = tag.replace(/^<([a-zA-Z0-9-]+)[\s/>].*/, "$1").toLowerCase();
  return /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(name);
}

function JsonNode({ value, depth, defaultOpen }: { value: unknown; depth: number; defaultOpen?: boolean }) {
  if (value === null) return <span className="json-null">null</span>;
  if (typeof value === "boolean") return <span className="json-bool">{String(value)}</span>;
  if (typeof value === "number") return <span className="json-num">{String(value)}</span>;
  if (typeof value === "string") return <span className="json-str">"{value}"</span>;
  if (Array.isArray(value)) return <JsonArray items={value} depth={depth} defaultOpen={defaultOpen} />;
  if (typeof value === "object") return <JsonObject obj={value as Record<string, unknown>} depth={depth} defaultOpen={defaultOpen} />;
  return <span>{String(value)}</span>;
}

function JsonObject({ obj, depth, defaultOpen }: { obj: Record<string, unknown>; depth: number; defaultOpen?: boolean }) {
  const entries = Object.entries(obj);
  const [open, setOpen] = useState(defaultOpen || depth < 1);

  if (entries.length === 0) return <span className="json-brace">{"{}"}</span>;

  if (!open) {
    return (
      <span className="json-collapsed" onClick={() => setOpen(true)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") setOpen(true); }}>
        <span className="json-brace">{"{"}</span>
        <span className="json-ellipsis">{entries.length} keys</span>
        <span className="json-brace">{"}"}</span>
      </span>
    );
  }

  return (
    <span className="json-block">
      <span className="json-toggle" onClick={() => setOpen(false)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") setOpen(false); }}>
        <span className="json-brace">{"{"}</span>
      </span>
      <span className="json-indent">
        {entries.map(([key, val], i) => (
          <span className="json-line" key={key}>
            <span className="json-key">"{key}"</span>
            <span className="json-colon">: </span>
            <JsonNode value={val} depth={depth + 1} />
            {i < entries.length - 1 ? <span className="json-comma">,</span> : null}
          </span>
        ))}
      </span>
      <span className="json-brace">{"}"}</span>
    </span>
  );
}

function JsonArray({ items, depth, defaultOpen }: { items: unknown[]; depth: number; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen || depth < 1);

  if (items.length === 0) return <span className="json-brace">[]</span>;

  if (!open) {
    return (
      <span className="json-collapsed" onClick={() => setOpen(true)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") setOpen(true); }}>
        <span className="json-brace">[</span>
        <span className="json-ellipsis">{items.length} items</span>
        <span className="json-brace">]</span>
      </span>
    );
  }

  return (
    <span className="json-block">
      <span className="json-toggle" onClick={() => setOpen(false)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") setOpen(false); }}>
        <span className="json-brace">[</span>
      </span>
      <span className="json-indent">
        {items.map((item, i) => (
          <span className="json-line" key={i}>
            <JsonNode value={item} depth={depth + 1} />
            {i < items.length - 1 ? <span className="json-comma">,</span> : null}
          </span>
        ))}
      </span>
      <span className="json-brace">]</span>
    </span>
  );
}
