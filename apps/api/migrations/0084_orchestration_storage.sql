-- 0084: canonical orchestration/execution authority (PLNR-365).
--
-- Actors remain attribution identities; these rows preserve the immutable execution tree,
-- timestamped lifecycle journal, and non-tree relations. Existing Runs are backfilled as honest
-- partial legacy roots/sittings. No parent is invented from agents.parent_agent_id.

CREATE TABLE orchestrations (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  anchor_type         TEXT NOT NULL CHECK (anchor_type IN ('task','plan','run','chat','none')),
  anchor_id           TEXT,
  root_execution_id   TEXT,
  status              TEXT NOT NULL CHECK (status IN ('pending','running','parked','succeeded','failed','cancelled','interrupted')),
  completeness_status TEXT NOT NULL CHECK (completeness_status IN ('complete','partial','unknown')),
  completeness_missing TEXT NOT NULL DEFAULT '[]',
  completeness_reason TEXT,
  created_by_kind     TEXT NOT NULL CHECK (created_by_kind IN ('human','copilot','agent','runner','system')),
  created_by_id       TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  finished_at         TEXT,
  CHECK ((anchor_type = 'none') = (anchor_id IS NULL))
);

CREATE TABLE execution_nodes (
  id                  TEXT PRIMARY KEY,
  orchestration_id    TEXT NOT NULL REFERENCES orchestrations(id) ON DELETE CASCADE,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_execution_id TEXT REFERENCES execution_nodes(id),
  local_node_key      TEXT,
  producer_scope      TEXT,
  declaration_hash    TEXT,
  kind                TEXT NOT NULL CHECK (kind IN ('copilot_session','run','sitting','stage','step','gate')),
  role                TEXT NOT NULL CHECK (role IN ('orchestrator','planner','worker','reviewer','verifier','repair','system')),
  actor_kind          TEXT CHECK (actor_kind IN ('human','copilot','agent','runner','system')),
  actor_id            TEXT,
  presence_id         TEXT,
  task_id             TEXT REFERENCES tasks(id),
  plan_id             TEXT REFERENCES plans(id),
  run_id              TEXT REFERENCES runs(id),
  sitting             INTEGER,
  stage               TEXT,
  step                TEXT,
  gate_id             TEXT,
  status              TEXT NOT NULL CHECK (status IN ('pending','running','parked','succeeded','failed','cancelled','interrupted')),
  completeness_status TEXT NOT NULL CHECK (completeness_status IN ('complete','partial','unknown')),
  completeness_missing TEXT NOT NULL DEFAULT '[]',
  completeness_reason TEXT,
  last_revision       INTEGER NOT NULL DEFAULT 0 CHECK (last_revision >= 0),
  started_at          TEXT,
  parked_at           TEXT,
  finished_at         TEXT,
  outcome_reason      TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK ((local_node_key IS NULL) = (producer_scope IS NULL)),
  CHECK ((actor_kind IS NULL) = (actor_id IS NULL)),
  UNIQUE (producer_scope, local_node_key)
);

CREATE TABLE execution_relations (
  id                TEXT PRIMARY KEY,
  orchestration_id  TEXT NOT NULL REFERENCES orchestrations(id) ON DELETE CASCADE,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_execution_id TEXT NOT NULL REFERENCES execution_nodes(id),
  to_execution_id   TEXT NOT NULL REFERENCES execution_nodes(id),
  type              TEXT NOT NULL CHECK (type IN ('continues','verifies','repairs','hands_off_to','depends_on')),
  metadata          TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  CHECK (from_execution_id != to_execution_id),
  UNIQUE (from_execution_id, to_execution_id, type)
);

CREATE TABLE execution_lifecycle_events (
  event_id          TEXT PRIMARY KEY,
  orchestration_id  TEXT NOT NULL REFERENCES orchestrations(id) ON DELETE CASCADE,
  execution_id      TEXT NOT NULL REFERENCES execution_nodes(id) ON DELETE CASCADE,
  revision          INTEGER NOT NULL CHECK (revision > 0),
  event_type        TEXT NOT NULL CHECK (event_type IN ('started','parked','resumed','succeeded','failed','cancelled','interrupted')),
  payload_hash      TEXT NOT NULL,
  observed_at       TEXT NOT NULL,
  reason            TEXT,
  metadata          TEXT NOT NULL DEFAULT '{}',
  accepted_at       TEXT NOT NULL,
  UNIQUE (execution_id, revision)
);

