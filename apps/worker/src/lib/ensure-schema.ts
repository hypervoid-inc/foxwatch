const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS monitors (
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
)`,
  `CREATE TABLE IF NOT EXISTS check_latest (
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
)`,
  `CREATE TABLE IF NOT EXISTS component_state (
  component_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS daily_uptime (
  component_id TEXT NOT NULL,
  date TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  latency_sum INTEGER NOT NULL DEFAULT 0,
  latency_count INTEGER NOT NULL DEFAULT 0,
  latency_min INTEGER,
  latency_max INTEGER,
  PRIMARY KEY (component_id, date)
)`,
  `CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  component_id TEXT,
  status TEXT NOT NULL,
  impact TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  auto INTEGER NOT NULL DEFAULT 0
)`,
  `CREATE TABLE IF NOT EXISTS incident_updates (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  status TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS heartbeats (
  monitor_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  last_ping_at INTEGER,
  created_at INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  monitor_id TEXT,
  meta_json TEXT,
  created_at INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS maintenance (
  id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  note TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS alert_channels (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  secret_name TEXT NOT NULL,
  events_json TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS ops_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT
)`,
  `CREATE TABLE IF NOT EXISTS ops_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS ops_auth_throttle (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_monitors_component ON monitors(component_id)`,
  `CREATE INDEX IF NOT EXISTS idx_incidents_created ON incidents(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ops_sessions_user ON ops_sessions(user_id)`,
];

const SCHEMA_VERSION = "4";

const ALTERS = [
  "ALTER TABLE daily_uptime ADD COLUMN latency_sum INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE daily_uptime ADD COLUMN latency_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE daily_uptime ADD COLUMN latency_min INTEGER",
  "ALTER TABLE daily_uptime ADD COLUMN latency_max INTEGER",
];

export async function ensureSchema(db: D1Database): Promise<void> {
  try {
    const row = await db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").first<{ value: string }>();
    if (row?.value === SCHEMA_VERSION) return;
  } catch {
    /* tables may not exist yet */
  }
  await db.batch(STATEMENTS.map((sql) => db.prepare(sql)));
  for (const sql of ALTERS) {
    try {
      await db.prepare(sql).run();
    } catch {
      /* column already present on fresh CREATE */
    }
  }
  await db
    .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(SCHEMA_VERSION)
    .run();
}
