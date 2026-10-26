-- Existing plans retain their rollout policy; newly created plans require evidence.
ALTER TABLE plans ADD COLUMN readiness_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN readiness_generation INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER task_readiness_generation AFTER UPDATE OF status, body, execution_spec ON tasks
WHEN NEW.status IS NOT OLD.status OR NEW.body IS NOT OLD.body OR NEW.execution_spec IS NOT OLD.execution_spec
BEGIN
  UPDATE tasks SET readiness_generation = OLD.readiness_generation + 1 WHERE id = NEW.id;
END;
CREATE TABLE entity_readiness_overrides (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  subject_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('readiness','implementation')),
  context_fingerprint TEXT NOT NULL,
  reason TEXT NOT NULL,
  revision_json TEXT,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_readiness_overrides_subject ON entity_readiness_overrides(project_id,subject_id,scope,created_at);
