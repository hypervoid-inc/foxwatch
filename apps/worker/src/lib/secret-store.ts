import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../env.ts";
import { envSecret } from "../env.ts";
import * as schema from "../db/schema.ts";

const VALUES_KEY = "secret_values";
const NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
export const MAX_SECRET_VALUE = 8192;

export function parseStoredSecrets(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!NAME_RE.test(name) || typeof value !== "string" || !value) continue;
      if (value.length > MAX_SECRET_VALUE) continue;
      out[name] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function resolveSecretValue(
  stored: Record<string, string>,
  name: string,
  envValue?: string,
): string | undefined {
  const local = stored[name];
  if (local) return local;
  if (envValue) return envValue;
  return undefined;
}

export async function loadStoredSecrets(env: Env): Promise<Record<string, string>> {
  try {
    const db = drizzle(env.DB, { schema });
    const rows = await db.select().from(schema.siteSettings).where(eq(schema.siteSettings.key, VALUES_KEY));
    if (rows[0]) return parseStoredSecrets(rows[0].valueJson);
  } catch {
    /* schema may not exist yet */
  }
  return {};
}

export async function saveStoredSecret(env: Env, name: string, value: string): Promise<void> {
  if (!NAME_RE.test(name)) throw new Error("name");
  if (!value || value.length > MAX_SECRET_VALUE) throw new Error("secret");
  const current = await loadStoredSecrets(env);
  current[name] = value;
  const db = drizzle(env.DB, { schema });
  await db
    .insert(schema.siteSettings)
    .values({ key: VALUES_KEY, valueJson: JSON.stringify(current) })
    .onConflictDoUpdate({ target: schema.siteSettings.key, set: { valueJson: JSON.stringify(current) } });
}

export async function deleteStoredSecret(env: Env, name: string): Promise<void> {
  const current = await loadStoredSecrets(env);
  if (!(name in current)) return;
  delete current[name];
  const db = drizzle(env.DB, { schema });
  await db
    .insert(schema.siteSettings)
    .values({ key: VALUES_KEY, valueJson: JSON.stringify(current) })
    .onConflictDoUpdate({ target: schema.siteSettings.key, set: { valueJson: JSON.stringify(current) } });
}

export async function loadSecretMap(env: Env, names: string[]): Promise<Record<string, string | undefined>> {
  const stored = await loadStoredSecrets(env);
  const out: Record<string, string | undefined> = {};
  for (const name of names) {
    out[name] = resolveSecretValue(stored, name, envSecret(env, name));
  }
  return out;
}

export async function resolveSecret(env: Env, name: string): Promise<string | undefined> {
  const map = await loadSecretMap(env, [name]);
  return map[name];
}
