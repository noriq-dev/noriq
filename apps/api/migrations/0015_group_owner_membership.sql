-- PLNR-83: a project's owner is a member of that project's group — so everyone who
-- has a project in a shared group can see the group's other projects (grouped
-- visibility is member-driven). Backfill existing grouped projects whose owner
-- wasn't yet a member. Data-only, additive.
INSERT OR IGNORE INTO user_groups (user_id, group_id)
  SELECT owner_user_id, group_id FROM projects
  WHERE group_id IS NOT NULL AND owner_user_id IS NOT NULL;
