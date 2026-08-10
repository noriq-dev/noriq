-- PLNR-297: generation-scoped frozen quality facts. This is disposable read-model data and
-- cascades with its generation; canonical history remains in D1 project_quality_events.
CREATE TABLE analytics_quality_event_rows (
  generation_id TEXT NOT NULL REFERENCES analytics_generations(id) ON DELETE CASCADE,
  event_id       TEXT NOT NULL,
  run_id         TEXT,
  sitting        INTEGER,
  body           TEXT NOT NULL,
  row_checksum   TEXT NOT NULL,
  PRIMARY KEY (generation_id, event_id)
);

CREATE INDEX idx_analytics_quality_events_sitting
  ON analytics_quality_event_rows (generation_id, run_id, sitting);
