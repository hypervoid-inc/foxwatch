import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import {
  ID_RE,
  MAX_MONITORS,
  MIN_INTERVAL_MS,
  MAX_TIMEOUT_MS,
  MAX_REGIONS,
  MAX_ASSERTIONS,
  REGIONS,
  ASSERTION_OPS,
  type Check,
  type HttpCheck,
  type Assertion,
  http,
  heartbeat,
  secretName,
} from "@foxwatch/config";
import { assertSafeUrl, runHttpProbe, sanitizeText, parseHomepageUrl } from "@foxwatch/engine";
import type { Env } from "./env.ts";
import { allowHttpLocal, envSecret } from "./env.ts";
import * as schema from "./db/schema.ts";
import { authorizeOps, clearOpsCookie, csrfOk, isOpenOpsPath, opsCookie, sessionTokenFromRequest, type OpsRole } from "./auth/ops.ts";
import { readSnapshot, publishSnapshot, loadSettings, saveSettings, rememberSecretNames, loadIcon, saveIcon, deleteIcon } from "./lib/snapshot.ts";
import { renderBadge, renderFeed, renderHistoryPage, renderLivePayload, renderPublicHtml } from "./lib/public-html.ts";
import { sha256Hex, randomToken, newId } from "./lib/crypto.ts";
import { auditPageFromRows, parseAuditCursor, parseAuditLimit } from "./lib/audit-page.ts";
import { monitorStub } from "./do/monitor.ts";
import { sampleMonitors } from "./lib/samples.ts";
import { deliverAlert } from "./lib/alerts.ts";
import { loadSecretMap } from "./lib/secret-store.ts";
import { canManageWorkerSecrets, putWorkerSecret, WorkerSecretError } from "./lib/worker-secrets.ts";
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
import { fail, failFromUnknown } from "./lib/ops-error.ts";
import { visitorFromRequest } from "./lib/visitor.ts";

export const PUBLIC_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self' 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
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

app.onError((err, c) => {
  console.error(err);
  return fail(c, 500, "internal");
});

app.use("*", async (c, next) => {
  await next();
  if (c.req.path.startsWith("/admin") || c.req.path.startsWith("/ops") || c.req.path.startsWith("/api/ops")) {
    for (const [k, v] of Object.entries(OPS_HEADERS)) c.header(k, v);
  } else if (!c.req.path.startsWith("/assets")) {
    for (const [k, v] of Object.entries(PUBLIC_HEADERS)) {
      if (k === "cache-control" && c.req.path === "/api/here.json") {
        c.header(k, "private, no-store");
      } else {
        c.header(k, v);
      }
    }
  }
});

app.get("/", async (c) => {
  const snap = await readSnapshot(c.env);
  return c.html(renderPublicHtml(snap), 200, PUBLIC_HEADERS);
});

app.get("/history", async (c) => {
  const snap = await readSnapshot(c.env);
  return c.html(renderHistoryPage(snap), 200, PUBLIC_HEADERS);
});

app.get("/api/here.json", (c) => {
  return c.json(visitorFromRequest(c.req.raw), 200, { "cache-control": "private, no-store" });
});

app.get("/api/status.json", async (c) => {
  const snap = await readSnapshot(c.env);
  c.header("access-control-allow-origin", "*");
  return c.json(snap);
});

app.get("/api/status/live.json", async (c) => {
  const snap = await readSnapshot(c.env);
  return c.json(renderLivePayload(snap));
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
  if (!csrfOk(c.req.raw)) return fail(c, 403, "forbidden");
  const body = (await c.req.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
  const result = await setupFirstUser(c.env, body?.email, body?.password);
  if (!result.ok) {
    if (result.error === "exists") return fail(c, 409, "exists", "An account already exists. Sign in instead.");
    return fail(c, 400, result.error);
  }
  c.header("set-cookie", opsCookie(result.token, c.req.raw));
  await audit(c.env, result.user.email, "setup-superadmin", undefined, { id: result.user.id });
  return c.json({ ok: true, me: result.user });
});

app.post("/api/ops/session", async (c) => {
  if (!csrfOk(c.req.raw)) return fail(c, 403, "forbidden");
  const body = (await c.req.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
  const result = await loginUser(c.env, body?.email, body?.password, clientIp(c.req.raw));
  if (!result.ok) {
    if (result.error === "rate") return fail(c, 429, "rate");
    if (result.error === "setup") return fail(c, 409, "setup");
    return fail(c, 401, "credentials");
  }
  c.header("set-cookie", opsCookie(result.token, c.req.raw));
  await audit(c.env, result.user.email, "login");
  return c.json({ ok: true, me: result.user });
});

app.delete("/api/ops/session", async (c) => {
  if (!csrfOk(c.req.raw)) return fail(c, 403, "forbidden");
  await revokeSession(c.env, sessionTokenFromRequest(c.req.raw));
  c.header("set-cookie", clearOpsCookie(c.req.raw));
  return c.json({ ok: true });
});

app.use("/api/ops/*", async (c, next) => {
  if (isOpenOpsPath(c.req.path, c.req.method)) return next();
  if (!csrfOk(c.req.raw)) return fail(c, 403, "forbidden");
  const actor = await authorizeOps(c.req.raw, c.env);
  if (!actor) return fail(c, 401, "auth");
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
      confirmedOutcome: m.confirmedOutcome,
      consecutiveFails: m.consecutiveFails,
      config: JSON.parse(m.configJson) as Check,
      latest: latest.filter((l) => l.monitorId === m.id),
    })),
  });
});

