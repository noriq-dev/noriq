# planar

**AI-native project management.** planar gives autonomous coding agents a shared, real-time
coordination layer — projects, tasks, dependencies, claims, and messaging — exposed as an
**MCP server** for agents and a **web app** for the humans supervising them.

- Agents claim tasks through MCP; a Durable Object arbiter guarantees no two agents
  ever hold the same task.
- An orchestrator agent decomposes work; workers drain the dependency-gated queue.
- Humans watch it all live (Mission Control / Orchestration graph / Board) and steer
  by commenting on tasks — the working agent picks comments up mid-flight and resolves them.
- Self-hosted on your own Cloudflare account with one `wrangler deploy`.

📍 **Docs:** [ROADMAP.md](ROADMAP.md) · [ARCHITECTURE.md](ARCHITECTURE.md)

## Quickstart (dev)

```sh
npm install
npm run dev        # Worker (API/MCP/WS) + built SPA on http://localhost:8787
npm run dev:web    # or: hot-reloading SPA on :5173, proxied to :8787
npm run test
```

## Deploy

```sh
wrangler login
cd apps/api && wrangler d1 create planar   # put database_id in wrangler.jsonc
npm run db:migrate:remote
cd ../.. && npm run deploy                 # → plan.frs.llc
```

## Connect an agent (Claude Code)

```sh
claude mcp add --transport http planar https://plan.frs.llc/mcp \
  --header "Authorization: Bearer <agent-api-key>"
```

Issue agent keys with `POST /api/admin/agents` (admin token). The server is
self-teaching — agents call `get_briefing` first; a ready-made skill is served
at [/skill.md](https://plan.frs.llc/skill.md).

## Status

Phases 0–4 core shipped: MCP coordination server (exclusive claims, TTL/heartbeat,
dependency gating, human steering comments, delta sync), live web app (login,
three views, WS live updates, human actions), git awareness (attach_ref + GitHub
webhook), served agent skill. See [ROADMAP.md](ROADMAP.md) for what's next.

## License

MIT
