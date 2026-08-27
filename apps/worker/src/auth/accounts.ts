import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../env.ts";
import * as schema from "../db/schema.ts";
import { newId, randomToken, sha256Hex } from "../lib/crypto.ts";
import { dummyPasswordHash, hashPassword, parseEmail, parsePassword, verifyPassword } from "./password.ts";
import { SESSION_MS, type OpsActor, type OpsRole } from "./ops.ts";

export type PublicUser = { id: string; email: string; role: OpsRole; createdAt: number };

const LOGIN_LIMIT = 8;
const LOGIN_WINDOW_MS = 15 * 60_000;

export async function needsSetup(env: Env): Promise<boolean> {
  try {
    const db = drizzle(env.DB, { schema });
    const rows = await db.select({ id: schema.opsUsers.id }).from(schema.opsUsers).limit(1);
    return rows.length === 0;
  } catch {
    return true;
  }
}

export async function createSession(env: Env, userId: string): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  const db = drizzle(env.DB, { schema });
  await db.insert(schema.opsSessions).values({
    id: newId(),
    userId,
    tokenHash: await sha256Hex(token),
    createdAt: now,
    expiresAt: now + SESSION_MS,
  });
  return token;
}

export async function revokeSession(env: Env, token: string): Promise<void> {
  if (!token) return;
  const db = drizzle(env.DB, { schema });
  await db.delete(schema.opsSessions).where(eq(schema.opsSessions.tokenHash, await sha256Hex(token)));
}

async function throttled(env: Env, key: string): Promise<boolean> {
  const now = Date.now();
  const db = drizzle(env.DB, { schema });
  const row = (await db.select().from(schema.opsAuthThrottle).where(eq(schema.opsAuthThrottle.key, key)))[0];
  if (!row || row.resetAt <= now) {
    await db
      .insert(schema.opsAuthThrottle)
      .values({ key, count: 1, resetAt: now + LOGIN_WINDOW_MS })
      .onConflictDoUpdate({
        target: schema.opsAuthThrottle.key,
        set: { count: 1, resetAt: now + LOGIN_WINDOW_MS },
      });
    return false;
  }
  if (row.count >= LOGIN_LIMIT) return true;
  await db
    .update(schema.opsAuthThrottle)
    .set({ count: row.count + 1 })
    .where(eq(schema.opsAuthThrottle.key, key));
  return false;
}

async function clearThrottle(env: Env, key: string): Promise<void> {
  const db = drizzle(env.DB, { schema });
  await db.delete(schema.opsAuthThrottle).where(eq(schema.opsAuthThrottle.key, key));
}

export async function setupFirstUser(
  env: Env,
  emailRaw: unknown,
  passwordRaw: unknown,
): Promise<{ ok: true; token: string; user: PublicUser } | { ok: false; error: "exists" | "invalid_email" | "invalid_password" }> {
  const email = parseEmail(emailRaw);
  const password = parsePassword(passwordRaw);
  if (!email) return { ok: false, error: "invalid_email" };
  if (!password) return { ok: false, error: "invalid_password" };
  if (!(await needsSetup(env))) return { ok: false, error: "exists" };

  const userId = newId();
  const sessionId = newId();
  const token = randomToken();
  const now = Date.now();
  const passwordHash = await hashPassword(password);
  const tokenHash = await sha256Hex(token);

  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").bind("ops_bootstrapped", userId),
      env.DB.prepare(
        "INSERT INTO ops_users (id, email, password_hash, role, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(userId, email, passwordHash, "superadmin", now, "setup"),
      env.DB.prepare("INSERT INTO ops_sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").bind(
        sessionId,
        userId,
        tokenHash,
        now,
        now + SESSION_MS,
      ),
    ]);
  } catch {
    return { ok: false, error: "exists" };
  }

  return { ok: true, token, user: { id: userId, email, role: "superadmin", createdAt: now } };
}

