-- PLNR-83: every project is either private (has an owner) or shared (has a group).
-- Legacy/agent-created projects had neither, which the old "ownerless → visible to
-- everyone" rule leaked to all users. Give every ownerless project an owner — the
-- founding admin (oldest admin, else oldest user) — so it becomes private to them
-- instead of globally visible. New agent-created projects set their owner going
-- forward (create_project). Data-only, additive.
UPDATE projects
   SET owner_user_id = COALESCE(
     (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1),
     (SELECT id FROM users ORDER BY created_at LIMIT 1)
   )
 WHERE owner_user_id IS NULL;
