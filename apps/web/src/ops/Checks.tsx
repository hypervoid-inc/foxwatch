import { useEffect, useState } from "react";
import { impactAriaLabel, impactTitle, impactTone, regionImpact } from "@foxwatch/engine";
import { api } from "./api.ts";
import { CheckForm, type Monitor } from "./CheckForm.tsx";
import { outcomeLabel, outcomeMark, regionLabel, regionTitle } from "./labels.ts";
import { CopyPanel, ConfirmDialog, ErrorText, Field, Mark } from "./ui.tsx";

type Latest = {
  region: string;
  outcome: string;
  latencyMs: number | null;
  colo: string | null;
  errorClass: string | null;
  errorSnippet?: string | null;
  statusCode?: number | null;
  checkedAt: number;
};

export type MonitorRow = Monitor & { latest: Latest[] };

export function Checks({
  monitors,
  secrets,
  onChange,
}: {
  monitors: MonitorRow[];
  secrets: string[];
  onChange: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<string | "new" | null>(monitors.length ? null : "new");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [curl, setCurl] = useState<{ id: string; value: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const editing = selected && selected !== "new" ? (monitors.find((m) => m.id === selected) ?? null) : null;

  async function run(id: string) {
    setError(null);
    setBusy(`run:${id}`);
    const res = await api<{ ok: boolean; skipped?: string }>(`/api/ops/monitors/${id}/run`, { method: "POST", body: "{}" });
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (res.data.skipped === "muted") {
      setError("This check is muted. Unmute it before running.");
      return;
    }
    if (res.data.skipped === "maintenance") {
      setError("This component is under maintenance. Checks are intentionally suppressed.");
      return;
    }
    await onChange();
  }

  async function mute(id: string, until: number | null) {
    setError(null);
    setBusy(`mute:${id}`);
    const res = await api(`/api/ops/monitors/${id}/mute`, { method: "POST", body: JSON.stringify({ until }) });
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    await onChange();
  }

  async function remove(id: string) {
    setError(null);
    setBusy(`del:${id}`);
    const res = await api(`/api/ops/monitors/${id}`, { method: "DELETE" });
    setBusy(null);
    setPendingDelete(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setSelected(null);
    await onChange();
  }

  async function rotate(id: string) {
    setError(null);
    setBusy(`rot:${id}`);
    const res = await api<{ token: string; curl: string }>(`/api/ops/heartbeats/${id}/rotate`, { method: "POST", body: "{}" });
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setCurl({ id, value: res.data.curl });
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(20rem,30rem)_minmax(0,1fr)]">
      <section className="card overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div>
            <h2 className="section-title">Checks</h2>
            <p className="section-copy">HTTP endpoints and heartbeats for this instance.</p>
          </div>
          <button className="btn btn-primary btn-sm" type="button" onClick={() => setSelected("new")}>
            New check
          </button>
        </div>
        {error ? (
          <div className="border-t border-line px-4 py-2.5">
            <ErrorText>{error}</ErrorText>
          </div>
        ) : null}
        {monitors.length === 0 ? (
          <p className="empty-note">No checks yet. Add an HTTP endpoint or a heartbeat to start monitoring.</p>
        ) : (
          <ul className="check-list">
            {monitors.map((m) => {
              const interval = Number(m.config.intervalMs ?? 60_000);
              const timeout = m.type === "http" ? Number(m.config.timeoutMs ?? 10_000) * (Number(m.config.retries ?? 2) + 1) : Number(m.config.graceMs ?? 0);
              const freshAfter = Date.now() - Math.max(interval * 2.5, interval + timeout + 30_000);
              const freshLatest = m.latest.filter((latest) => latest.checkedAt >= freshAfter);
              const muted = m.mutedUntil != null && m.mutedUntil > Date.now();
              const expected = m.type === "heartbeat" ? ["global"] : Array.isArray(m.config.regions) ? m.config.regions.map(String) : [];
              const worst = muted ? "empty" : freshLatest.some((l) => l.outcome === "fail") ? "bad" : freshLatest.some((l) => l.outcome === "degraded") ? "warn" : freshLatest.length ? "ok" : "empty";
              const confirming = freshLatest.some((latest) => latest.outcome === "fail") && m.confirmedOutcome !== "fail";
              const isSelected = selected === m.id;
              return (
                <li
                  key={m.id}
                  className="check-item"
                  data-selected={isSelected ? "true" : undefined}
                  data-muted={muted ? "true" : undefined}
                >
                  <div className="check-item-head">
                    <button
                      type="button"
                      className="check-name"
                      aria-pressed={isSelected}
                      onClick={() => setSelected(m.id)}
                      title={[m.type === "http" ? String(m.config.url ?? "") : "Heartbeat", `${m.groupName} / ${m.componentName}`].join(" · ")}
                    >
                      <div className="check-title">
                        <Mark status={worst} />
                        <span className="check-title-text">{m.name}</span>
                        {muted ? null : <ImpactPills expected={expected} latest={freshLatest} />}
                        {muted ? <span className="check-flag">Muted</span> : null}
                        {m.drifted ? <span className="check-flag">Drifted</span> : null}
                        {m.origin === "git" ? <span className="check-flag">Imported</span> : null}
                        {m.latest.length > 0 && freshLatest.length === 0 ? <span className="check-flag">Stale</span> : null}
                        {confirming ? <span className="check-flag">Confirming {m.consecutiveFails ?? 0}/{Number(m.config.confirmFails ?? 3)}</span> : null}
                      </div>
                      <p className="check-target">
                        {m.type === "http" ? (
                          <>
                            <span className="check-verb">{String(m.config.method ?? "GET")}</span>
                            <span className="min-w-0 flex-1 truncate">{String(m.config.url ?? "")}</span>
                          </>
                        ) : (
                          <span className="truncate">Heartbeat</span>
                        )}
                      </p>
                    </button>
                    <div className="check-actions">
                      <button className="btn btn-secondary btn-sm" type="button" disabled={muted || busy === `run:${m.id}`} onClick={() => void run(m.id)}>
                        {busy === `run:${m.id}` ? "Running…" : "Run"}
                      </button>
                      {muted ? (
                        <button className="btn btn-secondary btn-sm" type="button" disabled={busy === `mute:${m.id}`} onClick={() => void mute(m.id, null)}>
                          {busy === `mute:${m.id}` ? "Saving…" : "Unmute"}
                        </button>
                      ) : (
                        <select
                          className="btn btn-secondary btn-sm"
                          aria-label={`Mute ${m.name}`}
                          value=""
                          disabled={busy === `mute:${m.id}`}
                          onChange={(e) => {
                            const duration = Number(e.target.value);
                            if (duration) void mute(m.id, Date.now() + duration);
                          }}
                        >
                          <option value="">{busy === `mute:${m.id}` ? "Saving…" : "Mute"}</option>
                          <option value={3_600_000}>1 hour</option>
                          <option value={86_400_000}>24 hours</option>
                          <option value={604_800_000}>7 days</option>
                        </select>
                      )}
                      <button className="btn btn-danger btn-sm" type="button" disabled={busy === `del:${m.id}`} onClick={() => setPendingDelete(m.id)}>
                        {busy === `del:${m.id}` ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </div>
                  {m.latest.length ? <RegionProbes latest={m.latest} /> : <p className="check-empty">No results yet.</p>}
                  {m.type === "heartbeat" && isSelected ? (
                    <button className="btn btn-secondary btn-sm mt-2" type="button" disabled={busy === `rot:${m.id}`} onClick={() => void rotate(m.id)}>
                      {busy === `rot:${m.id}` ? "Rotating…" : "Rotate token"}
                    </button>
                  ) : null}
                  {curl?.id === m.id ? <CopyPanel curl={curl.value} onDismiss={() => setCurl(null)} /> : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <aside className="aside-panel flex flex-col gap-5">
        {selected === "new" || editing ? (
          <CheckForm
            monitor={selected === "new" ? null : editing}
            secrets={secrets}
            onDone={async () => {
              await onChange();
              setSelected(null);
            }}
            onCancel={() => setSelected(null)}
          />
        ) : (
          <div className="card px-5 py-8 text-center text-sm text-muted">Select a check to edit, or create a new one.</div>
        )}
        {editing?.componentId ? (
          <MaintenanceCard componentId={editing.componentId} componentName={editing.componentName} onChange={onChange} />
        ) : null}
        {editing ? <RunHistory monitor={editing} /> : null}
      </aside>
      <ConfirmDialog
        open={pendingDelete != null}
        title="Delete this check?"
        body="It will disappear from the public page."
        confirmLabel="Delete check"
        pending={pendingDelete != null && busy === `del:${pendingDelete}`}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) void remove(pendingDelete);
        }}
      />
    </div>
  );
}

function ImpactPills({ expected, latest }: { expected: string[]; latest: Latest[] }) {
  const impact = regionImpact(expected, latest);
  if (!impact) return null;
  const tone = impactTone(impact);
  return (
    <ul className="check-impact" aria-label={impactAriaLabel(impact)}>
      {impact.all ? (
        <li>
          <span className={`check-impact-pill ${tone}`} title={impactTitle(impact)}>
            All
          </span>
        </li>
      ) : (
        impact.items.map((item) => (
          <li key={item.region}>
            <span className={`check-impact-pill ${item.outcome === "fail" ? "bad" : "warn"}`}>
              {item.label} <span className="check-impact-detail">{item.detail}</span>
            </span>
          </li>
        ))
      )}
    </ul>
  );
}

function RunHistory({ monitor }: { monitor: MonitorRow }) {
  const [runs, setRuns] = useState<Latest[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    void api<{ runs: Latest[] }>(`/api/ops/monitors/${monitor.id}/runs?limit=5`).then((res) => {
      if (res.ok) setRuns(res.data.runs);
      setLoading(false);
    });
  }, [monitor.id, monitor.latest]);

  return (
    <section className="card overflow-hidden">
      <div className="px-5 py-4">
        <h2 className="section-title">Recent runs</h2>
        <p className="section-copy">Last 5 probes. Confirmed after {Number(monitor.config.confirmFails ?? 3)} consecutive failures.</p>
      </div>
      {loading ? <p className="empty-note">Loading…</p> : runs.length === 0 ? <p className="empty-note">No runs recorded yet.</p> : (
        <ul className="border-t border-line">
          {runs.map((run, index) => (
            <li key={`${run.checkedAt}-${run.region}-${index}`} className="run-item">
              <div className="run-item-head">
                <Mark status={outcomeMark(run.outcome)} />
                <strong className="run-item-outcome">{outcomeLabel(run.outcome)}</strong>
                <span className="run-item-latency">{run.latencyMs != null ? `${run.latencyMs}ms` : "—"}</span>
              </div>
              <p className="run-item-detail">{regionTitle(run.region)}{run.colo ? ` · ${run.colo}` : ""}{run.statusCode ? ` · HTTP ${run.statusCode}` : ""} · {new Date(run.checkedAt).toLocaleString()}</p>
              {run.errorClass || run.errorSnippet ? <p className="run-item-error">{[run.errorClass, run.errorSnippet].filter(Boolean).join(": ")}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RegionProbes({ latest }: { latest: Latest[] }) {
  const samples = latest.map((l) => l.latencyMs).filter((n): n is number => n != null);
  const maxMs = Math.max(1, ...samples);
  const min = samples.length ? Math.min(...samples) : null;
  const max = samples.length ? Math.max(...samples) : null;
  const avg = samples.length ? Math.round(samples.reduce((sum, n) => sum + n, 0) / samples.length) : null;

  return (
    <div className="check-probes">
      <ul className="check-probe-list" aria-label="Latest latency by region">
        {latest.map((l) => {
          const tone = outcomeMark(l.outcome);
          const pct = l.latencyMs != null ? Math.max(6, (l.latencyMs / maxMs) * 100) : 0;
          const label = [
            regionTitle(l.region),
            l.colo,
            l.latencyMs != null ? `${l.latencyMs}ms` : "no sample",
            l.outcome !== "pass" ? outcomeLabel(l.outcome) : null,
            l.errorClass,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <li key={l.region} className="check-probe" aria-label={label} title={l.errorClass ?? regionTitle(l.region)}>
              <span className="check-probe-region">{regionLabel(l.region)}</span>
              <span className="check-probe-colo">{l.colo ?? "—"}</span>
              <span className={`check-probe-track tone-${tone}`}>
                {l.latencyMs != null ? <span className="check-probe-fill" style={{ width: `${pct}%` }} /> : null}
              </span>
              <span className={`check-probe-ms tone-${tone}`}>{l.latencyMs != null ? `${l.latencyMs}ms` : "—"}</span>
            </li>
          );
        })}
      </ul>
      {min != null && avg != null && max != null && samples.length > 1 && min !== max ? (
        <p className="check-probe-stats">
          {min}–{max}ms <span aria-hidden="true">·</span> avg {avg}ms
        </p>
      ) : null}
    </div>
  );
}

type MaintenanceWindow = { id: string; note: string; startAt: number; endAt: number };

function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function MaintenanceCard({
  componentId,
  componentName,
  onChange,
}: {
  componentId: string;
  componentName: string;
  onChange: () => Promise<void>;
}) {
  const [windows, setWindows] = useState<MaintenanceWindow[]>([]);
  const [note, setNote] = useState("");
  const [startAt, setStartAt] = useState(() => toLocalInput(Date.now() + 5 * 60 * 1000));
  const [endAt, setEndAt] = useState(() => toLocalInput(Date.now() + 2 * 60 * 60 * 1000));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function refresh() {
    const res = await api<{ window: MaintenanceWindow | null; windows: MaintenanceWindow[] }>(`/api/ops/components/${componentId}/maintenance`);
    if (!res.ok) return;
    setWindows(res.data.windows);
  }

  useEffect(() => {
    setError(null);
    setNote("");
    setStartAt(toLocalInput(Date.now() + 5 * 60 * 1000));
    setEndAt(toLocalInput(Date.now() + 2 * 60 * 60 * 1000));
    void refresh();
  }, [componentId]);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = new Date(endAt).getTime();
    const parsedStart = new Date(startAt).getTime();
    setPending(true);
    const res = await api<{ window: MaintenanceWindow }>(`/api/ops/components/${componentId}/maintenance`, {
      method: "POST",
      body: JSON.stringify({ note, startAt: parsedStart, endAt: parsed }),
    });
    setPending(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setWindows((current) => [...current, res.data.window].sort((a, b) => a.startAt - b.startAt));
    setNote("");
    setStartAt(toLocalInput(Date.now() + 5 * 60 * 1000));
    setEndAt(toLocalInput(Date.now() + 2 * 60 * 60 * 1000));
    await onChange();
  }

  async function end(windowId: string) {
    setError(null);
    setPending(true);
    const res = await api(`/api/ops/components/${componentId}/maintenance/${windowId}`, { method: "DELETE" });
    setPending(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setWindows((current) => current.filter((window) => window.id !== windowId));
    await onChange();
  }

  return (
    <form className="card flex flex-col gap-3 p-5" onSubmit={start}>
      <div>
        <h2 className="section-title">Maintenance</h2>
        <p className="section-copy">
            Suppresses checks, alerts, and automated incidents for <span className="font-medium text-ink">{componentName}</span> during this window.
        </p>
      </div>
      {windows.length ? (
        <ul className="flex flex-col gap-2">
          {windows.map((window) => {
            const active = window.startAt <= Date.now() && Date.now() < window.endAt;
            return <li key={window.id} className="rounded-lg border border-line p-3 text-sm"><p className="font-medium">{active ? "In progress" : "Scheduled"}</p><p className="mt-0.5 text-xs text-muted"><time dateTime={new Date(window.startAt).toISOString()}>{new Date(window.startAt).toLocaleString()}</time> – <time dateTime={new Date(window.endAt).toISOString()}>{new Date(window.endAt).toLocaleString()}</time></p>{window.note ? <p className="mt-1 text-sm text-muted">{window.note}</p> : null}<button className="check-quiet check-quiet-bad mt-1" type="button" disabled={pending} onClick={() => void end(window.id)}>{active ? "End now" : "Cancel"}</button></li>;
          })}
        </ul>
      ) : null}
      <>
          <Field label="Note (optional)" htmlFor="maint-note">
            <input id="maint-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Deploying API v2" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start" htmlFor="maint-start">
              <input id="maint-start" className="input" type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} required />
            </Field>
            <Field label="End" htmlFor="maint-end">
              <input id="maint-end" className="input" type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} required />
            </Field>
          </div>
          <button className="btn btn-primary w-fit" disabled={pending} type="submit">
            {pending ? "Scheduling…" : "Schedule maintenance"}
          </button>
      </>
      {error ? <ErrorText>{error}</ErrorText> : null}
    </form>
  );
}
