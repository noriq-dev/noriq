-- PLNR-137: a milestone is a goal, but the schema could only store its name — no place
-- for what "done" means. Additive only.
ALTER TABLE milestones ADD COLUMN description TEXT NOT NULL DEFAULT '';
