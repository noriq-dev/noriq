# Research: non-Cloudflare deployment (PLNR-147)

**Question:** can Noriq ship as a Docker container for users who don't want a Cloudflare
account, and what would it cost us?

**Short answer:** yes, and the proof already runs in CI. The entire app — Durable
Objects, D1, R2, cron — executes inside `workerd` (Cloudflare's open-source runtime)
on every `npm test`, with SQLite standing in for D1 and disk for R2. A Docker image is
"that, supervised, with volumes." The real decision is which of two packagings to ship.

## What we're coupled to

| Binding | Used for | Portability |
|---|---|---|
| Durable Objects | `ProjectRoom` (sole writer / claim arbiter / event seq), `AgentSession` (notice cursors), `RateLimiter`, `RunnerHub` (daemon WS) | **The crux.** Needs actor semantics: serialized execution per key, storage, alarms, WebSocket ownership. |
| D1 | all state | SQLite dialect throughout — trivially portable to a SQLite file; our migrations already apply cleanly in workerd. |
| R2 | attachments, backups | Any blob store: disk volume or S3-compatible. |
| Workers Assets | the SPA | Any static file serving. |
| Email binding | invites/resets/signal alerts | Already optional-by-design (`sent:false` fallback). SMTP adapter later. |
| Cron trigger | nightly backup/sweep/demo reset | Container cron / `setInterval`. |

Everything else (Hono, zod, the MCP server) is runtime-agnostic.

## Option A — ship workerd in Docker (recommended)

Run the same runtime we already trust:

```
FROM node:22-slim            # miniflare drives workerd; workerd binary comes with it
COPY dist/ migrations/ …
CMD ["node", "server.mjs"]   # ~80-line launcher: miniflare with persistence flags
```

- **Miniflare** (the library underneath `wrangler dev` and our test pool) provides
  production-grade-enough emulation: D1 → SQLite files, R2 → disk, DOs → persisted
  per-key state, alarms, cron, WS. Volumes: `/data/db`, `/data/blobs`.
- **Effort:** small — a launcher script, a Dockerfile, health checks, docs. No
  application code changes at all.
- **Risks / honest caveats:**
  - Miniflare is positioned as a *dev* tool. It is very close to production workerd
    semantics (it IS workerd), but Cloudflare doesn't support this use. Pin versions.
  - Single-node only: DO uniqueness holds within the process. That's fine — a
    self-hosted Noriq is a single-team instance; the sole-writer invariant actually
    gets *stronger* on one node.
  - Backup story becomes "snapshot the volume" (plus the existing JSON export).

## Option B — Node port behind a platform-adapter layer

Introduce `PlatformAdapter { db, blobs, actor(), email, cron }` and implement it twice
(CF bindings / Node+better-sqlite3+fs+ws). The DO shim is the only interesting piece:
a per-key async mutex + a storage table + `setTimeout` alarms reproduces everything
`ProjectRoom` uses (`blockConcurrencyWhile`, `storage.get/put`, `alarm`, WS fanout).

- **Effort:** medium (touches every binding call site; ~2–3 focused tasks), then a
  permanent tax: every new feature must be written against the adapter.
- **Payoff:** no dependence on dev-tool positioning; can later scale beyond one node
  (external SQLite/Postgres, Redis locks) if that ever matters.

## Recommendation

1. **Ship Option A now** as the `noriq/selfhost` image — it's days, not weeks, and the
   test suite is the compatibility proof. Label it "single-node self-host."
2. **Adopt the adapter interface opportunistically** (Option B) only where code is
   touched anyway; don't do a big-bang port. If Option A's miniflare dependency ever
   bites, the adapter work will already be partly paid for.
3. Non-goals for v1: multi-node HA, Postgres, Kubernetes charts.

**Suggested follow-up tasks** (not yet filed): `selfhost: miniflare launcher + Dockerfile
+ /data volumes`, `selfhost: SMTP email adapter`, `selfhost: docs page + compose file`.
