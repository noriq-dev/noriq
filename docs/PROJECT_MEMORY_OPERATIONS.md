# Project Memory operations

This is the self-hosting and day-two operations guide for Project Memory. It covers the boundary
between D1 and the per-project Durable Object, optional Cloudflare services, Runner repository
ingest, upgrades, recovery, deletion, and release checks. Detailed snapshot formats and restore
semantics live in [`apps/api/BACKUP.md`](../apps/api/BACKUP.md); the security and measured-load
records live in [`PROJECT_MEMORY_SECURITY_REVIEW.md`](PROJECT_MEMORY_SECURITY_REVIEW.md) and
[`PROJECT_MEMORY_LOAD_PROFILE.md`](PROJECT_MEMORY_LOAD_PROFILE.md).

## Storage and capability map

Only D1 and the six Durable Object bindings in the example config are required. All other
bindings are optional and may be added after the first deployment.

| State | Canonical home | Optional service | Behavior when absent |
| --- | --- | --- | --- |
| Projects, tasks, plans, users, repository routing, compact memory health | D1 (`DB`) | None | Required; the Worker cannot start without it |
| Cognitive memory, evidence, graph, episodes, repository generations | Per-project SQLite `ProjectMemory` Durable Object | None | Required; lexical and graph retrieval continue without AI |
| Live project coordination and Runner/session state | Other required Durable Objects | None | Required |
| Attachments, D1 snapshots, portable ProjectMemory snapshots | R2 (`FILES`) | R2 | Attachments and portable backups report unavailable; memory reads/writes continue |
| Embeddings and Ask generation | Workers AI (`AI`) | Workers AI | Ask is unavailable; search falls back to non-semantic stages |
| Authored-memory/task/doc semantic vectors | `VECTORIZE` (`noriq-search`) | Vectorize | Keyword, lexical, and graph retrieval continue |
| Repository-code semantic vectors | `CODE_VECTORIZE` (`noriq-code`) | Vectorize | Repository lexical and graph retrieval continue |
| Invite delivery | `EMAIL` | Email Service | Invites become copyable links |

D1 is the cross-project control plane. It intentionally does not contain the full cognitive graph.
Each `ProjectMemory` Durable Object is authoritative for exactly one project's memory, evidence,
episodes, code generations, and graph. The D1 `project_memory_registry` row is only a compact
operational projection (backup, vector-dirty, and size status); never recover or infer the graph
from that row.

Vector indexes are derived caches. Canonical authority, visibility, and validity are rechecked
from D1/ProjectMemory after vector lookup. Backups do not trust or restore embeddings.

## Deploy a clean-account instance first

The production example leaves email, R2, Workers AI, and Vectorize commented out. A first deploy
therefore needs only D1 plus the required Durable Object declarations, which Wrangler creates from
the append-only `v1` through `v5` migration list.

```sh
cd apps/api
cp wrangler.production.jsonc.example wrangler.production.jsonc
npx wrangler d1 create noriq
# Put the printed database id in d1_databases[0].database_id.
npm run db:migrate:remote
cd ../..
npm run deploy
```

For `workers.dev`, remove the custom `routes` entry. Do not remove `PROJECT_MEMORY`, collapse or
renumber the Durable Object migrations, or add `deleted_classes`. A Durable Object class deletion
permanently destroys its namespace and its point-in-time history.

Verify the reduced-capability deployment:

1. Complete the setup wizard and create a project, task, and doc.
2. Open Memory > Operations. Canonical store must be reachable; R2 and vector capability fields
   must honestly report unconfigured.
3. Search for the task/doc. Keyword retrieval must work without Vectorize.
4. Confirm attachment upload, portable backup, and Ask fail as unavailable rather than presenting
   false success or taking ordinary memory reads down.

## Add the full memory stack

### R2: attachments and portable backups

```sh
cd apps/api
npx wrangler r2 bucket create noriq-files --config wrangler.production.jsonc
```

Uncomment `r2_buckets` in `wrangler.production.jsonc`, deploy again, trigger a ProjectMemory
backup, and verify that its manifest is present under
`memory-backups/<projectId>/<exportedAt>/manifest.json`. The manifest is written last; a prefix
without it is an incomplete export, not a backup. Apply an R2 lifecycle policy appropriate to the
organization's retention requirements in addition to Noriq's keep-last-N sweep.

