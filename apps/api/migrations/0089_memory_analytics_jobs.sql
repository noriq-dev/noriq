-- PLNR-292: one coalescing rebuild request per project. Episode delivery inserts this job only
-- after canonical ProjectMemory recording succeeds; scheduled reconciliation performs the
-- cross-store replay away from ProjectRoom mutation latency.
CREATE TABLE memory_analytics_jobs (
  project_id      TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  requested_at    TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  last_attempt_at TEXT
);
