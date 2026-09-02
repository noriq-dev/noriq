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
~4.5 min single-worker (the pool can't parallelize within one project; see that file). Besides the `shard-*`
projects there are dedicated `demo` and `maintenance` projects: `DEMO_MODE`/`MAINTENANCE_MODE` flip global
behavior, so those suites can't ride the shared default binding set. Target one file by `cd`-ing in — a
workspace, once present, governs every run, so `--root apps/api <file>` from the repo root no longer
resolves the path:

```sh
npm test --workspace @noriq-dev/api                      # full API suite (shard* + demo + maintenance, ~10s)
npm run test:load --workspace @noriq-dev/api             # the 28s claim-stampede stress test (off the default run)
npm run test:hooks                                       # the file-lock Claude Code hook suite (node --test, not vitest)
cd apps/api && npx vitest run test/oauth.test.ts         # a single test file
cd apps/api && npx vitest run -t "refresh"               # a single case by name (across all shards)
cd apps/api && npx tsc --noEmit                          # typecheck API (vitest uses esbuild — it does NOT catch type errors)
```

Deploy + migrations (production actions — only run when explicitly asked):

```sh
npm run deploy                                    # build + wrangler deploy (uses wrangler.production.jsonc if present)
npm run deploy:demo                               # build + deploy the DEMO_MODE instance (wrangler.demo.jsonc)
npm run deploy:staging                            # build + deploy the full-capability staging instance (wrangler.staging.jsonc)
npm run db:migrate:local --workspace @noriq-dev/api   # apply migrations to the local D1
npm run db:migrate:remote --workspace @noriq-dev/api  # apply migrations to the REMOTE (prod) D1
npm run db:migrate:demo --workspace @noriq-dev/api    # apply migrations to the demo instance's D1
npm run db:migrate:staging --workspace @noriq-dev/api # apply migrations to the staging instance's D1
```

**Staging is not the demo.** `wrangler.demo.jsonc` deliberately omits `ai`/`vectorize`/`r2` and sets
`DEMO_MODE=1` (resource lockdown + nightly reseed), so it cannot exercise semantic search,
attachments, backup/restore, repository indexing, or OAuth-connected agents. `wrangler.staging.jsonc`
(see `wrangler.staging.jsonc.example`) is the opposite posture — prod's bindings, `DEMO_MODE` unset,
separate worker/D1/R2/Vectorize. Every one of those must differ from prod: **DO namespaces are created
per worker SCRIPT**, so a shared `name` puts staging traffic on prod's Durable Objects, and a shared
`FILES` bucket lets a staging restore/erase reach prod's only backups (both `backups/` and
`memory-backups/<projectId>/` live there). Note that after a deploy, an already-running Durable Object
keeps serving OLD code until it restarts — a DO-backed path can lag a Worker-side path by a minute.

## Architecture

**One Worker does everything.** `apps/api/src/index.ts` is a Hono router that serves `/api/*`
(REST for the SPA), `/mcp` (agents), `/ws/*` (live updates — including `/ws/runner/:id`, the
Bearer-authenticated runner-daemon channel), `/oauth/*` + `/.well-known/*` (OAuth 2.1 AS),
`/skill.md` + `/skill/docs.md` + `/reference.md` + `/reference.json` (served agent guidance),
and falls through to Workers Assets for the SPA. `run_worker_first` in the wrangler config keeps
the dynamic paths on the Worker while static assets are served directly.

**Four Durable Objects.** **`ProjectRoom` is the sole writer per project** —
[apps/api/src/do/ProjectRoom.ts](apps/api/src/do/ProjectRoom.ts). All mutations (create/claim/release
tasks, comments, milestones, boards, deletes) go through it, wrapped in `blockConcurrencyWhile`, so
there are no double-claims or read-modify-write races, and every mutation appends to a per-project
**event log** (monotonic `seq`, also the WS resume cursor) and fans out over WebSocket. **Reads go
straight to D1** (e.g. the `/snapshot` endpoint); only writes cross into the DO. Humans and agents
are the same `Actor` path — a human is just another actor. The others: `AgentSession` (per-agent
notices cursor + presence), `RateLimiter`, and `RunnerHub` (one per runner daemon, holds its
`/ws/runner/:id` socket — pure transport; run **authority** stays in `ProjectRoom`).

