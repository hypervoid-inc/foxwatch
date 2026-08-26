-- Foxwatch D1 schema
CREATE TABLE IF NOT EXISTS monitors (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  drifted INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  group_id TEXT NOT NULL,
  group_name TEXT NOT NULL,
  component_id TEXT NOT NULL,
  component_name TEXT NOT NULL,
  critical INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL,
  muted_until INTEGER,
  consecutive_fails INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS check_latest (
  monitor_id TEXT NOT NULL,
  region TEXT NOT NULL,
  outcome TEXT NOT NULL,
  latency_ms INTEGER,
  status_code INTEGER,
  colo TEXT,
  error_class TEXT,
  error_snippet TEXT,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (monitor_id, region)
);

CREATE TABLE IF NOT EXISTS component_state (
  component_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_uptime (
  component_id TEXT NOT NULL,
  date TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (component_id, date)
);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  component_id TEXT,
  status TEXT NOT NULL,
  impact TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  auto INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS incident_updates (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  status TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS heartbeats (
  monitor_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  last_ping_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  monitor_id TEXT,
  meta_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS maintenance (
  id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  note TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_channels (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  secret_name TEXT NOT NULL,
  events_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_monitors_component ON monitors(component_id);
CREATE INDEX IF NOT EXISTS idx_incidents_created ON incidents(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
