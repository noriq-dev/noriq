-- PLNR-263: deterministic episode identity + idempotency columns.
--
-- 0001 gave `episodes` its queryable landing/cost/coverage columns and a payload-JSON `body`;
-- this adds the columns that make ONE terminal run map to ONE row cheaply and honestly:
--
--   agent_id     the run's own spawned agent (runs.agent_id) — the `owned_by` edge target and
--                the join key for "memories this run recorded" (recorded_by_agent_id), pulled
--                into its own column so neither needs a `json_extract` over `body`.
--   run_kind     'scope' | 'build' | 'verify' (runs.kind) — cheap filtering ("build episodes
--                only") without parsing body.
--   outcome      the RUN's own terminal exit reason (runs.exit.outcome: 'done' | 'failed' |
--                'cancelled') — a DIFFERENT axis from the pre-existing `landing_outcome`, which
--                asks whether the WORK landed (merged), not whether the agent's own sitting
--                succeeded. A `done` run can still sit at landing_outcome 'pending' for days
--                awaiting human review; conflating the two into one column would lose that.
--   started_at   runs.started_at — when the agent actually began, as opposed to `created_at`
--                below (when THIS ROW was recorded, i.e. write time).
--   finished_at  the run's own exit.finishedAt — when the run reached its terminal status.
--   content_hash sha256 over the recorded body — lets a caller detect whether a re-recorded
--                episode's content actually changed without diffing JSON.
--
-- `outcome` deliberately has NO CHECK constraint widened to include a 'continued' value some
-- earlier planning draft anticipated: nothing in this codebase ever calls recordEpisode with an
-- outcome other than runs.exit.outcome's own three values (recordEpisode reads outcome from the
-- run's OWN row, never trusts a caller-supplied one — see episodes.ts), so a fourth CHECK value
-- would be exactly the kind of speculative column memory/migrations.ts's own guidance warns
-- against. If a future phase needs to represent "this run was reopened," that is a `runs`-side
-- fact (RUN-180's reopenRun already clears `exit` back to NULL), not an episode outcome.
--
-- `run_id` gets a UNIQUE index (replacing 0001's plain one) — recordEpisode UPSERTs on it, which
-- is what makes "one episode per run" and "duplicate payload delivery is idempotent" true by
-- construction, with no operation-id ledger lookup needed on every redelivery. Dropping and
-- recreating an INDEX (never a table) is not the FK/rebuild hazard this file's sibling
-- migrations warn about — no other table references an index, so this is a pure additive-in-
-- effect change: existing rows are untouched, and a schema that had already gone unique-by-
-- construction (no duplicate run_id could ever have been written by the pre-PLNR-263 code, since
-- nothing but `_seedEpisodeForTest` wrote this table) loses nothing by the swap.
DROP INDEX idx_episodes_run;
CREATE UNIQUE INDEX idx_episodes_run ON episodes (run_id);

ALTER TABLE episodes ADD COLUMN agent_id TEXT;
ALTER TABLE episodes ADD COLUMN run_kind TEXT CHECK (run_kind IN ('scope', 'build', 'verify'));
ALTER TABLE episodes ADD COLUMN outcome TEXT CHECK (outcome IN ('done', 'failed', 'cancelled'));
ALTER TABLE episodes ADD COLUMN started_at TEXT;
ALTER TABLE episodes ADD COLUMN finished_at TEXT;
ALTER TABLE episodes ADD COLUMN content_hash TEXT;

-- The `owned_by`/memory-correlation join target (§14, PLNR-263's locked graph-edge set).
CREATE INDEX idx_episodes_agent ON episodes (agent_id) WHERE agent_id IS NOT NULL;
