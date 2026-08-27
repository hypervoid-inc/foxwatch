#!/usr/bin/env node
/**
 * Creates D1, KV, and Queue on *your* Cloudflare account.
 * IDs go to gitignored wrangler.cloud.jsonc. wrangler.jsonc stays empty.
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { writeCloudIds, cloudWranglerPath, d1DatabaseName, KV_NAMESPACE_TITLE, alertsQueueName } from "./cloud-ids.mjs";
import { parseJsonBlob, runWrangler } from "./run.mjs";

const DB_NAME = d1DatabaseName();
const KV_TITLE = KV_NAMESPACE_TITLE;
const QUEUE_NAME = alertsQueueName();
const YES = process.argv.includes("--yes");

/** Tables Foxwatch owns. sqlite_* / d1_migrations are ignored. */
const FOXWATCH_TABLES = new Set([
  "monitors",
  "check_latest",
  "check_runs",
  "component_state",
  "daily_uptime",
  "incidents",
  "incident_updates",
  "heartbeats",
  "audit_log",
  "site_settings",
  "maintenance",
  "alert_channels",
  "meta",
  "ops_users",
  "ops_sessions",
  "ops_auth_throttle",
]);

const IN_CI = Boolean(process.env.GITHUB_ACTIONS);

function showId(id) {
  return IN_CI ? "(omitted in CI logs)" : id;
}

function ignoreTable(name) {
  return name.startsWith("sqlite_") || name === "d1_migrations" || name.startsWith("_cf_");
}

export function classifyTables(names) {
  const user = names.filter((n) => !ignoreTable(n));
  const foreign = user.filter((n) => !FOXWATCH_TABLES.has(n));
  const present = user.filter((n) => FOXWATCH_TABLES.has(n));
  const missing = [...FOXWATCH_TABLES].filter((n) => !present.includes(n)).sort();
  if (foreign.length) {
    return { ok: false, kind: "foreign", user, foreign: foreign.sort(), missing, present };
  }
  if (user.length === 0) return { ok: true, kind: "empty", user, foreign: [], missing, present };
  if (missing.length) return { ok: true, kind: "partial", user, foreign: [], missing, present };
  return { ok: true, kind: "foxwatch", user, foreign: [], missing: [], present };
}

async function confirm(question) {
  if (YES) return true;
  if (!input.isTTY) {
    console.error(`${question}\nNon-interactive shell: pass --yes to reuse a compatible existing database.`);
    process.exit(1);
  }
  const rl = createInterface({ input, output });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function listD1() {
  const raw = runWrangler(["d1", "list", "--json"]);
  const rows = parseJsonBlob(raw);
  return Array.isArray(rows) ? rows : [];
}

function listKv() {
  const raw = runWrangler(["kv", "namespace", "list"]);
  const rows = parseJsonBlob(raw);
  return Array.isArray(rows) ? rows : [];
}

function listQueues() {
  try {
    const raw = runWrangler(["queues", "list"]);
    if (raw.includes(QUEUE_NAME)) return [QUEUE_NAME];
    try {
      const parsed = parseJsonBlob(raw);
      const names = (Array.isArray(parsed) ? parsed : parsed.queues ?? parsed.result ?? [])
        .map((q) => q.queue_name ?? q.name ?? q)
        .filter((n) => typeof n === "string");
      return names;
    } catch {
      return raw.includes(QUEUE_NAME) ? [QUEUE_NAME] : [];
    }
  } catch {
    return [];
  }
}

function pickId(text, patterns) {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[1]) return m[1];
  }
  return null;
}

function d1Tables(databaseId) {
  const raw = runWrangler([
    "d1",
    "execute",
    databaseId,
    "--remote",
    "--json",
    "--command",
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ]);
  const json = parseJsonBlob(raw);
  const block = Array.isArray(json) ? json[0] : json;
  const results = block?.results ?? block?.result ?? [];
  return results.map((row) => row.name).filter(Boolean);
}

function printDb(db) {
  const extra = db.num_tables != null ? `, ${db.num_tables} table(s)` : "";
  console.log(`  name: ${db.name}`);
  console.log(`  id:   ${showId(db.uuid ?? db.id)}${extra}`);
}

