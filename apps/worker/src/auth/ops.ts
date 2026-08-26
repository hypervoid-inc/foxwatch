import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../env.ts";
import * as schema from "../db/schema.ts";
import { sha256Hex } from "../lib/crypto.ts";

export type OpsRole = "superadmin" | "admin";

export type OpsActor = { actor: string; userId: string; role: OpsRole };

const COOKIE = "foxwatch_ops";
export const SESSION_MS = 12 * 60 * 60 * 1000;

function cookieValue(request: Request): string | null {
  const header = request.headers.get("Cookie") ?? "";
  const parts = header.split(";").map((p) => p.trim());
  for (const p of parts) {
    if (p.startsWith(`${COOKIE}=`)) return decodeURIComponent(p.slice(COOKIE.length + 1));
  }
  return null;
}

export function sessionTokenFromRequest(request: Request): string {
  const header = request.headers.get("Authorization");
  const bearer = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  return bearer || cookieValue(request) || "";
}

export function opsCookie(token: string, request: Request): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${SESSION_MS / 1000}`;
}

export function clearOpsCookie(request: Request): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=0`;
}

export async function authorizeOps(request: Request, env: Env): Promise<OpsActor | null> {
  const provided = sessionTokenFromRequest(request);
  if (!provided) return null;
  try {
    const tokenHash = await sha256Hex(provided);
    const db = drizzle(env.DB, { schema });
    const session = (await db.select().from(schema.opsSessions).where(eq(schema.opsSessions.tokenHash, tokenHash)))[0];
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      await db.delete(schema.opsSessions).where(eq(schema.opsSessions.id, session.id));
      return null;
    }
    const user = (await db.select().from(schema.opsUsers).where(eq(schema.opsUsers.id, session.userId)))[0];
    if (!user || (user.role !== "superadmin" && user.role !== "admin")) return null;
    return { actor: user.email, userId: user.id, role: user.role };
  } catch {
    return null;
  }
}

export function csrfOk(request: Request): boolean {
  if (request.method === "GET" || request.method === "HEAD") return true;
  const origin = request.headers.get("Origin");
  if (!origin) {
    const site = request.headers.get("Sec-Fetch-Site");
    return site === "same-origin" || site === "none" || site == null;
  }
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export function isOpenOpsPath(path: string, method: string): boolean {
  if (path === "/api/ops/auth" && method === "GET") return true;
  if (path === "/api/ops/setup" && method === "POST") return true;
  if (path === "/api/ops/session" && (method === "POST" || method === "DELETE")) return true;
  return false;
}
