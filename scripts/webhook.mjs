#!/usr/bin/env node
/**
 * Post a Discord alert using the same payload builder as the Worker.
 *
 *   pnpm webhook -- <discord-webhook-url>
 *   DISCORD_WEBHOOK_URL=... pnpm webhook
 *   pnpm webhook -- --event all --origin https://status.example.com
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVENTS = ["test", "fail", "degrade", "recover"];

function usage() {
  console.log(`Post a Foxwatch Discord webhook card (same builder as production).

Usage:
  pnpm webhook -- <discord-webhook-url>
  DISCORD_WEBHOOK_URL=... pnpm webhook
  pnpm webhook -- --event fail --origin https://your-status-page.example

Options:
  --event, -e   test | fail | degrade | recover | all   (default: fail)
  --origin      Public status page origin for Open incident / Open status page
  --site        Site name shown as the embed author          (default: Acme)
  --dry-run     Print the payload and skip Discord
  --help, -h

The URL can also live in gitignored .dev.vars or .env as DISCORD_WEBHOOK_URL.
Do not commit webhook URLs.
`);
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") process.env[key] = value;
  }
}

function parseArgs(argv) {
  const opts = {
    event: "fail",
    origin: "https://status.example.com",
    site: "Acme",
    dryRun: false,
    help: false,
    url: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--") continue;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--event" || arg === "-e") opts.event = String(argv[++i] ?? "").trim().toLowerCase();
    else if (arg === "--origin") opts.origin = String(argv[++i] ?? "").trim();
    else if (arg === "--site") opts.site = String(argv[++i] ?? "").trim() || opts.site;
    else if (arg.startsWith("--event=")) opts.event = arg.slice("--event=".length).trim().toLowerCase();
    else if (arg.startsWith("--origin=")) opts.origin = arg.slice("--origin=".length).trim();
    else if (arg.startsWith("--site=")) opts.site = arg.slice("--site=".length).trim() || opts.site;
    else if (!arg.startsWith("-") && !opts.url) opts.url = arg;
    else {
      console.error(`Unknown argument: ${arg}`);
      opts.help = true;
      opts.bad = true;
    }
  }
  return opts;
}

function newId() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url").slice(0, 22);
}

function redactWebhook(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const id = parts[2] ?? "?";
    return `${parsed.origin}/api/webhooks/${id}/…`;
  } catch {
    return "(invalid url)";
  }
}

function sampleBodies(opts) {
  const occurredAt = Date.now();
  const incidentId = newId();
  const regions = [
    { region: "wnam", outcome: "fail", latencyMs: 80, statusCode: 503, colo: "SFO", errorClass: "status" },
    { region: "weur", outcome: "fail", latencyMs: 10_000, colo: "AMS", errorClass: "timeout" },
    { region: "apac", outcome: "pass", latencyMs: 41, colo: "NRT" },
  ];
  const monitor = {
    componentId: "api",
    componentName: "Checkout API",
    componentIds: ["api"],
    checkType: "http",
    publicOrigin: opts.origin,
    occurredAt,
  };
  return {
    test: {
      eventId: newId(),
      event: "recover",
      componentId: "test",
      title: "Test alert, delivery is configured",
      occurredAt,
      publicOrigin: opts.origin,
      source: "test",
      componentName: "Test",
    },
    fail: {
      ...monitor,
      eventId: newId(),
      event: "fail",
      title: "api fail",
      source: "monitor",
      consecutiveFails: 3,
      incidentId,
      regions,
    },
    degrade: {
      ...monitor,
      eventId: newId(),
      event: "degrade",
      title: "api degrade",
      source: "monitor",
      consecutiveFails: 2,
      incidentId,
      regions: regions.map((run) =>
        run.outcome === "fail" ? { ...run, outcome: "degraded", errorClass: "latency" } : run,
      ),
    },
    recover: {
      ...monitor,
      eventId: newId(),
      event: "recover",
      title: "api recover",
      source: "monitor",
      incidentId,
      durationMs: 12 * 60_000,
      regions: regions.map((run) => ({ ...run, outcome: "pass", errorClass: undefined, statusCode: 200 })),
    },
  };
}

async function loadAlerts() {
  const vite = await createServer({
    configFile: false,
    root,
    logLevel: "error",
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    resolve: {
      alias: {
        "@foxwatch/engine": resolve(root, "packages/engine/src/index.ts"),
        "@foxwatch/config": resolve(root, "packages/config/src/index.ts"),
      },
    },
  });
  try {
    const alerts = await vite.ssrLoadModule("/apps/worker/src/lib/alerts.ts");
    const engine = await vite.ssrLoadModule("/packages/engine/src/index.ts");
    return { ...alerts, assertSafeUrl: engine.assertSafeUrl };
  } finally {
    await vite.close();
  }
}

async function postDiscord(alerts, webhookUrl, payload, eventId) {
  alerts.assertSafeUrl(webhookUrl, { allowHttpLocal: false });
  const executeUrl = alerts.discordExecuteUrl(webhookUrl, Boolean(payload.components?.length));
  const response = await fetch(executeUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-foxwatch-event-id": eventId },
    body: JSON.stringify(payload),
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`Discord returned ${response.status} ${text.replace(/\s+/g, " ").trim().slice(0, 180)}`);
  }
  return response.status;
}

loadEnvFile(resolve(root, ".dev.vars"));
loadEnvFile(resolve(root, ".env"));

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  usage();
  process.exit(opts.bad ? 1 : 0);
}

const url = opts.url || process.env.DISCORD_WEBHOOK_URL || process.env.FOXWATCH_DISCORD_WEBHOOK_URL || "";
if (!opts.dryRun && !url) {
  console.error("Missing Discord webhook URL.");
  usage();
  process.exit(1);
}

const selected = opts.event === "all" ? EVENTS : [opts.event];
if (selected.some((event) => !EVENTS.includes(event))) {
  console.error(`Unknown event "${opts.event}". Use test, fail, degrade, recover, or all.`);
  process.exit(1);
}

try {
  const alerts = await loadAlerts();
  const ctx = { siteName: opts.site, origin: opts.origin };
  const samples = sampleBodies(opts);
  const foxPath = resolve(root, "public/fox.png");
  const foxPng = existsSync(foxPath) ? new Uint8Array(readFileSync(foxPath)) : undefined;
  if (!opts.dryRun) {
    alerts.assertSafeUrl(url, { allowHttpLocal: false });
    const branded = alerts.pngAvatarDataUri(foxPng);
    await alerts.brandDiscordWebhook(url, undefined, foxPng).catch((error) => {
      console.warn(`brand skipped: ${error instanceof Error ? error.message : error}`);
    });
    console.log(`webhook profile: Foxwatch${branded ? " · fox.png" : " · name only"}`);
  }

  for (const event of selected) {
    const payload = alerts.discordPayload(samples[event], ctx);
    const buttons = payload.components?.[0]?.components.map((button) => button.label).join(", ") || "(none)";
    console.log(`${event}: ${payload.embeds[0]?.title} · avatar ${payload.avatar_url} · buttons: ${buttons}`);
    if (opts.dryRun) {
      console.log(JSON.stringify(payload, null, 2));
      continue;
    }
    const status = await postDiscord(alerts, url, payload, samples[event].eventId);
    console.log(`  posted ${status} → ${redactWebhook(url)}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
