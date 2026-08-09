-- PLNR-326: additive foundation for layered authorization.
--
-- The legacy owner/group reach rules stay in place during the compatibility phase. New
-- enforcement resolves these rows in shadow first; a later migration can retire the legacy
-- projects.group_id authorization fallback after access parity has been audited.

ALTER TABLE users ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'read_write'
  CHECK (access_mode IN ('read_write', 'read_only'));
ALTER TABLE users ADD COLUMN can_create_projects INTEGER
  CHECK (can_create_projects IS NULL OR can_create_projects IN (0, 1));
ALTER TABLE users ADD COLUMN can_create_groups INTEGER
  CHECK (can_create_groups IS NULL OR can_create_groups IN (0, 1));

-- Group roles govern the group itself; they do not imply a project role. Existing accepted
-- members could all administer their groups, so backfill them as managers to preserve behavior.
-- A known creator is promoted to owner. Pending invitees remain ordinary members.
ALTER TABLE user_groups ADD COLUMN role TEXT NOT NULL DEFAULT 'member'
  CHECK (role IN ('owner', 'manager', 'member'));
UPDATE user_groups SET role = 'manager' WHERE status = 'accepted';
UPDATE user_groups
   SET role = 'owner'
 WHERE status = 'accepted'
   AND user_id = (SELECT g.created_by FROM groups g WHERE g.id = user_groups.group_id);
CREATE INDEX idx_user_groups_group_role ON user_groups (group_id, status, role);

-- Ownership remains projects.owner_user_id and is therefore never duplicated here. A
-- polymorphic principal cannot have a useful SQLite FK, so principal lifecycle cleanup is
-- explicit in the user/group deletion paths.
CREATE TABLE project_grants (
  project_id      TEXT NOT NULL REFERENCES projects(id),
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group')),
  principal_id   TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('manager', 'contributor', 'viewer')),
  source         TEXT NOT NULL DEFAULT 'explicit' CHECK (source IN ('explicit', 'legacy_group')),
  created_by     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, principal_type, principal_id)
);
CREATE INDEX idx_project_grants_principal
  ON project_grants (principal_type, principal_id, project_id);

-- Preserve existing group-linked project reach as an explicit contributor grant. Accepted
-- membership is still checked when resolving the group principal, so pending invites gain no
-- access. projects.group_id remains as a temporary compatibility source during rollout.
INSERT INTO project_grants (project_id, principal_type, principal_id, role, source)
  SELECT id, 'group', group_id, 'contributor', 'legacy_group'
    FROM projects
   WHERE group_id IS NOT NULL;

-- Singleton instance policy. Per-user nullable overrides inherit these defaults.
CREATE TABLE authorization_settings (
  id                          INTEGER PRIMARY KEY CHECK (id = 1),
  default_can_create_projects INTEGER NOT NULL DEFAULT 1
    CHECK (default_can_create_projects IN (0, 1)),
  default_can_create_groups   INTEGER NOT NULL DEFAULT 1
    CHECK (default_can_create_groups IN (0, 1)),
  updated_by                  TEXT,
  updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO authorization_settings (id) VALUES (1);

-- Append-only authorization evidence. Resource and actor ids are soft references on purpose:
-- audit history must survive deletion of the object or identity it describes.
CREATE TABLE authorization_audit_events (
  id            TEXT PRIMARY KEY,
  actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent', 'system')),
  actor_id      TEXT,
  action        TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   TEXT,
  decision      TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  reason        TEXT NOT NULL,
  metadata      TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_authorization_audit_created
  ON authorization_audit_events (created_at);
CREATE INDEX idx_authorization_audit_resource
  ON authorization_audit_events (resource_type, resource_id, created_at);
