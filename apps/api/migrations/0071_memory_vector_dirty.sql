-- PLNR-249: visible vector-staleness flag for a project's memory registry row. Set whenever a
-- restore activates a new generation (the imported data's derived vectors, if any existed, do
-- NOT travel with a snapshot — Vectorize is rebuilt from canonical rows, never trusted from the
-- snapshot alone, per the architecture doc). No memory Vectorize index exists before Phase 4
-- (PLNR-255/256); this column is durable scaffolding for the rebuild pipeline that reads it.
ALTER TABLE project_memory_registry ADD COLUMN vector_dirty INTEGER NOT NULL DEFAULT 0;
