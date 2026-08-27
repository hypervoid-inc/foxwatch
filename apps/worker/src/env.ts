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
};

export function envSecret(env: Env, name: string): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function allowHttpLocal(env: Env): boolean {
  return env.ALLOW_HTTP_LOCAL === "true";
}
