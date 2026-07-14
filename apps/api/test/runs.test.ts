// RUN-6: Run lifecycle is authoritative in ProjectRoom — create/dispatch/transition
// through the DO, event log + fanout, and daemon-reconnect reconciliation. Drives the
// DO methods directly via the stub (the HTTP/WS dispatch surface lands in RUN-7).
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import type { Actor, CreateRunInput, RunPatch, RunView } from '../src/do/ProjectRoom';
import type { Env } from '../src/env';
import { createUser, loginSession, mintTokenForUser } from './helpers';

const actor: Actor = { kind: 'human', id: 'usr_runtest', name: 'Run Tester' };
let cookie: string;
let pid: string;

// ProvidedEnv (cloudflare:test) exposes DB but not the DO namespace; cast to app Env.
const appEnv = env as unknown as Env;
// The DurableObjectStub RPC type collapses these RunView returns to `never`, so
// address the room through a hand-typed facade — keeps assertions checked vs RunView.
interface RoomRpc {
  createRun(projectId: string, actor: Actor, input: CreateRunInput): Promise<RunView>;
  dispatchRun(projectId: string, actor: Actor, runId: string, runnerId: string): Promise<RunView>;
  transitionRun(projectId: string, actor: Actor, runId: string, patch: RunPatch): Promise<RunView>;
  reconcileRunnerRuns(projectId: string, actor: Actor, runnerId: string): Promise<{ failed: number }>;
  listRuns(projectId: string, opts?: { runnerId?: string; status?: string }): Promise<RunView[]>;
  getRun(projectId: string, runId: string): Promise<RunView>;
}
const room = (projectId: string) =>
  appEnv.PROJECT_ROOM.get(appEnv.PROJECT_ROOM.idFromName(projectId)) as unknown as RoomRpc;
// runs.runner_id is a real FK → runners(id). Seed the runner rows dispatch targets need.
const seedRunner = (id: string) =>
  env.DB.prepare('INSERT OR IGNORE INTO runners (id, label) VALUES (?, ?)').bind(id, id).run();
const runEvents = async (projectId: string) => {
  const { results } = await env.DB.prepare(
    "SELECT verb, subject_id FROM events WHERE project_id = ? AND subject_type = 'run' ORDER BY seq",
  ).bind(projectId).all<{ verb: string; subject_id: string }>();
  return results;
};

beforeAll(async () => {
  await createUser('run-owner@example.com', 'Run Owner', 'longenough1', 'member').catch(() => {});
  cookie = await loginSession('run-owner@example.com', 'longenough1');
  const p = await SELF.fetch('https://planar.test/api/projects', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'RUNL', name: 'runl' }),
  });
  pid = ((await p.json()) as { id: string }).id;
  for (const r of ['rnr_1', 'rnr_2', 'rnr_ev', 'rnr_recon', 'rnr_other']) await seedRunner(r);
  // runs.agent_id is a real FK → agents(id); the spawned agent is a genuine actor.
  await env.DB.prepare("INSERT OR IGNORE INTO agents (id, name, api_key_hash) VALUES ('agt_spawned', 'agt_spawned', 'x')").run();
}, 60000);

