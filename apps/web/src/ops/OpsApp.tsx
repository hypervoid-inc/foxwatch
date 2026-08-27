import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { Activity } from "./Activity.tsx";
import { Checks, type MonitorRow } from "./Checks.tsx";
import { Incidents, type Incident } from "./Incidents.tsx";
import { bannerLabel, bannerMark } from "./labels.ts";
import { fileFromDrop, isFileDrag } from "./prepare-icon.ts";
import { Settings, type Me } from "./Settings.tsx";
import { ErrorText, Field, FoxMark, Mark, Skeleton, ThemeToggle } from "./ui.tsx";
import { applyStatusFavicon } from "./status-favicon.ts";

type Overview = {
  snapshot: {
    siteName: string;
    banner: string;
    stale: boolean;
    iconUrl?: string | null;
    incidents: Incident[];
  };
  me: Me;
  monitors: MonitorRow[];
};

type Tab = "checks" | "incidents" | "activity" | "settings";
type Gate = "loading" | "setup" | "login" | "ready";

function tabFromPath(pathname: string): Tab {
  if (pathname.startsWith("/admin/incidents") || pathname.startsWith("/ops/incidents")) return "incidents";
  if (pathname.startsWith("/admin/activity") || pathname.startsWith("/ops/activity")) return "activity";
  if (pathname.startsWith("/admin/settings") || pathname.startsWith("/ops/settings")) return "settings";
  return "checks";
}

function pathForTab(tab: Tab): string {
  return tab === "checks" ? "/admin" : `/admin/${tab}`;
}

