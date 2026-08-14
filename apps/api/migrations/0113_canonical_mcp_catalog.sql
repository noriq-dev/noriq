-- Canonical MCP catalogue and generic proposed-task provenance.
--
-- The existing spinoff_* columns remain the durable run/source/finding storage for
-- backwards-readable history. These columns add the actor/execution dimensions that
-- also exist when an IDE Copilot proposes work without a live Runner run.
ALTER TABLE tasks ADD COLUMN proposal_actor_kind TEXT;
ALTER TABLE tasks ADD COLUMN proposal_actor_id TEXT;
ALTER TABLE tasks ADD COLUMN proposal_execution_id TEXT;

-- Optional Copilot tool packs are persisted on the agent/session identity. Core is
-- implied and therefore never stored in this JSON array. Runner agents continue to
-- use allowed_tools as an exact server-enforced floor.
ALTER TABLE agents ADD COLUMN tool_packs TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agents ADD COLUMN tool_profile_updated_at TEXT;
