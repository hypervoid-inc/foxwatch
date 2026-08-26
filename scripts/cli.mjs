#!/usr/bin/env node
/**
 * foxwatch CLI — create Cloudflare resources for this instance.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const [cmd, ...rest] = process.argv.slice(2);

function usage() {
  console.log(`foxwatch <command>

  init [--yes]   Create D1 / KV / Queue; write IDs to gitignored wrangler.cloud.jsonc
`);
}

if (!cmd || cmd === "-h" || cmd === "--help") {
  usage();
  process.exit(0);
}

if (cmd === "init") {
  const script = resolve(here, "init.mjs");
  const result = spawnSync(process.execPath, [script, ...rest], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

usage();
process.exit(1);
