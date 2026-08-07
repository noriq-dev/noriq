import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { newId, nowIso } from '../lib/util';
import {
  buildEntityUri, parseEntityUri, AUTHORITY_HYPOTHESIS, AUTHORITY_HUMAN_APPROVED, AUTHORITY_VERIFIED_MERGED,
  EffortEpisode, EpisodeSelfSummary, type EpisodeLandingOutcome, type MemoryBackupManifest,
} from '@noriq-dev/shared';
import { projectCoordinationEvents, type ProjectedEvent } from '../lib/memory-projector';
import { exportMemorySnapshot, sha256HexBytes } from '../memory/backup';
import { fetchManifest, readSnapshotChunks, checkManifestHeader } from '../memory/restore';
import { deleteAllProjectBackups, sizeStatus, type EraseReport, type EraseStepResult } from '../memory/lifecycle';
import { MEMORY_MIGRATIONS } from '../memory/migrations';
import { validateMemoryScope, validateEvidenceRef, memoryContentHash, evidenceHash, clampAuthority, type MemoryScope } from '../memory/writes';
import { searchBackend, indexEntity, removeEntity } from '../search';
import { codeSearchBackend, indexCodeEntity, removeCodeEntity, type CodeEntityType } from '../memory/code-index';
import {
  parseStagedRow,
  beginIngestEpisode, applyIngestEpisodeBatch, completeIngestEpisode, abortIngestEpisode, type IngestEpisodeState,
  type EpisodeUploadManifest,
} from '../memory/ingest';
import { IndexGenerationManifest, type IndexBatch } from '@noriq-dev/shared';
import { planProjection, changedFileUris, coChangePairs, CO_CHANGE_PAIR_CAP } from '../memory/projection';
import {
  applyMemoryFilters, rankCandidates, RETRIEVAL_DEFAULTS,
  type RetrievalHit, type RetrievalStage, type RankedHit,
} from '../memory/retrieval';
import {
  dependencyNeighborhood, validatingTests, implementingWork, decisionLineage, changeImpact,
  type GraphEntityRef, type DependencyNeighborhoodResult, type ValidatingTestsResult,
  type ImplementingWorkResult, type DecisionLineageResult, type ChangeImpactResult,
} from '../memory/graph-queries';
import { parseExit } from '../memory/episodes';
import {
  effortSignals, duplicateWarnings, summarizeEffort,
  type TaskEffortInput, type EffortCandidate, type DuplicateWarning, type EffortSummary,
} from '../memory/similar-effort';

/**
 * ProjectMemory — one instance per project (idFromName(projectId)), canonical
 * writer and query authority for the project's cognitive memory (Project
 * Memory §2). Separate from ProjectRoom on purpose: graph traversal, ingest,
 * and backup workloads must never sit on coordination mutation latency (§19).
 *
 * This is the FIRST Durable Object in this repo to use the SQLite storage API
 * (`ctx.storage.sql`) directly — ProjectRoom is D1-backed, and AgentSession /
 * RateLimiter / RunnerHub use plain KV storage. The DO's own SQLite is the
 * canonical store; D1 keeps only compact routing/registry rows (PLNR-246), and
 * nothing here parses or normalizes a VCS `baseId` (PLNR-244 keeps that opaque).
 *
 * PLNR-247 adds the outbox<->coordination bridge: a canonical mutation writes its outbox row in
 * the SAME SQLite transaction as the mutation itself; `drainOutbox` delivers pending rows to
 * ProjectRoom (idempotent — retrying is safe, the receiver dedupes); `runProjector` reads D1
 * coordination events past this project's durable `global_seq` cursor and projects a minimal set
 * of them into the graph, advancing the cursor atomically with each projection write. No
 * Queues/Workflows binding exists in this repo (env.ts declares none), so a DO alarm plus the
 * explicit `reconcile` RPC are the whole delivery mechanism — correctness rests on the durable
 * cursor and outbox replay alone, never on a wakeup actually arriving.
 *
 * PLNR-251 adds the real memory/evidence/graph write APIs (`recordMemory`, `writeNode`,
 * `writeEdge`, `addContradiction`) — see the block comment above that section for their shared
 * shape. Later phases (retrieval, ingest, episodes, approval) build on top of these.
 */

// This DO's internal SQLite schema lives in apps/api/memory-migrations — real `.sql` files, one
// per version and nothing else, ordered by the manifest in ../memory/migrations.ts. Adding a
// migration is a new file plus one manifest entry; the rules (never edit a shipped migration;
// stay additive) are documented there. Note that directory is a SIBLING of apps/api/migrations,
// which is D1's and is applied by the wrangler CLI — the two must never be mixed.

export interface ProjectMemoryHealth {
  projectId: string;
  schemaVersion: number;
  memoryRevision: number;
  tableCounts: Record<string, number>;
  databaseSize: number;
  sizeStatus: 'ok' | 'warn' | 'critical';
}

/**
 * `recordEpisode`'s input (PLNR-263) — the deterministic skeleton's fields (matching
 * `memory/episodes.ts`'s `EpisodeSkeleton` one-for-one) PLUS the two things a skeleton alone
 * cannot carry: `agentId`/`runKind`/`outcome`/`startedAt`/`finishedAt` are the run's OWN
 * identity, always resolved by the CALLER from `runs` (never trusted from an uploaded payload —
 * `completeEpisodeIngest`, the other caller, does its own tiny `runs` lookup before calling
 * this, exactly like `recordEpisodeForRun` does), and `selfSummary`/`actor` are the two fields
 * only a daemon upload or an agent can supply. `taskTitle` is a label hint for the task node,
 * never persisted as its own column.
 *
 * `sitting` (correction, migration 0075/0007): an episode's identity is (run_id, sitting), NOT
 * run_id alone. `ProjectRoom.reopenRun` reuses one run id across multiple sittings (RUN-182) —
 * without this, a reopened run's terminal transition would upsert straight over the failed
 * sitting's episode, destroying evidence §14 requires stay retrievable. Always the run's OWN
 * `runs.sitting` value, resolved by the caller the same way the other identity fields are —
 * never trusted from an uploaded payload.
 */
interface RecordEpisodeInput {
  runId: string;
  sitting: number;
  agentId: string | null;
  runKind: string;
  outcome: string;
  startedAt: string | null;
  finishedAt: string | null;
  taskId: string | null;
  taskTitle?: string | null;
  repositoryKey: string | null;
  baseId: string | null;
  timeline: Array<{ at: string; label: string }>;
  filesTouched: string[];
  commands: string[];
  testsRun: string[];
  failures: string[];
  findings: Array<{ summary: string; severity?: string }>;
  reviewRounds: number;
  tokenUsage: Record<string, unknown>;
  costUSD: number;
  acceptanceCoverage: number | null;
  steeringEvents: string[];
  landingOutcome: string;
  remainingWork: string[];
  selfSummary?: unknown;
  actor: { kind: string; id: string | null };
}

export const SCHEMA_TABLES = [
  'repositories',
  'index_generations',
  // PLNR-261's staged-generation tables: children of index_generations by convention (no real
  // FK — see the migration's comment), so they must come right after it here too, both for
  // backup/restore's generic parent-first/child-first ordering and for erase()'s reverse pass.
  'index_batches',
  'index_staged_entities',
  'index_staged_edges',
  'nodes',
  'edges',
  'memory_items',
  'evidence',
  'feedback',
  'contradiction_sets',
  'contradictions',
  'memory_authority_transitions',
  'episodes',
  'outbox',
] as const;

// Operational ledgers (PLNR-247) that are not part of SCHEMA_TABLES' health/erase accounting
// (health counts them separately below; erase clears them explicitly) but that a faithful
// backup/restore (PLNR-248/249) must carry — a restore missing these would re-project already
// consumed coordination events and re-deliver already-emitted operations on the next reconcile.
export const OPERATIONAL_TABLES = ['applied_operations', 'memory_revision', 'projector_cursor'] as const;

/** Every table a backup (PLNR-248) exports and a restore (PLNR-249) imports, parents before
 *  children — the same generic per-table chunking applies to both graph data and the
 *  operational singletons (memory_revision, projector_cursor are one row each, chunked the same
 *  way as everything else rather than carved into bespoke manifest fields). */
export const BACKUP_TABLES = [...SCHEMA_TABLES, ...OPERATIONAL_TABLES] as const;

/**
 * The shape of one accumulated episode-upload row (PLNR-263): an `EffortEpisode`, minus the
 * three fields the SERVER always owns rather than trusting a daemon-supplied value — `id` and
 * `createdAt` are minted by `recordEpisode` itself (see its own doc comment on why `episodeId`
 * is resolved once, synchronously, rather than trusted from a payload), and `projectId` is
 * already the RPC's own first parameter. A row that fails this parse is skipped, not fatal to
 * the rest of the upload — the same per-row tolerance `planProjection` applies to staged index
 * rows.
 */
const UPLOADED_EPISODE_SHAPE = EffortEpisode.omit({ id: true, projectId: true, createdAt: true });

/**
 * PLNR-255: the embedding/display text derived from an episode's `body` JSON blob — `body` is
 * written by `recordEpisode` (PLNR-263), the canonical (and, since that task, only) episode
 * writer. Picks the human-legible bits: the self-summary's approach and durable learnings, and
 * each finding's summary. Malformed/absent JSON degrades to a fixed string rather than
 * throwing — an episode this can't summarize should still index and hydrate, just without a
 * preview.
 */
function summarizeEpisodeBody(bodyJson: string): string {
  try {
    const body = JSON.parse(bodyJson) as {
      findings?: Array<{ summary?: string }>;
      selfSummary?: { approachSummary?: string; durableLearnings?: string[] } | null;
    };
    const parts = [
      body.selfSummary?.approachSummary,
      ...(body.findings ?? []).map((f) => f.summary),
      ...(body.selfSummary?.durableLearnings ?? []),
    ].filter((p): p is string => !!p && p.trim().length > 0);
    return parts.length ? parts.join(' — ') : '(no episode summary recorded)';
  } catch {
    return '(unreadable episode body)';
  }
}

export class ProjectMemory extends DurableObject<Env> {
  // Bound on first call — from ctx.id.name when the runtime exposes it (every
  // real idFromName(projectId) stub), falling back to the caller-provided
  // value on a runtime that does not (mirroring ProjectRoom's own comment on
  // ctx.id.name portability) and persisting it for hibernation recovery.
  // Every later call is asserted against this, never silently reassigned —
  // project isolation inside the DO is a security boundary here, not just a
  // convenience cache the way ProjectRoom's setPid is.
  private _pid?: string;

  private async assertProjectId(projectId: string): Promise<string> {
    if (!this._pid) {
      this._pid = this.ctx.id.name ?? (await this.ctx.storage.get<string>('pid')) ?? projectId;
      await this.ctx.storage.put('pid', this._pid);
    }
    if (this._pid !== projectId) {
      throw new Error(`ProjectMemory: projectId mismatch (bound to ${this._pid}, got ${projectId})`);
    }
    return this._pid;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(() => this.migrate());
  }

