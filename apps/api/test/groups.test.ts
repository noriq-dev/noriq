// PLNR-81: group authorization — only a group's members (or an admin) may see,
// rename, or delete it. Previously any authenticated user could edit any group.
import { SELF, env } from 'cloudflare:test';
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

  // --- PLNR-138: group membership is consent-based ---------------------------------
  // A self-service add creates a PENDING invite the target must accept; a pending invite
  // is NOT membership, so it grants neither edit rights nor project access.
  let bId: string;
  const groupProjectId = 'prj_grp_consent_test';
  const memberInvites = async (cookie: string) =>
    (await (await SELF.fetch('https://noriq.test/api/me/group-invites', { headers: { Cookie: cookie } })).json() as {
      invites: Array<{ groupId: string; groupName: string; invitedByName: string | null }>;
    }).invites;
  const seesProject = async (cookie: string, pid: string) =>
    ((await (await SELF.fetch('https://noriq.test/api/projects', { headers: { Cookie: cookie } })).json() as {
      projects: Array<{ id: string }>;
    }).projects).some((p) => p.id === pid);

  it('inviting a member creates a pending invite that grants no edit rights or access', async () => {
    // A member can view the roster and invite; a non-member is locked out of both.
    expect((await SELF.fetch(`https://noriq.test/api/groups/${groupId}/members`, { headers: { Cookie: aCookie } })).status).toBe(200);
    expect((await SELF.fetch(`https://noriq.test/api/groups/${groupId}/members`, { headers: { Cookie: bCookie } })).status).toBe(403);

    bId = (await (await SELF.fetch('https://noriq.test/api/users', { headers: { Cookie: aCookie } })).json() as {
      users: Array<{ id: string; email: string }>;
    }).users.find((u) => u.email === 'grp-b@example.com')!.id;

    // A group-scoped project that only members should see (owned by A, filed under the group).
    await env.DB.prepare(
      `INSERT OR IGNORE INTO projects (id, key, name, description, status, claim_ttl_seconds, owner_user_id, group_id, created_at)
       VALUES (?, 'GRPCON', 'grouped project', '', 'active', 1800, ?, ?, ?)`,
    ).bind(groupProjectId, memberAId, groupId, new Date().toISOString()).run();

    const add = await SELF.fetch(`https://noriq.test/api/groups/${groupId}/members`, {
      method: 'POST', headers: { Cookie: aCookie, ...asJson }, body: JSON.stringify({ userId: bId }),
    });
    expect(add.status).toBe(200);
    expect((await add.json() as { status: string }).status).toBe('pending'); // an invite, not a membership

    // Pending ≠ member: no edit rights, no access to the group's project, invisible as an owner-project.
    expect((await listGroups(bCookie)).find((g) => g.id === groupId)?.canEdit).toBeFalsy();
    expect(await seesProject(bCookie, groupProjectId)).toBe(false);

    // But B sees the invite waiting for them, and A's roster shows B as pending.
    expect((await memberInvites(bCookie)).some((i) => i.groupId === groupId)).toBe(true);
    const roster = (await (await SELF.fetch(`https://noriq.test/api/groups/${groupId}/members`, { headers: { Cookie: aCookie } })).json() as {
      members: Array<{ id: string; status: string }>;
    }).members;
    expect(roster.find((m) => m.id === bId)?.status).toBe('pending');
  });

  it('accepting the invite makes B a member with access; declining/leaving reverses it', async () => {
    // Accept: now a real member — editable, sees the group project, invite list clears.
    const accept = await SELF.fetch(`https://noriq.test/api/groups/${groupId}/members/accept`, { method: 'POST', headers: { Cookie: bCookie } });
    expect(accept.status).toBe(200);
    expect((await listGroups(bCookie)).find((g) => g.id === groupId)?.canEdit).toBeTruthy();
    expect(await seesProject(bCookie, groupProjectId)).toBe(true);
    expect((await memberInvites(bCookie)).some((i) => i.groupId === groupId)).toBe(false);

    // B leaves (removes their own accepted membership) — access is gone again.
    const leave = await SELF.fetch(`https://noriq.test/api/groups/${groupId}/members/${bId}`, { method: 'DELETE', headers: { Cookie: bCookie } });
    expect(leave.status).toBe(200);
    expect(await seesProject(bCookie, groupProjectId)).toBe(false);
  });

  it('declining an invite drops it with no access granted', async () => {
    // Re-invite, then B declines.
    await SELF.fetch(`https://noriq.test/api/groups/${groupId}/members`, {
      method: 'POST', headers: { Cookie: aCookie, ...asJson }, body: JSON.stringify({ userId: bId }),
    });
    expect((await memberInvites(bCookie)).some((i) => i.groupId === groupId)).toBe(true);
    const decline = await SELF.fetch(`https://noriq.test/api/groups/${groupId}/members/decline`, { method: 'POST', headers: { Cookie: bCookie } });
    expect(decline.status).toBe(200);
    expect((await memberInvites(bCookie)).some((i) => i.groupId === groupId)).toBe(false);
    expect(await seesProject(bCookie, groupProjectId)).toBe(false);
    // Accepting when there's nothing pending is a clean 404, not a silent membership.
    const ghost = await SELF.fetch(`https://noriq.test/api/groups/${groupId}/members/accept`, { method: 'POST', headers: { Cookie: bCookie } });
    expect(ghost.status).toBe(404);
  });

  it('an admin can delete any group regardless of membership', async () => {
    const del = await SELF.fetch(`https://noriq.test/api/groups/${groupId}`, { method: 'DELETE', headers: { Cookie: adminCookie } });
    expect(del.status).toBe(200);
    expect((await listGroups(adminCookie)).some((g) => g.id === groupId)).toBe(false);
  });
});
