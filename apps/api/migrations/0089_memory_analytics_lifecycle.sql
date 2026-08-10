-- PLNR-293: retry scheduling is durable D1 job metadata, not an in-memory timer. A failed
-- extraction records its next eligible retry; a fresh canonical change resets the backoff.
ALTER TABLE memory_analytics_jobs ADD COLUMN next_retry_at TEXT;
