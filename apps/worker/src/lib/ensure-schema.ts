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
  confirmed_outcome TEXT,
  consecutive_changes INTEGER NOT NULL DEFAULT 0,
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
  `CREATE TABLE IF NOT EXISTS check_runs (
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
)`,
  `CREATE TABLE IF NOT EXISTS component_state (
  component_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  pending_json TEXT,
  pending_lease INTEGER
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
  component_ids_json TEXT,
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
  `CREATE INDEX IF NOT EXISTS idx_check_runs_monitor_time ON check_runs(monitor_id, checked_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_check_runs_time ON check_runs(checked_at)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ops_sessions_user ON ops_sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ops_sessions_expires ON ops_sessions(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ops_auth_throttle_reset ON ops_auth_throttle(reset_at)`,
  `CREATE INDEX IF NOT EXISTS idx_incident_updates_incident ON incident_updates(incident_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_maintenance_component ON maintenance(component_id, end_at)`,
  `CREATE INDEX IF NOT EXISTS idx_heartbeats_token ON heartbeats(token_hash)`,
];

const SCHEMA_VERSION = "9";

// Every file in migrations/, oldest first. ensureSchema and the migrations build
// the same schema and either may reach a database first. Once ensureSchema has
// run, it records the files as applied in Wrangler's own table, so a later
// `wrangler d1 migrations apply` does not stop on a column that already exists.
// A migration added here must be fully covered by STATEMENTS, ALTERS and the
// data fixes below.
export const MIGRATIONS = [
  "0001_init.sql",
  "0002_ops_accounts.sql",
  "0003_daily_latency.sql",
  "0004_daily_latency_range.sql",
  "0005_monitor_state.sql",
  "0006_history_incident_components.sql",
  "0007_auth_pruning.sql",
  "0008_monitor_confirmation.sql",
  "0009_lookup_indexes.sql",
];

// Same definition Wrangler uses, so its own CREATE TABLE IF NOT EXISTS is a no-op.
const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS d1_migrations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

const ALTERS = [
  "ALTER TABLE daily_uptime ADD COLUMN latency_sum INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE daily_uptime ADD COLUMN latency_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE daily_uptime ADD COLUMN latency_min INTEGER",
  "ALTER TABLE daily_uptime ADD COLUMN latency_max INTEGER",
  "ALTER TABLE monitors ADD COLUMN confirmed_outcome TEXT",
  "ALTER TABLE incidents ADD COLUMN component_ids_json TEXT",
  "ALTER TABLE monitors ADD COLUMN consecutive_changes INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE component_state ADD COLUMN pending_json TEXT",
  "ALTER TABLE component_state ADD COLUMN pending_lease INTEGER",
];

// One check per isolate. A failed attempt is forgotten so the next request tries again.
const ready = new WeakMap<D1Database, Promise<void>>();

export function ensureSchema(db: D1Database): Promise<void> {
  let pending = ready.get(db);
  if (!pending) {
    pending = buildSchema(db);
    ready.set(db, pending);
    pending.catch(() => {
      if (ready.get(db) === pending) ready.delete(db);
    });
  }
  return pending;
}

async function buildSchema(db: D1Database): Promise<void> {
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
    } catch (error) {
      // Only a column that is already there may be skipped. Anything else must
      // fail the build before the version and the migration history are written.
      if (!/duplicate column name/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
  // Versions before 6 accepted secret values into site_settings. They cannot
  // be safely re-encrypted without a deployment-owned key, so remove them and
  // require Worker secrets, matching the documented security model.
  await db.prepare("DELETE FROM site_settings WHERE key = 'secret_values'").run();
  const migrationTime = Date.now();
  await db.prepare(`UPDATE incidents SET status = 'resolved', resolved_at = ?
    WHERE auto = 1 AND resolved_at IS NULL AND rowid NOT IN (
      SELECT MAX(rowid) FROM incidents WHERE auto = 1 AND resolved_at IS NULL GROUP BY component_id
    )`).bind(migrationTime).run();
  await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_auto_incident ON incidents(component_id) WHERE auto = 1 AND resolved_at IS NULL").run();
  await db.batch([
    db.prepare(MIGRATIONS_TABLE),
    ...MIGRATIONS.map((name) => db.prepare("INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)").bind(name)),
  ]);
  await db
    .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(SCHEMA_VERSION)
    .run();
}
