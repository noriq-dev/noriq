-- PLNR-153: deletePlan tore down phases/phase_tasks/plans but left the dependency
-- edges createPlan minted to enforce phase ordering — permanently, with the plan
-- (the only artifact explaining them) gone. The fix needs to delete exactly the
-- edges the plan created and no others, and the schema couldn't say which those
-- were: a human-added Drawer edge and a plan-minted edge were indistinguishable.
--
-- created_by_plan_id is that provenance. NULL = a person (or pre-0036 code) chose
-- this edge; set = createPlan minted it to serialize phases, and deletePlan /
-- rejectPlan may reap it. Deliberately NOT a foreign key to plans(id): the edge is
-- deleted in the same batch as its plan, so enforcement would only constrain
-- statement order inside that batch, and existing rows all carry NULL anyway.
ALTER TABLE dependencies ADD COLUMN created_by_plan_id TEXT;
CREATE INDEX idx_deps_plan ON dependencies (created_by_plan_id) WHERE created_by_plan_id IS NOT NULL;
