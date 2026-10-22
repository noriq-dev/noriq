-- PLNR-585 (P1-G): opt-in dormancy thresholds.
-- dormancy_quiet_seconds NULL = off (default). When set, quiet period opens
-- advisory `dormant` review cause only — never auto-closes subjects.
-- content_activity_at tracks last fingerprint-affecting write (≠ updated_at).

ALTER TABLE projects ADD COLUMN dormancy_quiet_seconds INTEGER;

ALTER TABLE tasks ADD COLUMN content_activity_at TEXT;
UPDATE tasks SET content_activity_at = created_at WHERE content_activity_at IS NULL;

ALTER TABLE plans ADD COLUMN content_activity_at TEXT;
UPDATE plans SET content_activity_at = created_at WHERE content_activity_at IS NULL;

ALTER TABLE docs ADD COLUMN content_activity_at TEXT;
UPDATE docs SET content_activity_at = created_at WHERE content_activity_at IS NULL;

-- Optional per-entity quiet override (positive seconds). Absence = inherit project.
CREATE TABLE entity_dormancy_overrides (
  project_id    TEXT NOT NULL REFERENCES projects(id),
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('task','plan','doc')),
  subject_id    TEXT NOT NULL,
  quiet_seconds INTEGER NOT NULL CHECK (quiet_seconds > 0),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (project_id, subject_type, subject_id)
);
CREATE INDEX idx_entity_dormancy_overrides_project
  ON entity_dormancy_overrides (project_id);
