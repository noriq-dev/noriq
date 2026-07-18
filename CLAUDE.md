# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Noriq is an AI-native project management system: an **MCP server for AI agents** plus a
**React web app for the humans supervising them**, deployed as a single Cloudflare Worker.
Open-source and self-hostable.

## Commands

Run from the repo root unless noted. Workspaces are `@noriq-dev/api`, `@noriq-dev/web`, `@noriq-dev/shared`.

```sh
npm install
npm run dev              # wrangler dev on :8787 (Worker: API + MCP + WS + built SPA)
npm run dev:web          # Vite dev server with proxy to :8787 (hot reload for UI work)
npm run build            # shared + web → apps/web/dist (the Worker serves this)
npm run typecheck        # tsc --noEmit across workspaces
npm test                 # all workspace tests
```

API tests run in a real `workerd` via `@cloudflare/vitest-pool-workers` (DOs + D1 are exercised, not mocked).
The full run is **sharded across parallel pool projects** (`apps/api/vitest.workspace.ts`) — ~10s instead of
~4.5 min single-worker (the pool can't parallelize within one project; see that file). Target one file by
`cd`-ing in — a workspace, once present, governs every run, so `--root apps/api <file>` from the repo root no
longer resolves the path:

```sh
npm test --workspace @noriq-dev/api                      # full API suite (sharded, ~10s)
npm run test:load --workspace @noriq-dev/api             # the 28s claim-stampede stress test (off the default run)
cd apps/api && npx vitest run test/oauth.test.ts         # a single test file
cd apps/api && npx vitest run -t "refresh"               # a single case by name (across all shards)
cd apps/api && npx tsc --noEmit                          # typecheck API (vitest uses esbuild — it does NOT catch type errors)
```

Deploy + migrations (production actions — only run when explicitly asked):

```sh
npm run deploy                                    # build + wrangler deploy (uses wrangler.production.jsonc if present)
npm run db:migrate:local --workspace @noriq-dev/api   # apply migrations to the local D1
npm run db:migrate:remote --workspace @noriq-dev/api  # apply migrations to the REMOTE (prod) D1
```

## Architecture

**One Worker does everything.** `apps/api/src/index.ts` is a Hono router that serves `/api/*`
(REST for the SPA), `/mcp` (agents), `/ws/*` (live updates), `/oauth/*` + `/.well-known/*`
(OAuth 2.1 AS), and falls through to Workers Assets for the SPA. `run_worker_first` in the
wrangler config keeps the dynamic paths on the Worker while static assets are served directly.

**`ProjectRoom` (Durable Object) is the sole writer per project** — [apps/api/src/do/ProjectRoom.ts](apps/api/src/do/ProjectRoom.ts).
All mutations (create/claim/release tasks, comments, milestones, boards, deletes) go through it,
wrapped in `blockConcurrencyWhile`, so there are no double-claims or read-modify-write races, and
every mutation appends to a per-project **event log** (monotonic `seq`, also the WS resume cursor)
and fans out over WebSocket. **Reads go straight to D1** (e.g. the `/snapshot` endpoint); only
writes cross into the DO. Humans and agents are the same `Actor` path — a human is just another actor.

**MCP server** — [apps/api/src/mcp.ts](apps/api/src/mcp.ts). Streamable HTTP via `@hono/mcp`, **stateless**:
a fresh `McpServer` is built per request, bound to the authenticated agent. Tools double as docs
(descriptions teach the workflow); every tool result piggybacks a `--- notices ---` block computed
in [sync.ts](apps/api/src/sync.ts) from a server-side cursor stored in the `AgentSession` DO, so
working agents get pushed-feeling updates without polling.

**Agent identity model:** user → OAuth connection (one per `claude mcp add`) → agent (one per MCP
session, keyed by `Mcp-Session-Id`) → sub-agents (`parent_agent_id`). Agents are **project-local**.
Auth lives in [auth.ts](apps/api/src/auth.ts) (agents: OAuth-only, no static keys) and
[oauth.ts](apps/api/src/oauth.ts) (the AS: authz-code + PKCE/S256, DCR + CIMD client registration).

**Shared zod schemas** — [packages/shared/src](packages/shared/src) — are the single source of truth for
the data model and the event/WS protocol, consumed by MCP tools, REST, and the UI.

**Web app** — [apps/web/src/store.tsx](apps/web/src/store.tsx) is the live store: it loads REST
`/snapshot`s and invalidates on WS events, deriving view-model types ([types.ts](apps/web/src/types.ts))
for the components. (ARCHITECTURE.md calls it a "mock store" — that's stale; it's live.)

## Non-obvious constraints (read before changing schema, MCP, or tests)

- **D1 enforces foreign keys during BOTH `migrations apply` AND `d1 execute`, and ignores
  `PRAGMA foreign_keys`/`defer_foreign_keys`.** You cannot drop/rebuild a referenced table on
  populated data. **All migrations must be additive** (`ALTER TABLE ADD COLUMN`, new tables).
  When adding a table that other tables reference, order the statements so FK targets exist first,
  and update the `deleteProject` cascade in `ProjectRoom` (FK-ordered deletes) for any new table.

- **MCP notifications only deliver on the in-flight request's SSE stream.** In stateless Streamable
  HTTP there is no standing GET stream, so `server.notification()` with no `relatedRequestId` is
  dropped. Always pass `extra.requestId` as `relatedRequestId` (see `pushChannel` in mcp.ts). A fully
  idle agent cannot be pushed to — the notices text-block is the reliable fallback.

- **Agent-facing guidance lives in three overlapping places that must be kept in sync.** The
  MCP `instructions` string (`INSTRUCTIONS` in [mcp.ts](apps/api/src/mcp.ts), sent once on
  `initialize`), the `playbook` array returned by `get_briefing` (same file), and `SKILL_MD`
  ([skill.ts](apps/api/src/skill.ts), served at `/skill.md`). The duplication is intentional —
  the inline playbook spares a working agent a second fetch, and the skill is not registered as
  an MCP resource, so a bare "read the skill" pointer would dangle for MCP clients. **When you
  change the work-loop contract (claim/release, identity, planning, escalation), update all
  three** — they drift silently otherwise.

- **`fetchMock` from `cloudflare:test` only intercepts the test isolate, not the worker isolate
  reached via `SELF.fetch()`.** To test code that makes outbound `fetch` from within the Worker,
  inject the fetch function (see `resolveCimdClient(env, id, doFetch)` in [lib/cimd.ts](apps/api/src/lib/cimd.ts))
  and unit-test it directly, rather than driving it through an HTTP route.

- **Task- vs project-scoped tables:** `comments` and `attachments` are **task-scoped** (no
  `project_id` column — join through `tasks`). `signals`, `messages`, `events` have `project_id`.

- **A deployed change requires a hard browser refresh** — the open SPA tab caches the old JS bundle.

## Naming

Everything is **Noriq**: the `@noriq-dev/*` packages, the MCP server name, `noriq://` resource
URIs, the Worker / D1 / R2 names in the configs, the `noriq_session` cookie, `noriq.*`
localStorage keys, and `backups/noriq-*.json` snapshots (marker `noriq: 'd1-snapshot'`).
`wrangler.production.jsonc` holds the real instance values and is gitignored. Two rules:

- **The project key `PLNR` (and `PLNR-##` task keys) is a permanent identifier, not brand
  copy** — it's embedded in every commit message, comment, and external link. Never re-key.
- **Durable Object namespace labels are minted from the worker's name at namespace creation
  and have no rename knob** (dashboard, wrangler, or API) — a long-lived instance can show
  labels that don't match its current worker name. Cosmetic only; never "fix" a label with a
  `deleted_classes` migration, which permanently wipes that namespace's storage.
