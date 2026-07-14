-- RUN-17: steer bookkeeping for the ack/dedup loop. When the server sends a steer
-- to a runner it records the mapping steerId → (agent, source comment/message id)
-- here; when the daemon acks delivered-via-runtime, the ack handler uses this row
-- to mark the source delivered (runtime_deliveries) so the MCP notices fallback
-- won't double-deliver. Dedup is by the stable source id. Additive-only.
CREATE TABLE steers (
  id            TEXT PRIMARY KEY,          -- steerId
  run_id        TEXT NOT NULL,
  agent_id      TEXT,                      -- the spawned agent (dedup target); null if unknown
  source_id     TEXT,                      -- the Noriq comment/message id this steer derives from
  notice_cursor INTEGER,
  mode          TEXT NOT NULL CHECK (mode IN ('soft','hard')),
  delivered_via TEXT,                      -- runtime|fallback|dropped, set on ack
  acked_at      TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_steers_run ON steers (run_id);
