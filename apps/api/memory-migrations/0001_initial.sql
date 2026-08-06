-- ProjectMemory schema v1 (PLNR-245) — the canonical cognitive-memory schema.
--
-- Applied INSIDE the ProjectMemory Durable Object at construction (see
-- ../src/do/ProjectMemory.ts migrate()), gated by a durable `_meta.schema_version`.
-- This is NOT a D1 migration: it must never live in ../migrations, which wrangler and
-- the test harness apply wholesale to D1. The ordered manifest that loads this file is
-- ../src/memory/migrations.ts.
--
-- The whole file is executed as ONE multi-statement `SqlStorage.exec()` call (exec
-- accepts several `;`-separated statements — verified against workerd), so there is no
-- statement splitting and this reads as ordinary SQL.
--
-- FK targets are created before their referrers. Column vocabularies
-- (kind/type/authority/verification enums) are the CHECK-constraint mirror of
-- @noriq-dev/shared's memory.ts zod enums — the same convention D1's own migrations use
-- for status columns. Never re-declare them as a second source of truth elsewhere.
--
-- There is deliberately NO `PRAGMA foreign_keys` statement here. On Durable Object
-- SQLite foreign keys are enforced ALWAYS and the pragma is ignored outright:
-- `PRAGMA foreign_keys = OFF` still reports 1 and a dangling insert still raises
-- SQLITE_CONSTRAINT (verified against workerd). The line that used to sit here read as
-- "we turn enforcement on", which was misleading twice over — it was already on, and
-- nothing here could have turned it off.
CREATE TABLE _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- A monotonic counter bumped by every canonical mutation (PLNR-247+) — what a
-- health check and a backup manifest's memoryRevision report.
CREATE TABLE memory_revision (
  id    INTEGER PRIMARY KEY CHECK (id = 0),
  value INTEGER NOT NULL DEFAULT 0
);
INSERT INTO memory_revision (id, value) VALUES (0, 0);

-- The durable D1-event-log cursor the projector (PLNR-247) advances —
-- events.global_seq, never rowid (reused after deleteProject, PLNR-111) and
-- never the per-project seq (that one is the WS resume cursor).
CREATE TABLE projector_cursor (
  id         INTEGER PRIMARY KEY CHECK (id = 0),
  global_seq INTEGER NOT NULL DEFAULT 0
);
INSERT INTO projector_cursor (id, global_seq) VALUES (0, 0);

-- Idempotency ledger for canonical mutations delivered outward (PLNR-247): a
-- redelivered operation id is recognized and skipped rather than re-applied.
CREATE TABLE applied_operations (
  operation_id TEXT PRIMARY KEY,
  applied_at   TEXT NOT NULL
);

-- Compact change events awaiting delivery to ProjectRoom (PLNR-247). No memory
-- body ever rides here — verb + subject + a summary payload only, the same
-- discipline the D1 event log itself already follows.
CREATE TABLE outbox (
  id           TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  verb         TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX idx_outbox_pending ON outbox (created_at) WHERE delivered_at IS NULL;

-- Repositories this project's memory has ever indexed. The CANONICAL
-- project<->repository association lives in D1 (PLNR-246, §3); this is just the
-- local FK anchor for index generations and evidence.
CREATE TABLE repositories (
  repository_key TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL
);

CREATE TABLE index_generations (
  id              TEXT PRIMARY KEY,
  repository_key  TEXT NOT NULL REFERENCES repositories(repository_key),
  branch          TEXT NOT NULL,
  base_id         TEXT NOT NULL,
  indexer_version TEXT NOT NULL,
  batch_count     INTEGER NOT NULL,
  file_count      INTEGER NOT NULL,
  content_hash    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'active', 'superseded')),
  created_at      TEXT NOT NULL,
  activated_at    TEXT
);
CREATE INDEX idx_index_generations_repo ON index_generations (repository_key, status);

