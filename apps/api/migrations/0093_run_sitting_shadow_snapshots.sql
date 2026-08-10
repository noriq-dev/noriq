-- PLNR-300: immutable pre-execution shadow evidence, one row per real run sitting. The JSON
-- payload and its hash are never updated; terminal episode and later quality refs append in the
-- child table so outcome knowledge cannot rewrite what was knowable at dispatch.
CREATE TABLE run_sitting_shadow_snapshots (
  run_id                     TEXT NOT NULL,
  sitting                    INTEGER NOT NULL CHECK (sitting > 0),
  project_id                 TEXT NOT NULL REFERENCES projects(id),
  commissioning_fingerprint TEXT NOT NULL,
  snapshot                   TEXT NOT NULL,
  snapshot_hash              TEXT NOT NULL,
  capture_status             TEXT NOT NULL CHECK (capture_status IN ('complete','partial','failed')),
  capture_error              TEXT,
  captured_at                TEXT NOT NULL,
  PRIMARY KEY (run_id, sitting),
  FOREIGN KEY (run_id, sitting) REFERENCES run_sitting_intelligence(run_id, sitting) ON DELETE CASCADE
);

CREATE INDEX idx_run_sitting_shadow_project
  ON run_sitting_shadow_snapshots (project_id, captured_at, run_id, sitting);

CREATE TABLE run_sitting_shadow_outcome_refs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  run_id      TEXT NOT NULL,
  sitting     INTEGER NOT NULL CHECK (sitting > 0),
  ref_type    TEXT NOT NULL CHECK (ref_type IN ('episode','quality_event')),
  ref_id      TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (run_id, sitting) REFERENCES run_sitting_intelligence(run_id, sitting) ON DELETE CASCADE,
  UNIQUE (project_id, run_id, sitting, ref_type, ref_id)
);

CREATE INDEX idx_run_sitting_shadow_outcomes
  ON run_sitting_shadow_outcome_refs (project_id, run_id, sitting, observed_at, id);
