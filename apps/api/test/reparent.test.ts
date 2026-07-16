// PLNR-89: re-parent a task after creation via update_task.parentTaskId — so you
// can create tasks in key order first, then wire the tree.
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, mcpCall } from './helpers';

let agent: { id: string; apiKey: string };
let projectId: string;
let a: { id: string; key: string };
let b: { id: string; key: string };
let c: { id: string; key: string };

const parentOf = async (key: string) => {
  const proj = await mcpCall(agent.apiKey, 'get_project', { projectId });
  return (proj.body.tasks.find((t: { key: string }) => t.key === key)?.parentTaskId ?? null) as string | null;
};

beforeAll(async () => {
  agent = await createAgent('reparent-agent');
  projectId = (await mcpCall(agent.apiKey, 'create_project', { key: 'RP', name: 'reparent' })).body.id;
  a = (await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'epic A' })).body;
  b = (await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'epic B' })).body;
  c = (await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'child C' })).body;
}, 60000);

describe('re-parent task (PLNR-89)', () => {
  it('re-parents an existing task, addressing the parent by id and by key', async () => {
    expect(await parentOf(c.key)).toBeNull(); // created as a root
    expect((await mcpCall(agent.apiKey, 'update_task', { projectId, taskId: c.id, parentTaskId: a.id })).isError).toBe(false);
    expect(await parentOf(c.key)).toBe(a.id);
    expect((await mcpCall(agent.apiKey, 'update_task', { projectId, taskId: c.id, parentTaskId: b.key })).isError).toBe(false);
    expect(await parentOf(c.key)).toBe(b.id); // moved under B via its key
  });

  it('detaches to a root with null', async () => {
    await mcpCall(agent.apiKey, 'update_task', { projectId, taskId: c.id, parentTaskId: null });
    expect(await parentOf(c.key)).toBeNull();
  });

  it('rejects self-parenting and cycles', async () => {
    await mcpCall(agent.apiKey, 'update_task', { projectId, taskId: c.id, parentTaskId: a.id }); // C under A
    expect((await mcpCall(agent.apiKey, 'update_task', { projectId, taskId: a.id, parentTaskId: a.id })).isError).toBe(true); // self
    const cyc = await mcpCall(agent.apiKey, 'update_task', { projectId, taskId: a.id, parentTaskId: c.id }); // A under its child C
    expect(cyc.isError).toBe(true);
    expect(cyc.text).toMatch(/cycle/);
  });

  it('rejects a non-existent parent', async () => {
    const r = await mcpCall(agent.apiKey, 'update_task', { projectId, taskId: c.id, parentTaskId: 'task_does_not_exist' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not found/);
  });
});
