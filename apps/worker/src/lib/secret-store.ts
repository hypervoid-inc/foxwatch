import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../env.ts";
import { envSecret } from "../env.ts";
import * as schema from "../db/schema.ts";
import { isResolvableSecret } from "./secret-policy.ts";

// Reads the registry straight from the settings row: snapshot.ts pulls in
// Durable Object modules that alert delivery and its tests do not need.
async function registeredSecretNames(env: Env): Promise<string[]> {
  // A failed read throws so the run or delivery is retried, not recorded as a missing secret.
  const db = drizzle(env.DB, { schema });
  const rows = await db.select().from(schema.siteSettings).where(eq(schema.siteSettings.key, "settings"));
  try {
    const parsed = JSON.parse(rows[0]?.valueJson ?? "{}") as { secrets?: unknown };
    return Array.isArray(parsed.secrets) ? parsed.secrets.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

export async function loadSecretMap(env: Env, names: string[]): Promise<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  if (names.length === 0) return out;
  // Only names registered in admin resolve. Any other Worker binding stays
  // unreadable even if a stored check or channel refers to it.
  const registered = await registeredSecretNames(env);
  for (const name of names) {
    out[name] = isResolvableSecret(name, registered) ? envSecret(env, name) : undefined;
  }
  return out;
}

export async function resolveSecret(env: Env, name: string): Promise<string | undefined> {
  return (await loadSecretMap(env, [name]))[name];
}
