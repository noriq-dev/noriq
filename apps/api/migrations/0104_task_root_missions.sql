-- PLNR-492: explicit task-anchored mission roots share mission.v2 lease/restart fencing.
-- Ordinary task Runs retain NULL and therefore stay on the legacy lifecycle path.

ALTER TABLE runs ADD COLUMN mission_mode TEXT CHECK (mission_mode IS NULL OR mission_mode = 'task_root');

CREATE TABLE mission_task_root_commissions (
  root_run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sitting INTEGER NOT NULL CHECK (sitting > 0),
  commission_id TEXT NOT NULL UNIQUE,
  digest TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  commissioned_at TEXT NOT NULL
);

CREATE INDEX idx_mission_task_root_commissions_task
  ON mission_task_root_commissions (project_id, task_id, commissioned_at);
