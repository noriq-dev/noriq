-- 0009: agents become project-local working identities (Montana's agent review).
--
-- Corrected model: a *connection* is one oauth_tokens row (one `claude mcp add`).
-- An *agent* is a distinct MCP session (a chat, or a sub-agent) working ONE project,
-- keyed by the MCP session id. Names are unique per project, not globally. Sub-agents
-- link to a parent via parent_agent_id. Drops the static-key vestiges (api_key_hash,
-- scopes) and the global-unique name — hence a table rebuild.

CREATE TABLE agents_new (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'worker' CHECK (role IN ('orchestrator', 'worker')),
  status          TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('active', 'idle', 'offline', 'revoked')),
  user_id         TEXT REFERENCES users(id),          -- owner (who authorized the connection)
  project_id      TEXT REFERENCES projects(id),       -- the project this agent works (NULL until scoped)
  oauth_token_id  TEXT REFERENCES oauth_tokens(id),   -- the connection this agent belongs to
  session_id      TEXT,                               -- MCP session id (per chat / sub-agent)
  parent_agent_id TEXT REFERENCES agents(id),         -- set when this agent is a sub-agent
  last_seen_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO agents_new (id, name, role, status, user_id, last_seen_at, created_at)
  SELECT id, name, role, status, user_id, last_seen_at, created_at FROM agents;

DROP TABLE agents;
ALTER TABLE agents_new RENAME TO agents;

-- Best-effort: link legacy agents to their most recent connection.
UPDATE agents SET oauth_token_id = (
  SELECT t.id FROM oauth_tokens t WHERE t.agent_id = agents.id ORDER BY t.created_at DESC LIMIT 1
);

-- Names unique within a project; unscoped (NULL project) agents never collide.
CREATE UNIQUE INDEX idx_agents_project_name ON agents (project_id, name) WHERE project_id IS NOT NULL;
CREATE INDEX idx_agents_session ON agents (session_id);
CREATE INDEX idx_agents_token   ON agents (oauth_token_id);
CREATE INDEX idx_agents_project ON agents (project_id);
