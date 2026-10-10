import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../env.ts";
import * as schema from "../db/schema.ts";
import { newId, randomToken, sha256Hex, tokenEquals } from "../lib/crypto.ts";
import { dummyPasswordHash, hashPassword, parseEmail, parsePassword, passwordNeedsRehash, verifyPassword } from "./password.ts";
import { SESSION_MS, type OpsActor, type OpsRole } from "./ops.ts";

export type PublicUser = { id: string; email: string; role: OpsRole; createdAt: number };

const LOGIN_WINDOW_MS = 15 * 60_000;
// Failed sign-ins allowed per window. The network-and-account limit is the one
// a person meets. The address limit bounds what one client can spray across
// accounts. The account-wide limit never blocks by itself, or a stranger who
// knows an operator's email could spend it and keep the right password out:
// past it, each network is cut to the guarded allowance for that account. That
// trades a fixed ceiling on a widely distributed guess for an operator who can
// always sign in from a network the guesses are not coming from.
const LOGIN_PAIR_LIMIT = 8;
const LOGIN_GUARDED_PAIR_LIMIT = 3;
const LOGIN_IP_LIMIT = 40;
const LOGIN_EMAIL_LIMIT = 200;
// Audit rows a signed-out caller can cause, per limit kind.
const THROTTLE_AUDIT_WINDOW_MS = 60 * 60_000;
const THROTTLE_AUDIT_LIMIT = 3;
const SETUP_LIMIT = 8;
// Wrong current passwords allowed per window when changing a password. The
// per-session limit is the one that blocks. The account-wide one never blocks
// by itself, or a stolen session could spend it and keep the owner from
// rotating: past it, each session is cut to the guarded allowance.
const PASSWORD_SESSION_LIMIT = 8;
const PASSWORD_GUARDED_SESSION_LIMIT = 3;
const PASSWORD_USER_LIMIT = 40;

export type ThrottleScope = "ip" | "pair" | "email";
/** A sign-in limit crossed by this request, for the audit log. */
export type LoginTrip = { scope: ThrottleScope; email: string };

export const AUDIT_RETENTION_MS = 365 * 86_400_000;

/** A database error propagates: "could not tell" must never read as "no accounts yet". */
export async function needsSetup(env: Env): Promise<boolean> {
  const db = drizzle(env.DB, { schema });
  const rows = await db.select({ id: schema.opsUsers.id }).from(schema.opsUsers).limit(1);
  return rows.length === 0;
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

/**
 * Throttle bucket for a client address. An IPv6 client holds a whole /64, so
 * that counts as one. Three groups give the /48 a home or tunnel allocation is
 * cut from, for limits that rotating through its /64s must not multiply.
 */
export function throttleBucket(ip: string, prefixGroups: 3 | 4 = 4): string {
  const value = ip.trim().toLowerCase().slice(0, 64) || "unknown";
  if (!value.includes(":") || value.includes(".")) return value;
  const [head = "", tail] = value.split("::");
  const before = head ? head.split(":") : [];
  const after = tail ? tail.split(":") : [];
  const groups =
    tail === undefined ? before : [...before, ...Array<string>(Math.max(0, 8 - before.length - after.length)).fill("0"), ...after];
  return `${groups.slice(0, prefixGroups).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/${prefixGroups * 16}`;
}

/**
 * Counts one attempt against a key and returns the new count. One statement,
 * so parallel requests each see a different count instead of the same stale read.
 */
async function bumpThrottle(env: Env, key: string, now: number, windowMs = LOGIN_WINDOW_MS): Promise<number> {
  const count = await env.DB.prepare(
    `INSERT INTO ops_auth_throttle (key, count, reset_at) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN reset_at <= ?3 THEN 1 ELSE count + 1 END,
       reset_at = CASE WHEN reset_at <= ?3 THEN ?2 ELSE reset_at END
     RETURNING count`,
  )
    .bind(key, now + windowMs, now)
    .first<number>("count");
  return count ?? 1;
}

function loginKeys(email: string, ip: string): Record<ThrottleScope, string> {
  return {
    ip: `login-ip:${throttleBucket(ip)}`,
    pair: `login-pair:${throttleBucket(ip, 3)}|${email}`,
    email: `login:${email}`,
  };
}

/**
 * Reserves an attempt before the password is checked. The address is counted
 * first, so a limited client stops there and cannot add a row per email it
 * invents; a network over its limit for one account stops before the
 * account-wide count, so it cannot spend that either.
 * `tripped` names the limit this one request crossed, blocked or not.
 */
async function reserveLoginAttempt(
  env: Env,
  email: string,
  ip: string,
  now: number,
): Promise<{ blocked: ThrottleScope | null; tripped: ThrottleScope | null }> {
  const keys = loginKeys(email, ip);
  const fromAddress = await bumpThrottle(env, keys.ip, now);
  if (fromAddress > LOGIN_IP_LIMIT) return { blocked: "ip", tripped: fromAddress === LOGIN_IP_LIMIT + 1 ? "ip" : null };
  const fromNetwork = await bumpThrottle(env, keys.pair, now);
  if (fromNetwork > LOGIN_PAIR_LIMIT) return { blocked: "pair", tripped: fromNetwork === LOGIN_PAIR_LIMIT + 1 ? "pair" : null };
  const forAccount = await bumpThrottle(env, keys.email, now);
  return {
    blocked: forAccount > LOGIN_EMAIL_LIMIT && fromNetwork > LOGIN_GUARDED_PAIR_LIMIT ? "email" : null,
    tripped: forAccount === LOGIN_EMAIL_LIMIT + 1 ? "email" : null,
  };
}

/**
 * Whether a limit trip may be written to the audit log. Those rows come from
 * signed-out callers and are kept far longer than the throttle rows, so they
 * are capped per kind of limit, not per key the caller can vary.
 */
export async function reserveThrottleAudit(env: Env, scope: ThrottleScope): Promise<boolean> {
  const count = await bumpThrottle(env, `audit:login-throttled:${scope}`, Date.now(), THROTTLE_AUDIT_WINDOW_MS);
  return count <= THROTTLE_AUDIT_LIMIT;
}

/** A successful sign-in was not a failed attempt: clear this network's count for the account and hand the others back. */
async function refundLoginAttempt(env: Env, email: string, ip: string): Promise<void> {
  const keys = loginKeys(email, ip);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ops_auth_throttle WHERE key = ?").bind(keys.pair),
    env.DB.prepare("UPDATE ops_auth_throttle SET count = MAX(count - 1, 0) WHERE key IN (?, ?)").bind(keys.ip, keys.email),
  ]);
}

