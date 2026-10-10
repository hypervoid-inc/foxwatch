import { isReservedSecretName, SECRET_NAME_RE } from "@foxwatch/config";

export type Env = {
  DB: D1Database;
  STATUS: KVNamespace;
  ALERTS: Queue;
  METRICS: AnalyticsEngineDataset;
  SCHEDULER: DurableObjectNamespace;
  MONITOR: DurableObjectNamespace;
  PROBE: DurableObjectNamespace;
  STATUS_HUB: DurableObjectNamespace;
  ASSETS: Fetcher;
  ALLOW_HTTP_LOCAL?: string;
  /** One-time bootstrap credentials used only to create or rotate Worker secrets from admin. */
  FOXWATCH_CF_API_TOKEN?: string;
  FOXWATCH_CF_ACCOUNT_ID?: string;
  FOXWATCH_CF_SCRIPT_NAME?: string;
  /** Optional. When set, creating the first account must present this value. */
  FOXWATCH_SETUP_TOKEN?: string;
};

export function envSecret(env: Env, name: string): string | undefined {
  // Foxwatch's own bindings are configuration, never a check or alert secret.
  if (!SECRET_NAME_RE.test(name) || isReservedSecretName(name)) return undefined;
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function allowHttpLocal(env: Env): boolean {
  return env.ALLOW_HTTP_LOCAL === "true";
}
