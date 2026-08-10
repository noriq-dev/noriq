import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  groupRoleAllows,
  projectRoleAllows,
  resolveAccountCapabilities,
  resolveGroupRole,
  resolveProjectAccess,
} from '../src/lib/authorization';
import { listWorkspaceProjects } from '../src/lib/workspace-operations';

const ids = {
  owner: 'usr_authz_owner',
  direct: 'usr_authz_direct',
  grouped: 'usr_authz_grouped',
  pending: 'usr_authz_pending',
  readonly: 'usr_authz_readonly',
  admin: 'usr_authz_admin',
  disabled: 'usr_authz_disabled',
  group: 'grp_authz',
  legacyGroup: 'grp_authz_legacy',
  project: 'prj_authz',
  legacyProject: 'prj_authz_legacy',
};

const userRows = [
  [ids.owner, 'authz-owner@example.test', 'Authz Owner', 'member', 'read_write', null, null, 0],
  [ids.direct, 'authz-direct@example.test', 'Authz Direct', 'member', 'read_write', 0, 1, 0],
  [ids.grouped, 'authz-grouped@example.test', 'Authz Grouped', 'member', 'read_write', null, null, 0],
  [ids.pending, 'authz-pending@example.test', 'Authz Pending', 'member', 'read_write', null, null, 0],
  [ids.readonly, 'authz-readonly@example.test', 'Authz Readonly', 'member', 'read_only', 1, 1, 0],
  [ids.admin, 'authz-admin@example.test', 'Authz Admin', 'admin', 'read_write', null, null, 0],
  [ids.disabled, 'authz-disabled@example.test', 'Authz Disabled', 'member', 'read_write', 1, 1, 1],
] as const;

