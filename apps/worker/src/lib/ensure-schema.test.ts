import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hasSqlite, testDb, type TestDb } from "../../test/sqlite-d1.ts";
import { ensureSchema, MIGRATIONS } from "./ensure-schema.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../../migrations/", import.meta.url));
const BASELINE = readFileSync(fileURLToPath(new URL("../../../../scripts/baseline-migrations.sql", import.meta.url)), "utf8");
const FILES = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort();

/** What `wrangler d1 migrations apply` does: run each file not yet recorded, then record it. */
function applyMigrations(db: TestDb, files = FILES): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS d1_migrations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);
  const applied = new Set(db.query<{ name: string }>("SELECT name FROM d1_migrations").map((row) => row.name));
  const ran: string[] = [];
  for (const name of files) {
    if (applied.has(name)) continue;
    db.exec(readFileSync(`${MIGRATIONS_DIR}${name}`, "utf8"));
    db.query("INSERT INTO d1_migrations (name) VALUES (?)", name);
    ran.push(name);
  }
  return ran;
}

/** Tables with their columns, and indexes, in an order that does not depend on how they were added. */
function shape(db: TestDb) {
  const tables = db
    .query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map(({ name }) => ({
      name,
      columns: db
        .query<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>(`PRAGMA table_info(${name})`)
        .map((c) => `${c.name} ${c.type} notnull=${c.notnull} default=${c.dflt_value} pk=${c.pk}`)
        .sort(),
    }));
  const indexes = db
    .query<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name")
    .map((row) => row.sql.replace(/\s+/g, " ").trim());
  return { tables, indexes };
}

describe.skipIf(!hasSqlite)("schema bootstrap and migrations", () => {
  it("lists every migration file", () => {
    expect(MIGRATIONS).toEqual(FILES);
  });

  it("builds the same schema from the Worker as from the migrations", async () => {
    const worker = await testDb();
    const migrated = await testDb({ schema: false });
    expect(applyMigrations(migrated)).toEqual(FILES);
    expect(shape(migrated)).toEqual(shape(worker));
    await ensureSchema(migrated.DB);
    expect(shape(migrated)).toEqual(shape(worker));
  });

  it("leaves nothing for the migrations to apply once the Worker has built the schema", async () => {
    const db = await testDb();
    expect(db.query<{ name: string }>("SELECT name FROM d1_migrations ORDER BY id").map((row) => row.name)).toEqual(FILES);
    const before = shape(db);
    expect(applyMigrations(db)).toEqual([]);
    expect(shape(db)).toEqual(before);
  });

  it("runs after the migrations without recording anything twice", async () => {
    const db = await testDb({ schema: false });
    applyMigrations(db);
    await ensureSchema(db.DB);
    await ensureSchema(db.DB);
    expect(db.query("SELECT name FROM d1_migrations")).toHaveLength(FILES.length);
  });

  it("picks up where a partly migrated database stopped", async () => {
    const db = await testDb({ schema: false });
    applyMigrations(db, FILES.slice(0, 2));
    db.query("INSERT INTO daily_uptime (component_id, date, ok, total) VALUES ('api', '2026-01-01', 3, 4)");
    await ensureSchema(db.DB);
    expect(applyMigrations(db)).toEqual([]);
    expect(shape(db)).toEqual(shape(await testDb()));
    expect(db.query("SELECT ok, total, latency_sum FROM daily_uptime")).toEqual([{ ok: 3, total: 4, latency_sum: 0 }]);
  });

  it("records nothing when a column could not be added, and finishes on the next attempt", async () => {
    const db = await testDb({ schema: false });
    applyMigrations(db, FILES.slice(0, 2));
    const prepare = db.DB.prepare.bind(db.DB);
    (db.DB as { prepare: unknown }).prepare = (sql: string) => {
      if (/ADD COLUMN consecutive_changes/.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    };
    await expect(ensureSchema(db.DB)).rejects.toThrow(/connection lost/);
    expect(db.query("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual([]);
    expect(db.query("SELECT name FROM d1_migrations")).toHaveLength(2);
    (db.DB as { prepare: unknown }).prepare = prepare;
    await ensureSchema(db.DB);
    expect(applyMigrations(db)).toEqual([]);
    expect(shape(db)).toEqual(shape(await testDb()));
  });

  it("baselines a database an older Worker built, which has the columns but no history", async () => {
    const db = await testDb();
    db.exec("DROP TABLE d1_migrations");
    // Without the baseline, apply stops on the first column that already exists.
    const blocked = await testDb();
    blocked.exec("DROP TABLE d1_migrations");
    expect(() => applyMigrations(blocked)).toThrow(/duplicate column/);

    db.exec(BASELINE);
    const recorded = db.query<{ name: string }>("SELECT name FROM d1_migrations ORDER BY name").map((row) => row.name);
    expect(recorded).toEqual(FILES.filter((name) => /ADD COLUMN/.test(readFileSync(`${MIGRATIONS_DIR}${name}`, "utf8"))));
    const before = shape(db);
    // The rest are CREATE ... IF NOT EXISTS and change nothing.
    expect(applyMigrations(db)).toEqual(FILES.filter((name) => !recorded.includes(name)));
    expect(shape(db)).toEqual(before);
  });

  it("baselines nothing on an empty database or a migrated one", async () => {
    const empty = await testDb({ schema: false });
    empty.exec(BASELINE);
    expect(empty.query("SELECT name FROM d1_migrations")).toEqual([]);
    expect(applyMigrations(empty)).toEqual(FILES);

    const partial = await testDb({ schema: false });
    applyMigrations(partial, FILES.slice(0, 4));
    partial.exec(BASELINE);
    expect(applyMigrations(partial)).toEqual(FILES.slice(4));
  });

  it("indexes the lookups by incident, component and heartbeat token", async () => {
    const db = await testDb();
    const plan = (sql: string) => db.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`).map((row) => row.detail).join(" ");
    expect(plan("SELECT * FROM incident_updates WHERE incident_id IN ('a', 'b')")).toContain("idx_incident_updates_incident");
    expect(plan("SELECT * FROM maintenance WHERE component_id = 'api'")).toContain("idx_maintenance_component");
    expect(plan("SELECT * FROM heartbeats WHERE token_hash = 'x'")).toContain("idx_heartbeats_token");
  });
});
