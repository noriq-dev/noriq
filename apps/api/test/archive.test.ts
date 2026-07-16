// PLNR-73: task archive — manual archive/restore.
// PLNR-150: the snapshot no longer filters archived tasks out. Archiving is a board
// *display* concern, so it belongs at the render layer; filtering here silently drained
// every derived aggregate (milestone chips, plan phase rails) of the very tasks it was
// counting, and a milestone whose work was all done+archived read 0/0 instead of complete.
import { SELF } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall } from './helpers';

let agent: { id: string; apiKey: string };
let projectId: string;
let taskId: string;
let cookie: string;

const snapshot = async () =>
  await (await SELF.fetch(`https://noriq.test/api/projects/${projectId}/snapshot`, { headers: { Cookie: cookie } })).json() as {
    tasks: Array<{ id: string; status: string; milestoneId: string | null; archivedAt: string | null }>;
  };
const tasksIn = async () => (await snapshot()).tasks;
const post = (path: string) => SELF.fetch(`https://noriq.test/api/projects/${projectId}${path}`, { method: 'POST', headers: { Cookie: cookie } });

beforeAll(async () => {
  agent = await createAgent('arch-agent');
  await createUser('arch-human@example.com', 'Arch Human', 'longenough1', 'admin').catch(() => {});
  cookie = await loginSession('arch-human@example.com', 'longenough1');
  const p = await mcpCall(agent.apiKey, 'create_project', { key: 'ARCH', name: 'archive' });
  projectId = p.body.id;
  taskId = (await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'archive me' })).body.id;
}, 60000);

describe('task archive', () => {
  it('archived tasks stay in the snapshot, flagged by archivedAt', async () => {
    expect((await tasksIn()).find((t) => t.id === taskId)?.archivedAt).toBeNull();

    expect((await post(`/tasks/${taskId}/archive`)).status).toBe(200);
    // Still present — the client hides it at render, the server does not drop it.
    expect((await tasksIn()).find((t) => t.id === taskId)?.archivedAt).toBeTruthy();
  });

  it('restore clears the flag', async () => {
    expect((await post(`/tasks/${taskId}/restore`)).status).toBe(200);
    const back = (await tasksIn()).find((t) => t.id === taskId);
    expect(back).toBeTruthy();
    expect(back!.archivedAt).toBeNull();
  });

  // The PLNR-150 regression: a milestone whose every task is done+archived must still
  // have those tasks in the snapshot, so the UI can count done/total and render N/N.
  // Before the fix the snapshot returned zero of them and the chip read 0/0.
  it('a fully done+archived milestone keeps its tasks countable (not 0/0)', async () => {
    const ms = await mcpCall(agent.apiKey, 'create_milestone', { projectId, title: 'all-archived' });
    const msId = ms.body.id as string;

    const ids: string[] = [];
    for (const title of ['done one', 'done two']) {
      const t = await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title, milestoneId: msId });
      ids.push(t.body.id as string);
      await mcpCall(agent.apiKey, 'update_task', { projectId, taskId: t.body.id, status: 'done' });
      expect((await post(`/tasks/${t.body.id}/archive`)).status).toBe(200);
    }

    const mine = (await tasksIn()).filter((t) => t.milestoneId === msId);
    expect(mine).toHaveLength(2);
    expect(mine.every((t) => t.archivedAt !== null)).toBe(true);
    // What the milestone chip computes: done/total → 2/2, not 0/0.
    const done = mine.filter((t) => t.status === 'done').length;
    expect(`${done}/${mine.length}`).toBe('2/2');
    expect(ids).toHaveLength(2);
  });
});
