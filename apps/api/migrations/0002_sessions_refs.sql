-- Human sessions (Phase 2) and git awareness refs (Phase 4).

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,          -- SHA-256 of the cookie value
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

-- Task ↔ branch / PR / commit links (read-only git awareness).
CREATE TABLE task_refs (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  kind       TEXT NOT NULL CHECK (kind IN ('branch', 'pr', 'commit')),
  ref        TEXT NOT NULL,             -- branch name, PR number/url, or sha
  url        TEXT,
  state      TEXT,                      -- e.g. open / merged / closed (PRs)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (task_id, kind, ref)
);
CREATE INDEX idx_task_refs_task ON task_refs (task_id);
