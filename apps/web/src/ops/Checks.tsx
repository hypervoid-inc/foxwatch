import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { CheckForm, type Monitor } from "./CheckForm.tsx";
import { mutationError, outcomeLabel, outcomeMark, regionLabel, regionTitle } from "./labels.ts";
import { CopyPanel, ConfirmDialog, ErrorText, Field, Mark } from "./ui.tsx";

type Latest = {
  region: string;
  outcome: string;
  latencyMs: number | null;
  colo: string | null;
  errorClass: string | null;
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
      setError(mutationError(res.error, "Could not run that check."));
      return;
    }
    if (res.data.skipped === "muted") {
      setError("This check is muted. Unmute it before running.");
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
      setError(mutationError(res.error, "Could not update mute."));
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
      setError(mutationError(res.error, "Could not delete that check."));
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
      setError(mutationError(res.error, "Could not rotate that token."));
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
              const worst = m.latest.some((l) => l.outcome === "fail") ? "bad" : m.latest.some((l) => l.outcome === "degraded") ? "warn" : m.latest.length ? "ok" : "empty";
              const muted = m.mutedUntil != null && m.mutedUntil > Date.now();
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
                      <p className="check-title">
                        <Mark status={worst} />
                        <span className="check-title-text">{m.name}</span>
                        {muted ? <span className="check-flag">Muted</span> : null}
                        {m.drifted ? <span className="check-flag">Drifted</span> : null}
                        {m.origin === "git" ? <span className="check-flag">Imported</span> : null}
                      </p>
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
                      <button className="btn btn-secondary btn-sm" type="button" disabled={busy === `mute:${m.id}`} onClick={() => void mute(m.id, muted ? null : Date.now() + 3_600_000)}>
                        {busy === `mute:${m.id}` ? "Saving…" : muted ? "Unmute" : "Mute 1h"}
                      </button>
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
  const [active, setActive] = useState<MaintenanceWindow | null>(null);
  const [note, setNote] = useState("");
  const [endAt, setEndAt] = useState(() => toLocalInput(Date.now() + 2 * 60 * 60 * 1000));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function refresh() {
    const res = await api<{ window: MaintenanceWindow | null }>(`/api/ops/components/${componentId}/maintenance`);
    if (!res.ok) return;
    setActive(res.data.window);
    if (res.data.window) setNote(res.data.window.note);
  }

  useEffect(() => {
    setError(null);
    setNote("");
    setEndAt(toLocalInput(Date.now() + 2 * 60 * 60 * 1000));
    void refresh();
  }, [componentId]);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = new Date(endAt).getTime();
    setPending(true);
    const res = await api<{ window: MaintenanceWindow }>(`/api/ops/components/${componentId}/maintenance`, {
      method: "POST",
      body: JSON.stringify({ note, endAt: parsed }),
    });
    setPending(false);
    if (!res.ok) {
      setError(mutationError(res.error, "Could not start maintenance."));
      return;
    }
    setActive(res.data.window);
    await onChange();
  }

  async function end() {
    setError(null);
    setPending(true);
    const res = await api(`/api/ops/components/${componentId}/maintenance`, { method: "DELETE" });
    setPending(false);
    if (!res.ok) {
      setError(mutationError(res.error, "Could not end maintenance."));
      return;
    }
    setActive(null);
    await onChange();
  }

  return (
    <form className="card flex flex-col gap-3 p-5" onSubmit={start}>
      <div>
        <h2 className="section-title">Maintenance</h2>
        <p className="section-copy">
          Marks <span className="font-medium text-ink">{componentName}</span> as under maintenance on the public page. Does not change the outage banner.
        </p>
      </div>
      {active ? (
        <>
          <p className="text-sm">
            Active until <time dateTime={new Date(active.endAt).toISOString()}>{new Date(active.endAt).toUTCString()}</time>
          </p>
          {active.note ? <p className="text-sm text-muted">{active.note}</p> : null}
          <button className="btn btn-secondary w-fit" type="button" disabled={pending} onClick={() => void end()}>
            {pending ? "Ending…" : "End now"}
          </button>
        </>
      ) : (
        <>
          <Field label="Note (optional)" htmlFor="maint-note">
            <input id="maint-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Deploying API v2" />
          </Field>
          <Field label="End" htmlFor="maint-end">
            <input id="maint-end" className="input" type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} required />
          </Field>
          <button className="btn btn-primary w-fit" disabled={pending} type="submit">
            {pending ? "Starting…" : "Start maintenance"}
          </button>
        </>
      )}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </form>
  );
}