export async function loginUser(
  env: Env,
  emailRaw: unknown,
  passwordRaw: unknown,
  ip: string,
): Promise<{ ok: true; token: string; user: PublicUser } | { ok: false; error: "credentials" | "rate" | "setup" }> {
  if (await needsSetup(env)) return { ok: false, error: "setup" };
  const email = parseEmail(emailRaw);
  const password = typeof passwordRaw === "string" ? passwordRaw : "";
  if (!email || password.length < 1 || password.length > 128) return { ok: false, error: "credentials" };

  const emailKey = `login:${email}`;
  const ipKey = `login-ip:${ip || "unknown"}`;
  if ((await throttled(env, emailKey)) || (await throttled(env, ipKey))) return { ok: false, error: "rate" };

  const db = drizzle(env.DB, { schema });
  const user = (await db.select().from(schema.opsUsers).where(eq(schema.opsUsers.email, email)))[0];
  const hash = user?.passwordHash ?? (await dummyPasswordHash());
  const matches = await verifyPassword(password, hash);
  if (!user || !matches) return { ok: false, error: "credentials" };

  await clearThrottle(env, emailKey);
  await clearThrottle(env, ipKey);
  const token = await createSession(env, user.id);
  return {
    ok: true,
    token,
    user: { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt },
  };
}

export async function listOperators(env: Env): Promise<PublicUser[]> {
  const db = drizzle(env.DB, { schema });
  const rows = await db.select().from(schema.opsUsers);
  return rows
    .map((u) => ({ id: u.id, email: u.email, role: u.role, createdAt: u.createdAt }))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function createOperator(
  env: Env,
  actor: OpsActor,
  emailRaw: unknown,
  passwordRaw: unknown,
  roleRaw: unknown,
): Promise<{ ok: true; user: PublicUser } | { ok: false; error: "forbidden" | "invalid_email" | "invalid_password" | "invalid_role" | "exists" }> {
  if (actor.role !== "superadmin") return { ok: false, error: "forbidden" };
  const email = parseEmail(emailRaw);
  const password = parsePassword(passwordRaw);
  const role: OpsRole = roleRaw === "superadmin" ? "superadmin" : roleRaw === "admin" ? "admin" : "admin";
  if (!email) return { ok: false, error: "invalid_email" };
  if (!password) return { ok: false, error: "invalid_password" };
  if (roleRaw != null && roleRaw !== "admin" && roleRaw !== "superadmin") return { ok: false, error: "invalid_role" };

  const db = drizzle(env.DB, { schema });
  const existing = (await db.select({ id: schema.opsUsers.id }).from(schema.opsUsers).where(eq(schema.opsUsers.email, email)))[0];
  if (existing) return { ok: false, error: "exists" };

  const now = Date.now();
  const user: PublicUser = { id: newId(), email, role, createdAt: now };
  try {
    await db.insert(schema.opsUsers).values({
      id: user.id,
      email,
      passwordHash: await hashPassword(password),
      role,
      createdAt: now,
      createdBy: actor.userId,
    });
  } catch {
    return { ok: false, error: "exists" };
  }
  return { ok: true, user };
}

export async function deleteOperator(
  env: Env,
  actor: OpsActor,
  id: string,
): Promise<{ ok: true } | { ok: false; error: "forbidden" | "self" | "last_superadmin" | "not_found" }> {
  if (actor.role !== "superadmin") return { ok: false, error: "forbidden" };
  if (id === actor.userId) return { ok: false, error: "self" };
  const db = drizzle(env.DB, { schema });
  const user = (await db.select().from(schema.opsUsers).where(eq(schema.opsUsers.id, id)))[0];
  if (!user) return { ok: false, error: "not_found" };
  if (user.role === "superadmin") {
    const supers = (await db.select().from(schema.opsUsers)).filter((u) => u.role === "superadmin");
    if (supers.length <= 1) return { ok: false, error: "last_superadmin" };
  }
  await db.delete(schema.opsSessions).where(eq(schema.opsSessions.userId, id));
  await db.delete(schema.opsUsers).where(eq(schema.opsUsers.id, id));
  return { ok: true };
}

export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "local";
}
