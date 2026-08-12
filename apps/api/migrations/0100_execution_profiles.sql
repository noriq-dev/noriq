-- PLNR-487: secret-free, repo-scoped execution-profile selection. The JSON snapshot contains
-- only the shared CommissionedExecutionProfile identity (id, fingerprints, generation and the
-- attestation capability bit); machine configuration and probe evidence remain Runner-local.

ALTER TABLE runs ADD COLUMN execution_profile_id TEXT;
ALTER TABLE runs ADD COLUMN execution_profile TEXT;

ALTER TABLE plan_dispatches ADD COLUMN execution_profile_id TEXT;
ALTER TABLE plan_dispatches ADD COLUMN execution_profile TEXT;

CREATE INDEX idx_runs_execution_profile_live
  ON runs (runner_id, execution_profile_id, status)
  WHERE execution_profile_id IS NOT NULL;

-- A slot lease is deliberately independent of the Run FK so it can be acquired before the Run
-- row becomes visible. The authority deletes it if Run insertion fails and on every terminal
-- path; acquisition also reaps terminal leases and missing-Run leases after a short reservation
-- grace period before choosing a slot.
CREATE TABLE execution_profile_leases (
  run_id TEXT PRIMARY KEY,
  runner_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot > 0),
  acquired_at TEXT NOT NULL,
  UNIQUE (runner_id, profile_id, slot)
);
