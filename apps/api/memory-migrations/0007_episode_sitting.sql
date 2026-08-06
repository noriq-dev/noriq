-- PLNR-263 (correction) — episode identity is (run_id, sitting), not run_id alone.
--
-- 0006 gave `episodes` a UNIQUE index on `run_id` alone, on the mistaken assumption that a
-- "continued" run always gets a fresh run id. It does not: `ProjectRoom.reopenRun` (RUN-182)
-- reuses the SAME `runs.id` for a second (or third) sitting, clearing `exit`/`agent_id` and
-- re-dispatching — its own code comment already calls this "a new sitting". Under the old
-- UNIQUE(run_id), the reopened sitting's own terminal transition would UPSERT the SAME episode
-- row the failed sitting had already written, destroying it — exactly the evidence §14 says
-- must remain retrievable, and a violation of this task's own "neither overwrites the other"
-- acceptance line.
--
-- Never editing 0006 in place: it may already be applied (a durable `_meta.schema_version` in a
-- live store could already read >= 6), and memory/migrations.ts's own rule is additive-only,
-- never edit a shipped migration. This is a NEW migration that widens the same table instead.
--
-- `sitting` mirrors migration 0075's `runs.sitting` (D1) — DEFAULT 1 for the same reason: every
-- episode written before this migration existed is trivially "sitting 1" of its run. The old
-- UNIQUE(run_id) index is dropped and replaced with UNIQUE(run_id, sitting); `recordEpisode`'s
-- upsert conflict target moves to that pair.
DROP INDEX idx_episodes_run;
ALTER TABLE episodes ADD COLUMN sitting INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX idx_episodes_run_sitting ON episodes (run_id, sitting);
