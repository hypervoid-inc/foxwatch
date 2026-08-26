import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, desc, eq, lt, or } from "drizzle-orm";
import {
  ID_RE,
  MAX_MONITORS,
  MIN_INTERVAL_MS,
  MAX_TIMEOUT_MS,
  MAX_REGIONS,
  type Check,
  type HttpCheck,
  http,
  heartbeat,
  secretName,
} from "@foxwatch/config";
import { sanitizeText, parseHomepageUrl } from "@foxwatch/engine";
import type { Env } from "./env.ts";
import { envSecret } from "./env.ts";
import * as schema from "./db/schema.ts";
import { authorizeOps, clearOpsCookie, csrfOk, isOpenOpsPath, opsCookie, sessionTokenFromRequest, type OpsRole } from "./auth/ops.ts";
import { readSnapshot, publishSnapshot, loadSettings, saveSettings, rememberSecretNames, loadIcon, saveIcon, deleteIcon } from "./lib/snapshot.ts";
import { deleteStoredSecret, loadStoredSecrets, saveStoredSecret } from "./lib/secret-store.ts";
import { renderBadge, renderFeed, renderPublicHtml } from "./lib/public-html.ts";
import { sha256Hex, randomToken, newId } from "./lib/crypto.ts";
import { auditPageFromRows, parseAuditCursor, parseAuditLimit } from "./lib/audit-page.ts";
import { monitorStub } from "./do/monitor.ts";
import {
  clientIp,
  createOperator,
  deleteOperator,
  listOperators,
  loginUser,
  needsSetup,
  revokeSession,
  setupFirstUser,
} from "./auth/accounts.ts";

const PUBLIC_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "cache-control": "public, max-age=15",
};

const OPS_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
};

export const app = new Hono<{ Bindings: Env; Variables: { actor: string; opsRole: OpsRole; opsUserId: string } }>();

app.use("*", async (c, next) => {
  await next();
  if (c.req.path.startsWith("/admin") || c.req.path.startsWith("/ops") || c.req.path.startsWith("/api/ops")) {
    for (const [k, v] of Object.entries(OPS_HEADERS)) c.header(k, v);
  } else if (!c.req.path.startsWith("/assets")) {
    for (const [k, v] of Object.entries(PUBLIC_HEADERS)) c.header(k, v);
  }
});

app.get("/", async (c) => {
  const snap = await readSnapshot(c.env);
  return c.html(renderPublicHtml(snap), 200, PUBLIC_HEADERS);
});

app.get("/api/status.json", async (c) => {
  const snap = await readSnapshot(c.env);
  c.header("access-control-allow-origin", "*");
  return c.json(snap);
});

app.get("/badge.svg", async (c) => {
  const snap = await readSnapshot(c.env);
  return new Response(renderBadge(snap), {
    headers: { "content-type": "image/svg+xml; charset=utf-8", ...PUBLIC_HEADERS },
  });
});

app.get("/feed.xml", async (c) => {
  const snap = await readSnapshot(c.env);
  return new Response(renderFeed(snap, new URL(c.req.url).origin), {
    headers: { "content-type": "application/rss+xml; charset=utf-8", ...PUBLIC_HEADERS },
  });
});

