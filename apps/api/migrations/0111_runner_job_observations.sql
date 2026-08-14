-- PLNR-509: compact, structured RunnerJob stage evidence.
-- Raw event payloads remain the append-only protocol journal. This table is the
-- durable read model for live inspection and later Project Intelligence projection.

ALTER TABLE runner_jobs ADD COLUMN intelligence_context TEXT;
ALTER TABLE runner_jobs ADD COLUMN intelligence_started_received_at TEXT;
ALTER TABLE runner_jobs ADD COLUMN intelligence_finished_received_at TEXT;
ALTER TABLE runner_jobs ADD COLUMN human_wait_started_received_at TEXT;
ALTER TABLE runner_jobs ADD COLUMN human_wait_ms INTEGER NOT NULL DEFAULT 0
  CHECK (human_wait_ms >= 0);

ALTER TABLE runner_job_items ADD COLUMN intelligence_started_received_at TEXT;
ALTER TABLE runner_job_items ADD COLUMN intelligence_finished_received_at TEXT;

CREATE TABLE runner_job_observations (
  job_id TEXT NOT NULL REFERENCES runner_jobs(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL,
  task_id TEXT,
  stage TEXT NOT NULL CHECK (stage IN (
    'preflight','workspace','plan','setup','build','candidate','integrate','check',
    'review','repair','accept','preserve','finalize','human_wait','landing'
  )),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  actor TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled','skipped')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  usage TEXT,
  recovery TEXT CHECK (recovery IS NULL OR recovery IN ('none','journal_replay','process_recovery')),
  evidence TEXT,
  start_seq INTEGER CHECK (start_seq IS NULL OR start_seq > 0),
  finish_seq INTEGER CHECK (finish_seq IS NULL OR finish_seq > 0),
  start_received_at TEXT,
  finish_received_at TEXT,
  PRIMARY KEY (job_id, observation_id)
);

CREATE INDEX idx_runner_job_observations_cursor
  ON runner_job_observations (job_id, COALESCE(finish_seq, start_seq), observation_id);
CREATE INDEX idx_runner_job_observations_task_cursor
  ON runner_job_observations (job_id, task_id, COALESCE(finish_seq, start_seq), observation_id)
  WHERE task_id IS NOT NULL;
