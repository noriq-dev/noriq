-- PLNR-483: retain the exact release boundary for a Copilot claim and durably retry its derived
-- Project Memory episode. The release remains canonical even when ProjectMemory is unavailable.

ALTER TABLE claims ADD COLUMN release_status TEXT
  CHECK (release_status IS NULL OR release_status IN ('todo', 'review', 'done', 'blocked'));
ALTER TABLE claims ADD COLUMN commit_id TEXT;
ALTER TABLE claims ADD COLUMN reported_evidence TEXT;

CREATE TABLE copilot_episode_jobs (
  claim_id        TEXT PRIMARY KEY REFERENCES claims(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  requested_at    TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  last_attempt_at TEXT
);

CREATE INDEX idx_copilot_episode_jobs_project
  ON copilot_episode_jobs (project_id, requested_at);