**MCP server** — [apps/api/src/mcp.ts](apps/api/src/mcp.ts). Streamable HTTP via `@hono/mcp`, **stateless**:
a fresh `McpServer` is built per request, bound to the authenticated agent. Two protocol eras share
`/mcp`: the legacy path (`initialize` + `Mcp-Session-Id`, ≤2025-11-25) goes through the SDK, while
the **2026-07-28 modern path** ([mcp-2026.ts](apps/api/src/mcp-2026.ts)) sits in front of it — the
TS SDK tops out at 2025-11-25, so it validates the modern envelope itself, answers `server/discover`
directly, and bridges an allowlist of methods into the same `buildMcpServer` over an in-memory
transport (JSON-only responses, no sessions, no notifications). `subscriptions/listen`
([mcp-listen.ts](apps/api/src/mcp-listen.ts)) is the one long-lived push stream — see constraints.
Tools double as docs (descriptions teach the workflow); every tool result piggybacks a
`--- notices ---` block computed in [sync.ts](apps/api/src/sync.ts) from a server-side cursor stored
in the `AgentSession` DO, so working agents get pushed-feeling updates without polling.

**Agent identity model:** user → OAuth connection (one per `claude mcp add`) → agent (one per MCP
session) → sub-agents (`parent_agent_id`). Session keys, first match wins: `_meta["openai/session"]`
(`openai:{id}`), `_meta["grok/session"]` (`grok:{id}`), `Mcp-Session-Id` (as-is), `x-mcp-session-id`
(`grok:{id}`), else `stateless:{oauthTokenId}`. A non-Grok legacy `initialize` with none of those
still mints a UUID so Claude Code keeps one copilot per chat; Grok (`User-Agent: grok-cli`) uses
the token fallback because it re-initializes per tool call. See `lib/mcp-session-key.ts` (PLNR-552). Agents are **project-local** and carry a `kind`: **copilot**
(human-authorized connection) vs **agent** (runner-spawned — minted per run via
`POST /api/runs/:runId/agent`, one live agent per run, with reduced authority; see constraints).
Auth lives in [auth.ts](apps/api/src/auth.ts) (agents: OAuth-only, no static keys) and
[oauth.ts](apps/api/src/oauth.ts) (the AS: authz-code + PKCE/S256, DCR + CIMD client registration,
plus the RFC 8628 device grant for headless runners).

**Shared zod schemas** — [packages/shared/src](packages/shared/src) — are the single source of truth,
consumed by MCP tools, REST, and the UI: `model.ts` (data model), `events.ts` (event log),
`ws.ts` (browser + runner WS protocols), `runner.ts` (runs: kind/tool/effort/budget/spend),
`manifest.ts` (the `.noriq/project.toml` and `~/.noriq/runner.toml` manifests, validated as parsed
objects — shared deliberately has no TOML parser), and `execution-spec.ts` (the ExecutionSpec contract).

**Web app** — [apps/web/src/store.tsx](apps/web/src/store.tsx) is the live store: it loads REST
`/snapshot`s and invalidates on WS events, deriving view-model types ([types.ts](apps/web/src/types.ts))
for the components. (ARCHITECTURE.md calls it a "mock store" — that's stale; it's live.)

## Non-obvious constraints (read before changing schema, MCP, or tests)

- **D1 enforces foreign keys during BOTH `migrations apply` AND `d1 execute`, and ignores
  `PRAGMA foreign_keys`/`defer_foreign_keys`.** You cannot drop/rebuild a referenced table on
  populated data. **All migrations must be additive** (`ALTER TABLE ADD COLUMN`, new tables).
  When adding a table that other tables reference, order the statements so FK targets exist first,
  and update the `deleteProject` cascade in `ProjectRoom` (FK-ordered deletes) for any new table.