app.get("/api/ops/users", async (c) => {
  if (opsActorOf(c).role !== "superadmin") return fail(c, 403, "forbidden");
  return c.json({ users: await listOperators(c.env) });
});

app.post("/api/ops/users", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: unknown; password?: unknown; role?: unknown };
  const result = await createOperator(c.env, opsActorOf(c), body.email, body.password, body.role);
  if (!result.ok) {
    if (result.error === "forbidden") return fail(c, 403, "forbidden");
    if (result.error === "exists") return fail(c, 409, "exists", "That email already has an account.");
    return fail(c, 400, result.error);
  }
  await audit(c.env, actorOf(c), "create-user", undefined, { id: result.user.id, email: result.user.email, role: result.user.role });
  return c.json({ ok: true, user: result.user });
});

app.delete("/api/ops/users/:id", async (c) => {
  const result = await deleteOperator(c.env, opsActorOf(c), c.req.param("id"));
  if (!result.ok) {
    if (result.error === "not_found") return fail(c, 404, "not_found");
    return fail(c, 403, result.error);
  }
  await audit(c.env, actorOf(c), "delete-user", undefined, { id: c.req.param("id") });
  return c.json({ ok: true });
});

app.get("/api/ops/secrets", async (c) => {
  const settings = await loadSettings(c.env);
  const names = listSecretNames(c.env, settings.secrets);
  return c.json({
    names,
    secrets: names.map((name) => ({
      name,
      set: Boolean(envSecret(c.env, name)),
    })),
    manageable: canManageWorkerSecrets(c.env),
  });
});

app.post("/api/ops/secrets", async (c) => {
  if (opsActorOf(c).role !== "superadmin") return fail(c, 403, "forbidden");
  const body = (await c.req.json().catch(() => null)) as { name?: unknown; value?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim().toUpperCase() : "";
  const value = typeof body?.value === "string" ? body.value : "";
  try {
    secretName({ __foxwatch_secret__: name });
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) throw new Error("name");
  } catch {
    return fail(c, 400, "secret");
  }
  if (value) {
    if (new TextEncoder().encode(value).byteLength > 8192) return fail(c, 400, "secret_value");
    const rotating = Boolean(envSecret(c.env, name));
    try {
      await putWorkerSecret(c.env, name, value);
    } catch (error) {
      const code = error instanceof WorkerSecretError ? error.code : "cloudflare_api";
      return fail(c, 503, code);
    }
    await rememberSecretNames(c.env, [name]);
    await audit(c.env, actorOf(c), rotating ? "rotate-secret" : "create-secret", undefined, { name });
    return c.json({ ok: true, name, rotated: rotating });
  }
  // Name-only registration (value set later via wrangler secret put)
  await rememberSecretNames(c.env, [name]);
  await audit(c.env, actorOf(c), "create-secret", undefined, { name });
  return c.json({ ok: true, name, rotated: false });
});

app.get("/api/ops/alert-channels", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const rows = await db.select().from(schema.alertChannels);
  return c.json({
    channels: rows.map((row) => ({
      id: row.id,
      type: row.type,
      secretName: row.secretName,
      events: JSON.parse(row.eventsJson) as string[],
      ready: Boolean(envSecret(c.env, row.secretName)),
    })),
  });
});

app.post("/api/ops/alert-channels", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const id = String(body.id ?? "");
  const type = body.type === "slack_webhook" || body.type === "discord_webhook" || body.type === "webhook" ? body.type : "";
  const secret = String(body.secretName ?? "").trim().toUpperCase();
  const events = Array.isArray(body.events)
    ? [...new Set(body.events.map(String).filter((event) => ["fail", "degrade", "recover"].includes(event)))]
    : [];
  if (!ID_RE.test(id) || !type || !/^[A-Z][A-Z0-9_]{0,127}$/.test(secret) || events.length === 0) {
    return fail(c, 400, "alert_channel");
  }
  const db = drizzle(c.env.DB, { schema });
  await db.insert(schema.alertChannels).values({ id, type, secretName: secret, eventsJson: JSON.stringify(events) })
    .onConflictDoUpdate({ target: schema.alertChannels.id, set: { type, secretName: secret, eventsJson: JSON.stringify(events) } });
  await rememberSecretNames(c.env, [secret]);
  await audit(c.env, actorOf(c), "upsert-alert-channel", undefined, { id, type, secretName: secret, events });
  return c.json({ ok: true, id });
});

