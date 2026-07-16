# Backup & restore (D1)

Noriq stores all durable state in one D1 database (`DB`). There are two backup
paths — pick either or both.

## 1. Automatic daily snapshot → R2 (PLNR-21)

The Worker has a cron trigger (`0 6 * * *`, 06:00 UTC — see `wrangler.jsonc`) that
writes a full logical snapshot of every table to the R2 bucket bound as `FILES`,
under `backups/noriq-<timestamp>.json`. (Snapshots taken before the
planar→Noriq rename are keyed `backups/planar-*.json` — equally valid restore sources.)

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

The snapshot is `{ noriq: "d1-snapshot", version, exportedAt, counts, tables }`
(pre-rename snapshots use `planar` as the marker key),
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

### Option B — from a JSON snapshot

The JSON snapshot (from the cron or `/api/admin/export`) is a logical dump. To restore
it into an empty, freshly-migrated database (`wrangler d1 migrations apply noriq`),
replay each table's rows as `INSERT`s in dependency order (parents before children —
e.g. `users`, `groups`, `projects`, then `tasks`, then `comments`/`claims`/`events`…).
A small script that reads the JSON and generates parameterized inserts per table is the
simplest path; the `counts` field lets you verify row totals after import.

> The JSON snapshot is best for inspection, migration between instances, and
> partial/selective restore. For disaster recovery of a single instance, Option A is
> simpler and exact.
