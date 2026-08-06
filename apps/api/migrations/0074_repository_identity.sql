-- PLNR-259: canonical repository identity + checkout association. Additive columns on the
-- ALREADY-canonical `project_repositories` (0069) — default branch, VCS kind, branch classes,
-- latest observed base, and the D1-side active-generation PROJECTION (authority stays
-- index_generations.status='active' inside the ProjectMemory DO; this column only mirrors it,
-- written the same DO -> ProjectRoom -> D1 direction as upsertMemoryHealth/updateMemoryBackupStatus).
-- `updated_at` is new too — the table had none, so every field below was write-once before this.
ALTER TABLE project_repositories ADD COLUMN default_branch TEXT;
ALTER TABLE project_repositories ADD COLUMN vcs_kind TEXT;
ALTER TABLE project_repositories ADD COLUMN branch_classes TEXT NOT NULL DEFAULT '[]'; -- JSON array
ALTER TABLE project_repositories ADD COLUMN latest_observed_base TEXT;
ALTER TABLE project_repositories ADD COLUMN active_generation_id TEXT;
ALTER TABLE project_repositories ADD COLUMN updated_at TEXT;

-- A runner-local checkout association (§4/§6): (runner_id, checkout_id) is the runner's own
-- identity for "this local clone" (RunnerRepo.id — "stable per (runner, repo), e.g. hash of the
-- root path" — never a canonical key). Many checkouts may converge on one canonical repository;
-- one checkout must resolve to at most one. Named `repository_checkouts`, NOT `staging_*` or
-- anything starting `staging_` — the restore path derives `staging_<table>` names from
-- BACKUP_TABLES and this table lives in D1, not the ProjectMemory DO, but the naming collision
-- risk is a repo-wide convention worth avoiding regardless.
CREATE TABLE repository_checkouts (
  id                      TEXT PRIMARY KEY,
  project_repository_id   TEXT NOT NULL REFERENCES project_repositories(id),
  runner_id               TEXT NOT NULL REFERENCES runners(id),
  checkout_id             TEXT NOT NULL, -- RunnerRepo.id — display/association data only, never canonical identity
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  UNIQUE (runner_id, checkout_id)
);
CREATE INDEX idx_repository_checkouts_repo ON repository_checkouts (project_repository_id);
