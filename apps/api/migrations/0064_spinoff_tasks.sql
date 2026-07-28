-- Spin-off tasks (PLNR-230, server half of RUN-188): a run agent files adjacent work as its
-- own task in a PROPOSED, ungated state — visible on the board, inert to every agent path
-- (claim, next_claimable, notices, plan-dispatch pump) until a human accepts it.
--
-- Additive only (D1 cannot rebuild the FK-heavy tasks table), and `proposed` is a WIRE-only
-- status derived from proposed_at — exactly the PLNR-178 `failed`/failed_at pattern, because
-- tasks.status carries a CHECK that cannot be widened.
--
-- proposed_at: non-NULL ⇔ awaiting the human accept/reject decision. Accept clears it
-- (task stays a real `todo`, now claimable); reject clears it and cancels the task.
ALTER TABLE tasks ADD COLUMN proposed_at TEXT;
-- Durable, queryable provenance — the runner's adjudicator verifies "real, out of scope,
-- tracked THERE" pointers against these. Deliberately WITHOUT foreign keys: the record must
-- survive its run being deleted (deleteProject cascade order stays untouched), same as
-- runs.anchor_id.
ALTER TABLE tasks ADD COLUMN spinoff_run_id TEXT;
ALTER TABLE tasks ADD COLUMN spinoff_source_task_id TEXT;
ALTER TABLE tasks ADD COLUMN spinoff_finding TEXT;
