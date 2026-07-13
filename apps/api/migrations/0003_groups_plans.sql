-- Groups (collections of projects) and Plans/Phases (an agent's work program:
-- a plan groups existing tasks into ordered phases; phase order is enforced by
-- auto-generated task dependencies, so the claim arbiter respects it).

CREATE TABLE groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  "order"     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

ALTER TABLE projects ADD COLUMN group_id TEXT REFERENCES groups(id);

CREATE TABLE plans (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  agent_id    TEXT REFERENCES agents(id),   -- who authored the plan (null = human)
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_plans_project ON plans (project_id);

CREATE TABLE phases (
  id      TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  title   TEXT NOT NULL,
  "order" INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_phases_plan ON phases (plan_id);

CREATE TABLE phase_tasks (
  phase_id TEXT NOT NULL REFERENCES phases(id),
  task_id  TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (phase_id, task_id)
);
CREATE INDEX idx_phase_tasks_task ON phase_tasks (task_id);