app.delete("/api/ops/alert-channels/:id", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB, { schema });
  await db.delete(schema.alertChannels).where(eq(schema.alertChannels.id, id));
  await audit(c.env, actorOf(c), "delete-alert-channel", undefined, { id });
  return c.json({ ok: true });
});

app.post("/api/ops/alert-channels/:id/test", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB, { schema });
  const channel = (await db.select().from(schema.alertChannels).where(eq(schema.alertChannels.id, id)))[0];
  if (!channel) return fail(c, 404, "not_found");
  try {
    const configured = JSON.parse(channel.eventsJson) as Array<"fail" | "degrade" | "recover">;
    await deliverAlert(c.env, { type: channel.type, secretName: channel.secretName, events: configured }, {
      eventId: newId(),
      event: configured[0] ?? "recover",
      componentId: "test",
      title: "Test alert — delivery is configured",
    });
  } catch {
    return fail(c, 503, "delivery");
  }
  await audit(c.env, actorOf(c), "test-alert-channel", undefined, { id });
  return c.json({ ok: true });
});

app.delete("/api/ops/secrets/:name", async (c) => {
  if (opsActorOf(c).role !== "superadmin") return fail(c, 403, "forbidden");
  const name = c.req.param("name").toUpperCase();
  if (envSecret(c.env, name)) return fail(c, 409, "rotate_only");
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
      return fail(c, 400, "invalid_url");
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
  if (!(file instanceof File)) return fail(c, 400, "icon");
  try {
    const next = await saveIcon(c.env, new Uint8Array(await file.arrayBuffer()));
    await audit(c.env, actorOf(c), "update-icon");
    await publishSnapshot(c.env);
    return c.json({ iconUrl: `/icon?v=${next.iconUpdatedAt}` });
  } catch {
    return fail(c, 400, "icon");
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
  if (cursor === "invalid") return fail(c, 400, "invalid_cursor");
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
  if (!row) return fail(c, 404, "not_found");
  if (row.mutedUntil != null && row.mutedUntil > Date.now()) return c.json({ ok: true, skipped: "muted" });
  const now = Date.now();
  const maintenance = await db.select().from(schema.maintenance).where(eq(schema.maintenance.componentId, row.componentId));
  if (maintenance.some((window) => window.startAt <= now && now < window.endAt)) {
    return c.json({ ok: true, skipped: "maintenance" });
  }
  await monitorStub(c.env, id).runNow();
  await audit(c.env, actorOf(c), "run-now", id);
  return c.json({ ok: true });
});

app.get("/api/ops/monitors/:id/runs", async (c) => {
  const id = c.req.param("id");
  const limit = Math.min(5, Math.max(1, Number(c.req.query("limit") ?? 5) || 5));
  const db = drizzle(c.env.DB, { schema });
  const monitor = (await db.select({ id: schema.monitors.id }).from(schema.monitors).where(eq(schema.monitors.id, id)))[0];
  if (!monitor) return fail(c, 404, "not_found");
  const runs = await db
    .select()
    .from(schema.checkRuns)
    .where(eq(schema.checkRuns.monitorId, id))
    .orderBy(desc(schema.checkRuns.checkedAt))
    .limit(limit);
  return c.json({ runs });
});

app.post("/api/ops/monitors/test-request", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return fail(c, 400, "invalid");
  let check: Check;
  try {
    check = parseCheckInput({ ...body, id: "test-request", type: "http", interval: "1m" });
  } catch (error) {
    return failFromUnknown(c, error);
  }
  if (check.type !== "http") return fail(c, 400, "invalid");
  const secrets = await loadSecretMap(c.env, secretNamesFromCheck(check));
  const result = await runHttpProbe(check, {
    secrets,
    allowHttpLocal: allowHttpLocal(c.env),
    fetchImpl: fetch.bind(globalThis),
  });
  await audit(c.env, actorOf(c), "test-request", undefined, { outcome: result.outcome, statusCode: result.statusCode });
  return c.json({
    outcome: result.outcome,
    latencyMs: result.latencyMs,
    statusCode: result.statusCode,
    colo: result.colo,
    errorClass: result.errorClass ?? null,
    responseSnippet: result.responseSnippet ?? null,
  });
});

app.post("/api/ops/monitors/:id/mute", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { until?: number | null };
  const db = drizzle(c.env.DB, { schema });
  const row = (await db.select().from(schema.monitors).where(eq(schema.monitors.id, id)))[0];
  if (!row) return fail(c, 404, "not_found");
  const until = body.until == null ? null : Number(body.until);
  if (until != null && (!Number.isFinite(until) || until <= Date.now() || until - Date.now() > 90 * 24 * 60 * 60 * 1000)) {
    return fail(c, 400, "mute_until");
  }
  await db.update(schema.monitors).set({ mutedUntil: until, updatedAt: Date.now() }).where(eq(schema.monitors.id, id));
  if (until == null) await monitorStub(c.env, id).reschedule(1);
  await audit(c.env, actorOf(c), until ? "mute" : "unmute", id);
  await publishSnapshot(c.env);
  return c.json({ ok: true });
});

