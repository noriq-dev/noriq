-- 0012: task archive (PLNR-73). Archived tasks are hidden from the board unless the
-- archive switch is on; done tasks auto-archive after 24h (a sweep sets archived_at).
-- Additive column — safe on D1.
ALTER TABLE tasks ADD COLUMN archived_at TEXT;
CREATE INDEX idx_tasks_archived ON tasks (project_id, archived_at);
