// RUN-71: the marker's optional `board` locks a repo's work to one board, the way `key`
// locks it to a project. Board rides the key's rails — committed NAME, per-server
// resolution at registration, null on any miss — and lands in exactly one place: the
// board a run-spawned agent's tasks default onto.
import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/do/ProjectRoom';
import type { Env } from '../src/env';
import { authorizeForAllProjects, createUser, loginSession, mintTokenForUser } from './helpers';

const appEnv = env as unknown as Env;
const human: Actor = { kind: 'human', id: 'usr_bl', name: 'Board Locker' };

interface RoomRpc {
  createTask(projectId: string, actor: Actor, input: Record<string, unknown>): Promise<{ id: string }>;
  createPlan(projectId: string, actor: Actor, input: Record<string, unknown>): Promise<{ id: string; phases: Array<{ taskIds: string[] }> }>;
}
const room = (pid: string) =>
  appEnv.PROJECT_ROOM.get(appEnv.PROJECT_ROOM.idFromName(pid)) as unknown as RoomRpc;

let cookie: string;
let token: string;
let pid: string;
let runnerBoardId: string; // the "Runner" board created next to the default one

const taskBoard = (taskId: string) =>
  env.DB.prepare('SELECT board_id AS boardId FROM tasks WHERE id = ?').bind(taskId)
    .first<{ boardId: string | null }>();

const register = (body: unknown) =>
  SELF.fetch('https://noriq.test/api/runners', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  await createUser('board-lock@example.com', 'Board Lock', 'longenough1', 'member').catch(() => {});
  cookie = await loginSession('board-lock@example.com', 'longenough1');
  token = await mintTokenForUser('board-lock@example.com');
  const p = await SELF.fetch('https://noriq.test/api/projects', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'BLCK', name: 'board-lock' }),
  });
  pid = ((await p.json()) as { id: string }).id;
  await authorizeForAllProjects(token);
  const b = await SELF.fetch(`https://noriq.test/api/projects/${pid}/boards`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Runner' }),
  });
  runnerBoardId = ((await b.json()) as { id: string }).id;
}, 60000);

describe('registration resolves the board lock the way it resolves the key (RUN-71)', () => {
  it('committed name → per-server boardId, case-insensitively (the marker is hand-typed)', async () => {
    const res = await register({
      label: 'locked-box', tools: ['claude'], kinds: ['build'], maxConcurrency: 1,
      repos: [{ id: 'repo_lk', projectKey: 'blck', board: 'runner' }], // lowercase on purpose
    });
    expect(res.status).toBe(200);
    const { runner } = (await res.json()) as { runner: { repos: Array<{ board: string | null; boardId: string | null }> } };
    expect(runner.repos[0]!.board).toBe('runner');
    expect(runner.repos[0]!.boardId).toBe(runnerBoardId);
  });

  it('an unknown board name resolves to null — visible, and the repo stays dispatchable', async () => {
    const res = await register({
      label: 'mistyped-box', tools: ['claude'], kinds: ['build'], maxConcurrency: 1,
      repos: [{ id: 'repo_typo', projectKey: 'BLCK', board: 'Runer' }],
    });
    const { runner } = (await res.json()) as { runner: { repos: Array<{ projectId: string | null; boardId: string | null }> } };
    expect(runner.repos[0]!.projectId).toBe(pid); // the KEY still resolved — board is additive
    expect(runner.repos[0]!.boardId).toBeNull();
  });

  it('no board in the marker → nulls, exactly the pre-RUN-71 shape', async () => {
    const res = await register({
      label: 'plain-box', tools: ['claude'], kinds: ['build'], maxConcurrency: 1,
      repos: [{ id: 'repo_plain', projectKey: 'BLCK' }],
    });
    const { runner } = (await res.json()) as { runner: { repos: Array<{ board: string | null; boardId: string | null }> } };
    expect(runner.repos[0]!.board).toBeNull();
    expect(runner.repos[0]!.boardId).toBeNull();
  });
});

describe("a locked repo's agent lands its tasks on the locked board", () => {
  /** A runner + live run + run-bound agent wired to a repo locked to `boardId`. */
  let seq = 0;
  async function seedLockedAgent(boardId: string | null) {
    const rid = `rnr_bl_${++seq}`;
    const aid = `agt_bl_${seq}`;
    const runId = `run_bl_${seq}`;
    await env.DB.prepare(
      "INSERT INTO runners (id, label, status, capabilities, repos) VALUES (?, ?, 'online', '{}', ?)",
    ).bind(rid, rid, JSON.stringify([{ id: 'repo_lk', projectId: pid, projectKey: 'BLCK', board: 'Runner', boardId }])).run();
    await env.DB.prepare(
      "INSERT INTO agents (id, name, kind, runner_id, project_id) VALUES (?, ?, 'agent', ?, ?)",
    ).bind(aid, aid, rid, pid).run();
    await env.DB.prepare(
      `INSERT INTO runs (id, project_id, runner_id, agent_id, kind, brief, repo_ref, agent_tool, budget, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'build', '', 'repo_lk', 'claude', '{}', 'running', 'usr_bl', ?, ?)`,
    ).bind(runId, pid, rid, aid, new Date().toISOString(), new Date().toISOString()).run();
    return { agent: { kind: 'agent', id: aid, name: aid } as Actor };
  }

  it('defaults an uninstructed create_task onto the locked board', async () => {
    const { agent } = await seedLockedAgent(runnerBoardId);
    const t = await room(pid).createTask(pid, agent, { title: 'lands on Runner' });
    expect((await taskBoard(t.id))!.boardId).toBe(runnerBoardId);
  });

  it("covers create_plan's newTasks — every creation path funnels through the same seam", async () => {
    const { agent } = await seedLockedAgent(runnerBoardId);
    const plan = await room(pid).createPlan(pid, agent, {
      title: 'locked plan', phases: [{ title: 'p', newTasks: [{ title: 'phase task' }] }],
    });
    expect((await taskBoard(plan.phases[0]!.taskIds[0]!))!.boardId).toBe(runnerBoardId);
  });

  it('a DEFAULT, not a fence: an explicit boardId still wins', async () => {
    const { agent } = await seedLockedAgent(runnerBoardId);
    const defaultBoard = await env.DB.prepare(
      'SELECT id FROM boards WHERE project_id = ? ORDER BY "order", created_at LIMIT 1',
    ).bind(pid).first<{ id: string }>();
    const t = await room(pid).createTask(pid, agent, { title: 'explicitly elsewhere', boardId: defaultBoard!.id });
    expect((await taskBoard(t.id))!.boardId).toBe(defaultBoard!.id);
  });

  it('an unresolved lock (boardId null) falls through to the default board, never throws', async () => {
    const { agent } = await seedLockedAgent(null);
    const t = await room(pid).createTask(pid, agent, { title: 'unlocked fallback' });
    const defaultBoard = await env.DB.prepare(
      'SELECT id FROM boards WHERE project_id = ? ORDER BY "order", created_at LIMIT 1',
    ).bind(pid).first<{ id: string }>();
    expect((await taskBoard(t.id))!.boardId).toBe(defaultBoard!.id);
  });

  it('humans are untouched — no run bound, no lock consulted', async () => {
    const t = await room(pid).createTask(pid, human, { title: 'human task' });
    const defaultBoard = await env.DB.prepare(
      'SELECT id FROM boards WHERE project_id = ? ORDER BY "order", created_at LIMIT 1',
    ).bind(pid).first<{ id: string }>();
    expect((await taskBoard(t.id))!.boardId).toBe(defaultBoard!.id);
  });
});
