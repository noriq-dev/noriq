-- PLNR-508: durable human/automatic acceptance of retained RunnerJob output.

ALTER TABLE runner_jobs ADD COLUMN landing_policy TEXT NOT NULL DEFAULT 'retain'
  CHECK (landing_policy IN ('retain','manual','auto','direct'));
ALTER TABLE runner_jobs ADD COLUMN landing_status TEXT NOT NULL DEFAULT 'retained'
  CHECK (landing_status IN ('retained','requested','landing','landed','failed','not_applicable'));
ALTER TABLE runner_jobs ADD COLUMN landing_target TEXT;
ALTER TABLE runner_jobs ADD COLUMN landing_request_id TEXT;
ALTER TABLE runner_jobs ADD COLUMN landing_requested_by TEXT;
ALTER TABLE runner_jobs ADD COLUMN landing_requested_at TEXT;
ALTER TABLE runner_jobs ADD COLUMN landing_started_at TEXT;
ALTER TABLE runner_jobs ADD COLUMN landing_finished_at TEXT;
ALTER TABLE runner_jobs ADD COLUMN landing_checkpoint TEXT;
ALTER TABLE runner_jobs ADD COLUMN landing_error TEXT;

CREATE UNIQUE INDEX idx_runner_jobs_landing_request
  ON runner_jobs (landing_request_id) WHERE landing_request_id IS NOT NULL;
CREATE INDEX idx_runner_jobs_runner_landing
  ON runner_jobs (runner_id, landing_status, landing_requested_at)
  WHERE landing_status IN ('requested','landing');
