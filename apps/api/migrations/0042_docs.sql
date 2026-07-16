-- PLNR-158: project docs — freeform markdown reference material (conventions,
-- architecture notes, onboarding) that agents and humans both read. Name/description
-- form the index agents scan; body is the document. FK target (projects) exists;
-- deleteProject's cascade gains this table (CLAUDE.md rule for new tables).
CREATE TABLE docs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  author_kind TEXT NOT NULL DEFAULT 'agent',
  author_name TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_docs_project ON docs (project_id);
