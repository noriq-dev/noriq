-- PLNR-80: multiple boards per project (e.g. environments, planning stages).
-- A board is a named lane collection; every task belongs to exactly one board.
-- Additive only (D1 enforces FKs during migration): create the table, add the
-- column, then backfill one default "Main" board per project and assign every
-- existing task to it so nothing falls off the board.

CREATE TABLE boards (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  name        TEXT NOT NULL,
  "order"     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_boards_project ON boards(project_id);

ALTER TABLE tasks ADD COLUMN board_id TEXT REFERENCES boards(id);

-- One default board per existing project…
INSERT INTO boards (id, project_id, name, "order", created_at)
  SELECT 'brd_' || lower(hex(randomblob(10))), id, 'Main', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM projects;

-- …and route every existing task onto it (one board per project at this point,
-- so the correlated subquery is unambiguous).
UPDATE tasks
   SET board_id = (SELECT b.id FROM boards b WHERE b.project_id = tasks.project_id)
 WHERE board_id IS NULL;
