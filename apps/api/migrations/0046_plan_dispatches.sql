-- PLNR-170: dispatch a whole PLAN to a runner. The server fans the plan's tasks out as
-- individual task-anchored build runs, respecting dependency edges, in parallel up to the
-- runner's capacity. This row is the durable orchestration record — the pump reads it, never
-- an in-memory queue, so a dispatch survives deploys, DO evictions, and the runner being off.
--
-- `gate` is the review-latency decision, per dispatch:
--   'landed'   — a dependent task unblocks once its dependency's run is DONE (verify gate
--                passed, code landed on the plan branch), even while the task row sits in
--                review. Humans still review everything; they stop being a synchronous lock
--                in the middle of the pipeline. Same philosophy as [land].autoPush.
--   'approved' — the strict rule: dependents wait for the human to mark the task done.
--
-- `status`: active → completed | cancelled, with stalled ⇄ active in between. 'stalled' means
-- the pump can make no forward progress without a human (failed attempts, review backlog under
-- 'approved', parked tasks) — it is recoverable: the next unblocking event re-pumps.
CREATE TABLE plan_dispatches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  plan_id TEXT NOT NULL REFERENCES plans(id),
  runner_id TEXT NOT NULL REFERENCES runners(id),
  repo_ref TEXT NOT NULL,
  agent_tool TEXT NOT NULL CHECK (agent_tool IN ('claude', 'codex')),
  -- Per-dispatch model/effort, applied to every run it creates. No CHECKs — same reasoning as
  -- 0033: model names are the vendor's, and effort is validated by the shared schema at the door.
  model TEXT,
  effort TEXT,
  budget TEXT NOT NULL DEFAULT '{}',
  gate TEXT NOT NULL DEFAULT 'landed' CHECK (gate IN ('landed', 'approved')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stalled', 'completed', 'cancelled')),
  -- Why the pump is stuck, for the dashboard. Set iff status='stalled'.
  stall_reason TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

-- The pump's entry query (every terminal run / task completion / runner heartbeat asks it).
CREATE INDEX idx_plan_dispatches_live ON plan_dispatches (project_id, status);
-- The heartbeat nudge asks per-runner.
CREATE INDEX idx_plan_dispatches_runner ON plan_dispatches (runner_id, status);

-- Which dispatch created a run. Null = a one-off (manual) dispatch — the overwhelmingly common
-- row, hence a nullable column on runs rather than a join table (additive-migrations rule).
ALTER TABLE runs ADD COLUMN plan_dispatch_id TEXT REFERENCES plan_dispatches(id);
