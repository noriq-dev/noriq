-- PLNR-182: first-class task↔doc relations. A task can cite the design/decision docs
-- it implements or must follow, set at creation time (create_task docIds) or later.
-- Both FK targets exist; deleteTask/deleteDoc/deleteProject cascades and moveTask's
-- severing gain this table (CLAUDE.md rule for new tables).
CREATE TABLE task_docs (
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  doc_id     TEXT NOT NULL REFERENCES docs(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (task_id, doc_id)
);
CREATE INDEX idx_task_docs_doc ON task_docs (doc_id);
