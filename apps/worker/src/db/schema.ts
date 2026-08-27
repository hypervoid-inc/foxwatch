import { integer, sqliteTable, text, primaryKey } from "drizzle-orm/sqlite-core";

export const monitors = sqliteTable("monitors", {
  id: text("id").primaryKey(),
  origin: text("origin").$type<"git" | "ui">().notNull(),
  drifted: integer("drifted").notNull().default(0),
  type: text("type").$type<"http" | "heartbeat">().notNull(),
  name: text("name").notNull(),
  groupId: text("group_id").notNull(),
  groupName: text("group_name").notNull(),
  componentId: text("component_id").notNull(),
  componentName: text("component_name").notNull(),
  critical: integer("critical").notNull().default(0),
  configJson: text("config_json").notNull(),
  mutedUntil: integer("muted_until"),
  consecutiveFails: integer("consecutive_fails").notNull().default(0),
  confirmedOutcome: text("confirmed_outcome").$type<"pass" | "degraded" | "fail">(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const checkLatest = sqliteTable(
  "check_latest",
  {
    monitorId: text("monitor_id").notNull(),
    region: text("region").notNull(),
    outcome: text("outcome").notNull(),
    latencyMs: integer("latency_ms"),
    statusCode: integer("status_code"),
    colo: text("colo"),
    errorClass: text("error_class"),
    errorSnippet: text("error_snippet"),
    checkedAt: integer("checked_at").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.monitorId, t.region] }) }),
);

export const checkRuns = sqliteTable("check_runs", {
  id: text("id").primaryKey(),
  monitorId: text("monitor_id").notNull(),
  region: text("region").notNull(),
  outcome: text("outcome").notNull(),
  latencyMs: integer("latency_ms"),
  statusCode: integer("status_code"),
  colo: text("colo"),
  errorClass: text("error_class"),
  errorSnippet: text("error_snippet"),
  checkedAt: integer("checked_at").notNull(),
});

export const componentState = sqliteTable("component_state", {
  componentId: text("component_id").primaryKey(),
  status: text("status").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const dailyUptime = sqliteTable(
  "daily_uptime",
  {
    componentId: text("component_id").notNull(),
    date: text("date").notNull(),
    ok: integer("ok").notNull().default(0),
    total: integer("total").notNull().default(0),
    latencySum: integer("latency_sum").notNull().default(0),
    latencyCount: integer("latency_count").notNull().default(0),
    latencyMin: integer("latency_min"),
    latencyMax: integer("latency_max"),
  },
  (t) => ({ pk: primaryKey({ columns: [t.componentId, t.date] }) }),
);

export const incidents = sqliteTable("incidents", {
  id: text("id").primaryKey(),
  componentId: text("component_id"),
  componentIdsJson: text("component_ids_json"),
  status: text("status").notNull(),
  impact: text("impact").notNull(),
  title: text("title").notNull(),
  createdAt: integer("created_at").notNull(),
  resolvedAt: integer("resolved_at"),
  auto: integer("auto").notNull().default(0),
});

export const incidentUpdates = sqliteTable("incident_updates", {
  id: text("id").primaryKey(),
  incidentId: text("incident_id").notNull(),
  status: text("status").notNull(),
  body: text("body").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const heartbeats = sqliteTable("heartbeats", {
  monitorId: text("monitor_id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  lastPingAt: integer("last_ping_at"),
  createdAt: integer("created_at").notNull(),
});

export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  monitorId: text("monitor_id"),
  metaJson: text("meta_json"),
  createdAt: integer("created_at").notNull(),
});

export const siteSettings = sqliteTable("site_settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
});

export const maintenance = sqliteTable("maintenance", {
  id: text("id").primaryKey(),
  componentId: text("component_id").notNull(),
  startAt: integer("start_at").notNull(),
  endAt: integer("end_at").notNull(),
  note: text("note").notNull(),
});

export const alertChannels = sqliteTable("alert_channels", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  secretName: text("secret_name").notNull(),
  eventsJson: text("events_json").notNull(),
});

export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const opsUsers = sqliteTable("ops_users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").$type<"superadmin" | "admin">().notNull(),
  createdAt: integer("created_at").notNull(),
  createdBy: text("created_by"),
});

export const opsSessions = sqliteTable("ops_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const opsAuthThrottle = sqliteTable("ops_auth_throttle", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  resetAt: integer("reset_at").notNull(),
});
