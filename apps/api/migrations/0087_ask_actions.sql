-- Durable, user-confirmed Ask mutations. A model may only create a pending proposal; the
-- stored normalized payload is executed once, after a later authenticated human approval.
CREATE TABLE ask_actions (
  id                TEXT PRIMARY KEY,
  thread_id         TEXT NOT NULL REFERENCES ask_threads(id),
  message_id        TEXT NOT NULL REFERENCES ask_messages(id),
  generation_id     TEXT REFERENCES ask_generations(id),
  user_id           TEXT NOT NULL REFERENCES users(id),
  project_id        TEXT NOT NULL,
  type              TEXT NOT NULL,
  summary           TEXT NOT NULL,
  arguments_json    TEXT NOT NULL,
  expected_json     TEXT NOT NULL DEFAULT '{}',
  required_action   TEXT NOT NULL DEFAULT 'contribute',
  operation_key     TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','executing','approved','rejected','failed')),
  result_json       TEXT,
  error             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  settled_at        TEXT,
  UNIQUE (user_id, operation_key)
);
CREATE INDEX idx_ask_actions_thread_created ON ask_actions (thread_id, created_at, id);
CREATE INDEX idx_ask_actions_generation ON ask_actions (generation_id, created_at, id);
CREATE INDEX idx_ask_actions_user_status ON ask_actions (user_id, status, updated_at DESC);
