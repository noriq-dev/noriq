-- PLNR-484: a plan dispatch may commission one plan-anchored Runner mission instead of
-- fanning out task Runs. Omission remains the legacy per-task pump.

ALTER TABLE plan_dispatches ADD COLUMN strategy TEXT NOT NULL DEFAULT 'per_task'
  CHECK (strategy IN ('per_task', 'single_root'));

-- The ProjectRoom serializes creation, and this is the durable backstop: retry, reconnect, or
-- an isolate restart can never produce two plan roots for the same dispatch.
CREATE UNIQUE INDEX idx_plan_dispatch_single_root
  ON runs (plan_dispatch_id)
  WHERE plan_dispatch_id IS NOT NULL AND anchor_type = 'plan';