app.get("/icon", async (c) => {
  const icon = await loadIcon(c.env);
  if (!icon) return c.body(null, 404);
  return new Response(icon.bytes, {
    headers: {
      "content-type": icon.mime,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
});

app.post("/api/heartbeat", async (c) => {
  const ct = c.req.header("content-type") ?? "";
  let token = "";
  const auth = c.req.header("Authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) token = auth.slice(7).trim();
  if (!token && ct.includes("application/json")) {
    const body = (await c.req.json().catch(() => null)) as { token?: string } | null;
    token = body?.token?.trim() ?? "";
  }
  if (!token || token.length > 256) return c.body(null, 404);
  const hash = await sha256Hex(token);
  const db = drizzle(c.env.DB, { schema });
  const rows = await db.select().from(schema.heartbeats).where(eq(schema.heartbeats.tokenHash, hash));
  const row = rows[0];
  if (!row) return c.body(null, 404);
  const now = Date.now();
  if (row.lastPingAt && now - row.lastPingAt < 1000) return c.body(null, 429);
  await db.update(schema.heartbeats).set({ lastPingAt: now }).where(eq(schema.heartbeats.monitorId, row.monitorId));
  return c.json({ ok: true });
});

app.get("/api/ops/auth", async (c) => {
  const setup = await needsSetup(c.env);
  const actor = await authorizeOps(c.req.raw, c.env);
  return c.json({
    setup,
    me: actor ? { id: actor.userId, email: actor.actor, role: actor.role } : null,
  });
});

app.post("/api/ops/setup", async (c) => {
  if (!csrfOk(c.req.raw)) return c.json({ error: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
  const result = await setupFirstUser(c.env, body?.email, body?.password);
  if (!result.ok) return c.json({ error: result.error }, result.error === "exists" ? 409 : 400);
  c.header("set-cookie", opsCookie(result.token, c.req.raw));
  await audit(c.env, result.user.email, "setup-superadmin", undefined, { id: result.user.id });
  return c.json({ ok: true, me: result.user });
});

app.post("/api/ops/session", async (c) => {
  if (!csrfOk(c.req.raw)) return c.json({ error: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
  const result = await loginUser(c.env, body?.email, body?.password, clientIp(c.req.raw));
  if (!result.ok) {
    const status = result.error === "rate" ? 429 : result.error === "setup" ? 409 : 401;
    return c.json({ error: result.error }, status);
  }
  c.header("set-cookie", opsCookie(result.token, c.req.raw));
  await audit(c.env, result.user.email, "login");
  return c.json({ ok: true, me: result.user });
});

app.delete("/api/ops/session", async (c) => {
  if (!csrfOk(c.req.raw)) return c.json({ error: "forbidden" }, 403);
  await revokeSession(c.env, sessionTokenFromRequest(c.req.raw));
  c.header("set-cookie", clearOpsCookie(c.req.raw));
  return c.json({ ok: true });
});

app.use("/api/ops/*", async (c, next) => {
  if (isOpenOpsPath(c.req.path, c.req.method)) return next();
  if (!csrfOk(c.req.raw)) return c.json({ error: "forbidden" }, 403);
  const actor = await authorizeOps(c.req.raw, c.env);
  if (!actor) return c.json({ error: "auth" }, 401);
  c.set("actor", actor.actor);
  c.set("opsRole", actor.role);
  c.set("opsUserId", actor.userId);
  await next();
});

function actorOf(c: { get: (k: "actor") => string }): string {
  return c.get("actor") ?? "unknown";
}

function opsActorOf(c: { get: (k: "actor" | "opsRole" | "opsUserId") => string }): {
  actor: string;
  userId: string;
  role: OpsRole;
} {
  return { actor: c.get("actor"), userId: c.get("opsUserId"), role: c.get("opsRole") as OpsRole };
}

async function audit(env: Env, actor: string, action: string, monitorId?: string, meta?: unknown) {
  const db = drizzle(env.DB, { schema });
  await db.insert(schema.auditLog).values({
    id: newId(),
    actor,
    action,
    monitorId: monitorId ?? null,
    metaJson: meta ? JSON.stringify(meta) : null,
    createdAt: Date.now(),
  });
}

app.get("/api/ops/overview", async (c) => {
  const snap = await readSnapshot(c.env);
  const db = drizzle(c.env.DB, { schema });
  const monitors = await db.select().from(schema.monitors);
  const latest = await db.select().from(schema.checkLatest);
  const me = opsActorOf(c);
  return c.json({
    snapshot: snap,
    me: { id: me.userId, email: me.actor, role: me.role },
    monitors: monitors.map((m) => ({
      id: m.id,
      origin: m.origin,
      drifted: m.drifted === 1,
      type: m.type,
      name: m.name,
      groupId: m.groupId,
      groupName: m.groupName,
      componentId: m.componentId,
      componentName: m.componentName,
      critical: m.critical === 1,
      mutedUntil: m.mutedUntil,
      config: JSON.parse(m.configJson) as Check,
      latest: latest.filter((l) => l.monitorId === m.id),
    })),
  });
});

app.get("/api/ops/users", async (c) => {
  if (opsActorOf(c).role !== "superadmin") return c.json({ error: "forbidden" }, 403);
  return c.json({ users: await listOperators(c.env) });
});

app.post("/api/ops/users", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: unknown; password?: unknown; role?: unknown };
  const result = await createOperator(c.env, opsActorOf(c), body.email, body.password, body.role);
  if (!result.ok) {
    const status = result.error === "forbidden" ? 403 : result.error === "exists" ? 409 : 400;
    return c.json({ error: result.error }, status);
  }
  await audit(c.env, actorOf(c), "create-user", undefined, { id: result.user.id, email: result.user.email, role: result.user.role });
  return c.json({ ok: true, user: result.user });
});

app.delete("/api/ops/users/:id", async (c) => {
  const result = await deleteOperator(c.env, opsActorOf(c), c.req.param("id"));
  if (!result.ok) {
    const status = result.error === "forbidden" || result.error === "self" || result.error === "last_superadmin" ? 403 : 404;
    return c.json({ error: result.error }, status);
  }
  await audit(c.env, actorOf(c), "delete-user", undefined, { id: c.req.param("id") });
  return c.json({ ok: true });
});

app.get("/api/ops/secrets", async (c) => {
  const settings = await loadSettings(c.env);
  const stored = await loadStoredSecrets(c.env);
  const names = listSecretNames(c.env, [...settings.secrets, ...Object.keys(stored)]);
  return c.json({
    names,
    secrets: names.map((name) => ({
      name,
      set: Boolean(stored[name] || envSecret(c.env, name)),
    })),
  });
});

app.post("/api/ops/secrets", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { name?: unknown; value?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim().toUpperCase() : "";
  const value = typeof body?.value === "string" ? body.value : "";
  try {
    await saveStoredSecret(c.env, name, value);
  } catch {
    return c.json({ error: "secret" }, 400);
  }
  await rememberSecretNames(c.env, [name]);
  await audit(c.env, actorOf(c), "update-secret", undefined, { name });
  return c.json({ ok: true, name });
});

app.delete("/api/ops/secrets/:name", async (c) => {
  const name = c.req.param("name").toUpperCase();
  await deleteStoredSecret(c.env, name);
  const current = await loadSettings(c.env);
  await saveSettings(c.env, { ...current, secrets: current.secrets.filter((n) => n !== name) });
  await audit(c.env, actorOf(c), "delete-secret", undefined, { name });
  return c.json({ ok: true });
});

app.get("/api/ops/settings", async (c) => {
  const settings = await loadSettings(c.env);
  return c.json({
    siteName: settings.siteName,
    secrets: settings.secrets,
    homepageUrl: settings.homepageUrl ?? "",
    iconUrl: settings.iconUpdatedAt ? `/icon?v=${settings.iconUpdatedAt}` : null,
  });
});

app.patch("/api/ops/settings", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { siteName?: unknown; secrets?: unknown; homepageUrl?: unknown };
  const current = await loadSettings(c.env);
  let homepageUrl = current.homepageUrl;
  if ("homepageUrl" in body) {
    try {
      homepageUrl = parseHomepageUrl(body.homepageUrl);
    } catch {
      return c.json({ error: "invalid_url" }, 400);
    }
  }
  const next = await saveSettings(c.env, {
    siteName: typeof body.siteName === "string" ? body.siteName : current.siteName,
    secrets: Array.isArray(body.secrets) ? body.secrets.map(String) : current.secrets,
    homepageUrl,
    iconUpdatedAt: current.iconUpdatedAt,
  });
  await audit(c.env, actorOf(c), "update-settings");
  await publishSnapshot(c.env);
  return c.json({
    siteName: next.siteName,
    secrets: next.secrets,
    homepageUrl: next.homepageUrl ?? "",
    iconUrl: next.iconUpdatedAt ? `/icon?v=${next.iconUpdatedAt}` : null,
  });
});

app.post("/api/ops/settings/icon", async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return c.json({ error: "icon" }, 400);
  try {
    const next = await saveIcon(c.env, new Uint8Array(await file.arrayBuffer()));
    await audit(c.env, actorOf(c), "update-icon");
    await publishSnapshot(c.env);
    return c.json({ iconUrl: `/icon?v=${next.iconUpdatedAt}` });
  } catch {
    return c.json({ error: "icon" }, 400);
  }
});

app.delete("/api/ops/settings/icon", async (c) => {
  await deleteIcon(c.env);
  await audit(c.env, actorOf(c), "delete-icon");
  await publishSnapshot(c.env);
  return c.json({ ok: true });
});

app.get("/api/ops/audit", async (c) => {
  const limit = parseAuditLimit(c.req.query("limit"));
  const cursor = parseAuditCursor(c.req.query("cursor"));
  if (cursor === "invalid") return c.json({ error: "invalid_cursor" }, 400);
  const db = drizzle(c.env.DB, { schema });
  const pageWhere = cursor
    ? or(
        lt(schema.auditLog.createdAt, cursor.createdAt),
        and(eq(schema.auditLog.createdAt, cursor.createdAt), lt(schema.auditLog.id, cursor.id)),
      )
    : undefined;
  const rows = await db
    .select()
    .from(schema.auditLog)
    .where(pageWhere)
    .orderBy(desc(schema.auditLog.createdAt), desc(schema.auditLog.id))
    .limit(limit + 1);
  return c.json(auditPageFromRows(rows, limit));
});

app.post("/api/ops/monitors/:id/run", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB, { schema });
  const row = (await db.select().from(schema.monitors).where(eq(schema.monitors.id, id)))[0];
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.mutedUntil != null && row.mutedUntil > Date.now()) return c.json({ ok: true, skipped: "muted" });
  await monitorStub(c.env, id).runNow();
  await audit(c.env, actorOf(c), "run-now", id);
  return c.json({ ok: true });
});

app.post("/api/ops/monitors/:id/mute", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { until?: number | null };
  const db = drizzle(c.env.DB, { schema });
  const row = (await db.select().from(schema.monitors).where(eq(schema.monitors.id, id)))[0];
  if (!row) return c.json({ error: "not_found" }, 404);
  const until = body.until == null ? null : Number(body.until);
  await db.update(schema.monitors).set({ mutedUntil: until, updatedAt: Date.now() }).where(eq(schema.monitors.id, id));
  await audit(c.env, actorOf(c), until ? "mute" : "unmute", id);
  return c.json({ ok: true });
});

