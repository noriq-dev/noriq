// PLNR-231: priority runs 0 = MOST urgent to 4 = someday, matching P0/P1 everywhere else.
//
// The scale used to run the other way (4 = urgent), so the UI read "P0 · someday" and an agent
// asked for "the P0" picked the least important thing in the project. Inverting it means every
// ORDER BY over priority flips DESC -> ASC; a half-applied change ranks the entire backlog upside
// down while every test that merely round-trips a number keeps passing. These pin the ORDERING
// rather than the storage, across each surface that hands an agent work.
import { beforeAll, describe, expect, it } from 'vitest';
import { authorizeForAllProjects, createAgent, mcpCall } from './helpers';

describe('priority ordering: 0 is most urgent (PLNR-231)', () => {
  let orch: { id: string; apiKey: string };
  let worker: { id: string; apiKey: string };
  let pid: string;
  let urgent: { id: string; key: string };
  let someday: { id: string; key: string };

  beforeAll(async () => {
    orch = await createAgent('prio-orch', 'orchestrator');
    worker = await createAgent('prio-worker');
    pid = (await mcpCall(orch.apiKey, 'create_project', { key: 'PRIO', name: 'priority-scale' })).body.id;
    await authorizeForAllProjects(orch.apiKey, worker.apiKey);
    // Created least-urgent FIRST, so insertion order can't be what produces a passing result:
    // if the sort were dropped entirely, `someday` would come back first.
    someday = (await mcpCall(orch.apiKey, 'create_task', {
      projectId: pid, title: 'someday pile', tags: ['prio-scale'], allowNewTags: true, priority: 4,
    })).body;
    urgent = (await mcpCall(orch.apiKey, 'create_task', {
      projectId: pid, title: 'drop everything', tags: ['prio-scale'], priority: 0,
    })).body;
  }, 60000);

  it('next_claimable offers P0 before P4 — the pull loop takes the lowest number', async () => {
    const next = await mcpCall(worker.apiKey, 'next_claimable', { projectId: pid });
    expect(next.body.task?.key ?? next.body.key).toBe(urgent.key);
  });

  it('search_tasks returns urgent-first, i.e. ascending by priority', async () => {
    const res = await mcpCall(orch.apiKey, 'search_tasks', { projectId: pid });
    const prios = (res.body.tasks as Array<{ priority: number }>).map((t) => t.priority);
    expect(prios).toEqual([...prios].sort((a, b) => a - b));
    expect((res.body.tasks as Array<{ key: string }>)[0]?.key).toBe(urgent.key);
  });

  it('the claimable feed leads with P0', async () => {
    const updates = await mcpCall(worker.apiKey, 'my_updates', {});
    const claimable = (updates.body.claimable as Array<{ key: string; projectId: string }>)
      .filter((t) => t.projectId === pid);
    expect(claimable[0]?.key).toBe(urgent.key);
  });

  it('get_project carries the P0 task and not the P4 one', async () => {
    const keys = (await mcpCall(orch.apiKey, 'get_project', { projectId: pid }))
      .body.tasks.map((t: { key: string }) => t.key);
    expect(keys).toContain(urgent.key);
    expect(keys).not.toContain(someday.key);
  });

  it('the default priority is still the 2 midpoint — "normal" from either end', async () => {
    const plain = (await mcpCall(orch.apiKey, 'create_task', {
      projectId: pid, title: 'unspecified priority', tags: ['prio-scale'],
    })).body;
    const got = await mcpCall(orch.apiKey, 'get_task', { taskId: plain.id });
    expect(got.body.task.priority).toBe(2);
  });
});
