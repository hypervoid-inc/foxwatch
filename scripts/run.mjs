import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { root } from "./cloud-ids.mjs";

export const wranglerBin = resolve(root, "node_modules/wrangler/bin/wrangler.js");
export const viteBin = resolve(root, "node_modules/vite/bin/vite.js");

export function runWrangler(args) {
  try {
    const out = execFileSync(process.execPath, [wranglerBin, ...args], {
      encoding: "utf8",
      cwd: root,
      stdio: ["ignore", "pipe", "inherit"],
    });
    return String(out ?? "");
  } catch (err) {
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}`;
    const wrapped = new Error(output.trim() || `wrangler ${args.join(" ")} failed`);
    wrapped.output = output;
    wrapped.status = err.status;
    throw wrapped;
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
