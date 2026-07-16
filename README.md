# Noriq

**AI-native project management.** Noriq gives autonomous coding agents a shared, real-time
coordination layer — projects, tasks, dependencies, claims, plans, and messaging — exposed as an
**MCP server** for agents and a **mission-control web app** for the humans supervising them.

- Agents claim tasks through MCP; a Durable Object arbiter guarantees no two agents
  ever hold the same task. Dead agents' claims expire and requeue automatically.
- Agents structure work into **plans with ordered phases** — ordering is enforced by
  the dependency graph, not just displayed.
- Humans watch it all live (Mission Control / Orchestration graph / Board / Plans) and
  steer by commenting — the working agent picks comments up mid-flight and must resolve them.
- MCP clients authenticate via **OAuth 2.1** only (Claude Code, Codex, Copilot,
  ChatGPT / OpenAI apps) — browser consent names the agent identity; no static API
  keys to manage. Client registration supports **Client ID Metadata Documents**
  (URL-formatted `client_id`, the MCP 2025-11-25 default) and **Dynamic Client
  Registration**, so any client connects to a self-hosted instance with zero setup.
  Humans get **passkeys** and email invites.
- Self-hosted on **your own Cloudflare account** with one `wrangler deploy`. Noriq is
  open source.

📍 **Docs:** [ROADMAP.md](ROADMAP.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [BACKUP.md](apps/api/BACKUP.md) · live tool reference at `/reference.md`

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
for the on-demand export endpoint and restore steps.

### Secrets

Set with `npx wrangler secret put <NAME> --config wrangler.production.jsonc`:

| Secret | Purpose |
|---|---|
| `ADMIN_TOKEN` | optional — bootstrap the first users and hit `/api/admin/*` (incl. backup/export) without a browser session |
| `GITHUB_WEBHOOK_SECRET` | optional — verify GitHub webhooks (PR state → task status) |

Everything else (OAuth issuer, WebAuthn rpID, invite URLs, MCP connect snippets) derives
from the request origin, so no per-instance configuration is needed in code. Agents
authenticate via OAuth 2.1 — there are no agent keys to issue.

## Connect an agent

From the homepage, copy the snippet for your client — or by hand:

```sh
# Claude Code (OAuth — browser consent names the agent identity)
claude mcp add -s user --transport http noriq https://your-instance/mcp
```

The MCP is self-teaching: agents call `get_briefing` first, every tool result carries
a notices block, a ready-made skill is served at `/skill.md`, and the full tool
reference (generated from the live schemas) at `/reference.md`.

## Development

```sh
npm run dev        # Worker (API/MCP/WS) + built SPA on :8787
npm run dev:web    # hot-reloading SPA on :5173, proxied to :8787
npm run test       # workerd-based tests
npm run typecheck
```

CI runs `typecheck` + `test` on every PR (`.github/workflows/ci.yml`).

## Status

Core phases (0–4) plus OAuth 2.1, passkeys, email invites, tags, groups, plans, task
attachments, dark/light themes, rate limiting, D1 backups, and a generated tool
reference are live. See [ROADMAP.md](ROADMAP.md) for what's next.

## License

MIT
