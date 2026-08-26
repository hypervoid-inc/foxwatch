export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error?: string };

export async function api<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, status: res.status, error: body?.error };
  }
  if (res.status === 204) return { ok: true, data: undefined as T };
  return { ok: true, data: (await res.json()) as T };
}

export async function apiUpload<T>(path: string, body: FormData): Promise<ApiResult<T>> {
  const res = await fetch(path, { method: "POST", credentials: "same-origin", body });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, status: res.status, error: json?.error };
  }
  return { ok: true, data: (await res.json()) as T };
}
