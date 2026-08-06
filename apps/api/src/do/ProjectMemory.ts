import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { newId, nowIso } from '../lib/util';
import { buildEntityUri, type MemoryBackupManifest } from '@noriq-dev/shared';
import { projectCoordinationEvents, type ProjectedEvent } from '../lib/memory-projector';
import { exportMemorySnapshot } from '../memory/backup';
import { fetchManifest, readSnapshotChunks, checkManifestHeader } from '../memory/restore';

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

/**
 * Ordered, additive migrations, applied once each. Each entry is a list of
 * individual statements (never a single multi-statement string — `exec()` is
 * one statement per call, exactly like the DO's own SQL API expects). NEVER
 * edit an entry once shipped; add a new one, exactly like D1's numbered
 * migration files.
 */
const MIGRATIONS: readonly (readonly string[])[] = [
  // v1 (PLNR-245) — the canonical schema. FK targets are created before their
  // referrers. Column vocabularies (kind/type/authority/verification enums)
  // are the CHECK-constraint mirror of @noriq-dev/shared's memory.ts zod
  // enums, the same convention D1's own migrations already use for status
  // columns — never re-declare them as a second source of truth elsewhere.
  [
    // Real SQLite (not D1), so FK enforcement is ours to turn on — unlike D1,
    // which ignores this pragma outright (CLAUDE.md).
    `PRAGMA foreign_keys = ON`,

    `CREATE TABLE _meta (
       key   TEXT PRIMARY KEY,
       value TEXT NOT NULL
     )`,

    // A monotonic counter bumped by every canonical mutation (PLNR-247+) — what
    // a health check and a backup manifest's memoryRevision report.
    `CREATE TABLE memory_revision (
       id    INTEGER PRIMARY KEY CHECK (id = 0),
       value INTEGER NOT NULL DEFAULT 0
     )`,
    `INSERT INTO memory_revision (id, value) VALUES (0, 0)`,

    // The durable D1-event-log cursor the projector (PLNR-247) advances —
    // events.global_seq, never rowid (reused after deleteProject, PLNR-111)
    // and never the per-project seq (that one's the WS resume cursor).
    `CREATE TABLE projector_cursor (
       id         INTEGER PRIMARY KEY CHECK (id = 0),
       global_seq INTEGER NOT NULL DEFAULT 0
     )`,
    `INSERT INTO projector_cursor (id, global_seq) VALUES (0, 0)`,

    // Idempotency ledger for canonical mutations delivered outward (PLNR-247):
    // a redelivered operation id is recognized and skipped rather than
    // re-applied.
    `CREATE TABLE applied_operations (
       operation_id TEXT PRIMARY KEY,
       applied_at   TEXT NOT NULL
     )`,

    // Compact change events awaiting delivery to ProjectRoom (PLNR-247). No
    // memory body ever rides here — verb + subject + a summary payload only,
    // the same discipline the D1 event log itself already follows.
    `CREATE TABLE outbox (
       id             TEXT PRIMARY KEY,
       operation_id   TEXT NOT NULL,
       verb           TEXT NOT NULL,
       subject_type   TEXT NOT NULL,
       subject_id     TEXT NOT NULL,
       payload        TEXT NOT NULL,
       created_at     TEXT NOT NULL,
       delivered_at   TEXT
     )`,
    `CREATE INDEX idx_outbox_pending ON outbox (created_at) WHERE delivered_at IS NULL`,

    // Repositories this project's memory has ever indexed. The CANONICAL
    // project<->repository association lives in D1 (PLNR-246, §3); this is
    // just the local FK anchor for index generations and evidence.
    `CREATE TABLE repositories (
       repository_key TEXT PRIMARY KEY,
       created_at     TEXT NOT NULL
     )`,

    `CREATE TABLE index_generations (
       id               TEXT PRIMARY KEY,
       repository_key   TEXT NOT NULL REFERENCES repositories(repository_key),
       branch           TEXT NOT NULL,
       base_id          TEXT NOT NULL,
       indexer_version  TEXT NOT NULL,
       batch_count      INTEGER NOT NULL,
       file_count       INTEGER NOT NULL,
       content_hash     TEXT NOT NULL,
       status           TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'active', 'superseded')),
       created_at       TEXT NOT NULL,
       activated_at     TEXT
     )`,
    `CREATE INDEX idx_index_generations_repo ON index_generations (repository_key, status)`,

    // The project knowledge graph (§5). `uri` is the stable entity URI
    // (buildEntityUri, PLNR-244) — durable identity, never a generation or
    // baseId.
    `CREATE TABLE nodes (
       id         TEXT PRIMARY KEY,
       type       TEXT NOT NULL CHECK (type IN (
                    'project', 'repository', 'branch', 'revision', 'file', 'symbol', 'api',
                    'database_entity', 'test', 'task', 'plan', 'run', 'agent', 'decision',
                    'memory', 'error', 'requirement', 'procedure', 'episode', 'artifact', 'unknown'
                  )),
       uri        TEXT NOT NULL UNIQUE,
       label      TEXT NOT NULL,
       created_at TEXT NOT NULL
     )`,
    `CREATE INDEX idx_nodes_type ON nodes (type)`,

    `CREATE TABLE edges (
       id           TEXT PRIMARY KEY,
       type         TEXT NOT NULL CHECK (type IN (
                      'declares', 'calls', 'imports', 'depends_on', 'tests', 'implements', 'modifies',
                      'observed_in', 'decided_by', 'supersedes', 'contradicts', 'blocks', 'related_to',
                      'failed_because', 'validated_by', 'owned_by', 'commonly_changes_with', 'derived_from'
                    )),
       from_node_id TEXT NOT NULL REFERENCES nodes(id),
       to_node_id   TEXT NOT NULL REFERENCES nodes(id),
       created_at   TEXT NOT NULL
     )`,
    `CREATE INDEX idx_edges_from ON edges (from_node_id)`,
    `CREATE INDEX idx_edges_to ON edges (to_node_id)`,

    // The one kind-driven recording surface (§11). `supersedes_memory_id`
    // links a new version back rather than overwriting — history is never
    // destructively erased (§12).
    `CREATE TABLE memory_items (
       id                     TEXT PRIMARY KEY,
       kind                   TEXT NOT NULL CHECK (kind IN (
                                'learning', 'decision', 'failed_approach', 'procedure',
                                'requirement', 'hazard', 'unknown'
                              )),
       statement              TEXT NOT NULL,
       authority              INTEGER NOT NULL DEFAULT 1 CHECK (authority BETWEEN 1 AND 5),
       confidence             REAL,
       supersedes_memory_id   TEXT REFERENCES memory_items(id),
       recorded_by_agent_id   TEXT,
       recorded_at            TEXT NOT NULL
     )`,
    `CREATE INDEX idx_memory_items_kind ON memory_items (kind)`,

    // Repository citations backing a memory (§1). `verification_state`
    // degrades a memory to a lead the moment its evidence stops checking out.
    `CREATE TABLE evidence (
       id                   TEXT PRIMARY KEY,
       memory_item_id       TEXT NOT NULL REFERENCES memory_items(id),
       repository_key       TEXT NOT NULL,
       branch               TEXT NOT NULL,
       base_id              TEXT NOT NULL,
       path                 TEXT NOT NULL,
       symbol               TEXT,
       content_hash         TEXT,
       verification_state   TEXT NOT NULL DEFAULT 'unverifiable' CHECK (verification_state IN (
                              'valid', 'moved', 'changed', 'missing', 'unverifiable'
                            )),
       created_at           TEXT NOT NULL
     )`,
    `CREATE INDEX idx_evidence_memory_item ON evidence (memory_item_id)`,

    // Feedback and contradiction are OPERATIONS on a memory item (§11), not
    // separate kinds — but they are still durable rows a later phase
    // (PLNR-254) reads and writes.
    `CREATE TABLE feedback (
       id              TEXT PRIMARY KEY,
       memory_item_id  TEXT NOT NULL REFERENCES memory_items(id),
       actor_id        TEXT NOT NULL,
       vote            TEXT NOT NULL CHECK (vote IN ('up', 'down')),
       reason          TEXT,
       created_at      TEXT NOT NULL
     )`,
    `CREATE INDEX idx_feedback_memory_item ON feedback (memory_item_id)`,

    `CREATE TABLE contradictions (
       id                          TEXT PRIMARY KEY,
       memory_item_id              TEXT NOT NULL REFERENCES memory_items(id),
       contradicts_memory_item_id  TEXT NOT NULL REFERENCES memory_items(id),
       resolved_at                 TEXT,
       created_at                  TEXT NOT NULL
     )`,
    `CREATE INDEX idx_contradictions_memory_item ON contradictions (memory_item_id)`,

    // Every terminal run (§14). The deterministic skeleton's queryable columns
    // are pulled out; the full record (timeline, findings, self-summary, …)
    // rides in `body` as JSON, the same "payload TEXT" convention the D1 event
    // log already uses for its own variable-shape data.
    `CREATE TABLE episodes (
       id                    TEXT PRIMARY KEY,
       run_id                TEXT NOT NULL,
       task_id               TEXT,
       repository_key        TEXT,
       base_id               TEXT,
       landing_outcome       TEXT NOT NULL DEFAULT 'pending' CHECK (landing_outcome IN (
                               'landed', 'not_landed', 'failed', 'pending'
                             )),
       review_rounds         INTEGER NOT NULL DEFAULT 0,
       cost_usd              REAL NOT NULL DEFAULT 0,
       acceptance_coverage   REAL,
       body                  TEXT NOT NULL,
       created_at            TEXT NOT NULL
     )`,
    `CREATE INDEX idx_episodes_run ON episodes (run_id)`,
    `CREATE INDEX idx_episodes_task ON episodes (task_id)`,
  ],
];

