-- PLNR-367: immediate delegation belongs to ephemeral session presence and immutable execution,
-- not to the durable connection owner. Existing connection-parent pointers are explicitly
-- degraded to unknown lineage; ownership remains recoverable through oauth_token_id/copilot_id.

ALTER TABLE agent_presences ADD COLUMN parent_presence_id TEXT REFERENCES agent_presences(id);
CREATE INDEX idx_agent_presences_parent ON agent_presences (parent_presence_id);

UPDATE agents SET
  parent_agent_id = NULL,
  lineage_status = 'partial',
  lineage_reason = 'immediate_parent_unknown',
  lifecycle_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE actor_class = 'session_copilot'
  AND lineage_reason IN (
    'connection_owner_not_immediate_execution',
    'legacy_owner_parent_not_immediate_execution'
  );

CREATE TRIGGER agent_presences_parent_validate_insert
BEFORE INSERT ON agent_presences
WHEN NEW.parent_presence_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.parent_presence_id = NEW.id
    THEN RAISE(ABORT, 'session presence cannot parent itself') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM agent_presences parent
    JOIN agents parent_actor ON parent_actor.id = parent.actor_id
    JOIN agents child_actor ON child_actor.id = NEW.actor_id
    WHERE parent.id = NEW.parent_presence_id
      AND parent.kind = 'mcp_session' AND NEW.kind = 'mcp_session'
      AND parent_actor.user_id = child_actor.user_id
  ) THEN RAISE(ABORT, 'session presence parent must be an MCP session for the same user') END;
  SELECT CASE WHEN EXISTS (
    WITH RECURSIVE ancestors(id) AS (
      SELECT parent_presence_id FROM agent_presences WHERE id = NEW.parent_presence_id
      UNION ALL
      SELECT p.parent_presence_id FROM agent_presences p JOIN ancestors a ON p.id = a.id
      WHERE p.parent_presence_id IS NOT NULL
    ) SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN RAISE(ABORT, 'session presence parent would create a cycle') END;
END;

CREATE TRIGGER agent_presences_parent_validate_update
BEFORE UPDATE OF parent_presence_id ON agent_presences
BEGIN
  SELECT CASE WHEN OLD.parent_presence_id IS NOT NULL
                   AND OLD.parent_presence_id IS NOT NEW.parent_presence_id
    THEN RAISE(ABORT, 'session presence parent is immutable') END;
  SELECT CASE WHEN NEW.parent_presence_id = NEW.id
    THEN RAISE(ABORT, 'session presence cannot parent itself') END;
  SELECT CASE WHEN NEW.parent_presence_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agent_presences parent
    JOIN agents parent_actor ON parent_actor.id = parent.actor_id
    JOIN agents child_actor ON child_actor.id = NEW.actor_id
    WHERE parent.id = NEW.parent_presence_id
      AND parent.kind = 'mcp_session' AND NEW.kind = 'mcp_session'
      AND parent_actor.user_id = child_actor.user_id
  ) THEN RAISE(ABORT, 'session presence parent must be an MCP session for the same user') END;
  SELECT CASE WHEN NEW.parent_presence_id IS NOT NULL AND EXISTS (
    WITH RECURSIVE ancestors(id) AS (
      SELECT parent_presence_id FROM agent_presences WHERE id = NEW.parent_presence_id
      UNION ALL
      SELECT p.parent_presence_id FROM agent_presences p JOIN ancestors a ON p.id = a.id
      WHERE p.parent_presence_id IS NOT NULL
    ) SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN RAISE(ABORT, 'session presence parent would create a cycle') END;
END;
