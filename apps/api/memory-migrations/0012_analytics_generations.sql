-- PLNR-292: disposable, generation-scoped Project Intelligence read models. Canonical episodes
-- remain in `episodes`; canonical coordination/orchestration remains in D1. Snapshot rows are a
-- bounded replay inbox for one build and analytics_rows are replaceable derived output.
CREATE TABLE analytics_generations (
  id                         TEXT PRIMARY KEY,
  status                     TEXT NOT NULL CHECK (status IN ('building','complete','failed')),
  extraction_version         TEXT NOT NULL,
  base_generation_id         TEXT,
  source_memory_revision     INTEGER NOT NULL,
  d1_event_watermark         INTEGER,
  orchestration_watermark    TEXT,
  completeness               TEXT NOT NULL,
  row_count                  INTEGER NOT NULL DEFAULT 0,
  checksum                   TEXT,
  created_at                 TEXT NOT NULL,
  completed_at               TEXT,
  error                      TEXT
);

CREATE TABLE analytics_active_generation (
  id            INTEGER PRIMARY KEY CHECK (id = 0),
  generation_id TEXT REFERENCES analytics_generations(id)
);
INSERT INTO analytics_active_generation (id, generation_id) VALUES (0, NULL);

CREATE TABLE analytics_snapshot_rows (
  generation_id TEXT NOT NULL REFERENCES analytics_generations(id) ON DELETE CASCADE,
  source_kind   TEXT NOT NULL CHECK (source_kind IN ('execution_node','execution_event')),
  source_key    TEXT NOT NULL,
  run_id        TEXT,
  sitting       INTEGER,
  execution_id  TEXT,
  body          TEXT NOT NULL,
  PRIMARY KEY (generation_id, source_kind, source_key)
);

CREATE TABLE analytics_rows (
  generation_id TEXT NOT NULL REFERENCES analytics_generations(id) ON DELETE CASCADE,
  episode_id    TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  sitting       INTEGER NOT NULL,
  normalized    TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  row_checksum  TEXT NOT NULL,
  PRIMARY KEY (generation_id, episode_id),
  UNIQUE (generation_id, run_id, sitting)
);

CREATE INDEX idx_analytics_rows_run ON analytics_rows (generation_id, run_id, sitting);
CREATE INDEX idx_analytics_snapshot_run ON analytics_snapshot_rows (generation_id, run_id, sitting);
CREATE INDEX idx_analytics_snapshot_execution ON analytics_snapshot_rows (generation_id, execution_id);
CREATE INDEX idx_analytics_generations_status ON analytics_generations (status, completed_at);
