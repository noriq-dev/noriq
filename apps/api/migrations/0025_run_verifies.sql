-- Let a VERIFY run say which BUILD run's diff it is judging.
--
-- Without this the verify agent is dispatched into a worktree branched from HEAD, so the
-- `git diff` its prompt tells it to inspect comes back EMPTY — it reviews unchanged code
-- and its verdict is meaningless. The daemon uses this to branch the verifier's checkout
-- from the build's throwaway branch instead.
--
-- A separate column rather than a new `anchor_type` variant, deliberately:
--   * a verify run still needs its TASK anchor — that is where the daemon posts findings,
--     so the two are different axes, not alternatives;
--   * `anchor_type` carries CHECK (anchor_type IN ('task','plan')), and widening it would
--     mean rebuilding `runs` — non-additive, which this repo forbids.
--
-- Soft (polymorphic) reference, matching anchor_id's convention: no FK, so reaping or
-- archiving a build run can never block a verify row.
ALTER TABLE runs ADD COLUMN verifies_run_id TEXT;
CREATE INDEX idx_runs_verifies ON runs (verifies_run_id);
