import { useEffect, useRef, useState, type ReactNode } from "react";
import { incidentStatusLabel, timelineTone } from "./labels.ts";
import { applyTheme, THEME_KEY, themeFromDocument, toggleTheme } from "./theme.ts";

export function Mark({ status }: { status: "ok" | "warn" | "bad" | "empty" }) {
  if (status === "ok") {
    return (
      <svg className="size-4 shrink-0 fill-ok" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="10" />
        <path d="M6 10.4 8.6 13 14.2 7.4" fill="none" stroke="var(--on-accent)" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === "bad") {
    return (
      <svg className="size-4 shrink-0 fill-bad" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="10" />
        <path d="M7 7l6 6M13 7l-6 6" fill="none" stroke="var(--on-accent)" strokeWidth="1.85" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === "empty") {
    return (
      <svg className="size-4 shrink-0 text-muted" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="9" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    );
  }
  return (
    <svg className="size-4 shrink-0 fill-warn" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="10" />
      <path d="M10 6v5.2M10 14.2h.01" fill="none" stroke="var(--on-accent)" strokeWidth="1.85" strokeLinecap="round" />
    </svg>
  );
}

export function FoxMark() {
  return <img className="fox-mark" src="/fox.png" alt="" width="20" height="20" />;
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    typeof document === "undefined" ? "light" : themeFromDocument(),
  );

  useEffect(() => {
    function sync(e: StorageEvent) {
      if (e.key !== THEME_KEY) return;
      if (e.newValue === "light" || e.newValue === "dark") {
        applyTheme(e.newValue);
        setTheme(e.newValue);
      }
    }
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  return (
    <button
      className="btn btn-secondary btn-sm theme-toggle"
      type="button"
      aria-label={theme === "dark" ? "Use light appearance" : "Use dark appearance"}
      onClick={() => setTheme(toggleTheme())}
    >
      <span className="theme-icon theme-icon-moon" aria-hidden="true" />
      <span className="theme-icon theme-icon-sun" aria-hidden="true" />
    </button>
  );
}

export function Seg({
  label,
  labelledBy,
  value,
  options,
  disabled,
  onChange,
}: {
  label?: string;
  labelledBy?: string;
  value: string;
  options: readonly { id: string; label: string }[];
  disabled?: boolean;
  onChange: (id: string) => void;
}) {
  return (
    <div className="seg" role="group" aria-label={label} aria-labelledby={labelledBy}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={value === o.id} disabled={disabled} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field" htmlFor={htmlFor}>
      <span>{label}</span>
      {children}
      {hint ? <span className="text-xs font-normal text-muted">{hint}</span> : null}
    </label>
  );
}

export function InfoTip({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);

  function position() {
    const el = ref.current;
    const pop = popRef.current;
    if (!el || !pop) return;
    const rect = el.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    // Try below first
    let top = rect.bottom + 6;
    let left = rect.left + rect.width / 2 - popRect.width / 2;
    // If below goes off screen, show above
    if (top + popRect.height > window.innerHeight - 8) {
      top = rect.top - popRect.height - 6;
    }
    // Keep within horizontal bounds
    if (left < 8) left = 8;
    if (left + popRect.width > window.innerWidth - 8) left = window.innerWidth - popRect.width - 8;
    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;
  }

  return (
    <span
      className="info-tip"
      ref={ref}
      tabIndex={0}
      aria-label={typeof children === "string" ? children : "More information"}
      onMouseEnter={position}
      onFocus={position}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.25" />
        <path d="M8 7.1v4M8 4.7h.01" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <span className="info-tip-pop" ref={popRef} role="tooltip">{children}</span>
    </span>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p className="text-sm text-bad" role="alert">
      {children}
    </p>
  );
}

export function CopyPanel({ curl, onDismiss }: { curl: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-panel" role="status">
      <p className="text-sm font-medium">Copy now; it will not be shown again.</p>
      <pre className="mt-2 overflow-x-auto text-xs whitespace-pre-wrap">{curl}</pre>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className="btn btn-primary"
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(curl).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button className="btn btn-secondary" type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function Timeline({
  updates,
}: {
  updates: Array<{ status: string; body: string; at: number }>;
}) {
  if (!updates.length) return null;
  return (
    <ol className="timeline">
      {updates.map((u, i) => (
        <li key={`${u.at}-${i}`} className={`timeline-item timeline-item-${timelineTone(u.status)}`}>
          <p className="text-xs text-muted">
            {incidentStatusLabel(u.status)} · <time dateTime={new Date(u.at).toISOString()}>{new Date(u.at).toUTCString()}</time>
          </p>
          {u.body ? <p className="mt-0.5 text-sm">{u.body}</p> : null}
        </li>
      ))}
    </ol>
  );
}

export function Skeleton({ className = "h-4 w-40" }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

export function useActionFlash(resetMs = 1200) {
  const [flash, setFlash] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  function flashOk() {
    setFlash(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setFlash(false), resetMs);
  }
  function flashOkThen(next: () => void) {
    setFlash(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setFlash(false);
      next();
    }, resetMs);
  }
  return { flash, flashOk, flashOkThen };
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  pending,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open) {
      if (!el.open) el.showModal();
      confirmRef.current?.focus();
    } else if (el.open) {
      el.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="confirm-panel">
        <h2 className="section-title">{title}</h2>
        <p className="section-copy">{body}</p>
        <div className="confirm-actions">
          <button className="btn btn-secondary" type="button" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button ref={confirmRef} className="btn btn-danger" type="button" disabled={pending} onClick={onConfirm}>
            {pending ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