app.post("/api/ops/heartbeats/:id/rotate", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB, { schema });
  const monitor = (await db.select().from(schema.monitors).where(eq(schema.monitors.id, id)))[0];
  if (!monitor || monitor.type !== "heartbeat") return fail(c, 404, "not_found");
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
  if (count >= MAX_MONITORS) return fail(c, 400, "quota");
  const body = (await c.req.json()) as Record<string, unknown>;
  const id = String(body.id ?? "");
  if (!ID_RE.test(id)) return fail(c, 400, "invalid_id");
  const existing = (await db.select().from(schema.monitors).where(eq(schema.monitors.id, id)))[0];
  if (existing) return fail(c, 409, "exists", "A check with this id already exists.");
  let check: Check;
  try {
    check = parseCheckInput(body);
    if (check.type === "http") assertSafeUrl(check.url, { allowHttpLocal: allowHttpLocal(c.env) });
  } catch (err) {
    return failFromUnknown(c, err);
  }
  const now = Date.now();
  const groupName = sanitizeText(String(body.groupName ?? "Custom"), 80) || "Custom";
  const componentName = sanitizeText(String(body.componentName ?? body.name ?? id), 80) || id;
  const groupId = String(body.groupId ?? "custom");
  const componentId = String(body.componentId ?? id);
  if (!ID_RE.test(groupId) || !ID_RE.test(componentId)) return fail(c, 400, "invalid_id");
  await db.insert(schema.monitors).values({
    id,
    origin: "ui",
    drifted: 0,
    type: check.type,
    name: sanitizeText(String(body.name ?? id), 80) || id,
    groupId,
    groupName,
    componentId,
    componentName,
    critical: body.critical ? 1 : 0,
    configJson: JSON.stringify(check),
    mutedUntil: null,
    consecutiveFails: 0,
    confirmedOutcome: null,
    createdAt: now,
    updatedAt: now,
  });
  await rememberSecretNames(c.env, secretNamesFromCheck(check));
  await monitorStub(c.env, id).reschedule(1);
  await audit(c.env, actorOf(c), "create-monitor", id);
  await publishSnapshot(c.env);
  return c.json({ ok: true, id });
});

app.post("/api/ops/samples", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const samples = sampleMonitors();
  const existing = new Set((await db.select({ id: schema.monitors.id }).from(schema.monitors)).map((row) => row.id));
  const missing = samples.filter((sample) => !existing.has(sample.id));
  if (existing.size + missing.length > MAX_MONITORS) return fail(c, 400, "quota");
  const now = Date.now();
  for (const sample of missing) {
    if (sample.check.type === "http") {
      try {
        assertSafeUrl(sample.check.url, { allowHttpLocal: allowHttpLocal(c.env) });
      } catch (err) {
        return failFromUnknown(c, err);
      }
    }
  }
  for (const sample of missing) {
    await db.insert(schema.monitors).values({
      id: sample.id,
      origin: "ui",
      drifted: 0,
      type: sample.check.type,
      name: sample.name,
      groupId: sample.groupId,
      groupName: sample.groupName,
      componentId: sample.componentId,
      componentName: sample.componentName,
      critical: sample.critical ? 1 : 0,
      configJson: JSON.stringify(sample.check),
      mutedUntil: null,
      consecutiveFails: 0,
      confirmedOutcome: null,
      createdAt: now,
      updatedAt: now,
    });
    try {
      await monitorStub(c.env, sample.id).reschedule(1);
    } catch {
      /* alarm is best-effort; Run still works from Checks */
    }
  }
  await audit(c.env, actorOf(c), "populate-samples", undefined, {
    created: missing.map((sample) => sample.id),
    skipped: samples.filter((sample) => existing.has(sample.id)).map((sample) => sample.id),
  });
  await publishSnapshot(c.env);
  return c.json({
    ok: true,
    created: missing.map((sample) => sample.id),
    skipped: samples.filter((sample) => existing.has(sample.id)).map((sample) => sample.id),
  });
});

