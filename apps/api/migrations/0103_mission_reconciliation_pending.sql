-- PLNR-490: REST re-registration records that adoption is needed, but does not start the clock.
-- Only an accepted mission.v2 WebSocket hello proves the daemon has a channel that can answer.

ALTER TABLE runs ADD COLUMN reconciliation_pending INTEGER NOT NULL DEFAULT 0
  CHECK (reconciliation_pending IN (0, 1));

CREATE INDEX idx_runs_reconciliation_pending
  ON runs (runner_id, project_id)
  WHERE reconciliation_pending = 1;
