import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { api } from "./api.ts";
import {
  ASSERTION_OPS,
  METHODS,
  buildCheckPayload,
  buildHttpRequest,
  clampAssertionThreshold,
  emptyForm,
  formFromMonitor,
  type AssertionOp,
  type CheckFormState,
  type CheckKind,
  type HeaderRow,
  type Monitor,
  type PlacedMonitor,
} from "./check-payload.ts";
import {
  clampDuration,
  convertDuration,
  durationMs,
  maxAmount,
  sanitizeInt,
  unitsForCap,
  UNIT_LABEL,
  UNIT_MS,
  type DurationUnit,
} from "./duration.ts";
import { MAX_INTERVAL_MS, MAX_REGIONS, MAX_TIMEOUT_MS, MIN_INTERVAL_MS, REGIONS } from "@foxwatch/config";
import { regionLabel, regionTitle } from "./labels.ts";
import { tokenizeMarkup } from "./markup.ts";
import { CopyPanel, ErrorText, InfoTip, Mark, Seg, useActionFlash } from "./ui.tsx";

export type { HttpConfig, Monitor, SecretRef } from "./check-payload.ts";

function rejectNonDigitKey(e: KeyboardEvent<HTMLInputElement>) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.length === 1 && !/\d/.test(e.key)) e.preventDefault();
}

const INTERVALS_HB = ["1m", "5m", "10m", "15m"] as const;
const INTERVAL_UNITS: DurationUnit[] = ["s", "m", "h"];
const GRACES = ["30s", "1m", "2m", "5m"] as const;

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
        // Only the ceiling applies while typing: holding "4" up to a floor of 30 would turn 45 into 305.
        const next = sanitizeInt(e.target.value, max);
        if (next === undefined) return;
        onChange(next);
      }}
      onBlur={() => {
        if (value !== "" && Number(value) < min) onChange(String(min));
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
  minMs = 1,
  onChange,
}: {
  id: string;
  value: string;
  unit: DurationUnit;
  capMs: number;
  required?: boolean;
  placeholder?: string;
  units?: DurationUnit[];
  minMs?: number;
  onChange: (value: string, unit: DurationUnit) => void;
}) {
  // The floor is a duration, so each unit has its own smallest amount (30 sec, but 1 min).
  const minFor = (u: DurationUnit) => Math.max(1, Math.ceil(minMs / UNIT_MS[u]));
  const units = (unitList ?? unitsForCap(capMs)).filter((u) => maxAmount(u, capMs) >= minFor(u));
  const min = minFor(unit);
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
          onChange(convertDuration(value, unit, next, capMs, minFor(next)), next);
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
  monitors,
  secrets,
  onSaved,
  onClose,
  onCancel,
}: {
  monitor: Monitor | null;
  /** Every check, so a typed group or component name can join the one that already has it. */
  monitors: PlacedMonitor[];
  secrets: string[];
  /** A save landed: refresh the list now. */
  onSaved: () => Promise<void>;
  /** Close the panel for the check that was saved (its id, or "new"), if it is still the one open. */
  onClose: (saved: string) => void;
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
    setForm((f) => ({ ...f, checkType, interval: "10m", intervalValue: "1", intervalUnit: "m" }));
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

  function removeAssertion(index: number) {
    setForm((f) => {
      const assertions = f.assertions.filter((_, j) => j !== index);
      return { ...f, assertions, assertionFailThreshold: clampAssertionThreshold(f.assertionFailThreshold, assertions.length) };
    });
  }

  async function sendTestRequest() {
    setTestResult(null);
    setError(null);
    // The same request and expectations a save would store.
    const request = buildHttpRequest(form);
    if (!request.ok) {
      setError(request.error);
      return;
    }
    setTestPending(true);
    const res = await api<TestResult>("/api/ops/monitors/test-request", {
      method: "POST",
      body: JSON.stringify(request.payload),
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
    if (pending || flash) return;
    setError(null);
    const built = buildCheckPayload(form, editing, monitors);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    const saved = editing?.id ?? "new";

    setPending(true);
    const res = editing
      ? await api<{ ok: boolean }>(`/api/ops/monitors/${editing.id}`, { method: "PATCH", body: JSON.stringify(built.payload) })
      : await api<{ ok: boolean }>("/api/ops/monitors", { method: "POST", body: JSON.stringify(built.payload) });
    if (!res.ok) {
      setPending(false);
      setError(res.error);
      return;
    }
    setPending(false);
    // The list shows the saved check at once. The flash below is only cosmetic.
    void onSaved();
    if (!editing && form.checkType === "heartbeat") {
      const rot = await api<{ token: string; curl: string }>(`/api/ops/heartbeats/${built.id}/rotate`, { method: "POST", body: "{}" });
      if (rot.ok) {
        setCurl(rot.data.curl);
        return;
      }
    }
    flashOkThen(() => onClose(saved));
  }

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
                value={form.intervalValue}
                unit={form.intervalUnit}
                capMs={MAX_INTERVAL_MS}
                units={INTERVAL_UNITS}
                minMs={MIN_INTERVAL_MS}
                required
                onChange={(intervalValue, intervalUnit) => setForm((f) => ({ ...f, intervalValue, intervalUnit }))}
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
                      <InfoTip>JSON path assertions on the response body. Use $.key.nested[0] syntax, or $['any key'] for keys with other characters. Wildcard matching uses * and ? characters. Equals compares numbers, true, false and null by type. Wrap a value in double quotes to compare it as text, like "200".</InfoTip>
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
                          onClick={() => removeAssertion(i)}
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
                          onChange={(e) => set("assertionFailThreshold", clampAssertionThreshold(Number(e.target.value) || 1, form.assertions.length))}
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
      {curl ? <CopyPanel curl={curl} onDismiss={() => onClose("new")} /> : null}
      <div className="check-form-actions">
        <button className="btn btn-primary btn-flash" disabled={pending || flash || Boolean(curl)} type="submit">
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
    return (
      <pre className="test-result-body markup-highlight">
        {tokenizeMarkup(formatted).map((token, i) => (token.kind === "text" ? token.text : <span key={i} className={`markup-${token.kind}`}>{token.text}</span>))}
      </pre>
    );
  }

  return <pre className="test-result-body">{formatted}</pre>;
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
