-- 0011: signals — first-class attention items an agent raises for a human (PLNR-67).
--   * input_request — a decision GATE. Blocks its task ('done' can't happen while open);
--     raising one auto-parks the task to 'blocked' so it doesn't lapse to claim-TTL, and
--     answering it returns the task to the queue + notifies the requesting agent.
--   * alert — a non-blocking attention item (deviation / heads-up), info|warning|critical.
-- Attachable to a task or standalone (task_id NULL).
CREATE TABLE signals (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  task_id       TEXT REFERENCES tasks(id),                  -- NULL = standalone
  agent_id      TEXT REFERENCES agents(id),                 -- who raised it (NULL = system)
  agent_name    TEXT NOT NULL DEFAULT '',                   -- denormalized for display
  type          TEXT NOT NULL CHECK (type IN ('input_request', 'alert')),
  severity      TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  title         TEXT NOT NULL,
  body          TEXT,
  options       TEXT,                                        -- JSON array of choices (input_request)
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'acknowledged', 'dismissed')),
  response      TEXT,                                        -- the human's decision / answer
  responder_id  TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  resolved_at   TEXT
);
CREATE INDEX idx_signals_project ON signals (project_id, status);
CREATE INDEX idx_signals_task    ON signals (task_id);
CREATE INDEX idx_signals_agent   ON signals (agent_id);
