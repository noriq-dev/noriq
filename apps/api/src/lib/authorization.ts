import type { Env } from '../env';
import { newId, nowIso } from './util';

export type SystemRole = 'admin' | 'user';
export type AccountAccessMode = 'read_write' | 'read_only';
export type GroupRole = 'owner' | 'manager' | 'member';
export type GroupAction = 'view' | 'manage' | 'own';
export type ProjectRole = 'owner' | 'manager' | 'contributor' | 'viewer';
export type ProjectAction = 'view' | 'contribute' | 'manage' | 'own';

export interface AccountCapabilities {
  userId: string;
  systemRole: SystemRole;
  accessMode: AccountAccessMode;
  canCreateProjects: boolean;
  canCreateGroups: boolean;
  disabled: boolean;
}

export type ProjectAccessSource =
  | 'owner'
  | 'user_grant'
  | 'group_grant'
  | 'admin_override'
  | 'none';

export interface EffectiveProjectAccess {
  exists: boolean;
  role: ProjectRole | null;
  source: ProjectAccessSource;
  cappedByReadOnly: boolean;
  account: AccountCapabilities;
}

const PROJECT_ROLE_RANK: Record<ProjectRole, number> = {
  viewer: 1,
  contributor: 2,
  manager: 3,
  owner: 4,
};

const ACTION_ROLE: Record<ProjectAction, ProjectRole> = {
  view: 'viewer',
  contribute: 'contributor',
  manage: 'manager',
  own: 'owner',
};

const GROUP_ROLE_RANK: Record<GroupRole, number> = {
  member: 1,
  manager: 2,
  owner: 3,
};

const GROUP_ACTION_ROLE: Record<GroupAction, GroupRole> = {
  view: 'member',
  manage: 'manager',
  own: 'owner',
};

const bool = (value: number | null | undefined, fallback: number): boolean =>
  (value ?? fallback) === 1;

/** Resolve instance defaults plus per-account overrides. A disabled or read-only account never
 * receives creation capabilities, even if stale rows still contain explicit allow overrides. */
export async function resolveAccountCapabilities(
  db: D1Database,
  userId: string,
): Promise<AccountCapabilities> {
  const row = await db.prepare(
    `SELECT CASE u.role WHEN 'admin' THEN 'admin' ELSE 'user' END AS systemRole,
            u.access_mode AS accessMode,
            u.can_create_projects AS canCreateProjects,
            u.can_create_groups AS canCreateGroups,
            u.disabled,
            COALESCE(s.default_can_create_projects, 1) AS defaultCanCreateProjects,
            COALESCE(s.default_can_create_groups, 1) AS defaultCanCreateGroups
       FROM users u
       LEFT JOIN authorization_settings s ON s.id = 1
      WHERE u.id = ?`,
  ).bind(userId).first<{
    systemRole: SystemRole;
    accessMode: AccountAccessMode;
    canCreateProjects: number | null;
    canCreateGroups: number | null;
    disabled: number;
    defaultCanCreateProjects: number;
    defaultCanCreateGroups: number;
  }>();

  if (!row) {
    return {
      userId,
      systemRole: 'user',
      accessMode: 'read_only',
      canCreateProjects: false,
      canCreateGroups: false,
      disabled: true,
    };
  }

  const disabled = row.disabled === 1;
  const writable = row.accessMode === 'read_write' && !disabled;
  return {
    userId,
    systemRole: row.systemRole,
    accessMode: row.accessMode,
    canCreateProjects: writable && bool(row.canCreateProjects, row.defaultCanCreateProjects),
    canCreateGroups: writable && bool(row.canCreateGroups, row.defaultCanCreateGroups),
    disabled,
  };
}

function stronger(
  current: { role: ProjectRole | null; source: ProjectAccessSource },
  role: ProjectRole | null,
  source: ProjectAccessSource,
): { role: ProjectRole | null; source: ProjectAccessSource } {
  if (!role || (current.role && PROJECT_ROLE_RANK[current.role] >= PROJECT_ROLE_RANK[role])) return current;
  return { role, source };
}

/**
 * Compute one user's effective role for a project.
 *
 * `allowAdminOverride` is deliberately explicit and defaults off. Human administration may opt
 * into it at a specific boundary; MCP/OAuth/Runner callers must leave it false so a credential
 * belonging to a system administrator does not become ambient authority over every project.
 *
 * Project ownership and project_grants are the only project authority. projects.group_id is
 * organizational metadata; linking a group dual-writes a tagged grant before this resolver runs.
 */
