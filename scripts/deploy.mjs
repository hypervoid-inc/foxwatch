#!/usr/bin/env node
/**
 * Build, inject D1/KV IDs into the Vite output, deploy. Never writes IDs into
 * committed wrangler.jsonc.
 *
 * ID sources, in order: GitHub secrets, gitignored .foxwatch-cloud.json,
 * wrangler.jsonc (Deploy to Cloudflare injects IDs on the user's clone),
 * then Wrangler auto-provision on deploy when IDs are still empty.
 */
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  alertsQueueName,
  applyCloudIds,
  builtWranglerPath,
  cloudWranglerPath,
  d1DatabaseName,
  idsFromWranglerJson,
  KV_NAMESPACE_TITLE,
  readCloudIds,
  root,
  writeCloudWrangler,
} from "./cloud-ids.mjs";
import { baselineMigrations, isAlreadyExists, parseJsonBlob, runVite, runWrangler, wranglerBin } from "./run.mjs";

const queueName = alertsQueueName();
ensureQueue(queueName);

const known = readCloudIds();
if (known) {
  deployWithIds(known);
} else {
  deployByProvisioning();
}

function deployWithIds(ids) {
  writeCloudWrangler(ids);
  // Build first: a bundling failure must stop the run before production D1 is migrated.
  runVite(["build"]);
  const built = requireBuilt();
  applyCloudIds(built, ids);
  applyRemoteMigrations();
  wranglerDeploy(built);
}

function deployByProvisioning() {
  console.log("No D1/KV IDs in secrets or gitignored config. Building, then letting Wrangler provision bindings.");
  runVite(["build"]);
  const built = requireBuilt();
  wranglerDeploy(built);
  const ids = idsFromWranglerJson(built) ?? lookupIdsByName() ?? readCloudIds();
  if (!ids) {
    console.error(`Could not resolve D1 (${d1DatabaseName()}) or KV (${KV_NAMESPACE_TITLE}) after deploy.
Set FOXWATCH_D1_DATABASE_ID and FOXWATCH_KV_NAMESPACE_ID, or run pnpm foxwatch init.
`);
    process.exit(1);
  }
  writeCloudWrangler(ids);
  applyRemoteMigrations();
}

function requireBuilt() {
  const built = builtWranglerPath();
  if (!existsSync(built)) {
    console.error(`Expected Vite to write ${built}`);
    process.exit(1);
  }
  return built;
}

function wranglerDeploy(configPath) {
  execFileSync(process.execPath, [wranglerBin, "deploy", "-c", configPath], {
    cwd: root,
    stdio: "inherit",
  });
}

function ensureQueue(name) {
  try {
    runWrangler(["queues", "create", name]);
  } catch (err) {
    const text = err.output ?? err.message ?? "";
    if (isAlreadyExists(text)) return;
    // Not fatal here: the queue may still exist, and `wrangler deploy` fails on
    // the binding if it does not. Show why, so that failure is not a mystery.
    console.warn(`Could not create queue ${name}:\n${text.trim()}`);
  }
}

function applyRemoteMigrations() {
  baselineMigrations(cloudWranglerPath);
  execFileSync(
    process.execPath,
    [wranglerBin, "d1", "migrations", "apply", "DB", "--remote", "--config", cloudWranglerPath],
    { cwd: root, stdio: "inherit" },
  );
}

function lookupIdsByName() {
  let d1Rows = [];
  let kvRows = [];
  try {
    const parsed = parseJsonBlob(runWrangler(["d1", "list", "--json"]));
    d1Rows = Array.isArray(parsed) ? parsed : [];
  } catch {
    return null;
  }
  try {
    const parsed = parseJsonBlob(runWrangler(["kv", "namespace", "list"]));
    kvRows = Array.isArray(parsed) ? parsed : [];
  } catch {
    return null;
  }
  const db = d1Rows.find((row) => row.name === d1DatabaseName());
  const kv = kvRows.find((row) => row.title === KV_NAMESPACE_TITLE);
  const database_id = db?.uuid ?? db?.id;
  const kv_id = kv?.id;
  if (!database_id || !kv_id) return null;
  return { database_id: String(database_id), kv_id: String(kv_id) };
}
