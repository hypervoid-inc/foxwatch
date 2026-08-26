import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { ErrorText, Skeleton } from "./ui.tsx";

export const ACTIVITY_PAGE_SIZE = 100;

type Entry = { id: string; actor: string; action: string; createdAt: number };

export function activityPath(cursor?: string | null): string {
  const q = new URLSearchParams({ limit: String(ACTIVITY_PAGE_SIZE) });
  if (cursor) q.set("cursor", cursor);
  return `/api/ops/audit?${q}`;
}

export function mergeActivityById(current: Entry[], incoming: Entry[], mode: "append" | "prepend"): Entry[] {
  const seen = new Set(current.map((e) => e.id));
  const extra = incoming.filter((e) => !seen.has(e.id));
  return mode === "prepend" ? [...extra, ...current] : [...current, ...extra];
}

export function Activity() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [more, setMore] = useState<"idle" | "loading" | "error">("idle");
  const nextCursorRef = useRef<string | null>(null);
  const moreRef = useRef<"idle" | "loading" | "error">("idle");
  const sentinelRef = useRef<HTMLLIElement>(null);

  const loadPage = useCallback(async (cursor: string | null, mode: "replace" | "append") => {
    if (mode === "append") {
      if (!cursor || moreRef.current === "loading") return;
      moreRef.current = "loading";
      setMore("loading");
    }
    const res = await api<{ entries: Entry[]; nextCursor?: string | null }>(activityPath(cursor));
    if (!res.ok) {
      if (mode === "replace") {
        setStatus("error");
        return;
      }
      moreRef.current = "error";
      setMore("error");
      return;
    }
    const pageCursor = res.data.nextCursor ?? null;
    nextCursorRef.current = pageCursor;
    setNextCursor(pageCursor);
    setEntries((prev) => (mode === "replace" ? res.data.entries : mergeActivityById(prev, res.data.entries, "append")));
    if (mode === "replace") setStatus("ready");
    moreRef.current = "idle";
    setMore("idle");
  }, []);

  useEffect(() => {
    void loadPage(null, "replace");
  }, [loadPage]);

  useEffect(() => {
    if (status !== "ready" || !nextCursor || more === "error") return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (observed) => {
        if (observed.some((entry) => entry.isIntersecting)) void loadPage(nextCursorRef.current, "append");
      },
      { rootMargin: "240px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [status, nextCursor, more, loadPage]);

  return (
    <section className="card overflow-hidden">
      <div className="px-4 py-3">
        <h2 className="section-title">Activity</h2>
        <p className="section-copy">Recent admin actions on this instance.</p>
      </div>
      {status === "loading" ? (
        <div className="flex flex-col gap-3 border-t border-line px-4 py-4" aria-busy="true" aria-label="Loading activity">
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-4 w-52" />
          <Skeleton className="h-4 w-72" />
        </div>
      ) : null}
      {status === "error" ? (
        <div className="border-t border-line px-4 py-8">
          <ErrorText>Could not load activity.</ErrorText>
        </div>
      ) : null}
      {status === "ready" && entries.length === 0 ? (
        <p className="empty-note">No activity yet.</p>
      ) : null}
      {status === "ready" && entries.length > 0 ? (
        <ul>
          {entries.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-x-3 gap-y-1 border-t border-line px-4 py-2.5 text-[0.8125rem]">
              <time className="text-muted" dateTime={new Date(e.createdAt).toISOString()}>
                {new Date(e.createdAt).toLocaleString()}
              </time>
              <span className="font-medium">{e.action}</span>
              <span className="text-muted">{e.actor}</span>
            </li>
          ))}
          {nextCursor && more !== "error" ? (
            <li
              ref={sentinelRef}
              className={
                more === "loading"
                  ? "border-t border-line px-4 py-3 text-center text-[0.8125rem] text-muted"
                  : "h-px"
              }
              aria-busy={more === "loading"}
              aria-hidden={more !== "loading"}
            >
              {more === "loading" ? "Loading more…" : null}
            </li>
          ) : null}
          {more === "error" ? (
            <li className="border-t border-line px-4 py-3">
              <ErrorText>Could not load more activity.</ErrorText>
              <button className="btn btn-secondary btn-sm mt-2" type="button" onClick={() => void loadPage(nextCursor, "append")}>
                Retry
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </section>
  );
}