describe('layered authorization foundation (PLNR-326)', () => {
  beforeAll(async () => {
    await env.DB.batch([
      ...userRows.map((row) => env.DB.prepare(
        `INSERT INTO users
          (id, email, name, role, access_mode, can_create_projects, can_create_groups, disabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(...row)),
      env.DB.prepare('INSERT INTO groups (id, name, created_by) VALUES (?, ?, ?)')
        .bind(ids.group, 'Authorization group', ids.owner),
      env.DB.prepare('INSERT INTO groups (id, name, created_by) VALUES (?, ?, ?)')
        .bind(ids.legacyGroup, 'Legacy authorization group', ids.owner),
      env.DB.prepare("INSERT INTO user_groups (user_id, group_id, status, role) VALUES (?, ?, 'accepted', 'member')")
        .bind(ids.grouped, ids.group),
      env.DB.prepare("INSERT INTO user_groups (user_id, group_id, status, role) VALUES (?, ?, 'accepted', 'owner')")
        .bind(ids.owner, ids.group),
      env.DB.prepare("INSERT INTO user_groups (user_id, group_id, status, role) VALUES (?, ?, 'accepted', 'manager')")
        .bind(ids.direct, ids.group),
      env.DB.prepare("INSERT INTO user_groups (user_id, group_id, status, role) VALUES (?, ?, 'pending', 'member')")
        .bind(ids.pending, ids.group),
      env.DB.prepare("INSERT INTO user_groups (user_id, group_id, status, role) VALUES (?, ?, 'accepted', 'member')")
        .bind(ids.grouped, ids.legacyGroup),
      env.DB.prepare(
        `INSERT INTO projects (id, key, name, owner_user_id, claim_ttl_seconds)
         VALUES (?, 'AUTHZ', 'Authorization project', ?, 1800)`,
      ).bind(ids.project, ids.owner),
      env.DB.prepare(
        `INSERT INTO projects (id, key, name, owner_user_id, group_id, claim_ttl_seconds)
         VALUES (?, 'AUTHZL', 'Legacy authorization project', ?, ?, 1800)`,
      ).bind(ids.legacyProject, ids.owner, ids.legacyGroup),
      env.DB.prepare(
        "INSERT INTO project_grants (project_id, principal_type, principal_id, role) VALUES (?, 'user', ?, 'manager')",
      ).bind(ids.project, ids.direct),
      env.DB.prepare(
        "INSERT INTO project_grants (project_id, principal_type, principal_id, role) VALUES (?, 'user', ?, 'manager')",
      ).bind(ids.project, ids.readonly),
      env.DB.prepare(
        "INSERT INTO project_grants (project_id, principal_type, principal_id, role) VALUES (?, 'user', ?, 'manager')",
      ).bind(ids.project, ids.disabled),
      env.DB.prepare(
        "INSERT INTO project_grants (project_id, principal_type, principal_id, role) VALUES (?, 'group', ?, 'contributor')",
      ).bind(ids.project, ids.group),
    ]);
  });

  afterAll(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM project_grants WHERE project_id IN (?, ?)').bind(ids.project, ids.legacyProject),
      env.DB.prepare('DELETE FROM projects WHERE id IN (?, ?)').bind(ids.project, ids.legacyProject),
      env.DB.prepare('DELETE FROM user_groups WHERE group_id IN (?, ?)').bind(ids.group, ids.legacyGroup),
      env.DB.prepare('DELETE FROM groups WHERE id IN (?, ?)').bind(ids.group, ids.legacyGroup),
      env.DB.prepare(`DELETE FROM users WHERE id IN (${userRows.map(() => '?').join(', ')})`).bind(...userRows.map((r) => r[0])),
    ]);
  });

  it('inherits instance creation defaults and honors per-account deny overrides', async () => {
    const owner = await resolveAccountCapabilities(env.DB, ids.owner);
    expect(owner.canCreateProjects).toBe(true);
    expect(owner.canCreateGroups).toBe(true);

    const direct = await resolveAccountCapabilities(env.DB, ids.direct);
    expect(direct.canCreateProjects).toBe(false);
    expect(direct.canCreateGroups).toBe(true);
  });

  it('makes ownership implicit and resolves direct and accepted-group grants', async () => {
    expect((await resolveProjectAccess(env.DB, ids.owner, ids.project)).role).toBe('owner');
    expect((await resolveProjectAccess(env.DB, ids.direct, ids.project)).role).toBe('manager');
    expect((await resolveProjectAccess(env.DB, ids.grouped, ids.project)).role).toBe('contributor');

    const pending = await resolveProjectAccess(env.DB, ids.pending, ids.project);
    expect(pending.role).toBeNull();
    expect(pending.source).toBe('none');
  });

  it('caps stronger grants at viewer for read-only accounts and denies disabled accounts', async () => {
    const readonly = await resolveProjectAccess(env.DB, ids.readonly, ids.project);
    expect(readonly.role).toBe('viewer');
    expect(readonly.cappedByReadOnly).toBe(true);
    expect(readonly.account.canCreateProjects).toBe(false);
    expect(readonly.account.canCreateGroups).toBe(false);

    const disabled = await resolveProjectAccess(env.DB, ids.disabled, ids.project);
    expect(disabled.role).toBeNull();
    expect(disabled.account.disabled).toBe(true);
  });

  it('treats group_id as metadata and requires an authoritative group grant', async () => {
    const metadataOnly = await resolveProjectAccess(env.DB, ids.grouped, ids.legacyProject);
    expect(metadataOnly.role).toBeNull();

    await env.DB.prepare(
      "INSERT INTO project_grants (project_id, principal_type, principal_id, role, source) VALUES (?, 'group', ?, 'contributor', 'legacy_group')",
    ).bind(ids.legacyProject, ids.legacyGroup).run();
    const granted = await resolveProjectAccess(env.DB, ids.grouped, ids.legacyProject);
    expect(granted.role).toBe('contributor');
    expect(granted.source).toBe('group_grant');
  });

  it('requires an explicit human-only admin override option', async () => {
    expect((await resolveProjectAccess(env.DB, ids.admin, ids.project)).role).toBeNull();
    const elevated = await resolveProjectAccess(env.DB, ids.admin, ids.project, { allowAdminOverride: true });
    expect(elevated.role).toBe('owner');
    expect(elevated.source).toBe('admin_override');
  });

  it('requires the same explicit override in shared workspace operations', async () => {
    const ordinary = await listWorkspaceProjects(env, { userId: ids.admin });
    expect(ordinary.some((project) => project.id === ids.project)).toBe(false);

    const elevated = await listWorkspaceProjects(env, { userId: ids.admin, allowAdminOverride: true });
    expect(elevated.some((project) => project.id === ids.project)).toBe(true);

    const pending = await listWorkspaceProjects(env, { userId: ids.pending });
    expect(pending.some((project) => project.id === ids.project)).toBe(false);
  });

  it('maps project roles to stable action thresholds', () => {
    expect(projectRoleAllows('viewer', 'view')).toBe(true);
    expect(projectRoleAllows('viewer', 'contribute')).toBe(false);
    expect(projectRoleAllows('manager', 'manage')).toBe(true);
    expect(projectRoleAllows('manager', 'own')).toBe(false);
    expect(projectRoleAllows('owner', 'own')).toBe(true);
  });

  it('resolves only accepted group roles and applies management thresholds', async () => {
    expect(await resolveGroupRole(env.DB, ids.owner, ids.group)).toBe('owner');
    expect(await resolveGroupRole(env.DB, ids.direct, ids.group)).toBe('manager');
    expect(await resolveGroupRole(env.DB, ids.grouped, ids.group)).toBe('member');
    expect(await resolveGroupRole(env.DB, ids.pending, ids.group)).toBeNull();
    expect(groupRoleAllows('member', 'view')).toBe(true);
    expect(groupRoleAllows('member', 'manage')).toBe(false);
    expect(groupRoleAllows('manager', 'manage')).toBe(true);
    expect(groupRoleAllows('manager', 'own')).toBe(false);
  });
});