app.post("/api/ops/heartbeats/:id/rotate", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB, { schema });
  const monitor = (await db.select().from(schema.monitors).where(eq(schema.monitors.id, id)))[0];
  if (!monitor || monitor.type !== "heartbeat") return c.json({ error: "not_found" }, 404);
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const existing = (await db.select().from(schema.heartbeats).where(eq(schema.heartbeats.monitorId, id)))[0];
  if (existing) {
    await db.update(schema.heartbeats).set({ tokenHash, lastPingAt: null }).where(eq(schema.heartbeats.monitorId, id));
  } else {
    await db.insert(schema.heartbeats).values({ monitorId: id, tokenHash, lastPingAt: null, createdAt: now });
  }
  await audit(c.env, actorOf(c), "rotate-heartbeat", id);
  return c.json({ token, curl: `curl -X POST ${new URL(c.req.url).origin}/api/heartbeat -H 'Authorization: Bearer ${token}'` });
});

app.post("/api/ops/monitors", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const count = (await db.select().from(schema.monitors)).length;
  if (count >= MAX_MONITORS) return c.json({ error: "quota" }, 400);
  const body = (await c.req.json()) as Record<string, unknown>;
  const id = String(body.id ?? "");
  if (!ID_RE.test(id)) return c.json({ error: "invalid_id" }, 400);
  const existing = (await db.select().from(schema.monitors).where(eq(schema.monitors.id, id)))[0];
  if (existing) return c.json({ error: "exists" }, 409);
  let check: Check;
  try {
    check = parseCheckInput(body);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "invalid" }, 400);
  }
  const now = Date.now();
  await db.insert(schema.monitors).values({
    id,
    origin: "ui",
    drifted: 0,
    type: check.type,
    name: String(body.name ?? id),
    groupId: String(body.groupId ?? "custom"),
    groupName: String(body.groupName ?? "Custom"),
    componentId: String(body.componentId ?? id),
    componentName: String(body.componentName ?? id),
    critical: body.critical ? 1 : 0,
    configJson: JSON.stringify(check),
    mutedUntil: null,
    consecutiveFails: 0,
    createdAt: now,
    updatedAt: now,
  });
  await rememberSecretNames(c.env, secretNamesFromCheck(check));
  await monitorStub(c.env, id).ensureAlarm("intervalMs" in check ? check.intervalMs : 60_000);
  await audit(c.env, actorOf(c), "create-monitor", id);
  await publishSnapshot(c.env);
  return c.json({ ok: true, id });
});

