-- PLNR-297: canonical, append-only downstream quality observations. Task/run ids are soft
-- historical references on purpose: deleting or relinking today's task must not erase a fact
-- observed about an earlier episode. Application code never UPDATEs or DELETEs these rows except
-- as part of deleting the entire owning project.
CREATE TABLE project_quality_events (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id),
  operation_key         TEXT NOT NULL,
  operation_fingerprint TEXT NOT NULL,
  event_type            TEXT NOT NULL CHECK (event_type IN ('task_reopened','work_reverted','regression_task_linked')),
  task_id               TEXT NOT NULL,
  related_task_id       TEXT,
  run_id                TEXT,
  sitting               INTEGER CHECK (sitting IS NULL OR sitting > 0),
  orchestration_id      TEXT,
  execution_id          TEXT,
  artifact_ref          TEXT,
  source_kind           TEXT NOT NULL CHECK (source_kind IN ('coordination_event','explicit_user_action')),
  source_event_id       TEXT,
  source_event_seq      INTEGER,
  actor_kind            TEXT NOT NULL CHECK (actor_kind IN ('agent','human','system')),
  actor_id              TEXT NOT NULL,
  observed_at           TEXT NOT NULL,
  provenance            TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT NOT NULL,
  UNIQUE (project_id, operation_key),
  CHECK ((run_id IS NULL) = (sitting IS NULL)),
  CHECK ((event_type = 'regression_task_linked') = (related_task_id IS NOT NULL)),
  CHECK ((event_type = 'work_reverted') = (artifact_ref IS NOT NULL)),
  CHECK ((source_kind = 'coordination_event') = (source_event_id IS NOT NULL))
);

CREATE INDEX idx_project_quality_events_observed
  ON project_quality_events (project_id, observed_at, id);
CREATE INDEX idx_project_quality_events_sitting
  ON project_quality_events (project_id, run_id, sitting);
CREATE INDEX idx_project_quality_events_task
  ON project_quality_events (project_id, task_id);
