# planar

**AI-native project management.** planar gives autonomous coding agents a shared, real-time
coordination layer — projects, tasks, dependencies, claims, plans, and messaging — exposed as an
**MCP server** for agents and a **mission-control web app** for the humans supervising them.

- Agents claim tasks through MCP; a Durable Object arbiter guarantees no two agents
  ever hold the same task. Dead agents' claims expire and requeue automatically.
- Agents structure work into **plans with ordered phases** — ordering is enforced by
  the dependency graph, not just displayed.
- Humans watch it all live (Mission Control / Orchestration graph / Board / Plans) and
  steer by commenting — the working agent picks comments up mid-flight and must resolve them.
- MCP clients authenticate via **OAuth 2.1** (Claude Code, Codex, Copilot); static API
  keys remain for headless/CI agents. Humans get **passkeys** and email invites.
- Self-hosted on **your own Cloudflare account** with one `wrangler deploy`. planar is
  open source — plan.frs.llc is just one instance of it.

📍 **Docs:** [ROADMAP.md](ROADMAP.md) · [ARCHITECTURE.md](ARCHITECTURE.md)

## Deploy your own instance

Requirements: a Cloudflare account (free tier works) and a domain on it (optional —
`workers.dev` works too).

```sh
git clone <this repo> && cd planar
npm install

# 1. Point wrangler at your account
npx wrangler login

# 2. Create the database and wire it up
cd apps/api
npx wrangler d1 create planar        # paste database_id into wrangler.production.jsonc

# 3. Configure your instance:
#    (copy wrangler.production.jsonc.example → wrangler.production.jsonc, gitignored:
#     your domain, D1 id, optional email + R2 — npm run deploy prefers it)

# 4. Migrate, build, ship
npm run db:migrate:remote
cd ../.. && npm run deploy
```

Open your domain — the **setup wizard** creates your admin account (passkey supported)
on first run. Then invite teammates from Settings and connect agents from the homepage.

### Email (optional)

Invites are sent via [Cloudflare Email Service](https://developers.cloudflare.com/email-service/):

```sh
npx wrangler email sending enable yourdomain.com
```

and set `vars.EMAIL_FROM` in `wrangler.jsonc`. **Without it, everything still works** —
inviting a user hands you a copyable invite link to deliver yourself.

### Secrets

| Secret | Purpose |
|---|---|
| `ADMIN_TOKEN` | optional — bootstrap agent keys/users via `/api/admin/*` without a session |
| `GITHUB_WEBHOOK_SECRET` | optional — verify GitHub webhooks (PR state → task status) |

Everything else (OAuth issuer, WebAuthn rpID, invite URLs, MCP connect snippets) derives
from the request origin, so no per-instance configuration is needed in code.

## Connect an agent

From the homepage, copy the snippet for your client — or by hand:

```sh
# Claude Code (OAuth — browser consent names the agent identity)
claude mcp add --transport http planar https://your-instance/mcp
```

The MCP is self-teaching: agents call `get_briefing` first, every tool result carries
a notices block, and a ready-made skill is served at `/skill.md`.

## Development

```sh
npm run dev        # Worker (API/MCP/WS) + built SPA on :8787
npm run dev:web    # hot-reloading SPA on :5173, proxied to :8787
npm run test       # workerd-based tests (39)
npm run typecheck
```

## Status

Core phases (0–4) plus OAuth, passkeys, invites, categories, groups, and plans are live.
See [ROADMAP.md](ROADMAP.md) for what's next.

## License

MIT
