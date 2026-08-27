import type { Env } from "../env.ts";
import { envSecret } from "../env.ts";

export async function loadSecretMap(env: Env, names: string[]): Promise<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  for (const name of names) {
    out[name] = envSecret(env, name);
  }
  return out;
}

export async function resolveSecret(env: Env, name: string): Promise<string | undefined> {
  return envSecret(env, name);
}
