-- 0081: actor lifecycle + ephemeral presence (PLNR-362).
--
-- `agents.status` currently tries to answer three different questions: may this identity
-- authenticate, is its process/session online, and should it be shown in an operational roster.
-- Those questions have different clocks.  Keep the existing column byte-compatible for old
-- clients, add archive-first actor lifecycle facts, and move liveness into a separate presence
-- table.  No actor is deleted or hidden by this migration.

ALTER TABLE agents ADD COLUMN actor_class TEXT NOT NULL DEFAULT 'legacy_copilot'
  CHECK (actor_class IN ('connection_copilot', 'session_copilot', 'runner_agent', 'legacy_copilot'));
ALTER TABLE agents ADD COLUMN retired_at TEXT;
ALTER TABLE agents ADD COLUMN retire_reason TEXT;
ALTER TABLE agents ADD COLUMN archived_at TEXT;
ALTER TABLE agents ADD COLUMN lifecycle_updated_at TEXT;
ALTER TABLE agents ADD COLUMN lineage_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK (lineage_status IN ('complete', 'partial', 'unknown'));
ALTER TABLE agents ADD COLUMN lineage_reason TEXT;

ALTER TABLE runners ADD COLUMN retired_at TEXT;
ALTER TABLE runners ADD COLUMN retire_reason TEXT;
ALTER TABLE runners ADD COLUMN archived_at TEXT;

CREATE INDEX idx_agents_lifecycle ON agents (actor_class, retired_at, archived_at);
CREATE INDEX idx_agents_archive ON agents (archived_at, created_at);
CREATE INDEX idx_runners_archive ON runners (archived_at, last_heartbeat_at);

CREATE TABLE agent_presences (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('mcp_session', 'runner_daemon', 'run_process')),
  source_key   TEXT NOT NULL,
  actor_id     TEXT REFERENCES agents(id),
  project_id   TEXT REFERENCES projects(id) ON DELETE SET NULL,
  runner_id    TEXT REFERENCES runners(id) ON DELETE CASCADE,
  run_id       TEXT REFERENCES runs(id) ON DELETE SET NULL,
  sitting      INTEGER,
  state        TEXT NOT NULL CHECK (state IN ('online', 'working', 'dormant', 'ended', 'unknown')),
  started_at   TEXT NOT NULL,
  last_seen_at TEXT,
  ended_at     TEXT,
  end_reason   TEXT,
  archived_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- source_key is producer evidence, not globally unique identity. Legacy MCP clients could reuse a
-- session id across connections before the server had a scoped uniqueness constraint; canonical
-- presence id + actor association keeps those rows distinct rather than making migration fail.
CREATE INDEX idx_agent_presences_source ON agent_presences (kind, source_key);
CREATE INDEX idx_agent_presences_actor ON agent_presences (actor_id, ended_at, last_seen_at DESC);
CREATE INDEX idx_agent_presences_project ON agent_presences (project_id, state, last_seen_at DESC);
CREATE INDEX idx_agent_presences_runner ON agent_presences (runner_id, state, last_seen_at DESC);
CREATE INDEX idx_agent_presences_archive ON agent_presences (archived_at, ended_at);

-- Classification is deliberately evidence-based.  A session id proves a session Copilot;
-- oauth_tokens.copilot_id proves a connection root; a runner-owned kind proves a Runner actor.
-- Anything else is retained as legacy/unknown rather than adopted by a guess.
UPDATE agents SET
  actor_class = CASE
    WHEN kind = 'agent' THEN 'runner_agent'
    WHEN session_id IS NOT NULL THEN 'session_copilot'
    WHEN id IN (SELECT copilot_id FROM oauth_tokens WHERE copilot_id IS NOT NULL) THEN 'connection_copilot'
    ELSE 'legacy_copilot'
  END,
  lineage_status = CASE
    WHEN kind = 'copilot' AND session_id IS NULL
      AND id IN (SELECT copilot_id FROM oauth_tokens WHERE copilot_id IS NOT NULL) THEN 'complete'
    WHEN kind = 'agent' AND id IN (SELECT agent_id FROM runs WHERE agent_id IS NOT NULL) THEN 'partial'
    WHEN kind = 'copilot' AND session_id IS NOT NULL THEN 'partial'
    ELSE 'unknown'
  END,
  lineage_reason = CASE
    WHEN kind = 'agent' AND id IN (SELECT agent_id FROM runs WHERE agent_id IS NOT NULL)
      THEN 'execution_contract_pending'
    WHEN kind = 'copilot' AND session_id IS NOT NULL AND parent_agent_id IS NOT NULL
      THEN 'legacy_owner_parent_not_immediate_execution'
    WHEN kind = 'copilot' AND session_id IS NOT NULL THEN 'immediate_parent_unknown'
    WHEN kind = 'copilot' AND session_id IS NULL
      AND id NOT IN (SELECT copilot_id FROM oauth_tokens WHERE copilot_id IS NOT NULL)
      THEN 'legacy_actor_class_unknown'
    ELSE NULL
  END,
  lifecycle_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

