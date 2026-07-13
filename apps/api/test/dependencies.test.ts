// PLNR-58: add/remove dependencies from the UI (human REST endpoints).
import { SELF } from 'cloudflare:test';
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
      ? `https://planar.test/api/projects/${projectId}/tasks/${tid}/dependencies`
      : `https://planar.test/api/projects/${projectId}/tasks/${tid}/dependencies/${depId}`;
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
  a = (await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'A' })).body.id;
  b = (await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'B' })).body.id;
}, 60000);

describe('dependency management (PLNR-58)', () => {
  const depsOf = async (tid: string) => {
    const snap = await (await SELF.fetch(`https://planar.test/api/projects/${projectId}/snapshot`, { headers: { Cookie: cookie } })).json() as {
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
    const res = await SELF.fetch(`https://planar.test/api/projects/${projectId}/tasks/${a}/dependencies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dependsOnTaskId: b }),
    });
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(404);
  });
});
