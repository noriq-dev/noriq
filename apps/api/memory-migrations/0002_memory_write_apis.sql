-- ProjectMemory schema v2 (PLNR-251) — the real memory/evidence/graph write APIs' additive
-- schema. Never edit 0001; this only adds columns and tables it needs.
--
-- Named contradiction sets: a set is the addressable unit ("coexist ... joined by a named
-- contradiction set"); membership is still recorded as pairwise rows in `contradictions` (0001),
-- each now tagged with the set it belongs to. Two memories contradicting each other is one row
-- with a fresh set_id; a third memory joining the same disagreement is a second row reusing that
-- set_id — the set, not the pair, is what a caller resolves as a unit.
CREATE TABLE contradiction_sets (
  id          TEXT PRIMARY KEY,
  resolved_at TEXT,
  created_at  TEXT NOT NULL
);
ALTER TABLE contradictions ADD COLUMN set_id TEXT REFERENCES contradiction_sets(id);
CREATE INDEX idx_contradictions_set ON contradictions (set_id);

-- Content/evidence hashes (sha256, see memory/writes.ts) — stable identity for a memory's
-- recorded content and for one evidence citation, independent of the operation-id ledger below.
ALTER TABLE memory_items ADD COLUMN content_hash TEXT;
ALTER TABLE evidence ADD COLUMN evidence_hash TEXT;

-- Memory scope (§6, §16): which repository/branch/baseId this memory is about, when it is
-- about one. Nullable — a project-wide decision or procedure has no repository scope.
ALTER TABLE memory_items ADD COLUMN repository_key TEXT REFERENCES repositories(repository_key);
ALTER TABLE memory_items ADD COLUMN branch TEXT;
ALTER TABLE memory_items ADD COLUMN base_id TEXT;
CREATE INDEX idx_memory_items_repo ON memory_items (repository_key);

-- Memory-level validity (§15) — separate from evidence.verification_state (which is per
-- citation): this is the memory's own presentation state. PLNR-254 adds the transitions; this
-- column just gives them somewhere to land, defaulting every existing/new row to 'active'.
ALTER TABLE memory_items ADD COLUMN validity TEXT NOT NULL DEFAULT 'active' CHECK (validity IN ('active', 'stale', 'invalid'));

-- Operation-id idempotency ledger (0001) widens to carry what it dedupes TO, not just that it
-- was seen: a retried write with the same operation id must return the SAME subject id it
-- returned the first time, not merely acknowledge silently.
ALTER TABLE applied_operations ADD COLUMN subject_type TEXT;
ALTER TABLE applied_operations ADD COLUMN subject_id TEXT;
ALTER TABLE applied_operations ADD COLUMN result TEXT;

-- A literal duplicate edge (same type between the same two nodes) is never meaningful graph
-- data — idempotent by construction, the same way `nodes.uri` already is, independent of
-- whether the caller supplied an operation id.
CREATE UNIQUE INDEX idx_edges_unique ON edges (type, from_node_id, to_node_id);