CREATE TABLE orchestration_rejections (
  id                TEXT PRIMARY KEY,
  orchestration_id  TEXT,
  project_id        TEXT NOT NULL,
  producer_scope    TEXT,
  local_node_key    TEXT,
  event_id          TEXT,
  reason            TEXT NOT NULL,
  detail            TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL
);

CREATE INDEX idx_orchestrations_project_status ON orchestrations (project_id, status, updated_at DESC);
CREATE INDEX idx_orchestrations_anchor ON orchestrations (project_id, anchor_type, anchor_id);
CREATE INDEX idx_execution_nodes_tree ON execution_nodes (orchestration_id, parent_execution_id, created_at);
CREATE INDEX idx_execution_nodes_subject_run ON execution_nodes (run_id, sitting, kind);
CREATE INDEX idx_execution_nodes_actor ON execution_nodes (actor_id, created_at DESC) WHERE actor_id IS NOT NULL;
CREATE INDEX idx_execution_nodes_live ON execution_nodes (project_id, status, updated_at DESC);
CREATE INDEX idx_execution_relations_orchestration ON execution_relations (orchestration_id, type);
CREATE INDEX idx_execution_events_node ON execution_lifecycle_events (execution_id, revision);
CREATE INDEX idx_orchestration_rejections_project ON orchestration_rejections (project_id, created_at DESC);

-- Structural identity and parentage are immutable. Lifecycle/completeness may advance, but a
-- historical node can never be moved to make a later hierarchy look nicer.
CREATE TRIGGER execution_nodes_structure_immutable
BEFORE UPDATE OF orchestration_id, project_id, parent_execution_id, local_node_key, producer_scope,
                 kind, actor_kind, actor_id, presence_id, task_id, plan_id, run_id, sitting,
                 stage, step, gate_id
ON execution_nodes
WHEN OLD.orchestration_id != NEW.orchestration_id
  OR OLD.project_id != NEW.project_id
  OR OLD.parent_execution_id IS NOT NEW.parent_execution_id
  OR OLD.local_node_key IS NOT NEW.local_node_key
  OR OLD.producer_scope IS NOT NEW.producer_scope
  OR OLD.kind != NEW.kind
  OR OLD.actor_kind IS NOT NEW.actor_kind
  OR OLD.actor_id IS NOT NEW.actor_id
  OR OLD.presence_id IS NOT NEW.presence_id
  OR OLD.task_id IS NOT NEW.task_id
  OR OLD.plan_id IS NOT NEW.plan_id
  OR OLD.run_id IS NOT NEW.run_id
  OR OLD.sitting IS NOT NEW.sitting
  OR OLD.stage IS NOT NEW.stage
  OR OLD.step IS NOT NEW.step
  OR OLD.gate_id IS NOT NEW.gate_id
BEGIN
  SELECT RAISE(ABORT, 'execution structure is immutable');
END;

CREATE TRIGGER execution_nodes_parent_scope_insert
BEFORE INSERT ON execution_nodes
WHEN NEW.parent_execution_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.parent_execution_id = NEW.id
    THEN RAISE(ABORT, 'execution cannot parent itself') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM execution_nodes p
     WHERE p.id = NEW.parent_execution_id
       AND p.orchestration_id = NEW.orchestration_id
       AND p.project_id = NEW.project_id
  ) THEN RAISE(ABORT, 'execution parent scope mismatch') END;
END;

CREATE TRIGGER execution_relations_scope_insert
BEFORE INSERT ON execution_relations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM execution_nodes f JOIN execution_nodes t
      ON t.id = NEW.to_execution_id
     WHERE f.id = NEW.from_execution_id
       AND f.orchestration_id = NEW.orchestration_id
       AND t.orchestration_id = NEW.orchestration_id
       AND f.project_id = NEW.project_id AND t.project_id = NEW.project_id
  ) THEN RAISE(ABORT, 'execution relation scope mismatch') END;
END;