async function ensureD1() {
  const existing = listD1().find((r) => r.name === DB_NAME);
  if (!existing) {
    console.log(`Creating D1 database ${DB_NAME}…`);
    const out = runWrangler(["d1", "create", DB_NAME]);
    const id = pickId(out, [/database_id\s*=\s*"([^"]+)"/, /"database_id":\s*"([^"]+)"/, /"uuid":\s*"([^"]+)"/]);
    if (!id) {
      console.error(out);
      process.exit(1);
    }
    console.log(`Created D1 ${DB_NAME} (${showId(id)})`);
    return id;
  }

  const id = existing.uuid ?? existing.id;
  console.log(`D1 database "${DB_NAME}" already exists:`);
  printDb({ ...existing, uuid: id });

  let tables = [];
  try {
    tables = d1Tables(id);
  } catch (err) {
    console.error("Could not inspect tables on that database.");
    console.error(err.output ?? err.message);
    process.exit(1);
  }

  const verdict = classifyTables(tables);
  if (verdict.kind === "empty") {
    console.log("  tables: (empty — Foxwatch migrations can be applied)");
  } else if (verdict.kind === "foxwatch") {
    console.log(`  tables: Foxwatch schema (${verdict.present.length} tables)`);
  } else if (verdict.kind === "partial") {
    console.log(`  tables: partial Foxwatch schema (missing ${verdict.missing.join(", ")})`);
    console.log("  remaining migrations can be applied");
  } else {
    console.error("  tables do not match Foxwatch. Refusing to reuse this database:");
    console.error(`    unexpected: ${verdict.foreign.join(", ")}`);
    if (verdict.present.length) console.error(`    foxwatch-like: ${verdict.present.join(", ")}`);
    console.error("Rename or delete it, then retry. Foxwatch will not migrate over unrelated data.");
    process.exit(1);
  }

  if (!(await confirm("Use this existing D1 database for Foxwatch?"))) {
    console.error("Aborted. Rename or delete the existing database and retry.");
    process.exit(1);
  }
  return id;
}

async function ensureKv() {
  const rows = listKv();
  const found = rows.find((r) => r.title === KV_TITLE);
  if (!found) {
    console.log(`Creating KV namespace ${KV_TITLE}…`);
    const out = runWrangler(["kv", "namespace", "create", KV_TITLE]);
    const id = pickId(out, [/id\s*=\s*"([^"]+)"/, /"id":\s*"([^"]+)"/]);
    if (!id) {
      console.error(out);
      process.exit(1);
    }
    console.log(`Created KV ${KV_TITLE} (${showId(id)})`);
    return id;
  }

  console.log(`KV namespace already exists:`);
  console.log(`  title: ${found.title}`);
  console.log(`  id:    ${showId(found.id)}`);
  if (!(await confirm("Use this existing KV namespace for Foxwatch status snapshots?"))) {
    console.error("Aborted. Create a differently titled namespace or delete this one, then retry.");
    process.exit(1);
  }
  return found.id;
}

function ensureQueue() {
  const names = listQueues();
  if (names.includes(QUEUE_NAME)) {
    console.log(`Queue ${QUEUE_NAME} already exists; reusing.`);
    return;
  }
  console.log(`Creating queue ${QUEUE_NAME}…`);
  try {
    runWrangler(["queues", "create", QUEUE_NAME]);
  } catch (err) {
    const text = err.output ?? err.message ?? "";
    if (text.includes("already taken") || text.includes("already exists")) {
      console.log(`Queue ${QUEUE_NAME} already exists; reusing.`);
      return;
    }
    throw err;
  }
}

function applyMigrations() {
  console.log("Applying D1 migrations…");
  try {
    process.stdout.write(
      runWrangler(["d1", "migrations", "apply", "DB", "--remote", "--config", cloudWranglerPath]),
    );
  } catch (err) {
    console.error("Could not apply remote migrations (first Worker request will still create tables).");
    console.error(err.output ?? err.message);
  }
}

async function main() {
  try {
    process.stdout.write(runWrangler(["whoami"]));
  } catch (err) {
    console.error(err.output ?? err.message);
    console.error(
      "Not logged in to Cloudflare. Run `pnpm exec wrangler login`, or in CI set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.",
    );
    process.exit(1);
  }

  const d1Id = await ensureD1();
  const kvId = await ensureKv();
  ensureQueue();
  writeCloudIds({ database_id: d1Id, kv_id: kvId });
  applyMigrations();

  console.log(`
Wrote your Cloudflare resource IDs to gitignored wrangler.cloud.jsonc
(and .foxwatch-cloud.json). wrangler.jsonc is unchanged — clones never see these IDs.

Next:
  pnpm deploy
  Open /admin and create the first superadmin (email + password).
`);
}

await main();
