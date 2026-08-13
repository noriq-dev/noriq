-- PLNR-498: minimal immutable commissioning and append-only reporting for RunnerJob protocol v2.

CREATE TABLE runner_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  runner_id TEXT NOT NULL REFERENCES runners(id),
  repo_ref TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('task','plan')),
  source_id TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL,
  expected_base_revision TEXT NOT NULL,
  assignment_id TEXT NOT NULL UNIQUE,
  orchestration_id TEXT NOT NULL UNIQUE REFERENCES orchestrations(id),
  status TEXT NOT NULL CHECK (status IN ('queued','assigned','running','waiting','succeeded','partial','failed','cancelled')),
  phase TEXT NOT NULL CHECK (phase IN ('preparing','planning','building','checking','reviewing','repairing','integrating','finalizing')),
  progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
  usage TEXT NOT NULL DEFAULT '{"inputTokens":0,"outputTokens":0,"cachedTokens":0,"costUsd":null,"calls":0}',
  final_result TEXT,
  warning_count INTEGER NOT NULL DEFAULT 0 CHECK (warning_count >= 0),
  last_event_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  assigned_at TEXT,
  started_at TEXT,
  cancel_requested_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_runner_jobs_project_created ON runner_jobs (project_id, created_at DESC);
CREATE INDEX idx_runner_jobs_runner_live ON runner_jobs (runner_id, status, created_at)
  WHERE status IN ('queued','assigned','running','waiting');

CREATE TRIGGER runner_jobs_immutable_snapshot
BEFORE UPDATE OF project_id, runner_id, repo_ref, source_kind, source_id, snapshot, snapshot_digest,
  expected_base_revision, assignment_id, orchestration_id, created_by, created_at ON runner_jobs
BEGIN
  SELECT RAISE(ABORT, 'RunnerJob commissioning fields are immutable');
END;

CREATE TABLE runner_job_items (
  job_id TEXT NOT NULL REFERENCES runner_jobs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  task_key TEXT NOT NULL,
  phase_order INTEGER NOT NULL CHECK (phase_order >= 0),
  task_order INTEGER NOT NULL CHECK (task_order >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending','running','accepted','failed','not_started','cancelled')),
  reservation_active INTEGER NOT NULL DEFAULT 1 CHECK (reservation_active IN (0,1)),
  plan TEXT,
  commit_revision TEXT,
  summary TEXT,
  findings TEXT NOT NULL DEFAULT '[]',
  projection_conflict TEXT,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, task_id)
);

CREATE UNIQUE INDEX idx_runner_job_items_live_task ON runner_job_items (task_id)
  WHERE reservation_active = 1;
CREATE INDEX idx_runner_job_items_job_order ON runner_job_items (job_id, phase_order, task_order, task_key);

CREATE TABLE runner_job_events (
  job_id TEXT NOT NULL REFERENCES runner_jobs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq > 0),
  assignment_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (job_id, seq)
);

CREATE TABLE runner_job_questions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES runner_jobs(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','answered','abandoned')),
  answer TEXT,
  published_at TEXT NOT NULL,
  answered_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (job_id, question_id)
);

CREATE INDEX idx_runner_job_questions_open ON runner_job_questions (job_id, state, published_at);