-- The project knowledge graph (§5). `uri` is the stable entity URI
-- (buildEntityUri, PLNR-244) — durable identity, never a generation or baseId.
CREATE TABLE nodes (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL CHECK (type IN (
               'project', 'repository', 'branch', 'revision', 'file', 'symbol', 'api',
               'database_entity', 'test', 'task', 'plan', 'run', 'agent', 'decision',
               'memory', 'error', 'requirement', 'procedure', 'episode', 'artifact', 'unknown'
             )),
  uri        TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_nodes_type ON nodes (type);

CREATE TABLE edges (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN (
                 'declares', 'calls', 'imports', 'depends_on', 'tests', 'implements', 'modifies',
                 'observed_in', 'decided_by', 'supersedes', 'contradicts', 'blocks', 'related_to',
                 'failed_because', 'validated_by', 'owned_by', 'commonly_changes_with', 'derived_from'
               )),
  from_node_id TEXT NOT NULL REFERENCES nodes(id),
  to_node_id   TEXT NOT NULL REFERENCES nodes(id),
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_edges_from ON edges (from_node_id);
CREATE INDEX idx_edges_to ON edges (to_node_id);

-- The one kind-driven recording surface (§11). `supersedes_memory_id` links a
-- new version back rather than overwriting — history is never destructively
-- erased (§12).
CREATE TABLE memory_items (
  id                   TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL CHECK (kind IN (
                         'learning', 'decision', 'failed_approach', 'procedure',
                         'requirement', 'hazard', 'unknown'
                       )),
  statement            TEXT NOT NULL,
  authority            INTEGER NOT NULL DEFAULT 1 CHECK (authority BETWEEN 1 AND 5),
  confidence           REAL,
  supersedes_memory_id TEXT REFERENCES memory_items(id),
  recorded_by_agent_id TEXT,
  recorded_at          TEXT NOT NULL
);
CREATE INDEX idx_memory_items_kind ON memory_items (kind);

-- Repository citations backing a memory (§1). `verification_state` degrades a
-- memory to a lead the moment its evidence stops checking out.
CREATE TABLE evidence (
  id                 TEXT PRIMARY KEY,
  memory_item_id     TEXT NOT NULL REFERENCES memory_items(id),
  repository_key     TEXT NOT NULL,
  branch             TEXT NOT NULL,
  base_id            TEXT NOT NULL,
  path               TEXT NOT NULL,
  symbol             TEXT,
  content_hash       TEXT,
  verification_state TEXT NOT NULL DEFAULT 'unverifiable' CHECK (verification_state IN (
                       'valid', 'moved', 'changed', 'missing', 'unverifiable'
                     )),
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_evidence_memory_item ON evidence (memory_item_id);

-- Feedback and contradiction are OPERATIONS on a memory item (§11), not
-- separate kinds — but they are still durable rows a later phase (PLNR-254)
-- reads and writes.
CREATE TABLE feedback (
  id             TEXT PRIMARY KEY,
  memory_item_id TEXT NOT NULL REFERENCES memory_items(id),
  actor_id       TEXT NOT NULL,
  vote           TEXT NOT NULL CHECK (vote IN ('up', 'down')),
  reason         TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_feedback_memory_item ON feedback (memory_item_id);

CREATE TABLE contradictions (
  id                         TEXT PRIMARY KEY,
  memory_item_id             TEXT NOT NULL REFERENCES memory_items(id),
  contradicts_memory_item_id TEXT NOT NULL REFERENCES memory_items(id),
  resolved_at                TEXT,
  created_at                 TEXT NOT NULL
);
CREATE INDEX idx_contradictions_memory_item ON contradictions (memory_item_id);

-- Every terminal run (§14). The deterministic skeleton's queryable columns are
-- pulled out; the full record (timeline, findings, self-summary, …) rides in
-- `body` as JSON, the same "payload TEXT" convention the D1 event log already
-- uses for its own variable-shape data.
CREATE TABLE episodes (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL,
  task_id             TEXT,
  repository_key      TEXT,
  base_id             TEXT,
  landing_outcome     TEXT NOT NULL DEFAULT 'pending' CHECK (landing_outcome IN (
                        'landed', 'not_landed', 'failed', 'pending'
                      )),
  review_rounds       INTEGER NOT NULL DEFAULT 0,
  cost_usd            REAL NOT NULL DEFAULT 0,
  acceptance_coverage REAL,
  body                TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_episodes_run ON episodes (run_id);
CREATE INDEX idx_episodes_task ON episodes (task_id);
