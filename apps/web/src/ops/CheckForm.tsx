import { useEffect, useMemo, useState } from "react";
import { api } from "./api.ts";
import { mutationError, regionLabel, regionTitle } from "./labels.ts";
import { CopyPanel, ErrorText, Seg, useActionFlash } from "./ui.tsx";

const METHODS = ["GET", "HEAD", "POST"] as const;
const INTERVALS_HTTP = ["30s", "1m", "5m", "15m"] as const;
const INTERVALS_HB = ["1m", "5m", "10m", "15m"] as const;
const GRACES = ["30s", "1m", "2m", "5m"] as const;
const DEFAULT_REGIONS = ["wnam", "weur", "apac"];
const REGION_IDS = ["wnam", "weur", "apac"] as const;
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

export type SecretRef = { __foxwatch_secret__: string };

export type HttpConfig = {
  type?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string | SecretRef>;
  body?: string;
  expect?: { status?: number | number[]; bodyIncludes?: string };
  intervalMs?: number;
  timeoutMs?: number;
  graceMs?: number;
  retries?: number;
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
  config: HttpConfig & Record<string, unknown>;
};

type HeaderRow = { key: string; kind: "text" | "secret"; value: string };
type CheckKind = "http" | "heartbeat";

function intervalFromMs(ms?: number): string {
  if (ms === 30_000) return "30s";
  if (ms === 300_000) return "5m";
  if (ms === 600_000) return "10m";
  if (ms === 900_000) return "15m";
  return "1m";
}

function timeoutFromMs(ms?: number): string {
  if (ms === 5_000) return "5s";
  if (ms === 15_000) return "15s";
  return "10s";
}

function graceFromMs(ms?: number): string {
  if (ms === 30_000) return "30s";
  if (ms === 60_000) return "1m";
  if (ms === 300_000) return "5m";
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
  interval: string;
  timeout: string;
  grace: string;
  regions: string[];
  groupName: string;
  componentName: string;
  critical: boolean;
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
    interval: "1m",
    timeout: "10s",
    grace: "2m",
    regions: [...DEFAULT_REGIONS],
    groupName: "API",
    componentName: "",
    critical: false,
  };
}

function formFromMonitor(m: Monitor): CheckFormState {
  const cfg = m.config;
  const expect = cfg.expect ?? {};
  const status = Array.isArray(expect.status) ? expect.status[0] : expect.status;
  return {
    checkType: m.type === "heartbeat" ? "heartbeat" : "http",
    name: m.name,
    url: String(cfg.url ?? "https://"),
    method: (METHODS.includes(cfg.method as (typeof METHODS)[number]) ? cfg.method : "GET") as (typeof METHODS)[number],
    headers: headersToRows(cfg.headers),
    body: String(cfg.body ?? ""),
    expectStatus: String(status ?? 200),
    bodyIncludes: String(expect.bodyIncludes ?? ""),
    interval: intervalFromMs(cfg.intervalMs),
    timeout: timeoutFromMs(cfg.timeoutMs),
    grace: graceFromMs(cfg.graceMs),
    regions: (cfg.regions?.length ? cfg.regions : [...DEFAULT_REGIONS]).slice(),
    groupName: m.groupName,
    componentName: m.componentName,
    critical: m.critical,
  };
}

function usesAdvanced(form: CheckFormState): boolean {
  const hasHeaders = form.headers.some((h) => h.key.trim() && h.value.trim());
  const customComponent = Boolean(form.componentName.trim()) && form.componentName.trim() !== form.name.trim();
  return (
    hasHeaders ||
    Boolean(form.body.trim()) ||
    Boolean(form.bodyIncludes.trim()) ||
    form.timeout !== "10s" ||
    customComponent ||
    form.critical
  );
}

