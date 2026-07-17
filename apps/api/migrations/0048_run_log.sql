-- RUN-74: the run TRANSCRIPT — an append-only, role-labeled stream of everything a run said.
-- Exists because runs.log_tail is one last-writer-wins blob from the core agent only: after an
-- inline-reviewer refusal, the reviewer's report (the WHY) never reached the server at all.
-- (run_id, seq) is the daemon's monotonic ordering; INSERT OR IGNORE makes redelivery a no-op.
CREATE TABLE run_log_segments (
  run_id     TEXT NOT NULL REFERENCES runs(id),
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('agent', 'reviewer', 'verify', 'system')),
  round      INTEGER,        -- reviewer rounds; null for everything else
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