app.patch("/api/ops/monitors/:id", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB, { schema });
  const row = (await db.select().from(schema.monitors).where(eq(schema.monitors.id, id)))[0];
  if (!row) return fail(c, 404, "not_found");
  const body = (await c.req.json()) as Record<string, unknown>;
  const existingCheck = JSON.parse(row.configJson) as Check;
  let check: Check;
  try {
    check = parseCheckInput({ ...existingCheck, ...body, id, type: body.type ?? existingCheck.type });
    if (check.type === "http") assertSafeUrl(check.url, { allowHttpLocal: allowHttpLocal(c.env) });
  } catch (err) {
    return failFromUnknown(c, err);
  }
  const drifted = row.origin === "git" ? 1 : 0;
  const executionChanged = checkExecutionKey(check) !== checkExecutionKey(existingCheck);
  const nextGroupId = String(body.groupId ?? row.groupId);
  const nextComponentId = String(body.componentId ?? row.componentId);
  if (!ID_RE.test(nextGroupId) || !ID_RE.test(nextComponentId)) return fail(c, 400, "invalid_id");
  await db
    .update(schema.monitors)
    .set({
      type: check.type,
      name: sanitizeText(String(body.name ?? row.name), 80) || row.name,
      groupId: nextGroupId,
      groupName: sanitizeText(String(body.groupName ?? row.groupName), 80) || row.groupName,
      componentId: nextComponentId,
      componentName: sanitizeText(String(body.componentName ?? row.componentName), 80) || row.componentName,
      critical: body.critical == null ? row.critical : body.critical ? 1 : 0,
      configJson: JSON.stringify(check),
      drifted,
      consecutiveFails: executionChanged ? 0 : row.consecutiveFails,
      confirmedOutcome: executionChanged ? null : row.confirmedOutcome,
      updatedAt: Date.now(),
    })
    .where(eq(schema.monitors.id, id));
  if (executionChanged) {
    // Configuration changes invalidate every prior regional result. Keeping
    // even one removed region would corrupt quorum until manually deleted.
    await db.delete(schema.checkLatest).where(eq(schema.checkLatest.monitorId, id));
  }
  if (row.componentId !== nextComponentId) {
    const oldComponentMonitors = await db.select({ id: schema.monitors.id }).from(schema.monitors).where(eq(schema.monitors.componentId, row.componentId));
    if (oldComponentMonitors.length === 0) {
      const movedAt = Date.now();
      const openAuto = await db.select().from(schema.incidents).where(
        and(eq(schema.incidents.componentId, row.componentId), eq(schema.incidents.auto, 1), inArray(schema.incidents.status, ["investigating", "identified", "monitoring"])),
      );
      for (const incident of openAuto) {
        await db.update(schema.incidents).set({ status: "resolved", resolvedAt: movedAt }).where(eq(schema.incidents.id, incident.id));
        await db.insert(schema.incidentUpdates).values({ id: newId(), incidentId: incident.id, status: "resolved", body: "Automatically resolved because the check moved to another component.", createdAt: movedAt });
      }
      await db.delete(schema.componentState).where(eq(schema.componentState.componentId, row.componentId));
    }
  }
  await rememberSecretNames(c.env, secretNamesFromCheck(check));
  if (executionChanged) await monitorStub(c.env, id).reschedule(1);
  await audit(c.env, actorOf(c), "update-monitor", id);
  await publishSnapshot(c.env);
  return c.json({ ok: true, drifted: drifted === 1 });
});

app.delete("/api/ops/monitors/:id", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB, { schema });
  const row = (await db.select().from(schema.monitors).where(eq(schema.monitors.id, id)))[0];
  if (!row) return fail(c, 404, "not_found");
  await db.delete(schema.monitors).where(eq(schema.monitors.id, id));
  await db.delete(schema.heartbeats).where(eq(schema.heartbeats.monitorId, id));
  await db.delete(schema.checkLatest).where(eq(schema.checkLatest.monitorId, id));
  await db.delete(schema.checkRuns).where(eq(schema.checkRuns.monitorId, id));
  const remaining = await db.select({ id: schema.monitors.id }).from(schema.monitors).where(eq(schema.monitors.componentId, row.componentId));
  if (remaining.length === 0) {
    const now = Date.now();
    const openAuto = await db.select().from(schema.incidents).where(
      and(eq(schema.incidents.componentId, row.componentId), eq(schema.incidents.auto, 1), inArray(schema.incidents.status, ["investigating", "identified", "monitoring"])),
    );
    for (const incident of openAuto) {
      await db.update(schema.incidents).set({ status: "resolved", resolvedAt: now }).where(eq(schema.incidents.id, incident.id));
      await db.insert(schema.incidentUpdates).values({ id: newId(), incidentId: incident.id, status: "resolved", body: "Automatically resolved because the monitored component was removed.", createdAt: now });
    }
    await db.delete(schema.componentState).where(eq(schema.componentState.componentId, row.componentId));
  }
  await audit(c.env, actorOf(c), "delete-monitor", id);
  await publishSnapshot(c.env);
  return c.json({ ok: true });
});

app.get("/api/ops/components/:id/maintenance", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB, { schema });
  const monitor = (await db.select().from(schema.monitors).where(eq(schema.monitors.componentId, id)))[0];
  if (!monitor) return fail(c, 404, "not_found");
  const now = Date.now();
  const rows = await db.select().from(schema.maintenance).where(eq(schema.maintenance.componentId, id));
  const upcoming = rows.filter((w) => w.endAt > now).sort((a, b) => a.startAt - b.startAt);
  const window = upcoming.find((w) => w.startAt <= now && now < w.endAt) ?? null;
  return c.json({ window, windows: upcoming });
});

