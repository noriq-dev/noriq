-- PLNR-495: review is shared by successful and gated mission settlements. Preserve the exact
-- authoritative outcome so gate=landed can accept only successful work with consumed handoff.

ALTER TABLE mission_task_attempts ADD COLUMN outcome TEXT
  CHECK (outcome IS NULL OR outcome IN ('done','gated','failed','cancelled'));

CREATE INDEX idx_mission_attempt_landed_evidence
  ON mission_task_attempts (task_id, outcome, root_run_id)
  WHERE status = 'review' AND outcome = 'done';
