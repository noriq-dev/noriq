-- 0009: agents become project-local working identities (Montana's agent review).
--
-- Corrected model: a *connection* is one oauth_tokens row (one `claude mcp add`).
-- An *agent* is a distinct MCP session (a chat, or a sub-agent) working ONE project,
-- keyed by the MCP session id. Sub-agents link to a parent via parent_agent_id.
--
-- Purely additive: D1 enforces foreign keys during migrations (and ignores
-- PRAGMA toggles), so we cannot drop/rebuild the referenced `agents` table. Names
-- therefore stay globally unique for now (a per-project relaxation is a later,
-- data-copy cutover — see the follow-up task). api_key_hash/scopes stay as vestigial
-- NOT NULL columns filled with a dummy on insert.

ALTER TABLE agents ADD COLUMN project_id      TEXT REFERENCES projects(id);       -- project this agent works (NULL until scoped)
ALTER TABLE agents ADD COLUMN oauth_token_id  TEXT REFERENCES oauth_tokens(id);   -- the connection this agent belongs to
ALTER TABLE agents ADD COLUMN session_id      TEXT;                               -- MCP session id (per chat / sub-agent)
ALTER TABLE agents ADD COLUMN parent_agent_id TEXT REFERENCES agents(id);         -- set when this agent is a sub-agent

-- Best-effort: link existing agents to their most recent connection.
UPDATE agents SET oauth_token_id = (
  SELECT t.id FROM oauth_tokens t WHERE t.agent_id = agents.id ORDER BY t.created_at DESC LIMIT 1
);

CREATE INDEX idx_agents_session ON agents (session_id);
CREATE INDEX idx_agents_token   ON agents (oauth_token_id);
CREATE INDEX idx_agents_project ON agents (project_id);
