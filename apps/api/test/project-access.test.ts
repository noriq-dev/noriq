import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createUser, loginSession } from './helpers';

const json = { 'Content-Type': 'application/json' };
const call = (path: string, cookie: string, method = 'GET', body?: unknown) => SELF.fetch(`https://noriq.test${path}`, {
  method, headers: { Cookie: cookie, ...json }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

let ownerCookie = '';
let managerCookie = '';
let viewerCookie = '';
let ownerId = '';
let managerId = '';
let viewerId = '';
let projectId = '';

beforeAll(async () => {
  for (const [email, name] of [
    ['access-owner@example.com', 'Access Owner'],
    ['access-manager@example.com', 'Access Manager'],
    ['access-viewer@example.com', 'Access Viewer'],
  ] as const) await createUser(email, name, 'longenough1').catch(() => {});
  ownerCookie = await loginSession('access-owner@example.com', 'longenough1');
  managerCookie = await loginSession('access-manager@example.com', 'longenough1');
  viewerCookie = await loginSession('access-viewer@example.com', 'longenough1');
  const { results } = await env.DB.prepare("SELECT id, email FROM users WHERE email LIKE 'access-%@example.com'").all<{ id: string; email: string }>();
  ownerId = results.find((u) => u.email === 'access-owner@example.com')!.id;
  managerId = results.find((u) => u.email === 'access-manager@example.com')!.id;
  viewerId = results.find((u) => u.email === 'access-viewer@example.com')!.id;
  const project = await call('/api/projects', ownerCookie, 'POST', { key: 'PACCSS', name: 'Project access' });
  projectId = (await project.json() as { id: string }).id;
});

describe('project access management (PLNR-333)', () => {
  it('lets an owner delegate management and a manager grant/revoke viewer access', async () => {
    expect((await call(`/api/projects/${projectId}/access/grants`, ownerCookie, 'PUT', {
      principalType: 'user', principalId: managerId, role: 'manager',
    })).status).toBe(200);

    expect((await call(`/api/projects/${projectId}/access/grants`, managerCookie, 'PUT', {
      principalType: 'user', principalId: viewerId, role: 'viewer',
    })).status).toBe(200);
    const access = await (await call(`/api/projects/${projectId}/access`, managerCookie)).json() as {
      owner: { id: string }; grants: Array<{ principalId: string; role: string }>; canManageAccess: boolean;
    };
    expect(access.owner.id).toBe(ownerId);
    expect(access.canManageAccess).toBe(true);
    expect(access.grants).toEqual(expect.arrayContaining([
      expect.objectContaining({ principalId: managerId, role: 'manager' }),
      expect.objectContaining({ principalId: viewerId, role: 'viewer' }),
    ]));
    expect((await call(`/api/projects/${projectId}/snapshot`, viewerCookie)).status).toBe(200);

    expect((await call(`/api/projects/${projectId}/access/grants/user/${viewerId}`, managerCookie, 'DELETE')).status).toBe(200);
    expect((await call(`/api/projects/${projectId}/snapshot`, viewerCookie)).status).toBe(404);
  });

  it('protects ownership and retains the prior owner as manager on transfer', async () => {
    expect((await call(`/api/projects/${projectId}/access/transfer-owner`, managerCookie, 'POST', { ownerUserId: viewerId })).status).toBe(403);
    expect((await call(`/api/projects/${projectId}/access/transfer-owner`, ownerCookie, 'POST', { ownerUserId: viewerId })).status).toBe(200);
    expect((await env.DB.prepare('SELECT owner_user_id AS id FROM projects WHERE id = ?').bind(projectId).first<{ id: string }>())!.id).toBe(viewerId);
    expect((await env.DB.prepare("SELECT role FROM project_grants WHERE project_id = ? AND principal_type = 'user' AND principal_id = ?")
      .bind(projectId, ownerId).first<{ role: string }>())!.role).toBe('manager');
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM authorization_audit_events WHERE resource_id = ? AND action LIKE 'project.%'")
      .bind(projectId).first<{ n: number }>())!.n).toBeGreaterThanOrEqual(4);
  });
});
