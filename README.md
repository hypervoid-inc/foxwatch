# Foxwatch

Open-source synthetic monitoring and status pages, running on Cloudflare.

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-4B5563?style=flat-square" alt="AGPL-3.0" /></a>
  <a href="https://developers.cloudflare.com/workers/platform/pricing/"><img src="https://img.shields.io/badge/Cloudflare-Workers_Paid-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Workers Paid" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node-20+-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node 20+" /></a>
</p>

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/hypervoid-inc/foxwatch">
    <img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" />
  </a>
</p>

<p align="center">
  <sub>One click. Cloudflare clones this repo to your GitHub, provisions D1 / KV / Queue, and deploys the Worker.</sub>
</p>

Requires [Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/) (~$5/month) for Durable Objects and Analytics Engine.

Create HTTP and heartbeat checks in the **admin UI**, run them from multiple Cloudflare regions, and publish a public page: **fully operational / degraded / failing**.

This is a **GitHub template**. Instance data (hosts, monitors, accounts) lives in **your** D1 after you deploy, never in this repo.

Foxwatch observes **from Cloudflare**. A global Cloudflare outage takes the observer down with the target. That is an explicit tradeoff, not a bug.

---

## Deploy

### One click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hypervoid-inc/foxwatch)

The [Deploy to Cloudflare](https://developers.cloudflare.com/workers/platform/deploy-buttons/) button:

1. Clones this repo into your GitHub account
2. Provisions D1 `foxwatch-data`, queue `foxwatch-alerts`, and a KV namespace (name it **`foxwatch-status`** on the setup page)
3. Injects those IDs into *your* clone only, deploys the Worker, and turns on Workers Builds

Committed `wrangler.jsonc` in this template omits D1/KV IDs on purpose. Your account IDs never land in the public repo.

Then open **`/admin`** on your Worker and create the first superadmin (email + password).

Until that account exists, anyone who reaches `/admin` can create it, so do it right after the deploy finishes. To close that window, set a Worker secret named **`FOXWATCH_SETUP_TOKEN`** (dashboard **Settings → Variables and Secrets**, or the command below) before you open `/admin`. The setup screen then asks for the token and refuses to create the account without it. Leave it unset and setup works as before.

```bash
pnpm exec wrangler secret put FOXWATCH_SETUP_TOKEN
```

### This repository (GitHub Actions)

This repo deploys from **Actions on `main`**. Nothing is written into `wrangler.jsonc`.

Create an API token: [Cloudflare dashboard → Manage Account → API Tokens → Create Token → Custom token](https://dash.cloudflare.com/profile/api-tokens).

- **Token name:** `foxwatch-github-actions` (or anything you like)
- **Account resources:** Include → the account you will deploy to
- **Zone resources:** None

**Account permissions**

| Resource | Access |
| --- | --- |
| Workers Scripts | Write |
| Workers KV Storage | Write |
| D1 | Write |
| Queues | Write |
| Account Settings | Read |

Copy the token once. Put it in GitHub **Settings → Secrets and variables → Actions**.

**Secret**

| Name | Required |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | yes, the token above |

**Variables** (same page, Variables tab, or secrets with the same names)

| Name | Required |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | yes, [account ID](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/) |
| `FOXWATCH_D1_DATABASE_ID` | no, pin D1 `foxwatch-data` |
| `FOXWATCH_KV_NAMESPACE_ID` | no, pin KV `foxwatch-status` |

Without the ID variables, CI runs `pnpm foxwatch init --yes` (creates or reuses those named resources) then `pnpm deploy`. IDs are injected into the build output only.

A push with no Cloudflare credentials skips deploy so a fresh template clone stays green. **Actions → CI → Run workflow** fails instead of silently skipping.

Same setup works if you [use this template](https://github.com/hypervoid-inc/foxwatch/generate) instead of the button.

### Laptop

```bash
pnpm install
pnpm exec wrangler login
pnpm foxwatch init          # D1 / KV / Queue → gitignored wrangler.cloud.jsonc
pnpm deploy
```

If `foxwatch-data` or `foxwatch-status` already exists, init checks the D1 schema and asks before reusing. It will not migrate over unrelated tables. `--yes` skips the prompt (CI).

---

## Local

Needs [Node 20+](https://nodejs.org/) and [pnpm](https://pnpm.io/installation). No Cloudflare login.

```bash
pnpm install
pnpm dev
```

- Public status: [http://localhost:5173/](http://localhost:5173/)
- Admin: [http://localhost:5173/admin](http://localhost:5173/admin)

A new instance has no checks and is named **Foxwatch** until you change it under **Settings**. Optional: copy `.dev.vars.example` to `.dev.vars` for `ALLOW_HTTP_LOCAL=true` or local header secrets.

---

## Using it

All instance data is in **D1**: operator accounts, site name, HTTP and heartbeat checks, incidents.

**Worker secrets** for authenticated checks live on the Worker, not in git or D1. Register the name in admin, then:

```bash
pnpm exec wrangler secret put YOUR_SECRET_NAME
```

By default the admin UI only registers names; values are set with the command above. To set and rotate values from **Settings** instead, give the Worker these three secrets:

| Name | Value |
| --- | --- |
| `FOXWATCH_CF_API_TOKEN` | API token with **Workers Scripts** write access on the account |
| `FOXWATCH_CF_ACCOUNT_ID` | the account ID |
| `FOXWATCH_CF_SCRIPT_NAME` | the Worker's name, `foxwatch` unless you renamed it |

Values are never read back, in either mode.

Sensitive headers must use a secret ref. Secrets attach only when the request host is in `allowedHosts`; cross-origin redirects strip them. Only names registered in admin resolve, and Foxwatch's own bindings (`FOXWATCH_CF_*`, `FOXWATCH_SETUP_TOKEN`, `ALLOW_HTTP_LOCAL`) never do. Registering a secret takes a superadmin, and so does any new use of one: other admins can save or test a request that carries a secret only when an existing check already sends that exact request (same URL, method, body, headers and allowed hosts). They can still edit everything else about such a check, and like any admin they see the response snippets of the requests it makes.

**Operator accounts** - each operator changes their own password under **Settings → Your password**. That signs them out everywhere else, which is also how to cut off a leaked password or a session left on another machine. Sign-in allows 8 wrong passwords per account from one address (one IPv6 /48) in 15 minutes, and 3 once an account has drawn 200 wrong passwords from anywhere; no number of wrong guesses from elsewhere keeps the right password out. A trip shows in **Activity** as `login-throttled` by `anonymous`, a few per hour at most. Activity entries are kept for 365 days.

If every operator is locked out, empty the accounts table and `/admin` offers first-account setup again (with the setup token, if you set one):

```bash
pnpm exec wrangler d1 execute foxwatch-data --remote --command "DELETE FROM ops_sessions; DELETE FROM ops_users;"
```

**Heartbeats** - create a check in admin, copy the token (or rotate it):

```bash
curl -X POST https://your-worker/api/heartbeat \
  -H "Authorization: Bearer <token>"
```

Tokens never go in URLs.

**Alert channels** - under **Settings**, add a Slack webhook, Discord webhook or generic webhook and pick the events it gets: fail, degrade, recover. The webhook URL is a Worker secret; the channel stores only its name. **Test** sends a sample alert. To preview the Discord card from your laptop without a deploy:

```bash
pnpm webhook -- --help
```

**Maintenance** - start or schedule a window on a component (up to 90 days; windows on one component cannot overlap). While it runs the public page shows the component as under maintenance.

**Incidents** - a component that fails or degrades opens an incident on its own and resolves it on recovery. Operators can also open one by hand, attach components, and post updates (investigating, identified, monitoring, resolved). Each incident has a public page and appears in the RSS feed.

**Status model**

- Check: pass / degraded (latency SLO) / fail
- Component: operational / degraded / failing (region quorum, default majority)
- Banner: fully operational / degraded / failing (critical component down)

Public JSON, HTML, RSS, and badges **do not** include check URLs, headers, or error bodies.

---

## Layout

- `apps/worker` - Hono API, public status page, Durable Objects (Scheduler, Monitor, Probe, StatusHub)
- `apps/web` - admin UI and the status page globe
- `packages/config` - check shape helpers
- `packages/engine` - URL policy, assertions, quorum, redaction
- `migrations` - D1 schema
- `scripts` - `pnpm foxwatch init`, `pnpm deploy`, `pnpm webhook`

`pnpm test`, `pnpm check-types` and `pnpm build` are what CI runs.

AGPL-3.0-or-later.
