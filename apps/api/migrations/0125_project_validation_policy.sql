ALTER TABLE projects ADD COLUMN validation_policy TEXT NOT NULL DEFAULT 'legacy' CHECK (validation_policy IN ('legacy','strict'));
ALTER TABLE projects ADD COLUMN validation_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN direction_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE claims ADD COLUMN release_reason TEXT;
CREATE TABLE task_direction_markers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('comment','signal')),
  source_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_assessment_id TEXT,
  resolved_at TEXT,
  UNIQUE(task_id, source_type, source_id)
);
CREATE INDEX idx_task_direction_unresolved ON task_direction_markers(project_id,task_id,resolved_at);
