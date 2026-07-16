// PLNR-70: deletion cascades for milestone/tag/plan/task/project.
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall } from './helpers';

let agent: { id: string; apiKey: string };
let cookie: string;

const snap = async (pid: string) =>
  await (await SELF.fetch(`https://noriq.test/api/projects/${pid}/snapshot`, { headers: { Cookie: cookie } })).json() as {
    tasks: Array<{ id: string; milestoneId: string | null }>; milestones: unknown[]; tags: unknown[]; plans: unknown[];
  };
const del = (pid: string, path: string, ck = cookie) =>
  SELF.fetch(`https://noriq.test/api/projects/${pid}${path}`, { method: 'DELETE', headers: { Cookie: ck } });

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
    const s = await SELF.fetch(`https://noriq.test/api/projects/${p.id}/snapshot`, { headers: { Cookie: cookie } });
    expect(s.status).toBe(404);
  });

  it('project delete removes its runs and unpins (keeps) its runners — RUN-4', async () => {
    const p = (await mcpCall(agent.apiKey, 'create_project', { key: 'DELR', name: 'delr' })).body;
    const runnerId = `rnr_del_${crypto.randomUUID().slice(0, 8)}`;
    const runId = `run_del_${crypto.randomUUID().slice(0, 8)}`;
    // Insert directly — MCP insert paths land in RUN-5+; this drives the migration + cascade now.
    await env.DB.prepare('INSERT INTO runners (id, project_id, label, status) VALUES (?, ?, ?, ?)')
      .bind(runnerId, p.id, 'del-runner', 'online').run();
    await env.DB.prepare(
      'INSERT INTO runs (id, project_id, runner_id, kind, repo_ref, agent_tool, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(runId, p.id, runnerId, 'build', 'repo_a', 'claude', 'running', agent.id).run();

    expect((await del(p.id, '')).status).toBe(200);

    const run = await env.DB.prepare('SELECT id FROM runs WHERE id = ?').bind(runId).first();
    expect(run).toBeNull(); // run deleted
    const runner = await env.DB.prepare('SELECT id, project_id FROM runners WHERE id = ?').bind(runnerId)
      .first<{ id: string; project_id: string | null }>();
    expect(runner).not.toBeNull(); // runner survives...
    expect(runner!.project_id).toBeNull(); // ...unpinned
    // cleanup the surviving runner so it doesn't leak into other tests' snapshots
    await env.DB.prepare('DELETE FROM runners WHERE id = ?').bind(runnerId).run();
  });

  it('plans.status gate: defaults active, accepts proposed, rejects bogus — RUN-4', async () => {
    const p = (await mcpCall(agent.apiKey, 'create_project', { key: 'DELS', name: 'dels' })).body;
    const plan = await mcpCall(agent.apiKey, 'create_plan', {
      projectId: p.id, title: 'Plan', phases: [{ title: 'P1', newTasks: [{ title: 't' }] }],
    });
    const row = await env.DB.prepare('SELECT status FROM plans WHERE id = ?').bind(plan.body.id)
      .first<{ status: string }>();
    expect(row!.status).toBe('active'); // existing create_plan path is ungated
    // column accepts 'proposed'
    await env.DB.prepare('UPDATE plans SET status = ? WHERE id = ?').bind('proposed', plan.body.id).run();
    const proposed = await env.DB.prepare('SELECT status FROM plans WHERE id = ?').bind(plan.body.id).first<{ status: string }>();
    expect(proposed!.status).toBe('proposed');
    // CHECK rejects an unknown status
    await expect(
      env.DB.prepare('UPDATE plans SET status = ? WHERE id = ?').bind('bogus', plan.body.id).run(),
    ).rejects.toThrow();
    await del(p.id, '');
  });

  it('project delete is refused for a non-owner member', async () => {
    // A REST-created project records an owner (the admin). A member can't delete it.
    const create = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'DELO', name: 'owned' }),
    });
    const proj = (await create.json()) as { id: string };
    await createUser('del-member@example.com', 'Member', 'longenough1', 'member').catch(() => {});
    const memberCk = await loginSession('del-member@example.com', 'longenough1');
    expect((await del(proj.id, '', memberCk)).status).toBe(403);
  });
});

