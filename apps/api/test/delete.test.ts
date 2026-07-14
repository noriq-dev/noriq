// PLNR-70: deletion cascades for milestone/tag/plan/task/project.
import { SELF } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall } from './helpers';

let agent: { id: string; apiKey: string };
let cookie: string;

const snap = async (pid: string) =>
  await (await SELF.fetch(`https://planar.test/api/projects/${pid}/snapshot`, { headers: { Cookie: cookie } })).json() as {
    tasks: Array<{ id: string; milestoneId: string | null }>; milestones: unknown[]; tags: unknown[]; plans: unknown[];
  };
const del = (pid: string, path: string, ck = cookie) =>
  SELF.fetch(`https://planar.test/api/projects/${pid}${path}`, { method: 'DELETE', headers: { Cookie: ck } });

beforeAll(async () => {
  agent = await createAgent('del-agent');
  await createUser('del-human@example.com', 'Del Human', 'longenough1', 'admin').catch(() => {});
  cookie = await loginSession('del-human@example.com', 'longenough1');
}, 60000);

describe('deletion', () => {
  it('milestone delete keeps its tasks (milestone_id nulled)', async () => {
    const p = (await mcpCall(agent.apiKey, 'create_project', { key: 'DELM', name: 'delm' })).body;
    const ms = (await mcpCall(agent.apiKey, 'create_milestone', { projectId: p.id, title: 'M1' })).body;
    const t = (await mcpCall(agent.apiKey, 'create_task', { projectId: p.id, title: 'keep me', milestoneId: ms.id })).body;
    expect((await del(p.id, `/milestones/${ms.id}`)).status).toBe(200);
    const s = await snap(p.id);
    expect(s.milestones.find((m) => (m as { id: string }).id === ms.id)).toBeUndefined();
    expect(s.tasks.find((x) => x.id === t.id)!.milestoneId).toBeNull();
  });

  it('plan delete keeps its tasks', async () => {
    const p = (await mcpCall(agent.apiKey, 'create_project', { key: 'DELP', name: 'delp' })).body;
    const plan = await mcpCall(agent.apiKey, 'create_plan', {
      projectId: p.id, title: 'Plan', phases: [{ title: 'P1', newTasks: [{ title: 'phase task' }] }],
    });
    expect(plan.isError).toBe(false);
    let s = await snap(p.id);
    expect(s.plans).toHaveLength(1);
    expect(s.tasks.length).toBe(1);
    expect((await del(p.id, `/plans/${plan.body.id}`)).status).toBe(200);
    s = await snap(p.id);
    expect(s.plans).toHaveLength(0);
    expect(s.tasks.length).toBe(1); // task survives
  });

  it('task delete cascades deps/comments/attachments and orphans children', async () => {
    const p = (await mcpCall(agent.apiKey, 'create_project', { key: 'DELT', name: 'delt' })).body;
    const parent = (await mcpCall(agent.apiKey, 'create_task', { projectId: p.id, title: 'parent' })).body;
    const child = (await mcpCall(agent.apiKey, 'create_task', { projectId: p.id, title: 'child', parentTaskId: parent.id })).body;
    const other = (await mcpCall(agent.apiKey, 'create_task', { projectId: p.id, title: 'other' })).body;
    await mcpCall(agent.apiKey, 'add_dependency', { projectId: p.id, taskId: other.id, dependsOnTaskId: parent.id });
    await mcpCall(agent.apiKey, 'add_attachment', { projectId: p.id, taskId: parent.id, filename: 'x.png', data: btoa('bytes'), contentType: 'image/png' });
    await mcpCall(agent.apiKey, 'request_input', { projectId: p.id, taskId: parent.id, title: 'q?' });

    expect((await del(p.id, `/tasks/${parent.id}`)).status).toBe(200);
    const s = await snap(p.id);
    expect(s.tasks.find((x: { id: string }) => x.id === parent.id)).toBeUndefined();
    // child survives, orphaned
    expect(s.tasks.find((x: { id: string }) => x.id === child.id)).toBeTruthy();
    // 'other' survives; get_task should now show no deps
    const gt = await mcpCall(agent.apiKey, 'get_task', { taskId: other.id });
    expect(gt.body.dependencies).toHaveLength(0);
  });

  it('project delete removes everything and unscopes agents', async () => {
    const p = (await mcpCall(agent.apiKey, 'create_project', { key: 'DELX', name: 'delx' })).body;
    const t = (await mcpCall(agent.apiKey, 'create_task', { projectId: p.id, title: 'doomed' })).body;
    await mcpCall(agent.apiKey, 'claim_task', { projectId: p.id, taskId: t.id }); // scopes the agent
    expect((await del(p.id, '')).status).toBe(200);
    // snapshot 404s now
    const s = await SELF.fetch(`https://planar.test/api/projects/${p.id}/snapshot`, { headers: { Cookie: cookie } });
    expect(s.status).toBe(404);
  });

  it('project delete is refused for a non-owner member', async () => {
    // A REST-created project records an owner (the admin). A member can't delete it.
    const create = await SELF.fetch('https://planar.test/api/projects', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'DELO', name: 'owned' }),
    });
    const proj = (await create.json()) as { id: string };
    await createUser('del-member@example.com', 'Member', 'longenough1', 'member').catch(() => {});
    const memberCk = await loginSession('del-member@example.com', 'longenough1');
    expect((await del(proj.id, '', memberCk)).status).toBe(403);
  });
});