app.patch("/api/ops/monitors/:id", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB, { schema });
  const row = (await db.select().from(schema.monitors).where(eq(schema.monitors.id, id)))[0];
  if (!row) return c.json({ error: "not_found" }, 404);
  const body = (await c.req.json()) as Record<string, unknown>;
  const existingCheck = JSON.parse(row.configJson) as Check;
  let check: Check;
  try {
    check = parseCheckInput({ ...existingCheck, ...body, id, type: body.type ?? existingCheck.type });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "invalid" }, 400);
  }
  const drifted = row.origin === "git" ? 1 : 0;
  await db
    .update(schema.monitors)
    .set({
      name: String(body.name ?? row.name),
      groupId: String(body.groupId ?? row.groupId),
      groupName: String(body.groupName ?? row.groupName),
      componentId: String(body.componentId ?? row.componentId),
      componentName: String(body.componentName ?? row.componentName),
      critical: body.critical == null ? row.critical : body.critical ? 1 : 0,
      configJson: JSON.stringify(check),
      drifted,
      updatedAt: Date.now(),
    })
    .where(eq(schema.monitors.id, id));
  await rememberSecretNames(c.env, secretNamesFromCheck(check));
  await audit(c.env, actorOf(c), "update-monitor", id);
  await publishSnapshot(c.env);
  return c.json({ ok: true, drifted: drifted === 1 });
});

