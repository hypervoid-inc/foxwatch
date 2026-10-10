// A D1-shaped wrapper over node:sqlite so account and route logic can run its
// real SQL in tests. node:sqlite is missing or flagged on older Node 22 releases.
import { ensureSchema } from "../src/lib/ensure-schema.ts";

const sqlite = await import("node:sqlite").catch(() => null);

export const hasSqlite = sqlite != null;

type Value = string | number | null;

export type TestDb = {
  DB: D1Database;
  /** Run SQL directly, bypassing the failure switch. */
  query: <T = Record<string, unknown>>(sql: string, ...args: Value[]) => T[];
  /** Run a script of several statements, such as a migration file. */
  exec: (sql: string) => void;
  /** While set, every D1 call rejects, like an unavailable database. */
  failing: boolean;
};

/** `schema: false` leaves the database empty, for tests of how the schema gets built. */
export async function testDb(opts: { schema?: boolean } = {}): Promise<TestDb> {
  const db = new sqlite!.DatabaseSync(":memory:");
  const handle = { failing: false } as TestDb;
  const guard = () => {
    if (handle.failing) throw new Error("D1_ERROR: unavailable");
  };
  const exec = (sql: string, args: Value[]) => {
    const results = db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
    const changes = Number((db.prepare("SELECT changes() AS c").get() as { c: number }).c);
    return { success: true, meta: { changes }, results };
  };
  const prepare = (sql: string) => {
    let args: Value[] = [];
    const statement = {
      sql,
      get args() {
        return args;
      },
      bind: (...values: Value[]) => {
        args = values;
        return statement;
      },
      run: async () => {
        guard();
        return exec(sql, args);
      },
      all: async () => {
        guard();
        return exec(sql, args);
      },
      raw: async () => {
        guard();
        return exec(sql, args).results.map((row) => Object.values(row));
      },
      first: async (column?: string) => {
        guard();
        const row = exec(sql, args).results[0];
        if (!row) return null;
        return column ? row[column] : row;
      },
    };
    return statement;
  };
  const batch = async (statements: Array<{ sql: string; args: Value[] }>) => {
    guard();
    db.exec("BEGIN");
    try {
      const out = statements.map((s) => exec(s.sql, s.args));
      db.exec("COMMIT");
      return out;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };
  handle.DB = { prepare, batch } as unknown as D1Database;
  handle.query = <T,>(sql: string, ...args: Value[]) => db.prepare(sql).all(...args) as T[];
  handle.exec = (sql: string) => db.exec(sql);
  if (opts.schema !== false) await ensureSchema(handle.DB);
  return handle;
}
