import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { newId, nowIso } from '../lib/util';
import { buildEntityUri, type MemoryBackupManifest } from '@noriq-dev/shared';
import { projectCoordinationEvents, type ProjectedEvent } from '../lib/memory-projector';
import { exportMemorySnapshot } from '../memory/backup';
import { fetchManifest, readSnapshotChunks, checkManifestHeader } from '../memory/restore';
import { deleteAllProjectBackups, sizeStatus, type EraseReport, type EraseStepResult } from '../memory/lifecycle';
import { MEMORY_MIGRATIONS } from '../../memory-migrations';

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
 * PLNR-247 adds the outbox<->coordination bridge: a canonical mutation writes
 * its outbox row in the SAME SQLite transaction (`_mutate`, a deliberately
 * minimal stand-in for PLNR-251's real write APIs); `drainOutbox` delivers
 * pending rows to ProjectRoom (idempotent — retrying is safe, the receiver
 * dedupes); `runProjector` reads D1 coordination events past this project's
 * durable `global_seq` cursor and projects a minimal set of them into the
 * graph, advancing the cursor atomically with each projection write. No
 * Queues/Workflows binding exists in this repo (env.ts declares none), so a
 * DO alarm plus the explicit `reconcile` RPC are the whole delivery mechanism
 * — correctness rests on the durable cursor and outbox replay alone, never on
 * a wakeup actually arriving.
 *
 * The real memory/evidence/graph write APIs are PLNR-251 onward. The tables
 * below exist so those tasks have somewhere to write.
 */

// This DO's internal SQLite schema lives in apps/api/memory-migrations — real `.sql` files, one
// per version, assembled into an ordered manifest by that directory's index.ts. Adding a
// migration is a new file plus one manifest entry; the rules (never edit a shipped migration;
// stay additive) are documented there. Note it is a SIBLING of apps/api/migrations, which is
// D1's and is applied by the wrangler CLI — the two must never be mixed.

export interface ProjectMemoryHealth {
  projectId: string;
  schemaVersion: number;
  memoryRevision: number;
  tableCounts: Record<string, number>;
  databaseSize: number;
  sizeStatus: 'ok' | 'warn' | 'critical';
}

export const SCHEMA_TABLES = [
  'repositories',
  'index_generations',
  'nodes',
  'edges',
  'memory_items',
  'evidence',
  'feedback',
  'contradictions',
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
      this.ctx.storage.sql.exec(`DELETE FROM index_generations WHERE status = 'staged' AND created_at < ?1`, cutoff);
    });
    return abandoned.length;
  }

  private async reportVectorDirty(projectId: string, dirty: boolean): Promise<void> {
    await this.env.PROJECT_ROOM.get(this.env.PROJECT_ROOM.idFromName(projectId))
      .setMemoryVectorDirty(projectId, dirty)
      .catch((err) => console.warn(`ProjectMemory vector-dirty report for ${projectId} failed: ${String(err)}`));
  }

  /** The rebuild hook Phase 4 (PLNR-256) fills in. No memory Vectorize index exists yet, so
   *  this is an honest no-op regardless of whether VECTORIZE is bound — it does NOT clear the
   *  dirty flag, because there is nothing yet that actually rebuilds anything from it. */
  async rebuildVectorIndex(projectId: string): Promise<{ ok: true; rebuilt: false; reason: string }> {
    await this.assertProjectId(projectId);
    const reason = this.env.VECTORIZE
      ? 'VECTORIZE is bound, but no memory vector index exists yet (Phase 4) — nothing to rebuild'
      : 'VECTORIZE is not bound — nothing to rebuild';
    console.log(`ProjectMemory rebuildVectorIndex(${projectId}): ${reason}`);
    return { ok: true, rebuilt: false, reason };
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
    steps.push({ step: 'ingest-capabilities', ok: true, detail: 'no ingest capabilities exist yet (Phase 5) — nothing to revoke' });

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

  /**
   * A deliberately minimal stand-in for PLNR-251's real write APIs — just
   * enough of a canonical mutation to exercise the outbox. Writes the outbox
   * row in the SAME SQLite transaction as the (trivial) mutation it represents
   * and bumps `memory_revision`, exactly as any future real write must.
   */
  async _mutate(
    projectId: string,
    verb: string,
    subjectType: string,
    subjectId: string,
    summary: Record<string, unknown> = {},
  ): Promise<{ operationId: string }> {
    await this.assertProjectId(projectId);
    const operationId = newId('op');
    const now = nowIso();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO outbox (id, operation_id, verb, subject_type, subject_id, payload, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        newId('obx'),
        operationId,
        verb,
        subjectType,
        subjectId,
        JSON.stringify({ operationId, ...summary }),
        now,
      );
      this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = value + 1 WHERE id = 0`);
    });
    // Best-effort nudge — never awaited, never load-bearing: `reconcile`/`drainOutbox` are
    // the correctness path if this alarm is lost or the isolate recycles before it fires.
    this.ctx.storage.setAlarm(Date.now()).catch(() => {});
    return { operationId };
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

  /**
   * Test/seed-only helper: insert a bare-minimum graph node under this
   * project's store. Exists so PLNR-245's migrator-repeatability test can
   * prove seeded data survives across a re-migration without reaching into
   * the DO's private SQL surface from outside. The real write surface
   * (memory items, evidence, versioning) is PLNR-251 — this is deliberately
   * not that.
   */
  async _seedNode(projectId: string, uri: string, label: string): Promise<string> {
    await this.assertProjectId(projectId);
    const id = newId('node');
    this.ctx.storage.sql.exec(
      `INSERT INTO nodes (id, type, uri, label, created_at) VALUES (?1, 'unknown', ?2, ?3, ?4)`,
      id,
      uri,
      label,
      nowIso(),
    );
    return id;
  }

  async _countNodes(projectId: string): Promise<number> {
    await this.assertProjectId(projectId);
    return this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM nodes`).toArray()[0]?.n ?? 0;
  }

  /** Test/seed-only: a typed edge between two already-seeded nodes (PLNR-249's restore
   *  round-trip needs graph data beyond bare nodes). Not the real write surface — PLNR-251. */
  async _seedEdge(projectId: string, type: string, fromNodeId: string, toNodeId: string): Promise<string> {
    await this.assertProjectId(projectId);
    const id = newId('edge');
    this.ctx.storage.sql.exec(
      `INSERT INTO edges (id, type, from_node_id, to_node_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
      id,
      type,
      fromNodeId,
      toNodeId,
      nowIso(),
    );
    return id;
  }

  /** Test/seed-only: a bare memory item. See _seedEdge. */
  async _seedMemoryItem(projectId: string, kind: string, statement: string): Promise<string> {
    await this.assertProjectId(projectId);
    const id = newId('mem');
    this.ctx.storage.sql.exec(
      `INSERT INTO memory_items (id, kind, statement, recorded_at) VALUES (?1, ?2, ?3, ?4)`,
      id,
      kind,
      statement,
      nowIso(),
    );
    return id;
  }

  /** Test/seed-only: an evidence row citing an already-seeded memory item. See _seedEdge. */
  async _seedEvidence(projectId: string, memoryItemId: string, repositoryKey: string, branch: string, baseId: string, path: string): Promise<string> {
    await this.assertProjectId(projectId);
    const id = newId('ev');
    this.ctx.storage.sql.exec(
      `INSERT INTO evidence (id, memory_item_id, repository_key, branch, base_id, path, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      id,
      memoryItemId,
      repositoryKey,
      branch,
      baseId,
      path,
      nowIso(),
    );
    return id;
  }

  /** Test-only: one-hop graph traversal from a node, via edges of the given type. Exists so
   *  PLNR-249's restore round-trip can prove a restored graph still answers the SAME traversal
   *  as the pre-restore one, without exposing a general query surface. */
  async _traverseFrom(projectId: string, fromNodeId: string, type: string): Promise<string[]> {
    await this.assertProjectId(projectId);
    return this.ctx.storage.sql
      .exec<{ to_node_id: string }>(`SELECT to_node_id FROM edges WHERE from_node_id = ?1 AND type = ?2 ORDER BY to_node_id`, fromNodeId, type)
      .toArray()
      .map((r) => r.to_node_id);
  }

  /** Test-only: evidence paths cited by one memory item, for the same reason as _traverseFrom. */
  async _evidencePathsFor(projectId: string, memoryItemId: string): Promise<string[]> {
    await this.assertProjectId(projectId);
    return this.ctx.storage.sql
      .exec<{ path: string }>(`SELECT path FROM evidence WHERE memory_item_id = ?1 ORDER BY path`, memoryItemId)
      .toArray()
      .map((r) => r.path);
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

  /** Test-only: overwrite a `_meta` value directly — used to backdate
   *  `prior_generation_created_at` so retained-generation pruning can be tested without waiting
   *  out its real rollback window. Deliberately narrow (one table, key/value only), not a
   *  general query surface. */
  async _setMetaForTest(projectId: string, key: string, value: string): Promise<void> {
    await this.assertProjectId(projectId);
    this.ctx.storage.sql.exec(`UPDATE _meta SET value = ?1 WHERE key = ?2`, value, key);
  }
}
