-- PLNR-111: give events a monotonic sequence independent of row lifecycle.
--
-- events.id is a TEXT PK, so the table's rowid is the implicit *non*-AUTOINCREMENT
-- rowid. The per-agent my_updates cursor (sync.ts) is a global rowid high-water mark.
-- When deleteProject removes the row holding the current MAX(rowid), SQLite REUSES
-- that rowid for the next insert; any agent whose cursor already sits at/above it then
-- has `rowid > cursor` exclude the new event → a dropped direct-message / held-task
-- comment notice. AUTOINCREMENT would fix this but can't be added to an existing table
-- (and events can't be rebuilt — it's an FK target and migrations are additive).
--
-- Instead: a dedicated single-row counter that only ever climbs, assigned to each new
-- event by an AFTER INSERT trigger (atomic with the insert, so no app-code change to
-- the append path). deleteProject deletes events but NEVER touches event_seq, so the
-- counter is immune to row reuse. The cursor moves onto events.global_seq.
CREATE TABLE event_seq (
  id   INTEGER PRIMARY KEY CHECK (id = 0),
  next INTEGER NOT NULL
);

ALTER TABLE events ADD COLUMN global_seq INTEGER;

-- Backfill existing rows with their current rowid (monotonic to date, and distinct),
-- then seed the counter above the current max so new events never collide with history.
UPDATE events SET global_seq = rowid WHERE global_seq IS NULL;
INSERT INTO event_seq (id, next) VALUES (0, (SELECT COALESCE(MAX(rowid), 0) FROM events));

-- Assign the next counter value to every new event, inside the insert's transaction.
-- (SQLite recursive triggers are off by default, so the self-UPDATE won't re-fire.)
CREATE TRIGGER events_assign_global_seq AFTER INSERT ON events
WHEN NEW.global_seq IS NULL
BEGIN
  UPDATE event_seq SET next = next + 1 WHERE id = 0;
  UPDATE events SET global_seq = (SELECT next FROM event_seq WHERE id = 0) WHERE rowid = NEW.rowid;
END;

CREATE INDEX idx_events_global_seq ON events (global_seq);