app.post("/api/ops/components/:id/maintenance", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { note?: unknown; startAt?: unknown; endAt?: unknown };
  const db = drizzle(c.env.DB, { schema });
  const monitor = (await db.select().from(schema.monitors).where(eq(schema.monitors.componentId, id)))[0];
  if (!monitor) return fail(c, 404, "not_found");
  const now = Date.now();
  const startAt = body.startAt == null ? now : Number(body.startAt);
  const endAt = Number(body.endAt);
  if (!Number.isFinite(startAt) || startAt < now - 60_000 || startAt - now > 90 * 24 * 60 * 60 * 1000) {
    return fail(c, 400, "start_at");
  }
  if (!Number.isFinite(endAt) || endAt <= startAt || endAt - startAt > 90 * 24 * 60 * 60 * 1000) {
    return fail(c, 400, "end_at");
  }
  const rows = await db.select().from(schema.maintenance).where(eq(schema.maintenance.componentId, id));
  if (rows.some((w) => w.startAt < endAt && w.endAt > startAt)) return fail(c, 409, "overlap");
  const window = {
    id: newId(),
    componentId: id,
    startAt,
    endAt,
    note: sanitizeText(String(body.note ?? ""), 500),
  };
  await db.insert(schema.maintenance).values(window);
  await audit(c.env, actorOf(c), startAt > now ? "schedule-maintenance" : "start-maintenance", undefined, { componentId: id, startAt, endAt });
  await publishSnapshot(c.env);
  return c.json({ window });
});

app.delete("/api/ops/components/:id/maintenance", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB, { schema });
  const now = Date.now();
  const rows = await db.select().from(schema.maintenance).where(eq(schema.maintenance.componentId, id));
  const target = rows
    .filter((w) => w.endAt > now)
    .sort((a, b) => a.startAt - b.startAt)[0];
  if (!target) return fail(c, 404, "not_found");
  if (target.startAt > now) await db.delete(schema.maintenance).where(eq(schema.maintenance.id, target.id));
  else await db.update(schema.maintenance).set({ endAt: now }).where(eq(schema.maintenance.id, target.id));
  await audit(c.env, actorOf(c), target.startAt > now ? "cancel-maintenance" : "end-maintenance", undefined, { componentId: id, id: target.id });
  await publishSnapshot(c.env);
  return c.json({ ok: true });
});

app.delete("/api/ops/components/:id/maintenance/:windowId", async (c) => {
  const componentId = c.req.param("id");
  const windowId = c.req.param("windowId");
  const db = drizzle(c.env.DB, { schema });
  const target = (await db.select().from(schema.maintenance).where(
    and(eq(schema.maintenance.id, windowId), eq(schema.maintenance.componentId, componentId)),
  ))[0];
  if (!target || target.endAt <= Date.now()) return fail(c, 404, "not_found");
  const now = Date.now();
  if (target.startAt > now) await db.delete(schema.maintenance).where(eq(schema.maintenance.id, target.id));
  else await db.update(schema.maintenance).set({ endAt: now }).where(eq(schema.maintenance.id, target.id));
  await audit(c.env, actorOf(c), target.startAt > now ? "cancel-maintenance" : "end-maintenance", undefined, { componentId, id: target.id });
  await publishSnapshot(c.env);
  return c.json({ ok: true });
});

app.post("/api/ops/incidents", async (c) => {
  const body = (await c.req.json()) as { title?: string; componentId?: string; componentIds?: unknown; impact?: string; body?: string; startedAt?: unknown; notify?: unknown };
  const id = newId();
  const now = Date.now();
  const createdAt = body.startedAt == null ? now : Number(body.startedAt);
  if (!Number.isFinite(createdAt) || createdAt > now + 60_000 || createdAt < now - 365 * 86_400_000) {
    return fail(c, 400, "incident_time");
  }
  const db = drizzle(c.env.DB, { schema });
  const title = sanitizeText(body.title ?? "", 200);
  if (!title) return fail(c, 400, "title");
  const requested = Array.isArray(body.componentIds)
    ? [...new Set(body.componentIds.filter((id): id is string => typeof id === "string"))]
    : body.componentId ? [body.componentId] : [];
  const known = new Set((await db.select({ id: schema.monitors.componentId }).from(schema.monitors)).map((row) => row.id));
  if (requested.some((id) => !known.has(id))) return fail(c, 400, "component");
  await db.insert(schema.incidents).values({
    id,
    componentId: requested[0] ?? null,
    componentIdsJson: JSON.stringify(requested),
    status: "investigating",
    impact: body.impact === "failing" ? "failing" : "degraded",
    title,
    createdAt,
    resolvedAt: null,
    auto: 0,
  });
  await db.insert(schema.incidentUpdates).values({
    id: newId(),
    incidentId: id,
    status: "investigating",
    body: sanitizeText(body.body ?? "Investigating.", 2000),
    createdAt,
  });
  if (body.notify !== false) {
    const alertTargets = requested.length ? requested : ["global"];
    try {
      await c.env.ALERTS.send({ eventId: newId(), event: body.impact === "failing" ? "fail" : "degrade", componentId: alertTargets.join(","), title });
    } catch {
      /* incident publishing must not fail because an optional queue is absent */
    }
  }
  await audit(c.env, actorOf(c), "create-incident", undefined, { id, createdAt, notify: body.notify !== false });
  await publishSnapshot(c.env);
  return c.json({ id });
});

