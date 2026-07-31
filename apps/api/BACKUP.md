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
