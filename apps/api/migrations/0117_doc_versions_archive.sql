-- PLNR-539: immutable project-document history and reversible archive lifecycle.
-- The docs row remains the current revision for cheap reads and links. Every revision is
-- snapshotted in doc_versions; archived docs remain readable by exact id but leave normal
-- discovery and the operational vector index.
ALTER TABLE docs ADD COLUMN current_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE docs ADD COLUMN archived_at TEXT;

CREATE TABLE doc_versions (
  doc_id       TEXT NOT NULL REFERENCES docs(id),
  version      INTEGER NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  folder       TEXT NOT NULL DEFAULT '',
  tags_json    TEXT NOT NULL DEFAULT '[]',
  author_kind  TEXT NOT NULL DEFAULT 'agent',
  author_name  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (doc_id, version)
);
CREATE INDEX idx_doc_versions_doc_created ON doc_versions (doc_id, created_at DESC);
CREATE INDEX idx_docs_project_archive ON docs (project_id, archived_at, updated_at DESC);

-- Existing docs become version 1 at their last-known revision time. Tags are captured in a
-- deterministic JSON array so a historical read never inherits the current tag set.
INSERT INTO doc_versions (
  doc_id, version, name, description, body, folder, tags_json,
  author_kind, author_name, created_at
)
SELECT d.id, 1, d.name, d.description, d.body, d.folder,
       COALESCE((
         SELECT json_group_array(name) FROM (
           SELECT g.name AS name FROM doc_tags dt JOIN tags g ON g.id = dt.tag_id
           WHERE dt.doc_id = d.id ORDER BY g.name
         )
       ), '[]'),
       d.author_kind, d.author_name, d.updated_at
FROM docs d;