CREATE TRIGGER execution_events_validate_insert
BEFORE INSERT ON execution_lifecycle_events
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM execution_nodes n
     WHERE n.id = NEW.execution_id AND n.orchestration_id = NEW.orchestration_id
  ) THEN RAISE(ABORT, 'execution event scope mismatch') END;
  SELECT CASE WHEN NEW.revision != (
    SELECT last_revision + 1 FROM execution_nodes WHERE id = NEW.execution_id
  ) THEN RAISE(ABORT, 'execution event revision mismatch') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM execution_nodes n WHERE n.id = NEW.execution_id AND (
      (n.status = 'pending' AND NEW.event_type IN ('started','cancelled','interrupted')) OR
      (n.status = 'running' AND NEW.event_type IN ('parked','succeeded','failed','cancelled','interrupted')) OR
      (n.status = 'parked' AND NEW.event_type IN ('resumed','failed','cancelled','interrupted'))
    )
  ) THEN RAISE(ABORT, 'illegal execution lifecycle transition') END;
END;

CREATE TRIGGER execution_events_apply_insert
AFTER INSERT ON execution_lifecycle_events
BEGIN
  UPDATE execution_nodes SET
    status = CASE NEW.event_type
      WHEN 'started' THEN 'running' WHEN 'resumed' THEN 'running' WHEN 'parked' THEN 'parked'
      WHEN 'succeeded' THEN 'succeeded' WHEN 'failed' THEN 'failed'
      WHEN 'cancelled' THEN 'cancelled' ELSE 'interrupted' END,
    last_revision = NEW.revision,
    started_at = CASE WHEN NEW.event_type IN ('started','resumed')
                      THEN COALESCE(started_at, NEW.observed_at) ELSE started_at END,
    parked_at = CASE WHEN NEW.event_type = 'parked' THEN NEW.observed_at
                     WHEN NEW.event_type = 'resumed' THEN NULL ELSE parked_at END,
    finished_at = CASE WHEN NEW.event_type IN ('succeeded','failed','cancelled','interrupted')
                       THEN NEW.observed_at ELSE finished_at END,
    outcome_reason = CASE WHEN NEW.event_type IN ('succeeded','failed','cancelled','interrupted')
                          THEN NEW.reason ELSE outcome_reason END,
    updated_at = NEW.accepted_at
  WHERE id = NEW.execution_id;
END;

CREATE TRIGGER orchestrations_root_once
BEFORE UPDATE OF root_execution_id ON orchestrations
WHEN OLD.root_execution_id IS NOT NULL AND OLD.root_execution_id IS NOT NEW.root_execution_id
BEGIN
  SELECT RAISE(ABORT, 'orchestration root is immutable');
END;

-- One orchestration per plan dispatch. A synthetic system stage is an honest legacy container;
-- there was no historical model actor/process for the fan-out itself.
INSERT INTO orchestrations (
  id, project_id, anchor_type, anchor_id, root_execution_id, status,
  completeness_status, completeness_missing, completeness_reason,
  created_by_kind, created_by_id, created_at, updated_at, finished_at
)
SELECT 'orc_legacy_pd_' || pd.id, pd.project_id, 'plan', pd.plan_id,
       'exe_legacy_pd_' || pd.id,
       CASE pd.status WHEN 'active' THEN 'running' WHEN 'stalled' THEN 'parked'
            WHEN 'completed' THEN 'succeeded' ELSE 'cancelled' END,
       'partial', '["events","legacy"]', 'legacy_plan_dispatch_backfill',
       CASE WHEN a.id IS NULL THEN 'human' ELSE a.kind END, pd.created_by,
       pd.created_at, pd.updated_at, pd.finished_at
  FROM plan_dispatches pd LEFT JOIN agents a ON a.id = pd.created_by;

