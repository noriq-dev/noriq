-- planar initial schema (ROADMAP §4)
-- Single-tenant. All project-scoped writes go through the ProjectRoom DO.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  password_hash TEXT,               -- null when passkey-only
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE agents (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  role         TEXT NOT NULL DEFAULT 'worker' CHECK (role IN ('orchestrator', 'worker')),
  status       TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('active', 'idle', 'offline', 'revoked')),
  api_key_hash TEXT NOT NULL,       -- SHA-256 of the bearer token; raw key never stored
  scopes       TEXT NOT NULL DEFAULT '[]', -- JSON array
  last_seen_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_agents_key ON agents (api_key_hash);

CREATE TABLE projects (
  id                TEXT PRIMARY KEY,
  key               TEXT NOT NULL UNIQUE,  -- task-key prefix, e.g. 'PLN'
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  repo_url          TEXT,
  default_branch    TEXT,
  claim_ttl_seconds INTEGER NOT NULL DEFAULT 300,
  heartbeat_seconds INTEGER NOT NULL DEFAULT 60,
  next_task_number  INTEGER NOT NULL DEFAULT 1,   -- allocator for 'PLN-142' keys
  next_event_seq    INTEGER NOT NULL DEFAULT 1,   -- monotonic event cursor
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE milestones (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title      TEXT NOT NULL,
  due_at     TEXT,
  "order"    INTEGER NOT NULL DEFAULT 0,
  closed_at  TEXT
);
CREATE INDEX idx_milestones_project ON milestones (project_id);

CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  key              TEXT NOT NULL UNIQUE,   -- 'PLN-142'
  milestone_id     TEXT REFERENCES milestones(id),
  parent_task_id   TEXT REFERENCES tasks(id),
  title            TEXT NOT NULL,
  body             TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'todo'
                   CHECK (status IN ('todo','claimed','in_progress','blocked','review','done','cancelled')),
  priority         INTEGER NOT NULL DEFAULT 2,
  estimate         REAL,
  claimed_by       TEXT REFERENCES agents(id),
  claim_expires_at TEXT,
  open_comments    INTEGER NOT NULL DEFAULT 0,  -- denormalized unaddressed count
  "order"          INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_tasks_project_status ON tasks (project_id, status);
CREATE INDEX idx_tasks_parent ON tasks (parent_task_id);
CREATE INDEX idx_tasks_claimed_by ON tasks (claimed_by) WHERE claimed_by IS NOT NULL;

CREATE TABLE dependencies (
  task_id            TEXT NOT NULL REFERENCES tasks(id),
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on_task_id)
);
CREATE INDEX idx_deps_reverse ON dependencies (depends_on_task_id);

CREATE TABLE claims (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  acquired_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  released_at TEXT                      -- null = live; enforced single-live by ProjectRoom DO
);
CREATE INDEX idx_claims_task_live ON claims (task_id) WHERE released_at IS NULL;
CREATE INDEX idx_claims_agent ON claims (agent_id);

CREATE TABLE comments (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES tasks(id),
  author_kind       TEXT NOT NULL CHECK (author_kind IN ('agent', 'human', 'system')),
  author_id         TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment','question','instruction','reply')),
  body              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','addressed','wont_do')),
  resolved_by       TEXT,
  parent_comment_id TEXT REFERENCES comments(id),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_comments_task ON comments (task_id);
CREATE INDEX idx_comments_open ON comments (task_id, status) WHERE status IN ('open', 'acknowledged');

CREATE TABLE messages (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  from_agent_id TEXT NOT NULL REFERENCES agents(id),
  to_agent_id   TEXT REFERENCES agents(id),  -- null = broadcast
  body          TEXT NOT NULL,
  ref_task_id   TEXT REFERENCES tasks(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_messages_project ON messages (project_id);
CREATE INDEX idx_messages_inbox ON messages (to_agent_id, created_at);

-- Append-only. Never UPDATE or DELETE rows here.
CREATE TABLE events (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  seq          INTEGER NOT NULL,        -- monotonic per project
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('agent', 'human', 'system')),
  actor_id     TEXT NOT NULL,
  verb         TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  payload      TEXT NOT NULL DEFAULT '{}',  -- JSON
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (project_id, seq)
);
CREATE INDEX idx_events_project_seq ON events (project_id, seq DESC);
