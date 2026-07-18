// PLNR-80: multiple boards per project — default board, create/rename/delete,
// moving tasks between boards, and the last-board guard.
import { SELF } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall } from './helpers';

let agent: { id: string; apiKey: string };
let projectId: string;
let taskId: string;
let cookie: string;

const asJson = { 'Content-Type': 'application/json' };
const snapshot = async () =>
  (await (await SELF.fetch(`https://noriq.test/api/projects/${projectId}/snapshot`, { headers: { Cookie: cookie } })).json()) as {
    boards: Array<{ id: string; name: string }>;
    tasks: Array<{ id: string; boardId: string | null }>;
  };

beforeAll(async () => {
  agent = await createAgent('board-agent');
  await createUser('board-human@example.com', 'Board Human', 'longenough1', 'admin').catch(() => {});
  cookie = await loginSession('board-human@example.com', 'longenough1');
  const p = await mcpCall(agent.apiKey, 'create_project', { key: 'BRD', name: 'boards' });
  projectId = p.body.id;
  taskId = (await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'lands on default board' })).body.id;
}, 60000);

describe('boards (PLNR-80)', () => {
  it('a new project has a default board and new tasks land on it', async () => {
    const s = await snapshot();
    expect(s.boards.length).toBe(1);
    expect(s.boards[0]!.name).toBe('Main');
    expect(s.tasks.find((t) => t.id === taskId)?.boardId).toBe(s.boards[0]!.id);
  });

  it('creates a second board and moves a task onto it', async () => {
    const created = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/boards`, {
      method: 'POST', headers: { Cookie: cookie, ...asJson }, body: JSON.stringify({ name: 'Staging' }),
    });
    expect(created.status).toBe(200);
    const staging = (await created.json()) as { id: string };

    // Move the task via update_task (MCP) to prove the agent path too.
    await mcpCall(agent.apiKey, 'update_task', { projectId, taskId, boardId: staging.id });
    const s = await snapshot();
    expect(s.boards.length).toBe(2);
    expect(s.tasks.find((t) => t.id === taskId)?.boardId).toBe(staging.id);
  });

  it('renames a board', async () => {
    const s0 = await snapshot();
    const main = s0.boards.find((b) => b.name === 'Main')!;
    const r = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/boards/${main.id}`, {
      method: 'PATCH', headers: { Cookie: cookie, ...asJson }, body: JSON.stringify({ name: 'Production' }),
    });
    expect(r.status).toBe(200);
    expect((await snapshot()).boards.find((b) => b.id === main.id)?.name).toBe('Production');
  });

  it('deleting a board moves its tasks to another board', async () => {
    const s0 = await snapshot();
    const staging = s0.boards.find((b) => b.name === 'Staging')!;
    const other = s0.boards.find((b) => b.id !== staging.id)!;
    const del = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/boards/${staging.id}`, {
      method: 'DELETE', headers: { Cookie: cookie },
    });
    expect(del.status).toBe(200);
    const s = await snapshot();
    expect(s.boards.some((b) => b.id === staging.id)).toBe(false);
    expect(s.tasks.find((t) => t.id === taskId)?.boardId).toBe(other.id); // task rescued, not orphaned
  });

  it('refuses to delete the last remaining board', async () => {
    const s = await snapshot();
    expect(s.boards.length).toBe(1);
    const del = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/boards/${s.boards[0]!.id}`, {
      method: 'DELETE', headers: { Cookie: cookie },
    });
    expect(del.status).toBe(400);
    expect((await snapshot()).boards.length).toBe(1); // still there
  });
});

// PLNR-181: board placement is decided AT creation — an explicit boardId lands the task
// directly (no follow-up update_task), subtasks inherit their parent's board, and a bad
// board id fails with a readable error instead of an FK 500 / silent cross-project leak.
describe('board placement at creation (PLNR-181)', () => {
  let defaultBoard: string;
  let qa: string;
  let parentOnQa: string;

  beforeAll(async () => {
    defaultBoard = (await snapshot()).boards[0]!.id;
    const created = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/boards`, {
      method: 'POST', headers: { Cookie: cookie, ...asJson }, body: JSON.stringify({ name: 'QA' }),
    });
    qa = ((await created.json()) as { id: string }).id;
  }, 60000);

  it('create_task with an explicit boardId lands there directly', async () => {
    const r = await mcpCall(agent.apiKey, 'create_task', {
      projectId, title: 'born on QA', tags: ['test-fixture'], boardId: qa,
    });
    parentOnQa = r.body.id;
    const s = await snapshot();
    expect(s.tasks.find((t) => t.id === parentOnQa)?.boardId).toBe(qa);
  });

  it('a subtask inherits its parent\'s board, not the default board', async () => {
    const r = await mcpCall(agent.apiKey, 'create_task', {
      projectId, title: 'child of QA parent', tags: ['test-fixture'], parentTaskId: parentOnQa,
    });
    const s = await snapshot();
    expect(s.tasks.find((t) => t.id === r.body.id)?.boardId).toBe(qa);
  });

  it('decompose_task subtasks inherit the parent board; a per-subtask boardId overrides', async () => {
    const r = await mcpCall(agent.apiKey, 'decompose_task', {
      projectId, parentTaskId: parentOnQa, subtasks: [
        { title: 'inherits QA' },
        { title: 'explicitly elsewhere', boardId: defaultBoard },
      ],
    });
    const [inherited, explicit] = r.body.created as Array<{ id: string }>;
    const s = await snapshot();
    expect(s.tasks.find((t) => t.id === inherited!.id)?.boardId).toBe(qa);
    expect(s.tasks.find((t) => t.id === explicit!.id)?.boardId).toBe(defaultBoard);
  });

  it('an unknown or foreign-project boardId is a readable error, not an FK 500', async () => {
    const create = await mcpCall(agent.apiKey, 'create_task', {
      projectId, title: 'nowhere', tags: ['test-fixture'], boardId: 'brd_nope',
    });
    expect(create.isError).toBe(true);
    expect(create.text).toContain('not found in this project');

    const update = await mcpCall(agent.apiKey, 'update_task', {
      projectId, taskId: parentOnQa, boardId: 'brd_nope',
    });
    expect(update.isError).toBe(true);
    expect(update.text).toContain('not found in this project');
    // and the task did not move
    const s = await snapshot();
    expect(s.tasks.find((t) => t.id === parentOnQa)?.boardId).toBe(qa);
  });
});
