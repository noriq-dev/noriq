-- PLNR-486: negotiated mission Runs survive daemon restart only through a bounded, server-issued
-- lease epoch. Old processes cannot mutate after adoption advances the epoch.

ALTER TABLE runs ADD COLUMN lease_epoch INTEGER NOT NULL DEFAULT 1 CHECK (lease_epoch > 0);
ALTER TABLE runs ADD COLUMN reconciliation_deadline TEXT;
ALTER TABLE mission_task_attempts ADD COLUMN lease_epoch INTEGER NOT NULL DEFAULT 1 CHECK (lease_epoch > 0);

CREATE INDEX idx_runs_reconciliation_deadline
  ON runs (project_id, reconciliation_deadline)
  WHERE reconciliation_deadline IS NOT NULL;