app.post("/api/ops/incidents/:id/updates", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json()) as { status?: string; body?: string; notify?: unknown };
  const db = drizzle(c.env.DB, { schema });
  const incident = (await db.select().from(schema.incidents).where(eq(schema.incidents.id, id)))[0];
  if (!incident) return fail(c, 404, "not_found");
  const now = Date.now();
  const status = ["investigating", "identified", "monitoring", "resolved"].includes(String(body.status))
    ? String(body.status)
    : "monitoring";
  const updateText = sanitizeText(body.body ?? "", 2000);
  if (!updateText) return fail(c, 400, "update_body");
  await db.insert(schema.incidentUpdates).values({
    id: newId(),
    incidentId: id,
    status,
    body: updateText,
    createdAt: now,
  });
  await db
    .update(schema.incidents)
    .set({ status, resolvedAt: status === "resolved" ? now : null })
    .where(eq(schema.incidents.id, id));
  if (body.notify !== false) {
    const targets = (() => {
      try {
        const ids = JSON.parse(incident.componentIdsJson ?? "[]") as unknown;
        if (Array.isArray(ids) && ids.every((value) => typeof value === "string") && ids.length) return ids as string[];
      } catch { /* legacy single-component incident */ }
      return incident.componentId ? [incident.componentId] : ["global"];
    })();
    try {
      await c.env.ALERTS.send({
        eventId: newId(),
        event: status === "resolved" ? "recover" : incident.impact === "failing" ? "fail" : "degrade",
        componentId: targets.join(","),
        title: `${incident.title}: ${updateText}`,
      });
    } catch { /* optional queue */ }
  }
  await audit(c.env, actorOf(c), "incident-update", undefined, { id, status, notify: body.notify !== false });
  await publishSnapshot(c.env);
  return c.json({ ok: true });
});

function secretNamesFromCheck(check: Check): string[] {
  if (check.type !== "http") return [];
  return Object.values(check.headers ?? {})
    .map((v) => secretName(v))
    .filter((n): n is string => Boolean(n));
}

function checkExecutionKey(check: Check): string {
  const { critical: _critical, name: _name, ...execution } = check;
  return JSON.stringify(execution);
}

