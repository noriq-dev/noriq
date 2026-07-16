-- PLNR-128: reusable work templates. A template is a SAVED create_plan skeleton
-- (title/body/taskDefaults/phases-with-newTasks as JSON) — teams run the same shape of
-- work repeatedly, and agents shouldn't re-derive it each time. Owned by the USER so it
-- reuses across projects. FK target (users) exists; user-deletion cascade updated.
CREATE TABLE templates (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  spec        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_templates_user ON templates (user_id);
