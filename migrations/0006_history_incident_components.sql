ALTER TABLE incidents ADD COLUMN component_ids_json TEXT;

CREATE TABLE IF NOT EXISTS check_runs (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL,
  region TEXT NOT NULL,
  outcome TEXT NOT NULL,
  latency_ms INTEGER,
  status_code INTEGER,
  colo TEXT,
  error_class TEXT,
  error_snippet TEXT,
  checked_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_check_runs_monitor_time
  ON check_runs(monitor_id, checked_at DESC);

DELETE FROM site_settings WHERE key = 'secret_values';

UPDATE incidents SET status = 'resolved', resolved_at = unixepoch('now') * 1000
WHERE auto = 1 AND resolved_at IS NULL AND rowid NOT IN (
  SELECT MAX(rowid) FROM incidents WHERE auto = 1 AND resolved_at IS NULL GROUP BY component_id
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_auto_incident
  ON incidents(component_id)
  WHERE auto = 1 AND resolved_at IS NULL;
