import { useEffect, useRef, useState } from "react";
import { api, apiUpload } from "./api.ts";
import { mutationError } from "./labels.ts";
import { prepareSiteIcon } from "./prepare-icon.ts";
import { ConfirmDialog, ErrorText, FoxMark, Seg, useActionFlash } from "./ui.tsx";

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
  const [nextName, setNextName] = useState("");
  const [nextValue, setNextValue] = useState("");
  const [replace, setReplace] = useState<Record<string, string>>({});
  const [editingName, setEditingName] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [secretBusy, setSecretBusy] = useState(false);
  const [iconBusy, setIconBusy] = useState(false);
  const [replaceFlashName, setReplaceFlashName] = useState<string | null>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const { flash, flashOk } = useActionFlash();
  const { flash: replaceFlash, flashOk: replaceFlashOk } = useActionFlash();

  async function refresh() {
    const site = await api<{ siteName: string; homepageUrl: string; iconUrl: string | null }>("/api/ops/settings");
    if (site.ok) {
      setName(site.data.siteName);
      setHomepageUrl(site.data.homepageUrl);
      setIconUrl(site.data.iconUrl);
    }
    const secs = await api<{ secrets: Array<{ name: string; set: boolean }> }>("/api/ops/secrets");
    if (secs.ok) setSecrets(secs.data.secrets);
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

  useEffect(() => {
    if (editingName) replaceInputRef.current?.focus();
  }, [editingName]);

  async function saveSecret(name: string, value: string, mode: "add" | "replace") {
    setError(null);
    const n = name.trim().toUpperCase();
    if (!SECRET_NAME_RE.test(n)) {
      setError("Secret names must look like API_TOKEN (A–Z, 0–9, _).");
      return;
    }
    if (!value) {
      setError("Enter a value for that secret.");
      return;
    }
    setSecretBusy(true);
    try {
      const res = await api("/api/ops/secrets", { method: "POST", body: JSON.stringify({ name: n, value }) });
      if (!res.ok) {
        setError(mutationError(res.error, "Could not save that secret."));
        return;
      }
      if (mode === "add") {
        setNextName("");
        setNextValue("");
      } else {
        setEditingName(null);
        setReplaceFlashName(n);
        replaceFlashOk();
      }
      setReplace((prev) => ({ ...prev, [n]: "" }));
      await refresh();
      await onChange();
    } finally {
      setSecretBusy(false);
    }
  }

  function cancelEdit(n: string) {
    setEditingName(null);
    setReplace((prev) => ({ ...prev, [n]: "" }));
  }

  async function addSecret(e: React.FormEvent) {
    e.preventDefault();
    await saveSecret(nextName, nextValue, "add");
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
      if (editingName === n) setEditingName(null);
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
    <div className="grid gap-5 lg:grid-cols-2">
      {error ? (
        <div className="lg:col-span-2">
          <ErrorText>{error}</ErrorText>
        </div>
      ) : null}
      <form className="card set-card" onSubmit={saveName}>
        <div className="set-card-head">
          <h2 className="section-title">Public site</h2>
          <p className="section-copy">
            Name, icon, and header link on the public page. Leave homepage blank to keep the header here. Any image works; it is converted and resized in the browser.
          </p>
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
      <section className="card set-card">
        <div className="set-card-head">
          <h2 className="section-title">Secrets</h2>
          <p className="section-copy">Values for check headers. Stored here and never shown again after save.</p>
        </div>
        {secrets.length === 0 ? (
          <p className="set-empty">None yet. Add a name and value, then pick that name on a check header.</p>
        ) : (
          <ul className="check-sheet">
            {secrets.map((row) => {
              const editing = !row.set || editingName === row.name;
              return (
                <li key={row.name} className="set-secret">
                  <div className="check-row">
                    <code className="set-secret-name">{row.name}</code>
                    {!row.set ? <span className="set-pill">Empty</span> : null}
                    {row.set && editingName !== row.name ? (
                      <button
                        className="check-quiet check-quiet-ink"
                        type="button"
                        disabled={secretBusy}
                        onClick={() => setEditingName(row.name)}
                      >
                        {replaceFlash && replaceFlashName === row.name ? "Updated" : "Replace"}
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
                  {editing ? (
                    <form
                      className="check-row set-secret-edit"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void saveSecret(row.name, replace[row.name] ?? "", "replace");
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== "Escape") return;
                        e.preventDefault();
                        if (row.set) cancelEdit(row.name);
                      }}
                    >
                      <input
                        ref={row.set && editingName === row.name ? replaceInputRef : undefined}
                        className="check-plain"
                        type="password"
                        value={replace[row.name] ?? ""}
                        onChange={(e) => setReplace((prev) => ({ ...prev, [row.name]: e.target.value }))}
                        placeholder={row.set ? "Replace value" : "Value"}
                        aria-label={`Value for ${row.name}`}
                        autoComplete="new-password"
                        disabled={secretBusy}
                      />
                      <button className="check-quiet check-quiet-ink" disabled={secretBusy} type="submit">
                        {secretBusy ? "Saving…" : "Save"}
                      </button>
                      {row.set ? (
                        <button className="check-quiet" type="button" disabled={secretBusy} onClick={() => cancelEdit(row.name)}>
                          Cancel
                        </button>
                      ) : null}
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <form id="secret-add" className="check-sheet" onSubmit={addSecret} aria-label="Add secret">
          <label className="check-row" htmlFor="secret-name">
            <span className="check-row-k">Name</span>
            <input
              id="secret-name"
              className="check-plain check-plain-mono"
              value={nextName}
              onChange={(e) => setNextName(e.target.value.toUpperCase())}
              disabled={secretBusy}
              placeholder="API_TOKEN"
              autoComplete="off"
            />
          </label>
          <label className="check-row" htmlFor="secret-value">
            <span className="check-row-k">Value</span>
            <input
              id="secret-value"
              className="check-plain"
              type="password"
              value={nextValue}
              onChange={(e) => setNextValue(e.target.value)}
              disabled={secretBusy}
              placeholder="Never shown again"
              autoComplete="new-password"
            />
          </label>
        </form>
        <div className="check-form-actions">
          <button className="btn btn-primary" disabled={secretBusy} type="submit" form="secret-add">
            Add
          </button>
        </div>
        <ConfirmDialog
          open={pendingRemove != null}
          title={`Remove ${pendingRemove ?? "this secret"}?`}
          body="Checks that use this name will send an empty header until another secret is picked."
          confirmLabel="Remove secret"
          pending={secretBusy}
          onCancel={() => setPendingRemove(null)}
          onConfirm={() => {
            if (pendingRemove) void removeSecret(pendingRemove);
          }}
        />
      </section>
      {me.role === "superadmin" ? <Operators me={me} /> : null}
    </div>
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
    <section className="card set-card lg:col-span-2">
      <div className="set-card-head">
        <h2 className="section-title">Operators</h2>
        <p className="section-copy">People who can sign in to admin. Passwords are hashed and never shown again.</p>
      </div>
      {users.length === 0 ? (
        <p className="set-empty">No operators loaded.</p>
      ) : (
        <ul className="check-sheet">
          {users.map((u) => (
            <li key={u.id} className="check-row">
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
          {pending ? "Adding…" : "Add"}
        </button>
      </div>
      {error ? <ErrorText>{error}</ErrorText> : null}
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