function listSecretNames(env: Env, fromConfig: string[]): string[] {
  const reserved = new Set(["ALLOW_HTTP_LOCAL", "FOXWATCH_CF_API_TOKEN", "FOXWATCH_CF_ACCOUNT_ID", "FOXWATCH_CF_SCRIPT_NAME"]);
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
      confirmFails: Number(body.confirmFails ?? 3),
    });
    if (ch.intervalMs < MIN_INTERVAL_MS) throw new Error("interval");
    if (ch.intervalMs > 24 * 60 * 60 * 1000 || ch.graceMs > 7 * 24 * 60 * 60 * 1000) throw new Error("interval");
    if (!Number.isInteger(ch.confirmFails) || ch.confirmFails! < 1 || ch.confirmFails! > 10) throw new Error("confirm_fails");
    return ch;
  }
  const requestedRegions = Array.isArray(body.regions) ? body.regions.map(String) : ["wnam"];
  if (requestedRegions.length < 1 || requestedRegions.length > MAX_REGIONS || requestedRegions.some((r) => !REGIONS.includes(r as (typeof REGIONS)[number]))) {
    throw new Error("regions");
  }
  const regions = [...new Set(requestedRegions)];
  const method = body.method === "POST" || body.method === "HEAD" ? body.method : "GET";
  const allowedHosts = body.allowedHosts == null
    ? undefined
    : Array.isArray(body.allowedHosts) && body.allowedHosts.length <= 10 && body.allowedHosts.every((host) => typeof host === "string" && host.length <= 253)
      ? body.allowedHosts as string[]
      : (() => { throw new Error("invalid_url"); })();
  const retries = Number(body.retries ?? 2);
  const confirmFails = Number(body.confirmFails ?? 3);
  const degradedIf = body.degradedIf as { latencyMs?: unknown } | undefined;
  if (degradedIf && (!Number.isFinite(Number(degradedIf.latencyMs)) || Number(degradedIf.latencyMs) < 1)) {
    throw new Error("latency");
  }
  const requestBody = typeof body.body === "string" && body.body.length > 0 ? body.body : undefined;
  if (requestBody && new TextEncoder().encode(requestBody).byteLength > 64 * 1024) throw new Error("body");
  const rawHeaders = body.headers ?? {};
  if (!rawHeaders || typeof rawHeaders !== "object" || Array.isArray(rawHeaders) || Object.keys(rawHeaders).length > 50) throw new Error("headers");
  const headers = rawHeaders as Record<string, unknown>;
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)) throw new Error("headers");
    const ref = secretName(value);
    if (typeof value !== "string" && !ref) throw new Error("headers");
    if (typeof value === "string" && value.length > 8192) throw new Error("headers");
    if (/authorization|proxy-authorization|api[-_]?key|token|secret|cookie/i.test(name) && typeof value === "string") {
      throw new Error("secret_required");
    }
  }
  const expect = (body.expect ?? { status: 200 }) as Record<string, unknown>;
  if (!expect || typeof expect !== "object" || Array.isArray(expect)) throw new Error("expect");
  const statuses = Array.isArray(expect.status) ? expect.status : [expect.status ?? 200];
  if (statuses.length < 1 || statuses.length > 20 || statuses.some((status) => !Number.isInteger(status) || Number(status) < 100 || Number(status) > 599)) {
    throw new Error("expect");
  }
  if (expect.bodyIncludes != null && (typeof expect.bodyIncludes !== "string" || expect.bodyIncludes.length > 8192)) throw new Error("expect");
  if (expect.header != null && (typeof expect.header !== "object" || Array.isArray(expect.header) || Object.entries(expect.header as Record<string, unknown>).some(([name, value]) => !name || typeof value !== "string" || value.length > 8192))) {
    throw new Error("expect");
  }
  if (expect.jsonPath != null) {
    const assertion = expect.jsonPath as Record<string, unknown>;
    if (!assertion || typeof assertion !== "object" || typeof assertion.path !== "string" || assertion.path.length > 256) throw new Error("expect");
  }
  if (expect.assertions != null) {
    if (!Array.isArray(expect.assertions) || expect.assertions.length > MAX_ASSERTIONS) throw new Error("expect");
    for (const a of expect.assertions as unknown[]) {
      if (!a || typeof a !== "object" || Array.isArray(a)) throw new Error("expect");
      const item = a as Record<string, unknown>;
      if (typeof item.path !== "string" || item.path.length > 256 || !item.path.startsWith("$")) throw new Error("expect");
      if (typeof item.op !== "string" || !(ASSERTION_OPS as readonly string[]).includes(item.op)) throw new Error("expect");
      const op = item.op as Assertion["op"];
      if (op === "exists" || op === "not_exists") {
        // value not needed
      } else if (op === "gt" || op === "gte" || op === "lt" || op === "lte") {
        if (typeof item.value !== "number" || !Number.isFinite(item.value)) throw new Error("expect");
      } else if (op === "contains" || op === "not_contains" || op === "matches") {
        if (typeof item.value !== "string" || item.value.length > 256) throw new Error("expect");
      } else {
        // equals / not_equals: allow string, number, boolean, null
        if (item.value !== null && typeof item.value !== "string" && typeof item.value !== "number" && typeof item.value !== "boolean") throw new Error("expect");
      }
    }
    if (expect.assertionFailThreshold != null) {
      const t = Number(expect.assertionFailThreshold);
      if (!Number.isInteger(t) || t < 1 || t > (expect.assertions as unknown[]).length) throw new Error("expect");
    }
  }
  const ch = http(id, {
    url: String(body.url),
    method,
    allowedHosts,
    regions: regions as HttpCheck["regions"],
    interval: (body.interval as string | number) ?? (body.intervalMs as number) ?? "1m",
    timeout: (body.timeout as string | number) ?? (body.timeoutMs as number) ?? "10s",
    retries,
    headers: headers as HttpCheck["headers"],
    body: requestBody,
    expect: expect as HttpCheck["expect"],
    degradedIf: degradedIf ? { latencyMs: Number(degradedIf.latencyMs) } : undefined,
    failWhen: body.failWhen === "any" || body.failWhen === "all" ? body.failWhen : "majority",
    confirmFails,
    critical: Boolean(body.critical),
    followRedirects: body.followRedirects !== false,
  });
  if (ch.intervalMs < MIN_INTERVAL_MS) throw new Error("interval");
  if (!Number.isInteger(ch.retries) || ch.retries < 0 || ch.retries > 5) throw new Error("retries");
  if (!Number.isInteger(ch.confirmFails) || ch.confirmFails! < 1 || ch.confirmFails! > 10) throw new Error("confirm_fails");
  if (!Number.isFinite(ch.timeoutMs) || ch.timeoutMs < 1 || ch.timeoutMs > MAX_TIMEOUT_MS) throw new Error("timeout");
  if (ch.degradedIf && ch.degradedIf.latencyMs >= ch.timeoutMs) throw new Error("latency");
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
