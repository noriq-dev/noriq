import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall, authorizeForAllProjects } from './helpers';

// PLNR-217: create_plan/create_tasks taskDefaults (incl. boardId) apply ONLY to tasks the
// call CREATES. Existing tasks pulled into a phase via taskIds are placed as-is and keep
// their own board — a copilot once expected taskDefaults.boardId to MOVE a referenced task;
// it does not, by design (moving a deliberately-placed task is a separate update_task/move_task).
describe('create_plan / create_tasks board defaults', () => {
  let planner: { id: string; apiKey: string };
  let cookie: string;
  let projectId: string;
  let mainBoardId: string;
  let secondBoardId: string;

  beforeAll(async () => {
    planner = await createAgent('board-defaults-planner', 'orchestrator');
    cookie = await loginSession('founder@example.com', 'longenough1').catch(async () => {
      await createUser('founder@example.com', 'Founder', 'longenough1', 'admin');
      return loginSession('founder@example.com', 'longenough1');
    });
    const proj = await mcpCall(planner.apiKey, 'create_project', { key: 'RBI', name: 'board-defaults' });
    projectId = proj.body.id;
    await authorizeForAllProjects(planner.apiKey);

    const gp = await mcpCall(planner.apiKey, 'get_project', { projectId });
    mainBoardId = gp.body.boards[0].id;

    // A second board (only via REST) — the one we want the plan's NEW tasks to land on.
    const mk = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/boards`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Backend' }),
    });
    expect(mk.status).toBe(200);
    const gp2 = await mcpCall(planner.apiKey, 'get_project', { projectId });
    secondBoardId = gp2.body.boards.find((b: { name: string }) => b.name === 'Backend').id;
    expect(secondBoardId).toBeTruthy();
    expect(secondBoardId).not.toBe(mainBoardId);
  });

  it('newTasks land on taskDefaults.boardId', async () => {
    const plan = await mcpCall(planner.apiKey, 'create_plan', {
      projectId, title: 'board default plan',
      taskDefaults: { boardId: secondBoardId, tags: ['reprowork'] },
      phases: [{ title: 'P1', newTasks: [{ title: 'task A' }, { title: 'task B' }] }],
    });
    expect(plan.isError).toBe(false);
    const ids = plan.body.phases[0].taskIds as string[];
    for (const id of ids) {
      const t = await mcpCall(planner.apiKey, 'get_task', { taskId: id });
      expect(t.body.task.board_id).toBe(secondBoardId);
    }
  });

  it('existing tasks referenced via taskIds keep their board — taskDefaults does not move them', async () => {
    // A copilot creates tasks first (they land on the default board), then references them by
    // taskIds in a plan with taskDefaults.boardId. taskDefaults is for CREATED tasks only, so
    // the referenced tasks stay where they were — the plan only sets their phase membership.
    const t1 = await mcpCall(planner.apiKey, 'create_task', { projectId, title: 'pre-made 1', tags: ['reprowork'] });
    const t2 = await mcpCall(planner.apiKey, 'create_task', { projectId, title: 'pre-made 2', tags: ['reprowork'] });
    expect((await mcpCall(planner.apiKey, 'get_task', { taskId: t1.body.id })).body.task.board_id).toBe(mainBoardId);

    await mcpCall(planner.apiKey, 'create_plan', {
      projectId, title: 'plan over existing tasks',
      taskDefaults: { boardId: secondBoardId, tags: ['reprowork'] },
      phases: [{ title: 'P1', taskIds: [t1.body.id, t2.body.id] }],
    });
    // Unchanged: the referenced task keeps its original board (re-home it with move_task/update_task).
    expect((await mcpCall(planner.apiKey, 'get_task', { taskId: t1.body.id })).body.task.board_id).toBe(mainBoardId);
    expect((await mcpCall(planner.apiKey, 'get_task', { taskId: t2.body.id })).body.task.board_id).toBe(mainBoardId);
  });

  it('create_tasks defaults.boardId lands new tasks on that board', async () => {
    const res = await mcpCall(planner.apiKey, 'create_tasks', {
      projectId,
      defaults: { boardId: secondBoardId, tags: ['reprowork'] },
      tasks: [{ title: 'batch A' }, { title: 'batch B' }],
    });
    for (const c of res.body.created as Array<{ id: string }>) {
      const t = await mcpCall(planner.apiKey, 'get_task', { taskId: c.id });
      expect(t.body.task.board_id).toBe(secondBoardId);
    }
  });
});
