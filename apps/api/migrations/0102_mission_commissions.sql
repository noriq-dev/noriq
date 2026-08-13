-- PLNR-489: immutable plan/task/dependency snapshots for single-root mission assignments.
-- The JSON is the bounded shared MissionCommissionSnapshot. It is never updated after insert;
-- a later plan/task edit cannot silently rewrite authority already commissioned to Runner.

CREATE TABLE mission_commissions (
  root_run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  sitting INTEGER NOT NULL CHECK (sitting > 0),
  commission_id TEXT NOT NULL UNIQUE,
  plan_revision TEXT NOT NULL,
  digest TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  commissioned_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_mission_commissions_plan_revision
  ON mission_commissions (root_run_id, sitting, plan_revision);
