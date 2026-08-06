-- PLNR-247: durable dedup ledger for ProjectMemory outbox delivery. Delivery is at-least-once
-- (the outbox retries an undelivered row); THIS table is what makes ProjectRoom's receiving
-- end idempotent — a redelivered operation id is recognized and acknowledged without a second
-- event. An in-memory set would not survive an isolate recycle, which is exactly the gap this
-- closes. References `projects`, which predates it, so no FK-ordering concern in this file.
--
-- Distinct from ProjectMemory's OWN `applied_operations` table (PLNR-245, lives in the DO's
-- SQLite): that one dedupes WRITE requests reaching the canonical store; this one dedupes
-- DELIVERY of an already-committed mutation into the D1 event log. Two different failure modes,
-- two different ledgers, on two different sides of the outbox.
CREATE TABLE memory_event_dedup (
  operation_id TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  applied_at   TEXT NOT NULL
);
CREATE INDEX idx_memory_event_dedup_project ON memory_event_dedup (project_id);
