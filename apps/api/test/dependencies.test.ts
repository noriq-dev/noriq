// PLNR-58: add/remove dependencies from the UI (human REST endpoints).
// PLNR-241: cross-project dependencies — a blocker may live in another project.
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall } from './helpers';

let agent: { id: string; apiKey: string };
let projectId: string;
let a: string; // task ids
let b: string;
let cookie: string;

async function apiDep(method: 'POST' | 'DELETE', tid: string, depId: string) {
  const url =
    method === 'POST'
      ? `https://noriq.test/api/projects/${projectId}/tasks/${tid}/dependencies`
      : `https://noriq.test/api/projects/${projectId}/tasks/${tid}/dependencies/${depId}`;
  return SELF.fetch(url, {
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify({ dependsOnTaskId: depId }) : undefined,
  });
}

beforeAll(async () => {
  agent = await createAgent('dep-tester');
  await createUser('dep-human@example.com', 'Dep Human', 'longenough1', 'admin').catch(() => {});
  cookie = await loginSession('dep-human@example.com', 'longenough1');
  const proj = await mcpCall(agent.apiKey, 'create_project', { key: 'DEP', name: 'deps' });
  projectId = proj.body.id;
  a = (await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'A' })).body.id;
  b = (await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'B' })).body.id;
}, 60000);

describe('dependency management (PLNR-58)', () => {
  const depsOf = async (tid: string) => {
    const snap = await (await SELF.fetch(`https://noriq.test/api/projects/${projectId}/snapshot`, { headers: { Cookie: cookie } })).json() as {
      dependencies: Array<{ taskId: string; dependsOnTaskId: string }>;
    };
    return snap.dependencies.filter((d) => d.taskId === tid);
  };

  it('adds and removes a dependency', async () => {
    expect((await apiDep('POST', a, b)).status).toBe(200);
    expect(await depsOf(a)).toEqual([{ taskId: a, dependsOnTaskId: b }]);

    expect((await apiDep('DELETE', a, b)).status).toBe(200);
    expect(await depsOf(a)).toEqual([]);
  });

  it('rejects a cycle', async () => {
    expect((await apiDep('POST', a, b)).status).toBe(200); // A depends on B
    const res = await apiDep('POST', b, a); // B depends on A → cycle
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await res.json())).toMatch(/cycle/);
    await apiDep('DELETE', a, b); // cleanup
  });

  it('requires a session', async () => {
    const res = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/tasks/${a}/dependencies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dependsOnTaskId: b }),
    });
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(404);
  });
});

describe('create_task dependsOn resolution (PLNR-109)', () => {
  const depsOf = async (tid: string) => {
    const snap = await (await SELF.fetch(`https://noriq.test/api/projects/${projectId}/snapshot`, { headers: { Cookie: cookie } })).json() as {
      dependencies: Array<{ taskId: string; dependsOnTaskId: string }>;
    };
    return snap.dependencies.filter((d) => d.taskId === tid);
  };

  it('accepts a display key and stores the resolved id', async () => {
    const bKey = (await mcpCall(agent.apiKey, 'get_task', { projectId, taskId: b })).body.task.key as string;
    const created = (await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'depends-by-key', dependsOn: [bKey] })).body;
    expect(await depsOf(created.id)).toEqual([{ taskId: created.id, dependsOnTaskId: b }]);
  });

  it('accepts a task id', async () => {
    const created = (await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'depends-by-id', dependsOn: [a] })).body;
    expect(await depsOf(created.id)).toEqual([{ taskId: created.id, dependsOnTaskId: a }]);
  });

  it('rejects an unknown ref without creating the task', async () => {
    const res = await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'bad-dep', dependsOn: ['PLNR-9999'] });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not found or not accessible/);
    const snap = await (await SELF.fetch(`https://noriq.test/api/projects/${projectId}/snapshot`, { headers: { Cookie: cookie } })).json() as {
      tasks: Array<{ title: string }>;
    };
    expect(snap.tasks.some((t) => t.title === 'bad-dep')).toBe(false);
  });
});