-- Retire only identities for which terminal/security evidence already exists.  Active-but-stale
-- rows are NOT retired here: claims, gates, parked Runs and cross-store evidence need the bounded
-- PLNR-363 sweep.  This migration never sets archived_at.
UPDATE agents SET
  retired_at = COALESCE(
    (SELECT r.updated_at FROM runs r
      WHERE r.agent_id = agents.id AND r.status IN ('done', 'failed', 'cancelled')
      ORDER BY r.updated_at DESC LIMIT 1),
    last_seen_at,
    created_at
  ),
  retire_reason = CASE
    WHEN EXISTS (SELECT 1 FROM runs r
      WHERE r.agent_id = agents.id AND r.status IN ('done', 'failed', 'cancelled')) THEN 'run_terminal'
    WHEN status = 'revoked' THEN 'security_revoked'
    ELSE 'legacy_offline'
  END
WHERE status IN ('offline', 'revoked')
   OR EXISTS (SELECT 1 FROM runs r
      WHERE r.agent_id = agents.id AND r.status IN ('done', 'failed', 'cancelled'));

-- One presence per historical MCP-session actor.  Five minutes matches the existing UI's online
-- signal; the later configurable sweep owns retirement/archive thresholds and protected-work
-- overrides.  Revoked/offline is explicit terminal evidence, not mere inactivity.
INSERT INTO agent_presences (
  id, kind, source_key, actor_id, project_id, state, started_at, last_seen_at,
  ended_at, end_reason, created_at, updated_at
)
SELECT
  'prs_mcp_' || id,
  'mcp_session',
  session_id,
  id,
  project_id,
  CASE
    WHEN status IN ('offline', 'revoked') THEN 'ended'
    WHEN last_seen_at IS NULL THEN 'unknown'
    WHEN julianday('now') - julianday(last_seen_at) <= (5.0 / 1440.0) THEN 'online'
    ELSE 'dormant'
  END,
  created_at,
  last_seen_at,
  CASE WHEN status IN ('offline', 'revoked') THEN COALESCE(last_seen_at, created_at) ELSE NULL END,
  CASE WHEN status = 'revoked' THEN 'security_revoked'
       WHEN status = 'offline' THEN 'connection_or_session_offline' ELSE NULL END,
  created_at,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM agents
WHERE actor_class = 'session_copilot' AND session_id IS NOT NULL;

-- A historical run can clear runs.agent_id when it is continued, so absence of a current Run
-- link is incomplete evidence, not permission to discard the old actor.  Such a presence is ended
-- when the actor is already retired/offline and unknown otherwise.
WITH latest_run AS (
  SELECT r.*,
         ROW_NUMBER() OVER (
           PARTITION BY r.agent_id ORDER BY r.updated_at DESC, r.created_at DESC, r.id DESC
         ) AS actor_rank
    FROM runs r
   WHERE r.agent_id IS NOT NULL
)
INSERT INTO agent_presences (
  id, kind, source_key, actor_id, project_id, runner_id, run_id, sitting, state,
  started_at, last_seen_at, ended_at, end_reason, created_at, updated_at
)
SELECT
  'prs_run_' || a.id,
  'run_process',
  a.id,
  a.id,
  a.project_id,
  a.runner_id,
  r.id,
  r.sitting,
  CASE
    WHEN r.status IN ('dispatched', 'running', 'blocked') AND a.status = 'active' THEN 'working'
    WHEN a.retired_at IS NOT NULL OR a.status IN ('offline', 'revoked')
      OR r.status IN ('done', 'failed', 'cancelled') THEN 'ended'
    ELSE 'unknown'
  END,
  COALESCE(r.started_at, a.created_at),
  a.last_seen_at,
  CASE
    WHEN a.retired_at IS NOT NULL OR a.status IN ('offline', 'revoked')
      OR r.status IN ('done', 'failed', 'cancelled')
    THEN COALESCE(a.retired_at, r.updated_at, a.last_seen_at, a.created_at)
    ELSE NULL
  END,
  CASE
    WHEN r.status IN ('done', 'failed', 'cancelled') THEN 'run_terminal'
    WHEN a.status = 'revoked' THEN 'security_revoked'
    WHEN a.status = 'offline' THEN 'run_agent_offline'
    WHEN r.id IS NULL THEN 'legacy_run_link_unknown'
    ELSE NULL
  END,
  a.created_at,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM agents a
