// PLNR-73: task archive — manual archive/restore + snapshot filtering.
import { SELF } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall } from './helpers';

let agent: { id: string; apiKey: string };
let projectId: string;
let taskId: string;
let cookie: string;

const tasksIn = async (archived = false) => {
  const r = await (await SELF.fetch(`https://planar.test/api/projects/${projectId}/snapshot${archived ? '?archived=1' : ''}`, { headers: { Cookie: cookie } })).json() as {
    tasks: Array<{ id: string; archivedAt: string | null }>;
  };
  return r.tasks;
};
const post = (path: string) => SELF.fetch(`https://planar.test/api/projects/${projectId}${path}`, { method: 'POST', headers: { Cookie: cookie } });

beforeAll(async () => {
  agent = await createAgent('arch-agent');
  await createUser('arch-human@example.com', 'Arch Human', 'longenough1', 'admin').catch(() => {});
  cookie = await loginSession('arch-human@example.com', 'longenough1');
  const p = await mcpCall(agent.apiKey, 'create_project', { key: 'ARCH', name: 'archive' });
  projectId = p.body.id;
  taskId = (await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'archive me' })).body.id;
}, 60000);

describe('task archive', () => {
  it('archived tasks drop off the default snapshot but show with ?archived=1', async () => {
    expect((await tasksIn()).find((t) => t.id === taskId)).toBeTruthy();

    expect((await post(`/tasks/${taskId}/archive`)).status).toBe(200);
    expect((await tasksIn()).find((t) => t.id === taskId)).toBeUndefined(); // hidden by default
    const withArchived = await tasksIn(true);
    expect(withArchived.find((t) => t.id === taskId)?.archivedAt).toBeTruthy(); // visible + flagged
  });

  it('restore brings it back to the board', async () => {
    expect((await post(`/tasks/${taskId}/restore`)).status).toBe(200);
    const back = (await tasksIn()).find((t) => t.id === taskId);
    expect(back).toBeTruthy();
    expect(back!.archivedAt).toBeNull();
  });
});
