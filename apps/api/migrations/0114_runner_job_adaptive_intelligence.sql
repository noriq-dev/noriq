-- PLNR-516: live adaptive routing, task-phase, and price-basis projection.
-- The append-only RunnerJob event journal remains authoritative. These bounded
-- read models make current Runs cheap to inspect and are rebuilt into permanent
-- Project Intelligence summaries before detailed journal retention expires.

ALTER TABLE runner_job_items ADD COLUMN phase TEXT CHECK (phase IS NULL OR phase IN (
  'preparing','planning','building','checking','reviewing','repairing','integrating','finalizing'
));
ALTER TABLE runner_job_items ADD COLUMN progress REAL CHECK (progress IS NULL OR (progress >= 0 AND progress <= 1));
ALTER TABLE runner_job_items ADD COLUMN phase_updated_at TEXT;

ALTER TABLE runner_job_observations ADD COLUMN cost_basis TEXT;

CREATE TABLE runner_job_routes (
  job_id TEXT NOT NULL REFERENCES runner_jobs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  role TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0 AND attempt <= 100),
  route TEXT NOT NULL,
  event_seq INTEGER NOT NULL CHECK (event_seq > 0),
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (job_id, task_id, role, attempt),
  UNIQUE (job_id, event_seq)
);

CREATE INDEX idx_runner_job_routes_task
  ON runner_job_routes (job_id, task_id, event_seq);