- **MCP push has three distinct delivery paths — know which one you're on.** (1) Legacy path:
  notifications only deliver on the in-flight request's SSE stream — there is no standing GET
  stream, so `server.notification()` with no `relatedRequestId` is dropped; always pass
  `extra.requestId` as `relatedRequestId` (see `pushChannel` in mcp.ts). (2) Modern 2026-07-28
  path: notifications are **never forwarded**, by design (JSON-only responses). (3)
  `subscriptions/listen` ([mcp-listen.ts](apps/api/src/mcp-listen.ts)) is a real long-lived SSE
  stream, but narrow: docs/attachments change events only (D1-polled every `LISTEN_POLL_MS`,
  default 5s), resource subscriptions limited to `noriq://doc/{id}`, forward-only and not
  resumable. It carries **no** task/comment/message coordination — the notices text-block
  remains the reliable fallback for a working agent, and a fully idle legacy agent still
  cannot be pushed to.

- **Agent-facing guidance lives in four overlapping places that must be kept in sync.** The
  MCP `instructions` string (`INSTRUCTIONS` in [mcp.ts](apps/api/src/mcp.ts), sent on legacy
  `initialize` and in the modern `server/discover` result), the `playbook` array returned by
  `get_briefing` (same file), `SKILL_MD` ([skill.ts](apps/api/src/skill.ts), served at
  `/skill.md`), and `DOC_SKILL_MD` ([skill-docs.ts](apps/api/src/skill-docs.ts), the
  doc-authoring contract — served at `/skill/docs.md` and as MCP resource
  `noriq://skill/doc-authoring`). The duplication is
  intentional — the inline playbook spares a working agent a second fetch, and the skill is not
  registered as an MCP resource, so a bare "read the skill" pointer would dangle. **When you
  change the work-loop contract (claim/release, identity, planning, escalation), update
  INSTRUCTIONS + playbook + SKILL_MD; when you change the docs contract, also DOC_SKILL_MD** —
  they drift silently otherwise. `/reference.md` + `/reference.json` are *generated* from the
  live tool schemas and never need manual sync.

- **`fetchMock` from `cloudflare:test` only intercepts the test isolate, not the worker isolate
  reached via `SELF.fetch()`.** To test code that makes outbound `fetch` from within the Worker,
  inject the fetch function (see `resolveCimdClient(env, id, doFetch)` in [lib/cimd.ts](apps/api/src/lib/cimd.ts))
  and unit-test it directly, rather than driving it through an HTTP route.

- **Task- vs project-scoped tables:** `comments`, `attachments`, and `task_docs` are
  **task-scoped** (no `project_id` column — join through `tasks`); `run_log_segments` is
  run-scoped. `signals`, `messages`, `events`, `docs`, `plan_docs`, `file_locks`,
  `plan_dispatches`, `plan_landings` have `project_id`. `templates` is user-scoped and
  `event_seq` is a global singleton — `deleteProject` must never touch either.

- **The priority scale is INVERTED as of migration 0066 (PLNR-231): 0 = most urgent, 4 = someday,
  default 2.** Every priority sort is `ORDER BY priority ASC`. The migration is a
  `priority = 4 - priority` **data** migration — NOT idempotent; re-running it by hand via
  `d1 execute` silently flips the whole backlog. Pre-0066 backup snapshots carry the old scale
  (see [BACKUP.md](apps/api/BACKUP.md)).

