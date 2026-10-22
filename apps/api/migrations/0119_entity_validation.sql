-- PLNR-576..580: entity validation records, doc@version pins, supersession, review dismissals.
-- Additive only (CLAUDE.md). Entity data stays in D1 — not ProjectMemory.

CREATE TABLE entity_validations (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  subject_type        TEXT NOT NULL CHECK (subject_type IN ('task','plan','doc')),
  subject_id          TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  validated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor_kind          TEXT NOT NULL CHECK (actor_kind IN ('agent','human','system')),
  actor_id            TEXT,
  actor_name          TEXT NOT NULL DEFAULT '',
  baselines_json      TEXT NOT NULL DEFAULT '{}',
  note                TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_entity_validations_subject
  ON entity_validations (project_id, subject_type, subject_id, validated_at DESC);
CREATE INDEX idx_entity_validations_project_validated
  ON entity_validations (project_id, validated_at DESC);

-- Per-cause dismissals / human flags. status=open means the cause is active for the inbox;
-- dismissed removes it from the inbox without inventing validity. human_flagged is written
-- as an open row when a human flags a subject.
CREATE TABLE entity_review_causes (
  project_id   TEXT NOT NULL REFERENCES projects(id),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('task','plan','doc')),
  subject_id   TEXT NOT NULL,
  cause        TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('open','dismissed')),
  detail       TEXT NOT NULL DEFAULT '',
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor_kind   TEXT,
  actor_name   TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (project_id, subject_type, subject_id, cause)
);
CREATE INDEX idx_entity_review_causes_open
  ON entity_review_causes (project_id, status, cause);

-- Doc@version pins on task↔doc links (NULL = legacy unpinned / floating).
ALTER TABLE task_docs ADD COLUMN pinned_version INTEGER;

-- Plan-level settled-doc pins (distinct from plan_docs working scratch).
CREATE TABLE plan_doc_refs (
  plan_id         TEXT NOT NULL REFERENCES plans(id),
  doc_id          TEXT NOT NULL REFERENCES docs(id),
  pinned_version  INTEGER,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (plan_id, doc_id)
);
CREATE INDEX idx_plan_doc_refs_doc ON plan_doc_refs (doc_id);

-- Supersession: new current points at prior; prior stays readable. Reverse lookup = superseded by.
ALTER TABLE tasks ADD COLUMN supersedes_task_id TEXT REFERENCES tasks(id);
ALTER TABLE plans ADD COLUMN supersedes_plan_id TEXT REFERENCES plans(id);
ALTER TABLE docs ADD COLUMN supersedes_doc_id TEXT REFERENCES docs(id);

CREATE INDEX idx_tasks_supersedes ON tasks (supersedes_task_id);
CREATE INDEX idx_plans_supersedes ON plans (supersedes_plan_id);
CREATE INDEX idx_docs_supersedes ON docs (supersedes_doc_id);
