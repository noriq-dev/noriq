-- RUN-7: the steering double-delivery guard. When the daemon delivers a steer to
-- an agent over the runtime channel (injected into the live CLI session) it acks,
-- and we record it here so the MCP notices fallback (computeUpdates) does NOT also
-- surface the same message — the agent would otherwise see the steer twice.
-- Additive-only. Keyed by (agent, message) so an ack is idempotent.
CREATE TABLE runtime_deliveries (
  agent_id     TEXT NOT NULL,              -- the spawned agent that received the steer
  message_id   TEXT NOT NULL,              -- the steer's underlying message (events.subject_id)
  run_id       TEXT,                       -- the Run it was delivered through (audit)
  delivered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (agent_id, message_id)
);
CREATE INDEX idx_runtime_deliveries_agent ON runtime_deliveries (agent_id);
