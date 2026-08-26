# Foxwatch

Open-source, Cloudflare-native synthetic monitoring and status pages. Create HTTP and heartbeat checks in the **admin UI**, run them from multiple Cloudflare regions, and publish a public page with **fully operational / degraded / failing**.

This repository is a **GitHub template**. Use it to deploy your own instance. Nothing about a particular company’s hosts, Cloudflare resource IDs, or monitors belongs in this repo — those live in **your** D1 database after you deploy.

**Requires [Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/)** (Durable Objects + Analytics Engine), about $5/month.

Foxwatch observes **from Cloudflare**. A global Cloudflare outage takes the observer down with the target. That is an explicit tradeoff, not a bug.

## Quick start (local)

Needs [Node 20+](https://nodejs.org/) and [pnpm](https://pnpm.io/installation). No Cloudflare login, no secrets.

```bash
pnpm install
pnpm dev
```

- Public status: [http://localhost:5173/](http://localhost:5173/)
- Admin: [http://localhost:5173/admin](http://localhost:5173/admin) — first visit creates a superadmin (email + password); later visits sign in

A new instance has no checks and is named **Foxwatch** until you change it under **Settings**. Add monitors from **Checks**. Superadmins can add more operator accounts under **Settings → Operators**.

Optional: copy `.dev.vars.example` to `.dev.vars` if you need `ALLOW_HTTP_LOCAL=true` (plain `http://` checks) or local header secret values.

## Deploy to your Cloudflare account

```bash
pnpm exec wrangler login
pnpm foxwatch init          # creates D1 / KV / Queue; writes IDs to gitignored wrangler.cloud.jsonc
pnpm deploy                 # injects those IDs into the build output, not wrangler.jsonc
```

If a D1 database named `foxwatch` (or a KV namespace titled `STATUS`) already exists, init lists its id, checks that the D1 tables look like Foxwatch (or empty), and asks before reusing. It will not migrate over a database that already has unrelated tables. Pass `--yes` to skip the prompt in CI after that check still passes.

Open `/admin` on the deployed worker and create the first account there.

`wrangler.jsonc` stays placeholders (`local-dev-only`) so a public clone never gets your D1 or KV IDs. Wrangler only resolves D1 from a config file ([`d1 migrations apply`](https://developers.cloudflare.com/workers/wrangler/commands/d1/#d1-migrations-apply) takes the binding name, plus [`--config`](https://developers.cloudflare.com/workers/wrangler/commands/general/)), so init writes **`wrangler.cloud.jsonc`** (gitignored) and runs migrations with `--config wrangler.cloud.jsonc`. CI can set `FOXWATCH_D1_DATABASE_ID` and `FOXWATCH_KV_NAMESPACE_ID` instead of committing IDs.

## Configure from admin

All instance data is stored in **D1** for that deployment:

- Operator accounts (email, password hash, role) — first visitor is superadmin
- Site name and registered secret **names** — Settings
- HTTP checks (URL, method, headers, body, interval, regions) and heartbeats — Checks
- Incidents

There is no monitors-as-code file in this template. Do not put production URLs, Cloudflare IDs, or demo checks in git.

## Worker secrets

Authenticated HTTP checks use **this Worker's secrets**, not values in git or D1.

1. Register the name in admin (Settings, or type it on a header).
2. Set the value:

```bash
pnpm exec wrangler secret put YOUR_SECRET_NAME
```

Local: `.dev.vars` (gitignored). The admin UI binds a secret **name** onto a monitor. It cannot create or read secret **values**.

Secrets are attached only when the request host is in `allowedHosts`. Cross-origin redirects strip them.

## Heartbeats

Create a heartbeat check in admin, then copy the one-time token (also available via **Rotate heartbeat token**):

```bash
curl -X POST https://your-worker/api/heartbeat \
  -H "Authorization: Bearer <token>"
```

Tokens never go in URLs (access logs).

## Status model

- Check: pass / degraded (latency SLO) / fail
- Component: operational / degraded / failing (region quorum, default majority)
- Banner: fully operational / degraded / failing (critical component down)

Public JSON, HTML, RSS, and badges **do not** include check URLs, headers, or error bodies.

## Layout

- `apps/worker` — Hono API, Durable Objects (Scheduler, Monitor, Probe)
- `apps/web` — admin UI
- `packages/config` — check shape helpers used by the Worker
- `packages/engine` — URL policy, assertions, quorum, redaction
- `migrations` — D1 schema

AGPL-3.0-or-later.
