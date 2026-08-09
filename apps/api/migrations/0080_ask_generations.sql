-- Server-owned Ask generations. The D1 row is the durable hand-off between the HTTP request,
-- the alarm-driven generation worker, and any number of reconnecting browser streams.
CREATE TABLE ask_generations (
  id               TEXT PRIMARY KEY,
  thread_id        TEXT NOT NULL REFERENCES ask_threads(id),
  message_id       TEXT NOT NULL UNIQUE REFERENCES ask_messages(id),
  user_id          TEXT NOT NULL REFERENCES users(id),
  question         TEXT NOT NULL,
  history_json     TEXT NOT NULL DEFAULT '[]',
  status           TEXT NOT NULL CHECK (status IN ('pending', 'searching', 'generating', 'completed', 'failed')),
  answer           TEXT NOT NULL DEFAULT '',
  reasoning        TEXT NOT NULL DEFAULT '',
  sources_json     TEXT NOT NULL DEFAULT '[]',
  trace_json       TEXT NOT NULL DEFAULT '[]',
  retrieval_mode   TEXT,
  model             TEXT,
  graph_enhanced    INTEGER NOT NULL DEFAULT 0,
  finish_reason     TEXT,
  truncated         INTEGER NOT NULL DEFAULT 0,
  error              TEXT,
  revision           INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_ask_generations_thread ON ask_generations (thread_id, created_at DESC);
CREATE INDEX idx_ask_generations_user_status ON ask_generations (user_id, status, updated_at DESC);