export interface ProjectMemoryHealth {
  projectId: string;
  schemaVersion: number;
  memoryRevision: number;
  tableCounts: Record<string, number>;
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
    const hasMeta = metaTable.length > 0;
    const current = hasMeta ? this.readSchemaVersion() : 0;
    for (let version = current + 1; version <= MIGRATIONS.length; version++) {
      const statements = MIGRATIONS[version - 1]!;
      this.ctx.storage.transactionSync(() => {
        for (const stmt of statements) {
          this.ctx.storage.sql.exec(stmt);
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO _meta (key, value) VALUES ('schema_version', ?1)
           ON CONFLICT (key) DO UPDATE SET value = ?1`,
          String(version),
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

  /** Health/schema-version RPC (PLNR-246 projects this into the D1 registry). */
  async health(projectId: string): Promise<ProjectMemoryHealth> {
    await this.assertProjectId(projectId);
    const tableCounts: Record<string, number> = {};
    for (const table of SCHEMA_TABLES) {
      const row = this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0];
      tableCounts[table] = row?.n ?? 0;
    }
    return {
      projectId,
      schemaVersion: this.readSchemaVersion(),
      memoryRevision: this.readMemoryRevision(),
      tableCounts,
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
  // Restore NEVER deletes the active dataset first. Every table is imported into a `staging_`
  // twin (same CREATE TABLE, same CHECK constraints — just a different name), validated in
  // full, and only then does ONE transactionSync do the entire switch: the live table becomes
  // `prev_<table>` (retained for rollback — at most one generation back, never a stack) and
  // `staging_<table>` becomes the live table. A validation failure at any point drops the
  // staging tables and leaves the active generation byte-identical. FK enforcement is turned
  // OFF for the duration of staging import (both staged and live tables share one connection,
  // and a staging table's declared REFERENCES still point at the LIVE table names — rewriting
  // them is unnecessary because integrity is checked explicitly, via anti-joins, below).
  // ---------------------------------------------------------------------------

  private readonly VALID_COLUMN_NAME = /^[a-z_][a-z0-9_]*$/;

  private tableCreateSql(table: string): string {
    const row = this.ctx.storage.sql
      .exec<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1`, table)
      .toArray()[0];
    if (!row) throw new Error(`unknown table: ${table}`);
    return row.sql;
  }

  private createStagingTable(table: string): void {
    const liveSql = this.tableCreateSql(table);
    // Textual rename of the CREATE TABLE's own name only — a word-boundary match on `CREATE
    // TABLE <table>` so a substring collision (e.g. `nodes` inside some other identifier)
    // can't mis-rename.
    const stagingSql = liveSql.replace(new RegExp(`CREATE TABLE ${table}\\b`), `CREATE TABLE staging_${table}`);
    if (stagingSql === liveSql) throw new Error(`could not derive staging schema for ${table}`);
    this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS staging_${table}`);
    this.ctx.storage.sql.exec(stagingSql);
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
   *  pointing at a node/memory item that doesn't exist in the same staged import fails the
   *  restore before any switch happens. */
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

  private dropStagingTables(tables: readonly string[]): void {
    for (const table of tables) this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS staging_${table}`);
  }

  /**
   * Restore this project's canonical memory from a portable snapshot (PLNR-248's export).
   * Fetches and validates the manifest, imports every chunk into staging (chunk-at-a-time,
   * never the whole snapshot in memory), verifies row counts and graph/evidence integrity
   * against staging, and only on success performs the one atomic generation switch. Marks
   * derived vectors dirty on success — a snapshot's vectors, if any existed, never travel
   * with it (§9); the real rebuild is Phase 4's, this only flags it.
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

    const importedTables = new Set<string>();
    try {
      this.ctx.storage.sql.exec('PRAGMA foreign_keys = OFF');
      for await (const chunk of readSnapshotChunks(this.env, manifest)) {
        if (!importedTables.has(chunk.table)) {
          this.createStagingTable(chunk.table);
          importedTables.add(chunk.table);
        }
        this.ctx.storage.transactionSync(() => {
          for (const row of chunk.rows) this.insertStagingRow(chunk.table, row);
        });
      }

      const countProblems: string[] = [];
      for (const [table, expected] of Object.entries(manifest.tableCounts)) {
        const actual = importedTables.has(table) ? this.countRows('staging_', table) : 0;
        if (actual !== expected) countProblems.push(`${table}: expected ${expected} rows, staged ${actual}`);
      }
      const integrityProblems = importedTables.has('edges') || importedTables.has('evidence') ? this.stagingIntegrityProblems() : [];
      const problems = [...countProblems, ...integrityProblems];
      if (problems.length > 0) {
        this.dropStagingTables([...importedTables]);
        return { ok: false, reason: problems.join('; ') };
      }

      this.ctx.storage.transactionSync(() => {
        for (const table of importedTables) {
          this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS prev_${table}`);
          this.ctx.storage.sql.exec(`ALTER TABLE ${table} RENAME TO prev_${table}`);
          this.ctx.storage.sql.exec(`ALTER TABLE staging_${table} RENAME TO ${table}`);
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO _meta (key, value) VALUES ('has_prior_generation', '1')
           ON CONFLICT (key) DO UPDATE SET value = '1'`,
        );
      });

      await this.reportVectorDirty(projectId, true);
      const tableCounts: Record<string, number> = {};
      for (const table of importedTables) tableCounts[table] = this.countRows('', table);
      return { ok: true, tableCounts };
    } catch (err) {
      // A chunk that failed its own checksum (readSnapshotChunks throws rather than yielding
      // untrusted rows) lands here too — drop whatever staging tables got as far as being
      // created and report failure. The active generation was never touched: the switch above
      // is the only place that renames a live table, and we never reached it.
      this.dropStagingTables([...importedTables]);
      return { ok: false, reason: String(err) };
    } finally {
      this.ctx.storage.sql.exec('PRAGMA foreign_keys = ON');
    }
  }

  /** Swap the retained prior generation back to active — no R2 read, no re-validation; it was
   *  already trusted when it was live. Single-level undo: rolling back consumes the retained
   *  generation, so a second rollback has nothing left to swap. */
  async rollback(projectId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    await this.assertProjectId(projectId);
    const flag = this.ctx.storage.sql.exec<{ value: string }>(`SELECT value FROM _meta WHERE key = 'has_prior_generation'`).toArray()[0];
    if (flag?.value !== '1') return { ok: false, reason: 'no retained prior generation to roll back to' };
    this.ctx.storage.transactionSync(() => {
      for (const table of BACKUP_TABLES) {
        const hasPrev = this.ctx.storage.sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1`, `prev_${table}`).toArray().length > 0;
        if (!hasPrev) continue;
        this.ctx.storage.sql.exec(`ALTER TABLE ${table} RENAME TO rolled_back_${table}`);
        this.ctx.storage.sql.exec(`ALTER TABLE prev_${table} RENAME TO ${table}`);
        this.ctx.storage.sql.exec(`DROP TABLE rolled_back_${table}`);
      }
      this.ctx.storage.sql.exec(`UPDATE _meta SET value = '0' WHERE key = 'has_prior_generation'`);
    });
    await this.reportVectorDirty(projectId, true);
    return { ok: true };
  }

  /** Explicitly discard the retained prior generation once its rollback window has passed —
   *  PLNR-250's scheduled sweep calls this; a manual call here is enough for this task. */
  async pruneRetainedGeneration(projectId: string): Promise<{ ok: true }> {
    await this.assertProjectId(projectId);
    this.ctx.storage.transactionSync(() => {
      for (const table of BACKUP_TABLES) this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS prev_${table}`);
      this.ctx.storage.sql.exec(`UPDATE _meta SET value = '0' WHERE key = 'has_prior_generation'`);
    });
    return { ok: true };
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
}
