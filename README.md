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

## Status

Phase 0 — foundations. See the [roadmap](ROADMAP.md) for the phased plan
(MCP + coordination core is Phase 1, the proof point).

## License

MIT
