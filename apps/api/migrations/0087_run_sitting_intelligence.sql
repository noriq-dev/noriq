-- PLNR-291: immutable commissioning facts and late Runner evidence are keyed by the real
-- execution identity: (run_id, sitting). A run can be continued under the same run id, while
-- its task, spec, workflow, budget, and plan controls all remain mutable. `commissioning` is
-- therefore INSERT-only in application code. Runner-owned facts are separate nullable columns
-- so a late or redelivered telemetry frame can enrich this sitting without rewriting what the
-- server commissioned.
CREATE TABLE run_sitting_intelligence (
  run_id                    TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sitting                   INTEGER NOT NULL CHECK (sitting > 0),
  project_id                TEXT NOT NULL REFERENCES projects(id),
  commissioning             TEXT NOT NULL,
  commissioning_fingerprint TEXT NOT NULL,
  executed_specs            TEXT,
  executed_config           TEXT,
  captured_at               TEXT NOT NULL,
  runner_observed_at        TEXT,
  PRIMARY KEY (run_id, sitting)
);

CREATE INDEX idx_run_sitting_intelligence_project
  ON run_sitting_intelligence (project_id, captured_at);
