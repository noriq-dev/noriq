-- RUN-4: the execution plane's persistence. Two new tables (runners, then runs
-- so runs.runner_id's FK target exists first) plus a plan-level `proposed` status
-- so a scope agent can emit a plan that a human approves before any of its tasks
-- become claimable. Additive-only. The deleteProject cascade in ProjectRoom.ts is
-- updated in the same change to clear these rows FK-first.

-- A registered local daemon. project_id is nullable (a runner may serve multiple
-- projects); a pinned runner is unpinned (not deleted) when its project is deleted.
-- owner_user_id is a soft ref to users.id (like projects.owner_user_id) so the
-- registering user's runners can be authorized without a deleteUser cascade edit.
CREATE TABLE runners (
  id                TEXT PRIMARY KEY,
  project_id        TEXT REFERENCES projects(id),
  owner_user_id     TEXT,                     -- soft ref to users.id (per-user daemon)
  label             TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online','offline','draining')),
  capabilities      TEXT NOT NULL DEFAULT '{}', -- JSON: {tools,kinds,maxConcurrency}
  repos             TEXT NOT NULL DEFAULT '[]', -- JSON array of RunnerRepo
  free_slots        INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_runners_project ON runners (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_runners_owner ON runners (owner_user_id) WHERE owner_user_id IS NOT NULL;

-- One supervised agent process (scope|build|verify). The daemon speaks only Run
-- lifecycle; task/plan/comment semantics stay in the spawned agent's own MCP calls.
-- anchor is polymorphic (task | plan | none) — anchor_id is a soft ref (no FK, it
-- targets either table) with a CHECK keeping type and id present-or-absent together.
CREATE TABLE runs (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  runner_id     TEXT REFERENCES runners(id),  -- null while queued
  agent_id      TEXT REFERENCES agents(id),   -- the spawned agent's own actor; null until it registers
  kind          TEXT NOT NULL CHECK (kind IN ('scope','build','verify')),
  anchor_type   TEXT CHECK (anchor_type IN ('task','plan')),
  anchor_id     TEXT,                         -- task id or plan id; soft (polymorphic) ref
  brief         TEXT NOT NULL DEFAULT '',
  repo_ref      TEXT NOT NULL,                -- id of a RunnerRepo advertised by the owning runner
  agent_tool    TEXT NOT NULL CHECK (agent_tool IN ('claude','codex')),
  budget        TEXT NOT NULL DEFAULT '{}',   -- JSON RunBudget
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','dispatched','running','blocked','done','failed','cancelled')),
  exit          TEXT,                         -- JSON RunExit; null until terminal
  created_by    TEXT NOT NULL,                -- actor id that dispatched the brief (soft ref)
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  dispatched_at TEXT,
  started_at    TEXT,
  CHECK ((anchor_type IS NULL) = (anchor_id IS NULL))
);
CREATE INDEX idx_runs_project_status ON runs (project_id, status);
CREATE INDEX idx_runs_runner ON runs (runner_id) WHERE runner_id IS NOT NULL;
CREATE INDEX idx_runs_anchor ON runs (anchor_id) WHERE anchor_id IS NOT NULL;

-- Plan-level approval gate. Existing plans default to 'active' (ungated — preserves
-- current behavior); a scope agent's emitted plan is inserted 'proposed', and the
-- Approve action promotes all its tasks to 'todo' atomically (server logic, later phase).
ALTER TABLE plans ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('proposed','active'));
