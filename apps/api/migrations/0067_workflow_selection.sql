-- PLNR-240: dispatch selects a workflow.
--
-- Two carriers, both nullable TEXT (free strings — the valid set lives in each repo's
-- committed manifest and is advertised per runner, so a CHECK here would be wrong the
-- moment a repo edits its .noriq/workflows/):
--
--   plan_dispatches.workflow — the dispatch-level DEFAULT: every run the pump creates
--     runs under it unless the task names its own.
--   tasks.workflow — the per-task override ("this task builds under build-codex"),
--     settable where plans are edited/approved, read only by the pump.
--
-- Null = the built-in for the run's kind, byte-identical to pre-PLNR-240 behavior.
-- Additive only, per the repo migration rule.
ALTER TABLE plan_dispatches ADD COLUMN workflow TEXT;
ALTER TABLE tasks ADD COLUMN workflow TEXT;
