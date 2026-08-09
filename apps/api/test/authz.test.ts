// PLNR-92: every /api/projects/:pid/* route requires the caller to be able to
// REACH the project (owner, group member, or admin) — not merely signed in.
// Regression for the mass-IDOR write hole surfaced by the multi-agent review:
// writes went through room(pid) with only userAuth, so any logged-in user could
// create/update/delete/message in any project (ids are the guessable prj_<key>).
import { SELF, env } from 'cloudflare:test';
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

  it('project reach does not let a group contributor change project settings', async () => {
    const p = await req('/api/projects', ownerCookie, 'POST', { key: 'AZROLE', name: 'Role boundary' });
    const pid = (await p.json() as { id: string }).id;
    const g = await req('/api/groups', ownerCookie, 'POST', { name: 'AZ role group' });
    const gid = (await g.json() as { id: string }).id;
    const outsider = await env.DB.prepare("SELECT id FROM users WHERE email = 'az-outsider@example.com'")
      .first<{ id: string }>();
    expect((await req(`/api/groups/${gid}/members`, ownerCookie, 'POST', { userId: outsider!.id })).status).toBe(200);
    expect((await req(`/api/groups/${gid}/members/accept`, outsiderCookie, 'POST')).status).toBe(200);
    expect((await req(`/api/projects/${pid}/meta`, ownerCookie, 'PATCH', { groupId: gid })).status).toBe(200);

    // Accepted group membership gives contributor reach, not project management.
    expect((await req(`/api/projects/${pid}/meta`, outsiderCookie, 'PATCH', { name: 'contributor hijack' })).status).toBe(403);

    await env.DB.prepare(
      "INSERT INTO project_grants (project_id, principal_type, principal_id, role) VALUES (?, 'user', ?, 'manager')",
    ).bind(pid, outsider!.id).run();
    expect((await req(`/api/projects/${pid}/meta`, outsiderCookie, 'PATCH', { name: 'manager change' })).status).toBe(200);
    const snap = await (await req(`/api/projects/${pid}/snapshot`, ownerCookie)).json() as { project: { name: string } };
    expect(snap.project.name).toBe('manager change');
  });

  it('honors direct viewer grants and caps read-only owners at viewer actions', async () => {
    const outsider = await env.DB.prepare("SELECT id FROM users WHERE email = 'az-outsider@example.com'")
      .first<{ id: string }>();
    await env.DB.prepare(
      "INSERT INTO project_grants (project_id, principal_type, principal_id, role) VALUES (?, 'user', ?, 'viewer')",
    ).bind(projectId, outsider!.id).run();
    const viewerSnapshot = await req(`/api/projects/${projectId}/snapshot`, outsiderCookie);
    expect(viewerSnapshot.status).toBe(200);
    expect((await viewerSnapshot.json() as { project: Record<string, unknown> }).project).toMatchObject({
      effectiveRole: 'viewer', accessSource: 'user_grant', canView: true, canContribute: false, canManage: false, canOwn: false,
    });
    const viewerDirectory = await (await req('/api/projects', outsiderCookie)).json() as { projects: Array<Record<string, unknown>> };
    expect(viewerDirectory.projects.find((p) => p.id === projectId)).toMatchObject({
      effectiveRole: 'viewer', canView: true, canContribute: false,
    });
    const viewerWrite = await req(`/api/projects/${projectId}/tasks`, outsiderCookie, 'POST', { title: 'viewer write' });
    expect(viewerWrite.status).toBe(403);
    expect((await viewerWrite.json() as { code: string; action: string }).code).toBe('project_action_denied');

    const owner = await env.DB.prepare("SELECT id FROM users WHERE email = 'az-owner@example.com'")
      .first<{ id: string }>();
    await env.DB.prepare("UPDATE users SET access_mode = 'read_only' WHERE id = ?").bind(owner!.id).run();
    const me = await (await req('/api/auth/me', ownerCookie)).json() as { user: Record<string, unknown> };
    expect(me.user).toMatchObject({ accessMode: 'read_only', canCreateProjects: false, canCreateGroups: false });
    expect((await req(`/api/projects/${projectId}/snapshot`, ownerCookie)).status).toBe(200);
    const readonlyWrite = await req(`/api/projects/${projectId}/tasks`, ownerCookie, 'POST', { title: 'read-only write' });
    expect(readonlyWrite.status).toBe(403);
    expect((await readonlyWrite.json() as { reason: string }).reason).toBe('account is read-only');
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET access_mode = 'read_write' WHERE id = ?").bind(owner!.id),
      env.DB.prepare("DELETE FROM project_grants WHERE project_id = ? AND principal_type = 'user' AND principal_id = ?")
        .bind(projectId, outsider!.id),
    ]);
  });

  it("none of the outsider's attempts mutated the owner's task or project name", async () => {
    const snap = await (await req(`/api/projects/${projectId}/snapshot`, ownerCookie)).json() as {
      project: { name: string }; tasks: Array<{ id: string; status: string }>;
    };
    expect(snap.project.name).toBe('Owner project');
    expect(snap.tasks.find((x) => x.id === taskId)?.status).not.toBe('done');
  });
});
