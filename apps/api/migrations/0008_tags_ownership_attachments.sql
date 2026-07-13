-- Tags replace categories (multi-tag per task), project ownership/visibility,
-- task types, and file attachments (R2). PLNR-31/32/47/48/50.

-- Project ownership: ungrouped projects become owner-only visible.
ALTER TABLE projects ADD COLUMN owner_user_id TEXT REFERENCES users(id);
UPDATE projects SET owner_user_id = (SELECT id FROM users WHERE role = 'admin' AND disabled = 0 ORDER BY created_at LIMIT 1);

-- Categories → tags, many-to-many. Existing single-category assignments migrate.
ALTER TABLE categories RENAME TO tags;
CREATE TABLE task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  tag_id  TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (task_id, tag_id)
);
CREATE INDEX idx_task_tags_tag ON task_tags (tag_id);
INSERT INTO task_tags (task_id, tag_id) SELECT id, category_id FROM tasks WHERE category_id IS NOT NULL;
-- tasks.category_id is retired in place (kept for schema stability; no longer written).

-- Task type (PLNR-32).
ALTER TABLE tasks ADD COLUMN type TEXT NOT NULL DEFAULT 'feature'
  CHECK (type IN ('feature', 'bug', 'chore', 'research'));

-- Attachments (PLNR-31) — bytes in R2, metadata here.
CREATE TABLE attachments (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks(id),
  filename         TEXT NOT NULL,
  content_type     TEXT NOT NULL DEFAULT 'application/octet-stream',
  size             INTEGER NOT NULL,
  r2_key           TEXT NOT NULL UNIQUE,
  uploaded_by_kind TEXT NOT NULL CHECK (uploaded_by_kind IN ('human', 'agent')),
  uploaded_by      TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_attachments_task ON attachments (task_id);

-- Messages from ANY actor (humans can message agents directly / broadcast).
CREATE TABLE messages_new (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  from_kind     TEXT NOT NULL CHECK (from_kind IN ('agent', 'human')),
  from_id       TEXT NOT NULL,
  from_name     TEXT NOT NULL DEFAULT '',
  to_agent_id   TEXT REFERENCES agents(id),  -- null = broadcast (any agent should handle)
  body          TEXT NOT NULL,
  ref_task_id   TEXT REFERENCES tasks(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO messages_new (id, project_id, from_kind, from_id, from_name, to_agent_id, body, ref_task_id, created_at)
  SELECT m.id, m.project_id, 'agent', m.from_agent_id, COALESCE(a.name, ''), m.to_agent_id, m.body, m.ref_task_id, m.created_at
  FROM messages m LEFT JOIN agents a ON a.id = m.from_agent_id;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
CREATE INDEX idx_messages_project ON messages (project_id);
CREATE INDEX idx_messages_inbox ON messages (to_agent_id, created_at);
