#!/usr/bin/env node
/**
 * Build, inject gitignored cloud resource IDs into the Vite output, deploy.
 * Does not modify committed wrangler.jsonc.
 */
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { applyCloudIds, builtWranglerPath, readCloudIds, root, writeCloudWrangler } from "./cloud-ids.mjs";
import { runVite, wranglerBin } from "./run.mjs";

const ids = readCloudIds();
if (!ids) {
  console.error(`No cloud resource IDs found.

Run \`pnpm foxwatch init\` once (writes gitignored wrangler.cloud.jsonc),
or set FOXWATCH_D1_DATABASE_ID and FOXWATCH_KV_NAMESPACE_ID for CI.
`);
  process.exit(1);
}

writeCloudWrangler(ids);
runVite(["build"]);

const built = builtWranglerPath();
if (!existsSync(built)) {
  console.error(`Expected Vite to write ${built}`);
  process.exit(1);
}
applyCloudIds(built, ids);

execFileSync(process.execPath, [wranglerBin, "deploy", "-c", built], {
  cwd: root,
  stdio: "inherit",
});
