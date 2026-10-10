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

/** A request that never got an answer: offline, DNS, a dropped connection. */
const UNREACHABLE = { ok: false, status: 0, error: "Could not reach the server. Check your connection and try again.", code: "network" } as const;

/** A success status whose body is not the JSON the API sends, such as a proxy or login page. */
async function readData<T>(res: Response): Promise<ApiResult<T>> {
  if (res.status === 204) return { ok: true, data: undefined as T };
  try {
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, status: res.status, error: "The server sent an unexpected response. Try again.", code: "bad_response" };
  }
}

/** Always resolves, so a caller's pending state is cleared whatever happens to the request. */
export async function api<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: "same-origin",
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    return UNREACHABLE;
  }
  if (!res.ok) {
    const err = await readError(res);
    return { ok: false, status: res.status, ...err };
  }
  return readData<T>(res);
}

export async function apiUpload<T>(path: string, body: FormData): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", credentials: "same-origin", body });
  } catch {
    return UNREACHABLE;
  }
  if (!res.ok) {
    const err = await readError(res);
    return { ok: false, status: res.status, ...err };
  }
  return readData<T>(res);
}
