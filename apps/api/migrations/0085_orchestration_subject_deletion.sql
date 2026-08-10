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
  SELECT CASE WHEN OLD.orchestration_id != NEW.orchestration_id THEN RAISE(ABORT, 'execution orchestration is immutable') END;
  SELECT CASE WHEN OLD.project_id != NEW.project_id THEN RAISE(ABORT, 'execution project is immutable') END;
  SELECT CASE WHEN OLD.parent_execution_id IS NOT NEW.parent_execution_id THEN RAISE(ABORT, 'execution structure is immutable: parent') END;
  SELECT CASE WHEN OLD.local_node_key IS NOT NEW.local_node_key THEN RAISE(ABORT, 'execution local key is immutable') END;
  SELECT CASE WHEN OLD.producer_scope IS NOT NEW.producer_scope THEN RAISE(ABORT, 'execution producer scope is immutable') END;
  SELECT CASE WHEN OLD.kind != NEW.kind THEN RAISE(ABORT, 'execution kind is immutable') END;
  SELECT CASE WHEN OLD.actor_kind IS NOT NEW.actor_kind THEN RAISE(ABORT, 'execution actor kind is immutable') END;
  SELECT CASE WHEN OLD.actor_id IS NOT NEW.actor_id THEN RAISE(ABORT, 'execution actor is immutable') END;
  SELECT CASE WHEN OLD.presence_id IS NOT NEW.presence_id THEN RAISE(ABORT, 'execution presence is immutable') END;
  SELECT CASE WHEN OLD.task_id IS NOT NEW.task_id AND NEW.task_id IS NOT NULL THEN RAISE(ABORT, 'execution task is immutable') END;
  SELECT CASE WHEN OLD.plan_id IS NOT NEW.plan_id AND NEW.plan_id IS NOT NULL THEN RAISE(ABORT, 'execution plan is immutable') END;
  SELECT CASE WHEN OLD.run_id IS NOT NEW.run_id AND NEW.run_id IS NOT NULL THEN RAISE(ABORT, 'execution run is immutable') END;
  SELECT CASE WHEN OLD.sitting IS NOT NEW.sitting THEN RAISE(ABORT, 'execution sitting is immutable') END;
  SELECT CASE WHEN OLD.stage IS NOT NEW.stage THEN RAISE(ABORT, 'execution stage is immutable') END;
  SELECT CASE WHEN OLD.step IS NOT NEW.step THEN RAISE(ABORT, 'execution step is immutable') END;
  SELECT CASE WHEN OLD.gate_id IS NOT NEW.gate_id THEN RAISE(ABORT, 'execution gate is immutable') END;
END;
