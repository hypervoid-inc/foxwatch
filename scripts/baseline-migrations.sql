-- A database the Worker built for itself (ensureSchema) has every column but no
-- migration history, and `wrangler d1 migrations apply` would stop on the first
-- ADD COLUMN that is already there. This records each such migration as applied
-- when its last column exists. It changes nothing on an empty database or on
-- one that was migrated normally. Migrations without ADD COLUMN are safe to
-- run twice and need no entry here.
CREATE TABLE IF NOT EXISTS d1_migrations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT OR IGNORE INTO d1_migrations (name) SELECT '0003_daily_latency.sql'
  WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'daily_uptime' AND sql LIKE '%latency_count%');
INSERT OR IGNORE INTO d1_migrations (name) SELECT '0004_daily_latency_range.sql'
  WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'daily_uptime' AND sql LIKE '%latency_max%');
INSERT OR IGNORE INTO d1_migrations (name) SELECT '0005_monitor_state.sql'
  WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'monitors' AND sql LIKE '%confirmed_outcome%');
INSERT OR IGNORE INTO d1_migrations (name) SELECT '0006_history_incident_components.sql'
  WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'incidents' AND sql LIKE '%component_ids_json%');
INSERT OR IGNORE INTO d1_migrations (name) SELECT '0008_monitor_confirmation.sql'
  WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'component_state' AND sql LIKE '%pending_lease%');
