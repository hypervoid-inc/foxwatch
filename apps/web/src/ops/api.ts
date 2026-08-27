export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string; code?: string };

function statusFallback(status: number): string {
  if (status === 401) return "Sign in to continue.";
  if (status === 403) return "You do not have permission to do that.";
  if (status === 404) return "That item is gone.";
  if (status === 409) return "That already exists.";
  if (status === 429) return "Too many attempts. Try again in a few minutes.";
  if (status >= 500) return "Something went wrong. Try again.";
  return "Something went wrong. Try again.";
}

function fromErrorBody(res: Response, body: { error?: unknown; code?: unknown } | null): { error: string; code?: string } {
  const code = typeof body?.code === "string" && body.code ? body.code : undefined;
  const raw = typeof body?.error === "string" ? body.error.trim() : "";
  if (raw) return { error: raw, code: code ?? (raw.includes(" ") ? undefined : raw) };
  return { error: statusFallback(res.status), code };
}

async function readError(res: Response): Promise<{ error: string; code?: string }> {
  const body = (await res.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
  return fromErrorBody(res, body);
}

export async function api<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const err = await readError(res);
    return { ok: false, status: res.status, ...err };
  }
  if (res.status === 204) return { ok: true, data: undefined as T };
  return { ok: true, data: (await res.json()) as T };
}

export async function apiUpload<T>(path: string, body: FormData): Promise<ApiResult<T>> {
  const res = await fetch(path, { method: "POST", credentials: "same-origin", body });
  if (!res.ok) {
    const err = await readError(res);
    return { ok: false, status: res.status, ...err };
  }
  return { ok: true, data: (await res.json()) as T };
}
