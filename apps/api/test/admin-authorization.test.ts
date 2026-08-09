import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createUser, loginSession } from './helpers';

const json = { 'Content-Type': 'application/json' };
const call = (path: string, cookie: string, method = 'GET', body?: unknown) => SELF.fetch(`https://noriq.test${path}`, {
  method, headers: { Cookie: cookie, ...json }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
let adminCookie = '';
let memberCookie = '';
let memberId = '';
let projectId = '';

beforeAll(async () => {
  await createUser('policy-admin@example.com', 'Policy Admin', 'longenough1', 'admin').catch(() => {});
  await createUser('policy-member@example.com', 'Policy Member', 'longenough1').catch(() => {});
  adminCookie = await loginSession('policy-admin@example.com', 'longenough1');
  memberCookie = await loginSession('policy-member@example.com', 'longenough1');
  memberId = (await env.DB.prepare("SELECT id FROM users WHERE email = 'policy-member@example.com'").first<{ id: string }>())!.id;
  projectId = (await (await call('/api/projects', memberCookie, 'POST', { key: 'PADM', name: 'Admin override audit' })).json() as { id: string }).id;
});

describe('system authorization administration (PLNR-335)', () => {
  it('is admin-only and updates account ceilings and instance defaults', async () => {
    expect((await call('/api/admin/authorization', memberCookie)).status).toBe(403);
    const inventory = await call('/api/admin/authorization', adminCookie);
    expect(inventory.status).toBe(200);
    expect(await inventory.json()).toMatchObject({ settings: expect.any(Object), accounts: expect.any(Array), projects: expect.any(Array), groups: expect.any(Array), audit: expect.any(Array) });

    expect((await call(`/api/users/${memberId}`, adminCookie, 'PATCH', {
      accessMode: 'read_only', canCreateProjects: false, canCreateGroups: false,
    })).status).toBe(200);
    const me = await (await call('/api/auth/me', memberCookie)).json() as { user: Record<string, unknown> };
    expect(me.user).toMatchObject({ accessMode: 'read_only', canCreateProjects: false, canCreateGroups: false });

    expect((await call('/api/admin/authorization/settings', adminCookie, 'PATCH', { defaultCanCreateProjects: false })).status).toBe(200);
    expect((await env.DB.prepare('SELECT default_can_create_projects AS value FROM authorization_settings WHERE id = 1').first<{ value: number }>())!.value).toBe(0);
    // Restore global state before the test ends; the account override remains a local fixture.
    await call('/api/admin/authorization/settings', adminCookie, 'PATCH', { defaultCanCreateProjects: true });
  });

  it('records an explicit administrator project override before opening foreign work', async () => {
    expect((await call(`/api/admin/authorization/override/${projectId}`, adminCookie, 'POST')).status).toBe(200);
    const event = await env.DB.prepare(
      "SELECT reason FROM authorization_audit_events WHERE action = 'admin.project.override' AND resource_id = ? ORDER BY created_at DESC LIMIT 1",
    ).bind(projectId).first<{ reason: string }>();
    expect(event?.reason).toBe('explicit_admin_override');
  });
});
