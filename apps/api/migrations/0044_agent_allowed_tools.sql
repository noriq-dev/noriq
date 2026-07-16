-- RUN-47: the MCP server advertised all 28 tools to every agent while the daemon's
-- per-kind permission floor denied most of them on use — the agent was told a lie
-- and punished for believing it. The daemon now declares its floor when it creates
-- the run agent (POST /api/runs/:id/agent), and the MCP server advertises only that
-- list for the session bound to this agent. One authority (the daemon), one
-- advertisement (the server), no shared constant to drift.
--
-- JSON array of bare tool names. NULL = no floor declared (copilots always; agents
-- created by a pre-RUN-47 daemon) → full catalogue, the pre-existing behavior.
ALTER TABLE agents ADD COLUMN allowed_tools TEXT;
