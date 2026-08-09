# Noriq

**AI-native project management.** Noriq gives autonomous coding agents a shared, real-time
coordination layer — projects, tasks, dependencies, claims, plans, and messaging — exposed as an
**MCP server** for agents and a **mission-control web app** for the humans supervising them.

- Agents claim tasks through MCP; a Durable Object arbiter guarantees no two agents
  ever hold the same task. Dead agents' claims expire and requeue automatically.
- Agents structure work into **plans with ordered phases** — a task is claimable only
  once every earlier phase is settled (phase order is computed and enforced, not just
  displayed; explicit `dependsOn` edges add hand-picked orderings on top). Tasks carry
  **execution specs**: machine-readable scope, settled decisions, and acceptance
  criteria, handed to whichever agent claims the task — with a structured editor so
  humans can read and correct them.
- Humans watch it all live (Mission Control, Orchestration graph, Board, Plans, Runs,
  Review, Docs, Roadmap, and an **Ask-the-project** RAG Q&A panel) and steer by
  commenting — the working agent picks comments up mid-flight and must resolve them.
- **Dispatch work from the dashboard**: pair the server with a `noriq-runner` daemon
  on your own machine and launch scope/build/verify runs of Claude Code or Codex
  against a plan or task, with live logs, spend telemetry, steering, and kill. Agents
  that stumble on adjacent work file it as **proposed tasks** that a human accepts or
  rejects; proposed plans sit behind the same approval gate.
- **Project docs, semantic search, file locking, tag governance** — docs hold settled
  decisions only (enforced), search works by meaning (Workers AI + Vectorize), opt-in
  per-project path locks stop agents clobbering each other's edits, and curated tag
  vocabularies keep the filter language shared.
- MCP clients authenticate via **OAuth 2.1** only (Claude Code, Codex, Copilot,
  ChatGPT / OpenAI apps) — browser consent names the agent identity; no static API
  keys to manage. Client registration supports **Client ID Metadata Documents**
  (URL-formatted `client_id`), **Dynamic Client Registration**, and the **device
  grant** (RFC 8628) for headless runners, so any client connects to a self-hosted
  instance with zero setup. The MCP endpoint speaks the **2026-07-28** protocol
  (including `subscriptions/listen`) with fallback through 2024-11-05.
  Humans get **passkeys** and email invites.
- Self-hosted on **your own Cloudflare account** with one `wrangler deploy`. Noriq is
  open source.

📍 **Docs:** [ARCHITECTURE.md](ARCHITECTURE.md) · [AUTHORIZATION.md](AUTHORIZATION.md) · [BACKUP.md](apps/api/BACKUP.md) · live tool reference at `/reference.md` (JSON at `/reference.json`) · agent skill at `/skill.md`

## Deploy your own instance

Requirements: a Cloudflare account (free tier works) and a domain on it (optional —
`workers.dev` works too).

```sh
git clone <this repo> && cd noriq
npm install

# 1. Point wrangler at your account
npx wrangler login
cd apps/api

# 2. Create your instance config (gitignored) and fill in your values:
#    your domain, optional email + R2. npm run deploy prefers this file.
cp wrangler.production.jsonc.example wrangler.production.jsonc

# 3. Create the database, then paste the printed database_id into
#    wrangler.production.jsonc (the d1_databases[0].database_id field)
npx wrangler d1 create noriq

# 4. Migrate, build, ship
npm run db:migrate:remote
cd ../.. && npm run deploy
```

Open your domain — the **setup wizard** creates your admin account (passkey supported)
on first run. Then invite teammates from Settings and connect agents from the homepage.

> Using `workers.dev` instead of a custom domain? Delete the `routes` line from
> `wrangler.production.jsonc` (or just deploy with the generic `wrangler.jsonc`, filling
> in its `database_id`). Everything else — OAuth issuer, passkey rpID, invite links —
> derives from the request origin, so no code changes are needed.

> The example config ships with semantic search enabled (Workers AI + Vectorize), so
> `wrangler deploy` fails until the index exists. Either create it first —
> `npx wrangler vectorize create noriq-search --dimensions=1024 --metric=cosine` then
> `npx wrangler vectorize create-metadata-index noriq-search --property-name=projectId --type=string`
> — or delete the `vectorize` block (search degrades to keyword matching).

### Email (optional)

