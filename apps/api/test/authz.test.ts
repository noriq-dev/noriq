// PLNR-92: every /api/projects/:pid/* route requires the caller to be able to
// REACH the project (owner, group member, or admin) — not merely signed in.
// Regression for the mass-IDOR write hole surfaced by the multi-agent review:
// writes went through room(pid) with only userAuth, so any logged-in user could
// create/update/delete/message in any project (ids are the guessable prj_<key>).
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createUser, loginSession } from './helpers';

let ownerCookie: string;
let outsiderCookie: string;
let adminCookie: string;
let projectId: string;
let taskId: string;

const req = (path: string, cookie: string, method = 'GET', body?: unknown) =>
  SELF.fetch(`https://noriq.test${path}`, {
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

beforeAll(async () => {
  await createUser('az-owner@example.com', 'AZ Owner', 'longenough1').catch(() => {});
  await createUser('az-outsider@example.com', 'AZ Outsider', 'longenough1').catch(() => {});
  await createUser('az-admin@example.com', 'AZ Admin', 'longenough1', 'admin').catch(() => {});
  ownerCookie = await loginSession('az-owner@example.com', 'longenough1');
  outsiderCookie = await loginSession('az-outsider@example.com', 'longenough1');
  adminCookie = await loginSession('az-admin@example.com', 'longenough1');

  const p = await req('/api/projects', ownerCookie, 'POST', { key: 'AZP', name: 'Owner project' });
  projectId = (await p.json() as { id: string }).id;
  const t = await req(`/api/projects/${projectId}/tasks`, ownerCookie, 'POST', { title: 'owned task' });
  taskId = (await t.json() as { id: string }).id;
}, 60000);

describe('project write routes require project access (PLNR-92)', () => {
  it('the owner can create a task', async () => {
    expect((await req(`/api/projects/${projectId}/tasks`, ownerCookie, 'POST', { title: 'ok' })).status).toBe(200);
  });

  it('an outsider cannot create a task in the project', async () => {
    expect((await req(`/api/projects/${projectId}/tasks`, outsiderCookie, 'POST', { title: 'sneaky' })).status).toBe(404);
  });

  it('an outsider cannot update or delete a task in the project', async () => {
    expect((await req(`/api/projects/${projectId}/tasks/${taskId}`, outsiderCookie, 'PATCH', { status: 'done' })).status).toBe(404);
    expect((await req(`/api/projects/${projectId}/tasks/${taskId}`, outsiderCookie, 'DELETE')).status).toBe(404);
  });

  it('an outsider cannot inject a message into the project queue', async () => {
    expect((await req(`/api/projects/${projectId}/messages`, outsiderCookie, 'POST', { body: 'injected' })).status).toBe(404);
  });

  it('an outsider cannot rename/re-group the project via /meta', async () => {
    expect((await req(`/api/projects/${projectId}/meta`, outsiderCookie, 'PATCH', { name: 'hijacked' })).status).toBe(404);
  });

  it('an admin retains access to any project (escalation preserved)', async () => {
    expect((await req(`/api/projects/${projectId}/tasks`, adminCookie, 'POST', { title: 'admin ok' })).status).toBe(200);
  });

  it("none of the outsider's attempts mutated the owner's task or project name", async () => {
    const snap = await (await req(`/api/projects/${projectId}/snapshot`, ownerCookie)).json() as {
      project: { name: string }; tasks: Array<{ id: string; status: string }>;
    };
    expect(snap.project.name).toBe('Owner project');
    expect(snap.tasks.find((x) => x.id === taskId)?.status).not.toBe('done');
  });
});
