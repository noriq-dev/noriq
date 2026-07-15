-- 0031: a dispatch may steer its own landing branch (RUN-41).
--
-- `[land].branch` answers "where does landed work go" once, for every run forever — but the
-- decision is per-dispatch: a risky refactor belongs on its own branch, where it can be looked at
-- before it goes anywhere. The only way to say that was to edit and commit the manifest, which is
-- both a race (it is re-read per run) and a lie (it changes the default for every run in flight).
--
-- Stored, like plan_key and for the same reason: the branch a run landed on is a historical fact,
-- not something to re-derive later from config that has since moved.
ALTER TABLE runs ADD COLUMN target_branch TEXT;
