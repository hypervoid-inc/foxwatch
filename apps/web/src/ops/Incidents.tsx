import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { appendIncidents, incidentRefreshLimit, incidentsPath, incidentUpdatePayload, mergeRefreshedIncidents, type ResolvedList } from "./incident-list.ts";
import { impactLabel, incidentStatusLabel } from "./labels.ts";
import { ErrorText, Field, Mark, Timeline, useActionFlash } from "./ui.tsx";

export type Incident = {
  id: string;
  componentIds: string[];
  title: string;
  status: string;
  impact: string;
  startedAt: number;
  resolvedAt: number | null;
  updates: Array<{ status: string; body: string; at: number }>;
};

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function statusIcon(status: string): "ok" | "warn" | "bad" | "empty" {
  if (status === "resolved") return "ok";
  if (status === "investigating") return "bad";
  if (status === "identified") return "warn";
  return "warn";
}

function impactTone(impact: string): "bad" | "warn" {
  return impact === "failing" ? "bad" : "warn";
}

type IncidentPage = { open?: Incident[]; resolved: Incident[]; nextCursor: string | null };

export function Incidents({
  components,
  refreshKey,
  onChange,
}: {
  components: Array<{ id: string; name: string }>;
  /** Changes whenever the admin overview reloads, so automatic incidents show up here too. */
  refreshKey: number;
  onChange: () => Promise<void>;
}) {
  const [active, setActive] = useState<Incident[]>([]);
  const [resolved, setResolved] = useState<Incident[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listStatus, setListStatus] = useState<"loading" | "ready" | "error">("loading");
  const [more, setMore] = useState<"idle" | "loading" | "error">("idle");
  const listSeq = useRef(0);
  /** The resolved list as it stands, for a request that returns after another one changed it. */
  const list = useRef<ResolvedList<Incident>>({ resolved: [], nextCursor: null });
  const [title, setTitle] = useState("");
  const [impact, setImpact] = useState<"degraded" | "failing">("degraded");
  const [body, setBody] = useState("Investigating.");
  const [componentIds, setComponentIds] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState("");
  const [notify, setNotify] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { flash, flashOk } = useActionFlash();

  function showResolved(next: ResolvedList<Incident>) {
    list.current = next;
    setResolved(next.resolved);
    setNextCursor(next.nextCursor);
  }

  /**
   * Reloads the list from the top. One request covers a limited number of resolved incidents,
   * so older ones already on screen stay where they are.
   */
  async function refresh() {
    const seq = ++listSeq.current;
    const res = await api<IncidentPage>(incidentsPath({ limit: incidentRefreshLimit(list.current.resolved.length) }));
    if (seq !== listSeq.current) return;
    if (!res.ok) {
      // A failed refresh keeps the list that is already showing.
      setListStatus((current) => (current === "ready" ? current : "error"));
      return;
    }
    const open = res.data.open ?? [];
    setActive(open);
    showResolved(mergeRefreshedIncidents(list.current, res.data, open.map((incident) => incident.id)));
    setListStatus("ready");
  }

  // Not counted in listSeq: a background refresh must not cancel a "load older" request.
  async function loadMore() {
    const cursor = list.current.nextCursor;
    if (!cursor || more === "loading") return;
    setMore("loading");
    const res = await api<IncidentPage>(incidentsPath({ cursor }));
    if (!res.ok) {
      setMore("error");
      return;
    }
    setMore("idle");
    // A refresh that replaced the list in the meantime moved the cursor; this page no longer continues from it.
    if (list.current.nextCursor !== cursor) return;
    showResolved({ resolved: appendIncidents(list.current.resolved, res.data.resolved), nextCursor: res.data.nextCursor });
  }

  useEffect(() => {
    void refresh();
  }, [refreshKey]);

  async function changed() {
    await Promise.all([refresh(), onChange()]);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const res = await api("/api/ops/incidents", {
      method: "POST",
      body: JSON.stringify({ title, impact, body, componentIds, startedAt: startedAt ? new Date(startedAt).getTime() : undefined, notify }),
    });
    setPending(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setTitle("");
    setBody("Investigating.");
    setComponentIds([]);
    setStartedAt("");
    flashOk();
    await changed();
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <section className="flex flex-col gap-4">
        {/* Active incidents */}
        {active.length > 0 ? (
          <div className="card overflow-hidden">
            <div className="px-4 py-3">
              <h2 className="section-title">Active incidents</h2>
              <p className="section-copy">{active.length} ongoing, updates appear on the public status page.</p>
            </div>
            <ul className="incident-list">
              {active.map((i) => (
                <li key={i.id} className="incident-item">
                  <div className="incident-head">
                    <Mark status={statusIcon(i.status)} />
                    <div className="incident-meta">
                      <p className="incident-title">{i.title}</p>
                      <div className="incident-tags">
                        <span className={`incident-badge incident-badge-${impactTone(i.impact)}`}>{impactLabel(i.impact)}</span>
                        <span className="incident-badge incident-badge-status">{incidentStatusLabel(i.status)}</span>
                        <span className="incident-time" title={new Date(i.startedAt).toUTCString()}>{relativeTime(i.startedAt)}</span>
                      </div>
                    </div>
                  </div>
                  {i.componentIds.length ? (
                    <p className="incident-components">
                      {i.componentIds.map((id) => components.find((c) => c.id === id)?.name ?? id).join(", ")}
                    </p>
                  ) : null}
                  <Timeline updates={i.updates} />
                  <IncidentUpdate id={i.id} status={i.status} onChange={changed} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* Resolved history */}
        <div className="card overflow-hidden">
          <div className="px-4 py-3">
            <h2 className="section-title">{active.length > 0 ? "Resolved" : "Incident history"}</h2>
            <p className="section-copy">Past incidents visible on the public page.</p>
          </div>
          {listStatus === "loading" ? (
            <p className="empty-note">Loading…</p>
          ) : listStatus === "error" ? (
            <div className="border-t border-line px-4 py-8">
              <ErrorText>Could not load incidents.</ErrorText>
              <button className="btn btn-secondary btn-sm mt-2" type="button" onClick={() => void refresh()}>
                Retry
              </button>
            </div>
          ) : resolved.length === 0 && active.length === 0 ? (
            <div className="empty-note">
              <svg className="mx-auto mb-2 size-8 text-muted opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="M9 12l2 2 4-4"/></svg>
              No incidents reported. All systems operational.
            </div>
          ) : resolved.length === 0 ? (
            <p className="empty-note">No resolved incidents yet.</p>
          ) : (
            <ul className="incident-list">
              {resolved.map((i) => (
                <li key={i.id} className="incident-item incident-item-resolved">
                  <div className="incident-head">
                    <Mark status="ok" />
                    <div className="incident-meta">
                      <p className="incident-title">{i.title}</p>
                      <div className="incident-tags">
                        <span className={`incident-badge incident-badge-${impactTone(i.impact)}`}>{impactLabel(i.impact)}</span>
                        <span className="incident-badge incident-badge-ok">Resolved</span>
                        <span className="incident-time" title={new Date(i.startedAt).toUTCString()}>{relativeTime(i.startedAt)}</span>
                        {i.resolvedAt ? <span className="incident-duration">Duration: {formatDuration(i.resolvedAt - i.startedAt)}</span> : null}
                      </div>
                    </div>
                  </div>
                  <Timeline updates={i.updates} />
                </li>
              ))}
            </ul>
          )}
          {listStatus === "ready" && nextCursor ? (
            <div className="border-t border-line px-4 py-3">
              {more === "error" ? <ErrorText>Could not load older incidents.</ErrorText> : null}
              <button className={`btn btn-secondary btn-sm${more === "error" ? " mt-2" : ""}`} type="button" disabled={more === "loading"} onClick={() => void loadMore()}>
                {more === "loading" ? "Loading…" : more === "error" ? "Retry" : "Load older incidents"}
              </button>
            </div>
          ) : null}
        </div>
      </section>

      <form className="card aside-panel flex h-fit flex-col gap-3 p-5" onSubmit={create}>
        <h2 className="section-title">Open an incident</h2>
        <Field label="Public title" htmlFor="inc-title">
          <input id="inc-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Elevated API errors" required />
        </Field>
        <Field label="Impact" htmlFor="inc-impact">
          <select id="inc-impact" className="input" value={impact} onChange={(e) => setImpact(e.target.value as "degraded" | "failing")}>
            <option value="degraded">Degraded</option>
            <option value="failing">Outage</option>
          </select>
        </Field>
        <fieldset>
          <legend className="mb-1.5 text-[0.8125rem] font-medium">Affected components</legend>
          <div className="flex max-h-36 flex-col gap-1.5 overflow-auto rounded-lg border border-line p-2">
            {components.map((component) => (
              <label key={component.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={componentIds.includes(component.id)}
                  onChange={(e) => setComponentIds((ids) => e.target.checked ? [...ids, component.id] : ids.filter((id) => id !== component.id))}
                />
                {component.name}
              </label>
            ))}
            {components.length === 0 ? <span className="text-sm text-muted">No components yet.</span> : null}
          </div>
          <p className="mt-1 text-xs text-muted">Leave all unchecked to affect the whole status page.</p>
        </fieldset>
        <Field label="First update" htmlFor="inc-body">
          <textarea id="inc-body" className="input min-h-20" value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <Field label="Start time (optional)" htmlFor="inc-started">
          <input id="inc-started" className="input" type="datetime-local" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />Send configured alerts</label>
        {error ? <ErrorText>{error}</ErrorText> : null}
        <button className="btn btn-primary btn-flash" disabled={pending} type="submit">
          {pending ? "Publishing…" : flash ? "Published" : "Publish"}
        </button>
      </form>
    </div>
  );
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours < 24) return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function IncidentUpdate({
  id,
  status: current,
  onChange,
}: {
  id: string;
  /** The incident's status now. A message posted without touching the select must not change it. */
  status: string;
  onChange: () => Promise<void>;
}) {
  const [status, setStatus] = useState(current);
  // Only a status the operator picked is sent; the one shown until then may be out of date.
  const [picked, setPicked] = useState(false);
  const [body, setBody] = useState("");
  const [notify, setNotify] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Follows the incident when it moves on, here or from another operator, until the operator picks a status.
  useEffect(() => {
    if (!picked) setStatus(current);
  }, [current, picked]);

  return (
    <form
      className="incident-update-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        if (!body.trim()) {
          setError("Add a public incident update message.");
          return;
        }
        setPending(true);
        const res = await api(`/api/ops/incidents/${id}/updates`, { method: "POST", body: JSON.stringify(incidentUpdatePayload({ status: picked ? status : null, body, notify })) });
        setPending(false);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setBody("");
        setPicked(false);
        await onChange();
      }}
    >
      <div className="incident-update-row">
        <select className="input incident-update-select" value={status} onChange={(e) => { setStatus(e.target.value); setPicked(true); }} aria-label="Incident status">
          <option value="investigating">Investigating</option>
          <option value="identified">Identified</option>
          <option value="monitoring">Monitoring</option>
          <option value="resolved">Resolved</option>
        </select>
        <input className="input incident-update-input" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Post a public update…" aria-label="Public update" required />
      </div>
      <div className="incident-update-actions">
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />Alert</label>
        <button className="btn btn-primary btn-sm" disabled={pending} type="submit">
          {pending ? "Posting…" : "Post update"}
        </button>
      </div>
      {error ? <ErrorText>{error}</ErrorText> : null}
    </form>
  );
}
