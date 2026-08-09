-- 0082: bounded lifecycle sweep cursor + immutable transition telemetry (PLNR-363).
--
-- Actor identities remain durable. This state advances bounded scans; transition rows explain
-- visibility/lifecycle changes without writing into a project event stream from outside that
-- project's Durable Object authority.

CREATE TABLE agent_lifecycle_sweep_state (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  actor_cursor       TEXT,
  presence_cursor    TEXT,
  runner_cursor      TEXT,
  last_sweep_at      TEXT,
  last_apply_at      TEXT,
  last_result        TEXT NOT NULL DEFAULT '{}'
);

INSERT INTO agent_lifecycle_sweep_state (id) VALUES (1);

CREATE TABLE agent_lifecycle_events (
  id            TEXT PRIMARY KEY,
  sweep_id      TEXT NOT NULL,
  subject_kind  TEXT NOT NULL CHECK (subject_kind IN ('actor', 'presence', 'runner')),
  subject_id    TEXT NOT NULL,
  actor_class   TEXT,
  from_state    TEXT,
  to_state      TEXT NOT NULL,
  reason        TEXT NOT NULL,
  evidence_at   TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_agent_lifecycle_events_subject
  ON agent_lifecycle_events (subject_kind, subject_id, created_at DESC);
CREATE INDEX idx_agent_lifecycle_events_sweep
  ON agent_lifecycle_events (sweep_id, created_at);
