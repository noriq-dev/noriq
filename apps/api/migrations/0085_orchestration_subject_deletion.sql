-- PLNR-366: entity deletion may clear an execution node's nullable subject pointer while the
-- immutable execution identity, hierarchy, actor, role, and textual stage/step remain intact.
-- This is deliberate historical degradation: the orchestration keeps its anchor and lineage,
-- but no longer holds a foreign key that prevents an explicitly requested task/plan deletion.

DROP TRIGGER execution_nodes_structure_immutable;

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
  OR (OLD.task_id IS NOT NEW.task_id AND NEW.task_id IS NOT NULL)
  OR (OLD.plan_id IS NOT NEW.plan_id AND NEW.plan_id IS NOT NULL)
  OR (OLD.run_id IS NOT NEW.run_id AND NEW.run_id IS NOT NULL)
  OR OLD.sitting IS NOT NEW.sitting
  OR OLD.stage IS NOT NEW.stage
  OR OLD.step IS NOT NEW.step
  OR OLD.gate_id IS NOT NEW.gate_id
BEGIN
  SELECT RAISE(ABORT, 'execution orchestration is immutable') WHERE OLD.orchestration_id != NEW.orchestration_id;
  SELECT RAISE(ABORT, 'execution project is immutable') WHERE OLD.project_id != NEW.project_id;
  SELECT RAISE(ABORT, 'execution structure is immutable: parent') WHERE OLD.parent_execution_id IS NOT NEW.parent_execution_id;
  SELECT RAISE(ABORT, 'execution local key is immutable') WHERE OLD.local_node_key IS NOT NEW.local_node_key;
  SELECT RAISE(ABORT, 'execution producer scope is immutable') WHERE OLD.producer_scope IS NOT NEW.producer_scope;
  SELECT RAISE(ABORT, 'execution kind is immutable') WHERE OLD.kind != NEW.kind;
  SELECT RAISE(ABORT, 'execution actor kind is immutable') WHERE OLD.actor_kind IS NOT NEW.actor_kind;
  SELECT RAISE(ABORT, 'execution actor is immutable') WHERE OLD.actor_id IS NOT NEW.actor_id;
  SELECT RAISE(ABORT, 'execution presence is immutable') WHERE OLD.presence_id IS NOT NEW.presence_id;
  SELECT RAISE(ABORT, 'execution task is immutable') WHERE OLD.task_id IS NOT NEW.task_id AND NEW.task_id IS NOT NULL;
  SELECT RAISE(ABORT, 'execution plan is immutable') WHERE OLD.plan_id IS NOT NEW.plan_id AND NEW.plan_id IS NOT NULL;
  SELECT RAISE(ABORT, 'execution run is immutable') WHERE OLD.run_id IS NOT NEW.run_id AND NEW.run_id IS NOT NULL;
  SELECT RAISE(ABORT, 'execution sitting is immutable') WHERE OLD.sitting IS NOT NEW.sitting;
  SELECT RAISE(ABORT, 'execution stage is immutable') WHERE OLD.stage IS NOT NEW.stage;
  SELECT RAISE(ABORT, 'execution step is immutable') WHERE OLD.step IS NOT NEW.step;
  SELECT RAISE(ABORT, 'execution gate is immutable') WHERE OLD.gate_id IS NOT NEW.gate_id;
END;
