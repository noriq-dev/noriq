-- PLNR-496: exact durable mapping between a Runner mission question and Noriq's human-facing signal.

CREATE TABLE mission_questions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  runner_id TEXT NOT NULL REFERENCES runners(id) ON DELETE CASCADE,
  root_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  attempt_id TEXT REFERENCES mission_task_attempts(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  signal_id TEXT NOT NULL UNIQUE REFERENCES signals(id) ON DELETE CASCADE,
  sitting INTEGER NOT NULL CHECK (sitting > 0),
  execution_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL CHECK (lease_epoch > 0),
  prompt TEXT NOT NULL,
  publication_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','answered','abandoned')),
  answer_id TEXT UNIQUE,
  answer TEXT,
  published_at TEXT NOT NULL,
  answered_at TEXT,
  abandoned_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (root_run_id, question_id)
);

CREATE INDEX idx_mission_questions_runner_state
  ON mission_questions (runner_id, state, updated_at);
CREATE INDEX idx_mission_questions_attempt_state
  ON mission_questions (attempt_id, state);
