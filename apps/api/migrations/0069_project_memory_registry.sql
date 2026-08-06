-- PLNR-246: compact D1 registry for Project Memory. D1 holds only routing/health/status rows
-- here — the complete memory graph, evidence, and episodes live in the per-project ProjectMemory
-- Durable Object (PLNR-245). Both tables are additive and reference the existing `projects`
-- table, which predates them, so FK ordering needs no special care within this file.

-- One row per project once its memory store has been touched — health/backup projection only,
-- never graph or evidence content. Upserted by ProjectRoom (the sole D1 writer per project),
-- never written directly.
CREATE TABLE project_memory_registry (
  project_id       TEXT PRIMARY KEY REFERENCES projects(id),
  schema_version   INTEGER,
  memory_revision  INTEGER,
  last_health_at   TEXT,
  backup_status    TEXT NOT NULL DEFAULT 'none' CHECK (backup_status IN ('none', 'pending', 'ok', 'failed')),
  last_backup_at   TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- Canonical project<->repository associations (Project Memory §6). `repository_key` is the
-- committed, project-local identity from .noriq/project.toml — validated at the edge with
-- @noriq-dev/shared's RepositoryKey (PLNR-244), never a runner-local checkout id. Unique per
-- project; the SAME key may be registered in a different project (a fork, a different server).
CREATE TABLE project_repositories (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  repository_key    TEXT NOT NULL,
  indexing_enabled  INTEGER NOT NULL DEFAULT 0,
  ingest_status     TEXT NOT NULL DEFAULT 'none' CHECK (ingest_status IN ('none', 'staged', 'active', 'failed')),
  created_at        TEXT NOT NULL,
  UNIQUE (project_id, repository_key)
);
CREATE INDEX idx_project_repositories_project ON project_repositories (project_id);
