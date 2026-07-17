-- A task whose gate FAILED (RUN-83 counterpart): the build ran, the daemon's verify/reviewer
-- gate refused it across its rounds, and no re-dispatch has re-claimed it. Before this, the agent
-- moved the task to `review` when it finished — BEFORE the gate ran — so a gate failure left the
-- task stranded in `review`, indistinguishable from work genuinely awaiting a human.
--
-- Additive timestamp, NOT a new `status` value. tasks.status carries a CHECK, and D1 cannot
-- rebuild a table with inbound foreign keys (0028, PLNR-143) — tasks has many (parent_task_id,
-- dependencies, comments, refs, tags, attachments, phase_tasks, signals). So the wire shape
-- DERIVES status='failed' from this column, exactly as runners derive 'offboarded' from
-- offboarded_at. Set when a gate-failed run terminates; cleared when the task is re-claimed for a
-- retry, so `failed_at IS NOT NULL` means precisely "the last run failed and it hasn't been
-- picked up again".
ALTER TABLE tasks ADD COLUMN failed_at TEXT;
CREATE INDEX idx_tasks_failed ON tasks (project_id, failed_at) WHERE failed_at IS NOT NULL;