app.delete("/api/ops/monitors/:id", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB, { schema });
  const row = (await db.select().from(schema.monitors).where(eq(schema.monitors.id, id)))[0];
  if (!row) return c.json({ error: "not_found" }, 404);
  await db.delete(schema.monitors).where(eq(schema.monitors.id, id));
  await db.delete(schema.heartbeats).where(eq(schema.heartbeats.monitorId, id));
  await db.delete(schema.checkLatest).where(eq(schema.checkLatest.monitorId, id));
  await audit(c.env, actorOf(c), "delete-monitor", id);
  await publishSnapshot(c.env);
  return c.json({ ok: true });
});

app.get("/api/ops/components/:id/maintenance", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB, { schema });
  const monitor = (await db.select().from(schema.monitors).where(eq(schema.monitors.componentId, id)))[0];
  if (!monitor) return c.json({ error: "not_found" }, 404);
  const now = Date.now();
  const rows = await db.select().from(schema.maintenance).where(eq(schema.maintenance.componentId, id));
  const window = rows.find((w) => w.startAt <= now && now < w.endAt) ?? null;
  return c.json({ window });
});

app.post("/api/ops/components/:id/maintenance", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { note?: unknown; endAt?: unknown };
  const db = drizzle(c.env.DB, { schema });
  const monitor = (await db.select().from(schema.monitors).where(eq(schema.monitors.componentId, id)))[0];
  if (!monitor) return c.json({ error: "not_found" }, 404);
  const now = Date.now();
  const endAt = Number(body.endAt);
  if (!Number.isFinite(endAt) || endAt <= now || endAt - now > 90 * 24 * 60 * 60 * 1000) {
    return c.json({ error: "end_at" }, 400);
  }
  const rows = await db.select().from(schema.maintenance).where(eq(schema.maintenance.componentId, id));
  if (rows.some((w) => w.startAt < endAt && w.endAt > now)) return c.json({ error: "overlap" }, 409);
  const window = {
    id: newId(),
    componentId: id,
    startAt: now,
    endAt,
    note: sanitizeText(String(body.note ?? ""), 500),
  };
  await db.insert(schema.maintenance).values(window);
  await audit(c.env, actorOf(c), "start-maintenance", undefined, { componentId: id });
  await publishSnapshot(c.env);
  return c.json({ window });
});

