-- PLNR-520: server-owned, fenced coordination leases for RunnerJob checkouts.
-- These are intentionally separate from human/Copilot file_locks.

CREATE TABLE runner_coordination_fences (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository_key TEXT NOT NULL,
  lane TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, repository_key, lane)
);

CREATE TABLE runner_coordination_leases (
  lease_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  runner_id TEXT NOT NULL REFERENCES runners(id),
  checkout_id TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES runner_jobs(id) ON DELETE CASCADE,
  assignment_id TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id),
  idempotency_key TEXT NOT NULL,
  repository_key TEXT NOT NULL,
  lane TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('repository','paths','landing')),
  paths TEXT NOT NULL DEFAULT '[]',
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  expires_at TEXT NOT NULL,
  released_at TEXT,
  last_exchange_from_fence INTEGER,
  last_exchange_scope TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (job_id, assignment_id, idempotency_key)
);

CREATE INDEX idx_runner_coordination_conflicts
  ON runner_coordination_leases (project_id, repository_key, lane, expires_at);
CREATE INDEX idx_runner_coordination_job
  ON runner_coordination_leases (job_id, assignment_id);

CREATE TABLE runner_coordination_waits (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  runner_id TEXT NOT NULL REFERENCES runners(id),
  checkout_id TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES runner_jobs(id) ON DELETE CASCADE,
  assignment_id TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id),
  idempotency_key TEXT NOT NULL,
  repository_key TEXT NOT NULL,
  lane TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('repository','paths','landing')),
  paths TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, assignment_id, idempotency_key)
);

CREATE INDEX idx_runner_coordination_waits_job
  ON runner_coordination_waits (job_id, assignment_id);
