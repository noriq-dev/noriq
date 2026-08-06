# Backup & restore (D1)

Noriq stores all durable state in one D1 database (`DB`). There are two backup
paths — pick either or both.

## 1. Automatic daily snapshot → R2 (PLNR-21)

The Worker has a cron trigger (`0 6 * * *`, 06:00 UTC — see `wrangler.jsonc`) that
writes a full logical snapshot of every table to the R2 bucket bound as `FILES`,
under `backups/noriq-<timestamp>.json`.

- Requires R2 to be enabled and `FILES` bound (it already is in
  `wrangler.production.jsonc`). Without R2 the cron is a logged no-op — safe to leave on.
- Trigger it on demand: `POST /api/admin/backup` with the admin token.
- Adjust the schedule by editing `triggers.crons`, or add lifecycle rules on the
  bucket to expire old snapshots.

## 2. On-demand download

`GET /api/admin/export` (admin token) streams the same snapshot as a JSON download:

```sh
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://<your-host>/api/admin/export -o noriq-backup.json
```

The snapshot is `{ noriq: "d1-snapshot", version, exportedAt, counts, tables }`,
where `tables` maps each table name to its rows. Tables are discovered from
`sqlite_master`, so the dump always follows the live schema.

## ProjectMemory portable snapshots (PLNR-248)

Separate from the D1 backup above: each project's cognitive memory (the graph, evidence,
decisions, episodes, and outbox/cursor state) lives in its own `ProjectMemory` Durable Object,
not in D1 — see [CLAUDE.md](../CLAUDE.md) and the "Project Memory — settled architecture
decisions" project doc for why. It gets its own portable snapshot mechanism, exported to the
same `FILES` R2 bucket under a different prefix so the two never collide:

```
memory-backups/<projectId>/<exportedAt>/manifest.json
memory-backups/<projectId>/<exportedAt>/<table>/chunk-<n>.jsonl.gz
```

- Namespaced by project, so one project's backup can never overwrite another's, even with
  identical timestamps.
- Each chunk is gzip-compressed JSONL, bounded to a few hundred rows — exporting never holds
  a whole table (or the whole store) in memory at once, so it scales to a large project.
- `manifest.json` is written **last**. Its presence is what marks the backup complete; a crash
  mid-export leaves orphaned chunks but no manifest, and nothing should treat that as
  restorable. It carries the format/schema versions, the memory revision, per-table row counts,
  a sha256 checksum for every chunk, and the chunk keys (`r2EvidenceRefs`) — enough for a
  restore to detect a corrupted or missing chunk before trusting any of it.
- `tier` in the manifest is `core` or `full`. Today they're identical — `full`'s additional
  active code-index generation *content* doesn't exist until a later phase — the field just
  keeps the manifest shape stable for when it does.

**Trigger it:**

```sh
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://<your-host>/api/admin/memory-backup/<projectId>"
```

Add `?tier=full` for the full tier (currently equivalent to core). Without R2 bound, this
returns `503` with a reason — every other ProjectMemory operation (reads, writes, the outbox)
keeps working regardless; backup is the one optional-binding feature here.

**Schedule:** the same daily cron that runs the D1 backup (`0 6 * * *`) also exports a fresh
snapshot for every project that has ever touched its memory store (i.e. has a row in the
compact D1 `project_memory_registry` — a project that hasn't has nothing in ProjectMemory yet
worth backing up). Each project's export is independent; one failing never blocks another's.
Recent status is visible in that same registry row (`backup_status`, `last_backup_at`).

### Restoring a ProjectMemory snapshot (PLNR-249)

Restore is **generation-based, never delete-first**: every table from the snapshot imports into
a staging copy inside the project's own store, gets fully validated there (row counts against
the manifest, checksums on every chunk, and edges/evidence pointing at rows that actually
exist), and only then does one atomic switch make it active. If validation fails at any point,
the active generation is untouched — nothing was ever deleted to make room for the restore.

```sh
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://<your-host>/api/admin/memory-restore/<projectId>?confirm=replace&exportedAt=<exportedAt>"
```

`exportedAt` is the timestamp segment from the backup you want (the same value that appears in
its R2 prefix, `memory-backups/<projectId>/<exportedAt>/`). Refuses without `?confirm=replace`.
Exempt from the write-freeze, like `/api/admin/import` — `freeze → restore → unfreeze` is a
clean cutover here too.

**Rollback** — the generation that was active immediately before the restore is retained (not
deleted) until explicitly pruned, so you can undo without re-uploading or re-validating anything:

```sh
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://<your-host>/api/admin/memory-restore/<projectId>/rollback"
```