app.delete("/api/ops/components/:id/maintenance", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB, { schema });
  const now = Date.now();
  const rows = await db.select().from(schema.maintenance).where(eq(schema.maintenance.componentId, id));
  const active = rows.find((w) => w.startAt <= now && now < w.endAt);
  if (!active) return c.json({ error: "not_found" }, 404);
  await db.update(schema.maintenance).set({ endAt: now }).where(eq(schema.maintenance.id, active.id));
  await audit(c.env, actorOf(c), "end-maintenance", undefined, { componentId: id });
  await publishSnapshot(c.env);
  return c.json({ ok: true });
});

app.post("/api/ops/incidents", async (c) => {
  const body = (await c.req.json()) as { title?: string; componentId?: string; impact?: string; body?: string };
  const id = newId();
  const now = Date.now();
  const db = drizzle(c.env.DB, { schema });
  await db.insert(schema.incidents).values({
    id,
    componentId: body.componentId ?? null,
    status: "investigating",
    impact: body.impact === "failing" ? "failing" : "degraded",
    title: sanitizeText(body.title ?? "Incident", 200),
    createdAt: now,
    resolvedAt: null,
    auto: 0,
  });
  await db.insert(schema.incidentUpdates).values({
    id: newId(),
    incidentId: id,
    status: "investigating",
    body: sanitizeText(body.body ?? "Investigating.", 2000),
    createdAt: now,
  });
  await audit(c.env, actorOf(c), "create-incident", undefined, { id });
  await publishSnapshot(c.env);
  return c.json({ id });
});

app.post("/api/ops/incidents/:id/updates", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json()) as { status?: string; body?: string };
  const db = drizzle(c.env.DB, { schema });
  const incident = (await db.select().from(schema.incidents).where(eq(schema.incidents.id, id)))[0];
  if (!incident) return c.json({ error: "not_found" }, 404);
  const now = Date.now();
  const status = ["investigating", "identified", "monitoring", "resolved"].includes(String(body.status))
    ? String(body.status)
    : "monitoring";
  await db.insert(schema.incidentUpdates).values({
    id: newId(),
    incidentId: id,
    status,
    body: sanitizeText(body.body ?? "", 2000),
    createdAt: now,
  });
  await db
    .update(schema.incidents)
    .set({ status, resolvedAt: status === "resolved" ? now : null })
    .where(eq(schema.incidents.id, id));
  await audit(c.env, actorOf(c), "incident-update", undefined, { id });
  await publishSnapshot(c.env);
  return c.json({ ok: true });
});

