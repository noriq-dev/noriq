-- RUN-150: which STEP of a decomposed run a transcript segment came from.
--
-- Additive and nullable, as every migration here must be: null is the answer for an undecomposed
-- run — which is most of them — and for every segment written before this column existed. A second
-- attribution dimension beside `round` rather than a replacement, because a chain's step three can
-- still be on its second reviewer round, and one label could not say which.
ALTER TABLE run_log_segments ADD COLUMN step TEXT;
