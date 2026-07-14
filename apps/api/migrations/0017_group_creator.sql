-- PLNR-93: groups get a creator so the "closed + self-join" rule can decide who may
-- put a project into a group. You may add a project to a group you CREATED or already
-- belong to, but you can't join someone else's group by dropping a project into it.
-- Plain TEXT (soft reference to users.id — avoids a deleteUser cascade edit); existing
-- groups keep created_by NULL, so their current members retain access but nobody can
-- self-join them.
ALTER TABLE groups ADD COLUMN created_by TEXT;
