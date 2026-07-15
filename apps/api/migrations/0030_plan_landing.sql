-- 0030: the run→plan link, and durable plan completion (RUN-28).
--
-- Runs land onto a working branch and accumulate there; when the PLAN those runs belong to is
-- finished, a merge request opens. Two facts are missing for that, and both live server-side.
--
-- 1. WHICH PLAN a run serves. The daemon cannot know: Run.anchor is task|plan, so a
--    plan-anchored run knows its plan, but a task-anchored one only knows its task — and the
--    task's plan membership is `phase_tasks`, which the daemon never sees. Resolved at dispatch
--    and stored, rather than recomputed later: a task can be re-parented or a plan deleted, and
--    the branch a run landed on is a historical fact, not something to re-derive from a graph
--    that has since moved.
ALTER TABLE runs ADD COLUMN plan_id TEXT REFERENCES plans(id);
CREATE INDEX idx_runs_plan ON runs (plan_id) WHERE plan_id IS NOT NULL;

-- The branch-safe key, FROZEN at dispatch. Both columns earn their place: plan_id answers "which
-- runners served this plan" (the completion notify), and plan_key is the branch name — derived
-- from a title, which is neither unique nor immutable. Deriving it live would move a plan's
-- branch the moment someone retitled it, stranding everything already landed on the old one.
ALTER TABLE runs ADD COLUMN plan_key TEXT;

-- 2. THAT A PLAN FINISHED, durably.
--
-- The obvious build is "notice the last task go done, push a WS frame at the runner". That drops
-- the event whenever no runner is listening — the box is off, the runner was offboarded (RUN-35),
-- the socket is mid-reconnect — and the MR then never opens, silently. This project has already
-- shipped that exact bug twice (a terminal run.status emitted during a reconnect; agentId under
-- a change-only frame gate), so completion is RECORDED and reconciled, and the WS push is only
-- the fast path.
--
-- `merge_requested_at` is what makes it idempotent: a plan completes once, but a runner may
-- reconnect many times and must not open a second PR each time it asks.
CREATE TABLE plan_landings (
  plan_id           TEXT PRIMARY KEY REFERENCES plans(id) ON DELETE CASCADE,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  completed_at      TEXT NOT NULL,
  -- Set once a runner reports it opened (or could not open) the MR. NULL = still owed.
  merge_requested_at TEXT,
  merge_request_url  TEXT,
  -- Why it could not be opened, when a runner tried and failed (no gh, conflict, no remote).
  failed_detail      TEXT
);
CREATE INDEX idx_plan_landings_owed ON plan_landings (project_id) WHERE merge_requested_at IS NULL;
