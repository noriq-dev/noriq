-- PLNR-485: server-authorized, idempotent task attempts owned by one single-root mission Run.

CREATE TABLE mission_task_attempts (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan_dispatch_id   TEXT NOT NULL REFERENCES plan_dispatches(id) ON DELETE CASCADE,
  root_run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id            TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  child_execution_id TEXT NOT NULL REFERENCES execution_nodes(id) ON DELETE CASCADE,
  claim_id           TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  agent_id           TEXT NOT NULL REFERENCES agents(id),
  begin_hash         TEXT NOT NULL,
  begin_ack          TEXT,
  settle_hash        TEXT,
  settle_ack         TEXT,
  status             TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','review','failed','cancelled','interrupted')),
  begun_at           TEXT NOT NULL,
  settled_at         TEXT,
  updated_at         TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_mission_attempt_live_task
  ON mission_task_attempts (task_id)
  WHERE status = 'running';
CREATE INDEX idx_mission_attempt_root_status
  ON mission_task_attempts (root_run_id, status, begun_at);