INSERT INTO execution_nodes (
  id, orchestration_id, project_id, kind, role, actor_kind, actor_id, plan_id,
  status, completeness_status, completeness_missing, completeness_reason,
  started_at, parked_at, finished_at, created_at, updated_at
)
SELECT 'exe_legacy_pd_' || pd.id, 'orc_legacy_pd_' || pd.id, pd.project_id,
       'stage', 'orchestrator', 'system', 'system', pd.plan_id,
       CASE pd.status WHEN 'active' THEN 'running' WHEN 'stalled' THEN 'parked'
            WHEN 'completed' THEN 'succeeded' ELSE 'cancelled' END,
       'partial', '["actor","events","legacy"]', 'legacy_plan_dispatch_backfill',
       pd.created_at, CASE WHEN pd.status = 'stalled' THEN pd.updated_at END,
       pd.finished_at, pd.created_at, pd.updated_at
  FROM plan_dispatches pd;

-- One-off non-verifier Runs are roots. Verify Runs join the judged Run's orchestration below;
-- an orphaned verifier becomes its own partial root instead of inventing a missing target.
INSERT INTO orchestrations (
  id, project_id, anchor_type, anchor_id, root_execution_id, status,
  completeness_status, completeness_missing, completeness_reason,
  created_by_kind, created_by_id, created_at, updated_at, finished_at
)
SELECT 'orc_legacy_run_' || r.id, r.project_id, 'run', r.id,
       'exe_legacy_run_' || r.id,
       CASE r.status WHEN 'queued' THEN 'pending' WHEN 'dispatched' THEN 'running'
            WHEN 'running' THEN 'running' WHEN 'blocked' THEN 'parked'
            WHEN 'done' THEN 'succeeded' WHEN 'failed' THEN 'failed' ELSE 'cancelled' END,
       'partial', '["parent","events","legacy"]', 'legacy_run_backfill',
       CASE WHEN a.id IS NULL THEN 'human' ELSE a.kind END, r.created_by,
       r.created_at, r.updated_at,
       CASE WHEN r.status IN ('done','failed','cancelled') THEN r.updated_at END
  FROM runs r
  LEFT JOIN agents a ON a.id = r.created_by
 WHERE r.plan_dispatch_id IS NULL
   AND (r.verifies_run_id IS NULL OR NOT EXISTS (SELECT 1 FROM runs target WHERE target.id = r.verifies_run_id));

-- Canonical run nodes. The target Run supplies a verifier's orchestration; all other Runs use
-- their plan dispatch or their own root. A verifier's immediate structural parent is unknown, so
-- it remains a second partial root and gets an explicit verifies relation instead.
INSERT INTO execution_nodes (
  id, orchestration_id, project_id, parent_execution_id, kind, role,
  actor_kind, actor_id, task_id, plan_id, run_id, status,
  completeness_status, completeness_missing, completeness_reason,
  started_at, parked_at, finished_at, outcome_reason, created_at, updated_at
)
SELECT 'exe_legacy_run_' || r.id,
       CASE
         WHEN r.plan_dispatch_id IS NOT NULL THEN 'orc_legacy_pd_' || r.plan_dispatch_id
         WHEN r.verifies_run_id IS NOT NULL AND target.plan_dispatch_id IS NOT NULL THEN 'orc_legacy_pd_' || target.plan_dispatch_id
         WHEN r.verifies_run_id IS NOT NULL THEN 'orc_legacy_run_' || target.id
         ELSE 'orc_legacy_run_' || r.id
       END,
       r.project_id,
       CASE WHEN r.plan_dispatch_id IS NOT NULL THEN 'exe_legacy_pd_' || r.plan_dispatch_id ELSE NULL END,
       'run', CASE r.kind WHEN 'scope' THEN 'planner' WHEN 'verify' THEN 'verifier' ELSE 'worker' END,
       CASE WHEN r.agent_id IS NULL THEN NULL ELSE 'agent' END, r.agent_id,
       CASE WHEN r.anchor_type = 'task' THEN r.anchor_id END,
       COALESCE(r.plan_id, CASE WHEN r.anchor_type = 'plan' THEN r.anchor_id END),
       r.id,
       CASE r.status WHEN 'queued' THEN 'pending' WHEN 'dispatched' THEN 'running'
            WHEN 'running' THEN 'running' WHEN 'blocked' THEN 'parked'
            WHEN 'done' THEN 'succeeded' WHEN 'failed' THEN 'failed' ELSE 'cancelled' END,
       'partial', '["parent","events","legacy"]', 'legacy_run_backfill',
       r.started_at, CASE WHEN r.status = 'blocked' THEN r.updated_at END,
       CASE WHEN r.status IN ('done','failed','cancelled') THEN r.updated_at END,
       CASE WHEN r.status IN ('failed','cancelled') THEN r.status END,
       r.created_at, r.updated_at
  FROM runs r LEFT JOIN runs target ON target.id = r.verifies_run_id;

