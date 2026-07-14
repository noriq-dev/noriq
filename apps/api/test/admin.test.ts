// PLNR-83: admins default to their own projects (?scope=all opts into all), and
// an agent — even an admin's, over MCP — is scoped to what its USER can reach,
// never admin-wide.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall } from './helpers';

let adminCookie: string;
let bobCookie: string;
let bobProjectId: string;
let agent: { id: string; apiKey: string };

const listProjects = async (cookie: string, scope?: string) =>
  (await (await SELF.fetch(`https://planar.test/api/projects${scope ? `?scope=${scope}` : ''}`, { headers: { Cookie: cookie } })).json() as {
    projects: Array<{ id: string; ownerName: string | null }>; admin: boolean;
  });

beforeAll(async () => {
  await createUser('av-admin@example.com', 'AV Admin', 'longenough1', 'admin').catch(() => {});
  await createUser('av-bob@example.com', 'AV Bob', 'longenough1').catch(() => {});
  adminCookie = await loginSession('av-admin@example.com', 'longenough1');
  bobCookie = await loginSession('av-bob@example.com', 'longenough1');

  // Bob owns a project (created via the web REST path → owner_user_id = bob).
  const p = await SELF.fetch('https://planar.test/api/projects', {
    method: 'POST', headers: { Cookie: bobCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'AVBOB', name: "Bob's private project" }),
  });
  bobProjectId = (await p.json() as { id: string }).id;

  agent = await createAgent('scoped-agent'); // minted under the admin mint-user
}, 60000);

describe('admin project scope (PLNR-83)', () => {
  it("an admin's default project list excludes other users' projects", async () => {
    const r = await listProjects(adminCookie);
    expect(r.admin).toBe(true); // UI may offer admin view
    expect(r.projects.some((p) => p.id === bobProjectId)).toBe(false); // not mine → hidden by default
  });

  it('?scope=all lets an admin see every project with owner attribution', async () => {
    const r = await listProjects(adminCookie, 'all');
    const bob = r.projects.find((p) => p.id === bobProjectId);
    expect(bob).toBeTruthy();
    expect(bob!.ownerName).toBe('AV Bob');
  });

  it('?scope=all is ignored for a non-admin (still only their own)', async () => {
    const r = await listProjects(bobCookie, 'all');
    expect(r.admin).toBe(false);
    expect(r.projects.some((p) => p.id === bobProjectId)).toBe(true);   // bob owns it
    // Bob sees only his own + shared; no escalation.
  });
});

describe("an agent is scoped to its user, not admin (PLNR-83)", () => {
  it("get_briefing does not list another user's owned project", async () => {
    const b = await mcpCall(agent.apiKey, 'get_briefing', {});
    expect(b.body.projects.some((p: { id: string }) => p.id === bobProjectId)).toBe(false);
  });

  it("project-scoped tools reject another user's project", async () => {
    const get = await mcpCall(agent.apiKey, 'get_project', { projectId: bobProjectId });
    expect(get.isError).toBe(true);
    expect(get.text).toMatch(/not found or not accessible|not found/);

    const create = await mcpCall(agent.apiKey, 'create_task', { projectId: bobProjectId, title: 'sneaky' });
    expect(create.isError).toBe(true);
  });

  it('a project the agent creates is owned by its user and workable', async () => {
    const p = await mcpCall(agent.apiKey, 'create_project', { key: 'AVAGT', name: 'agent project' });
    expect(p.isError).toBe(false);
    const t = await mcpCall(agent.apiKey, 'create_task', { projectId: p.body.id, title: 'ok' });
    expect(t.isError).toBe(false);
  });
});

describe('grouped projects are shared with the group members only (PLNR-83)', () => {
  it('a group project is visible to members, not to outsiders', async () => {
    const charlie = await createUser('av-charlie@example.com', 'AV Charlie', 'longenough1').catch(() => null);
    await createUser('av-dave@example.com', 'AV Dave', 'longenough1').catch(() => {});
    const charlieCookie = await loginSession('av-charlie@example.com', 'longenough1');
    const daveCookie = await loginSession('av-dave@example.com', 'longenough1');

    // Bob makes a group (auto-joins), adds Charlie, and moves his project into it.
    // Admin is deliberately NOT a member, to prove grouped != globally visible.
    const g = await SELF.fetch('https://planar.test/api/groups', {
      method: 'POST', headers: { Cookie: bobCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Team X' }),
    });
    const gid = (await g.json() as { id: string }).id;
    await SELF.fetch(`https://planar.test/api/groups/${gid}/members`, {
      method: 'POST', headers: { Cookie: bobCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: charlie!.id }),
    });
    await SELF.fetch(`https://planar.test/api/projects/${bobProjectId}/meta`, {
      method: 'PATCH', headers: { Cookie: bobCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId: gid }),
    });

    // Member sees it; outsider does not.
    expect((await listProjects(charlieCookie)).projects.some((p) => p.id === bobProjectId)).toBe(true);
    expect((await listProjects(daveCookie)).projects.some((p) => p.id === bobProjectId)).toBe(false);
    // Admin isn't a member/owner → not in the default view; ?scope=all still shows it.
    expect((await listProjects(adminCookie)).projects.some((p) => p.id === bobProjectId)).toBe(false);
    expect((await listProjects(adminCookie, 'all')).projects.some((p) => p.id === bobProjectId)).toBe(true);
  });

  it('putting your project in a group joins you, so co-members see each others projects', async () => {
    await createUser('av-ed@example.com', 'AV Ed', 'longenough1').catch(() => {});
    await createUser('av-fred@example.com', 'AV Fred', 'longenough1').catch(() => {});
    const edCookie = await loginSession('av-ed@example.com', 'longenough1');
    const fredCookie = await loginSession('av-fred@example.com', 'longenough1');
    const mkProject = async (cookie: string, key: string) => {
      const r = await SELF.fetch('https://planar.test/api/projects', {
        method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ key, name: key }),
      });
      return (await r.json() as { id: string }).id;
    };
    const setGroup = (cookie: string, pid: string, gid: string) => SELF.fetch(`https://planar.test/api/projects/${pid}/meta`, {
      method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId: gid }),
    });

    // Ed makes a group (auto-joins) and puts his project in it.
    const g = await SELF.fetch('https://planar.test/api/groups', {
      method: 'POST', headers: { Cookie: edCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Shared Nod' }),
    });
    const gid = (await g.json() as { id: string }).id;
    const edProj = await mkProject(edCookie, 'AVED');
    await setGroup(edCookie, edProj, gid);

    // Fred puts HIS project in the same group → he auto-joins it.
    const fredProj = await mkProject(fredCookie, 'AVFRED');
    await setGroup(fredCookie, fredProj, gid);

    // Both are now members and see each other's grouped projects.
    const fredSees = (await listProjects(fredCookie)).projects.map((p) => p.id);
    expect(fredSees).toContain(fredProj);
    expect(fredSees).toContain(edProj);   // ← the previously-broken case
    const edSees = (await listProjects(edCookie)).projects.map((p) => p.id);
    expect(edSees).toContain(fredProj);
  });
});
