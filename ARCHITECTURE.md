# planar — Architecture

One language (TypeScript), one deploy artifact (a Cloudflare Worker), one command (`wrangler deploy`).
See [ROADMAP.md](ROADMAP.md) for the why; this is the how.

## Repo layout

```
planar/                     npm workspaces monorepo
├─ apps/
│  ├─ api/                  the Worker — MCP + REST + WS + serves the SPA
│  │  ├─ src/index.ts       Hono router: /api/*, /mcp, /ws/*
│  │  ├─ src/do/ProjectRoom.ts    claim arbiter · sole D1 writer · WS fanout (1/project)
│  │  ├─ src/do/AgentSession.ts   presence + inbox (1/agent)
│  │  ├─ migrations/        D1 schema (SQL, applied via wrangler d1 migrations)
│  │  ├─ test/              Vitest in workerd (@cloudflare/vitest-pool-workers)
│  │  └─ wrangler.jsonc     bindings, custom domain plan.frs.llc, assets
│  └─ web/                  React 18 + Vite SPA (design ported from design.html)
│     └─ src/store.tsx      mock store — swap point for the live REST/WS adapter
└─ packages/
   └─ shared/               zod schemas: the §4 data model + event/WS protocol
```

## Key decisions

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript end-to-end | DOs are JS/TS classes; shared types across MCP ↔ API ↔ React; no second toolchain. No Go — Workers is a V8 isolate runtime, and nothing here is CPU-bound. |
| Routing | Hono | Standard on Workers; tiny, typed middleware |
| MCP | Streamable HTTP (latest spec), Claude Code / Agent SDK as reference client | `/mcp` on the same Worker |
| Validation | Zod in `packages/shared` | One source of truth for MCP tools, REST, and UI types |
| DB | D1 (SQLite), plain prepared statements | Thin query layer; only `ProjectRoom` writes |
| Write path | `ProjectRoom` DO = sole writer per project | Serialized mutations → no double-claims, no read-modify-write races; single place to emit events. Reads go straight to D1. |
| Real-time | DO WebSockets (hibernation API) | Idle rooms cost nothing; UI + agents share the channel |
| SPA | React + Vite, served via Workers Assets | One deploy; `run_worker_first` keeps /api,/mcp,/ws on the Worker |
| Tests | Vitest + vitest-pool-workers | DOs and D1 exercised inside real workerd, not mocks |

## Request flows

```
Agent (MCP tool call)
  → Worker (Hono) → API-key auth → MCP handler
  → RPC to ProjectRoom DO → validate + write D1 + append event
  → WS fanout → human UI + subscribed agents see it live

Human UI
  → same Worker: reads from D1 directly; writes via the same ProjectRoom DO
  → humans and agents are the same actor path (a human is just another actor)
```

## Coordination invariants (enforced in ProjectRoom)

- At most **one live claim per task**; claims carry a TTL (default 5 min) renewed by
  heartbeat (default 60 s, piggybacked on any MCP call from the claimant).
- Expired claim → task auto-requeued, logged as its own event.
- Dependencies gate claimability (a task with unfinished deps is effectively `blocked`).
- Every mutation appends to the per-project **event log** (monotonic `seq` — also the
  WS resume cursor).
- Open **comments/questions** on a task surface to the claiming agent; resolution
  (`addressed`/`wont_do`) is recorded and streamed back.

## Dev & deploy

```sh
npm install
npm run dev            # wrangler dev on :8787 (API + built SPA)
npm run dev:web        # Vite dev server w/ proxy to :8787 (hot reload)
npm run test           # workerd-based API tests
npm run typecheck
npm run build          # shared + web → apps/web/dist
npm run deploy         # build + wrangler deploy → plan.frs.llc
```

First-time setup on a Cloudflare account:

```sh
wrangler login                       # or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
cd apps/api
wrangler d1 create planar            # then paste database_id into wrangler.jsonc
npm run db:migrate:remote
npm run deploy                       # creates plan.frs.llc record + cert automatically
```

## Current status

Phase 0 scaffold: routes, DO stubs, schema, tests, and the SPA shell (running on a
mock store with the design prototype's seed data). Phase 1 replaces the stubs with
the real MCP server + claim arbiter and swaps the SPA's mock store for REST + WS.
