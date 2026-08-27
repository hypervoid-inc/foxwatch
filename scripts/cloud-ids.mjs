#!/usr/bin/env node
/**
 * Committed wrangler.jsonc omits D1/KV IDs so the public template never
 * contains account-specific values. Empty strings are invalid — Wrangler
 * requires the field to be absent, not `""`.
 *
 * Wrangler auth in CI: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID.
 * Optional pin: FOXWATCH_D1_DATABASE_ID + FOXWATCH_KV_NAMESPACE_ID.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const cloudIdsPath = resolve(root, ".foxwatch-cloud.json");
export const cloudWranglerPath = resolve(root, "wrangler.cloud.jsonc");
export const wranglerPath = resolve(root, "wrangler.jsonc");

/** KV has no title field in Wrangler; this is the namespace name init creates. */
export const KV_NAMESPACE_TITLE = "foxwatch-status";

export function workerName() {
  return /"name"\s*:\s*"([^"]+)"/.exec(readWranglerText())?.[1] ?? "foxwatch";
}

export function d1DatabaseName() {
  return /"database_name"\s*:\s*"([^"]+)"/.exec(readWranglerText())?.[1] ?? "foxwatch-data";
}

export function alertsQueueName() {
  return /"queue"\s*:\s*"([^"]+)"/.exec(readWranglerText())?.[1] ?? "foxwatch-alerts";
}

export function builtWranglerPath() {
  return resolve(root, "dist", workerName(), "wrangler.json");
}

export function isRealId(value) {
  return typeof value === "string" && value.trim() !== "" && value !== "local-dev-only";
}

export function readCloudIds() {
  const database_id = process.env.FOXWATCH_D1_DATABASE_ID;
  const kv_id = process.env.FOXWATCH_KV_NAMESPACE_ID;
  if (isRealId(database_id) && isRealId(kv_id)) return { database_id, kv_id };

  if (existsSync(cloudIdsPath)) {
    const parsed = JSON.parse(readFileSync(cloudIdsPath, "utf8"));
    if (isRealId(parsed.database_id) && isRealId(parsed.kv_id)) {
      return { database_id: String(parsed.database_id), kv_id: String(parsed.kv_id) };
    }
  }

  return idsFromWranglerText(readWranglerText());
}

export function idsFromWranglerJson(path) {
  if (!existsSync(path)) return null;
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  const database_id = cfg.d1_databases?.find((db) => db.binding === "DB")?.database_id;
  const kv_id = cfg.kv_namespaces?.find((kv) => kv.binding === "STATUS")?.id;
  if (!isRealId(database_id) || !isRealId(kv_id)) return null;
  return { database_id, kv_id };
}

export function writeCloudIds({ database_id, kv_id }) {
  writeFileSync(cloudIdsPath, `${JSON.stringify({ database_id, kv_id }, null, 2)}\n`);
  writeCloudWrangler({ database_id, kv_id });
}

/** Gitignored Wrangler config with real IDs. Used via `wrangler --config wrangler.cloud.jsonc`. */
export function writeCloudWrangler({ database_id, kv_id }) {
  let text = readWranglerText();
  text = upsertJsoncField(text, "database_id", database_id, /("database_name"\s*:\s*"[^"]*")/);
  if (/"kv_namespaces"[\s\S]*?"id"\s*:\s*"[^"]*"/.test(text)) {
    text = text.replace(/("kv_namespaces"[\s\S]*?"id"\s*:\s*")[^"]*"/, `$1${kv_id}"`);
  } else {
    text = text.replace(/("kv_namespaces"\s*:\s*\[\s*\{\s*"binding"\s*:\s*"STATUS")/, `$1,\n      "id": "${kv_id}"`);
  }
  writeFileSync(cloudWranglerPath, text);
}

function upsertJsoncField(text, key, value, after) {
  const re = new RegExp(`("${key}"\\s*:\\s*")[^"]*"`);
  if (re.test(text)) return text.replace(re, `$1${value}"`);
  return text.replace(after, `$1,\n      "${key}": "${value}"`);
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

function readWranglerText() {
  return readFileSync(wranglerPath, "utf8");
}

function idsFromWranglerText(text) {
  const database_id = /"database_id"\s*:\s*"([^"]*)"/.exec(text)?.[1];
  const kv_id = /"kv_namespaces"[\s\S]*?"id"\s*:\s*"([^"]*)"/.exec(text)?.[1];
  if (!isRealId(database_id) || !isRealId(kv_id)) return null;
  return { database_id, kv_id };
}