### Workers AI and Vectorize

Create both indexes before adding their bindings. The indexes are deliberately separate because
repository generations churn independently of authored memory and task/doc search.

```sh
cd apps/api
npx wrangler vectorize create noriq-search --dimensions=1024 --metric=cosine
npx wrangler vectorize create-metadata-index noriq-search --property-name=projectId --type=string

npx wrangler vectorize create noriq-code --dimensions=1024 --metric=cosine
npx wrangler vectorize create-metadata-index noriq-code --property-name=projectId --type=string
npx wrangler vectorize create-metadata-index noriq-code --property-name=repositoryKey --type=string
npx wrangler vectorize create-metadata-index noriq-code --property-name=generationId --type=string
```

Uncomment `ai` and the desired `vectorize` entries, then deploy. `VECTORIZE` requires the
`projectId` metadata index. `CODE_VECTORIZE` requires all three metadata indexes; omitting one can
make filtered production queries fail even though in-memory tests pass.

After enabling the bindings:

1. From an authorized MCP client, call `reindex_search` for the project and repeat with the
   returned offset until `remaining` is zero. This repairs `noriq-search` content created before
   Vectorize was enabled.
2. In Memory > Operations, run **Rebuild vectors** for each project that reports vector-dirty.
3. Ask a semantic question and verify its cited project/task/doc references resolve.
4. Reindex one opted-in repository through Runner, confirm the completion receipt reports atomic
   activation, and verify both lexical traversal and semantic code retrieval.

Workers AI model behavior is a live dependency. Validate every configured `ASK_MODELS` entry in
staging for streaming and multi-round tool calls before advertising it in production.

## Runner repository indexing: server first, explicit consent

Repository intelligence is an HTTP ingest rail, not a WebSocket bulk frame and not a direct
Vectorize write. Set `ATTACHMENT_UPLOAD_SECRET` (or, less desirably, `ADMIN_TOKEN`) before enabling
it:

```sh
cd apps/api
npx wrangler secret put ATTACHMENT_UPLOAD_SECRET --config wrangler.production.jsonc
```

The server must know the repository and the live Runner checkout association before an upload can
start. In the project settings, register the repository key and associate the online Runner. Then
the repository itself must opt in through committed configuration:

```toml
[index]
enabled = true
include = ["src/**", "docs/**"]
exclude = ["**/*.generated.*"]
```

The Runner executes this server-owned sequence:

1. Authenticate as its OAuth connection and request a short-lived capability for exactly one
   project, repository key, purpose, scope id, Runner, checkout, and byte ceiling.
2. Call `begin`, upload bounded numbered batches with checksums, then call `complete`.
3. The `ProjectMemory` store validates counts, hashes, references, and completeness while the old
   generation remains active.
4. If validation passes, `complete` atomically activates the generation only while the active
   predecessor still matches the one recorded at `begin`; its response carries the activation
   receipt. This prevents two concurrent uploads from silently overwriting each other.
5. Search reads only active generations. An incomplete, invalid, or predecessor-conflicted staged
   generation never becomes canonical. An admin can inspect and activate or abort a retained
   staged generation as an explicit recovery action.

Use the Runner's supported controls rather than constructing capability URLs by hand:

```sh
noriq-runner index-repo --check-determinism  # local-only preview; cannot upload
noriq-runner index-status
noriq-runner index-reindex                   # request validation + atomic activation
noriq-runner index-cancel
```

Turning `[index].enabled` off stops future triggers; it does not retract previously activated
server content. `index-forget-journal` erases only local Runner bookkeeping. Server-side removal
belongs to the project operator and project deletion lifecycle.

## Routine operations

Memory > Operations is the preferred human surface because it combines the Durable Object health,
D1 registry projection, configured capability flags, generations, graph drift, and guarded
actions. The instance-admin bearer routes remain useful for automation:

```sh
# Portable per-project backup
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://<host>/api/admin/memory-backup/<projectId>?tier=core"

# List/project health is visible in Memory > Operations. Run all-project lifecycle maintenance:
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://<host>/api/admin/memory-lifecycle-sweep"
```

Available admin actions in Memory > Operations include:

- back up and restore a chosen portable generation;
- roll back the immediately preceding restored generation or prune that retained copy;
- activate or abort a repository index generation;
- rebuild ProjectMemory vectors from canonical rows;
- rebuild the disposable Constellation hierarchy and backfill coordination graph projections
  through the lifecycle sweep;
- run the per-project idempotent lifecycle sweep.

There are three different reindex operations; use the one matching the stale derived data:

- **Task/doc/plan search stale:** call the MCP `reindex_search` maintenance tool, passing its
  returned offset until `remaining` is zero.
- **Memory/episode semantic vectors dirty:** Memory > Operations > Rebuild vectors.
- **Repository generation stale:** `noriq-runner index-reindex`, then confirm `index-status`
  reports the server-confirmed active generation. Do not replace this with the task/doc/plan
  Search reindex.

## Backups, restore, and recovery rehearsal

Back up both planes. A D1 snapshot does not contain ProjectMemory, and a ProjectMemory snapshot
does not contain project membership, repository routing, tasks, or users.

- D1: scheduled JSON snapshot to `backups/`, on-demand `/api/admin/export`, or native
  `wrangler d1 export`.
- ProjectMemory: scheduled or on-demand portable R2 snapshot under `memory-backups/<projectId>/`.
- Short-window operational rollback: Cloudflare Durable Object point-in-time recovery/bookmarks.

Before an upgrade or restore, record the latest D1 export and a fresh portable snapshot for every
project with memory. Confirm checksums/manifests by restoring into a disposable target. Do not call
a backup successful merely because chunk objects exist.

A recovery rehearsal should prove this sequence without production mutation:

1. Provision a separate Worker name, D1 database, R2 bucket, and Vectorize indexes. Never share a
   production Durable Object script name, database id, bucket, or index with rehearsal/staging.
2. Apply all D1 migrations to the empty target and import the D1 snapshot.
3. Copy or generate the chosen ProjectMemory snapshot in that target's R2 namespace, restore it,
   and compare manifest counts plus representative memory, evidence, graph, and episode reads.
4. Rebuild derived vectors and analytics; verify a lexical query too, so Vectorize cannot hide a
   broken canonical restore.
5. Exercise the single-level rollback while the retained generation exists.
6. Delete the disposable target only after results are recorded. Deleting the Worker destroys its
   Durable Object storage, so verify its name is not production first.

The automated `memory-lifecycle` tests prove portable export, destruction, restore, validation,
and rollback in workerd. They do not replace a Cloudflare-hosted rehearsal of R2 permissions,
Durable Object PITR, CPU, or peak memory.

## Upgrade and rollback

Treat D1 migrations, Durable Object migrations, and a Worker deployment as separate steps.

1. Read every new migration. D1 migrations must be forward-safe for the currently deployed code;
   Durable Object migration tags must only be appended.
2. Run the repository typecheck, ordinary API suite, Wrangler config check, and opt-in load profile.
3. Export D1 and ProjectMemory as described above.
4. Deploy and migrate an isolated staging instance with distinct storage bindings. Rehearse both
   reduced-capability and full-binding startup.
5. For an additive release, apply D1 migrations and then deploy the Worker promptly. For a
   data-rewrite/cutover, enable `MAINTENANCE_MODE`, drain writes, snapshot, migrate, deploy, smoke
   test, and only then clear maintenance mode.
6. Verify canonical memory reachability, schema/revision, backup status, graph drift, vector-dirty
   status, active repository generations, Runner status, and representative retrieval.

If the Worker deployment fails before traffic moves, leave the existing version active and fix the
artifact. If the new version is incompatible after migration, do not blindly deploy old code over
a newer schema. Keep maintenance mode on and choose one of:

- deploy a forward fix compatible with the migrated schema;
- repoint to a fresh D1 database restored from the pre-upgrade export, then deploy the prior Worker;
- restore the affected ProjectMemory project from its portable snapshot, or use Durable Object
  PITR for a recent operational rollback.

D1's migration tracker does not replay value rewrites when old data is restored into a new schema.
[`apps/api/BACKUP.md`](../apps/api/BACKUP.md) lists every known data-rewrite migration and its
repair. Never rename a Durable Object class casually and never use `deleted_classes` as rollback.

## Secret rotation

Rotate secrets with `npx wrangler secret put <NAME> --config wrangler.production.jsonc`, then
verify the dependent endpoint before revoking the old upstream credential.