export function OpsApp() {
  const [gate, setGate] = useState<Gate>("loading");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [secrets, setSecrets] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => (typeof window === "undefined" ? "checks" : tabFromPath(window.location.pathname)));
  const [pending, setPending] = useState(false);
  const [iconDrop, setIconDrop] = useState<File | null>(null);
  const [dropOver, setDropOver] = useState(false);

  function go(next: Tab) {
    setTab(next);
    const path = pathForTab(next);
    if (window.location.pathname !== path) history.pushState(null, "", path);
  }

  async function load() {
    const auth = await api<{ setup: boolean; me: Me | null }>("/api/ops/auth");
    if (!auth.ok) {
      setGate("login");
      setError("Could not reach admin.");
      return;
    }
    if (auth.data.me) {
      const res = await api<Overview>("/api/ops/overview");
      if (!res.ok) {
        setGate("login");
        setError("Could not reach admin.");
        return;
      }
      setOverview(res.data);
      const s = await api<{ names: string[] }>("/api/ops/secrets");
      if (s.ok) setSecrets(s.data.names);
      setGate("ready");
      return;
    }
    setOverview(null);
    setGate(auth.data.setup ? "setup" : "login");
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (gate !== "ready") return;
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = window.setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [gate]);

  useEffect(() => {
    function onPop() {
      setTab(tabFromPath(window.location.pathname));
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    let depth = 0;
    function onEnter(e: DragEvent) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth += 1;
      setDropOver(true);
    }
    function onOver(e: DragEvent) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = gate === "ready" ? "copy" : "none";
    }
    function onLeave(e: DragEvent) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDropOver(false);
    }
    function onDrop(e: DragEvent) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth = 0;
      setDropOver(false);
      if (gate !== "ready") return;
      const file = fileFromDrop(e.dataTransfer);
      if (!file) return;
      setIconDrop(file);
      setTab("settings");
      if (window.location.pathname !== "/admin/settings") history.pushState(null, "", "/admin/settings");
    }
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [gate]);

  useEffect(() => {
    if (gate === "ready" && overview) {
      document.title = `${overview.snapshot.siteName} admin`;
      return;
    }
    document.title = "Foxwatch admin";
  }, [gate, overview]);

  useEffect(() => {
    if (overview?.snapshot.banner) {
      applyStatusFavicon(overview.snapshot.iconUrl ?? "/fox.png", overview.snapshot.banner);
      return;
    }
    let cancelled = false;
    void fetch("/api/status.json")
      .then((res) => (res.ok ? res.json() : null))
      .then((snap: { banner?: string; iconUrl?: string | null } | null) => {
        if (cancelled) return;
        applyStatusFavicon(snap?.iconUrl ?? "/fox.png", snap?.banner ?? "unknown");
      })
      .catch(() => {
        if (!cancelled) applyStatusFavicon("/fox.png", "unknown");
      });
    return () => {
      cancelled = true;
    };
  }, [overview?.snapshot.banner, overview?.snapshot.iconUrl]);

  async function setup(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setPending(true);
    const res = await api<{ ok: boolean }>("/api/ops/setup", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    setPending(false);
    if (!res.ok) {
      setError(res.error);
      if (res.code === "exists" || res.status === 409) setGate("login");
      return;
    }
    setPassword("");
    setConfirm("");
    await load();
  }

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const res = await api<{ ok: boolean }>("/api/ops/session", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    setPending(false);
    if (!res.ok) {
      setError(res.error);
      if (res.code === "setup") setGate("setup");
      return;
    }
    setPassword("");
    await load();
  }

  if (gate === "loading") {
    return (
      <div className="ops-wrap" aria-busy="true" aria-label="Loading admin">
        <div className="ops-head">
          <div className="flex items-center gap-2">
            <FoxMark />
            <Skeleton className="h-5 w-28" />
          </div>
          <ThemeToggle />
        </div>
        <div className="card mx-auto max-w-sm space-y-3 p-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </div>
    );
  }

  if (gate === "setup" || gate === "login") {
    return (
      <div className="ops-wrap">
        <header className="ops-head">
          <a className="flex items-center gap-2 font-semibold tracking-tight text-ink no-underline" href="/admin">
            <FoxMark />
            Foxwatch
          </a>
          <div className="ops-head-actions">
            <ThemeToggle />
            <a className="btn btn-secondary btn-sm" href="/">
              Public status
            </a>
          </div>
        </header>
        <section className="card mx-auto max-w-sm p-6">
          {gate === "setup" ? (
            <>
              <h1 className="text-xl font-semibold tracking-tight">Create the first account</h1>
              <p className="section-copy">
                This person becomes the superadmin. After this, admin will ask everyone else to sign in.
              </p>
              <form className="mt-6 flex flex-col gap-3" onSubmit={setup}>
                <Field label="Email" htmlFor="email">
                  <input
                    id="email"
                    className="input"
                    type="email"
                    autoComplete="username"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </Field>
                <Field label="Password" htmlFor="password" hint="At least 12 characters. Stored as a hash in this instance’s database.">
                  <input
                    id="password"
                    className="input"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    minLength={12}
                    required
                  />
                </Field>
                <Field label="Confirm password" htmlFor="confirm">
                  <input
                    id="confirm"
                    className="input"
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    minLength={12}
                    required
                  />
                </Field>
                {error ? <ErrorText>{error}</ErrorText> : null}
                <button className="btn btn-primary" disabled={pending} type="submit">
                  {pending ? "Creating…" : "Create superadmin"}
                </button>
              </form>
            </>
          ) : (
            <>
              <h1 className="text-xl font-semibold tracking-tight">Sign in to admin</h1>
              <p className="section-copy">Use an operator account for this instance.</p>
              <form className="mt-6 flex flex-col gap-3" onSubmit={login}>
                <Field label="Email" htmlFor="email">
                  <input
                    id="email"
                    className="input"
                    type="email"
                    autoComplete="username"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </Field>
                <Field label="Password" htmlFor="password">
                  <input
                    id="password"
                    className="input"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </Field>
                {error ? <ErrorText>{error}</ErrorText> : null}
                <button className="btn btn-primary" disabled={pending} type="submit">
                  {pending ? "Signing in…" : "Sign in"}
                </button>
              </form>
            </>
          )}
        </section>
      </div>
    );
  }

  if (!overview) return null;

  const mark = bannerMark(overview.snapshot.banner);

  return (
    <div className="ops-wrap">
      <header className="ops-head">
        <a className="flex items-center gap-2 font-semibold tracking-tight text-ink no-underline" href="/admin">
          {overview.snapshot.iconUrl ? <img className="fox-mark rounded-[26%] object-cover" src={overview.snapshot.iconUrl} alt="" width="20" height="20" /> : <FoxMark />}
          {overview.snapshot.siteName}
        </a>
        <div className="ops-head-actions">
          <span className="hidden text-[0.8125rem] text-muted sm:inline">{overview.me.email}</span>
          <span className={`pill pill-${mark}`}>
            <Mark status={mark} />
            {bannerLabel(overview.snapshot.banner)}
          </span>
          <ThemeToggle />
          <a className="btn btn-secondary btn-sm" href="/">
            Public page
          </a>
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={() =>
              void api("/api/ops/session", { method: "DELETE" }).then(() => {
                setOverview(null);
                void load();
              })
            }
          >
            Sign out
          </button>
        </div>
      </header>
      {overview.snapshot.stale ? (
        <p className="stale-banner" role="status">
          Monitoring data may be stale. The public page is showing the last known snapshot.
        </p>
      ) : null}
      <nav className="mb-5 flex gap-4 border-b border-line">
        {(
          [
            ["checks", "Checks"],
            ["incidents", "Incidents"],
            ["activity", "Activity"],
            ["settings", "Settings"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} className="nav-tab" type="button" aria-current={tab === id ? "page" : undefined} onClick={() => go(id)}>
            {label}
          </button>
        ))}
      </nav>
      {tab === "checks" ? <Checks monitors={overview.monitors} secrets={secrets} onChange={load} /> : null}
      {tab === "incidents" ? (
        <Incidents
          incidents={overview.snapshot.incidents}
          components={[...new Map(overview.monitors.map((monitor) => [monitor.componentId ?? monitor.id, { id: monitor.componentId ?? monitor.id, name: monitor.componentName }])).values()]}
          onChange={load}
        />
      ) : null}
      {tab === "activity" ? <Activity /> : null}
      {tab === "settings" ? (
        <Settings
          siteName={overview.snapshot.siteName}
          me={overview.me}
          incomingIcon={iconDrop}
          onIncomingIconConsumed={() => setIconDrop(null)}
          onChange={load}
        />
      ) : null}
      {dropOver ? (
        <div className="drop-veil" role="status">
          Drop to set the public site icon
        </div>
      ) : null}
    </div>
  );
}
