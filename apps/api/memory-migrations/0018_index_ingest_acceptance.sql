-- PLNR-397: bind a staged generation to the active generation observed when ingest began,
-- and retain bounded canonical-byte accounting for every accepted batch.
-- `base_id` remains opaque; activation compares only generation ids.
ALTER TABLE index_generations ADD COLUMN predecessor_generation_id TEXT;
ALTER TABLE index_batches ADD COLUMN content_bytes INTEGER NOT NULL DEFAULT 0;
