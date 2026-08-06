-- PLNR-261: staged index-generation content and the columns that make activation real
-- validation instead of blind trust.
--
-- Three NEW tables hold an in-flight generation's batches/entities/edges BEFORE promotion —
-- deliberately NOT prefixed `staging_`: the restore path (createEmptyStagingTables) derives
-- `staging_<table>` names from BACKUP_TABLES, and a real table sharing that prefix would collide
-- with restore's own constraint-free temp tables. `index_` prefix instead, alongside the
-- pre-existing `index_generations`. No FK to index_generations(id) — a staged row's generation
-- is deleted by pruneAbandonedStagedGenerations/abortIndexIngest, which delete these children
-- explicitly (child-before-parent) rather than relying on a cascade DO SQLite doesn't have.
--
-- Four ADDITIVE columns on the pre-existing index_generations: `deletions` carries the
-- manifest's declared RepoPath deletions through from stage to activation (a JSON array);
-- `sealed_at` marks "no more batches accepted" (set by completeIndexIngest, checked by
-- ingestIndexBatch/beginIndexIngest) independently of `status`, so "already completed" can be
-- refused without touching the staged/active/superseded vocabulary; `validation_problems` is the
-- actionable record of what a completed-but-invalid generation's validation found (JSON array of
-- strings; NULL means "no problems recorded" — either validation has not run yet, or it ran
-- clean). A partial unique index makes "one active generation per repository" a real constraint,
-- not just a code-enforced invariant guarded by a transaction.
ALTER TABLE index_generations ADD COLUMN deletions TEXT NOT NULL DEFAULT '[]';
ALTER TABLE index_generations ADD COLUMN sealed_at TEXT;
ALTER TABLE index_generations ADD COLUMN validation_problems TEXT;
CREATE UNIQUE INDEX idx_index_generations_one_active ON index_generations (repository_key) WHERE status = 'active';

CREATE TABLE index_batches (
  generation_id TEXT NOT NULL,
  batch_number  INTEGER NOT NULL,
  batch_hash    TEXT NOT NULL,
  row_count     INTEGER NOT NULL,
  received_at   TEXT NOT NULL,
  PRIMARY KEY (generation_id, batch_number)
);

-- A staged entity — the pre-projection form of what PLNR-262 turns into a `nodes` row. `type`
-- and `uri` are NOT constrained by nodes' CHECK/UNIQUE here: staged content is validated by
-- application code (completeIndexIngest), and the real constraints apply only once PLNR-262
-- projects a staged row into the live graph.
CREATE TABLE index_staged_entities (
  generation_id TEXT NOT NULL,
  uri           TEXT NOT NULL,
  type          TEXT NOT NULL,
  label         TEXT NOT NULL,
  content       TEXT,
  PRIMARY KEY (generation_id, uri)
);

-- A staged edge, addressed by entity URI (not a node id — no node exists yet for staged
-- content). `stagingIntegrityProblems`-style validation (completeIndexIngest) rejects a
-- generation whose staged edges reference a uri absent from this SAME generation's staged
-- entities.
CREATE TABLE index_staged_edges (
  generation_id TEXT NOT NULL,
  type          TEXT NOT NULL,
  from_uri      TEXT NOT NULL,
  to_uri        TEXT NOT NULL,
  PRIMARY KEY (generation_id, type, from_uri, to_uri)
);
