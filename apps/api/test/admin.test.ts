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

  it('but ownerless (agent-created) projects remain workable', async () => {
    const p = await mcpCall(agent.apiKey, 'create_project', { key: 'AVAGT', name: 'agent project' });
    expect(p.isError).toBe(false);
    const t = await mcpCall(agent.apiKey, 'create_task', { projectId: p.body.id, title: 'ok' });
    expect(t.isError).toBe(false);
  });
});
