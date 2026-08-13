-- PLNR-488: immutable accepted-revision handoffs. A preserved handoff is explicitly not a
-- landing fact. It is retained indefinitely until an authorized exact-identity consumption
-- acknowledgement is recorded; even then the audit row remains for replay and deduplication.

CREATE TABLE mission_handoffs (
  root_run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  runner_id TEXT NOT NULL REFERENCES runners(id),
  handoff_id TEXT NOT NULL UNIQUE,
  backend TEXT NOT NULL,
  repository_key TEXT NOT NULL,
  checkpoint TEXT NOT NULL,
  revision TEXT NOT NULL,
  reference TEXT NOT NULL,
  identity_hash TEXT NOT NULL,
  preserved_at TEXT NOT NULL,
  consumed_at TEXT,
  consumption_id TEXT UNIQUE,
  consumed_by_kind TEXT,
  consumed_by_id TEXT,
  CHECK ((consumed_at IS NULL) = (consumption_id IS NULL)),
  CHECK ((consumed_at IS NULL) = (consumed_by_kind IS NULL)),
  CHECK ((consumed_at IS NULL) = (consumed_by_id IS NULL))
);

CREATE INDEX idx_mission_handoffs_runner_consumed
  ON mission_handoffs (runner_id, consumed_at)
  WHERE consumed_at IS NOT NULL;