- **Runner-spawned agents (`kind === 'agent'`) have deliberately reduced authority, enforced in
  server code (not the daemon's tool manifest):** they cannot set task `status` via
  `update_task`/`update_tasks`, cannot call `release_task`/`handoff_task` (the run's terminal
  outcome settles its anchor task), and `build`/`verify` run agents cannot rewrite **any** task's
  execution spec ([lib/spec-authority.ts](apps/api/src/lib/spec-authority.ts) — only `scope` runs
  author specs). Separately, **a claimed task's status is not editable via MCP at all**
  (PLNR-226, enforced in the DO), and the GitHub webhook records a PR ref on a claimed task
  without restatusing it. Their `allowedTools` floor means unlisted tools are **not registered**
  (absent from `tools/list`), not advertise-then-deny.

- **The MCP SDK must dedupe to the SAME zod copy as our schemas — the root `package.json` pins
  `zod@^4` for exactly this (PLNR-549).** The SDK's `zod` is a *peer* dep resolved from the
  hoisted root; when the hoisted copy was zod@3.25 (pulled in by `@cloudflare/vitest-pool-workers`),
  its bundled `v4-mini.toJSONSchema` walked our zod@4.4 schemas and silently emitted bare
  `{type:'string'}` — every `.min()/.max()/.describe()` vanished from `tools/list`, so agents
  learned `create_doc`'s 120/300 caps only from the -32602 rejection. `npm ls zod` must show a
  single root `zod@4.x` with 3.x only nested under vitest-pool-workers/miniflare; a scoped
  `overrides` entry does NOT work (peers ignore it). `mcp-2026.test.ts` asserts the limits
  survive. `EXECUTION_SPEC_DESC` in mcp.ts predates this and is kept as belt-and-braces.

- **Dependency edges may cross projects (PLNR-241), and the `dependencies` table has no
  `project_id` — an edge is owned by the DEPENDENT task's project.** Task ids AND display
  keys are globally unique, so blocker refs resolve globally; access to a foreign blocker's
  project is enforced at the MCP/REST edges (`resolveBlockerRef` / `resolveBlockerRefRest`),
  never in the DO. When a task settles (done/cancelled) or is deleted, its room fire-and-forgets
  `onExternalBlockerSettled` into each foreign dependent's room (event + dispatch pump) —
  best-effort only; claim gates and pumps re-read global D1, so correctness never depends on
  it. `move_task` keeps dependency edges (they just become cross-project); plan phase gating
  remains intra-project by construction.

- **Two event cursors exist — don't conflate them.** Per-project `events.seq` is the WS resume
  cursor; `events.global_seq` (trigger-assigned from the singleton `event_seq` table, migration
  0056) is the `my_updates` notices cursor. rowid is unusable — `events.id` is a TEXT PK, so
  SQLite reuses rowids after `deleteProject` (PLNR-111).

- **There are TWO migration directories, and mixing them is destructive.**
  [apps/api/migrations/](apps/api/migrations/) is **D1's** — applied wholesale by the wrangler
  CLI (`migrations_dir`) and by `readD1Migrations()` in the test harness.
  [apps/api/memory-migrations/](apps/api/memory-migrations/) is the **ProjectMemory Durable
  Object's own SQLite schema** — applied *inside* the DO at construction, gated by a durable
  `_meta.schema_version`, so it ships in the Worker bundle (a Worker has no runtime filesystem).
  Putting a memory migration in `migrations/` would create the memory tables in D1 and record
  them in `d1_migrations`. Both directories hold **only** `.sql` files; the ordered manifest that
  loads the memory ones is [src/memory/migrations.ts](apps/api/src/memory/migrations.ts), which
  documents how to add one. `.sql` imports need **no** wrangler config
  (it ships a default Text rule for `**/*.sql` — adding your own `rules` entry *shadows* that
  default and fails the build unless it sets `fallthrough: true`), but the vitest pool builds
  with vite and needs the `sql-as-text` plugin in `vitest.workspace.ts`.

- **Durable Object SQLite enforces foreign keys ALWAYS and ignores `PRAGMA foreign_keys`.**
  `PRAGMA foreign_keys = OFF` still reads back `1` and a dangling insert still raises
  `SQLITE_CONSTRAINT` (verified against workerd) — the mirror image of D1, which ignores the
  pragma in the other direction. Anything that needs to load rows in an FK-violating order must
  therefore use constraint-free tables, not a pragma. Two related traps in the same API:
  `ALTER TABLE … RENAME TO` **rewrites the old name inside other tables' FK clauses** (renaming
  `nodes` silently repoints `edges.from_node_id` at the new name) and stores the renamed table
  **quoted** (`CREATE TABLE "edges"`), which breaks textual `CREATE TABLE <t>` matching. This is
  why `ProjectMemory`'s restore stages into `CREATE TABLE … AS SELECT * … WHERE 0` copies and
  swaps *contents* inside one transaction rather than renaming tables (PLNR-249/250).

- **Project `docs` and `plan_docs` are different beasts:** project docs are settled-decisions-only
  (enforced by [lib/doclint.ts](apps/api/src/lib/doclint.ts) — TBD/open-question phrasing is
  rejected) and vector-indexed; plan-local docs (PLNR-200) are working documents — never indexed,
  never linted, deliberately a separate table.

- **A deployed change no longer needs a hard browser refresh by default** — the SPA compares its
  build-time `__APP_VERSION__` against `/api/health` and the snapshot version and reloads itself
  once per server version (PLNR-193). A hard refresh is the fallback if that guard misfires.

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