-- Every known sitting gets its own immutable process node. Earlier sittings exist only when a Run
-- was continued, which proves they failed; their exact actor/timestamps remain explicitly missing.
WITH RECURSIVE sequence(n) AS (
  SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < (SELECT COALESCE(MAX(sitting), 1) FROM runs)
)
INSERT INTO execution_nodes (
  id, orchestration_id, project_id, parent_execution_id, kind, role,
  actor_kind, actor_id, presence_id, task_id, plan_id, run_id, sitting, status,
  completeness_status, completeness_missing, completeness_reason,
  started_at, parked_at, finished_at, outcome_reason, created_at, updated_at
)
SELECT 'exe_legacy_sit_' || r.id || '_' || sequence.n,
       run_node.orchestration_id, r.project_id, run_node.id, 'sitting', run_node.role,
       CASE WHEN sequence.n = r.sitting AND r.agent_id IS NOT NULL THEN 'agent' END,
       CASE WHEN sequence.n = r.sitting THEN r.agent_id END,
       CASE WHEN sequence.n = r.sitting THEN (
         SELECT ap.id FROM agent_presences ap
          WHERE ap.actor_id = r.agent_id AND ap.run_id = r.id AND ap.sitting = r.sitting LIMIT 1
       ) END,
       run_node.task_id, run_node.plan_id, r.id, sequence.n,
       CASE WHEN sequence.n < r.sitting THEN 'failed' ELSE run_node.status END,
       'partial',
       CASE WHEN sequence.n < r.sitting THEN '["actor","presence","events","legacy"]'
            ELSE '["parent","events","legacy"]' END,
       'legacy_sitting_backfill',
       CASE WHEN sequence.n = r.sitting THEN r.started_at END,
       CASE WHEN sequence.n = r.sitting AND r.status = 'blocked' THEN r.updated_at END,
       CASE WHEN sequence.n < r.sitting OR r.status IN ('done','failed','cancelled') THEN r.updated_at END,
       CASE WHEN sequence.n < r.sitting THEN 'continued_after_failure'
            WHEN r.status IN ('failed','cancelled') THEN r.status END,
       r.created_at, r.updated_at
  FROM runs r JOIN execution_nodes run_node ON run_node.id = 'exe_legacy_run_' || r.id
  JOIN sequence ON sequence.n <= r.sitting;

INSERT INTO execution_relations (
  id, orchestration_id, project_id, from_execution_id, to_execution_id, type, metadata, created_at
)
SELECT 'rel_legacy_continue_' || r.id || '_' || sequence.n,
       run_node.orchestration_id, r.project_id,
       'exe_legacy_sit_' || r.id || '_' || (sequence.n + 1),
       'exe_legacy_sit_' || r.id || '_' || sequence.n,
       'continues', '{"source":"legacy_run_sitting"}', r.updated_at
  FROM runs r JOIN execution_nodes run_node ON run_node.id = 'exe_legacy_run_' || r.id
  JOIN (
    WITH RECURSIVE n(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < (SELECT COALESCE(MAX(sitting), 1) FROM runs)
    ) SELECT value AS n FROM n
  ) sequence ON sequence.n < r.sitting;

INSERT INTO execution_relations (
  id, orchestration_id, project_id, from_execution_id, to_execution_id, type, metadata, created_at
)
SELECT 'rel_legacy_verify_' || r.id, verifier.orchestration_id, r.project_id,
       verifier.id, target.id, 'verifies', '{"source":"runs.verifies_run_id"}', r.created_at
  FROM runs r
  JOIN execution_nodes verifier ON verifier.id = 'exe_legacy_run_' || r.id
  JOIN execution_nodes target ON target.id = 'exe_legacy_run_' || r.verifies_run_id
 WHERE r.verifies_run_id IS NOT NULL AND verifier.orchestration_id = target.orchestration_id;
