-- ProjectMemory schema v3 (PLNR-253) — proposed-decision approval and authority promotion.
-- Never edit 0001/0002; additive only, same rules as always.
--
-- proposed_at: non-NULL <=> awaiting a human accept/reject decision — the SAME derived-state
-- pattern as spin-off tasks (migrations/0064_spinoff_tasks.sql): approve clears it (the memory
-- stays exactly as recorded; the promotion is a NEW superseding version, never an in-place
-- authority edit); reject clears it too but sets rejected_at, so a rejected decision remains
-- historically visible rather than reading as still-pending forever.
ALTER TABLE memory_items ADD COLUMN proposed_at TEXT;
ALTER TABLE memory_items ADD COLUMN rejected_at TEXT;

-- One immutable, additive row per authority transition — human approval OR merge-evidence
-- promotion. Never updated after insert; that is what makes it evidence rather than a mutable
-- status field. `resulting_memory_id` is the NEW superseding version's id (null for a rejection,
-- which produces no new version). `revision` is the merged baseId a promotion verified against,
-- when relevant.
CREATE TABLE memory_authority_transitions (
  id                   TEXT PRIMARY KEY,
  memory_item_id       TEXT NOT NULL REFERENCES memory_items(id),
  resulting_memory_id  TEXT REFERENCES memory_items(id),
  outcome              TEXT NOT NULL CHECK (outcome IN ('approved', 'rejected', 'merge_promoted')),
  new_authority        INTEGER,
  actor_kind           TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  actor_id             TEXT,
  revision             TEXT,
  note                 TEXT,
  created_at           TEXT NOT NULL
);
CREATE INDEX idx_memory_authority_transitions_item ON memory_authority_transitions (memory_item_id);