export async function resolveProjectAccess(
  db: D1Database,
  userId: string,
  projectId: string,
  options: { allowAdminOverride?: boolean } = {},
): Promise<EffectiveProjectAccess> {
  const [account, project] = await Promise.all([
    resolveAccountCapabilities(db, userId),
    db.prepare('SELECT owner_user_id AS ownerUserId FROM projects WHERE id = ?')
      .bind(projectId).first<{ ownerUserId: string | null }>(),
  ]);

  if (!project || account.disabled) {
    return { exists: !!project, role: null, source: 'none', cappedByReadOnly: false, account };
  }

  let access: { role: ProjectRole | null; source: ProjectAccessSource } = { role: null, source: 'none' };
  if (project.ownerUserId === userId) access = stronger(access, 'owner', 'owner');

  const [direct, group] = await Promise.all([
    db.prepare(
      `SELECT role FROM project_grants
        WHERE project_id = ? AND principal_type = 'user' AND principal_id = ?`,
    ).bind(projectId, userId).first<{ role: Exclude<ProjectRole, 'owner'> }>(),
    db.prepare(
      `SELECT pg.role
         FROM project_grants pg
         JOIN user_groups ug ON ug.group_id = pg.principal_id
        WHERE pg.project_id = ?
          AND pg.principal_type = 'group'
          AND ug.user_id = ?
          AND ug.status = 'accepted'
        ORDER BY CASE pg.role WHEN 'manager' THEN 3 WHEN 'contributor' THEN 2 ELSE 1 END DESC
        LIMIT 1`,
    ).bind(projectId, userId).first<{ role: Exclude<ProjectRole, 'owner'> }>(),
  ]);
  access = stronger(access, direct?.role ?? null, 'user_grant');
  access = stronger(access, group?.role ?? null, 'group_grant');

  if (options.allowAdminOverride && account.systemRole === 'admin') {
    access = stronger(access, 'owner', 'admin_override');
  }

  const cappedByReadOnly = account.accessMode === 'read_only' && access.role !== null && access.role !== 'viewer';
  if (cappedByReadOnly) access = { role: 'viewer', source: access.source };
  return { exists: true, ...access, cappedByReadOnly, account };
}

export function projectRoleAllows(role: ProjectRole | null, action: ProjectAction): boolean {
  return !!role && PROJECT_ROLE_RANK[role] >= PROJECT_ROLE_RANK[ACTION_ROLE[action]];
}

/** Pending invitations are deliberately not roles. Callers that need to render pending rows
 * query them directly; every authorization decision goes through this accepted-only resolver. */
export async function resolveGroupRole(
  db: D1Database,
  userId: string,
  groupId: string,
): Promise<GroupRole | null> {
  const row = await db.prepare(
    `SELECT role FROM user_groups
      WHERE user_id = ? AND group_id = ? AND status = 'accepted'`,
  ).bind(userId, groupId).first<{ role: GroupRole }>();
  return row?.role ?? null;
}

export function groupRoleAllows(role: GroupRole | null, action: GroupAction): boolean {
  return !!role && GROUP_ROLE_RANK[role] >= GROUP_ROLE_RANK[GROUP_ACTION_ROLE[action]];
}

export const userCanCreateProject = async (env: Env, userId: string): Promise<boolean> =>
  (await resolveAccountCapabilities(env.DB, userId)).canCreateProjects;

export const userCanCreateGroup = async (env: Env, userId: string): Promise<boolean> =>
  (await resolveAccountCapabilities(env.DB, userId)).canCreateGroups;

/** Append-only, metadata-minimal authorization evidence. Callers record policy changes and
 * consequential denials without storing request bodies, secrets, or resource content. */
export async function recordAuthorizationAudit(
  db: D1Database,
  event: {
    actorKind: 'human' | 'agent' | 'system';
    actorId?: string | null;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    decision: 'allow' | 'deny';
    reason: string;
    metadata?: Record<string, string | number | boolean | null>;
  },
): Promise<void> {
  await db.prepare(
    `INSERT INTO authorization_audit_events
      (id, actor_kind, actor_id, action, resource_type, resource_id, decision, reason, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    newId('aue'), event.actorKind, event.actorId ?? null, event.action, event.resourceType,
    event.resourceId ?? null, event.decision, event.reason, JSON.stringify(event.metadata ?? {}), nowIso(),
  ).run();
}