describe('run lifecycle in ProjectRoom (RUN-6)', () => {
  it('creates a queued run and maps the wire shape', async () => {
    const run = await room(pid).createRun(pid, actor, {
      kind: 'build', repoRef: 'repo_a', agentTool: 'claude',
      anchor: { type: 'task', id: 'task_x' }, budget: { maxTokens: 1000 },
    });
    expect(run.id).toMatch(/^run_/);
    expect(run.status).toBe('queued');
    expect(run.anchor).toEqual({ type: 'task', taskId: 'task_x' });
    expect(run.budget).toEqual({ maxTokens: 1000 });
    expect(run.runnerId).toBeNull();
  });

  it('drives queued → dispatched → running → blocked → running → done, synthesizing exit', async () => {
    const run = await room(pid).createRun(pid, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude' });
    const d = await room(pid).dispatchRun(pid, actor, run.id, 'rnr_1');
    expect(d.status).toBe('dispatched');
    expect(d.runnerId).toBe('rnr_1');
    expect(d.dispatchedAt).not.toBeNull();

    const running = await room(pid).transitionRun(pid, actor, run.id, { status: 'running', agentId: 'agt_spawned' });
    expect(running.status).toBe('running');
    expect(running.agentId).toBe('agt_spawned');
    expect(running.startedAt).not.toBeNull();

    await room(pid).transitionRun(pid, actor, run.id, { status: 'blocked', reason: 'awaiting input' });
    await room(pid).transitionRun(pid, actor, run.id, { status: 'running' });
    const done = await room(pid).transitionRun(pid, actor, run.id, { status: 'done' });
    expect(done.status).toBe('done');
    expect(done.exit).toMatchObject({ outcome: 'done' });
    expect(done.exit!.finishedAt).toBeTruthy();
  });

  it('persists the worktree path reported on a transition (server-side Run visibility)', async () => {
    const run = await room(pid).createRun(pid, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude', runnerId: 'rnr_1' });
    expect(run.worktreePath).toBeNull(); // not known until the daemon reports it
    const running = await room(pid).transitionRun(pid, actor, run.id, {
      status: 'running',
      worktreePath: '/home/mtuska/.noriq/worktrees/repo-run_1',
    });
    expect(running.worktreePath).toBe('/home/mtuska/.noriq/worktrees/repo-run_1');
    // sticky: a later transition that omits it keeps the path
    const done = await room(pid).transitionRun(pid, actor, run.id, { status: 'done' });
    expect(done.worktreePath).toBe('/home/mtuska/.noriq/worktrees/repo-run_1');
  });

  it('rejects an illegal transition (queued → done)', async () => {
    const run = await room(pid).createRun(pid, actor, { kind: 'scope', repoRef: 'r', agentTool: 'codex' });
    await expect(room(pid).transitionRun(pid, actor, run.id, { status: 'done' })).rejects.toThrow(/illegal run transition/);
  });

  it('create + dispatch atomically when runnerId is given', async () => {
    const run = await room(pid).createRun(pid, actor, { kind: 'verify', repoRef: 'r', agentTool: 'claude', runnerId: 'rnr_2' });
    expect(run.status).toBe('dispatched');
    expect(run.dispatchedAt).not.toBeNull();
  });

  it('reconcileRunnerRuns fails orphaned non-terminal runs for that runner', async () => {
    const a = await room(pid).createRun(pid, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude', runnerId: 'rnr_recon' });
    await room(pid).transitionRun(pid, actor, a.id, { status: 'running' });
    const b = await room(pid).createRun(pid, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude', runnerId: 'rnr_recon' });
    // a different runner's run must be untouched
    const other = await room(pid).createRun(pid, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude', runnerId: 'rnr_other' });
    await room(pid).transitionRun(pid, actor, other.id, { status: 'running' });

    const res = await room(pid).reconcileRunnerRuns(pid, actor, 'rnr_recon');
    expect(res.failed).toBe(2);
    const failedA = await room(pid).getRun(pid, a.id);
    expect(failedA.status).toBe('failed');
    expect(failedA.exit!.reason).toBe('daemon_restart');
    expect((await room(pid).getRun(pid, b.id)).status).toBe('failed');
    expect((await room(pid).getRun(pid, other.id)).status).toBe('running'); // untouched
  });

  it('emits run.created / run.dispatched / run.status_changed to the event log', async () => {
    const before = (await runEvents(pid)).length;
    const run = await room(pid).createRun(pid, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude' });
    await room(pid).dispatchRun(pid, actor, run.id, 'rnr_ev');
    await room(pid).transitionRun(pid, actor, run.id, { status: 'running' });
    const verbs = (await runEvents(pid)).slice(before).filter((e) => e.subject_id === run.id).map((e) => e.verb);
    expect(verbs).toEqual(['run.created', 'run.dispatched', 'run.status_changed']);
  });

  it('listRuns filters by runner and status', async () => {
    const runnerRuns = await room(pid).listRuns(pid, { runnerId: 'rnr_1' });
    expect(runnerRuns.length).toBeGreaterThanOrEqual(1);
    expect(runnerRuns.every((r) => r.runnerId === 'rnr_1')).toBe(true);
    const doneRuns = await room(pid).listRuns(pid, { status: 'done' });
    expect(doneRuns.every((r) => r.status === 'done')).toBe(true);
  });

  it('re-register (reconnect) reconciles the runner\'s orphaned runs over HTTP', async () => {
    const token = await mintTokenForUser('run-owner@example.com');
    const reg = await SELF.fetch('https://planar.test/api/runners', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'recon-daemon', maxConcurrency: 2 }),
    });
    const runnerId = ((await reg.json()) as { runner: { id: string } }).runner.id;
    const run = await room(pid).createRun(pid, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude', runnerId });
    await room(pid).transitionRun(pid, actor, run.id, { status: 'running' });

    // Reconnect: POST /api/runners again with the same runnerId.
    await SELF.fetch('https://planar.test/api/runners', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runnerId, label: 'recon-daemon', maxConcurrency: 2 }),
    });
    const after = await room(pid).getRun(pid, run.id);
    expect(after.status).toBe('failed');
    expect(after.exit!.reason).toBe('daemon_restart');
  });
});
