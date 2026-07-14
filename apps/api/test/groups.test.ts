// PLNR-81: group authorization — only a group's members (or an admin) may see,
// rename, or delete it. Previously any authenticated user could edit any group.
import { SELF } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { createUser, loginSession } from './helpers';

let adminCookie: string;
let aCookie: string; // memberA — will belong to the group
let bCookie: string; // memberB — outsider
let memberAId: string;
let groupId: string;

const asJson = { 'Content-Type': 'application/json' };
const listGroups = async (cookie: string) =>
  (await (await SELF.fetch('https://planar.test/api/groups', { headers: { Cookie: cookie } })).json() as {
    groups: Array<{ id: string; name: string }>;
  }).groups;

beforeAll(async () => {
  await createUser('grp-admin@example.com', 'Grp Admin', 'longenough1', 'admin').catch(() => {});
  const a = await createUser('grp-a@example.com', 'Member A', 'longenough1').catch(() => null);
  await createUser('grp-b@example.com', 'Member B', 'longenough1').catch(() => {});
  adminCookie = await loginSession('grp-admin@example.com', 'longenough1');
  aCookie = await loginSession('grp-a@example.com', 'longenough1');
  bCookie = await loginSession('grp-b@example.com', 'longenough1');
  memberAId = a!.id;

  // Admin creates a group and puts Member A in it (Member B stays out).
  const g = await SELF.fetch('https://planar.test/api/groups', {
    method: 'POST', headers: { Cookie: adminCookie, ...asJson }, body: JSON.stringify({ name: 'Env: staging' }),
  });
  groupId = (await g.json() as { id: string }).id;
  await SELF.fetch(`https://planar.test/api/users/${memberAId}/groups`, {
    method: 'PUT', headers: { Cookie: adminCookie, ...asJson }, body: JSON.stringify({ groupIds: [groupId] }),
  });
});

describe('group authorization (PLNR-81)', () => {
  it('a non-member cannot see the group in the list', async () => {
    expect((await listGroups(bCookie)).some((g) => g.id === groupId)).toBe(false);
    expect((await listGroups(aCookie)).some((g) => g.id === groupId)).toBe(true); // member sees it
    expect((await listGroups(adminCookie)).some((g) => g.id === groupId)).toBe(true); // admin sees all
  });

  it('a non-member is forbidden from renaming or deleting the group', async () => {
    const patch = await SELF.fetch(`https://planar.test/api/groups/${groupId}`, {
      method: 'PATCH', headers: { Cookie: bCookie, ...asJson }, body: JSON.stringify({ name: 'hijacked' }),
    });
    expect(patch.status).toBe(403);
    const del = await SELF.fetch(`https://planar.test/api/groups/${groupId}`, { method: 'DELETE', headers: { Cookie: bCookie } });
    expect(del.status).toBe(403);
    // Untouched.
    expect((await listGroups(aCookie)).find((g) => g.id === groupId)?.name).toBe('Env: staging');
  });

  it('a member can rename the group', async () => {
    const patch = await SELF.fetch(`https://planar.test/api/groups/${groupId}`, {
      method: 'PATCH', headers: { Cookie: aCookie, ...asJson }, body: JSON.stringify({ name: 'Env: prod' }),
    });
    expect(patch.status).toBe(200);
    expect((await listGroups(aCookie)).find((g) => g.id === groupId)?.name).toBe('Env: prod');
  });

  it('creating a group makes the creator a member who can then edit it', async () => {
    const g = await SELF.fetch('https://planar.test/api/groups', {
      method: 'POST', headers: { Cookie: bCookie, ...asJson }, body: JSON.stringify({ name: 'B owns this' }),
    });
    const bGroupId = (await g.json() as { id: string }).id;
    expect((await listGroups(bCookie)).some((x) => x.id === bGroupId)).toBe(true); // visible to creator
    const patch = await SELF.fetch(`https://planar.test/api/groups/${bGroupId}`, {
      method: 'PATCH', headers: { Cookie: bCookie, ...asJson }, body: JSON.stringify({ description: 'mine' }),
    });
    expect(patch.status).toBe(200);
  });

  it('an admin can delete any group regardless of membership', async () => {
    const del = await SELF.fetch(`https://planar.test/api/groups/${groupId}`, { method: 'DELETE', headers: { Cookie: adminCookie } });
    expect(del.status).toBe(200);
    expect((await listGroups(adminCookie)).some((g) => g.id === groupId)).toBe(false);
  });
});