// ---- PLNR-241: cross-project dependencies -----------------------------------------
describe('cross-project dependencies (PLNR-241)', () => {
  let otherProjectId: string;
  let foreignId: string; // a task in otherProjectId
  let foreignKey: string;

  const DB = (env as unknown as { DB: D1Database }).DB;
  const edgesOf = async (tid: string) =>
    (await DB.prepare('SELECT depends_on_task_id AS dep FROM dependencies WHERE task_id = ?').bind(tid).all<{ dep: string }>()).results;

  beforeAll(async () => {
    const other = await mcpCall(agent.apiKey, 'create_project', { key: 'DEPX', name: 'deps-across' });
    otherProjectId = other.body.id;
    const f = (await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId: otherProjectId, title: 'foreign blocker' })).body;
    foreignId = f.id;
    foreignKey = f.key;
  }, 60000);

  it('create_task accepts a foreign blocker and the claim gate holds across the boundary', async () => {
    const dependent = (await mcpCall(agent.apiKey, 'create_task', {
      tags: ['test-fixture'], projectId, title: 'gated-across-projects', dependsOn: [foreignId],
    })).body;
    expect(await edgesOf(dependent.id)).toEqual([{ dep: foreignId }]);

    const probe = await mcpCall(agent.apiKey, 'can_claim', { taskId: dependent.id });
    expect(probe.body.claimable).toBe(false);
    expect(probe.body.reason).toContain(foreignKey);

    const claim = await mcpCall(agent.apiKey, 'claim_task', { projectId, taskId: dependent.id });
    expect(claim.isError).toBe(true);
    expect(claim.text).toContain(foreignKey);

    // The dependent project's snapshot carries the foreign blocker's state (externalTasks).
    const snap = await (await SELF.fetch(`https://noriq.test/api/projects/${projectId}/snapshot`, { headers: { Cookie: cookie } })).json() as {
      externalTasks: Array<{ id: string; key?: string; status: string }>;
    };
    const ext = snap.externalTasks.find((e) => e.id === foreignId);
    expect(ext).toBeDefined();
    expect(ext!.key).toBe(foreignKey); // admin session reaches the blocker's project → full identity
    expect(ext!.status).toBe('todo');

    // Finishing the foreign blocker clears the gate…
    const settle = await mcpCall(agent.apiKey, 'update_task', { projectId: otherProjectId, taskId: foreignId, status: 'done' });
    expect(settle.isError).toBe(false);
    const claim2 = await mcpCall(agent.apiKey, 'claim_task', { projectId, taskId: dependent.id });
    expect(claim2.isError).toBe(false);

    // …and the DEPENDENT project hears about it (dependency.unblocked via the cross-room
    // notify, which is fire-and-forget — poll briefly).
    let unblocked: unknown;
    for (let i = 0; i < 40 && !unblocked; i++) {
      unblocked = await DB.prepare(
        "SELECT 1 FROM events WHERE project_id = ? AND verb = 'dependency.unblocked' AND subject_id = ?",
      ).bind(projectId, dependent.id).first();
      if (!unblocked) await new Promise((r) => setTimeout(r, 50));
    }
    expect(unblocked).toBeTruthy();
  }, 30000);

  it('add_dependency takes a foreign display key; remove_dependency drops the edge', async () => {
    const t = (await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'edge-by-key' })).body;
    const blocker = (await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId: otherProjectId, title: 'keyed blocker' })).body;
    const add = await mcpCall(agent.apiKey, 'add_dependency', { projectId, taskId: t.key, dependsOnTaskId: blocker.key });
    expect(add.isError).toBe(false);
    expect(await edgesOf(t.id)).toEqual([{ dep: blocker.id }]);

    const rm = await mcpCall(agent.apiKey, 'remove_dependency', { projectId, taskId: t.id, dependsOnTaskId: blocker.key });
    expect(rm.isError).toBe(false);
    expect(await edgesOf(t.id)).toEqual([]);
  });

  it('rejects a cycle that spans projects', async () => {
    const here = (await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'cycle-here' })).body;
    const there = (await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId: otherProjectId, title: 'cycle-there' })).body;
    expect((await mcpCall(agent.apiKey, 'add_dependency', { projectId, taskId: here.id, dependsOnTaskId: there.id })).isError).toBe(false);
    const back = await mcpCall(agent.apiKey, 'add_dependency', { projectId: otherProjectId, taskId: there.id, dependsOnTaskId: here.id });
    expect(back.isError).toBe(true);
    expect(back.text).toMatch(/cycle/);
  });

  it("refuses a blocker in a project the caller cannot reach, without confirming it exists", async () => {
    // A private project owned by a DIFFERENT user — outside the agent's user reach.
    await createUser('dep-outsider@example.com', 'Dep Outsider', 'longenough1', 'member').catch(() => {});
    const outsiderCookie = await loginSession('dep-outsider@example.com', 'longenough1');
    const proj = await (await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: outsiderCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'DEPPRIV', name: 'private-deps' }),
    })).json() as { id: string };
    const secret = await (await SELF.fetch(`https://noriq.test/api/projects/${proj.id}/tasks`, {
      method: 'POST', headers: { Cookie: outsiderCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'secret task' }),
    })).json() as { id: string };

    // create_task dependsOn and add_dependency both refuse with the same not-found shape.
    const viaCreate = await mcpCall(agent.apiKey, 'create_task', {
      tags: ['test-fixture'], projectId, title: 'no-reach-dep', dependsOn: [secret.id],
    });
    expect(viaCreate.isError).toBe(true);
    expect(viaCreate.text).toMatch(/not found or not accessible/);

    const t = (await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'no-reach-edge' })).body;
    const viaAdd = await mcpCall(agent.apiKey, 'add_dependency', { projectId, taskId: t.id, dependsOnTaskId: secret.id });
    expect(viaAdd.isError).toBe(true);
    expect(viaAdd.text).toMatch(/not found or not accessible/);
    expect(await edgesOf(t.id)).toEqual([]);
  });
});