function recipeLine(form: CheckFormState, host: string): string {
  if (form.checkType === "heartbeat") {
    return `Ping every ${form.interval} · fail after ${form.grace} late`;
  }
  const n = Math.max(form.regions.length, 1);
  const target = host || "this URL";
  return `${form.method} ${target} · ${form.expectStatus} · ${form.interval} · ${n} ${n === 1 ? "region" : "regions"}`;
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
  const { flash, flashOkThen } = useActionFlash();

  useEffect(() => {
    const next = editing ? formFromMonitor(editing) : emptyForm();
    setForm(next);
    setError(null);
    setCurl(null);
    setAdvancedOpen(Boolean(editing) && usesAdvanced(next));
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
      groupId: slugify(form.groupName.trim() || "api"),
      groupName: form.groupName.trim() || "API",
      componentId: slugify(componentName),
      componentName,
      critical: form.critical,
    };

    let payload: Record<string, unknown>;
    if (form.checkType === "heartbeat") {
      payload = { ...shared, type: "heartbeat", interval: form.interval, grace: form.grace };
    } else {
      let url: URL;
      try {
        url = new URL(form.url);
      } catch {
        setError("Enter a valid URL, including https://");
        return;
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        setError("Only http and https URLs are allowed.");
        return;
      }
      const headers = rowsToHeaders(form.headers);
      for (const row of form.headers) {
        if (row.kind === "secret" && row.value.trim() && !SECRET_NAME_RE.test(row.value.trim())) {
          setError("Secret names must look like API_TOKEN (A–Z, 0–9, _).");
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
      const expectStatus = Number(form.expectStatus);
      if (!Number.isInteger(expectStatus) || expectStatus < 100 || expectStatus > 599) {
        setError("Expected status must be an HTTP status code.");
        return;
      }
      payload = {
        ...shared,
        type: "http",
        url: url.toString(),
        method: form.method,
        body: form.method === "POST" && body ? body : undefined,
        headers,
        allowedHosts: [url.hostname],
        regions: form.regions.length ? form.regions : ["wnam"],
        interval: form.interval,
        timeout: form.timeout,
        retries: 2,
        expect: {
          status: expectStatus,
          bodyIncludes: form.bodyIncludes.trim() || undefined,
        },
      };
    }

    setPending(true);
    const res = editing
      ? await api<{ ok: boolean }>(`/api/ops/monitors/${editing.id}`, { method: "PATCH", body: JSON.stringify(payload) })
      : await api<{ ok: boolean }>("/api/ops/monitors", { method: "POST", body: JSON.stringify(payload) });
    if (!res.ok) {
      setPending(false);
      setError(mutationError(res.error, "Could not save this check."));
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

  const intervals = form.checkType === "heartbeat" ? INTERVALS_HB : INTERVALS_HTTP;
  const requestHint = form.method === "POST"
    ? host
      ? `JSON body is under Advanced. Secrets attach only to ${host}.`
      : "JSON body is under Advanced. Include https://."
    : host
      ? `Secrets attach only to ${host}.`
      : "Include https:// — secrets only attach to that host.";

  return (
    <form className="card check-form" onSubmit={submit}>
      <div className="check-form-head">
        <h2 className="section-title">{editing ? "Edit check" : "New check"}</h2>
        <p className="check-recipe">{recipeLine(form, host)}</p>
      </div>
      <section className="check-sheet" aria-label="Check">
        <div className="check-row">
          <span className="check-row-k" id="check-type-label">
            Type
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
          <span className="check-row-k">Name</span>
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
          <span className="check-row-k">Group</span>
          <input id="check-group" className="check-plain" value={form.groupName} onChange={(e) => set("groupName", e.target.value)} placeholder="API" autoComplete="off" />
        </label>
      </section>
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
            <p className="check-hint">{requestHint}</p>
          </div>
          <div className="check-split">
            <label className="check-row" htmlFor="check-status">
              <span className="check-row-k">Expect</span>
              <input id="check-status" className="check-plain check-plain-num" inputMode="numeric" value={form.expectStatus} onChange={(e) => set("expectStatus", e.target.value)} />
            </label>
            <label className="check-row" htmlFor="check-interval">
              <span className="check-row-k">Every</span>
              <select id="check-interval" className="check-plain check-plain-end" value={form.interval} onChange={(e) => set("interval", e.target.value)}>
                {intervals.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="check-row check-row-stack">
            <span className="check-row-k" id="check-regions-label">
              Probe from
            </span>
            <div className="region-picks" role="group" aria-labelledby="check-regions-label">
              {REGION_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="region-chip"
                  aria-pressed={form.regions.includes(id)}
                  title={regionTitle(id)}
                  onClick={() => toggleRegion(id)}
                >
                  {regionLabel(id)}
                </button>
              ))}
            </div>
          </div>
        </section>
      ) : (
        <section className="check-sheet" aria-label="Heartbeat">
          <div className="check-split">
            <label className="check-row" htmlFor="check-interval">
              <span className="check-row-k">Ping every</span>
              <select id="check-interval" className="check-plain check-plain-end" value={form.interval} onChange={(e) => set("interval", e.target.value)}>
                {intervals.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="check-row" htmlFor="check-grace">
              <span className="check-row-k">Late by</span>
              <select id="check-grace" className="check-plain check-plain-end" value={form.grace} onChange={(e) => set("grace", e.target.value)}>
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
                <div className="check-hdrs">
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
                  <p className="check-hint">Pick a secret from Settings. The value is filled in at probe time.</p>
                </div>
                {form.method === "POST" ? (
                  <label className="check-row check-row-stack" htmlFor="check-body">
                    <span className="check-row-k">JSON body</span>
                    <textarea id="check-body" className="input input-code" value={form.body} onChange={(e) => set("body", e.target.value)} placeholder={'{\n  "check": true\n}'} />
                  </label>
                ) : null}
                <label className="check-row" htmlFor="check-timeout">
                  <span className="check-row-k">Timeout</span>
                  <select id="check-timeout" className="check-plain check-plain-end" value={form.timeout} onChange={(e) => set("timeout", e.target.value)}>
                    <option value="5s">5 seconds</option>
                    <option value="10s">10 seconds</option>
                    <option value="15s">15 seconds</option>
                  </select>
                </label>
                <label className="check-row" htmlFor="check-includes">
                  <span className="check-row-k">Must include</span>
                  <input id="check-includes" className="check-plain" value={form.bodyIncludes} onChange={(e) => set("bodyIncludes", e.target.value)} placeholder='e.g. "ok"' />
                </label>
              </>
            ) : null}
            <label className="check-row" htmlFor="check-component">
              <span className="check-row-k">Component</span>
              <input id="check-component" className="check-plain" value={form.componentName} onChange={(e) => set("componentName", e.target.value)} placeholder="Same as name" />
            </label>
            <label className="check-row" htmlFor="check-critical">
              <span className="check-row-k check-row-k-wide">Critical</span>
              <span className="check-row-hint">Failures take the public page to failing</span>
              <input id="check-critical" type="checkbox" checked={form.critical} onChange={(e) => set("critical", e.target.checked)} />
            </label>
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
