import { describe, expect, it } from "vitest";
import { classifyTables } from "./init.mjs";

const OWNED = [
  "alert_channels", "audit_log", "check_latest", "check_runs", "component_state", "daily_uptime", "heartbeats", "incident_updates",
  "incidents", "maintenance", "meta", "monitors", "ops_auth_throttle", "ops_sessions", "ops_users", "site_settings",
];

describe("reusing an existing D1 database", () => {
  it("takes an empty database, ignoring SQLite and D1 bookkeeping tables", () => {
    expect(classifyTables([])).toMatchObject({ ok: true, kind: "empty" });
    expect(classifyTables(["sqlite_sequence", "d1_migrations", "_cf_KV"])).toMatchObject({ ok: true, kind: "empty", user: [] });
  });

  it("recognises a full Foxwatch schema", () => {
    expect(classifyTables([...OWNED, "d1_migrations"])).toMatchObject({ ok: true, kind: "foxwatch", missing: [], foreign: [] });
  });

  it("accepts a partial schema and names what is missing", () => {
    const verdict = classifyTables(OWNED.filter((name) => name !== "maintenance" && name !== "alert_channels"));
    expect(verdict).toMatchObject({ ok: true, kind: "partial", missing: ["alert_channels", "maintenance"] });
  });

  it("refuses a database holding anyone else's tables", () => {
    const verdict = classifyTables([...OWNED, "users", "orders"]);
    expect(verdict).toMatchObject({ ok: false, kind: "foreign", foreign: ["orders", "users"] });
    expect(classifyTables(["users"])).toMatchObject({ ok: false, kind: "foreign" });
  });
});
