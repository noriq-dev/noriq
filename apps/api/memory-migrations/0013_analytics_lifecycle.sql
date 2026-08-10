-- PLNR-293: record how a disposable analytics generation was produced so health can expose the
-- last successful incremental and full rebuild independently. Existing PLNR-292 generations
-- predate this distinction and are conservatively classified as full rebuilds.
ALTER TABLE analytics_generations
  ADD COLUMN build_mode TEXT NOT NULL DEFAULT 'full'
  CHECK (build_mode IN ('incremental','full'));
