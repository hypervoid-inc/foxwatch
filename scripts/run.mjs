import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { root } from "./cloud-ids.mjs";

export const wranglerBin = resolve(root, "node_modules/wrangler/bin/wrangler.js");
export const viteBin = resolve(root, "node_modules/vite/bin/vite.js");

/**
 * Runs Wrangler and returns its stdout. stderr is captured too: a failure
 * carries both streams on `err.output` so callers can match on Wrangler's own
 * message, and a success passes stderr (warnings) through.
 */
export function runWrangler(args) {
  const result = spawnSync(process.execPath, [wranglerBin, ...args], {
    encoding: "utf8",
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw wranglerError(args, result);
  if (result.stderr) process.stderr.write(result.stderr);
  return String(result.stdout ?? "");
}

export function wranglerError(args, { stdout, stderr, status, error }) {
  const output = [stdout, stderr, error?.message].filter(Boolean).join("\n");
  const wrapped = new Error(output.trim() || `wrangler ${args.join(" ")} failed`);
  wrapped.output = output;
  wrapped.status = status;
  return wrapped;
}

/** Wrangler's wording when `queues create` meets a queue that is already there. */
export function isAlreadyExists(text) {
  return /already (taken|exists)/i.test(text);
}

/**
 * Queue names in `wrangler queues list` output, JSON or the printed table.
 * Whole names only, so `foxwatch-alerts-dlq` is not taken for `foxwatch-alerts`.
 */
export function queueNames(raw) {
  try {
    const parsed = parseJsonBlob(raw);
    const rows = Array.isArray(parsed) ? parsed : parsed.queues ?? parsed.result ?? [];
    if (Array.isArray(rows)) {
      return rows.map((q) => q?.queue_name ?? q?.name ?? q).filter((n) => typeof n === "string");
    }
  } catch {
    // Not JSON: fall through to the table.
  }
  return raw.split(/[^A-Za-z0-9_-]+/).filter(Boolean);
}

/**
 * Run before `d1 migrations apply`. A database the Worker built for itself has
 * the schema but no migration history, and apply would stop on its first
 * ADD COLUMN. See baseline-migrations.sql. A failure here only means apply runs
 * against the history as it is.
 */
export function baselineMigrations(configPath) {
  const sql = readFileSync(resolve(root, "scripts/baseline-migrations.sql"), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  try {
    execFileSync(
      process.execPath,
      [wranglerBin, "d1", "execute", "DB", "--remote", "--yes", "--config", configPath, "--command", sql],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    console.warn("Could not check the D1 migration history. Applying migrations as they are.");
  }
}

export function runVite(args) {
  const result = execFileSync(process.execPath, [viteBin, ...args], {
    cwd: root,
    stdio: "inherit",
  });
  return result;
}

export function parseJsonBlob(text) {
  const start = text.search(/[\[{]/);
  if (start < 0) throw new Error(`Expected JSON:\n${text}`);
  return JSON.parse(text.slice(start));
}
