-- PLNR-138: group membership is consent-based.
--
-- A self-service add (POST /api/groups/:gid/members) no longer makes someone a member
-- outright — it creates a PENDING invite the target must accept. Only 'accepted' rows
-- count as membership anywhere (canEdit, userCanAccessProject, the project directory),
-- so a pending invite pollutes nothing and grants no access until the target consents.
--
-- Existing rows are real memberships, so status defaults to 'accepted'. The trusted
-- provisioning paths — the creator's own row (POST /api/groups), admin invite
-- (POST /api/users/invite) and admin PUT /api/users/:uid/groups — insert without a
-- status and therefore stay 'accepted'; only the self-service add sets 'pending'.
--
-- user_groups is a leaf join table (nothing references it), so these ADD COLUMNs are
-- safely additive under D1's always-on FK enforcement.
ALTER TABLE user_groups ADD COLUMN status TEXT NOT NULL DEFAULT 'accepted';
ALTER TABLE user_groups ADD COLUMN invited_by TEXT;
ALTER TABLE user_groups ADD COLUMN invited_at TEXT;
