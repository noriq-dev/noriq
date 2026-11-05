-- Subscription polling filters and orders by timestamp, including empty polls.
CREATE INDEX idx_events_created_at ON events (created_at);

-- Resolve one actor's MCP presence without scanning all MCP sessions by kind.
CREATE INDEX idx_agent_presences_kind_actor ON agent_presences (kind, actor_id);
