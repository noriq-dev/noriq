import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { newId, nowIso } from '../lib/util';

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
 * SCOPE OF THIS FILE (PLNR-245): the store and its migrator only. Outbox
 * DELIVERY and the D1 projector are PLNR-247; the real memory/evidence/graph
 * write APIs are PLNR-251 onward. The tables below exist so those tasks have
 * somewhere to write.
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

const SCHEMA_TABLES = [
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
}