- `ATTACHMENT_UPLOAD_SECRET`: invalidates in-flight attachment/index/episode capabilities. Rotate
  during a quiet window; Runner should mint fresh capabilities and retry bounded work.
- `ADMIN_TOKEN`: immediately invalidates automation using the old bearer. Update the secret store
  supplying backup/restore jobs in the same window.
- `GITHUB_WEBHOOK_SECRET`: update Noriq and the GitHub webhook together, then deliver a signed test.
- `SIGNAL_WEBHOOK_SECRET`: update Noriq and the receiver together, then send a non-critical test.

Never put a secret, capability token, or R2 object credential in Wrangler JSONC, Runner logs, task
comments, or snapshot manifests.

## Deletion and retention

Project deletion atomically creates a durable erasure tombstone with the D1 deletion cascade. The
immediate erasure is best effort; the scheduled lifecycle sweep retries until ProjectMemory rows,
memory backup prefixes, vector targets, and ingest capability state are cleared. Only then is the
tombstone removed. Run `/api/admin/memory-lifecycle-sweep` after a deletion when prompt erasure is
required and retain the returned step results as evidence.

The sweep also prunes abandoned staged generations, expired retained rollback generations, and
portable backups beyond its keep-last-N policy. Configure R2 lifecycle retention as a second,
account-level control. Check `databaseSize`/`sizeStatus`; warning and critical are visibility
signals, not write quotas.

## Troubleshooting

| Symptom | Check | Recovery |
| --- | --- | --- |
| Canonical store unreachable | Worker has `PROJECT_MEMORY`; `v4` migration remains present; project id is correct | Restore the binding/migration declaration and redeploy; do not create a replacement class name |
| Backup unavailable | `FILES` binding, bucket existence, Worker R2 permission | Rebind the correct environment-specific bucket, deploy, and trigger an on-demand backup |
| Restore refused before staging | Format/schema version, complete manifest inventory, chunk size/count/checksum, project prefix | Choose a compatible complete snapshot; do not edit checksums to force acceptance |
| Restore validated but semantic results stale | `vectorDirty`, `AI`, `VECTORIZE` capability | Rebuild memory vectors; lexical/graph results remain authoritative meanwhile |
| Runner capability mint returns 404 | Runner online/heartbeat, OAuth owner/token, repository registration, checkout association | Reconnect the correct Runner and repair the repository association; do not reuse another repository key |
| Runner capability mint returns 403 | OAuth token's current project access | Grant the connection the required project role or reconnect under the correct account |
| Runner capability mint returns 503 | Signing secret absent | Set `ATTACHMENT_UPLOAD_SECRET` and redeploy |
| Generation remains `staged` | Older server returned no activation receipt, or recovery state remains after a conflict | Reconcile `index-status`; if the server still reports staged, review it in Memory > Operations and activate or abort explicitly |
| Code semantic results absent | `AI`, `CODE_VECTORIZE`, all three metadata indexes, active generation | Correct bindings/index metadata; lexical and graph retrieval should still work |
| Graph drift non-zero | Operations drift report by projector-owned edge kind | From an authenticated instance-admin session call `POST /api/projects/<projectId>/memory/graph/rebuild`; recheck for both missing and stale edges |
| Database size warning/critical | Operations health plus load profile | Prune debris/retained generations, review ingest scope, back up, then investigate growth |

## Release checklist

- [ ] Required Durable Object bindings and append-only migrations pass `check:wrangler`.
- [ ] A clean configuration without optional bindings deploys and degrades explicitly.
- [ ] A full staging configuration has distinct D1, R2, Vectorize, and Worker/DO namespaces.
- [ ] D1 and all active ProjectMemory stores have fresh, restorable backups.
- [ ] Typecheck, ordinary API tests, security regressions, and opt-in load profile pass.
- [ ] Runner upload is token-free in logs and reports `active` only from the server's completion
      receipt or canonical cursor, never from bare HTTP success.
- [ ] Canonical, lexical, graph, semantic, backup, restore, rollback, and deletion checks have
      recorded evidence appropriate to the bindings enabled in that environment.
- [ ] Restore/PITR and production CPU/peak-memory claims are labelled local, staging, or live;
      unavailable live evidence is not inferred from workerd.
- [ ] Rollback owner, trigger thresholds, maintenance procedure, and recovery target are named
      before production migration begins.
