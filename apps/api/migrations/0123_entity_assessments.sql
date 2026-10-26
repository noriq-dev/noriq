-- Evidence is separate from legacy attestations; existing records are never upgraded.
CREATE TABLE entity_assessments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  subject_type TEXT NOT NULL CHECK(subject_type IN ('task','plan','doc')),
  subject_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('readiness','implementation','document')),
  content_fingerprint TEXT NOT NULL,
  context_fingerprint TEXT NOT NULL,
  assessment_json TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_entity_assessments_subject ON entity_assessments(project_id, subject_type, subject_id, purpose, created_at);
