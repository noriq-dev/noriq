-- Plan-local docs (PLNR-200): working documents scoped to a single plan.
--
-- Deliberately NOT the `docs` table and deliberately different from it: plan docs are
--   * never indexed in the vector store (no reindexSearch / SearchKind — they stay out of
--     semantic_search and list_docs), and
--   * not subject to the settled-only doc contract (doclint) — they are WORKING documents
--     that evolve as a plan's design firms up.
-- They give a plan's tasks a shared design/scratch space without bloating the project
-- knowledge base. FK to plans(id) so they die with the plan; project_id for scoping + the
-- deleteProject cascade. Both FK targets (plans, projects) already exist — additive.
CREATE TABLE IF NOT EXISTS plan_docs (
  id           TEXT PRIMARY KEY,
  plan_id      TEXT NOT NULL REFERENCES plans(id),
  project_id   TEXT NOT NULL REFERENCES projects(id),
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  author_kind  TEXT NOT NULL DEFAULT 'agent',
  author_name  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_plan_docs_plan ON plan_docs(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_docs_project ON plan_docs(project_id);
