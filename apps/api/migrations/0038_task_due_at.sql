-- PLNR-126: per-task deadlines. Milestones had dueAt; tasks did not, so there was no
-- overdue signal and no time-based prioritization. Additive only.
ALTER TABLE tasks ADD COLUMN due_at TEXT;
