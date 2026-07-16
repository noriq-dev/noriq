-- 0045 (PLNR-143): close the set_agent_identity TOCTOU race.
--
-- 0010 relaxed the global UNIQUE(agents.name) into per-project display labels, but
-- could only enforce label uniqueness in application code (SELECT-then-UPDATE, no
-- unique index, no transaction) — two concurrent sessions could both take the same
-- label in a project. 0026 confirmed this needs no table rebuild, just this index.
--
-- NULLs are distinct in SQLite unique indexes, so unscoped (project_id IS NULL) and
-- unlabeled (label IS NULL) rows are unconstrained — only real (project, label)
-- pairs collide. The app-level check in set_agent_identity stays as the friendly
-- error path; this is the backstop that makes the race lose loudly.
--
-- ⚠ Fails if live data already holds a duplicate — verify before applying remotely:
--   SELECT project_id, label, COUNT(*) c FROM agents
--    WHERE label IS NOT NULL GROUP BY 1,2 HAVING c > 1;
DROP INDEX idx_agents_project_label;
CREATE UNIQUE INDEX idx_agents_project_label ON agents (project_id, label);
