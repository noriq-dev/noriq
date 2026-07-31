// PLNR-224: get_project is the project SCAFFOLD, not a task dump — it blew the MCP
// tool-result token budget on mature projects. It now returns only P0 (most urgent) OPEN
// tasks, only active/pending plans (completed ones skipped), and the fileLocking flag so an
// agent knows locking is mandatory here.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall } from './helpers';

describe('get_project shape (PLNR-224)', () => {
  let agent: { id: string; apiKey: string };
  let pid: string;
  let cookie: string;
  let p0: { id: string; key: string };
  let p2: { id: string; key: string };
  let p0done: { id: string; key: string };

  beforeAll(async () => {
    agent = await createAgent('shape-agent');
    pid = (await mcpCall(agent.apiKey, 'create_project', { key: 'SHP', name: 'shape' })).body.id;
    p0 = (await mcpCall(agent.apiKey, 'create_task', { projectId: pid, title: 'urgent open', tags: ['shape'], priority: 0 })).body;
    p2 = (await mcpCall(agent.apiKey, 'create_task', { projectId: pid, title: 'normal', tags: ['shape'], priority: 2 })).body;
    p0done = (await mcpCall(agent.apiKey, 'create_task', { projectId: pid, title: 'urgent finished', tags: ['shape'], priority: 0 })).body;
    await mcpCall(agent.apiKey, 'claim_task', { projectId: pid, taskId: p0done.id });
    await mcpCall(agent.apiKey, 'release_task', { projectId: pid, taskId: p0done.id, toStatus: 'done' });
    cookie = await loginSession('agent-mint@example.com', 'longenough1').catch(async () => {
      await createUser('agent-mint@example.com', 'Agent Mint', 'longenough1', 'admin');
      return loginSession('agent-mint@example.com', 'longenough1');
    });
  }, 60000);

  it('returns only P0 open tasks — not the whole backlog', async () => {
    const keys = (await mcpCall(agent.apiKey, 'get_project', { projectId: pid })).body.tasks.map((t: { key: string }) => t.key);
    expect(keys).toContain(p0.key);
    expect(keys).not.toContain(p2.key); // lower priority — use search_tasks
    expect(keys).not.toContain(p0done.key); // P0 but finished
  });

  it('reports fileLocking as a boolean, following the REST opt-in', async () => {
    expect((await mcpCall(agent.apiKey, 'get_project', { projectId: pid })).body.project.fileLocking).toBe(false);
    const patch = await SELF.fetch(`https://noriq.test/api/projects/${pid}/meta`, {
      method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileLocking: true }),
    });
    expect(patch.status).toBe(200);
    expect((await mcpCall(agent.apiKey, 'get_project', { projectId: pid })).body.project.fileLocking).toBe(true);
  });

  it('lists active/pending plans and skips completed ones', async () => {
    const live = await mcpCall(agent.apiKey, 'create_plan', {
      projectId: pid, title: 'live plan', description: 'in flight',
      body: 'Work still to do.',
      phases: [{ title: 'P1', newTasks: [{ title: 'plan task', tags: ['shape'] }] }],
    });
    expect(live.isError).toBeFalsy();
    const finished = await mcpCall(agent.apiKey, 'create_plan', {
      projectId: pid, title: 'finished plan', description: 'all done',
      body: 'Everything landed.',
      phases: [{ title: 'P1', newTasks: [{ title: 'closed task', tags: ['shape'] }] }],
    });
    expect(finished.isError).toBeFalsy();
    // Drive the second plan's only task to done → the plan counts as completed.
    const doneTaskId = (await mcpCall(agent.apiKey, 'search_tasks', { projectId: pid, text: 'closed task' })).body.tasks[0].id;
    await mcpCall(agent.apiKey, 'claim_task', { projectId: pid, taskId: doneTaskId });
    await mcpCall(agent.apiKey, 'release_task', { projectId: pid, taskId: doneTaskId, toStatus: 'done' });

    const titles = (await mcpCall(agent.apiKey, 'get_project', { projectId: pid })).body.plans.map((p: { title: string }) => p.title);
    expect(titles).toContain('live plan');
    expect(titles).not.toContain('finished plan');
  });
});
