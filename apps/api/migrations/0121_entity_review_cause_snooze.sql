-- PLNR-594 / P2-C: timed snooze on review causes.
-- Extends status CHECK with 'snoozed' and adds snoozed_until.
-- entity_review_causes is not referenced by other tables (FK only outbound to projects),
-- so rebuild is safe and additive for the rest of the schema.

CREATE TABLE entity_review_causes_new (
  project_id    TEXT NOT NULL REFERENCES projects(id),
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('task','plan','doc')),
  subject_id    TEXT NOT NULL,
  cause         TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('open','dismissed','snoozed')),
  detail        TEXT NOT NULL DEFAULT '',
  snoozed_until TEXT,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor_kind    TEXT,
  actor_name    TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (project_id, subject_type, subject_id, cause),
  CHECK (status != 'snoozed' OR snoozed_until IS NOT NULL)
);
INSERT INTO entity_review_causes_new
  (project_id, subject_type, subject_id, cause, status, detail, snoozed_until, updated_at, actor_kind, actor_name)
SELECT project_id, subject_type, subject_id, cause, status, detail, NULL, updated_at, actor_kind, actor_name
  FROM entity_review_causes;
DROP TABLE entity_review_causes;
ALTER TABLE entity_review_causes_new RENAME TO entity_review_causes;
CREATE INDEX idx_entity_review_causes_open
  ON entity_review_causes (project_id, status, cause);
CREATE INDEX idx_entity_review_causes_snooze
  ON entity_review_causes (project_id, status, snoozed_until)
  WHERE status = 'snoozed';