/**
 * Removes rows nothing reads again: throttle windows that have ended, sessions
 * past expiry (a browser drops the cookie at the same moment, so the token is
 * never presented again), and audit entries older than the retention period.
 */
export async function pruneAuthTables(env: Env, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ops_auth_throttle WHERE reset_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM ops_sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM audit_log WHERE created_at < ?").bind(now - AUDIT_RETENTION_MS),
  ]);
}

/** True when the deploy owner set FOXWATCH_SETUP_TOKEN, so first-account setup must present it. */
export function setupTokenRequired(env: Env): boolean {
  return Boolean(env.FOXWATCH_SETUP_TOKEN?.trim());
}

export async function setupFirstUser(
  env: Env,
  emailRaw: unknown,
  passwordRaw: unknown,
  setupTokenRaw?: unknown,
  ip = "",
): Promise<
  | { ok: true; token: string; user: PublicUser }
  | { ok: false; error: "exists" | "invalid_email" | "invalid_password" | "setup_token" | "rate" }
> {
  const email = parseEmail(emailRaw);
  const password = parsePassword(passwordRaw);
  if (!email) return { ok: false, error: "invalid_email" };
  if (!password) return { ok: false, error: "invalid_password" };
  if (!(await needsSetup(env))) return { ok: false, error: "exists" };
  if (setupTokenRequired(env)) {
    if ((await bumpThrottle(env, `setup-ip:${throttleBucket(ip)}`, Date.now())) > SETUP_LIMIT) return { ok: false, error: "rate" };
    const provided = typeof setupTokenRaw === "string" ? setupTokenRaw.trim() : "";
    if (!provided || !(await tokenEquals(provided, env.FOXWATCH_SETUP_TOKEN!.trim()))) return { ok: false, error: "setup_token" };
  }

  const userId = newId();
  const sessionId = newId();
  const token = randomToken();
  const now = Date.now();
  const passwordHash = await hashPassword(password);
  const tokenHash = await sha256Hex(token);

  // The users table alone decides whether setup is open, here and in needsSetup.
  // The insert is one guarded statement, so of two racing setups exactly one
  // wins, and an instance whose accounts were all removed can be claimed again.
  const [created] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ops_users (id, email, password_hash, role, created_at, created_by)
       SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM ops_users)`,
    ).bind(userId, email, passwordHash, "superadmin", now, "setup"),
    env.DB.prepare(
      `INSERT INTO ops_sessions (id, user_id, token_hash, created_at, expires_at)
       SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM ops_users WHERE id = ?2)`,
    ).bind(sessionId, userId, tokenHash, now, now + SESSION_MS),
  ]);
  if (!created?.meta.changes) return { ok: false, error: "exists" };

  return { ok: true, token, user: { id: userId, email, role: "superadmin", createdAt: now } };
}

export async function loginUser(
  env: Env,
  emailRaw: unknown,
  passwordRaw: unknown,
  ip: string,
): Promise<
  | { ok: true; token: string; user: PublicUser }
  | { ok: false; error: "credentials" | "setup"; trip?: LoginTrip }
  | { ok: false; error: "rate"; scope: ThrottleScope; trip?: LoginTrip }
> {
  if (await needsSetup(env)) return { ok: false, error: "setup" };
  const email = parseEmail(emailRaw);
  const password = typeof passwordRaw === "string" ? passwordRaw : "";
  if (!email || password.length < 1 || password.length > 128) return { ok: false, error: "credentials" };

  const { blocked, tripped } = await reserveLoginAttempt(env, email, ip, Date.now());
  const trip = tripped ? { scope: tripped, email } : undefined;
  if (blocked) return { ok: false, error: "rate", scope: blocked, trip };

  const db = drizzle(env.DB, { schema });
  const user = (await db.select().from(schema.opsUsers).where(eq(schema.opsUsers.email, email)))[0];
  const hash = user?.passwordHash ?? (await dummyPasswordHash());
  const matches = await verifyPassword(password, hash);
  if (!user || !matches) return { ok: false, error: "credentials", trip };

  await refundLoginAttempt(env, email, ip);
  if (passwordNeedsRehash(user.passwordHash)) {
    // Only now is the plaintext in hand. Guarded on the old hash, so a password
    // changed in the meantime is never overwritten.
    await env.DB.prepare("UPDATE ops_users SET password_hash = ? WHERE id = ? AND password_hash = ?")
      .bind(await hashPassword(password), user.id, user.passwordHash)
      .run();
  }
  const token = await createSession(env, user.id);
  return {
    ok: true,
    token,
    user: { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt },
  };
}

/**
 * Replaces the caller's password after re-checking the current one, and signs
 * out every other session of theirs in the same batch, so a leaked password or
 * a stolen session stops working the moment the owner rotates.
 */
export async function changeOwnPassword(
  env: Env,
  actor: OpsActor,
  currentRaw: unknown,
  nextRaw: unknown,
  keepToken: string,
): Promise<{ ok: true } | { ok: false; error: "current_password" | "invalid_password" | "rate" }> {
  const current = typeof currentRaw === "string" ? currentRaw : "";
  const next = parsePassword(nextRaw);
  if (!next) return { ok: false, error: "invalid_password" };
  if (current.length < 1 || current.length > 128) return { ok: false, error: "current_password" };

  // A hijacked session must not be a way to guess the password without limit,
  // and must not be a way to lock the owner out of rotating either. The limit
  // is counted per session, so guesses spend only that session's allowance and
  // the owner, signed in afresh, still gets through. A session over its limit
  // stops before the account-wide count, so it cannot spend that either.
  const keepHash = await sha256Hex(keepToken);
  const sessionKey = `password:${actor.userId}|${keepHash}`;
  const userKey = `password:${actor.userId}`;
  const now = Date.now();
  const fromSession = await bumpThrottle(env, sessionKey, now);
  if (fromSession > PASSWORD_SESSION_LIMIT) return { ok: false, error: "rate" };
  const forUser = await bumpThrottle(env, userKey, now);
  if (forUser > PASSWORD_USER_LIMIT && fromSession > PASSWORD_GUARDED_SESSION_LIMIT) return { ok: false, error: "rate" };

  const db = drizzle(env.DB, { schema });
  const user = (await db.select().from(schema.opsUsers).where(eq(schema.opsUsers.id, actor.userId)))[0];
  if (!user || !(await verifyPassword(current, user.passwordHash))) return { ok: false, error: "current_password" };

  await env.DB.batch([
    env.DB.prepare("UPDATE ops_users SET password_hash = ? WHERE id = ?").bind(await hashPassword(next), user.id),
    env.DB.prepare("DELETE FROM ops_sessions WHERE user_id = ? AND token_hash != ?").bind(user.id, keepHash),
    env.DB.prepare("DELETE FROM ops_auth_throttle WHERE key IN (?, ?)").bind(sessionKey, userKey),
  ]);
  return { ok: true };
}

export async function listOperators(env: Env): Promise<PublicUser[]> {
  const db = drizzle(env.DB, { schema });
  const rows = await db.select().from(schema.opsUsers);
  return rows
    .map((u) => ({ id: u.id, email: u.email, role: u.role, createdAt: u.createdAt }))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** drizzle wraps the D1 error, so the constraint message is on the cause. */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if (e.message.includes("UNIQUE constraint failed")) return true;
  }
  return false;
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
  } catch (err) {
    // Lost a race with another create for the same email. Anything else is a real failure.
    if (!isUniqueViolation(err)) throw err;
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
  // The last-superadmin rule is part of the delete itself, so two superadmins
  // removing each other at the same moment cannot both succeed and empty the role.
  const [removed] = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM ops_users WHERE id = ?1
       AND (role != 'superadmin' OR (SELECT COUNT(*) FROM ops_users WHERE role = 'superadmin') > 1)`,
    ).bind(id),
    env.DB.prepare("DELETE FROM ops_sessions WHERE user_id = ?1 AND NOT EXISTS (SELECT 1 FROM ops_users WHERE id = ?1)").bind(id),
  ]);
  if (!removed?.meta.changes) return { ok: false, error: user.role === "superadmin" ? "last_superadmin" : "not_found" };
  return { ok: true };
}

export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "local";
}
