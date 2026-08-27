import type { Env } from "../env.ts";

export class WorkerSecretError extends Error {
  constructor(public readonly code: "management_unavailable" | "cloudflare_api") {
    super(code);
  }
}

export function canManageWorkerSecrets(env: Env): boolean {
  return Boolean(env.FOXWATCH_CF_API_TOKEN && env.FOXWATCH_CF_ACCOUNT_ID && env.FOXWATCH_CF_SCRIPT_NAME);
}

export async function putWorkerSecret(env: Env, name: string, value: string): Promise<void> {
  if (!canManageWorkerSecrets(env)) throw new WorkerSecretError("management_unavailable");
  const account = encodeURIComponent(env.FOXWATCH_CF_ACCOUNT_ID!);
  const script = encodeURIComponent(env.FOXWATCH_CF_SCRIPT_NAME!);
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${script}/secrets`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${env.FOXWATCH_CF_API_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name, text: value, type: "secret_text" }),
  });
  if (!response.ok) throw new WorkerSecretError("cloudflare_api");
  const payload = await response.json().catch(() => null) as { success?: boolean } | null;
  if (!payload?.success) throw new WorkerSecretError("cloudflare_api");
}