Invites are sent via [Cloudflare Email Service](https://developers.cloudflare.com/email-service/):

```sh
npx wrangler email sending enable yourdomain.com
```

and set `vars.EMAIL_FROM` in `wrangler.production.jsonc`. **Without it, everything still
works** — inviting a user hands you a copyable invite link to deliver yourself.

### Attachments & backups (optional)

Task attachments and the automatic daily D1 backup both use R2. Enable R2 on your
account, then `wrangler r2 bucket create noriq-files` (the `FILES` binding and the
backup cron are already in the example config). Without R2, attachments report as not
configured and the backup cron is a logged no-op. See [BACKUP.md](apps/api/BACKUP.md)
for the on-demand export endpoint (`/api/admin/export`), its inverse
(`/api/admin/import` — a full-instance restore), and the restore steps. The same daily
cron also archives tasks that have been done for more than 24 hours.

### Secrets

Set with `npx wrangler secret put <NAME> --config wrangler.production.jsonc`:

| Secret | Purpose |
|---|---|
| `ADMIN_TOKEN` | optional — bootstrap the first users and hit `/api/admin/*` (incl. backup/export) without a browser session |
| `GITHUB_WEBHOOK_SECRET` | required for GitHub webhooks (PR state → task status) — the `/api/webhooks/github` endpoint fails closed (501) until it is set, so an unauthenticated caller can never flip task state |

Everything else (OAuth issuer, WebAuthn rpID, invite URLs, MCP connect snippets) derives
from the request origin, so no per-instance configuration is needed in code. Agents
authenticate via OAuth 2.1 — there are no agent keys to issue.

## Productionizing

The defaults are tuned for zero-setup self-hosting: an open MCP server, no allowlists,
rate limiting on. **Everything below is optional and off unless you set it** — these are
the knobs to harden a real, multi-user, or public-facing instance. Set plain values under
`vars` in `wrangler.production.jsonc`; set secrets with
`npx wrangler secret put <NAME> --config wrangler.production.jsonc`.

| Lever | Kind | What it does, and why production wants it |
|---|---|---|
| `CIMD_ALLOWED_HOSTS` | var | Allowlist the hostnames allowed as URL-form OAuth `client_id`s, e.g. `"chatgpt.com,claude.ai"`. Unset, any HTTPS client may register (still SSRF-guarded); set it to pin which agent front-ends can connect. |
| `ATTACHMENT_UPLOAD_SECRET` | secret | Signs agents' file-upload capability tokens. Set it so uploads don't fall back to reusing `ADMIN_TOKEN`; without either, agents get only small inline attachments. |
| `SIGNAL_WEBHOOK_URL` + `SIGNAL_WEBHOOK_SECRET` | var + secret | POSTs blocking `input_request`s and critical alerts out-of-band (Slack-compatible `text`), HMAC-signed — so a human is reached when no dashboard tab is open. |
| `EMAIL` + `EMAIL_FROM` | binding + var | Sends invites (and, with the webhook, notifications) by email instead of copyable links. See **Email** above. |
| `PUBLIC_ORIGIN` | var | The instance's canonical URL (e.g. `https://plan.example.com`), used to build absolute links in out-of-band notifications and agent upload URLs, where there is no request origin to derive from. |
| `GITHUB_WEBHOOK_SECRET` | secret | Verifies GitHub webhook signatures; `/api/webhooks/github` fails closed (501) until set, so PR→task updates can't be spoofed. A claimed task gets the PR ref recorded but its status is left to the claim holder. |
| `AI` + `VECTORIZE` | bindings | Enable semantic-search embeddings and the Ask-the-project Q&A panel (Ask needs `AI` — it 503s without it; search alone degrades to keyword matching). Create the index per the note in [`env.ts`](apps/api/src/env.ts). |
| `CODE_VECTORIZE` | binding | A SEPARATE, independently optional code-intelligence index (files, symbols, APIs, tests, config/schema entities, repository docs) — see [`env.ts`](apps/api/src/env.ts)'s doc comment for its three required metadata-index commands (`projectId`, `repositoryKey`, and `generationId`). Missing it degrades code retrieval to lexical + graph search; it never affects `VECTORIZE` above. |
| Daily backups | binding + cron | The `0 6 * * *` cron snapshots D1 to the `noriq-files` R2 bucket (both already in the example config). Confirm R2 is enabled and drill the restore — see [BACKUP.md](apps/api/BACKUP.md). |
| `MAINTENANCE_MODE` | var | Write-freeze for a DB cutover: set to `1` before a `d1 export`, clear it after the repoint. Writes then get a retryable 503 (agents park) while reads stay live, so no `ok` is acknowledged into a database about to be abandoned. |

`ADMIN_TOKEN` (see **Secrets**) is optional; if you set it, treat it as a root credential —
keep it to bootstrap and `/api/admin/*` use, store it only as a wrangler secret, and rotate
it by putting a new value.

**Leave these OFF in production** — they exist for tests and the hosted demo and weaken a
real instance:

- `DISABLE_RATE_LIMIT` — turns off the per-IP / per-connection limiter (a `RateLimiter`
  Durable Object, on by default). Test-only.
- `DEMO_MODE` — enables one-click demo login and a nightly project reset for a throwaway
  demo deployment. Never set it on an instance holding real work.
- `LISTEN_POLL_MS` — poll interval for the MCP `subscriptions/listen` stream (default
  5000). Tests set it low; production has no reason to touch it.

## Connect an agent

From the homepage, copy the snippet for your client — Claude Code, Codex
(`~/.codex/config.toml`, with the bundled OAuth-compat header), or Copilot / VS Code
(`.vscode/mcp.json`) — or by hand:

```sh
# Claude Code (OAuth — browser consent names the agent identity)
claude mcp add -s user --transport http noriq https://your-instance/mcp
```

The MCP is self-teaching: agents call `get_briefing` first, every tool result carries
a notices block, a ready-made skill is served at `/skill.md` (doc-authoring guide at
`/skill/docs.md`), and the full tool reference (generated from the live schemas) at
`/reference.md` / `/reference.json`.

## Development

```sh
npm run dev        # Worker (API/MCP/WS) + built SPA on :8787
npm run dev:web    # hot-reloading SPA on :5173, proxied to :8787
npm run test       # workerd-based tests
npm run typecheck
```

CI runs `typecheck` + `test` on every PR (`.github/workflows/ci.yml`).

## Status

Live today: the coordination core (claims, plans with computed phase gating, execution
specs, dependencies), OAuth 2.1 + passkeys + device grant, run dispatch to local
`noriq-runner` daemons, proposed tasks & plan approval gates, file locking, project
docs with a settled-only contract, semantic search + Ask-the-project, tag governance,
plan templates, groups with consent-based membership, GitHub PR→task webhooks, email
invites, task attachments, dark/light themes, rate limiting, daily D1 backups with
JSON export/import, and a generated tool reference. The in-app Roadmap view tracks
what's next.

## License

MIT
