-- PLNR-263 follow-up: durable delivery of terminal-run episode skeletons.
--
-- A terminal transition commits the run state and this job in one D1 batch. ProjectRoom then
-- attempts the ProjectMemory write in the background, while the scheduled sweep retries any job
-- that survives an isolate restart or transient DO failure. The sitting is part of the key because
-- reopenRun deliberately reuses a run id for a new sitting.
CREATE TABLE memory_episode_jobs (
  project_id      TEXT NOT NULL REFERENCES projects(id),
  run_id          TEXT NOT NULL REFERENCES runs(id),
  sitting         INTEGER NOT NULL,
  requested_at    TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  last_attempt_at TEXT,
  PRIMARY KEY (run_id, sitting)
);

CREATE INDEX idx_memory_episode_jobs_project ON memory_episode_jobs (project_id, requested_at);
