-- RunnerJob v2 initially named a task's opaque VCS checkpoint as a Git commit.
-- Keep existing values while removing that active Git assumption from storage.
ALTER TABLE runner_job_items RENAME COLUMN commit_revision TO checkpoint_ref;
