#!/usr/bin/env node
/**
 * Cloud resource IDs must never live in committed wrangler.jsonc.
 *
 * Wrangler only reads D1/KV IDs from a Wrangler config file (`--config`).
 * Source: https://developers.cloudflare.com/workers/wrangler/commands/d1/#d1-migrations-apply
 * (`d1 migrations apply` takes the DB name or binding, resolved from that config).
 *
 * Local: gitignored wrangler.cloud.jsonc (copy of wrangler.jsonc with real IDs)
 *        plus .foxwatch-cloud.json for scripts/CI.
 * CI: FOXWATCH_D1_DATABASE_ID + FOXWATCH_KV_NAMESPACE_ID.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const cloudIdsPath = resolve(root, ".foxwatch-cloud.json");
export const cloudWranglerPath = resolve(root, "wrangler.cloud.jsonc");
export const wranglerPath = resolve(root, "wrangler.jsonc");

export function workerName() {
  return /"name"\s*:\s*"([^"]+)"/.exec(readFileSync(wranglerPath, "utf8"))?.[1] ?? "foxwatch";
}

export function builtWranglerPath() {
  return resolve(root, "dist", workerName(), "wrangler.json");
}

export function readCloudIds() {
  const database_id = process.env.FOXWATCH_D1_DATABASE_ID;
  const kv_id = process.env.FOXWATCH_KV_NAMESPACE_ID;
  if (database_id && kv_id) return { database_id, kv_id };

  if (!existsSync(cloudIdsPath)) return null;
  const parsed = JSON.parse(readFileSync(cloudIdsPath, "utf8"));
  if (!parsed.database_id || !parsed.kv_id) return null;
  return { database_id: String(parsed.database_id), kv_id: String(parsed.kv_id) };
}

export function writeCloudIds({ database_id, kv_id }) {
  writeFileSync(cloudIdsPath, `${JSON.stringify({ database_id, kv_id }, null, 2)}\n`);
  writeCloudWrangler({ database_id, kv_id });
}

/** Gitignored Wrangler config with real IDs. Used via `wrangler --config wrangler.cloud.jsonc`. */
export function writeCloudWrangler({ database_id, kv_id }) {
  let text = readFileSync(wranglerPath, "utf8");
  text = text.replace(/("database_id"\s*:\s*")[^"]+"/, `$1${database_id}"`);
  text = text.replace(/("kv_namespaces"[\s\S]*?"id"\s*:\s*")[^"]+"/, `$1${kv_id}"`);
  writeFileSync(cloudWranglerPath, text);
}

export function applyCloudIds(wranglerJsonPath, { database_id, kv_id }) {
  const cfg = JSON.parse(readFileSync(wranglerJsonPath, "utf8"));
  for (const db of cfg.d1_databases ?? []) {
    if (db.binding === "DB") db.database_id = database_id;
  }
  for (const kv of cfg.kv_namespaces ?? []) {
    if (kv.binding === "STATUS") kv.id = kv_id;
  }
  writeFileSync(wranglerJsonPath, `${JSON.stringify(cfg)}\n`);
}
