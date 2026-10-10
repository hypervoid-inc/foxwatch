import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cloudWranglerText, idsFromWranglerText, wranglerPath } from "./cloud-ids.mjs";

const committed = readFileSync(wranglerPath, "utf8");
const ids = { database_id: "11111111-2222-3333-4444-555555555555", kv_id: "0123456789abcdef0123456789abcdef" };

/** JSONC as Wrangler reads it: whole-line comments dropped, then plain JSON. */
function parse(text) {
  return JSON.parse(text.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n"));
}

describe("cloud wrangler config", () => {
  it("ships the template without account IDs", () => {
    expect(idsFromWranglerText(committed)).toBeNull();
    expect(committed).not.toContain('"database_id"');
  });

  it("adds both IDs to the committed config and changes nothing else", () => {
    const text = cloudWranglerText(committed, ids);
    const cfg = parse(text);
    expect(cfg.d1_databases).toEqual([{ binding: "DB", database_name: "foxwatch-data", database_id: ids.database_id, migrations_dir: "migrations" }]);
    expect(cfg.kv_namespaces).toEqual([{ binding: "STATUS", id: ids.kv_id }]);
    const before = parse(committed);
    expect({ ...cfg, d1_databases: before.d1_databases, kv_namespaces: before.kv_namespaces }).toEqual(before);
    expect(idsFromWranglerText(text)).toEqual(ids);
  });

  it("replaces IDs that are already there, as on a Deploy to Cloudflare clone", () => {
    const injected = cloudWranglerText(committed, { database_id: "old-db", kv_id: "old-kv" });
    expect(idsFromWranglerText(injected)).toEqual({ database_id: "old-db", kv_id: "old-kv" });
    const text = cloudWranglerText(injected, ids);
    expect(idsFromWranglerText(text)).toEqual(ids);
    expect(text).not.toContain("old-");
  });

  it("treats placeholders as no ID", () => {
    expect(idsFromWranglerText(cloudWranglerText(committed, { database_id: "local-dev-only", kv_id: "" }))).toBeNull();
  });

  it("leaves other namespaces and later id keys alone", () => {
    const other = committed
      .replace('"binding": "STATUS"\n    }', '"binding": "STATUS"\n    },\n    { "binding": "CACHE", "id": "cache-id" }')
      .replace('"binding": "METRICS",', '"binding": "METRICS",\n      "id": "metrics-id",');
    expect(other).toContain("cache-id");
    expect(other).toContain("metrics-id");
    // STATUS has no ID yet: the next "id" in the file belongs to someone else.
    expect(idsFromWranglerText(other.replace('"database_name"', '"database_id": "db", "database_name"'))).toBeNull();
    const cfg = parse(cloudWranglerText(other, ids));
    expect(cfg.kv_namespaces).toEqual([{ binding: "STATUS", id: ids.kv_id }, { binding: "CACHE", id: "cache-id" }]);
    expect(cfg.analytics_engine_datasets[0].id).toBe("metrics-id");
  });
});
