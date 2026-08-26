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
};

export function envSecret(env: Env, name: string): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function allowHttpLocal(env: Env): boolean {
  return env.ALLOW_HTTP_LOCAL === "true";
}