This is a **single-level** undo — only the immediately preceding generation is kept, so rolling
back twice in a row does nothing the second time (there's nothing left to swap back to). The
retained generation is pruned automatically on a policy timer (PLNR-250) or can be discarded
manually.

**Derived vectors after a restore:** a snapshot's rows never carry trusted vector embeddings —
after activation the project is marked vector-dirty (visible in `project_memory_registry`) and
must be re-embedded from the restored canonical rows. There is no memory Vectorize index to
rebuild from yet (that lands in a later phase); the flag exists now so that pipeline has
something to read once it does.

**Schema compatibility:** a snapshot from a *newer* server than the one restoring it is refused
outright — there's nothing to safely migrate it forward from. A snapshot from an older schema
version is accepted (today there is only one schema version, so this path is dormant until a
second one exists).

## 3. Restore

### Option A — full fidelity via wrangler (recommended)

For a true byte-for-byte restore, use D1's native export/import against SQL rather
than the JSON snapshot:

```sh
# Back up (SQL):
wrangler d1 export noriq --remote --output noriq.sql --config wrangler.production.jsonc

# Reorder before restoring — REQUIRED, see below:
python3 scripts/reorder-d1-dump.py noriq.sql noriq-ordered.sql

# Restore into a fresh/empty database:
wrangler d1 execute noriq --remote --file noriq-ordered.sql --config wrangler.production.jsonc
```

> ⚠️ A raw export does **not** import back as-is (learned the hard way during the
> PLNR-143 cutover): the dump lists tables alphabetically and D1's import API does
> not honor its `PRAGMA defer_foreign_keys` across internal batching, so the first
> INSERT that references a later table fails (`no such table: main.runners`).
> `scripts/reorder-d1-dump.py` rewrites the dump into FK-dependency order, breaks
> the agents↔oauth_tokens cycle via patch UPDATEs, preserves `events` rowids (the
> agent notice-cursor), and self-verifies with a strict FK-on rehearsal.

Keep a periodic `wrangler d1 export` in your own CI/cron if you want SQL-level backups
in addition to the R2 JSON snapshots.

### Option B — from a JSON snapshot, via `POST /api/admin/import`

The JSON snapshot (from the cron or `/api/admin/export`) restores through a live endpoint —
the inverse of `/export`. Point it at a database already migrated to a **compatible schema**
(`wrangler d1 migrations apply noriq`); the snapshot may predate a column (it takes the
default) but must not carry one the schema lacks (rejected, so no data is silently dropped).

```sh
curl -X 'POST' -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @noriq-backup.json \
  'https://<your-host>/api/admin/import?confirm=replace'
```

- **Destructive — it REPLACES, it does not merge.** The database is made to match the
  snapshot exactly: tables absent from the snapshot are emptied. `?confirm=replace` is the
  required guard (without it: `400`, nothing touched). The response echoes per-table
  `imported` counts to verify against the snapshot's `counts`.
- **Atomic.** The whole delete + reload runs in one D1 transaction, so a failure rolls back
  and the database is left untouched.
- **FK ordering is handled for you.** Rows load parents-before-children in an order derived
  from the live schema at import time, and the `agents`↔`oauth_tokens` cycle + self-references
  (`tasks.parent_task_id`, `agents.parent_agent_id`) are broken automatically — the same
  problem `scripts/reorder-d1-dump.py` solves for the SQL path, so no manual reordering.
- **Restoring over a live instance?** Turn on the write-freeze (`MAINTENANCE_MODE=1`, PLNR-166)
  first so concurrent coordination writes don't race the reload; `/api/admin/import` is exempt
  from the freeze, so `freeze → import → unfreeze` is a clean cutover. Agents' notice cursors
  live in the `AgentSession` DO (outside D1), so after a restore a working agent may see no
  notices until the event `global_seq` climbs past where its cursor was — reconnecting resets it.

> The JSON snapshot is best for inspection, migration between instances, and restoring over a
> running instance. For very large databases prefer Option A (a single atomic import batch can
> grow past D1's request limits — `/api/admin/import` fails cleanly and unchanged if it does).

## Data-rewrite migrations vs old snapshots — check before restoring

A restore replaces table **data**, but `d1_migrations` (and the schema) stay at the live
database's state. Additive column migrations are immune — a snapshot that predates a column
just takes the default. **Migrations that rewrite VALUES are not.** A snapshot taken before
such a migration carries the old encoding, and restoring it loads that old encoding into a
database whose tracker says the rewrite already ran — nothing will ever re-apply it.

Value-rewrite migrations to date:

- **`0066_invert_priority` (2026-07-31, PLNR-231)** — inverted `tasks.priority` from
  4-is-urgent to 0-is-urgent (`priority = 4 - priority`). Any snapshot exported **before**
  this date holds old-scale priorities; restoring one silently ranks the entire backlog
  upside down. After restoring a pre-0066 snapshot, re-apply the rewrite by hand:
  `wrangler d1 execute DB --remote --command "UPDATE tasks SET priority = 4 - priority"`
  (once — it is an involution, so running it twice undoes it). The same applies to
  pre-rename `backups/planar-*.json` snapshots in the old R2 bucket.

When adding a future value-rewrite migration, list it here and consider whether the
snapshot's `version` field should gate the import.

## ProjectMemory disaster recovery (PLNR-250)

Two independent recovery tiers exist for each project's `ProjectMemory` store, for two
different failure modes:

**Tier 1 — native Durable Object point-in-time recovery.** Cloudflare's SQLite-backed Durable
Objects keep a rolling history of the storage state, independent of anything Noriq does. It
covers *operational* rollback — "this project's memory looks wrong as of an hour ago, put it
back" — over roughly a **30-day window**. It is accessed through the storage bookmark API:

- `storage.getCurrentBookmark()` — a bookmark for right now.
- `storage.getBookmarkForTime(timestamp)` — the bookmark closest to a point in the window.
- `storage.onNextSessionRestoreBookmark(bookmark)` — arms the DO to restore to that bookmark the
  next time it starts a session (i.e. on its next request).

This is Cloudflare-side recovery, not something Noriq's application code drives end to end —
there is no admin route for it here. It is the right tool for "someone fat-fingered a restore
five minutes ago", not for long-term retention, migrating between instances, or recovering from
losing the Durable Object namespace entirely (see the limitation below — PITR does not survive
that).

**Tier 2 — portable R2 snapshots (PLNR-248/249).** The `memory-backup`/`memory-restore` routes
documented above. This is the tier for long retention, migrating a project to a different
Noriq instance, and recovering after the DO's own storage is gone (namespace loss, see below) —
anything PITR's 30-day, this-instance-only window can't reach.

**Rehearsed:** the portable tier (export → destroy → restore → verify) is exercised end to end
in `test/memory-lifecycle.test.ts`, in the same workerd test environment this whole suite runs
in — real gzip, real R2 (miniflare's simulator), real SQLite generation switch. The PITR tier's
bookmark API is **not** exercised by that test: `getCurrentBookmark`/`getBookmarkForTime` are
smoke-tested for availability where the test harness supports it, but a true point-in-time
*restore* — verifying data actually reverts — has only been exercised against production
Cloudflare infrastructure, not rehearsed in this repository's test suite. Treat the portable
tier as the one with automated proof; treat PITR as production-verified-only until that changes.

**Limitation — Durable Object namespace deletion is unrecoverable by either tier.** A
`deleted_classes` entry in `wrangler.jsonc`'s DO migrations permanently wipes every instance's
storage in that namespace — PITR's rolling history is gone with it, and there is nothing to
restore from unless a portable R2 snapshot happens to already exist from before the deletion.
**Never** add a `deleted_classes` migration to "fix" a cosmetic issue (a namespace label, a
rename) — see [CLAUDE.md](../CLAUDE.md)'s Naming section. The only durable protection against
this class of mistake is having portable snapshots in R2 *before* it happens, which is exactly
what the daily cron (PLNR-248) is for.

## ProjectMemory lifecycle: deletion, retention, and size (PLNR-250)

Deleting a project schedules erasure of its `ProjectMemory` store via a durable tombstone
(`memory_erasure_tombstones`, migration 0072) written in the SAME atomic batch as the rest of
the deletion cascade — so even if the immediate best-effort erasure attempt is lost (an
unreachable DO, a recycled isolate), the record that this project's memory MUST be erased
survives. A scheduled sweep (part of the same daily cron as the backups above) retries any
standing tombstone until every step of the erasure — the DO's own rows, its entire
`memory-backups/<projectId>/` R2 prefix, and (once they exist in later phases) its vector
entities and ingest capabilities — reports complete, then clears the tombstone. Trigger the
sweep on demand: `POST /api/admin/memory-lifecycle-sweep`.

The same sweep prunes debris on a policy timer: abandoned staged index generations, a restore's
retained prior generation once its rollback window has passed, and backups beyond a keep-last-N
retention count. All of it is idempotent — running the sweep twice in a row does nothing new
the second time.

Per-project size is visible via `health()` (`databaseSize`, `sizeStatus`) and projected into
`project_memory_registry.size_bytes`/`size_status` (migration 0073) by the same sweep. This is
**visibility only** — crossing the warn or critical threshold does not refuse writes; the goal
is a warning appearing before a store becomes operationally unsafe, not an enforced quota.
