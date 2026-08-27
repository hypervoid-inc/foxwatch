import { useEffect, useState } from "react";
import { api, apiUpload } from "./api.ts";
import { mutationError } from "./labels.ts";
import { prepareSiteIcon } from "./prepare-icon.ts";
import { ConfirmDialog, ErrorText, FoxMark, InfoTip, Seg, useActionFlash } from "./ui.tsx";

export type Me = { id: string; email: string; role: "superadmin" | "admin" };

const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

export function Settings({
  siteName,
  me,
  incomingIcon,
  onIncomingIconConsumed,
  onChange,
}: {
  siteName: string;
  me: Me;
  incomingIcon?: File | null;
  onIncomingIconConsumed?: () => void;
  onChange: () => Promise<void>;
}) {
  const [name, setName] = useState(siteName);
  const [homepageUrl, setHomepageUrl] = useState("");
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<Array<{ name: string; set: boolean }>>([]);
  const [manageable, setManageable] = useState(false);
  const [nextName, setNextName] = useState("");
  const [nextValue, setNextValue] = useState("");
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [rotatingSecret, setRotatingSecret] = useState<string | null>(null);
  const [rotateValue, setRotateValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [secretBusy, setSecretBusy] = useState(false);
  const [iconBusy, setIconBusy] = useState(false);
  const { flash, flashOk } = useActionFlash();

  async function refresh() {
    const site = await api<{ siteName: string; homepageUrl: string; iconUrl: string | null }>("/api/ops/settings");
    if (site.ok) {
      setName(site.data.siteName);
      setHomepageUrl(site.data.homepageUrl);
      setIconUrl(site.data.iconUrl);
    }
    const secs = await api<{ secrets: Array<{ name: string; set: boolean }>; manageable: boolean }>("/api/ops/secrets");
    if (secs.ok) {
      setSecrets(secs.data.secrets);
      setManageable(secs.data.manageable);
    }
  }

  useEffect(() => {
    void refresh();
  }, [siteName]);

  useEffect(() => {
    if (!incomingIcon) return;
    void uploadIcon(incomingIcon).finally(() => onIncomingIconConsumed?.());
  }, [incomingIcon]);

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const res = await api("/api/ops/settings", { method: "PATCH", body: JSON.stringify({ siteName: name, homepageUrl }) });
    setPending(false);
    if (!res.ok) {
      setError(mutationError(res.error, "Could not save public site."));
      return;
    }
    await onChange();
    flashOk();
  }

  async function saveSecret(secretName: string, value: string) {
    setError(null);
    const n = secretName.trim().toUpperCase();
    if (!SECRET_NAME_RE.test(n)) {
      setError("Secret names must look like API_TOKEN (A-Z, 0-9, _).");
      return;
    }
    setSecretBusy(true);
    try {
      const payload: Record<string, string> = { name: n };
      if (value.trim()) payload.value = value.trim();
      const res = await api("/api/ops/secrets", { method: "POST", body: JSON.stringify(payload) });
      if (!res.ok) {
        setError(mutationError(res.error, "Could not save that secret."));
        return;
      }
      setNextName("");
      setNextValue("");
      setRotatingSecret(null);
      setRotateValue("");
      await refresh();
      await onChange();
    } finally {
      setSecretBusy(false);
    }
  }

  async function addSecret(e: React.FormEvent) {
    e.preventDefault();
    await saveSecret(nextName, nextValue);
  }

  async function rotateSecret(name: string) {
    await saveSecret(name, rotateValue);
  }

  async function removeSecret(n: string) {
    setError(null);
    setSecretBusy(true);
    try {
      const res = await api(`/api/ops/secrets/${encodeURIComponent(n)}`, { method: "DELETE" });
      setPendingRemove(null);
      if (!res.ok) {
        setError(mutationError(res.error, "Could not remove that secret."));
        return;
      }
      await refresh();
      await onChange();
    } finally {
      setSecretBusy(false);
    }
  }

  async function uploadIcon(file: File) {
    setError(null);
    setIconBusy(true);
    try {
      const prepared = await prepareSiteIcon(file);
      const body = new FormData();
      body.append("file", prepared);
      const res = await apiUpload<{ iconUrl: string }>("/api/ops/settings/icon", body);
      if (!res.ok) {
        setError(mutationError(res.error, "Could not save that icon."));
        return;
      }
      setIconUrl(res.data.iconUrl);
      await onChange();
    } catch (err) {
      const code = err instanceof Error ? err.message : "";
      setError(mutationError(code === "decode" || code === "too_large" ? code : "icon", "Could not save that icon."));
    } finally {
      setIconBusy(false);
    }
  }

  async function removeIcon() {
    setError(null);
    const res = await api("/api/ops/settings/icon", { method: "DELETE" });
    if (!res.ok) {
      setError(mutationError(res.error, "Could not remove that icon."));
      return;
    }
    setIconUrl(null);
    await onChange();
  }

  return (
    <div className="settings-grid">
      {error ? (
        <div className="settings-error">
          <ErrorText>{error}</ErrorText>
        </div>
      ) : null}

      {/* Row 1: Public site + Operators */}
      <div className="settings-row">
        <form className="card set-card" onSubmit={saveName}>
          <div className="set-card-head">
            <h2 className="section-title">Public site</h2>
            <p className="section-copy">Name, icon, and header link on the public page.</p>
          </div>
          <section className="check-sheet" aria-label="Public site">
            <label className="check-row" htmlFor="site-name">
              <span className="check-row-k">Name</span>
              <input id="site-name" className="check-plain" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="off" />
            </label>
            <label className="check-row" htmlFor="site-home">
              <span className="check-row-k">Homepage</span>
              <input
                id="site-home"
                className="check-plain check-plain-mono"
                type="url"
                value={homepageUrl}
                onChange={(e) => setHomepageUrl(e.target.value)}
                placeholder="https://example.com"
              />
            </label>
            <div className="check-row">
              <span className="check-row-k">Icon</span>
              <span className="site-icon-slot">{iconUrl ? <img className="site-icon-preview" src={iconUrl} alt="" width="32" height="32" /> : <FoxMark />}</span>
              <label className="check-quiet check-quiet-ink">
                {iconBusy ? "Preparing…" : iconUrl ? "Replace" : "Upload"}
                <input
                  className="sr-only"
                  type="file"
                  accept="image/*,.heic,.heif,.avif,.svg,.ico"
                  disabled={iconBusy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) void uploadIcon(file);
                  }}
                />
              </label>
              {iconUrl ? (
                <button className="check-quiet check-quiet-bad" type="button" disabled={iconBusy} onClick={() => void removeIcon()}>
                  Remove
                </button>
              ) : null}
            </div>
          </section>
          <div className="check-form-actions">
            <button className="btn btn-primary btn-flash" disabled={pending} type="submit">
              {pending ? "Saving…" : flash ? "Saved" : "Save"}
            </button>
          </div>
        </form>

        {me.role === "superadmin" ? <Operators me={me} /> : null}
      </div>

      {/* Row 2: Secrets + Alert channels */}
      <div className="settings-row">
        <section className="card set-card">
          <div className="set-card-head">
            <h2 className="section-title">Secrets</h2>
            <p className="section-copy">
              Encrypted key-value pairs used by checks and alerts. Once set, values can only be rotated (never read back).
            </p>
          </div>
          {secrets.length === 0 ? (
            <div className="set-empty">
              <svg className="inline-block size-4 text-muted opacity-60" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><path d="M8 1v4M8 11v4M1 8h4M11 8h4"/></svg>
              {" "}No secrets yet. Add one below.
            </div>
          ) : (
            <ul className="check-sheet secret-list">
              {secrets.map((row) => (
                <li key={row.name} className="secret-item">
                  <div className="check-row">
                    <span className="secret-icon" aria-hidden="true">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg>
                    </span>
                    <code className="set-secret-name">{row.name}</code>
                    <span className={`set-pill ${row.set ? "is-on" : ""}`}>{row.set ? "Set" : "Missing"}</span>
                    {row.set && manageable ? (
                      <button
                        className="check-quiet check-quiet-ink"
                        type="button"
                        disabled={secretBusy}
                        onClick={() => { setRotatingSecret(rotatingSecret === row.name ? null : row.name); setRotateValue(""); }}
                      >
                        Rotate
                      </button>
                    ) : null}
                    <button
                      className="check-quiet check-quiet-bad"
                      type="button"
                      disabled={secretBusy}
                      onClick={() => setPendingRemove(row.name)}
                    >
                      Remove
                    </button>
                  </div>
                  {rotatingSecret === row.name ? (
                    <div className="secret-rotate">
                      <input
                        className="input"
                        type="password"
                        placeholder="New value"
                        value={rotateValue}
                        onChange={(e) => setRotateValue(e.target.value)}
                        autoComplete="off"
                      />
                      <button className="btn btn-primary btn-sm" type="button" disabled={secretBusy || !rotateValue.trim()} onClick={() => void rotateSecret(row.name)}>
                        {secretBusy ? "Saving…" : "Save new value"}
                      </button>
                      <button className="btn btn-secondary btn-sm" type="button" onClick={() => { setRotatingSecret(null); setRotateValue(""); }}>
                        Cancel
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <form id="secret-add" className="secret-add-form" onSubmit={addSecret} aria-label="Add secret">
            <div className="secret-add-fields">
              <input
                id="secret-name"
                className="input"
                value={nextName}
                onChange={(e) => setNextName(e.target.value.toUpperCase())}
                disabled={secretBusy}
                placeholder="NAME (e.g. API_TOKEN)"
                autoComplete="off"
              />
              {manageable ? (
                <input
                  id="secret-value"
                  className="input"
                  type="password"
                  value={nextValue}
                  onChange={(e) => setNextValue(e.target.value)}
                  disabled={secretBusy}
                  placeholder="Value (optional)"
                  autoComplete="off"
                />
              ) : null}
            </div>
            <div className="secret-add-actions">
              <button className="btn btn-primary btn-sm" disabled={secretBusy || !nextName.trim()} type="submit">
                Add secret
              </button>
              {!manageable ? <span className="text-xs text-muted">Set value later via <code>wrangler secret put NAME</code></span> : null}
            </div>
          </form>
          <ConfirmDialog
            open={pendingRemove != null}
            title={`Remove ${pendingRemove ?? "this secret"}?`}
            body="The Worker secret value is not deleted automatically. Existing checks keep their reference, but this name disappears from the picker."
            confirmLabel="Remove secret"
            pending={secretBusy}
            onCancel={() => setPendingRemove(null)}
            onConfirm={() => {
              if (pendingRemove) void removeSecret(pendingRemove);
            }}
          />
        </section>

        <AlertChannels secrets={secrets} onSecretsChange={refresh} />
      </div>
    </div>
  );
}

type AlertChannel = {
  id: string;
  type: "slack_webhook" | "discord_webhook" | "webhook";
  secretName: string;
  events: string[];
  ready: boolean;
};

function channelTypeLabel(type: AlertChannel["type"]): string {
  if (type === "slack_webhook") return "Slack";
  if (type === "discord_webhook") return "Discord";
  return "Webhook";
}

function channelTypeIcon(type: AlertChannel["type"]): string {
  if (type === "slack_webhook") return "#";
  if (type === "discord_webhook") return "D";
  return "{}";
}

function AlertChannels({
  secrets,
  onSecretsChange,
}: {
  secrets: Array<{ name: string; set: boolean }>;
  onSecretsChange: () => Promise<void>;
}) {
  const [channels, setChannels] = useState<AlertChannel[]>([]);
  const [id, setId] = useState("primary-alerts");
  const [type, setType] = useState<AlertChannel["type"]>("slack_webhook");
  const [secretName, setSecretName] = useState("SLACK_WEBHOOK_URL");
  const [events, setEvents] = useState(["fail", "degrade", "recover"]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [tested, setTested] = useState<string | null>(null);

  async function refresh() {
    const res = await api<{ channels: AlertChannel[] }>("/api/ops/alert-channels");
    if (res.ok) setChannels(res.data.channels);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const res = await api("/api/ops/alert-channels", {
      method: "POST",
      body: JSON.stringify({ id, type, secretName, events }),
    });
    setPending(false);
    if (!res.ok) {
      setError(mutationError(res.error, "Could not save that alert channel."));
      return;
    }
    await Promise.all([refresh(), onSecretsChange()]);
  }

  async function remove(channelId: string) {
    const res = await api(`/api/ops/alert-channels/${channelId}`, { method: "DELETE" });
    if (!res.ok) {
      setError(mutationError(res.error, "Could not remove that alert channel."));
      return;
    }
    await refresh();
  }

  async function test(channelId: string) {
    setError(null);
    const res = await api(`/api/ops/alert-channels/${channelId}/test`, { method: "POST", body: "{}" });
    if (!res.ok) {
      setError(mutationError(res.error, "Could not deliver a test alert."));
      return;
    }
    setTested(channelId);
    window.setTimeout(() => setTested((current) => current === channelId ? null : current), 1800);
  }

  function toggleEvent(event: string) {
    setEvents((current) => current.includes(event) ? current.filter((value) => value !== event) : [...current, event]);
  }

  function onTypeChange(newType: AlertChannel["type"]) {
    setType(newType);
    if (newType === "slack_webhook") setSecretName("SLACK_WEBHOOK_URL");
    else if (newType === "discord_webhook") setSecretName("DISCORD_WEBHOOK_URL");
    else setSecretName("WEBHOOK_URL");
  }

  return (
    <section className="card set-card">
      <div className="set-card-head">
        <h2 className="section-title">Alert channels</h2>
        <p className="section-copy">
          Route state transitions to Slack, Discord, or a JSON webhook.
          <InfoTip>Failed deliveries are retried by the queue with exponential backoff.</InfoTip>
        </p>
      </div>
      {channels.length ? (
        <ul className="check-sheet">
          {channels.map((channel) => (
            <li className="check-row alert-channel-row" key={channel.id}>
              <span className="alert-channel-icon" aria-hidden="true">{channelTypeIcon(channel.type)}</span>
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-sm">{channel.id}</strong>
                <span className="text-xs text-muted">{channelTypeLabel(channel.type)} · {channel.events.join(", ")}</span>
              </span>
              <span className={`set-pill ${channel.ready ? "is-on" : ""}`}>{channel.ready ? "Ready" : "Missing secret"}</span>
              <button className="check-quiet check-quiet-ink" type="button" disabled={!channel.ready} onClick={() => void test(channel.id)}>{tested === channel.id ? "Sent" : "Test"}</button>
              <button className="check-quiet check-quiet-bad" type="button" onClick={() => void remove(channel.id)}>Remove</button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="set-empty">
          <svg className="inline-block size-4 text-muted opacity-60" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><path d="M2 4l6 4 6-4M2 4v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1z"/></svg>
          {" "}No alert channels configured.
        </div>
      )}
      <form id="alert-add" className="alert-add-form" onSubmit={save}>
        <div className="alert-add-top">
          <label className="check-row" htmlFor="alert-id">
            <span className="check-row-k">Name</span>
            <input id="alert-id" className="check-plain check-plain-mono" value={id} onChange={(e) => setId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} required />
          </label>
          <label className="check-row" htmlFor="alert-type">
            <span className="check-row-k">Type</span>
            <select id="alert-type" className="check-plain check-plain-end" value={type} onChange={(e) => onTypeChange(e.target.value as AlertChannel["type"])}>
              <option value="slack_webhook">Slack webhook</option>
              <option value="discord_webhook">Discord webhook</option>
              <option value="webhook">JSON webhook</option>
            </select>
          </label>
          <label className="check-row" htmlFor="alert-secret">
            <span className="check-row-k">URL secret</span>
            <input id="alert-secret" className="check-plain check-plain-mono" list="alert-secrets" value={secretName} onChange={(e) => setSecretName(e.target.value.toUpperCase())} required />
            <datalist id="alert-secrets">{secrets.map((secret) => <option key={secret.name} value={secret.name} />)}</datalist>
          </label>
        </div>
        <fieldset className="alert-events">
          <legend className="check-row-k">Events</legend>
          <span className="flex flex-wrap gap-3">
            {([ ["fail", "Outage"], ["degrade", "Degraded"], ["recover", "Recovery"] ] as const).map(([value, label]) => (
              <label key={value} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={events.includes(value)} onChange={() => toggleEvent(value)} />{label}
              </label>
            ))}
          </span>
        </fieldset>
        <div className="check-form-actions">
          <button className="btn btn-primary" disabled={pending || events.length === 0}>{pending ? "Saving…" : "Add channel"}</button>
        </div>
      </form>
      {error ? <div className="px-[0.9rem] pb-2"><ErrorText>{error}</ErrorText></div> : null}
    </section>
  );
}

type Operator = { id: string; email: string; role: Me["role"]; createdAt: number };

function Operators({ me }: { me: Me }) {
  const [users, setUsers] = useState<Operator[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Me["role"]>("admin");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);

  async function refresh() {
    const res = await api<{ users: Operator[] }>("/api/ops/users");
    if (res.ok) setUsers(res.data.users);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const res = await api("/api/ops/users", { method: "POST", body: JSON.stringify({ email, password, role }) });
    setPending(false);
    if (!res.ok) {
      setError(
        res.error === "exists"
          ? "That email already has an account."
          : mutationError(res.error, "Use a valid email and a password of at least 12 characters."),
      );
      return;
    }
    setEmail("");
    setPassword("");
    setRole("admin");
    await refresh();
  }

  async function remove(id: string) {
    setError(null);
    const res = await api(`/api/ops/users/${id}`, { method: "DELETE" });
    setPendingRemove(null);
    if (!res.ok) {
      setError(mutationError(res.error, "Could not remove that operator."));
      return;
    }
    await refresh();
  }

  return (
    <section className="card set-card">
      <div className="set-card-head">
        <h2 className="section-title">Operators</h2>
        <p className="section-copy">People who can sign in to admin.</p>
      </div>
      {users.length === 0 ? (
        <p className="set-empty">No operators loaded.</p>
      ) : (
        <ul className="check-sheet">
          {users.map((u) => (
            <li key={u.id} className="check-row">
              <span className="operator-avatar">{u.email.charAt(0).toUpperCase()}</span>
              <span className="set-op-email">{u.email}</span>
              <span className="set-op-role">{u.role}</span>
              {u.id !== me.id ? (
                <button className="check-quiet check-quiet-bad" type="button" onClick={() => setPendingRemove(u.id)}>
                  Remove
                </button>
              ) : (
                <span className="set-pill is-on">You</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <form id="operator-add" className="check-sheet" onSubmit={create} aria-label="Add operator">
        <label className="check-row" htmlFor="op-email">
          <span className="check-row-k">Email</span>
          <input
            id="op-email"
            className="check-plain"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@example.com"
            autoComplete="off"
            required
          />
        </label>
        <label className="check-row" htmlFor="op-password">
          <span className="check-row-k">Password</span>
          <input
            id="op-password"
            className="check-plain"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="12+ characters"
            autoComplete="new-password"
            minLength={12}
            required
          />
        </label>
        <div className="check-row">
          <span className="check-row-k" id="op-role-label">
            Role
          </span>
          <Seg
            labelledBy="op-role-label"
            value={role}
            options={[
              { id: "admin", label: "Admin" },
              { id: "superadmin", label: "Superadmin" },
            ]}
            onChange={(id) => setRole(id as Me["role"])}
          />
        </div>
      </form>
      <div className="check-form-actions">
        <button className="btn btn-primary" disabled={pending} type="submit" form="operator-add">
          {pending ? "Adding…" : "Add operator"}
        </button>
      </div>
      {error ? <div className="px-[0.9rem]"><ErrorText>{error}</ErrorText></div> : null}
      <ConfirmDialog
        open={pendingRemove != null}
        title="Remove this operator?"
        body="They will be signed out immediately."
        confirmLabel="Remove operator"
        onCancel={() => setPendingRemove(null)}
        onConfirm={() => {
          if (pendingRemove) void remove(pendingRemove);
        }}
      />
    </section>
  );
}
