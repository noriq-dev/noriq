// RUN-28: a plan completing is a SERVER fact, recorded durably.
//
// The tempting build is "notice the last task go done, push a WS frame at the runner". That drops
// the merge request whenever nobody is listening — the box is off, the runner was offboarded, the
// socket is reconnecting. These tests are mostly about the record, not the push.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/do/ProjectRoom';
import type { Env } from '../src/env';
import { authorizeForAllProjects, createAgent, mcpCall } from './helpers';

const appEnv = env as unknown as Env;
const actor: Actor = { kind: 'human', id: 'usr_pl', name: 'Plan Tester' };
interface RoomRpc {
  releaseTask(projectId: string, actor: Actor, taskId: string, opts?: { toStatus?: string }): Promise<unknown>;
  claimTask(projectId: string, actor: Actor, taskId: string, agentId: string): Promise<unknown>;
  updateTask(projectId: string, actor: Actor, taskId: string, patch: Record<string, unknown>): Promise<unknown>;
}
const room = (pid: string) =>
  appEnv.PROJECT_ROOM.get(appEnv.PROJECT_ROOM.idFromName(pid)) as unknown as RoomRpc;

let conn: { id: string; apiKey: string };
let pid: string;

const landing = (planId: string) =>
  env.DB.prepare('SELECT plan_id AS planId, completed_at AS completedAt, merge_requested_at AS mergeRequestedAt FROM plan_landings WHERE plan_id = ?')
    .bind(planId).first<{ planId: string; completedAt: string; mergeRequestedAt: string | null }>();

beforeAll(async () => {
  conn = await createAgent('plan-lander');
  pid = (await mcpCall(conn.apiKey, 'create_project', { key: 'PLND', name: 'plan-landing' })).body.id;
  await authorizeForAllProjects(conn.apiKey);
}, 60000);

/** A live (approved) plan over two tasks. */
async function makePlan(title: string) {
  const plan = await mcpCall(conn.apiKey, 'create_plan', {
    projectId: pid,
    title,
    phases: [{ title: 'only', newTasks: [{ title: 'first' }, { title: 'second' }] }],
  });
  const planId = plan.body.id as string;
  const { results } = await env.DB.prepare(
    `SELECT pt.task_id AS id FROM phase_tasks pt JOIN phases ph ON ph.id = pt.phase_id WHERE ph.plan_id = ?`,
  ).bind(planId).all<{ id: string }>();
  return { planId, taskIds: results.map((r) => r.id) };
}

describe('plan completion is recorded (RUN-28)', () => {
  it('does not fire while any task is still open', async () => {
    const { planId, taskIds } = await makePlan('half done');
    await room(pid).updateTask(pid, actor, taskIds[0]!, { status: 'done' });
    expect(await landing(planId)).toBeNull(); // one task left → not a completed plan
  });

  it('records completion when the last task lands', async () => {
    const { planId, taskIds } = await makePlan('finishes');
    for (const id of taskIds) await room(pid).updateTask(pid, actor, id, { status: 'done' });
    const rec = await landing(planId);
    expect(rec).toBeTruthy();
    expect(rec!.completedAt).toBeTruthy();
    // Owed, not done: nothing has opened the merge request yet.
    expect(rec!.mergeRequestedAt).toBeNull();
  });

  it('completes once, however many times a task is touched', async () => {
    // A runner may reconnect and re-ask many times; a plan completes a single time, or every
    // reconnect opens another PR.
    const { planId, taskIds } = await makePlan('idempotent');
    for (const id of taskIds) await room(pid).updateTask(pid, actor, id, { status: 'done' });
    const first = await landing(planId);
    await room(pid).updateTask(pid, actor, taskIds[0]!, { status: 'todo' });
    await room(pid).updateTask(pid, actor, taskIds[0]!, { status: 'done' });
    const second = await landing(planId);
    expect(second!.completedAt).toBe(first!.completedAt); // not re-stamped
  });

  it('a cancelled task still completes the plan', async () => {
    // A plan whose remaining work was explicitly dropped IS finished. Refusing to notice would
    // strand its branch with no merge request, forever.
    const { planId, taskIds } = await makePlan('cancelled tail');
    await room(pid).updateTask(pid, actor, taskIds[0]!, { status: 'done' });
    await room(pid).updateTask(pid, actor, taskIds[1]!, { status: 'cancelled' });
    expect(await landing(planId)).toBeTruthy();
  });

  it('a proposed plan does not complete — its tasks are not real work yet', async () => {
    const plan = await mcpCall(conn.apiKey, 'create_plan', {
      projectId: pid,
      title: 'proposed',
      proposed: true,
      phases: [{ title: 'only', newTasks: [{ title: 'x' }] }],
    });
    const planId = plan.body.id as string;
    const t = await env.DB.prepare(
      `SELECT pt.task_id AS id FROM phase_tasks pt JOIN phases ph ON ph.id = pt.phase_id WHERE ph.plan_id = ?`,
    ).bind(planId).first<{ id: string }>();
    await room(pid).updateTask(pid, actor, t!.id, { status: 'done' });
    expect(await landing(planId)).toBeNull();
  });
});

describe('the run→plan link (RUN-28)', () => {
  it('a task-anchored run learns its plan — which the daemon could never work out', async () => {
    // Run.anchor is task|plan: a task-anchored run knows only its task, and plan membership is
    // phase_tasks, server-side. So the server resolves it at dispatch and freezes it.
    const { planId, taskIds } = await makePlan('anchored');
    await env.DB.prepare("INSERT OR IGNORE INTO runners (id, label) VALUES ('rnr_pl', 'pl')").run();
    const stub = appEnv.PROJECT_ROOM.get(appEnv.PROJECT_ROOM.idFromName(pid)) as unknown as {
      createRun(p: string, a: Actor, i: Record<string, unknown>): Promise<{ id: string; planKey: string | null }>;
    };
    const run = await stub.createRun(pid, actor, {
      kind: 'build', repoRef: 'r', agentTool: 'claude', runnerId: 'rnr_pl',
      anchor: { type: 'task', id: taskIds[0] },
    });
    expect(run.planKey).toBeTruthy();
    expect(run.planKey).toContain('anchored'); // slug of the plan title, for a human reading `git branch`
    const row = await env.DB.prepare('SELECT plan_id AS planId FROM runs WHERE id = ?').bind(run.id)
      .first<{ planId: string }>();
    expect(row!.planId).toBe(planId);
  });

  it('a one-off dispatch has no plan, and that is fine', async () => {
    const stub = appEnv.PROJECT_ROOM.get(appEnv.PROJECT_ROOM.idFromName(pid)) as unknown as {
      createRun(p: string, a: Actor, i: Record<string, unknown>): Promise<{ planKey: string | null }>;
    };
    const run = await stub.createRun(pid, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude' });
    expect(run.planKey).toBeNull();
  });
});
