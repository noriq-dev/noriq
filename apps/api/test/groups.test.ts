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
  (await (await SELF.fetch('https://noriq.test/api/groups', { headers: { Cookie: cookie } })).json() as {
    groups: Array<{ id: string; name: string; canEdit: number }>;
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
  const g = await SELF.fetch('https://noriq.test/api/groups', {
    method: 'POST', headers: { Cookie: adminCookie, ...asJson }, body: JSON.stringify({ name: 'Env: staging' }),
  });
  groupId = (await g.json() as { id: string }).id;
  await SELF.fetch(`https://noriq.test/api/users/${memberAId}/groups`, {
    method: 'PUT', headers: { Cookie: adminCookie, ...asJson }, body: JSON.stringify({ groupIds: [groupId] }),
  });
});

describe('group authorization (PLNR-81)', () => {
  it('everyone sees every group, but canEdit reflects membership (PLNR-81 regression)', async () => {
    // A non-member must still SEE the group — the project directory needs group
    // names to resolve, or projects in unseen groups vanish from the UI.
    const bView = (await listGroups(bCookie)).find((g) => g.id === groupId);
    expect(bView).toBeTruthy();
    expect(bView!.canEdit).toBeFalsy(); // …but no edit rights

    expect((await listGroups(aCookie)).find((g) => g.id === groupId)?.canEdit).toBeTruthy(); // member
    expect((await listGroups(adminCookie)).find((g) => g.id === groupId)?.canEdit).toBeTruthy(); // admin
  });

  it('a non-member is forbidden from renaming or deleting the group', async () => {
    const patch = await SELF.fetch(`https://noriq.test/api/groups/${groupId}`, {
      method: 'PATCH', headers: { Cookie: bCookie, ...asJson }, body: JSON.stringify({ name: 'hijacked' }),
    });
    expect(patch.status).toBe(403);
    const del = await SELF.fetch(`https://noriq.test/api/groups/${groupId}`, { method: 'DELETE', headers: { Cookie: bCookie } });
    expect(del.status).toBe(403);
    // Untouched.
    expect((await listGroups(aCookie)).find((g) => g.id === groupId)?.name).toBe('Env: staging');
  });

  it('a member can rename the group', async () => {
    const patch = await SELF.fetch(`https://noriq.test/api/groups/${groupId}`, {
      method: 'PATCH', headers: { Cookie: aCookie, ...asJson }, body: JSON.stringify({ name: 'Env: prod' }),
    });
    expect(patch.status).toBe(200);
    expect((await listGroups(aCookie)).find((g) => g.id === groupId)?.name).toBe('Env: prod');
  });

  it('creating a group makes the creator a member who can then edit it', async () => {
    const g = await SELF.fetch('https://noriq.test/api/groups', {
      method: 'POST', headers: { Cookie: bCookie, ...asJson }, body: JSON.stringify({ name: 'B owns this' }),
    });
    const bGroupId = (await g.json() as { id: string }).id;
    expect((await listGroups(bCookie)).some((x) => x.id === bGroupId)).toBe(true); // visible to creator
    const patch = await SELF.fetch(`https://noriq.test/api/groups/${bGroupId}`, {
      method: 'PATCH', headers: { Cookie: bCookie, ...asJson }, body: JSON.stringify({ description: 'mine' }),
    });
    expect(patch.status).toBe(200);
  });

  it('members manage membership themselves; non-members are locked out (PLNR-83)', async () => {
    // Member A views membership and adds Member B to the group.
    const list = await SELF.fetch(`https://noriq.test/api/groups/${groupId}/members`, { headers: { Cookie: aCookie } });
    expect(list.status).toBe(200);

    // B (non-member) can't view or add.
    expect((await SELF.fetch(`https://noriq.test/api/groups/${groupId}/members`, { headers: { Cookie: bCookie } })).status).toBe(403);

    const bId = (await (await SELF.fetch('https://noriq.test/api/users', { headers: { Cookie: aCookie } })).json() as {
      users: Array<{ id: string; email: string }>;
    }).users.find((u) => u.email === 'grp-b@example.com')!.id;
    const add = await SELF.fetch(`https://noriq.test/api/groups/${groupId}/members`, {
      method: 'POST', headers: { Cookie: aCookie, ...asJson }, body: JSON.stringify({ userId: bId }),
    });
    expect(add.status).toBe(200);

    // B is now a member: sees the group as editable and can remove themself.
    expect((await listGroups(bCookie)).find((g) => g.id === groupId)?.canEdit).toBeTruthy();
    const remove = await SELF.fetch(`https://noriq.test/api/groups/${groupId}/members/${bId}`, {
      method: 'DELETE', headers: { Cookie: bCookie },
    });
    expect(remove.status).toBe(200);
    expect((await listGroups(bCookie)).find((g) => g.id === groupId)?.canEdit).toBeFalsy();
  });

  it('an admin can delete any group regardless of membership', async () => {
    const del = await SELF.fetch(`https://noriq.test/api/groups/${groupId}`, { method: 'DELETE', headers: { Cookie: adminCookie } });
    expect(del.status).toBe(200);
    expect((await listGroups(adminCookie)).some((g) => g.id === groupId)).toBe(false);
  });
});