function secretNamesFromCheck(check: Check): string[] {
  if (check.type !== "http") return [];
  return Object.values(check.headers ?? {})
    .map((v) => secretName(v))
    .filter((n): n is string => Boolean(n));
}

function listSecretNames(env: Env, fromConfig: string[]): string[] {
  const reserved = new Set(["ALLOW_HTTP_LOCAL"]);
  const names = new Set(fromConfig);
  for (const [key, value] of Object.entries(env as unknown as Record<string, unknown>)) {
    if (reserved.has(key) || typeof value !== "string") continue;
    if (/^[A-Z][A-Z0-9_]{0,127}$/.test(key)) names.add(key);
  }
  return [...names].sort();
}

function parseCheckInput(body: Record<string, unknown>): Check {
  const type = body.type === "heartbeat" ? "heartbeat" : "http";
  const id = String(body.id ?? "tmp");
  if (type === "heartbeat") {
    const ch = heartbeat(id, {
      interval: (body.interval as string | number) ?? (body.intervalMs as number) ?? "10m",
      grace: (body.grace as string | number) ?? (body.graceMs as number) ?? "2m",
      critical: Boolean(body.critical),
    });
    if (ch.intervalMs < MIN_INTERVAL_MS) throw new Error("interval");
    return ch;
  }
  const regions = ((body.regions as string[]) ?? ["wnam"]).slice(0, MAX_REGIONS);
  const method = body.method === "POST" || body.method === "HEAD" ? body.method : "GET";
  const ch = http(id, {
    url: String(body.url),
    method,
    allowedHosts: body.allowedHosts as string[] | undefined,
    regions: regions as HttpCheck["regions"],
    interval: (body.interval as string | number) ?? (body.intervalMs as number) ?? "1m",
    timeout: (body.timeout as string | number) ?? (body.timeoutMs as number) ?? "10s",
    retries: Number(body.retries ?? 2),
    headers: (body.headers as HttpCheck["headers"]) ?? {},
    body: typeof body.body === "string" && body.body.length > 0 ? body.body : undefined,
    expect: (body.expect as HttpCheck["expect"]) ?? { status: 200 },
    degradedIf: body.degradedIf as HttpCheck["degradedIf"],
    critical: Boolean(body.critical),
    followRedirects: body.followRedirects !== false,
  });
  if (ch.intervalMs < MIN_INTERVAL_MS) throw new Error("interval");
  if (ch.timeoutMs > MAX_TIMEOUT_MS) ch.timeoutMs = MAX_TIMEOUT_MS;
  return ch;
}

app.get("/admin", (c) => serveAdmin(c));
app.get("/admin/*", (c) => serveAdmin(c));
app.get("/ops", (c) => redirectOpsToAdmin(c));
app.get("/ops/*", (c) => redirectOpsToAdmin(c));

function redirectOpsToAdmin(c: { req: { path: string; url: string } }) {
  const rest = c.req.path === "/ops" ? "" : c.req.path.slice("/ops".length);
  const dest = new URL(`/admin${rest}`, c.req.url);
  dest.search = new URL(c.req.url).search;
  return Response.redirect(dest.toString(), 301);
}

async function serveAdmin(c: { env: Env; req: { raw: Request; url: string } }) {
  const origin = new URL(c.req.url).origin;
  // Incoming requests use redirect: "manual". Cloning them would leak Vite's
  // /index.html → / rewrite to the browser and land on the public status page.
  let res = await c.env.ASSETS.fetch(new Request(new URL("/index.html", origin), { redirect: "follow" }));
  if (res.status >= 300 && res.status < 400) {
    res = await c.env.ASSETS.fetch(new Request(new URL("/", origin)));
  }
  const headers = new Headers(res.headers);
  headers.delete("location");
  for (const [k, v] of Object.entries(OPS_HEADERS)) headers.set(k, v);
  const status = res.status >= 300 && res.status < 400 ? 200 : res.status;
  return new Response(res.body, { status, headers });
}
