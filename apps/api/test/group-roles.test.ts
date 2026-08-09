import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createUser, loginSession } from './helpers';

const json = { 'Content-Type': 'application/json' };
const call = (path: string, cookie: string, method = 'GET', body?: unknown) => SELF.fetch(`https://noriq.test${path}`, {
  method, headers: { Cookie: cookie, ...json }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
let ownerCookie = '';
let secondCookie = '';
let ownerId = '';
let secondId = '';
let groupId = '';

beforeAll(async () => {
  await createUser('group-role-owner@example.com', 'Group Role Owner', 'longenough1').catch(() => {});
  await createUser('group-role-second@example.com', 'Group Role Second', 'longenough1').catch(() => {});
  ownerCookie = await loginSession('group-role-owner@example.com', 'longenough1');
  secondCookie = await loginSession('group-role-second@example.com', 'longenough1');
  ownerId = (await env.DB.prepare("SELECT id FROM users WHERE email = 'group-role-owner@example.com'").first<{ id: string }>())!.id;
  secondId = (await env.DB.prepare("SELECT id FROM users WHERE email = 'group-role-second@example.com'").first<{ id: string }>())!.id;
  groupId = (await (await call('/api/groups', ownerCookie, 'POST', { name: 'Group role policy' })).json() as { id: string }).id;
});

describe('group role lifecycle (PLNR-334)', () => {
  it('supports consent, role changes, and strict last-owner protection', async () => {
    expect((await call(`/api/groups/${groupId}/members`, ownerCookie, 'POST', { userId: secondId, role: 'manager' })).status).toBe(200);
    expect((await call(`/api/groups/${groupId}/members/accept`, secondCookie, 'POST')).status).toBe(200);

    // Managers administer ordinary membership, but ownership changes remain owner-only.
    expect((await call(`/api/groups/${groupId}/members/${ownerId}`, secondCookie, 'PATCH', { role: 'manager' })).status).toBe(403);
    expect((await call(`/api/groups/${groupId}/members/${secondId}`, ownerCookie, 'PATCH', { role: 'owner' })).status).toBe(200);
    expect((await call(`/api/groups/${groupId}/members/${ownerId}`, ownerCookie, 'PATCH', { role: 'manager' })).status).toBe(200);

    const lastOwnerDemote = await call(`/api/groups/${groupId}/members/${secondId}`, secondCookie, 'PATCH', { role: 'member' });
    expect(lastOwnerDemote.status).toBe(409);
    expect(await lastOwnerDemote.json()).toMatchObject({ code: 'last_group_owner' });
    expect((await call(`/api/groups/${groupId}/members/${secondId}`, secondCookie, 'DELETE')).status).toBe(409);

    const roster = await (await call(`/api/groups/${groupId}/members`, secondCookie)).json() as { members: Array<{ id: string; role: string }> };
    expect(roster.members.find((m) => m.id === secondId)?.role).toBe('owner');
  });
});
