import { sanitizeText } from "@foxwatch/engine";
import type { Env } from "../env.ts";
import { newId, randomToken, sha256Hex } from "../lib/crypto.ts";
import type { OpsActor } from "./ops.ts";

/** Every API token starts with this, so a leaked one is easy to recognise and scan for. */
export const TOKEN_PREFIX = "fxw_";
export const TOKEN_DEFAULT_DAYS = 90;
export const TOKEN_MAX_DAYS = 365;
/** Live tokens one operator may hold. */
export const TOKEN_MAX_ACTIVE = 20;
const DAY_MS = 86_400_000;
/** last_used_at is written at most this often per token. */
const LAST_USED_EVERY_MS = 60_000;

export type ApiToken = {
  id: string;
  name: string;
  userId: string;
  email: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
};

export function isApiToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX);
}

/**
 * The operator behind an API token. A token acts as its owner but never above
 * the admin role, so it cannot register secrets, attach one to a new request,
 * or manage operators. Null for an unknown, revoked or expired token, and for
 * one whose owner was removed.
 */
export async function actorFromApiToken(env: Env, provided: string, now = Date.now()): Promise<OpsActor | null> {
  const row = await env.DB.prepare(
    `SELECT t.id, t.name, t.expires_at, t.revoked_at, t.last_used_at, u.id AS user_id, u.email, u.role
     FROM ops_tokens t JOIN ops_users u ON u.id = t.user_id
     WHERE t.token_hash = ?`,
  )
    .bind(await sha256Hex(provided))
    .first<{
      id: string;
      name: string;
      expires_at: number;
      revoked_at: number | null;
      last_used_at: number | null;
      user_id: string;
      email: string;
      role: string;
    }>();
  if (!row || row.revoked_at != null || row.expires_at <= now) return null;
  if (row.role !== "superadmin" && row.role !== "admin") return null;
  if (row.last_used_at == null || now - row.last_used_at >= LAST_USED_EVERY_MS) {
    await env.DB.prepare("UPDATE ops_tokens SET last_used_at = ?1 WHERE id = ?2 AND (last_used_at IS NULL OR last_used_at <= ?3)")
      .bind(now, row.id, now - LAST_USED_EVERY_MS)
      .run();
  }
  return { actor: `${row.email} via ${row.name}`, userId: row.user_id, role: "admin", tokenId: row.id };
}

/** An operator's live tokens, or everyone's for a superadmin, newest first. Revoked tokens are left out. */
export async function listApiTokens(env: Env, actor: OpsActor): Promise<ApiToken[]> {
  const all = actor.role === "superadmin";
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.name, t.user_id, u.email, t.created_at, t.expires_at, t.last_used_at
     FROM ops_tokens t JOIN ops_users u ON u.id = t.user_id
     WHERE t.revoked_at IS NULL AND (?1 = 1 OR t.user_id = ?2)
     ORDER BY t.created_at DESC`,
  )
    .bind(all ? 1 : 0, actor.userId)
    .all<{ id: string; name: string; user_id: string; email: string; created_at: number; expires_at: number; last_used_at: number | null }>();
  return results.map((row) => ({
    id: row.id,
    name: row.name,
    userId: row.user_id,
    email: row.email,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
  }));
}

export async function createApiToken(
  env: Env,
  actor: OpsActor,
  nameRaw: unknown,
  daysRaw: unknown,
  now = Date.now(),
): Promise<{ ok: true; token: string; apiToken: ApiToken } | { ok: false; error: "token_name" | "token_days" | "token_quota" }> {
  const name = sanitizeText(typeof nameRaw === "string" ? nameRaw : "", 80);
  if (!name) return { ok: false, error: "token_name" };
  const days = daysRaw == null ? TOKEN_DEFAULT_DAYS : Number(daysRaw);
  if (!Number.isInteger(days) || days < 1 || days > TOKEN_MAX_DAYS) return { ok: false, error: "token_days" };
  const live = await env.DB.prepare("SELECT COUNT(*) AS n FROM ops_tokens WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?")
    .bind(actor.userId, now)
    .first<number>("n");
  if ((live ?? 0) >= TOKEN_MAX_ACTIVE) return { ok: false, error: "token_quota" };
  const token = `${TOKEN_PREFIX}${randomToken()}`;
  const apiToken: ApiToken = {
    id: newId(),
    name,
    userId: actor.userId,
    email: actor.actor,
    createdAt: now,
    expiresAt: now + days * DAY_MS,
    lastUsedAt: null,
  };
  await env.DB.prepare(
    `INSERT INTO ops_tokens (id, user_id, name, role, token_hash, created_at, expires_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, 'admin', ?, ?, ?, NULL, NULL)`,
  )
    .bind(apiToken.id, actor.userId, name, await sha256Hex(token), now, apiToken.expiresAt)
    .run();
  return { ok: true, token, apiToken };
}

/** An operator revokes their own tokens; a superadmin revokes anyone's. */
export async function revokeApiToken(
  env: Env,
  actor: OpsActor,
  id: string,
  now = Date.now(),
): Promise<{ ok: true; name: string; userId: string } | { ok: false; error: "not_found" }> {
  const row = await env.DB.prepare("SELECT user_id, name FROM ops_tokens WHERE id = ? AND revoked_at IS NULL")
    .bind(id)
    .first<{ user_id: string; name: string }>();
  // Someone else's token reads as missing, so ids cannot be probed.
  if (!row || (row.user_id !== actor.userId && actor.role !== "superadmin")) return { ok: false, error: "not_found" };
  await env.DB.prepare("UPDATE ops_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, id).run();
  return { ok: true, name: row.name, userId: row.user_id };
}
