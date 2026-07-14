-- Human ask (RUN-11 follow-up): "We still want Run visibility in the server."
-- Persist the Run's daemon-side git worktree path so the dashboard can show where
-- a Run is executing and the verify agent can reference the checkout. Additive,
-- nullable (populated when the daemon reports run.status with the worktree ready).
ALTER TABLE runs ADD COLUMN worktree_path TEXT;
