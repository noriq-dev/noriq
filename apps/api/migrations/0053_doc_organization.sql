-- PLNR-188: docs get organization. `folder` is a normalized path string ("design/mesh")
-- purely for human browsing in the UI — docs stay addressed by id everywhere, so no FK,
-- no folder table, and an empty string is the root. doc_tags reuses the PROJECT tag
-- vocabulary (same `tags` table tasks use) so humans and agents filter tasks and docs
-- with one set of words. deleteDoc/deleteTag/deleteProject cascades gain doc_tags
-- (CLAUDE.md rule for new tables).
ALTER TABLE docs ADD COLUMN folder TEXT NOT NULL DEFAULT '';
CREATE TABLE doc_tags (
  doc_id     TEXT NOT NULL REFERENCES docs(id),
  tag_id     TEXT NOT NULL REFERENCES tags(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (doc_id, tag_id)
);
CREATE INDEX idx_doc_tags_tag ON doc_tags (tag_id);
