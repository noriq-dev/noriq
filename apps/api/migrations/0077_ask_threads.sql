-- Durable, per-user Ask conversations. Threads are user-owned rather than project-owned because
-- global Ask spans every project the user can access. Messages retain the public reasoning
-- summary and grounding metadata needed to reconstruct the conversation UI after a reload.
-- User deletion removes messages before threads in index.ts's explicit FK-ordered cascade.
CREATE TABLE ask_threads (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  title       TEXT NOT NULL,
  archived_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_ask_threads_user_updated ON ask_threads (user_id, archived_at, updated_at DESC);

CREATE TABLE ask_messages (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT NOT NULL REFERENCES ask_threads(id),
  role           TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content        TEXT NOT NULL,
  sources_json   TEXT NOT NULL DEFAULT '[]',
  reasoning      TEXT NOT NULL DEFAULT '',
  trace_json     TEXT NOT NULL DEFAULT '[]',
  retrieval_mode TEXT,
  model          TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_ask_messages_thread_created ON ask_messages (thread_id, created_at, id);
