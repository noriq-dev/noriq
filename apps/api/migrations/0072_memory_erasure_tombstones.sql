-- PLNR-250: a durable, cascade-surviving record of a pending ProjectMemory erasure.
--
-- PLNR-246 shipped erasure as fire-and-forget: deleteProject calls into the ProjectMemory DO
-- after its own D1 batch commits, but a lost signal (isolate recycled, DO unreachable) orphans
-- that store forever with no record it was ever supposed to be erased. This table is what makes
-- cleanup RESUMABLE: deleteProject inserts a tombstone in the SAME batch as its cascade, and a
-- scheduled sweep (lib/memory/lifecycle.ts) retries any tombstone still standing until every
-- erasure step reports complete, at which point the sweep deletes the row.
--
-- Deliberately NOT a foreign key to `projects` — a tombstone's entire purpose is to outlive the
-- project row it refers to, so it must not be swept up by (and must be explicitly EXEMPT from)
-- deleteProject's own FK-ordered cascade, the same way `templates` and `event_seq` are exempt.
CREATE TABLE memory_erasure_tombstones (
  project_id      TEXT PRIMARY KEY,
  requested_at    TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  last_attempt_at TEXT
);
