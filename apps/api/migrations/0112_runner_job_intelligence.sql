-- PLNR-510: permanent RunnerJob intelligence summaries and retryable task-episode projection.
-- Detailed observations/events are intentionally separate and may be pruned after 90 days;
-- these summaries, RunnerJob rows, items, and ProjectMemory episodes are not retention targets.

ALTER TABLE runner_jobs ADD COLUMN intelligence_projected_at TEXT;
ALTER TABLE runner_jobs ADD COLUMN detail_pruned_at TEXT;

CREATE TABLE runner_job_episode_jobs (
  job_id TEXT PRIMARY KEY REFERENCES runner_jobs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('terminal','landing_refresh')),
  requested_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  last_attempt_at TEXT
);

CREATE INDEX idx_runner_job_episode_jobs_requested
  ON runner_job_episode_jobs (requested_at, project_id);

CREATE TABLE runner_job_intelligence_jobs (
  job_id TEXT PRIMARY KEY REFERENCES runner_jobs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('task','plan')),
  source_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded','partial','failed','cancelled')),
  task_count INTEGER NOT NULL CHECK (task_count >= 0),
  task_episode_count INTEGER NOT NULL CHECK (task_episode_count >= 0),
  context TEXT,
  timing TEXT NOT NULL,
  usage TEXT NOT NULL,
  stages TEXT NOT NULL,
  overhead TEXT NOT NULL,
  landing TEXT NOT NULL,
  projected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_runner_job_intelligence_jobs_project
  ON runner_job_intelligence_jobs (project_id, projected_at DESC, job_id);

CREATE TABLE runner_job_intelligence_tasks (
  job_id TEXT NOT NULL REFERENCES runner_jobs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('done','failed','cancelled')),
  timing TEXT NOT NULL,
  usage TEXT NOT NULL,
  stages TEXT NOT NULL,
  landing TEXT NOT NULL,
  projected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, task_id)
);

CREATE INDEX idx_runner_job_intelligence_tasks_project_task
  ON runner_job_intelligence_tasks (project_id, task_id, projected_at DESC);