  /** Apply any migrations newer than the stored schema version. Repeatable and
   *  additive: re-running against an already-current store is a no-op that
   *  preserves every existing row. */
  private async migrate(): Promise<void> {
    const metaTable = this.ctx.storage.sql
      .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_meta'`)
      .toArray();
    const current = metaTable.length > 0 ? this.readSchemaVersion() : 0;
    for (const migration of MEMORY_MIGRATIONS) {
      if (migration.version <= current) continue;
      // One transaction per migration, and one `exec()` for its whole SQL blob — exec accepts
      // several `;`-separated statements in a single call, so a migration file reads as plain
      // SQL instead of an array of fragments. The version bump commits with the DDL, so a
      // partially-applied migration is impossible.
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(migration.sql);
        this.ctx.storage.sql.exec(
          `INSERT INTO _meta (key, value) VALUES ('schema_version', ?1)
           ON CONFLICT (key) DO UPDATE SET value = ?1`,
          String(migration.version),
        );
      });
    }
  }

  private readSchemaVersion(): number {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>(`SELECT value FROM _meta WHERE key = 'schema_version'`)
      .toArray()[0];
    return row ? Number(row.value) : 0;
  }

  private readMemoryRevision(): number {
    const row = this.ctx.storage.sql.exec<{ value: number }>(`SELECT value FROM memory_revision WHERE id = 0`).toArray()[0];
    return row?.value ?? 0;
  }

  /** Health/schema-version RPC (PLNR-246 projects this into the D1 registry). `databaseSize`
   *  and `sizeStatus` (PLNR-250, §18) are visibility only — nothing here refuses a write at
   *  either threshold; the point is a warning surfaces before the store becomes operationally
   *  unsafe, not that it gets blocked. */
  async health(projectId: string): Promise<ProjectMemoryHealth> {
    await this.assertProjectId(projectId);
    const tableCounts: Record<string, number> = {};
    for (const table of SCHEMA_TABLES) {
      const row = this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0];
      tableCounts[table] = row?.n ?? 0;
    }
    const databaseSize = this.ctx.storage.sql.databaseSize;
    return {
      projectId,
      schemaVersion: this.readSchemaVersion(),
      memoryRevision: this.readMemoryRevision(),
      tableCounts,
      databaseSize,
      sizeStatus: sizeStatus(databaseSize),
    };
  }

  // ---------------------------------------------------------------------------
  // Portable snapshot export (PLNR-248)
  // ---------------------------------------------------------------------------

  /**
   * Export this project's canonical memory to R2 in bounded, checksummed chunks (see
   * lib/memory/backup.ts for the pipeline itself — this method only supplies the two
   * synchronous SQLite callbacks and the current schema/revision header fields; only this DO
   * can read its own SQLite, so the pipeline can never open storage itself). Degrades
   * gracefully with `{ ok: false, reason }` rather than throwing when R2 (FILES) is unbound —
   * every other RPC on this DO keeps working with zero optional bindings (§20).
   */
  async exportSnapshot(
    projectId: string,
    opts: { tier?: 'core' | 'full' } = {},
  ): Promise<{ ok: true; manifest: MemoryBackupManifest; manifestKey: string } | { ok: false; reason: string }> {
    await this.assertProjectId(projectId);
    if (!this.env.FILES) return { ok: false, reason: 'R2 (FILES) not configured' };
    try {
      const result = await exportMemorySnapshot({
        env: this.env,
        projectId,
        schemaVersion: this.readSchemaVersion(),
        memoryRevision: this.readMemoryRevision(),
        tier: opts.tier ?? 'core',
        exportedAt: nowIso(),
        tables: BACKUP_TABLES,
        readBatch: (table, offset, limit) =>
          this.ctx.storage.sql.exec(`SELECT * FROM ${table} LIMIT ?1 OFFSET ?2`, limit, offset).toArray(),
        tableCount: (table) => this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0]?.n ?? 0,
      });
      await this.reportBackupStatus(projectId, true);
      return { ok: true, manifest: result.manifest, manifestKey: result.manifestKey };
    } catch (err) {
      await this.reportBackupStatus(projectId, false);
      return { ok: false, reason: String(err) };
    }
  }

  /** Project the backup outcome into the D1 registry via ProjectRoom (sole D1 writer per
   *  project) — awaited, not fire-and-forget: unlike erase()'s post-delete notification, the
   *  project here is still very much alive, so the caller (admin route, cron) should see a
   *  settled registry row by the time exportSnapshot resolves. Never lets a registry-write
   *  failure mask the export's own result. */
  private async reportBackupStatus(projectId: string, ok: boolean): Promise<void> {
    await this.env.PROJECT_ROOM.get(this.env.PROJECT_ROOM.idFromName(projectId))
      .updateMemoryBackupStatus(projectId, { ok })
      .catch((err) => console.warn(`ProjectMemory backup-status report for ${projectId} failed: ${String(err)}`));
  }

  // ---------------------------------------------------------------------------
  // Generation-based restore + rollback (PLNR-249)
  //
  // Restore NEVER deletes the active dataset first, and — as of the PLNR-250 follow-up — never
  // RENAMES a live table either. Two platform facts forced that:
  //
  //   1. `ALTER TABLE x RENAME TO y` rewrites x's name in OTHER tables' FK clauses. Renaming
  //      `nodes` to `prev_nodes` silently repointed `edges.from_node_id` at `prev_nodes`, so a
  //      restore corrupted the schema it was restoring.
  //   2. That rename also stores the new name QUOTED (`CREATE TABLE "edges"`), which broke the
  //      textual `CREATE TABLE <t>` munging used to derive a staging schema — a SECOND restore
  //      failed outright with "could not derive staging schema".
  //
  // Neither was caught by the original tests because a single restore of a store that happened
  // to have evidence rows is the one path that worked. So the mechanism is now copy-based and
  // touches no table identity at all:
  //
  //   staging_<t>  — `CREATE TABLE … AS SELECT * FROM <t> WHERE 0`: same columns, and
  //                  deliberately NO constraints. Import order and FK enforcement (which is
  //                  permanently ON here — `PRAGMA foreign_keys = OFF` is ignored by DO SQLite,
  //                  verified against workerd) therefore cannot affect staging at all.
  //   prev_<t>     — `CREATE TABLE … AS SELECT * FROM <t>`: a constraint-free holding copy of
  //                  the outgoing generation, for rollback. One generation back, never a stack.
  //
  // Activation is ONE transactionSync that snapshots live→prev_, empties live child-first, and
  // refills it from staging parent-first. Because the LIVE tables keep their real schema, that
  // refill is checked against the real FKs and CHECKs — a corrupt snapshot fails the restore
  // instead of loading quietly — and because it is one transaction, any throw rolls the whole
  // thing back, leaving the active generation byte-identical.
  // ---------------------------------------------------------------------------

  /** Parent-first (FK-safe insert order) is BACKUP_TABLES; child-first (FK-safe delete order)
   *  is its reverse. Both matter now that refills hit the real constrained tables. */
  private static readonly PARENT_FIRST = BACKUP_TABLES;

  private readonly VALID_COLUMN_NAME = /^[a-z_][a-z0-9_]*$/;

  /** Empty, constraint-free twins of every backup table. Created for ALL of them up front, not
   *  just the ones the snapshot has chunks for: that is what makes the integrity anti-joins
   *  below unconditional. (The previous version created them lazily per-chunk and then queried
   *  `staging_evidence` whenever EITHER edges or evidence was present — so restoring any project
   *  that had edges but no evidence died on "no such table: staging_evidence".) */
  private createEmptyStagingTables(): void {
    for (const table of ProjectMemory.PARENT_FIRST) {
      this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS staging_${table}`);
      this.ctx.storage.sql.exec(`CREATE TABLE staging_${table} AS SELECT * FROM ${table} WHERE 0`);
    }
  }

  private insertStagingRow(table: string, row: Record<string, unknown>): void {
    const cols = Object.keys(row);
    for (const c of cols) {
      if (!this.VALID_COLUMN_NAME.test(c)) throw new Error(`refusing malformed column name in snapshot row: ${c}`);
    }
    const placeholders = cols.map((_, i) => `?${i + 1}`).join(', ');
    this.ctx.storage.sql.exec(
      `INSERT INTO staging_${table} (${cols.join(', ')}) VALUES (${placeholders})`,
      ...cols.map((c) => row[c]),
    );
  }

  private countRows(tablePrefix: string, table: string): number {
    return this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${tablePrefix}${table}`).toArray()[0]?.n ?? 0;
  }

  /** Anti-join graph/evidence integrity over the STAGED tables — an edge or evidence row
   *  pointing at a node/memory item the same snapshot doesn't contain fails the restore before
   *  anything is activated. The live tables' real FKs would also catch this during the refill,
   *  but checking here gives a precise count and a message, and does it before the outgoing
   *  generation has been disturbed at all. */
  private stagingIntegrityProblems(): string[] {
    const problems: string[] = [];
    const danglingEdges = this.ctx.storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM staging_edges e
         WHERE NOT EXISTS (SELECT 1 FROM staging_nodes n WHERE n.id = e.from_node_id)
            OR NOT EXISTS (SELECT 1 FROM staging_nodes n2 WHERE n2.id = e.to_node_id)`,
      )
      .toArray()[0]?.n ?? 0;
    if (danglingEdges > 0) problems.push(`${danglingEdges} staged edge(s) reference a missing node`);
    const danglingEvidence = this.ctx.storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM staging_evidence ev
         WHERE NOT EXISTS (SELECT 1 FROM staging_memory_items m WHERE m.id = ev.memory_item_id)`,
      )
      .toArray()[0]?.n ?? 0;
    if (danglingEvidence > 0) problems.push(`${danglingEvidence} staged evidence row(s) reference a missing memory item`);
    return problems;
  }

  private dropStagingTables(): void {
    for (const table of ProjectMemory.PARENT_FIRST) this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS staging_${table}`);
  }

  /** Replace every live table's contents from same-named tables carrying `fromPrefix`, keeping
   *  the live schema (and therefore its FKs and CHECKs) untouched. Delete child-first, insert
   *  parent-first, so the real FK constraints are satisfied at every step. Caller MUST wrap this
   *  in a transaction — that wrapping is what makes a failed activation leave nothing behind. */
  private replaceLiveContentsFrom(fromPrefix: string): void {
    for (const table of [...ProjectMemory.PARENT_FIRST].reverse()) {
      this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
    }
    for (const table of ProjectMemory.PARENT_FIRST) {
      const source = `${fromPrefix}${table}`;
      const exists = this.ctx.storage.sql
        .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1`, source)
        .toArray().length > 0;
      // A source table that doesn't exist means the snapshot genuinely had no such table (e.g.
      // it predates one). Emptying the live table is the correct reading of that: the snapshot
      // is the truth being restored, not a partial overlay on top of current data.
      if (exists) this.ctx.storage.sql.exec(`INSERT INTO ${table} SELECT * FROM ${source}`);
    }
  }

  private snapshotLiveInto(prefix: string): void {
    for (const table of ProjectMemory.PARENT_FIRST) {
      this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${prefix}${table}`);
      this.ctx.storage.sql.exec(`CREATE TABLE ${prefix}${table} AS SELECT * FROM ${table}`);
    }
  }

  /**
   * Restore this project's canonical memory from a portable snapshot (PLNR-248's export).
   * Fetches and validates the manifest, imports every chunk into constraint-free staging tables
   * (chunk-at-a-time, never the whole snapshot in memory), verifies row counts and
   * graph/evidence integrity against staging, and only on success performs one atomic
   * activation. Marks derived vectors dirty on success — a snapshot's vectors, if any existed,
   * never travel with it (§9); the real rebuild is Phase 4's, this only flags it.
   */
  async restoreSnapshot(
    projectId: string,
    opts: { exportedAt: string },
  ): Promise<{ ok: true; tableCounts: Record<string, number> } | { ok: false; reason: string }> {
    await this.assertProjectId(projectId);
    if (!this.env.FILES) return { ok: false, reason: 'R2 (FILES) not configured' };
    let manifest;
    try {
      manifest = await fetchManifest(this.env, projectId, opts.exportedAt);
    } catch (err) {
      return { ok: false, reason: `could not fetch manifest: ${String(err)}` };
    }
    const header = checkManifestHeader(manifest, projectId, this.readSchemaVersion());
    if (!header.ok) return { ok: false, reason: header.problems.join('; ') };

    try {
      this.createEmptyStagingTables();
      for await (const chunk of readSnapshotChunks(this.env, manifest)) {
        if (!ProjectMemory.PARENT_FIRST.includes(chunk.table as (typeof BACKUP_TABLES)[number])) {
          throw new Error(`snapshot contains an unknown table: ${chunk.table}`);
        }
        this.ctx.storage.transactionSync(() => {
          for (const row of chunk.rows) this.insertStagingRow(chunk.table, row);
        });
      }

      const problems: string[] = [];
      for (const [table, expected] of Object.entries(manifest.tableCounts)) {
        const staged = ProjectMemory.PARENT_FIRST.includes(table as (typeof BACKUP_TABLES)[number])
          ? this.countRows('staging_', table)
          : 0;
        if (staged !== expected) problems.push(`${table}: expected ${expected} rows, staged ${staged}`);
      }
      problems.push(...this.stagingIntegrityProblems());
      if (problems.length > 0) {
        this.dropStagingTables();
        return { ok: false, reason: problems.join('; ') };
      }

      // One transaction for the whole activation: retain the outgoing generation, then replace
      // live contents from staging. A constraint violation anywhere rolls all of it back.
      this.ctx.storage.transactionSync(() => {
        this.snapshotLiveInto('prev_');
        this.replaceLiveContentsFrom('staging_');
        this.ctx.storage.sql.exec(
          `INSERT INTO _meta (key, value) VALUES ('has_prior_generation', '1')
           ON CONFLICT (key) DO UPDATE SET value = '1'`,
        );
        this.ctx.storage.sql.exec(
          `INSERT INTO _meta (key, value) VALUES ('prior_generation_created_at', ?1)
           ON CONFLICT (key) DO UPDATE SET value = ?1`,
          nowIso(),
        );
      });
      this.dropStagingTables();

      await this.reportVectorDirty(projectId, true);
      const tableCounts: Record<string, number> = {};
      for (const table of ProjectMemory.PARENT_FIRST) tableCounts[table] = this.countRows('', table);
      return { ok: true, tableCounts };
    } catch (err) {
      // A chunk that failed its own checksum (readSnapshotChunks throws rather than yielding
      // untrusted rows) lands here too. Nothing live was touched: staging is separate, and
      // activation is a single transaction that either committed or rolled back whole.
      this.dropStagingTables();
      return { ok: false, reason: String(err) };
    }
  }

  /** Swap the retained prior generation back to active — no R2 read, no re-validation; it was
   *  already trusted when it was live. Single-level undo: rolling back consumes the retained
   *  generation, so a second rollback has nothing left to swap. */
  async rollback(projectId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    await this.assertProjectId(projectId);
    const flag = this.ctx.storage.sql.exec<{ value: string }>(`SELECT value FROM _meta WHERE key = 'has_prior_generation'`).toArray()[0];
    if (flag?.value !== '1') return { ok: false, reason: 'no retained prior generation to roll back to' };
    // Same copy-based shape as activation, in the other direction and in one transaction: refill
    // live from the retained `prev_` copies, then discard them (rollback CONSUMES the retained
    // generation — that is what makes this single-level rather than a stack).
    this.ctx.storage.transactionSync(() => {
      this.replaceLiveContentsFrom('prev_');
      for (const table of ProjectMemory.PARENT_FIRST) this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS prev_${table}`);
      this.ctx.storage.sql.exec(`UPDATE _meta SET value = '0' WHERE key = 'has_prior_generation'`);
    });
    await this.reportVectorDirty(projectId, true);
    return { ok: true };
  }

  /** Unconditionally discard the retained prior generation — a manual escape hatch. The
   *  scheduled sweep uses the age-gated `pruneRetainedGenerationIfExpired` below instead. */
  async pruneRetainedGeneration(projectId: string): Promise<{ ok: true }> {
    await this.assertProjectId(projectId);
    this.ctx.storage.transactionSync(() => {
      for (const table of BACKUP_TABLES) this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS prev_${table}`);
      this.ctx.storage.sql.exec(`UPDATE _meta SET value = '0' WHERE key = 'has_prior_generation'`);
    });
    return { ok: true };
  }

  /** PLNR-250's scheduled sweep calls this: discard the retained prior generation only once its
   *  rollback window has passed. Idempotent — nothing to prune reports false, cheaply. */
  async pruneRetainedGenerationIfExpired(projectId: string, maxAgeMs: number): Promise<boolean> {
    await this.assertProjectId(projectId);
    const flag = this.ctx.storage.sql.exec<{ value: string }>(`SELECT value FROM _meta WHERE key = 'has_prior_generation'`).toArray()[0];
    if (flag?.value !== '1') return false;
    const createdAtRow = this.ctx.storage.sql
      .exec<{ value: string }>(`SELECT value FROM _meta WHERE key = 'prior_generation_created_at'`)
      .toArray()[0];
    const age = createdAtRow ? Date.now() - new Date(createdAtRow.value).getTime() : Infinity;
    if (age < maxAgeMs) return false;
    await this.pruneRetainedGeneration(projectId);
    return true;
  }

  /** PLNR-250's scheduled sweep calls this: drop staged (never activated) index generations
   *  older than `maxAgeMs`. Nothing stages into `index_generations` before Phase 5's ingest
   *  pipeline exists, so this prunes zero rows until then — the method exists now so that
   *  pipeline has a cleanup path already wired rather than one someone has to remember to add. */
  async pruneAbandonedStagedGenerations(projectId: string, maxAgeMs: number): Promise<number> {
    await this.assertProjectId(projectId);
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const abandoned = this.ctx.storage.sql
      .exec<{ id: string }>(`SELECT id FROM index_generations WHERE status = 'staged' AND created_at < ?1`, cutoff)
      .toArray();
    if (abandoned.length === 0) return 0;
    this.ctx.storage.transactionSync(() => {
      // PLNR-261's staged children carry no real FK to index_generations(id) (see the
      // migration's comment) — delete them explicitly, child-before-parent, rather than relying
      // on a cascade DO SQLite doesn't provide.
      for (const { id } of abandoned) {
        this.ctx.storage.sql.exec(`DELETE FROM index_staged_edges WHERE generation_id = ?1`, id);
        this.ctx.storage.sql.exec(`DELETE FROM index_staged_entities WHERE generation_id = ?1`, id);
        this.ctx.storage.sql.exec(`DELETE FROM index_batches WHERE generation_id = ?1`, id);
      }
      this.ctx.storage.sql.exec(`DELETE FROM index_generations WHERE status = 'staged' AND created_at < ?1`, cutoff);
    });
    return abandoned.length;
  }

  private async reportVectorDirty(projectId: string, dirty: boolean): Promise<void> {
    await this.env.PROJECT_ROOM.get(this.env.PROJECT_ROOM.idFromName(projectId))
      .setMemoryVectorDirty(projectId, dirty)
      .catch((err) => console.warn(`ProjectMemory vector-dirty report for ${projectId} failed: ${String(err)}`));
  }

  /**
   * PLNR-255: the memory half of Phase 4's rebuild — re-embeds every memory item and episode
   * this project holds into the operational `noriq-search` index, then clears
   * `project_memory_registry.vector_dirty` (a restore or rollback sets it; nothing before this
   * task could ever clear it). PLNR-256 grows the CODE half onto the same method. An honest
   * no-op when no embeddings backend is bound — the dirty flag is left alone in that case,
   * since nothing was actually rebuilt from it.
   */
  async rebuildVectorIndex(projectId: string): Promise<{ ok: true; rebuilt: boolean; reason?: string; reindexed?: number }> {
    await this.assertProjectId(projectId);
    const backend = searchBackend(this.env);
    if (!backend) {
      const reason = 'VECTORIZE is not bound — nothing to rebuild';
      console.log(`ProjectMemory rebuildVectorIndex(${projectId}): ${reason}`);
      return { ok: true, rebuilt: false, reason };
    }
    const items = this.ctx.storage.sql
      .exec<{ id: string; kind: string; statement: string }>(`SELECT id, kind, statement FROM memory_items`)
      .toArray();
    for (const m of items) {
      await indexEntity(backend, { kind: 'memory', id: m.id, projectId, title: m.kind, body: m.statement });
    }
    const episodes = this.ctx.storage.sql
      .exec<{ id: string; run_id: string; body: string }>(`SELECT id, run_id, body FROM episodes`)
      .toArray();
    for (const e of episodes) {
      await indexEntity(backend, { kind: 'episode', id: e.id, projectId, title: `episode ${e.run_id}`, body: summarizeEpisodeBody(e.body) });
    }
    await this.reportVectorDirty(projectId, false);
    return { ok: true, rebuilt: true, reindexed: items.length + episodes.length };
  }

  // ---------------------------------------------------------------------------
  // Code-intelligence generation activation (PLNR-256)
  //
  // The code graph is empty today (PLNR-262 populates file/symbol/api/test nodes) — these two
  // RPCs are the ProjectMemory half of Phase 5's future ingest pipeline, which owns discovering
  // `entities`/`deletedUris` from a repository; this reuses the EXISTING `index_generations`
  // registry (migration 0001) rather than a parallel notion of "current generation", and adds
  // no new table. Activation's status transition is a real transactionSync (Vectorize writes
  // cannot join it — §4/§8); publishing/retiring vectors is best-effort outside that transaction,
  // exactly like every other write RPC's fire-and-forget indexing here.
  // ---------------------------------------------------------------------------

  // `activateCodeGeneration` (PLNR-256) used to live here: it inserted a generation DIRECTLY as
  // 'active' given caller-supplied entities, with no staging and no validation. PLNR-261
  // REFACTORED it into the stage (beginIndexIngest/ingestIndexBatch) -> validate
  // (completeIndexIngest) -> promote (activateIndexGeneration, below) sequence — the same RPC
  // surface, not a parallel one, now reading staged rows instead of trusting a direct parameter.

  /**
   * Bookkeeping GC for 'superseded' `index_generations` rows past their retention window —
   * mirrors `pruneAbandonedStagedGenerations`'s shape exactly. This does NOT retire vectors —
   * those are retired eagerly (best-effort) at activation via `deletedUris` above; a surviving
   * entity's vector is never orphaned because it is re-upserted at the same id under the new
   * generation. This only clears the now-inert registry row so `index_generations` does not
   * grow forever. Uses `activated_at` (when THIS generation itself went active) as the age
   * reference — there is no separate "superseded_at" column (adding one would mean a schema
   * migration this task does not need), so a long-lived generation becomes prunable
   * immediately once superseded rather than after its own separate grace period; the tradeoff
   * is documented here rather than hidden behind a precise-sounding column that doesn't exist.
   */
  async pruneSupersededGenerations(projectId: string, maxAgeMs: number): Promise<number> {
    await this.assertProjectId(projectId);
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const rows = this.ctx.storage.sql
      .exec<{ id: string }>(`SELECT id FROM index_generations WHERE status = 'superseded' AND activated_at < ?1`, cutoff)
      .toArray();
    if (rows.length === 0) return 0;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`DELETE FROM index_generations WHERE status = 'superseded' AND activated_at < ?1`, cutoff);
    });
    return rows.length;
  }

  // ---------------------------------------------------------------------------
  // Repository-index ingest — staged generations and atomic activation (PLNR-260/261).
  //
  // Unlike episode ingest below (still an in-memory bridge — PLNR-263 owns real episode
  // semantics), index-generation state is REAL and durable: `index_generations` (already existed,
  // PLNR-256) gains three children — index_batches, index_staged_entities, index_staged_edges —
  // and three additive columns (deletions, sealed_at, validation_problems). A generation's
  // manifest fields (batch_count/file_count/indexer_version/content_hash) are written ONCE, at
  // beginIndexIngest, from the REAL manifest — replacing the old activateCodeGeneration's
  // placeholders (0/entities.length/'unknown') that this refactor retires.
  //
  // Lifecycle: begin (insert 'staged', idempotent resume) -> batch* (idempotent per
  // (generationId, batchNumber), rejected once sealed) -> complete (seals; runs structural +
  // referential validation, recording `validation_problems`) -> activate (the ONLY promotion
  // path — refuses an unsealed or invalid generation; re-checks the current active generation
  // for this repository INSIDE the one transactionSync, so two concurrent activations cannot
  // both supersede the same prior row — reinforced by idx_index_generations_one_active, a
  // partial unique index making the invariant a real constraint, not just a code discipline).
  // Vector publish (best-effort, outside the transaction — a Vectorize upsert cannot join a
  // SQLite transaction, PLNR-256) is the only side effect of activation; PLNR-262 owns
  // projecting staged rows into `nodes`/`edges`.
  // ---------------------------------------------------------------------------
  private ingestEpisodes = new Map<string, IngestEpisodeState>();

  private getIndexGenerationRow(generationId: string) {
    return this.ctx.storage.sql
      .exec<{
        repository_key: string; branch: string; base_id: string; status: string;
        batch_count: number; file_count: number; sealed_at: string | null; validation_problems: string | null; deletions: string;
      }>(
        `SELECT repository_key, branch, base_id, status, batch_count, file_count, sealed_at, validation_problems, deletions
         FROM index_generations WHERE id = ?1`,
        generationId,
      )
      .toArray()[0];
  }

  /** Anti-join over the STAGED tables (mirrors the restore path's stagingIntegrityProblems in
   *  spirit, over a different pair of tables): a staged edge whose from/to uri is absent from
   *  this SAME generation's staged entities fails validation before anything activates. */
  private indexStagingIntegrityProblems(generationId: string): string[] {
    const dangling = this.ctx.storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM index_staged_edges e
         WHERE e.generation_id = ?1
           AND (NOT EXISTS (SELECT 1 FROM index_staged_entities n WHERE n.generation_id = ?1 AND n.uri = e.from_uri)
             OR NOT EXISTS (SELECT 1 FROM index_staged_entities n2 WHERE n2.generation_id = ?1 AND n2.uri = e.to_uri))`,
        generationId,
      )
      .toArray()[0]?.n ?? 0;
    return dangling > 0 ? [`${dangling} staged edge(s) reference a missing staged node`] : [];
  }

  /** Resolve a project's committed KEY from its projectId — a plain D1 read (env.DB is a normal
   *  binding; this isn't a coordination mutation, so it does not need to go through ProjectRoom).
   *  Needed because buildEntityUri's repository-scoped kinds take the project KEY, never the id
   *  (a projectId-shaped URI would parse, store, and never match anything real). */
  private async resolveProjectKey(projectId: string): Promise<string> {
    const row = await this.env.DB.prepare('SELECT key FROM projects WHERE id = ?').bind(projectId).first<{ key: string }>();
    if (!row) throw new Error(`project ${projectId} not found`);
    return row.key;
  }

  async beginIndexIngest(projectId: string, manifest: IndexGenerationManifest): Promise<{ ok: true }> {
    await this.assertProjectId(projectId);
    IndexGenerationManifest.parse(manifest);
    const existing = this.getIndexGenerationRow(manifest.generationId);
    if (existing && (existing.status !== 'staged' || existing.sealed_at)) {
      throw new Error(`generation ${manifest.generationId} already ${existing.sealed_at ? 'completed' : existing.status} — this purpose cannot be reopened`);
    }
    const now = nowIso();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO repositories (repository_key, created_at) VALUES (?1, ?2) ON CONFLICT (repository_key) DO NOTHING`,
        manifest.repositoryKey,
        now,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO index_generations
           (id, repository_key, branch, base_id, indexer_version, batch_count, file_count, content_hash, deletions, status, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'staged',?10)
         ON CONFLICT (id) DO UPDATE SET
           branch = excluded.branch, base_id = excluded.base_id, indexer_version = excluded.indexer_version,
           batch_count = excluded.batch_count, file_count = excluded.file_count, content_hash = excluded.content_hash,
           deletions = excluded.deletions`,
        manifest.generationId,
        manifest.repositoryKey,
        manifest.branch,
        manifest.baseId,
        manifest.indexerVersion,
        manifest.batchCount,
        manifest.fileCount,
        manifest.contentHash,
        JSON.stringify(manifest.deletions),
        now,
      );
    });
    return { ok: true };
  }

  async ingestIndexBatch(projectId: string, batch: IndexBatch, rows: Array<Record<string, unknown>>): Promise<{ ok: true; deduped: boolean }> {
    await this.assertProjectId(projectId);
    const gen = this.getIndexGenerationRow(batch.generationId);
    if (!gen) throw new Error(`no ingest in progress for generation ${batch.generationId} — call beginIndexIngest first`);
    if (gen.sealed_at || gen.status !== 'staged') {
      throw new Error(`generation ${batch.generationId} is already ${gen.sealed_at ? 'completed' : gen.status} — refusing a batch for a completed purpose`);
    }
    const already = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM index_batches WHERE generation_id = ?1 AND batch_number = ?2`, batch.generationId, batch.batchNumber)
      .toArray()[0]!.n;
    if (already > 0) return { ok: true, deduped: true };
    const parsedRows = rows.map(parseStagedRow);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO index_batches (generation_id, batch_number, batch_hash, row_count, received_at) VALUES (?1,?2,?3,?4,?5)`,
        batch.generationId,
        batch.batchNumber,
        batch.batchHash,
        rows.length,
        nowIso(),
      );
      for (const row of parsedRows) {
        if (row.kind === 'node') {
          this.ctx.storage.sql.exec(
            `INSERT INTO index_staged_entities (generation_id, uri, type, label, content) VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT (generation_id, uri) DO UPDATE SET type = excluded.type, label = excluded.label, content = excluded.content`,
            batch.generationId,
            row.uri,
            row.type,
            row.label,
            row.content,
          );
        } else {
          this.ctx.storage.sql.exec(
            `INSERT INTO index_staged_edges (generation_id, type, from_uri, to_uri) VALUES (?1,?2,?3,?4)
             ON CONFLICT (generation_id, type, from_uri, to_uri) DO NOTHING`,
            batch.generationId,
            row.type,
            row.from,
            row.to,
          );
        }
      }
    });
    return { ok: true, deduped: false };
  }

  /** The VALIDATE step. Seals the generation (no further batches accepted) and records
   *  `validation_problems` — actionable, naming what disagreed — without activating anything.
   *  Idempotent: calling it again re-reports the same recorded result rather than re-validating. */
  async completeIndexIngest(
    projectId: string,
    generationId: string,
  ): Promise<{ ok: true; batchesReceived: number; validation: { ok: boolean; problems: string[] } }> {
    await this.assertProjectId(projectId);
    const gen = this.getIndexGenerationRow(generationId);
    if (!gen) throw new Error(`no ingest in progress for generation ${generationId}`);
    if (gen.status !== 'staged') throw new Error(`generation ${generationId} is already ${gen.status}`);
    const received = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM index_batches WHERE generation_id = ?1`, generationId)
      .toArray()[0]!.n;
    if (gen.sealed_at) {
      const problems: string[] = gen.validation_problems ? JSON.parse(gen.validation_problems) : [];
      return { ok: true, batchesReceived: received, validation: { ok: problems.length === 0, problems } };
    }
    const problems: string[] = [];
    if (received !== gen.batch_count) problems.push(`expected ${gen.batch_count} batches, received ${received}`);
    const fileEntities = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM index_staged_entities WHERE generation_id = ?1 AND type = 'file'`, generationId)
      .toArray()[0]!.n;
    if (fileEntities !== gen.file_count) problems.push(`manifest declares fileCount ${gen.file_count}, staged ${fileEntities} file entities`);
    problems.push(...this.indexStagingIntegrityProblems(generationId));
    this.ctx.storage.sql.exec(
      `UPDATE index_generations SET sealed_at = ?2, validation_problems = ?3 WHERE id = ?1`,
      generationId,
      nowIso(),
      problems.length ? JSON.stringify(problems) : null,
    );
    return { ok: true, batchesReceived: received, validation: { ok: problems.length === 0, problems } };
  }

  /** The PROMOTE step — the ONLY writer of `status = 'active'`. Refuses a generation that has
   *  not completed ingest (no `sealed_at`) or that failed validation; activates exactly once
   *  (re-activating an already-active generation is refused, matching its `status` check). */
  async activateIndexGeneration(projectId: string, generationId: string): Promise<{ activated: string; superseded: string[] }> {
    await this.assertProjectId(projectId);
    const gen = this.getIndexGenerationRow(generationId);
    if (!gen) throw new Error(`generation ${generationId} not found`);
    if (gen.status !== 'staged') throw new Error(`generation ${generationId} is already ${gen.status}`);
    if (!gen.sealed_at) throw new Error(`generation ${generationId} has not completed ingest — call completeIndexIngest first`);
    if (gen.validation_problems) throw new Error(`generation ${generationId} failed validation: ${gen.validation_problems}`);

    let superseded: string[] = [];
    this.ctx.storage.transactionSync(() => {
      // The read of the currently-active generation happens INSIDE the transaction — moved here
      // from where the old activateCodeGeneration read it (before its own transactionSync), which
      // let two concurrent activations both observe the same prior active row and both promote.
      const active = this.ctx.storage.sql
        .exec<{ id: string }>(`SELECT id FROM index_generations WHERE repository_key = ?1 AND status = 'active'`, gen.repository_key)
        .toArray();
      superseded = active.map((r) => r.id);
      for (const id of superseded) {
        this.ctx.storage.sql.exec(`UPDATE index_generations SET status = 'superseded' WHERE id = ?1`, id);
      }
      this.ctx.storage.sql.exec(`UPDATE index_generations SET status = 'active', activated_at = ?2 WHERE id = ?1`, generationId, nowIso());
    });

    // Best-effort vector publish, OUTSIDE the transaction (PLNR-256: a Vectorize upsert cannot
    // join a SQLite transaction; correctness comes from query-time generation filtering, never
    // from "we deleted the old vectors").
    const backend = codeSearchBackend(this.env);
    if (backend) {
      const staged = this.ctx.storage.sql
        .exec<{ uri: string; type: string; label: string; content: string | null }>(
          `SELECT uri, type, label, content FROM index_staged_entities WHERE generation_id = ?1`,
          generationId,
        )
        .toArray();
      for (const e of staged) {
        void indexCodeEntity(backend, {
          uri: e.uri, projectId, repositoryKey: gen.repository_key, generationId, type: e.type as CodeEntityType, label: e.label, content: e.content,
        }).catch((err) => console.warn(`ProjectMemory code-index for ${e.uri} failed: ${String(err)}`));
      }
      const deletions: string[] = JSON.parse(gen.deletions || '[]');
      if (deletions.length) {
        const projectKey = await this.resolveProjectKey(projectId);
        for (const path of deletions) {
          const uri = buildEntityUri({ kind: 'file', projectKey, repositoryKey: gen.repository_key, path });
          void removeCodeEntity(backend, uri).catch((err) => console.warn(`ProjectMemory code-deindex for ${uri} failed: ${String(err)}`));
        }
      }
    }

    // D1-side active-generation PROJECTION (PLNR-259) — DO -> ProjectRoom -> D1, mirroring
    // upsertMemoryHealth/updateMemoryBackupStatus/setMemoryVectorDirty. Best-effort: the DO's own
    // index_generations.status is authority regardless of whether this projection lands.
    await this.env.PROJECT_ROOM.get(this.env.PROJECT_ROOM.idFromName(projectId))
      .setRepositoryActiveGeneration(projectId, gen.repository_key, generationId)
      .catch((err) => console.warn(`ProjectMemory active-generation projection for ${projectId}/${gen.repository_key} failed: ${String(err)}`));

    return { activated: generationId, superseded };
  }

  /**
   * Project an ALREADY-ACTIVE generation's staged entities/edges into the live graph
   * (`nodes`/`edges`) — PLNR-262. Staging (PLNR-261) never writes here, which is what keeps a
   * staged-but-unvalidated generation invisible to every query surface; this is the one place
   * that promotes staged rows into current project knowledge.
   *
   * Bulk, not per-row: a single `transactionSync` upserts every valid entity and edge and emits
   * ONE summary outbox event, never one per entity/edge (writeNode/writeEdge's per-call outbox +
   * memory_revision + applied_operations + alarm would flood the coordination event log on a
   * real repository).
   *
   * Stable identity is free: `buildEntityUri` is generation-free (§18) and the upsert is
   * `ON CONFLICT (uri) DO UPDATE`, so an unchanged entity re-projected under a new generationId
   * keeps its existing node id automatically — no version key needed.
   *
   * Retirement: an entity present in the PREVIOUS active generation for this repository but
   * absent from this one has its live EDGES severed (not its node deleted — edges FK-reference
   * nodes and Durable Object SQLite enforces that always; the node row survives so evidence/
   * episodes citing its uri by string still resolve). Every current graph-traversal query
   * surface (dependencyNeighborhood et al., PLNR-258) walks edges from a seed, so a retired
   * entity stops appearing as "current" without its history being erased.
   */
  async projectActiveGeneration(
    projectId: string,
    generationId: string,
  ): Promise<{ nodesWritten: number; edgesWritten: number; entitiesSkipped: number; edgesSkipped: number; retired: number; coChangeEdges: number }> {
    await this.assertProjectId(projectId);
    const gen = this.getIndexGenerationRow(generationId);
    if (!gen) throw new Error(`generation ${generationId} not found`);
    if (gen.status !== 'active') throw new Error(`generation ${generationId} is ${gen.status} — only an active generation may be projected`);
    const projectKey = await this.resolveProjectKey(projectId);

    const stagedEntities = this.ctx.storage.sql
      .exec<{ uri: string; type: string; label: string; content: string | null }>(
        `SELECT uri, type, label, content FROM index_staged_entities WHERE generation_id = ?1`,
        generationId,
      )
      .toArray();
    const stagedEdges = this.ctx.storage.sql
      .exec<{ type: string; from_uri: string; to_uri: string }>(`SELECT type, from_uri, to_uri FROM index_staged_edges WHERE generation_id = ?1`, generationId)
      .toArray();

    const plan = planProjection(
      projectKey,
      stagedEntities,
      stagedEdges.map((e) => ({ type: e.type, fromUri: e.from_uri, toUri: e.to_uri })),
    );
    for (const bad of plan.invalidEntities) console.warn(`ProjectMemory projection(${generationId}): skipping invalid staged entity ${bad.uri}: ${bad.reason}`);
    for (const bad of plan.invalidEdges) console.warn(`ProjectMemory projection(${generationId}): skipping invalid staged edge: ${bad.reason}`);

    // The most recently superseded generation for this repository — its still-present staged
    // rows (PLNR-261 never deletes them on supersession) are the "previous" side of both
    // retirement and the co-change signal below.
    const prevGen = this.ctx.storage.sql
      .exec<{ id: string }>(
        `SELECT id FROM index_generations WHERE repository_key = ?1 AND status = 'superseded' AND id != ?2 ORDER BY activated_at DESC LIMIT 1`,
        gen.repository_key,
        generationId,
      )
      .toArray()[0];

    let retired = 0;
    let coChangeEdges = 0;

    this.ctx.storage.transactionSync(() => {
      const now = nowIso();
      for (const e of plan.validEntities) {
        this.ctx.storage.sql.exec(
          `INSERT INTO nodes (id, type, uri, label, created_at) VALUES (?1,?2,?3,?4,?5)
           ON CONFLICT (uri) DO UPDATE SET label = excluded.label, type = excluded.type`,
          newId('node'),
          e.type,
          e.uri,
          e.label,
          now,
        );
      }
      const nodeIdByUri = (uri: string): string | undefined =>
        this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE uri = ?1`, uri).toArray()[0]?.id;

      for (const e of plan.validEdges) {
        const fromId = nodeIdByUri(e.fromUri);
        const toId = nodeIdByUri(e.toUri);
        if (!fromId || !toId) continue; // defensive — planProjection already filtered to valid uris
        this.ctx.storage.sql.exec(
          `INSERT INTO edges (id, type, from_node_id, to_node_id, created_at) VALUES (?1,?2,?3,?4,?5)
           ON CONFLICT (type, from_node_id, to_node_id) DO NOTHING`,
          newId('edge'),
          e.type,
          fromId,
          toId,
          now,
        );
      }

      if (prevGen) {
        const prevEntities = this.ctx.storage.sql
          .exec<{ uri: string; type: string }>(`SELECT uri, type FROM index_staged_entities WHERE generation_id = ?1`, prevGen.id)
          .toArray();
        const prevFileUris = new Set(prevEntities.filter((e) => e.type === 'file').map((e) => e.uri));
        const newFileUris = new Set(plan.validEntities.filter((e) => e.type === 'file').map((e) => e.uri));

        const removedUris = [...prevFileUris].filter((u) => !newFileUris.has(u));
        for (const uri of removedUris) {
          const node = nodeIdByUri(uri);
          if (!node) continue;
          this.ctx.storage.sql.exec(`DELETE FROM edges WHERE from_node_id = ?1 OR to_node_id = ?1`, node);
          retired++;
        }

        const changed = changedFileUris(prevFileUris, newFileUris);
        const pairs = coChangePairs(changed);
        if (changed.length > CO_CHANGE_PAIR_CAP) {
          console.warn(
            `ProjectMemory projection(${generationId}): ${changed.length} files changed together — exceeds the co-change pairing cap (${CO_CHANGE_PAIR_CAP}); skipping pairwise edges this round`,
          );
        }
        for (const [a, b] of pairs) {
          const aId = nodeIdByUri(a);
          const bId = nodeIdByUri(b);
          if (!aId || !bId) continue; // one side was retired/never projected — nothing to link
          this.ctx.storage.sql.exec(
            `INSERT INTO edges (id, type, from_node_id, to_node_id, created_at) VALUES (?1,'commonly_changes_with',?2,?3,?4)
             ON CONFLICT (type, from_node_id, to_node_id) DO NOTHING`,
            newId('edge'),
            aId,
            bId,
            now,
          );
          coChangeEdges++;
        }
      }

      // ONE summary outbox event for the whole projection — never one per entity/edge.
      const operationId = newId('op');
      this.ctx.storage.sql.exec(
        `INSERT INTO outbox (id, operation_id, verb, subject_type, subject_id, payload, created_at) VALUES (?1,?2,'memory.changed','memory',?3,?4,?5)`,
        newId('obx'),
        operationId,
        generationId,
        JSON.stringify({ operationId, entityType: 'generation-projection', generationId, nodesWritten: plan.validEntities.length, edgesWritten: plan.validEdges.length }),
        now,
      );
      this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = value + 1 WHERE id = 0`);
      this.ctx.storage.sql.exec(
        `INSERT INTO applied_operations (operation_id, applied_at, subject_type, subject_id, result) VALUES (?1,?2,'generation-projection',?3,?4)`,
        operationId,
        now,
        generationId,
        JSON.stringify({ nodesWritten: plan.validEntities.length, edgesWritten: plan.validEdges.length }),
      );
    });
    this.ctx.storage.setAlarm(Date.now()).catch(() => {});

    return {
      nodesWritten: plan.validEntities.length,
      edgesWritten: plan.validEdges.length,
      entitiesSkipped: plan.invalidEntities.length,
      edgesSkipped: plan.invalidEdges.length,
      retired,
      coChangeEdges,
    };
  }

  /** Abort a still-staged generation, dropping its staged rows. Refuses once active/superseded —
   *  there is no undo for a promotion; a sealed-but-not-yet-activated (validated or not)
   *  generation may still be aborted. */
  async abortIndexIngest(projectId: string, generationId: string): Promise<{ ok: true }> {
    await this.assertProjectId(projectId);
    const gen = this.getIndexGenerationRow(generationId);
    if (!gen) return { ok: true };
    if (gen.status !== 'staged') throw new Error(`generation ${generationId} is already ${gen.status} — cannot abort`);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`DELETE FROM index_staged_edges WHERE generation_id = ?1`, generationId);
      this.ctx.storage.sql.exec(`DELETE FROM index_staged_entities WHERE generation_id = ?1`, generationId);
      this.ctx.storage.sql.exec(`DELETE FROM index_batches WHERE generation_id = ?1`, generationId);
      this.ctx.storage.sql.exec(`DELETE FROM index_generations WHERE id = ?1`, generationId);
    });
    return { ok: true };
  }

  async indexIngestStatus(
    projectId: string,
    generationId: string,
  ): Promise<{ status: 'unknown' | 'staged' | 'active' | 'superseded'; sealed: boolean; batchesReceived: number; batchesExpected: number | null; validation: { ok: boolean; problems: string[] } | null }> {
    await this.assertProjectId(projectId);
    const gen = this.getIndexGenerationRow(generationId);
    if (!gen) return { status: 'unknown', sealed: false, batchesReceived: 0, batchesExpected: null, validation: null };
    const received = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM index_batches WHERE generation_id = ?1`, generationId)
      .toArray()[0]!.n;
    return {
      status: gen.status as 'staged' | 'active' | 'superseded',
      sealed: !!gen.sealed_at,
      batchesReceived: received,
      batchesExpected: gen.batch_count,
      validation: gen.sealed_at ? { ok: !gen.validation_problems, problems: gen.validation_problems ? JSON.parse(gen.validation_problems) : [] } : null,
    };
  }

  /**
   * The canonical episode writer (PLNR-263, §14). ONE episode per (run, sitting): UPSERTs on
   * `(run_id, sitting)` (0007's unique index — corrected from 0006's run_id-only index, which
   * let `ProjectRoom.reopenRun`'s second sitting of a build overwrite the first sitting's
   * episode; RUN-182's reopen reuses one run id across sittings, it does not mint a new run),
   * which is what makes duplicate delivery idempotent without an operation-id ledger lookup — a
   * re-recorded skeleton (a replay, or the same sitting settling twice through two different
   * callers) just overwrites the same row, while a NEW sitting gets its own.
   *
   * Skeleton fields always win: every column below except `body.selfSummary` is set from THIS
   * call's input, never merged with a prior write. `selfSummary` is the one exception (§14) — a
   * present, valid value wins; an absent or invalid one PRESERVES whatever was already recorded,
   * so a later skeleton-only write (a replay, or the server's own automatic recording arriving
   * after a richer daemon upload already enriched the row) can never erase enrichment that
   * already landed.
   *
   * Bulk graph write, ONE transaction, ONE outbox event — the same discipline
   * `projectActiveGeneration`'s doc comment states and for the same reason: per-edge
   * writeNode/writeEdge calls would emit an outbox row and bump `memory_revision` once per edge
   * for one logical "this run produced an episode" fact.
   *
   * The five edges this writes, and only these (locked — see the task's execution spec):
   *   episode --derived_from--> run
   *   episode --related_to--> task        (if this run has a task anchor)
   *   episode --owned_by--> agent         (if this run minted an agent)
   *   episode --modifies--> file          (one per `filesTouched`, only when `repositoryKey` is
   *                                         known — an unqualified path cannot become a URI)
   *   episode --related_to--> memory      (every `memory_items` row this run's OWN agent
   *                                         recorded — a runner-spawned agent lives for exactly
   *                                         one run, RUN-43, so `recorded_by_agent_id = agentId`
   *                                         IS "recorded during this run", no time-window needed)
   */
  async recordEpisode(
    projectId: string,
    input: RecordEpisodeInput,
  ): Promise<{ episodeId: string; runId: string; created: boolean; nodesWritten: number; edgesWritten: number }> {
    await this.assertProjectId(projectId);
    if (!['done', 'failed', 'cancelled'].includes(input.outcome)) {
      throw new Error(`recordEpisode: outcome "${input.outcome}" is not one of done/failed/cancelled`);
    }
    const now = nowIso();

    // Absent OR malformed both leave the episode valid (§14) — `.catch(null)` swallows a bad
    // self-summary rather than rejecting the whole record, reusing the SAME tolerance
    // `EffortEpisode.selfSummary` already declares (see that field's doc comment in memory.ts).
    const providedSelfSummary = EpisodeSelfSummary.nullable().catch(null).parse(input.selfSummary ?? null);

    // Read BEFORE building the new body — the one piece of "existing" state this write can
    // depend on, per the merge rule above: the STABLE id (a PK must never change across an
    // upsert) and the prior self-summary to preserve. Keyed on (run_id, sitting) — a DIFFERENT
    // sitting of the same run must find no existing row here, which is exactly what makes it a
    // fresh episode rather than an overwrite of an earlier sitting's. A plain read needs no
    // transactionSync (nothing else can run inside this DO concurrently); the transactionSync
    // below is for the WRITE.
    const existingRow = this.ctx.storage.sql
      .exec<{ id: string; body: string; created_at: string }>(
        `SELECT id, body, created_at FROM episodes WHERE run_id = ?1 AND sitting = ?2`,
        input.runId, input.sitting,
      )
      .toArray()[0];
    let existingSelfSummary: unknown = null;
    if (existingRow) {
      try {
        existingSelfSummary = (JSON.parse(existingRow.body) as { selfSummary?: unknown }).selfSummary ?? null;
      } catch { /* an unreadable prior body is treated as "no prior self-summary", not an error */ }
    }
    const mergedSelfSummary = providedSelfSummary ?? EpisodeSelfSummary.nullable().catch(null).parse(existingSelfSummary);
    const createdAt = existingRow?.created_at ?? now;
    // Resolved ONCE, synchronously, before either the hash or the write — never re-derived from
    // an ON CONFLICT clause's excluded/target ambiguity, so `body.id` and the row's own `id`
    // column can never disagree.
    const episodeId = existingRow?.id ?? newId('epi');
    const created = !existingRow;

    // Validated (and default-filled) through the SAME shared schema the wire contract uses —
    // the full EffortEpisode rides `body` as JSON (locked decision; the table's own header
    // comment already settles this), so this is the one construction site for that JSON, not a
    // hand-rolled shape a second place could drift from.
    const bodyObject = EffortEpisode.parse({
      id: episodeId,
      projectId,
      runId: input.runId,
      taskId: input.taskId,
      repositoryKey: input.repositoryKey,
      baseId: input.baseId,
      timeline: input.timeline,
      filesTouched: input.filesTouched,
      commands: input.commands,
      testsRun: input.testsRun,
      failures: input.failures,
      findings: input.findings,
      reviewRounds: input.reviewRounds,
      tokenUsage: input.tokenUsage,
      costUSD: input.costUSD,
      acceptanceCoverage: input.acceptanceCoverage,
      steeringEvents: input.steeringEvents,
      landingOutcome: input.landingOutcome,
      remainingWork: input.remainingWork,
      selfSummary: mergedSelfSummary,
      createdAt,
    });
    const finalBody = JSON.stringify(bodyObject);
    const contentHash = await sha256HexBytes(new TextEncoder().encode(finalBody));

    // Only needed to build file URIs (§18's repository-scoped shape) — skip the D1 round trip
    // when there is nothing to link.
    const projectKey = input.repositoryKey && input.filesTouched.length ? await this.resolveProjectKey(projectId) : null;

    let nodesWritten = 0;
    let edgesWritten = 0;
    this.ctx.storage.transactionSync(() => {
      if (this._forceWriteFailure) throw new Error('injected write failure (test)');
      // `episodeId` (from `existingRow.id`, when present) is ALSO what conflicts on
      // `(run_id, sitting)` below — so on an update this re-supplies the SAME id the row already
      // has, never a fresh one; on a first write of this sitting it is the only id anyone has
      // ever assigned. Either way the `id` column itself is never in the UPDATE SET list,
      // matching writeNode/writeEdge's own "never move a stable id" convention. A DIFFERENT
      // sitting of the same run conflicts on neither `id` (a fresh `newId('epi')`, since
      // `existingRow` above found nothing for THIS sitting) nor `run_id` alone (0007 dropped that
      // unique index) — it inserts a brand-new row.
      this.ctx.storage.sql.exec(
        `INSERT INTO episodes
           (id, run_id, sitting, task_id, repository_key, base_id, landing_outcome, review_rounds, cost_usd,
            acceptance_coverage, body, created_at, agent_id, run_kind, outcome, started_at, finished_at, content_hash)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)
         ON CONFLICT (run_id, sitting) DO UPDATE SET
           task_id = excluded.task_id, repository_key = excluded.repository_key, base_id = excluded.base_id,
           landing_outcome = excluded.landing_outcome, review_rounds = excluded.review_rounds,
           cost_usd = excluded.cost_usd, acceptance_coverage = excluded.acceptance_coverage, body = excluded.body,
           agent_id = excluded.agent_id, run_kind = excluded.run_kind, outcome = excluded.outcome,
           started_at = excluded.started_at, finished_at = excluded.finished_at, content_hash = excluded.content_hash`,
        episodeId, input.runId, input.sitting, input.taskId, input.repositoryKey, input.baseId, input.landingOutcome,
        input.reviewRounds, input.costUSD, input.acceptanceCoverage, finalBody, createdAt,
        input.agentId, input.runKind, input.outcome, input.startedAt, input.finishedAt, contentHash,
      );

      const upsertNode = (type: string, uri: string, label: string): string => {
        this.ctx.storage.sql.exec(
          `INSERT INTO nodes (id, type, uri, label, created_at) VALUES (?1,?2,?3,?4,?5)
           ON CONFLICT (uri) DO UPDATE SET label = excluded.label`,
          newId('node'), type, uri, label, now,
        );
        nodesWritten++;
        return this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE uri = ?1`, uri).toArray()[0]!.id;
      };
      const linkEdge = (type: string, fromNodeId: string, toNodeId: string): void => {
        this.ctx.storage.sql.exec(
          `INSERT INTO edges (id, type, from_node_id, to_node_id, created_at) VALUES (?1,?2,?3,?4,?5)
           ON CONFLICT (type, from_node_id, to_node_id) DO NOTHING`,
          newId('edge'), type, fromNodeId, toNodeId, now,
        );
        edgesWritten++;
      };

      const episodeNodeId = upsertNode('episode', buildEntityUri({ kind: 'episode', id: episodeId }), `${input.runKind} episode (${input.outcome})`);
      const runNodeId = upsertNode('run', buildEntityUri({ kind: 'run', id: input.runId }), `${input.runKind} run`);
      linkEdge('derived_from', episodeNodeId, runNodeId);

      if (input.taskId) {
        const taskNodeId = upsertNode('task', buildEntityUri({ kind: 'task', id: input.taskId }), input.taskTitle ?? input.taskId);
        linkEdge('related_to', episodeNodeId, taskNodeId);
      }
      if (input.agentId) {
        const agentNodeId = upsertNode('agent', buildEntityUri({ kind: 'agent', id: input.agentId }), input.agentId);
        linkEdge('owned_by', episodeNodeId, agentNodeId);
      }
      if (projectKey && input.repositoryKey) {
        for (const path of input.filesTouched) {
          const fileNodeId = upsertNode('file', buildEntityUri({ kind: 'file', projectKey, repositoryKey: input.repositoryKey, path }), path);
          linkEdge('modifies', episodeNodeId, fileNodeId);
        }
      }
      if (input.agentId) {
        const recordedMemories = this.ctx.storage.sql
          .exec<{ id: string; kind: string }>(`SELECT id, kind FROM memory_items WHERE recorded_by_agent_id = ?1`, input.agentId)
          .toArray();
        for (const m of recordedMemories) {
          const memoryNodeId = upsertNode('memory', buildEntityUri({ kind: 'memory', id: m.id }), m.kind);
          linkEdge('related_to', episodeNodeId, memoryNodeId);
        }
      }

      // ONE summary outbox event for the whole write — never one per node/edge.
      const operationId = newId('op');
      this.ctx.storage.sql.exec(
        `INSERT INTO outbox (id, operation_id, verb, subject_type, subject_id, payload, created_at) VALUES (?1,?2,'memory.changed','memory',?3,?4,?5)`,
        newId('obx'), operationId, episodeId,
        JSON.stringify({ operationId, entityType: 'episode', runId: input.runId, outcome: input.outcome, nodesWritten, edgesWritten }),
        now,
      );
      this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = value + 1 WHERE id = 0`);
    });
    this.ctx.storage.setAlarm(Date.now()).catch(() => {});

    // PLNR-255: index/re-index this episode the same way `rebuildVectorIndex` does — fire-and-
    // forget, must never fail or slow the write it derives from.
    const backend = searchBackend(this.env);
    if (backend) {
      void indexEntity(backend, { kind: 'episode', id: episodeId, projectId, title: `episode ${input.runId}`, body: summarizeEpisodeBody(finalBody) })
        .catch((err) => console.warn(`ProjectMemory episode-index for ${episodeId} failed: ${String(err)}`));
    }

    return { episodeId, runId: input.runId, created, nodesWritten, edgesWritten };
  }

  async beginEpisodeIngest(projectId: string, manifest: EpisodeUploadManifest): Promise<{ ok: true }> {
    await this.assertProjectId(projectId);
    this.ingestEpisodes.set(manifest.scopeId, beginIngestEpisode(this.ingestEpisodes.get(manifest.scopeId), manifest));
    return { ok: true };
  }

  async ingestEpisodeBatch(
    projectId: string,
    scopeId: string,
    batchNumber: number,
    rows: Array<Record<string, unknown>>,
  ): Promise<{ ok: true; deduped: boolean }> {
    await this.assertProjectId(projectId);
    const state = this.ingestEpisodes.get(scopeId);
    if (!state) throw new Error(`no episode ingest in progress for ${scopeId} — call beginEpisodeIngest first`);
    const { deduped } = applyIngestEpisodeBatch(state, batchNumber, rows);
    return { ok: true, deduped };
  }

  /**
   * Seals the upload, then parses each accumulated row as an `EffortEpisode` and hands it to
   * the real writer (PLNR-263) — the episode-upload half of `recordEpisode`'s two callers (the
   * other is `memory/episodes.ts`'s `recordEpisodeForRun`, from `ProjectRoom`'s terminal-run
   * fire-and-forget). `agentId`/`runKind`/`outcome`/`startedAt` are resolved from THIS project's
   * OWN `runs` row, never trusted from the upload — the same reason `recordEpisodeForRun` never
   * lets a daemon supply them (see `RecordEpisodeInput`'s doc comment): a compromised or merely
   * confused daemon must not be able to claim an outcome, agent, or run kind the server's own
   * coordination state disagrees with. A row naming a run that does not exist in this project,
   * or one with no terminal exit yet, is skipped rather than failing the whole completion —
   * consistent with `planProjection`'s per-row tolerance.
   */
  async completeEpisodeIngest(
    projectId: string,
    scopeId: string,
  ): Promise<{ ok: true; batchesReceived: number; rowCount: number; recorded: number; skipped: number }> {
    await this.assertProjectId(projectId);
    const state = this.ingestEpisodes.get(scopeId);
    if (!state) throw new Error(`no episode ingest in progress for ${scopeId}`);
    completeIngestEpisode(state);

    let recorded = 0;
    let skipped = 0;
    for (const row of state.rows) {
      const parsed = UPLOADED_EPISODE_SHAPE.safeParse(row);
      if (!parsed.success) {
        console.warn(`ProjectMemory episode-ingest(${scopeId}): skipping malformed uploaded row: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
        skipped++;
        continue;
      }
      // `sitting` is read straight off the run row, like agent_id/kind/exit below — an uploading
      // daemon can only ever be reporting on the sitting it just ran, i.e. the run's CURRENT
      // (highest) sitting. There is no wire field for it: `EffortEpisode` (the uploaded row's
      // shape) predates sittings and does not need to grow one — the server already knows.
      const runRow = await this.env.DB.prepare(`SELECT agent_id, kind, exit, started_at, sitting FROM runs WHERE id = ? AND project_id = ?`)
        .bind(parsed.data.runId, projectId)
        .first<{ agent_id: string | null; kind: string; exit: string | null; started_at: string | null; sitting: number }>();
      if (!runRow) {
        console.warn(`ProjectMemory episode-ingest(${scopeId}): uploaded row names run ${parsed.data.runId}, unknown in project ${projectId} — skipping`);
        skipped++;
        continue;
      }
      if (!runRow.exit) {
        console.warn(`ProjectMemory episode-ingest(${scopeId}): run ${parsed.data.runId} has no terminal exit yet — skipping`);
        skipped++;
        continue;
      }
      const { outcome, finishedAt } = parseExit(runRow.exit);
      await this.recordEpisode(projectId, {
        runId: parsed.data.runId,
        sitting: runRow.sitting,
        agentId: runRow.agent_id,
        runKind: runRow.kind,
        outcome,
        startedAt: runRow.started_at,
        finishedAt,
        taskId: parsed.data.taskId,
        repositoryKey: parsed.data.repositoryKey,
        baseId: parsed.data.baseId,
        timeline: parsed.data.timeline,
        filesTouched: parsed.data.filesTouched,
        commands: parsed.data.commands,
        testsRun: parsed.data.testsRun,
        failures: parsed.data.failures,
        findings: parsed.data.findings,
        reviewRounds: parsed.data.reviewRounds,
        tokenUsage: parsed.data.tokenUsage,
        costUSD: parsed.data.costUSD,
        acceptanceCoverage: parsed.data.acceptanceCoverage,
        steeringEvents: parsed.data.steeringEvents,
        landingOutcome: parsed.data.landingOutcome,
        remainingWork: parsed.data.remainingWork,
        selfSummary: parsed.data.selfSummary,
        actor: { kind: 'agent', id: runRow.agent_id },
      });
      recorded++;
    }
    return { ok: true, batchesReceived: state.receivedBatches.size, rowCount: state.rows.length, recorded, skipped };
  }

  async abortEpisodeIngest(projectId: string, scopeId: string): Promise<{ ok: true }> {
    await this.assertProjectId(projectId);
    const state = this.ingestEpisodes.get(scopeId);
    if (state) abortIngestEpisode(state);
    return { ok: true };
  }

  async episodeIngestStatus(
    projectId: string,
    scopeId: string,
  ): Promise<{ status: 'unknown' | 'pending' | 'complete' | 'aborted'; batchesReceived: number; batchesExpected: number | null }> {
    await this.assertProjectId(projectId);
    const state = this.ingestEpisodes.get(scopeId);
    if (!state) return { status: 'unknown', batchesReceived: 0, batchesExpected: null };
    return { status: state.status, batchesReceived: state.receivedBatches.size, batchesExpected: state.manifest.batchCount };
  }

  /**
   * Best-effort wipe of every row (PLNR-246), called fire-and-forget from
   * ProjectRoom.deleteProject once the D1 registry rows are already gone. Full
   * retention/quota/disaster-recovery policy is PLNR-250's — this is the
   * scheduling hook it hangs off of, not that policy itself. Deletes
   * children before parents (the reverse of SCHEMA_TABLES' creation order)
   * so it stays FK-safe even on a connection where `PRAGMA foreign_keys = ON`
   * is in effect. Schema and migration state are left intact — this empties
   * the store, it does not destroy it.
   */
  async erase(projectId: string): Promise<{ ok: true }> {
    await this.assertProjectId(projectId);
    this.ctx.storage.transactionSync(() => {
      for (const table of [...SCHEMA_TABLES].reverse()) {
        this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
      }
      this.ctx.storage.sql.exec(`DELETE FROM applied_operations`);
      this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = 0 WHERE id = 0`);
      this.ctx.storage.sql.exec(`UPDATE projector_cursor SET global_seq = 0 WHERE id = 0`);
    });
    return { ok: true };
  }

  /**
   * The full auditable erasure sequence (PLNR-250) — what a durable tombstone (migration 0072)
   * is retried against until every step reports complete. Order: (1) this DO's own rows,
   * including any generation debris a restore left behind (retained `prev_` tables, any
   * `staging_` tables from an import that never finished); (2) this project's entire R2
   * memory-backups prefix; (3)/(4) the vector and ingest-capability seams, shipped as explicit
   * "nothing to do yet" steps — no memory Vectorize entity exists before Phase 4 and no ingest
   * capability exists before Phase 5, so pretending to delete either would be theater. Each
   * step is independently idempotent: re-running on an already-erased project reports ok on
   * every step at effectively zero cost.
   */
  /** Test-only fault injection: force the next eraseAll's "store" step to fail — mirrors
   *  _setForceDeliveryFailure (PLNR-247), same reason: proves the tombstone survives a failed
   *  attempt and a later sweep completes it, without fighting the runtime for a real failure. */
  private _forceEraseFailure = false;
  async _setForceEraseFailure(projectId: string, fail: boolean): Promise<void> {
    await this.assertProjectId(projectId);
    this._forceEraseFailure = fail;
  }

  async eraseAll(projectId: string): Promise<EraseReport> {
    await this.assertProjectId(projectId);
    const steps: EraseStepResult[] = [];

    try {
      if (this._forceEraseFailure) throw new Error('injected erase failure (test)');
      await this.erase(projectId);
      this.ctx.storage.transactionSync(() => {
        for (const table of BACKUP_TABLES) {
          this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS prev_${table}`);
          this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS staging_${table}`);
        }
        this.ctx.storage.sql.exec(`UPDATE _meta SET value = '0' WHERE key = 'has_prior_generation'`);
      });
      this.ingestEpisodes.clear();
      steps.push({ step: 'store', ok: true, detail: 'rows and any generation debris cleared' });
    } catch (err) {
      steps.push({ step: 'store', ok: false, detail: String(err) });
    }

    try {
      const deleted = await deleteAllProjectBackups(this.env, projectId);
      steps.push({ step: 'r2-backups', ok: true, detail: this.env.FILES ? `${deleted} object(s) deleted` : 'R2 not configured — nothing to delete' });
    } catch (err) {
      steps.push({ step: 'r2-backups', ok: false, detail: String(err) });
    }

    steps.push({ step: 'vectors', ok: true, detail: 'no memory vector index exists yet (Phase 4) — nothing to delete' });
    // PLNR-260's capabilities are stateless HMAC tokens (§8) — there is no revocation list to
    // clear; a token minted before erasure stays verifiable for the rest of its own short TTL
    // (INGEST_TOKEN_TTL_SECONDS, ~15 min), scoped only to a project that no longer exists to
    // accept its writes (assertProjectId above already refuses any RPC for it). In-flight upload
    // STATE is real and is cleared in the 'store' step above — index-generation staging rows go
    // with the rest of SCHEMA_TABLES via erase(), and this.ingestEpisodes is cleared explicitly
    // (it is in-memory, not a SQL table) — this step is honest about the token itself, not
    // silent about the state.
    steps.push({
      step: 'ingest-capabilities',
      ok: true,
      detail: 'stateless HMAC capabilities cannot be revoked — bounded by their own short TTL; in-flight upload state was cleared in the store step',
    });

    return { ok: steps.every((s) => s.ok), steps };
  }

  // ---------------------------------------------------------------------------
  // Outbox delivery + D1 event projector (PLNR-247)
  // ---------------------------------------------------------------------------

  /**
   * Test-only fault injection: force the next `drainOutbox` delivery attempt
   * to fail before it ever reaches ProjectRoom. Lets a test prove the outbox
   * row survives a failed delivery and a later `reconcile` closes the gap,
   * without fighting the runtime for a real transport failure.
   */
  private _forceDeliveryFailure = false;
  async _setForceDeliveryFailure(projectId: string, fail: boolean): Promise<void> {
    await this.assertProjectId(projectId);
    this._forceDeliveryFailure = fail;
  }

  // ---------------------------------------------------------------------------
  // Real memory/evidence/graph write APIs (PLNR-251) — replaces the old `_mutate` stand-in.
  //
  // Every write here shares one shape: resolve an operation id, check `applied_operations` for
  // a prior application of it (idempotent replay), and — for a genuinely new operation — run ONE
  // `transactionSync` that performs the mutation, writes the outbox row, bumps `memory_revision`,
  // and records the operation as applied together with the id it produced. All four commit or
  // none do (§4) — that is what makes a retried write with the same operation id safe rather
  // than merely detected-after-the-fact.
  //
  // The outbox always emits verb 'memory.changed' / subjectType 'memory' — the ONE compact verb
  // ProjectRoom's closed `EventVerb`/subjectType enums carry for every memory-subsystem change
  // (see events.ts). Which kind of record changed rides the payload's `entityType`, never the
  // verb or subjectType themselves.
  // ---------------------------------------------------------------------------

  private lookupAppliedOperation(operationId: string): { subject_type: string; subject_id: string; result: string } | null {
    const row = this.ctx.storage.sql
      .exec<{ subject_type: string; subject_id: string; result: string }>(
        `SELECT subject_type, subject_id, result FROM applied_operations WHERE operation_id = ?1`,
        operationId,
      )
      .toArray()[0];
    return row ?? null;
  }

  /** Test-only fault injection: force the next write RPC's transaction to throw mid-commit,
   *  proving the mutation, its outbox row, and its revision bump are one atomic unit rather
   *  than three separate writes that could partially land. Mirrors `_setForceDeliveryFailure`
   *  / `_setForceEraseFailure` (same reason: a real SQLite failure isn't reproducible on demand). */
  private _forceWriteFailure = false;
  async _setForceWriteFailure(projectId: string, fail: boolean): Promise<void> {
    await this.assertProjectId(projectId);
    this._forceWriteFailure = fail;
  }

  async recordMemory(
    projectId: string,
    input: {
      operationId?: string;
      kind: string;
      statement: string;
      authority?: number;
      confidence?: number | null;
      evidence?: unknown[];
      supersedesMemoryId?: string | null;
      scope?: unknown;
      actor: { kind: string; id: string | null };
    },
  ): Promise<{ memoryId: string; operationId: string; deduped: boolean }> {
    await this.assertProjectId(projectId);
    if (input.operationId) {
      const existing = this.lookupAppliedOperation(input.operationId);
      if (existing) return { memoryId: (JSON.parse(existing.result) as { memoryId: string }).memoryId, operationId: input.operationId, deduped: true };
    }
    const scope = validateMemoryScope(input.scope ?? {});
    const evidenceRefs = (input.evidence ?? []).map((e) => validateEvidenceRef(e));
    const evidenceHashes = await Promise.all(evidenceRefs.map((e) => evidenceHash(e)));
    const contentHash = await memoryContentHash(input.kind, input.statement, scope);

    const operationId = input.operationId ?? newId('op');
    const authority = clampAuthority(input.authority ?? AUTHORITY_HYPOTHESIS, input.actor.kind);
    const memoryId = newId('mem');
    const now = nowIso();

    this.ctx.storage.transactionSync(() => {
      if (this._forceWriteFailure) throw new Error('injected write failure (test)');
      if (scope.repositoryKey) {
        this.ctx.storage.sql.exec(
          `INSERT INTO repositories (repository_key, created_at) VALUES (?1, ?2) ON CONFLICT (repository_key) DO NOTHING`,
          scope.repositoryKey,
          now,
        );
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO memory_items
           (id, kind, statement, authority, confidence, content_hash, repository_key, branch, base_id, supersedes_memory_id, recorded_by_agent_id, recorded_at, proposed_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`,
        memoryId,
        input.kind,
        input.statement,
        authority,
        input.confidence ?? null,
        contentHash,
        scope.repositoryKey ?? null,
        scope.branch ?? null,
        scope.baseId ?? null,
        input.supersedesMemoryId ?? null,
        input.actor.id ?? null,
        now,
        // A decision an AGENT records enters the approval queue automatically (§12/PLNR-253) —
        // it is already non-authoritative (clamped above), and "proposed" is what makes it
        // visible-but-inert until a human decides, the SAME derived-state pattern spin-off tasks
        // use (migrations/0064). A human/system-recorded decision (there is no such path yet,
        // but the field is actor-general) is not auto-proposed — only an untrusted AI claim needs
        // the gate.
        input.kind === 'decision' && input.actor.kind === 'agent' ? now : null,
      );
      evidenceRefs.forEach((ref, i) => {
        this.ctx.storage.sql.exec(
          `INSERT INTO evidence
             (id, memory_item_id, repository_key, branch, base_id, path, symbol, content_hash, evidence_hash, verification_state, created_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
          newId('ev'),
          memoryId,
          ref.repositoryKey,
          ref.branch,
          ref.baseId,
          ref.path,
          ref.symbol,
          ref.contentHash,
          evidenceHashes[i]!,
          ref.verificationState,
          now,
        );
      });
      this.ctx.storage.sql.exec(
        `INSERT INTO outbox (id, operation_id, verb, subject_type, subject_id, payload, created_at) VALUES (?1,?2,'memory.changed','memory',?3,?4,?5)`,
        newId('obx'),
        operationId,
        memoryId,
        JSON.stringify({ operationId, entityType: 'memory_item', kind: input.kind, authority }),
        now,
      );
      this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = value + 1 WHERE id = 0`);
      this.ctx.storage.sql.exec(
        `INSERT INTO applied_operations (operation_id, applied_at, subject_type, subject_id, result) VALUES (?1,?2,'memory_item',?3,?4)`,
        operationId,
        now,
        memoryId,
        JSON.stringify({ memoryId }),
      );
    });
    this.ctx.storage.setAlarm(Date.now()).catch(() => {});
    // PLNR-255: index the new version (and de-index the one it supersedes, so the old
    // statement stops out-ranking its replacement — the row itself stays fully readable via
    // getMemoryItem, only its vector is dropped). Fire-and-forget, same as every other write
    // side-effect here: indexing must never fail or slow down the write it derives from.
    const searchBackendForIndex = searchBackend(this.env);
    if (searchBackendForIndex) {
      const supersedes = input.supersedesMemoryId ?? null;
      void indexEntity(searchBackendForIndex, { kind: 'memory', id: memoryId, projectId, title: input.kind, body: input.statement })
        .then(() => (supersedes ? removeEntity(searchBackendForIndex, 'memory', supersedes) : undefined))
        .catch((err) => console.warn(`ProjectMemory memory-index for ${memoryId} failed: ${String(err)}`));
    }
    return { memoryId, operationId, deduped: false };
  }

  async writeNode(
    projectId: string,
    input: { operationId?: string; type: string; uri: string; label: string; actor: { kind: string; id: string | null } },
  ): Promise<{ nodeId: string; operationId: string; deduped: boolean }> {
    await this.assertProjectId(projectId);
    if (input.operationId) {
      const existing = this.lookupAppliedOperation(input.operationId);
      if (existing) return { nodeId: (JSON.parse(existing.result) as { nodeId: string }).nodeId, operationId: input.operationId, deduped: true };
    }
    const operationId = input.operationId ?? newId('op');
    const candidateId = newId('node');
    const now = nowIso();
    let nodeId = candidateId;
    this.ctx.storage.transactionSync(() => {
      if (this._forceWriteFailure) throw new Error('injected write failure (test)');
      this.ctx.storage.sql.exec(
        `INSERT INTO nodes (id, type, uri, label, created_at) VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT (uri) DO UPDATE SET label = excluded.label`,
        candidateId,
        input.type,
        input.uri,
        input.label,
        now,
      );
      nodeId = this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE uri = ?1`, input.uri).toArray()[0]!.id;
      this.ctx.storage.sql.exec(
        `INSERT INTO outbox (id, operation_id, verb, subject_type, subject_id, payload, created_at) VALUES (?1,?2,'memory.changed','memory',?3,?4,?5)`,
        newId('obx'),
        operationId,
        nodeId,
        JSON.stringify({ operationId, entityType: 'node', nodeType: input.type }),
        now,
      );
      this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = value + 1 WHERE id = 0`);
      this.ctx.storage.sql.exec(
        `INSERT INTO applied_operations (operation_id, applied_at, subject_type, subject_id, result) VALUES (?1,?2,'node',?3,?4)`,
        operationId,
        now,
        nodeId,
        JSON.stringify({ nodeId }),
      );
    });
    this.ctx.storage.setAlarm(Date.now()).catch(() => {});
    return { nodeId, operationId, deduped: false };
  }

  async writeEdge(
    projectId: string,
    input: { operationId?: string; type: string; fromNodeId: string; toNodeId: string; actor: { kind: string; id: string | null } },
  ): Promise<{ edgeId: string; operationId: string; deduped: boolean }> {
    await this.assertProjectId(projectId);
    if (input.operationId) {
      const existing = this.lookupAppliedOperation(input.operationId);
      if (existing) return { edgeId: (JSON.parse(existing.result) as { edgeId: string }).edgeId, operationId: input.operationId, deduped: true };
    }
    const operationId = input.operationId ?? newId('op');
    const candidateId = newId('edge');
    const now = nowIso();
    let edgeId = candidateId;
    this.ctx.storage.transactionSync(() => {
      if (this._forceWriteFailure) throw new Error('injected write failure (test)');
      this.ctx.storage.sql.exec(
        `INSERT INTO edges (id, type, from_node_id, to_node_id, created_at) VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT (type, from_node_id, to_node_id) DO NOTHING`,
        candidateId,
        input.type,
        input.fromNodeId,
        input.toNodeId,
        now,
      );
      edgeId = this.ctx.storage.sql
        .exec<{ id: string }>(`SELECT id FROM edges WHERE type = ?1 AND from_node_id = ?2 AND to_node_id = ?3`, input.type, input.fromNodeId, input.toNodeId)
        .toArray()[0]!.id;
      this.ctx.storage.sql.exec(
        `INSERT INTO outbox (id, operation_id, verb, subject_type, subject_id, payload, created_at) VALUES (?1,?2,'memory.changed','memory',?3,?4,?5)`,
        newId('obx'),
        operationId,
        edgeId,
        JSON.stringify({ operationId, entityType: 'edge', edgeType: input.type }),
        now,
      );
      this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = value + 1 WHERE id = 0`);
      this.ctx.storage.sql.exec(
        `INSERT INTO applied_operations (operation_id, applied_at, subject_type, subject_id, result) VALUES (?1,?2,'edge',?3,?4)`,
        operationId,
        now,
        edgeId,
        JSON.stringify({ edgeId }),
      );
    });
    this.ctx.storage.setAlarm(Date.now()).catch(() => {});
    return { edgeId, operationId, deduped: false };
  }

  /** Link two memories as contradicting each other, addressable as one named set (§12). Passing
   *  an existing `setId` folds a third (or later) memory into the same disagreement rather than
   *  starting a new one. */
  async addContradiction(
    projectId: string,
    input: {
      operationId?: string;
      memoryItemId: string;
      contradictsMemoryItemId: string;
      setId?: string | null;
      actor: { kind: string; id: string | null };
    },
  ): Promise<{ setId: string; contradictionId: string; operationId: string; deduped: boolean }> {
    await this.assertProjectId(projectId);
    if (input.operationId) {
      const existing = this.lookupAppliedOperation(input.operationId);
      if (existing) {
        const result = JSON.parse(existing.result) as { setId: string; contradictionId: string };
        return { ...result, operationId: input.operationId, deduped: true };
      }
    }
    const operationId = input.operationId ?? newId('op');
    const setId = input.setId ?? newId('cset');
    const contradictionId = newId('contra');
    const now = nowIso();
    this.ctx.storage.transactionSync(() => {
      if (this._forceWriteFailure) throw new Error('injected write failure (test)');
      if (!input.setId) {
        this.ctx.storage.sql.exec(`INSERT INTO contradiction_sets (id, created_at) VALUES (?1, ?2)`, setId, now);
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO contradictions (id, memory_item_id, contradicts_memory_item_id, set_id, created_at) VALUES (?1,?2,?3,?4,?5)`,
        contradictionId,
        input.memoryItemId,
        input.contradictsMemoryItemId,
        setId,
        now,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO outbox (id, operation_id, verb, subject_type, subject_id, payload, created_at) VALUES (?1,?2,'memory.changed','memory',?3,?4,?5)`,
        newId('obx'),
        operationId,
        contradictionId,
        JSON.stringify({ operationId, entityType: 'contradiction', setId }),
        now,
      );
      this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = value + 1 WHERE id = 0`);
      this.ctx.storage.sql.exec(
        `INSERT INTO applied_operations (operation_id, applied_at, subject_type, subject_id, result) VALUES (?1,?2,'contradiction',?3,?4)`,
        operationId,
        now,
        contradictionId,
        JSON.stringify({ setId, contradictionId }),
      );
    });
    this.ctx.storage.setAlarm(Date.now()).catch(() => {});
    return { setId, contradictionId, operationId, deduped: false };
  }

  /** Every memory item currently in a named contradiction set — the set is the addressable
   *  unit a caller resolves, not the individual pairwise rows. */
  async getContradictionSet(projectId: string, setId: string): Promise<{ setId: string; memoryItemIds: string[]; resolvedAt: string | null }> {
    await this.assertProjectId(projectId);
    const rows = this.ctx.storage.sql
      .exec<{ memory_item_id: string; contradicts_memory_item_id: string }>(
        `SELECT memory_item_id, contradicts_memory_item_id FROM contradictions WHERE set_id = ?1`,
        setId,
      )
      .toArray();
    const ids = new Set<string>();
    for (const r of rows) {
      ids.add(r.memory_item_id);
      ids.add(r.contradicts_memory_item_id);
    }
    const setRow = this.ctx.storage.sql.exec<{ resolved_at: string | null }>(`SELECT resolved_at FROM contradiction_sets WHERE id = ?1`, setId).toArray()[0];
    return { setId, memoryItemIds: [...ids], resolvedAt: setRow?.resolved_at ?? null };
  }

  /** Basic up/down feedback on a memory (§11 — an operation on the memory surface, not a
   *  separate agent tool). 0001's `feedback.vote` is CHECK-constrained to exactly these two
   *  values; PLNR-254 widens the vocabulary (useful/incorrect/outdated/harmful/unverifiable)
   *  with its own additive migration — this RPC does not anticipate that shape. */
  /** Feedback kind -> vote, when a caller supplies `kind` but not `vote` (§11/PLNR-254): the
   *  richer vocabulary still lands in the plain up/down bucket every existing reader (and the
   *  0001-era `vote` NOT NULL constraint) expects, without forcing every caller to state both. */
  private static readonly FEEDBACK_KIND_VOTE: Record<string, 'up' | 'down'> = {
    useful: 'up',
    incorrect: 'down',
    outdated: 'down',
    harmful: 'down',
    unverifiable: 'down',
  };

  /**
   * Record feedback on a memory (§11 — an operation on the memory surface, never a separate
   * agent tool). Influences ranking/presentation ONLY: it never touches the target's statement,
   * evidence, or authority — a correction is a NEW version (recordMemory + supersedesMemoryId),
   * not an edit here. `kind` (PLNR-254) carries the five-value vocabulary useful / incorrect /
   * outdated / harmful / unverifiable; `vote` (0001) stays the plain up/down signal every
   * existing caller already sends. At least one of the two is required; the other is derived
   * when omitted.
   */
  async recordFeedback(
    projectId: string,
    input: {
      operationId?: string;
      memoryItemId: string;
      vote?: 'up' | 'down';
      kind?: 'useful' | 'incorrect' | 'outdated' | 'harmful' | 'unverifiable';
      reason?: string | null;
      actor: { kind: string; id: string | null };
    },
  ): Promise<{ feedbackId: string; operationId: string; deduped: boolean }> {
    await this.assertProjectId(projectId);
    if (input.operationId) {
      const existing = this.lookupAppliedOperation(input.operationId);
      if (existing) return { feedbackId: (JSON.parse(existing.result) as { feedbackId: string }).feedbackId, operationId: input.operationId, deduped: true };
    }
    if (!input.vote && !input.kind) throw new Error('recordFeedback requires vote and/or kind');
    const vote = input.vote ?? ProjectMemory.FEEDBACK_KIND_VOTE[input.kind!]!;
    const kind = input.kind ?? null;

    const operationId = input.operationId ?? newId('op');
    const feedbackId = newId('fbk');
    const now = nowIso();
    this.ctx.storage.transactionSync(() => {
      if (this._forceWriteFailure) throw new Error('injected write failure (test)');
      this.ctx.storage.sql.exec(
        `INSERT INTO feedback (id, memory_item_id, actor_id, vote, kind, reason, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)`,
        feedbackId,
        input.memoryItemId,
        input.actor.id ?? 'system',
        vote,
        kind,
        input.reason ?? null,
        now,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO outbox (id, operation_id, verb, subject_type, subject_id, payload, created_at) VALUES (?1,?2,'memory.changed','memory',?3,?4,?5)`,
        newId('obx'),
        operationId,
        feedbackId,
        JSON.stringify({ operationId, entityType: 'feedback', memoryItemId: input.memoryItemId, vote, kind }),
        now,
      );
      this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = value + 1 WHERE id = 0`);
      this.ctx.storage.sql.exec(
        `INSERT INTO applied_operations (operation_id, applied_at, subject_type, subject_id, result) VALUES (?1,?2,'feedback',?3,?4)`,
        operationId,
        now,
        feedbackId,
        JSON.stringify({ feedbackId }),
      );
    });
    this.ctx.storage.setAlarm(Date.now()).catch(() => {});
    return { feedbackId, operationId, deduped: false };
  }

  /**
   * Transition a memory's own presentation validity (§15) — 'active' | 'stale' | 'invalid'.
   * Deliberately separate from `evidence.verification_state` (per-citation freshness, 0001):
   * this is the memory's OWN state, and setting it never touches any evidence row's own value.
   * Recorded as a state change alongside canonical history, never a deletion — the memory stays
   * fully readable at every validity, exactly like a superseded or rejected one.
   */
  async transitionMemoryValidity(
    projectId: string,
    input: { memoryItemId: string; validity: 'active' | 'stale' | 'invalid'; reason?: string | null; actor: { kind: string; id: string | null } },
  ): Promise<{ ok: true }> {
    await this.assertProjectId(projectId);
    const row = this.loadMemoryRow(input.memoryItemId);
    if (!row) throw new Error(`memory item ${input.memoryItemId} not found`);
    const operationId = newId('op');
    const now = nowIso();
    this.ctx.storage.transactionSync(() => {
      if (this._forceWriteFailure) throw new Error('injected write failure (test)');
      this.ctx.storage.sql.exec(`UPDATE memory_items SET validity = ?2 WHERE id = ?1`, input.memoryItemId, input.validity);
      this.ctx.storage.sql.exec(
        `INSERT INTO outbox (id, operation_id, verb, subject_type, subject_id, payload, created_at) VALUES (?1,?2,'memory.changed','memory',?3,?4,?5)`,
        newId('obx'),
        operationId,
        input.memoryItemId,
        JSON.stringify({ operationId, entityType: 'validity_transition', memoryItemId: input.memoryItemId, validity: input.validity, reason: input.reason ?? null }),
        now,
      );
      this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = value + 1 WHERE id = 0`);
      this.ctx.storage.sql.exec(
        `INSERT INTO applied_operations (operation_id, applied_at, subject_type, subject_id, result) VALUES (?1,?2,'validity_transition',?3,'{}')`,
        operationId,
        now,
        input.memoryItemId,
      );
    });
    this.ctx.storage.setAlarm(Date.now()).catch(() => {});
    return { ok: true };
  }

  /**
   * Bounded retention for unused low-authority hypotheses (§18/PLNR-254). A candidate is
   * decayed only when ALL of: authority below `authorityCeiling`, recorded before the cutoff,
   * no feedback of any kind has ever been recorded on it (feedback IS usage — a memory somebody
   * reacted to is not "unused"), it is not part of any authority-transition history (never
   * approved, rejected, or merge-promoted, and never itself the RESULT of one), and nothing
   * supersedes it (a memory another version links back to is history, not a cache entry).
   * Unlike supersession/rejection, decay actually DELETES the row — recoverable only by
   * restoring a pre-decay snapshot (PLNR-248/249), which is what "reversible from backup" means
   * here, not an in-store undo. One compact outbox audit event covers the whole run; no memory
   * body rides it. Safe to call repeatedly: a project with nothing left to decay is a no-op.
   *
   * NOTE on "unused": no retrieval/usage-counter infrastructure exists yet (that is Phase 4's
   * retrieval work) — absence of feedback plus age is the only honest signal available today.
   * A real usage counter can replace or narrow this once retrieval exists.
   */
  async decayLowAuthorityMemories(
    projectId: string,
    input: { maxAgeMs: number; authorityCeiling: number },
  ): Promise<{ decayed: string[] }> {
    await this.assertProjectId(projectId);
    const cutoff = new Date(Date.now() - input.maxAgeMs).toISOString();
    const candidates = this.ctx.storage.sql
      .exec<{ id: string }>(
        `SELECT id FROM memory_items m
         WHERE authority < ?1 AND recorded_at < ?2
           AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.memory_item_id = m.id)
           AND NOT EXISTS (SELECT 1 FROM memory_items m2 WHERE m2.supersedes_memory_id = m.id)
           AND NOT EXISTS (
             SELECT 1 FROM memory_authority_transitions t
             WHERE t.memory_item_id = m.id OR t.resulting_memory_id = m.id
           )`,
        input.authorityCeiling,
        cutoff,
      )
      .toArray();
    if (candidates.length === 0) return { decayed: [] };

    const decayed = candidates.map((c) => c.id);
    const operationId = newId('op');
    const now = nowIso();
    this.ctx.storage.transactionSync(() => {
      if (this._forceWriteFailure) throw new Error('injected write failure (test)');
      for (const id of decayed) {
        this.ctx.storage.sql.exec(`DELETE FROM feedback WHERE memory_item_id = ?1`, id);
        this.ctx.storage.sql.exec(`DELETE FROM evidence WHERE memory_item_id = ?1`, id);
        this.ctx.storage.sql.exec(`DELETE FROM memory_items WHERE id = ?1`, id);
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO outbox (id, operation_id, verb, subject_type, subject_id, payload, created_at) VALUES (?1,?2,'memory.changed','memory',?3,?4,?5)`,
        newId('obx'),
        operationId,
        projectId,
        JSON.stringify({ operationId, entityType: 'decay', count: decayed.length, decayedIds: decayed }),
        now,
      );
      this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = value + 1 WHERE id = 0`);
      this.ctx.storage.sql.exec(
        `INSERT INTO applied_operations (operation_id, applied_at, subject_type, subject_id, result) VALUES (?1,?2,'decay',?3,'{}')`,
        operationId,
        now,
        projectId,
      );
    });
    this.ctx.storage.setAlarm(Date.now()).catch(() => {});
    // PLNR-255: decay is the one path that hard-deletes memory rows — their vectors must be
    // dropped too, or they hydrate to nothing forever (hydrate's silent-skip would just make
    // them vanish from results, but the vector itself would sit in the index permanently).
    const searchBackendForIndex = searchBackend(this.env);
    if (searchBackendForIndex) {
      for (const id of decayed) {
        void removeEntity(searchBackendForIndex, 'memory', id).catch((err) => console.warn(`ProjectMemory memory-deindex for ${id} failed: ${String(err)}`));
      }
    }
    return { decayed };
  }

  /** A memory item in full — statement, authority, scope, and its evidence — exactly as
   *  recorded. A superseded item is reachable through this the same way its replacement is;
   *  supersession never mutates or hides the row it links back to (§12). */
  async getMemoryItem(projectId: string, memoryId: string): Promise<{
    id: string;
    kind: string;
    statement: string;
    authority: number;
    confidence: number | null;
    contentHash: string | null;
    repositoryKey: string | null;
    branch: string | null;
    baseId: string | null;
    validity: string;
    supersedesMemoryId: string | null;
    recordedByAgentId: string | null;
    recordedAt: string;
    proposedAt: string | null;
    rejectedAt: string | null;
    evidence: Array<{ id: string; repositoryKey: string; branch: string; baseId: string; path: string; symbol: string | null; verificationState: string }>;
  } | null> {
    await this.assertProjectId(projectId);
    const row = this.ctx.storage.sql
      .exec<{
        id: string;
        kind: string;
        statement: string;
        authority: number;
        confidence: number | null;
        content_hash: string | null;
        repository_key: string | null;
        branch: string | null;
        base_id: string | null;
        validity: string;
        supersedes_memory_id: string | null;
        recorded_by_agent_id: string | null;
        recorded_at: string;
        proposed_at: string | null;
        rejected_at: string | null;
      }>(`SELECT * FROM memory_items WHERE id = ?1`, memoryId)
      .toArray()[0];
    if (!row) return null;
    const evidence = this.ctx.storage.sql
      .exec<{ id: string; repository_key: string; branch: string; base_id: string; path: string; symbol: string | null; verification_state: string }>(
        `SELECT id, repository_key, branch, base_id, path, symbol, verification_state FROM evidence WHERE memory_item_id = ?1 ORDER BY created_at`,
        memoryId,
      )
      .toArray();
    return {
      id: row.id,
      kind: row.kind,
      statement: row.statement,
      authority: row.authority,
      confidence: row.confidence,
      contentHash: row.content_hash,
      repositoryKey: row.repository_key,
      branch: row.branch,
      baseId: row.base_id,
      validity: row.validity,
      supersedesMemoryId: row.supersedes_memory_id,
      recordedByAgentId: row.recorded_by_agent_id,
      recordedAt: row.recorded_at,
      proposedAt: row.proposed_at,
      rejectedAt: row.rejected_at,
      evidence: evidence.map((e) => ({
        id: e.id,
        repositoryKey: e.repository_key,
        branch: e.branch,
        baseId: e.base_id,
        path: e.path,
        symbol: e.symbol,
        verificationState: e.verification_state,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Operational search integration (PLNR-255) — the two read RPCs search.ts's hydrate() and
  // keywordSearch() drive for memory/episode kinds. Both are read-only: no memory_revision
  // bump, no outbox row — a query is not a canonical mutation.
  // ---------------------------------------------------------------------------

  /** Fill display fields for memory/episode VECTOR matches — called once per distinct
   *  projectId a match set touches. Authority and validity are read from the canonical row
   *  HERE, at query time, never carried in vector metadata (§1/§12): a promotion or validity
   *  transition is visible immediately, with no re-index required. A ref for a row deleted
   *  since indexing (e.g. by decay) is silently absent from the result, same as D1 hydration. */
  async hydrateSearchHits(
    projectId: string,
    refs: Array<{ kind: 'memory' | 'episode'; id: string }>,
  ): Promise<Array<{ kind: 'memory' | 'episode'; id: string; title: string; snippet: string; status?: string; authority?: number; validity?: string }>> {
    await this.assertProjectId(projectId);
    const out: Array<{ kind: 'memory' | 'episode'; id: string; title: string; snippet: string; status?: string; authority?: number; validity?: string }> = [];
    const memIds = refs.filter((r) => r.kind === 'memory').map((r) => r.id);
    const epIds = refs.filter((r) => r.kind === 'episode').map((r) => r.id);
    if (memIds.length) {
      const rows = this.ctx.storage.sql
        .exec<{ id: string; kind: string; statement: string; authority: number; validity: string }>(
          `SELECT id, kind, statement, authority, validity FROM memory_items WHERE id IN (${memIds.map(() => '?').join(',')})`,
          ...memIds,
        )
        .toArray();
      for (const r of rows) out.push({ kind: 'memory', id: r.id, title: r.kind, snippet: r.statement.slice(0, 200), authority: r.authority, validity: r.validity });
    }
    if (epIds.length) {
      const rows = this.ctx.storage.sql
        .exec<{ id: string; run_id: string; landing_outcome: string; body: string }>(
          `SELECT id, run_id, landing_outcome, body FROM episodes WHERE id IN (${epIds.map(() => '?').join(',')})`,
          ...epIds,
        )
        .toArray();
      for (const r of rows) {
        out.push({
          kind: 'episode',
          id: r.id,
          title: `episode ${r.run_id} (${r.landing_outcome})`,
          snippet: summarizeEpisodeBody(r.body).slice(0, 200),
          status: r.landing_outcome,
        });
      }
    }
    return out;
  }

  /** The no-Vectorize lexical fallback (§20) — memory content never reaches D1 (§3/§4), so this
   *  LIKE scan runs INSIDE ProjectMemory rather than as a D1 query, and search.ts's
   *  keywordSearch merges it with the D1 task/doc/plan results. Same AND-every-term contract as
   *  the D1 scan; score mirrors its (matched+1)/(terms+1) shape (every returned row matched
   *  every term, so this is always 1 — ties break on recency). */
  async searchMemoryLexical(
    projectId: string,
    opts: { q: string; kinds?: Array<'memory' | 'episode'>; limit?: number },
  ): Promise<Array<{ kind: 'memory' | 'episode'; id: string; title: string; snippet: string; score: number; status?: string; authority?: number; validity?: string }>> {
    await this.assertProjectId(projectId);
    const limit = opts.limit ?? 12;
    const kinds = opts.kinds?.length ? opts.kinds : (['memory', 'episode'] as const);
    const terms = opts.q.replace(/[%_]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!terms.length) return [];
    const likes = terms.map((t) => `%${t}%`);
    const hits: Array<{ kind: 'memory' | 'episode'; id: string; title: string; snippet: string; score: number; status?: string; authority?: number; validity?: string }> = [];
    if (kinds.includes('memory')) {
      const where = likes.map(() => `statement LIKE ?`).join(' AND ');
      const rows = this.ctx.storage.sql
        .exec<{ id: string; kind: string; statement: string; authority: number; validity: string }>(
          `SELECT id, kind, statement, authority, validity FROM memory_items WHERE ${where} ORDER BY recorded_at DESC LIMIT ${limit}`,
          ...likes,
        )
        .toArray();
      for (const r of rows) hits.push({ kind: 'memory', id: r.id, title: r.kind, snippet: r.statement.slice(0, 200), score: 1, authority: r.authority, validity: r.validity });
    }
    if (kinds.includes('episode')) {
      const where = likes.map(() => `body LIKE ?`).join(' AND ');
      const rows = this.ctx.storage.sql
        .exec<{ id: string; run_id: string; landing_outcome: string; body: string }>(
          `SELECT id, run_id, landing_outcome, body FROM episodes WHERE ${where} ORDER BY created_at DESC LIMIT ${limit}`,
          ...likes,
        )
        .toArray();
      for (const r of rows) {
        hits.push({
          kind: 'episode',
          id: r.id,
          title: `episode ${r.run_id} (${r.landing_outcome})`,
          snippet: summarizeEpisodeBody(r.body).slice(0, 200),
          score: 1,
          status: r.landing_outcome,
        });
      }
    }
    return hits.slice(0, limit);
  }

  // ---------------------------------------------------------------------------
  // Hybrid retrieval (PLNR-257) — exact lookup, lexical scan, semantic candidates, and bounded
  // graph expansion, combined and reranked by memory/retrieval.ts (which never opens storage;
  // this class supplies the rows). Read-only: no memory_revision bump, no outbox row, no
  // applied_operations entry — a query is not a canonical mutation (§4).
  // ---------------------------------------------------------------------------

  private evidenceVerificationStates(memoryItemId: string): string[] {
    return this.ctx.storage.sql
      .exec<{ verification_state: string }>(`SELECT verification_state FROM evidence WHERE memory_item_id = ?1 ORDER BY created_at`, memoryItemId)
      .toArray()
      .map((r) => r.verification_state);
  }

  private memoryRowToHit(
    row: { id: string; kind: string; statement: string; authority: number; validity: string; repository_key: string | null; branch: string | null },
    stage: RetrievalStage,
    score: number,
  ): RetrievalHit {
    return {
      entityType: 'memory',
      id: row.id,
      kind: row.kind,
      title: row.kind,
      snippet: row.statement.slice(0, 200),
      stage,
      score,
      repositoryKey: row.repository_key,
      branch: row.branch,
      authority: row.authority,
      validity: row.validity,
      evidenceVerification: this.evidenceVerificationStates(row.id),
    };
  }

  private episodeRowToHit(
    row: { id: string; run_id: string; repository_key: string | null; landing_outcome: string; body: string },
    stage: RetrievalStage,
    score: number,
  ): RetrievalHit {
    return {
      entityType: 'episode',
      id: row.id,
      title: `episode ${row.run_id} (${row.landing_outcome})`,
      snippet: summarizeEpisodeBody(row.body).slice(0, 200),
      stage,
      score,
      repositoryKey: row.repository_key,
      status: row.landing_outcome,
    };
  }

  /** Exact-id lookup for a single memory item — the 'exact' stage. */
  private lookupMemoryHit(memoryItemId: string): RetrievalHit | null {
    const row = this.ctx.storage.sql
      .exec<{ id: string; kind: string; statement: string; authority: number; validity: string; repository_key: string | null; branch: string | null }>(
        `SELECT id, kind, statement, authority, validity, repository_key, branch FROM memory_items WHERE id = ?1`,
        memoryItemId,
      )
      .toArray()[0];
    return row ? this.memoryRowToHit(row, 'exact', 1) : null;
  }

  /** Exact-id lookup for a single episode — the 'exact' stage. */
  private lookupEpisodeHit(episodeId: string): RetrievalHit | null {
    const row = this.ctx.storage.sql
      .exec<{ id: string; run_id: string; repository_key: string | null; landing_outcome: string; body: string }>(
        `SELECT id, run_id, repository_key, landing_outcome, body FROM episodes WHERE id = ?1`,
        episodeId,
      )
      .toArray()[0];
    return row ? this.episodeRowToHit(row, 'exact', 1) : null;
  }

  /** Term-wise LIKE scan over memory_items AND episodes, same AND-every-term contract as
   *  search.ts's keyword fallback — the 'lexical' stage, always available (§20). */
  private lexicalRetrievalRows(q: string, opts: { kind?: string; limit: number }): RetrievalHit[] {
    const terms = q.replace(/[%_]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!terms.length) return [];
    const likes = terms.map((t) => `%${t}%`);
    const hits: RetrievalHit[] = [];

    const memWhere = likes.map(() => `statement LIKE ?`).join(' AND ');
    const memBinds: unknown[] = [...likes];
    let memKindFilter = '';
    if (opts.kind) {
      memKindFilter = `AND kind = ?${memBinds.length + 1}`;
      memBinds.push(opts.kind);
    }
    const memRows = this.ctx.storage.sql
      .exec<{ id: string; kind: string; statement: string; authority: number; validity: string; repository_key: string | null; branch: string | null }>(
        `SELECT id, kind, statement, authority, validity, repository_key, branch FROM memory_items WHERE ${memWhere} ${memKindFilter} ORDER BY recorded_at DESC LIMIT ${opts.limit}`,
        ...memBinds,
      )
      .toArray();
    for (const r of memRows) hits.push(this.memoryRowToHit(r, 'lexical', 1));

    const epWhere = likes.map(() => `body LIKE ?`).join(' AND ');
    const epRows = this.ctx.storage.sql
      .exec<{ id: string; run_id: string; repository_key: string | null; landing_outcome: string; body: string }>(
        `SELECT id, run_id, repository_key, landing_outcome, body FROM episodes WHERE ${epWhere} ORDER BY created_at DESC LIMIT ${opts.limit}`,
        ...likes,
      )
      .toArray();
    for (const r of epRows) hits.push(this.episodeRowToHit(r, 'lexical', 1));

    return hits;
  }

  /** Semantic candidates over the operational index (PLNR-255's vectors), hydrated from the
   *  CANONICAL row here rather than trusted from vector metadata — the 'semantic' stage. Null
   *  when no embeddings backend is bound (§20 — caller falls back to exact+lexical+graph). */
  private async semanticRetrievalRows(projectId: string, q: string, limit: number): Promise<RetrievalHit[]> {
    const backend = searchBackend(this.env);
    if (!backend) return [];
    const [vector] = await backend.embedder.embed([q]);
    if (!vector) return [];
    const { matches } = await backend.store.query(vector, { topK: Math.min(limit * 5, 100), filter: { projectId: { $eq: projectId } } });
    const hits: RetrievalHit[] = [];
    for (const m of matches) {
      const kind = String(m.id).split(':')[0];
      // Belt-and-suspenders project check, matching search.ts's own isolation contract — the
      // server-side filter above already scopes the query, this guards a filter that silently
      // failed to apply.
      if (String(m.metadata?.projectId ?? '') !== projectId) continue;
      if (kind === 'memory') {
        const entityId = (m.metadata?.entityId as string) ?? String(m.id).slice('memory:'.length);
        const hit = this.lookupMemoryHit(entityId);
        if (hit) hits.push({ ...hit, stage: 'semantic', score: m.score });
      } else if (kind === 'episode') {
        const entityId = (m.metadata?.entityId as string) ?? String(m.id).slice('episode:'.length);
        const hit = this.lookupEpisodeHit(entityId);
        if (hit) hits.push({ ...hit, stage: 'semantic', score: m.score });
      }
    }
    return hits;
  }

  /** Bounded recursive-CTE traversal from a seed node set (this is the FIRST use of
   *  WITH RECURSIVE against Durable Object SQLite in this repo, rather than D1 — verified to
   *  execute here by memory-retrieval.test.ts). Depth is capped structurally
   *  (`WHERE depth < maxDepth` bounds the recursion itself, not just the output) and the
   *  final row count is capped by `maxResults` — both from named constants, never a literal at
   *  the call site. Deduped in JS by nodeId, keeping the SHALLOWEST occurrence (`ORDER BY depth
   *  ASC` guarantees the first-seen row per id is the shortest path). */
  /**
   * Bounded recursive-CTE traversal, `direction`-aware (PLNR-258 grows PLNR-257's
   * forward-only original into both directions): 'downstream' follows `from_node_id → to_node_id`
   * (what this node points AT); 'upstream' follows the SAME edges backward, `to_node_id →
   * from_node_id` (what points AT this node) — the recorded edge path always shows the edge's
   * REAL direction regardless of which way it was walked. Fetches one row past `maxResults` to
   * report `truncated` honestly (a bounded result may not be the whole neighborhood) rather than
   * guessing from a suspiciously-round row count.
   */
  private rawTraverseGraph(
    seedNodeIds: string[],
    opts: { edgeTypes?: string[]; maxDepth?: number; maxResults?: number; direction?: 'downstream' | 'upstream' },
  ): { rows: Array<{ nodeId: string; uri: string; type: string; label: string; depth: number; edgePath: string }>; truncated: boolean } {
    if (!seedNodeIds.length) return { rows: [], truncated: false };
    const maxDepth = Math.min(Math.max(opts.maxDepth ?? RETRIEVAL_DEFAULTS.maxDepth, 1), RETRIEVAL_DEFAULTS.maxDepthCeiling);
    const maxResults = Math.min(Math.max(opts.maxResults ?? RETRIEVAL_DEFAULTS.maxGraphResults, 1), RETRIEVAL_DEFAULTS.maxGraphResultsCeiling);
    const [startCol, nextCol] = (opts.direction ?? 'downstream') === 'downstream' ? ['from_node_id', 'to_node_id'] : ['to_node_id', 'from_node_id'];

    const binds: unknown[] = [...seedNodeIds];
    const seedPlaceholders = seedNodeIds.map((_, i) => `?${i + 1}`).join(',');
    let edgeFilterSql = '';
    if (opts.edgeTypes?.length) {
      const start = binds.length + 1;
      edgeFilterSql = `AND e.type IN (${opts.edgeTypes.map((_, i) => `?${start + i}`).join(',')})`;
      binds.push(...opts.edgeTypes);
    }
    const depthPh = binds.length + 1;
    binds.push(maxDepth);
    const limitPh = binds.length + 1;
    binds.push(maxResults + 1); // +1 so truncation is detected, not guessed

    const rows = this.ctx.storage.sql
      .exec<{ nodeId: string; uri: string; type: string; label: string; depth: number; edgePath: string }>(
        `WITH RECURSIVE reach(node_id, depth, path) AS (
           SELECT id, 0, '' FROM nodes WHERE id IN (${seedPlaceholders})
           UNION
           SELECT e.${nextCol}, r.depth + 1,
                  CASE WHEN r.path = '' THEN (e.from_node_id || '>' || e.type || '>' || e.to_node_id)
                       ELSE (r.path || ';' || e.from_node_id || '>' || e.type || '>' || e.to_node_id) END
           FROM reach r JOIN edges e ON e.${startCol} = r.node_id
           WHERE r.depth < ?${depthPh} ${edgeFilterSql}
         )
         SELECT n.id AS nodeId, n.uri AS uri, n.type AS type, n.label AS label, reach.depth AS depth, reach.path AS edgePath
         FROM reach JOIN nodes n ON n.id = reach.node_id
         WHERE reach.depth > 0
         ORDER BY reach.depth ASC
         LIMIT ?${limitPh}`,
        ...binds,
      )
      .toArray();

    const truncated = rows.length > maxResults;
    const seen = new Set<string>();
    const deduped: typeof rows = [];
    for (const r of rows.slice(0, maxResults)) {
      if (seen.has(r.nodeId)) continue;
      seen.add(r.nodeId);
      deduped.push(r);
    }
    return { rows: deduped, truncated };
  }

  /** The general graph-traversal read API (replaces the old `_traverseFrom` test shim — this
   *  IS the general query surface it was deliberately narrow to avoid preempting). Bounded
   *  multi-hop expansion from one or more seed nodes, each hit carrying the edge path back to
   *  its seed. */
  async traverseGraph(
    projectId: string,
    input: { seedNodeIds: string[]; edgeTypes?: string[]; maxDepth?: number; maxResults?: number },
  ): Promise<Array<{ nodeId: string; uri: string; type: string; label: string; depth: number; edgePath: string }>> {
    await this.assertProjectId(projectId);
    return this.rawTraverseGraph(input.seedNodeIds, input).rows;
  }

  /** Resolve one node by its stable entity URI — the seed-lookup every PLNR-258 primitive
   *  starts from. Null when the URI has no matching node (e.g. a file/symbol URI before
   *  Phase 5's ingest has ever run). */
  private resolveNodeByUri(uri: string): { nodeId: string; uri: string; type: string; label: string } | null {
    const row = this.ctx.storage.sql
      .exec<{ id: string; uri: string; type: string; label: string }>(`SELECT id, uri, type, label FROM nodes WHERE uri = ?1`, uri)
      .toArray()[0];
    return row ? { nodeId: row.id, uri: row.uri, type: row.type, label: row.label } : null;
  }

  /** Which of `candidateTypes` have NEVER been written as an edge anywhere in this project —
   *  the concrete "why" behind a completeness marker of 'no-writer-yet' (PLNR-258 §2: absence
   *  of an edge is never evidence of absence of the relationship when nothing writes that edge
   *  type at all yet). */
  private edgeTypesWithNoWriter(candidateTypes: string[]): string[] {
    if (!candidateTypes.length) return [];
    const placeholders = candidateTypes.map((_, i) => `?${i + 1}`).join(',');
    const present = new Set(
      this.ctx.storage.sql
        .exec<{ type: string }>(`SELECT DISTINCT type FROM edges WHERE type IN (${placeholders})`, ...candidateTypes)
        .toArray()
        .map((r) => r.type),
    );
    return candidateTypes.filter((t) => !present.has(t));
  }

  /** True once this project's graph holds at least one node beyond coordination's own 'task'
   *  type — i.e. Phase 5/6 ingest has populated something. Always false today (the projector is
   *  the only node writer in src/), which is exactly what makes every PLNR-258 primitive's
   *  completeness marker honest rather than a formality. */
  private isCodeGraphPopulated(): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM nodes WHERE type IN ('file', 'symbol', 'api', 'test', 'database_entity')`,
        )
        .toArray()[0]?.n ?? 0
    ) > 0;
  }

  /**
   * The hybrid retrieval entry point (§10): exact lookup + lexical scan + semantic candidates
   * + bounded graph expansion, filtered (repository/branch/kind/authority/validity), reranked,
   * and lead-labelled by memory/retrieval.ts. `taskId`/`seedEntityUri` seed graph expansion —
   * "what does the project know connected to this task/entity" — rather than acting as a
   * post-hoc filter. Cross-project leakage is guarded at the semantic stage (the shared
   * multi-project vector index is the one real leak surface — see the stage's own project
   * check) and is structurally impossible at the lexical/exact/graph stages (this DO instance
   * IS one project). Read-only throughout.
   */
  async searchProjectMemory(
    projectId: string,
    opts: {
      query?: string;
      memoryItemId?: string;
      episodeId?: string;
      taskId?: string;
      seedEntityUri?: string;
      edgeTypes?: string[];
      maxDepth?: number;
      repositoryKey?: string;
      branch?: string;
      kind?: string;
      minAuthority?: number;
      validity?: string;
      limit?: number;
    },
  ): Promise<{ mode: 'semantic' | 'keyword'; results: RankedHit[] }> {
    await this.assertProjectId(projectId);
    const limit = Math.min(Math.max(opts.limit ?? RETRIEVAL_DEFAULTS.maxResults, 1), RETRIEVAL_DEFAULTS.maxResultsCeiling);
    const candidates: RetrievalHit[] = [];
    let mode: 'semantic' | 'keyword' = 'keyword';

    if (opts.memoryItemId) {
      const hit = this.lookupMemoryHit(opts.memoryItemId);
      if (hit) candidates.push(hit);
    }
    if (opts.episodeId) {
      const hit = this.lookupEpisodeHit(opts.episodeId);
      if (hit) candidates.push(hit);
    }

    if (opts.query?.trim()) {
      candidates.push(...this.lexicalRetrievalRows(opts.query, { kind: opts.kind, limit }));
      const semanticHits = await this.semanticRetrievalRows(projectId, opts.query, limit);
      if (semanticHits.length || searchBackend(this.env)) mode = 'semantic';
      candidates.push(...semanticHits);
    }

    const seedNodeIds: string[] = [];
    const resolveSeed = (uri: string) => this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE uri = ?1`, uri).toArray()[0]?.id;
    if (opts.taskId) {
      const id = resolveSeed(buildEntityUri({ kind: 'task', id: opts.taskId }));
      if (id) seedNodeIds.push(id);
    }
    if (opts.seedEntityUri) {
      const id = resolveSeed(opts.seedEntityUri);
      if (id) seedNodeIds.push(id);
    }
    if (seedNodeIds.length) {
      const graphRows = this.rawTraverseGraph(seedNodeIds, { edgeTypes: opts.edgeTypes, maxDepth: opts.maxDepth, maxResults: RETRIEVAL_DEFAULTS.maxGraphResults }).rows;
      for (const g of graphRows) {
        candidates.push({
          entityType: 'node',
          id: g.nodeId,
          uri: g.uri,
          kind: g.type,
          title: g.label,
          snippet: g.label,
          stage: 'graph',
          score: 1 / (1 + g.depth),
          seedNodeId: seedNodeIds[0],
          edgePath: g.edgePath,
          depth: g.depth,
        });
      }
    }

    const filtered = applyMemoryFilters(candidates, {
      repositoryKey: opts.repositoryKey,
      branch: opts.branch,
      kind: opts.kind,
      minAuthority: opts.minAuthority,
      validity: opts.validity,
    });
    const results = rankCandidates(filtered, { limit, preferBranch: opts.branch });
    return { mode, results };
  }

  /**
   * PLNR-264: has this task's likely area of work already been attempted? Gathers episode
   * candidates the SAME way `searchProjectMemory` does — `lexicalRetrievalRows` +
   * `semanticRetrievalRows` over the task's own title/body, plus bounded graph expansion from
   * the task's own node when one already exists (an earlier episode/memory linked it) — then
   * hands them to `memory/similar-effort.ts`'s pure classifier/gate/summarizer rather than
   * forking a second ranking pipeline. Read-only throughout (locked decision): no row written,
   * no validity transition, no outbox event. Callers (`can_claim`/`claim_task` in mcp.ts) call
   * this AFTER ProjectRoom returns and swallow a failure into "no priorEffort block" — never let
   * it touch the claim itself (§19).
   */
  async similarEffort(
    projectId: string,
    input: TaskEffortInput & { taskId: string; limit?: number },
  ): Promise<{ warnings: DuplicateWarning[]; summary: EffortSummary; consideredCount: number }> {
    await this.assertProjectId(projectId);
    const limit = Math.min(Math.max(input.limit ?? RETRIEVAL_DEFAULTS.maxResults, 1), RETRIEVAL_DEFAULTS.maxResultsCeiling);
    const signals = effortSignals(input);

    // episodeId -> best-known provenance across every stage that found it. A graph hit's
    // edgePath is never discarded in favor of a later text hit — it is the ONLY source of the
    // graph-neighborhood/shared-decision support kinds (memory/similar-effort.ts) — otherwise
    // the higher raw score wins.
    const provenance = new Map<string, { stage: RetrievalStage; score: number; edgePath?: string }>();
    const consider = (id: string, stage: RetrievalStage, score: number, edgePath?: string) => {
      const prev = provenance.get(id);
      if (!prev) { provenance.set(id, { stage, score, edgePath }); return; }
      if (edgePath && !prev.edgePath) { provenance.set(id, { stage, score: Math.max(prev.score, score), edgePath }); return; }
      if (score > prev.score) provenance.set(id, { ...prev, score });
    };

    if (signals.queryText.trim()) {
      for (const hit of this.lexicalRetrievalRows(signals.queryText, { limit })) {
        if (hit.entityType === 'episode') consider(hit.id, hit.stage, hit.score);
      }
      for (const hit of await this.semanticRetrievalRows(projectId, signals.queryText, limit)) {
        if (hit.entityType === 'episode') consider(hit.id, hit.stage, hit.score);
      }
    }
    // Graph expansion seeded at the TASK's own node — reachable only once something has already
    // linked this task into the graph (recordEpisode's own related_to edge, most commonly). A
    // brand-new task with no prior episode of its own simply contributes no graph candidates,
    // same "absence is not an error" posture as the rest of this file.
    const taskNode = this.resolveNodeByUri(buildEntityUri({ kind: 'task', id: input.taskId }));
    if (taskNode) {
      const seedIds = [taskNode.nodeId];
      const graphOpts = { maxResults: RETRIEVAL_DEFAULTS.maxGraphResults };
      const rows = [
        ...this.rawTraverseGraph(seedIds, { ...graphOpts, direction: 'downstream' }).rows,
        ...this.rawTraverseGraph(seedIds, { ...graphOpts, direction: 'upstream' }).rows,
      ];
      for (const row of rows) {
        if (row.type !== 'episode') continue;
        const ref = parseEntityUri(row.uri);
        if (ref.kind === 'episode') consider(ref.id, 'graph', 1 / (1 + row.depth), row.edgePath);
      }
    }

    const episodeIds = [...provenance.keys()];
    if (!episodeIds.length) return { warnings: [], summary: summarizeEffort([]), consideredCount: 0 };

    const placeholders = episodeIds.map((_, i) => `?${i + 1}`).join(',');
    const rows = this.ctx.storage.sql
      .exec<{
        id: string; run_id: string; task_id: string | null; landing_outcome: string; review_rounds: number;
        cost_usd: number; body: string; run_kind: string | null; outcome: string | null;
        started_at: string | null; finished_at: string | null;
      }>(
        `SELECT id, run_id, task_id, landing_outcome, review_rounds, cost_usd, body, run_kind, outcome, started_at, finished_at
         FROM episodes WHERE id IN (${placeholders})`,
        ...episodeIds,
      )
      .toArray();

    // Batch-resolve display keys for each candidate's anchor task — ProjectMemory holds no task
    // rows of its own (coordination lives in D1); the same "plain D1 read, not a coordination
    // mutation" precedent `resolveProjectKey` already sets.
    const taskIds = [...new Set(rows.map((r) => r.task_id).filter((t): t is string => !!t))];
    const taskKeyById = new Map<string, string>();
    if (taskIds.length) {
      const tphs = taskIds.map((_, i) => `?${i + 1}`).join(',');
      const { results } = await this.env.DB.prepare(`SELECT id, key FROM tasks WHERE id IN (${tphs})`).bind(...taskIds).all<{ id: string; key: string }>();
      for (const r of results) taskKeyById.set(r.id, r.key);
    }

    const candidates: EffortCandidate[] = rows.map((row) => {
      // Same tolerance `summarizeEpisodeBody` already applies — an unreadable body degrades to
      // empty fields rather than dropping the candidate (its deterministic columns are still
      // real evidence: run id, task, landing outcome, cost, review rounds).
      let body: Partial<EffortEpisode> = {};
      try { body = JSON.parse(row.body) as EffortEpisode; } catch { /* degrade to empty fields below */ }
      const prov = provenance.get(row.id)!;
      return {
        episodeId: row.id,
        runId: row.run_id,
        taskId: row.task_id,
        taskKey: row.task_id ? (taskKeyById.get(row.task_id) ?? null) : null,
        runKind: row.run_kind ?? 'build',
        outcome: row.outcome ?? 'done',
        landingOutcome: (row.landing_outcome as EpisodeLandingOutcome) ?? 'pending',
        filesTouched: body.filesTouched ?? [],
        failures: body.failures ?? [],
        findings: body.findings ?? [],
        approachSummary: body.selfSummary?.approachSummary || null,
        unresolvedQuestions: body.selfSummary?.unresolvedQuestions ?? [],
        reviewRounds: row.review_rounds,
        costUSD: row.cost_usd,
        tokenUsage: body.tokenUsage ?? {},
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        stage: prov.stage,
        score: prov.score,
        edgePath: prov.edgePath,
      };
    });

    const warnings = duplicateWarnings(candidates, signals, { limit });
    // The summary always covers EXACTLY the episodes the warnings above it cite — never a
    // silently broader "everything considered" set (memory/similar-effort.ts's own contract).
    const warnedIds = new Set(warnings.map((w) => w.episodeId));
    const summary = summarizeEffort(candidates.filter((c) => warnedIds.has(c.episodeId)));
    return { warnings, summary, consideredCount: candidates.length };
  }

  // ---------------------------------------------------------------------------
  // Named graph-query primitives (PLNR-258) — dependency neighborhoods, validating tests,
  // implementing work, decision lineage, and change impact. Each executes bounded traversals
  // over this project's own SQLite (never the embedder/Vectorize — §20/task acceptance: these
  // are pure graph facts) and hands the raw rows to memory/graph-queries.ts to shape into
  // addressable entities with an honest completeness marker. Read-only, same as PLNR-257.
  // ---------------------------------------------------------------------------

  private edgeCoverageInputs(seed: { nodeId: string } | null, edgeTypes: string[], truncated: boolean): {
    codeGraphPopulated: boolean; edgeTypesWithNoWriter: string[]; truncated: boolean; seedMissing: boolean;
  } {
    return {
      codeGraphPopulated: this.isCodeGraphPopulated(),
      edgeTypesWithNoWriter: this.edgeTypesWithNoWriter(edgeTypes),
      truncated,
      seedMissing: !seed,
    };
  }

  /** A file/symbol/schema-entity's upstream/downstream neighborhood via depends_on/imports/
   *  calls (default) — bounded by the SAME depth/row constants PLNR-257's retrieval uses. */
  async dependencyNeighborhood(
    projectId: string,
    input: { entityUri: string; edgeTypes?: string[]; maxDepth?: number; maxResults?: number },
  ): Promise<DependencyNeighborhoodResult> {
    await this.assertProjectId(projectId);
    const edgeTypes = input.edgeTypes?.length ? input.edgeTypes : ['depends_on', 'imports', 'calls'];
    const seed = this.resolveNodeByUri(input.entityUri);
    const seedIds = seed ? [seed.nodeId] : [];
    const down = this.rawTraverseGraph(seedIds, { edgeTypes, maxDepth: input.maxDepth, maxResults: input.maxResults, direction: 'downstream' });
    const up = this.rawTraverseGraph(seedIds, { edgeTypes, maxDepth: input.maxDepth, maxResults: input.maxResults, direction: 'upstream' });
    return dependencyNeighborhood(seed, down.rows, up.rows, this.edgeCoverageInputs(seed, edgeTypes, down.truncated || up.truncated));
  }

  /** Tests connected to an entity via tests/validated_by (either direction — no writer has
   *  established a convention yet, see graph-queries.ts's module comment). */
  async validatingTests(
    projectId: string,
    input: { entityUri: string; maxDepth?: number; maxResults?: number },
  ): Promise<ValidatingTestsResult> {
    await this.assertProjectId(projectId);
    const edgeTypes = ['tests', 'validated_by'];
    const seed = this.resolveNodeByUri(input.entityUri);
    const seedIds = seed ? [seed.nodeId] : [];
    const fwd = this.rawTraverseGraph(seedIds, { edgeTypes, maxDepth: input.maxDepth, maxResults: input.maxResults, direction: 'downstream' });
    const bwd = this.rawTraverseGraph(seedIds, { edgeTypes, maxDepth: input.maxDepth, maxResults: input.maxResults, direction: 'upstream' });
    return validatingTests(seed, fwd.rows, bwd.rows, this.edgeCoverageInputs(seed, edgeTypes, fwd.truncated || bwd.truncated));
  }

  /** Tasks implementing an entity (requirement, decision, procedure, …) via `implements`,
   *  either direction merged. */
  async implementingWork(
    projectId: string,
    input: { entityUri: string; maxDepth?: number; maxResults?: number },
  ): Promise<ImplementingWorkResult> {
    await this.assertProjectId(projectId);
    const edgeTypes = ['implements'];
    const seed = this.resolveNodeByUri(input.entityUri);
    const seedIds = seed ? [seed.nodeId] : [];
    const fwd = this.rawTraverseGraph(seedIds, { edgeTypes, maxDepth: input.maxDepth, maxResults: input.maxResults, direction: 'downstream' });
    const bwd = this.rawTraverseGraph(seedIds, { edgeTypes, maxDepth: input.maxDepth, maxResults: input.maxResults, direction: 'upstream' });
    return implementingWork(seed, fwd.rows, bwd.rows, this.edgeCoverageInputs(seed, edgeTypes, fwd.truncated || bwd.truncated));
  }

  /** A decision's implementing tasks, the code entities those tasks touch (`implements` then
   *  `modifies` — composing existing edges rather than inventing an "affects" one), and any
   *  decision that supersedes it. `decisionUri` is `noriq://decision/<memoryItemId>` (§18) —
   *  its backing memory's evidence rides the answer per §1's contract. */
  async decisionLineage(
    projectId: string,
    input: { decisionUri: string; maxDepth?: number; maxResults?: number },
  ): Promise<DecisionLineageResult> {
    await this.assertProjectId(projectId);
    const implementsTypes = ['implements'];
    const supersedesTypes = ['supersedes'];
    const seed = this.resolveNodeByUri(input.decisionUri);
    const seedIds = seed ? [seed.nodeId] : [];

    const implFwd = this.rawTraverseGraph(seedIds, { edgeTypes: implementsTypes, maxDepth: 1, maxResults: input.maxResults, direction: 'downstream' });
    const implBwd = this.rawTraverseGraph(seedIds, { edgeTypes: implementsTypes, maxDepth: 1, maxResults: input.maxResults, direction: 'upstream' });
    const implementingTaskIds = [...new Set([...implFwd.rows, ...implBwd.rows].map((r) => r.nodeId))];
    const affected = this.rawTraverseGraph(implementingTaskIds, { edgeTypes: ['modifies'], maxDepth: 1, maxResults: input.maxResults, direction: 'downstream' });

    const superFwd = this.rawTraverseGraph(seedIds, { edgeTypes: supersedesTypes, maxDepth: input.maxDepth, maxResults: input.maxResults, direction: 'downstream' });
    const superBwd = this.rawTraverseGraph(seedIds, { edgeTypes: supersedesTypes, maxDepth: input.maxDepth, maxResults: input.maxResults, direction: 'upstream' });

    // §18: a decision node's uri IS noriq://decision/<memoryItemId> — the backing memory's
    // evidence rides the graph claim, same contract PLNR-257's retrieval results carry.
    let evidence: DecisionLineageResult['evidence'] = [];
    const decisionIdMatch = /^noriq:\/\/decision\/(.+)$/.exec(input.decisionUri);
    if (decisionIdMatch) {
      const backing = await this.getMemoryItem(projectId, decisionIdMatch[1]!);
      if (backing) evidence = backing.evidence.map((e) => ({ repositoryKey: e.repositoryKey, branch: e.branch, baseId: e.baseId, path: e.path, verificationState: e.verificationState }));
    }

    const truncated = implFwd.truncated || implBwd.truncated || affected.truncated || superFwd.truncated || superBwd.truncated;
    return decisionLineage(
      seed,
      implFwd.rows,
      implBwd.rows,
      affected.rows,
      superFwd.rows,
      superBwd.rows,
      evidence,
      this.edgeCoverageInputs(seed, [...implementsTypes, 'modifies', ...supersedesTypes], truncated),
    );
  }

  /** Impacted tests for a proposed set of changed entities (by stable URI) — an unresolved URI
   *  (no matching node, e.g. a file never indexed) becomes an UNCERTAIN edge, never a silent
   *  "no impact". */
  async changeImpact(
    projectId: string,
    input: { entityUris: string[]; maxDepth?: number; maxResults?: number },
  ): Promise<ChangeImpactResult> {
    await this.assertProjectId(projectId);
    const edgeTypes = ['tests', 'validated_by'];
    const resolved: GraphEntityRef[] = [];
    const unresolved: string[] = [];
    for (const uri of input.entityUris) {
      const node = this.resolveNodeByUri(uri);
      if (node) resolved.push(node);
      else unresolved.push(uri);
    }
    const seedIds = resolved.map((r) => r.nodeId);
    const fwd = this.rawTraverseGraph(seedIds, { edgeTypes, maxDepth: input.maxDepth, maxResults: input.maxResults, direction: 'downstream' });
    const bwd = this.rawTraverseGraph(seedIds, { edgeTypes, maxDepth: input.maxDepth, maxResults: input.maxResults, direction: 'upstream' });
    return changeImpact(resolved, unresolved, fwd.rows, bwd.rows, {
      codeGraphPopulated: this.isCodeGraphPopulated(),
      edgeTypesWithNoWriter: this.edgeTypesWithNoWriter(edgeTypes),
      truncated: fwd.truncated || bwd.truncated,
      seedMissing: resolved.length === 0,
    });
  }

  // ---------------------------------------------------------------------------
  // Proposed-decision approval and authority promotion (PLNR-253)
  //
  // Neither path ever mutates an existing memory_items row's authority in place — that column,
  // once written by recordMemory, never changes again. A promotion instead creates a NEW row
  // (authority 5 for human approval, 4 for merge evidence) linked back via
  // supersedes_memory_id — the SAME versioning mechanism PLNR-251 uses for a plain correction —
  // and records one immutable memory_authority_transitions row as the durable "who/when/why".
  // Authority 5 is reachable ONLY from approveDecision, which only userAuth REST calls (never an
  // MCP tool); nothing here trusts a caller-supplied authority value.
  // ---------------------------------------------------------------------------

  /** Every kind='decision' memory still awaiting a human's accept/reject — the human governance
   *  queue. Visible, but (being authority <= 2, per recordMemory's agent clamp) never
   *  authoritative until acted on. */
  async listProposedDecisions(projectId: string): Promise<
    Array<{ id: string; statement: string; authority: number; recordedByAgentId: string | null; recordedAt: string; proposedAt: string }>
  > {
    await this.assertProjectId(projectId);
    return this.ctx.storage.sql
      .exec<{
        id: string;
        statement: string;
        authority: number;
        recorded_by_agent_id: string | null;
        recorded_at: string;
        proposed_at: string;
      }>(
        `SELECT id, statement, authority, recorded_by_agent_id, recorded_at, proposed_at
         FROM memory_items WHERE kind = 'decision' AND proposed_at IS NOT NULL ORDER BY proposed_at`,
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        statement: r.statement,
        authority: r.authority,
        recordedByAgentId: r.recorded_by_agent_id,
        recordedAt: r.recorded_at,
        proposedAt: r.proposed_at,
      }));
  }

  private loadMemoryRow(memoryId: string): { id: string; kind: string; proposed_at: string | null; authority: number } | undefined {
    return this.ctx.storage.sql
      .exec<{ id: string; kind: string; proposed_at: string | null; authority: number }>(
        `SELECT id, kind, proposed_at, authority FROM memory_items WHERE id = ?1`,
        memoryId,
      )
      .toArray()[0];
  }

  /** Copy a memory item's evidence rows onto a NEW memory item id — used by both promotion
   *  paths so the superseding version carries the same citations as the one it replaces,
   *  rather than reading as unevidenced. */
  private copyEvidence(fromMemoryId: string, toMemoryId: string, now: string): void {
    const rows = this.ctx.storage.sql
      .exec<{ repository_key: string; branch: string; base_id: string; path: string; symbol: string | null; content_hash: string | null; evidence_hash: string | null; verification_state: string }>(
        `SELECT repository_key, branch, base_id, path, symbol, content_hash, evidence_hash, verification_state FROM evidence WHERE memory_item_id = ?1`,
        fromMemoryId,
      )
      .toArray();
    for (const r of rows) {
      this.ctx.storage.sql.exec(
        `INSERT INTO evidence (id, memory_item_id, repository_key, branch, base_id, path, symbol, content_hash, evidence_hash, verification_state, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
        newId('ev'),
        toMemoryId,
        r.repository_key,
        r.branch,
        r.base_id,
        r.path,
        r.symbol,
        r.content_hash,
        r.evidence_hash,
        r.verification_state,
        now,
      );
    }
  }

  /** Human-only (userAuth REST calls this; no MCP tool ever does) approval of a proposed
   *  decision — the ONLY path to authority 5 (§12). Creates a new authority-5 version
   *  superseding the proposed one, an immutable transition record, and clears proposed_at on
   *  the original (which itself is never otherwise touched — its authority column stays
   *  whatever it was recorded at). */
  async approveDecision(
    projectId: string,
    input: { memoryItemId: string; actorUserId: string; note?: string | null; revision?: string | null },
  ): Promise<{ approvedMemoryId: string; transitionId: string }> {
    await this.assertProjectId(projectId);
    const row = this.loadMemoryRow(input.memoryItemId);
    if (!row) throw new Error(`memory item ${input.memoryItemId} not found`);
    if (row.kind !== 'decision') throw new Error(`memory item ${input.memoryItemId} is not a decision`);
    if (!row.proposed_at) throw new Error(`memory item ${input.memoryItemId} is not a pending proposed decision`);

    const original = await this.getMemoryItem(projectId, input.memoryItemId);
    if (!original) throw new Error(`memory item ${input.memoryItemId} not found`);
    const approvedMemoryId = newId('mem');
    const transitionId = newId('atr');
    const operationId = newId('op');
    const now = nowIso();
    this.ctx.storage.transactionSync(() => {
      if (this._forceWriteFailure) throw new Error('injected write failure (test)');
      this.ctx.storage.sql.exec(
        `INSERT INTO memory_items
           (id, kind, statement, authority, confidence, content_hash, repository_key, branch, base_id, supersedes_memory_id, recorded_by_agent_id, recorded_at)
         VALUES (?1,'decision',?2,?3,?4,?5,?6,?7,?8,?9,NULL,?10)`,
        approvedMemoryId,
        original.statement,
        AUTHORITY_HUMAN_APPROVED,
        original.confidence,
        original.contentHash,
        original.repositoryKey,
        original.branch,
        original.baseId,
        input.memoryItemId,
        now,
      );
      this.copyEvidence(input.memoryItemId, approvedMemoryId, now);
      this.ctx.storage.sql.exec(`UPDATE memory_items SET proposed_at = NULL WHERE id = ?1`, input.memoryItemId);
      this.ctx.storage.sql.exec(
        `INSERT INTO memory_authority_transitions (id, memory_item_id, resulting_memory_id, outcome, new_authority, actor_kind, actor_id, revision, note, created_at)
         VALUES (?1,?2,?3,'approved',?4,'human',?5,?6,?7,?8)`,
        transitionId,
        input.memoryItemId,
        approvedMemoryId,
        AUTHORITY_HUMAN_APPROVED,
        input.actorUserId,
        input.revision ?? null,
        input.note ?? null,
        now,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO outbox (id, operation_id, verb, subject_type, subject_id, payload, created_at) VALUES (?1,?2,'memory.changed','memory',?3,?4,?5)`,
        newId('obx'),
        operationId,
        transitionId,
        JSON.stringify({ operationId, entityType: 'authority_transition', outcome: 'approved', memoryItemId: input.memoryItemId, resultingMemoryId: approvedMemoryId, actorKind: 'human', actorId: input.actorUserId }),
        now,
      );
      this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = value + 1 WHERE id = 0`);
      this.ctx.storage.sql.exec(
        `INSERT INTO applied_operations (operation_id, applied_at, subject_type, subject_id, result) VALUES (?1,?2,'authority_transition',?3,?4)`,
        operationId,
        now,
        transitionId,
        JSON.stringify({ approvedMemoryId, transitionId }),
      );
    });
    this.ctx.storage.setAlarm(Date.now()).catch(() => {});
    // PLNR-255: index the new authority-5 version, de-index the proposed one it supersedes.
    const searchBackendForIndex = searchBackend(this.env);
    if (searchBackendForIndex) {
      void indexEntity(searchBackendForIndex, { kind: 'memory', id: approvedMemoryId, projectId, title: original.kind, body: original.statement })
        .then(() => removeEntity(searchBackendForIndex, 'memory', input.memoryItemId))
        .catch((err) => console.warn(`ProjectMemory memory-index for ${approvedMemoryId} failed: ${String(err)}`));
    }
    return { approvedMemoryId, transitionId };
  }

  /** Human-only rejection of a proposed decision. No new version, no authority change — the
   *  original row is left exactly as recorded, `proposed_at` is cleared, and `rejected_at` is
   *  set so the decision remains historically visible as rejected rather than reading like it
   *  is still awaiting review. */
  async rejectDecision(
    projectId: string,
    input: { memoryItemId: string; actorUserId: string; note?: string | null },
  ): Promise<{ ok: true; transitionId: string }> {
    await this.assertProjectId(projectId);
    const row = this.loadMemoryRow(input.memoryItemId);
    if (!row) throw new Error(`memory item ${input.memoryItemId} not found`);
    if (row.kind !== 'decision') throw new Error(`memory item ${input.memoryItemId} is not a decision`);
    if (!row.proposed_at) throw new Error(`memory item ${input.memoryItemId} is not a pending proposed decision`);

    const transitionId = newId('atr');
    const operationId = newId('op');
    const now = nowIso();
    this.ctx.storage.transactionSync(() => {
      if (this._forceWriteFailure) throw new Error('injected write failure (test)');
      this.ctx.storage.sql.exec(`UPDATE memory_items SET proposed_at = NULL, rejected_at = ?2 WHERE id = ?1`, input.memoryItemId, now);
      this.ctx.storage.sql.exec(
        `INSERT INTO memory_authority_transitions (id, memory_item_id, resulting_memory_id, outcome, new_authority, actor_kind, actor_id, revision, note, created_at)
         VALUES (?1,?2,NULL,'rejected',NULL,'human',?3,NULL,?4,?5)`,
        transitionId,
        input.memoryItemId,
        input.actorUserId,
        input.note ?? null,
        now,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO outbox (id, operation_id, verb, subject_type, subject_id, payload, created_at) VALUES (?1,?2,'memory.changed','memory',?3,?4,?5)`,
        newId('obx'),
        operationId,
        transitionId,
        JSON.stringify({ operationId, entityType: 'authority_transition', outcome: 'rejected', memoryItemId: input.memoryItemId, actorKind: 'human', actorId: input.actorUserId }),
        now,
      );
      this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = value + 1 WHERE id = 0`);
      this.ctx.storage.sql.exec(
        `INSERT INTO applied_operations (operation_id, applied_at, subject_type, subject_id, result) VALUES (?1,?2,'authority_transition',?3,?4)`,
        operationId,
        now,
        transitionId,
        JSON.stringify({ transitionId }),
      );
    });
    this.ctx.storage.setAlarm(Date.now()).catch(() => {});
    return { ok: true, transitionId };
  }

  /**
   * GitHub-merge-evidence promotion (§12): every memory below authority 4 whose evidence is
   * ENTIRELY within the given repository/branch is promoted to a new authority-4 version citing
   * the merged revision. A memory with no evidence, or evidence citing any OTHER
   * repository/branch, is left untouched — a merge is not blanket proof for claims it does not
   * actually back. This is the "cheap server-side check" the task allows for now; the thorough
   * worktree-tier re-verification is PLNR-265's.
   */
  async promoteMemoriesOnMerge(
    projectId: string,
    input: { repositoryKey: string; branch: string; mergedBaseId: string },
  ): Promise<{ promoted: string[]; skipped: number }> {
    await this.assertProjectId(projectId);
    const candidates = this.ctx.storage.sql
      .exec<{ id: string }>(`SELECT id FROM memory_items WHERE authority < ?1`, AUTHORITY_VERIFIED_MERGED)
      .toArray();
    const searchBackendForIndex = searchBackend(this.env);
    const promoted: string[] = [];
    let skipped = 0;
    for (const { id } of candidates) {
      const evidenceRows = this.ctx.storage.sql
        .exec<{ repository_key: string; branch: string }>(`SELECT repository_key, branch FROM evidence WHERE memory_item_id = ?1`, id)
        .toArray();
      const verified = evidenceRows.length > 0 && evidenceRows.every((e) => e.repository_key === input.repositoryKey && e.branch === input.branch);
      if (!verified) {
        skipped++;
        continue;
      }
      const original = await this.getMemoryItem(projectId, id);
      if (!original) {
        skipped++;
        continue;
      }
      const promotedId = newId('mem');
      const transitionId = newId('atr');
      const operationId = newId('op');
      const now = nowIso();
      this.ctx.storage.transactionSync(() => {
        if (this._forceWriteFailure) throw new Error('injected write failure (test)');
        this.ctx.storage.sql.exec(
          `INSERT INTO memory_items
             (id, kind, statement, authority, confidence, content_hash, repository_key, branch, base_id, supersedes_memory_id, recorded_by_agent_id, recorded_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,NULL,?11)`,
          promotedId,
          original.kind,
          original.statement,
          AUTHORITY_VERIFIED_MERGED,
          original.confidence,
          original.contentHash,
          original.repositoryKey,
          original.branch,
          original.baseId,
          id,
          now,
        );
        this.copyEvidence(id, promotedId, now);
        this.ctx.storage.sql.exec(
          `INSERT INTO memory_authority_transitions (id, memory_item_id, resulting_memory_id, outcome, new_authority, actor_kind, actor_id, revision, note, created_at)
           VALUES (?1,?2,?3,'merge_promoted',?4,'system',NULL,?5,NULL,?6)`,
          transitionId,
          id,
          promotedId,
          AUTHORITY_VERIFIED_MERGED,
          input.mergedBaseId,
          now,
        );
        this.ctx.storage.sql.exec(
          `INSERT INTO outbox (id, operation_id, verb, subject_type, subject_id, payload, created_at) VALUES (?1,?2,'memory.changed','memory',?3,?4,?5)`,
          newId('obx'),
          operationId,
          transitionId,
          JSON.stringify({ operationId, entityType: 'authority_transition', outcome: 'merge_promoted', memoryItemId: id, resultingMemoryId: promotedId, actorKind: 'system', actorId: null, revision: input.mergedBaseId }),
          now,
        );
        this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = value + 1 WHERE id = 0`);
        this.ctx.storage.sql.exec(
          `INSERT INTO applied_operations (operation_id, applied_at, subject_type, subject_id, result) VALUES (?1,?2,'authority_transition',?3,?4)`,
          operationId,
          now,
          transitionId,
          JSON.stringify({ promotedId, transitionId }),
        );
      });
      // PLNR-255: index the new authority-4 version, de-index the one it supersedes.
      if (searchBackendForIndex) {
        void indexEntity(searchBackendForIndex, { kind: 'memory', id: promotedId, projectId, title: original.kind, body: original.statement })
          .then(() => removeEntity(searchBackendForIndex, 'memory', id))
          .catch((err) => console.warn(`ProjectMemory memory-index for ${promotedId} failed: ${String(err)}`));
      }
      promoted.push(promotedId);
    }
    if (promoted.length > 0) this.ctx.storage.setAlarm(Date.now()).catch(() => {});
    return { promoted, skipped };
  }

  /**
   * Deliver every undelivered outbox row to ProjectRoom, oldest first. At-least-once and
   * idempotent to retry: ProjectRoom's `memory_event_dedup` recognizes an already-applied
   * operation id and acknowledges it without a second event, so calling this again after a
   * partial run (or a full success) is always safe. A delivery failure stops that row from
   * being marked delivered and this simply returns — the row is retried on the next drain.
   */
  async drainOutbox(projectId: string): Promise<{ delivered: number; failed: number }> {
    await this.assertProjectId(projectId);
    const pending = this.ctx.storage.sql
      .exec<{ id: string; operation_id: string; verb: string; subject_type: string; subject_id: string; payload: string }>(
        `SELECT id, operation_id, verb, subject_type, subject_id, payload FROM outbox
         WHERE delivered_at IS NULL ORDER BY created_at ASC`,
      )
      .toArray();
    let delivered = 0;
    let failed = 0;
    for (const row of pending) {
      try {
        if (this._forceDeliveryFailure) throw new Error('injected delivery failure (test)');
        await this.env.PROJECT_ROOM.get(this.env.PROJECT_ROOM.idFromName(projectId)).receiveMemoryEvent(projectId, {
          operationId: row.operation_id,
          verb: row.verb,
          subjectType: row.subject_type,
          subjectId: row.subject_id,
          payload: JSON.parse(row.payload) as Record<string, unknown>,
        });
        this.ctx.storage.sql.exec(`UPDATE outbox SET delivered_at = ?1 WHERE id = ?2`, nowIso(), row.id);
        delivered++;
      } catch (err) {
        failed++;
        console.warn(`ProjectMemory outbox delivery failed for ${projectId}/${row.operation_id}: ${String(err)}`);
      }
    }
    return { delivered, failed };
  }

  private readProjectorCursor(): number {
    const row = this.ctx.storage.sql.exec<{ global_seq: number }>(`SELECT global_seq FROM projector_cursor WHERE id = 0`).toArray()[0];
    return row?.global_seq ?? 0;
  }

  /**
   * A deliberately minimal projection: today only `task.created` creates a graph node (type
   * 'task', a stable entity URI). Every other coordination verb is acknowledged (the cursor
   * still advances past it) with no projection write — the full projection matrix grows with
   * Phases 3-6. `ON CONFLICT DO NOTHING` on the URI makes a re-applied event a no-op rather
   * than a duplicate node, which matters because the cursor advance and this write commit in
   * the SAME transaction — replaying a range this already consumed must stay side-effect-free.
   */
  private applyCoordinationEvent(ev: ProjectedEvent): void {
    if (ev.verb === 'task.created') {
      const uri = buildEntityUri({ kind: 'task', id: ev.subjectId });
      const label = typeof ev.payload.title === 'string' ? ev.payload.title : ev.subjectId;
      this.ctx.storage.sql.exec(
        `INSERT INTO nodes (id, type, uri, label, created_at) VALUES (?1, 'task', ?2, ?3, ?4)
         ON CONFLICT (uri) DO NOTHING`,
        newId('node'),
        uri,
        label,
        ev.createdAt,
      );
    }
  }

  /**
   * Project this project's D1 coordination events past the durable `global_seq` cursor into
   * the graph, one event at a time — each projection write and its cursor advance commit in
   * ONE SQLite transaction, so a crash between them is impossible by construction, and
   * re-running over an already-consumed range applies nothing new (the cursor predicate and
   * the projection's own idempotent write both guarantee it).
   */
  async runProjector(projectId: string): Promise<{ applied: number; cursor: number }> {
    await this.assertProjectId(projectId);
    const events = await projectCoordinationEvents(this.env, projectId, this.readProjectorCursor());
    for (const ev of events) {
      this.ctx.storage.transactionSync(() => {
        this.applyCoordinationEvent(ev);
        this.ctx.storage.sql.exec(`UPDATE projector_cursor SET global_seq = ?1 WHERE id = 0`, ev.globalSeq);
      });
    }
    return { applied: events.length, cursor: this.readProjectorCursor() };
  }

  /** The explicit reconciliation entry point (§19/§20 — no Queues/Workflows binding exists in
   *  this repo, so this plus the alarm below are the whole delivery mechanism): drains any
   *  outbox backlog, then catches this project's memory up on any coordination events it
   *  missed. Safe to call any time, from anywhere — both halves are independently idempotent. */
  async reconcile(projectId: string): Promise<{ delivered: number; failed: number; applied: number; cursor: number }> {
    const drain = await this.drainOutbox(projectId);
    const project = await this.runProjector(projectId);
    return { ...drain, ...project };
  }

  override async alarm(): Promise<void> {
    const pid = this._pid ?? (await this.ctx.storage.get<string>('pid'));
    if (!pid) return;
    await this.drainOutbox(pid).catch((err) => console.warn(`ProjectMemory alarm drain failed: ${String(err)}`));
  }

  async _countNodes(projectId: string): Promise<number> {
    await this.assertProjectId(projectId);
    return this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM nodes`).toArray()[0]?.n ?? 0;
  }

  /** Test-only: a table's stored CREATE TABLE text. Exists so a restore test can assert the
   *  live SCHEMA is unchanged, not just the row counts — the original rename-based activation
   *  corrupted FK clauses and quoted table names while leaving every count correct. */
  async _tableDdl(projectId: string, table: string): Promise<string> {
    await this.assertProjectId(projectId);
    return (
      this.ctx.storage.sql
        .exec<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1`, table)
        .toArray()[0]?.sql ?? '(no such table)'
    );
  }

  /** Test-only: a staged (never activated) index generation with a caller-chosen created_at,
   *  so PLNR-250's staged-generation pruning can be tested without waiting out its real max
   *  age. Seeds the repository row too if it doesn't already exist (the FK target). */
  async _seedStagedIndexGeneration(projectId: string, repositoryKey: string, createdAt: string): Promise<string> {
    await this.assertProjectId(projectId);
    const id = newId('gen');
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO repositories (repository_key, created_at) VALUES (?1, ?2) ON CONFLICT (repository_key) DO NOTHING`,
        repositoryKey,
        createdAt,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO index_generations (id, repository_key, branch, base_id, indexer_version, batch_count, file_count, content_hash, status, created_at)
         VALUES (?1, ?2, 'main', 'deadbeef', 'test', 1, 1, 'sha256:test', 'staged', ?3)`,
        id,
        repositoryKey,
        createdAt,
      );
    });
    return id;
  }

  async _countIndexGenerations(projectId: string): Promise<number> {
    await this.assertProjectId(projectId);
    return this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM index_generations`).toArray()[0]?.n ?? 0;
  }

  /** Test-only: a 'superseded' index generation with a caller-chosen `activatedAt`, so
   *  PLNR-256's `pruneSupersededGenerations` can be tested without waiting out its real max
   *  age — same reason as `_seedStagedIndexGeneration`. */
  async _seedSupersededIndexGenerationForTest(projectId: string, repositoryKey: string, activatedAt: string): Promise<string> {
    await this.assertProjectId(projectId);
    const id = newId('gen');
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO repositories (repository_key, created_at) VALUES (?1, ?2) ON CONFLICT (repository_key) DO NOTHING`,
        repositoryKey,
        activatedAt,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO index_generations (id, repository_key, branch, base_id, indexer_version, batch_count, file_count, content_hash, status, created_at, activated_at)
         VALUES (?1, ?2, 'main', 'deadbeef', 'test', 1, 1, 'sha256:test', 'superseded', ?3, ?3)`,
        id,
        repositoryKey,
        activatedAt,
      );
    });
    return id;
  }

  /** Test-only: this generation's current status — so PLNR-256's activation tests can assert
   *  the transition (active → superseded, new → active) without a wider query surface. */
  async _getIndexGenerationStatusForTest(projectId: string, generationId: string): Promise<string | null> {
    await this.assertProjectId(projectId);
    return (
      this.ctx.storage.sql.exec<{ status: string }>(`SELECT status FROM index_generations WHERE id = ?1`, generationId).toArray()[0]?.status ?? null
    );
  }

  /** Test-only: overwrite a `_meta` value directly — used to backdate
   *  `prior_generation_created_at` so retained-generation pruning can be tested without waiting
   *  out its real rollback window. Deliberately narrow (one table, key/value only), not a
   *  general query surface. */
  async _setMetaForTest(projectId: string, key: string, value: string): Promise<void> {
    await this.assertProjectId(projectId);
    this.ctx.storage.sql.exec(`UPDATE _meta SET value = ?1 WHERE key = ?2`, value, key);
  }

  /** Test-only: backdate a memory item's `recorded_at` — so decay-age eligibility (PLNR-254)
   *  can be tested without waiting out the real retention window. Same reason as
   *  `_setMetaForTest`/`_seedStagedIndexGeneration`'s custom `createdAt`. */
  async _setMemoryRecordedAtForTest(projectId: string, memoryId: string, recordedAt: string): Promise<void> {
    await this.assertProjectId(projectId);
    this.ctx.storage.sql.exec(`UPDATE memory_items SET recorded_at = ?1 WHERE id = ?2`, recordedAt, memoryId);
  }

}
