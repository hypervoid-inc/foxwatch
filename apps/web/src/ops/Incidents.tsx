import { useState } from "react";
import { api } from "./api.ts";
import { impactLabel, incidentStatusLabel, mutationError } from "./labels.ts";
import { ErrorText, Field, Timeline, useActionFlash } from "./ui.tsx";

export type Incident = {
  id: string;
  title: string;
  status: string;
  impact: string;
  startedAt: number;
  resolvedAt: number | null;
  updates: Array<{ status: string; body: string; at: number }>;
};

export function Incidents({ incidents, onChange }: { incidents: Incident[]; onChange: () => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [impact, setImpact] = useState<"degraded" | "failing">("degraded");
  const [body, setBody] = useState("Investigating.");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { flash, flashOk } = useActionFlash();

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const res = await api("/api/ops/incidents", {
      method: "POST",
      body: JSON.stringify({ title, impact, body }),
    });
    setPending(false);
    if (!res.ok) {
      setError(mutationError(res.error, "Could not publish incident."));
      return;
    }
    setTitle("");
    setBody("Investigating.");
    flashOk();
    await onChange();
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <section className="card overflow-hidden">
        <div className="px-4 py-3">
          <h2 className="section-title">Incident history</h2>
          <p className="section-copy">Updates here appear on the public status page.</p>
          {error ? <div className="mt-2"><ErrorText>{error}</ErrorText></div> : null}
        </div>
        {incidents.length === 0 ? (
          <p className="empty-note">No incidents reported.</p>
        ) : (
          <ul>
            {incidents.map((i) => (
              <li key={i.id} className="border-t border-line px-4 py-3.5">
                <p className="font-semibold">{i.title}</p>
                <p className="mt-0.5 text-[0.8125rem] text-muted">
                  {incidentStatusLabel(i.status)} · {impactLabel(i.impact)} · {new Date(i.startedAt).toUTCString()}
                </p>
                <Timeline updates={i.updates} />
                <IncidentUpdate id={i.id} onChange={onChange} onError={setError} />
              </li>
            ))}
          </ul>
        )}
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
        <Field label="First update" htmlFor="inc-body">
          <textarea id="inc-body" className="input min-h-20" value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        {error ? <ErrorText>{error}</ErrorText> : null}
        <button className="btn btn-primary btn-flash" disabled={pending} type="submit">
          {pending ? "Publishing…" : flash ? "Published" : "Publish"}
        </button>
      </form>
    </div>
  );
}

function IncidentUpdate({
  id,
  onChange,
  onError,
}: {
  id: string;
  onChange: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [status, setStatus] = useState("monitoring");
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <form
      className="mt-3 flex flex-col gap-2 sm:flex-row"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!body.trim()) return;
        setPending(true);
        const res = await api(`/api/ops/incidents/${id}/updates`, { method: "POST", body: JSON.stringify({ status, body }) });
        setPending(false);
        if (!res.ok) {
          onError(mutationError(res.error, "Could not post that update."));
          return;
        }
        setBody("");
        await onChange();
      }}
    >
      <select className="input sm:w-40" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Incident status">
        <option value="investigating">Investigating</option>
        <option value="identified">Identified</option>
        <option value="monitoring">Monitoring</option>
        <option value="resolved">Resolved</option>
      </select>
      <input className="input" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Public update" />
      <button className="btn btn-secondary btn-sm" disabled={pending} type="submit">
        {pending ? "Posting…" : "Post"}
      </button>
    </form>
  );
}