LEFT JOIN latest_run r ON r.agent_id = a.id AND r.actor_rank = 1
WHERE a.actor_class = 'runner_agent';

INSERT INTO agent_presences (
  id, kind, source_key, runner_id, state, started_at, last_seen_at,
  ended_at, end_reason, created_at, updated_at
)
SELECT
  'prs_runner_' || id,
  'runner_daemon',
  id,
  id,
  CASE
    WHEN offboarded_at IS NOT NULL THEN 'ended'
    WHEN last_heartbeat_at IS NULL THEN 'unknown'
    WHEN julianday('now') - julianday(last_heartbeat_at) <= (90.0 / 86400.0) THEN 'online'
    ELSE 'dormant'
  END,
  created_at,
  last_heartbeat_at,
  offboarded_at,
  CASE WHEN offboarded_at IS NOT NULL THEN 'runner_offboarded' ELSE NULL END,
  created_at,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM runners;

-- New inserts and the existing mutation paths stay compatible without requiring every caller to
-- know about presence storage.  The triggers project facts; PLNR-363 remains the sole authority
-- for time-based retirement/archive policy.
--
-- Classification triggers also cover a rolling deploy where the new migration reaches D1 before
-- every Worker isolate is on the new INSERT shape.  Old writers omit actor_class; they must land as
-- the correct safe class, not accumulate as legacy_unknown until a later manual repair.
CREATE TRIGGER agents_classify_insert
AFTER INSERT ON agents
BEGIN
  UPDATE agents SET
    actor_class = CASE
      WHEN NEW.kind = 'agent' THEN 'runner_agent'
      WHEN NEW.session_id IS NOT NULL THEN 'session_copilot'
      ELSE actor_class
    END,
    lineage_status = CASE
      WHEN NEW.kind = 'agent' OR NEW.session_id IS NOT NULL THEN 'partial'
      ELSE lineage_status
    END,
    lineage_reason = CASE
      WHEN NEW.lineage_reason IS NOT NULL THEN NEW.lineage_reason
      WHEN NEW.kind = 'agent' THEN 'execution_contract_pending'
      WHEN NEW.session_id IS NOT NULL AND NEW.parent_agent_id IS NOT NULL
        THEN 'legacy_owner_parent_not_immediate_execution'
      WHEN NEW.session_id IS NOT NULL THEN 'immediate_parent_unknown'
      ELSE lineage_reason
    END,
    lifecycle_updated_at = COALESCE(NEW.lifecycle_updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE id = NEW.id;
END;

CREATE TRIGGER oauth_tokens_classify_connection_insert
AFTER INSERT ON oauth_tokens
WHEN NEW.copilot_id IS NOT NULL
BEGIN
  UPDATE agents SET
    actor_class = 'connection_copilot',
    lineage_status = 'complete',
    lineage_reason = NULL,
    lifecycle_updated_at = COALESCE(lifecycle_updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE id = NEW.copilot_id AND kind = 'copilot' AND session_id IS NULL;
END;

CREATE TRIGGER oauth_tokens_classify_connection_update
AFTER UPDATE OF copilot_id ON oauth_tokens
WHEN NEW.copilot_id IS NOT NULL
BEGIN
  UPDATE agents SET
    actor_class = 'connection_copilot',
    lineage_status = 'complete',
    lineage_reason = NULL,
    lifecycle_updated_at = COALESCE(lifecycle_updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE id = NEW.copilot_id AND kind = 'copilot' AND session_id IS NULL;
END;

CREATE TRIGGER agents_presence_insert_mcp
AFTER INSERT ON agents
WHEN NEW.kind = 'copilot' AND NEW.session_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO agent_presences (
    id, kind, source_key, actor_id, project_id, state, started_at, last_seen_at, created_at, updated_at
  ) VALUES (
    'prs_mcp_' || NEW.id, 'mcp_session', NEW.session_id, NEW.id, NEW.project_id,
    CASE WHEN NEW.last_seen_at IS NULL THEN 'unknown' ELSE 'online' END,
    NEW.created_at, NEW.last_seen_at, NEW.created_at, NEW.created_at
  );
END;

CREATE TRIGGER agents_presence_insert_run
AFTER INSERT ON agents
WHEN NEW.kind = 'agent'
BEGIN
  INSERT OR IGNORE INTO agent_presences (
    id, kind, source_key, actor_id, project_id, runner_id, state,
    started_at, last_seen_at, created_at, updated_at
  ) VALUES (
    'prs_run_' || NEW.id, 'run_process', NEW.id, NEW.id, NEW.project_id, NEW.runner_id,
    CASE WHEN NEW.status = 'active' THEN 'working' ELSE 'unknown' END,
    NEW.created_at, NEW.last_seen_at, NEW.created_at, NEW.created_at
  );
END;

CREATE TRIGGER agents_presence_sync_activity
AFTER UPDATE OF project_id, last_seen_at, status ON agents
BEGIN
  UPDATE agent_presences SET
    project_id = NEW.project_id,
    last_seen_at = CASE
      WHEN NEW.last_seen_at IS NOT NULL
       AND (last_seen_at IS NULL OR NEW.last_seen_at > last_seen_at) THEN NEW.last_seen_at
      ELSE last_seen_at
    END,
    state = CASE
      WHEN NEW.status IN ('offline', 'revoked') THEN 'ended'
      WHEN kind = 'run_process' THEN 'working'
      WHEN NEW.last_seen_at IS NOT NULL THEN 'online'
      ELSE state
    END,
    ended_at = CASE
      WHEN NEW.status IN ('offline', 'revoked') THEN COALESCE(ended_at, NEW.last_seen_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      WHEN NEW.status IN ('active', 'idle') THEN NULL
      ELSE ended_at
    END,
    end_reason = CASE
      WHEN NEW.status = 'revoked' THEN 'security_revoked'
      WHEN NEW.status = 'offline' THEN CASE WHEN kind = 'run_process' THEN 'run_agent_offline' ELSE 'connection_or_session_offline' END
      WHEN NEW.status IN ('active', 'idle') THEN NULL
      ELSE end_reason
    END,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE actor_id = NEW.id;
END;

CREATE TRIGGER runs_presence_sync_agent
AFTER UPDATE OF agent_id ON runs
WHEN NEW.agent_id IS NOT NULL
BEGIN
  UPDATE agent_presences SET
    project_id = NEW.project_id,
    runner_id = NEW.runner_id,
    run_id = NEW.id,
    sitting = NEW.sitting,
    state = CASE WHEN NEW.status IN ('dispatched', 'running', 'blocked') THEN 'working' ELSE state END,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE kind = 'run_process' AND actor_id = NEW.agent_id;
END;

CREATE TRIGGER runners_presence_insert
AFTER INSERT ON runners
BEGIN
  INSERT OR IGNORE INTO agent_presences (
    id, kind, source_key, runner_id, state, started_at, last_seen_at,
    ended_at, end_reason, created_at, updated_at
  ) VALUES (
    'prs_runner_' || NEW.id, 'runner_daemon', NEW.id, NEW.id,
    CASE WHEN NEW.offboarded_at IS NOT NULL THEN 'ended'
         WHEN NEW.last_heartbeat_at IS NOT NULL THEN 'online' ELSE 'unknown' END,
    NEW.created_at, NEW.last_heartbeat_at, NEW.offboarded_at,
    CASE WHEN NEW.offboarded_at IS NOT NULL THEN 'runner_offboarded' ELSE NULL END,
    NEW.created_at, NEW.created_at
  );
END;

CREATE TRIGGER runners_presence_sync
AFTER UPDATE OF last_heartbeat_at, status, offboarded_at ON runners
BEGIN
  UPDATE agent_presences SET
    last_seen_at = CASE
      WHEN NEW.last_heartbeat_at IS NOT NULL
       AND (last_seen_at IS NULL OR NEW.last_heartbeat_at > last_seen_at) THEN NEW.last_heartbeat_at
      ELSE last_seen_at
    END,
    state = CASE
      WHEN NEW.offboarded_at IS NOT NULL THEN 'ended'
      WHEN NEW.last_heartbeat_at IS NOT NULL THEN 'online'
      ELSE state
    END,
    ended_at = CASE WHEN NEW.offboarded_at IS NOT NULL THEN NEW.offboarded_at ELSE NULL END,
    end_reason = CASE WHEN NEW.offboarded_at IS NOT NULL THEN 'runner_offboarded' ELSE NULL END,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE kind = 'runner_daemon' AND runner_id = NEW.id;
END;
