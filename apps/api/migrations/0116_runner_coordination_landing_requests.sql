-- PLNR-521: bind post-terminal coordination to one durable human landing request.

ALTER TABLE runner_coordination_leases ADD COLUMN landing_request_id TEXT;
ALTER TABLE runner_coordination_leases ADD COLUMN last_recover_from_fence INTEGER;
ALTER TABLE runner_coordination_waits ADD COLUMN landing_request_id TEXT;

CREATE INDEX idx_runner_coordination_landing_request
  ON runner_coordination_leases (job_id, landing_request_id)
  WHERE landing_request_id IS NOT NULL;
