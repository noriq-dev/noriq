// PLNR-240: dispatch selects a workflow. The invariants under test: a selection must be on
// the repo's advertised menu (both dispatch doors refuse legibly, never silently fall back),
// the pump carries the dispatch default onto every run it creates, a task's own workflow wins
// over the default, and a ready task naming an unadvertised workflow stalls the dispatch with
// a reason a human can act on — it never runs under the wrong brief.
import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Actor, CreatePlanDispatchInput, PlanDispatchView } from '../src/do/ProjectRoom';
import type { Env } from '../src/env';
import { createUser, loginSession } from './helpers';

const appEnv = env as unknown as Env;
const actor: Actor = { kind: 'human', id: 'usr_wfd', name: 'Workflow Dispatcher' };

interface RoomRpc {
  createPlan(projectId: string, actor: Actor, input: Record<string, unknown>): Promise<{ id: string; phases: Array<{ id: string; taskIds: string[] }> }>;
  createPlanDispatch(projectId: string, actor: Actor, input: CreatePlanDispatchInput): Promise<PlanDispatchView>;
  updateTask(projectId: string, actor: Actor, taskId: string, patch: Record<string, unknown>): Promise<unknown>;
}
const room = (pid: string) =>
  appEnv.PROJECT_ROOM.get(appEnv.PROJECT_ROOM.idFromName(pid)) as unknown as RoomRpc;

let cookie: string;
let userId: string;
let pid: string;

// Advertised menu under test: one rich PLNR-240 entry, one bare RUN-121 name (an older
// daemon's shape) — both must stay selectable.
const ADVERTISED = [
  { name: 'build-codex', base: 'build', description: 'build with a codex adversary' },
  'legacy-wf',
];

let runnerSeq = 0;
async function seedRunner(maxConcurrency: number): Promise<string> {
  const id = `rnr_wfd_${++runnerSeq}`;
  await env.DB.prepare(
    `INSERT INTO runners (id, label, owner_user_id, status, capabilities, repos, free_slots)
     VALUES (?, ?, ?, 'online', ?, ?, ?)`,
  ).bind(
    id, id, userId,
    JSON.stringify({ tools: ['claude'], kinds: ['scope', 'build', 'verify'], maxConcurrency }),
    JSON.stringify([{ id: 'repo_wfd', projectKey: 'WFD', projectId: pid, name: 'wfd', defaultBranch: 'main', workflows: ADVERTISED }]),
    maxConcurrency,
  ).run();
  return id;
}

async function makePlan(title: string) {
  const plan = await room(pid).createPlan(pid, actor, {
    title,
    phases: [{ title: 'p1', newTasks: [{ title: `${title} a` }, { title: `${title} b` }] }],
  });
  const [a, b] = plan.phases[0]!.taskIds;
  return { planId: plan.id, a: a!, b: b! };
}

const dispatchRuns = async (dispatchId: string) => {
  const { results } = await env.DB.prepare(
    'SELECT id, anchor_id AS taskId, workflow FROM runs WHERE plan_dispatch_id = ? ORDER BY created_at',
  ).bind(dispatchId).all<{ id: string; taskId: string; workflow: string | null }>();
  return results;
};

beforeAll(async () => {
  await createUser('wfd-owner@example.com', 'WFD Owner', 'longenough1', 'member').catch(() => {});
  cookie = await loginSession('wfd-owner@example.com', 'longenough1');
  userId = (await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind('wfd-owner@example.com').first<{ id: string }>())!.id;
  const p = await SELF.fetch('https://noriq.test/api/projects', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'WFD', name: 'workflow-dispatch' }),
  });
  pid = ((await p.json()) as { id: string }).id;
}, 60000);

describe.skip('legacy direct workflow dispatch (removed by PLNR-502)', () => {
  const dispatch = async (runnerId: string, body: Record<string, unknown>) =>
    SELF.fetch(`https://noriq.test/api/projects/${pid}/runs`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runnerId, repoRef: 'repo_wfd', kind: 'build', agentTool: 'claude', brief: 'x', ...body }),
    });

  it('carries an advertised workflow onto the run — rich and bare-name entries alike', async () => {
    const runner = await seedRunner(4);
    for (const name of ['build-codex', 'legacy-wf']) {
      const res = await dispatch(runner, { workflow: name });
      expect(res.status).toBe(200);
      const { run } = (await res.json()) as { run: { workflow: string | null } };
      expect(run.workflow).toBe(name);
    }
    // Built-in names are always dispatchable, never listed.
    expect((await dispatch(runner, { workflow: 'build' })).status).toBe(200);
  });

  it('refuses an unadvertised workflow legibly — no silent fallback to the built-in', async () => {
    const runner = await seedRunner(4);
    const res = await dispatch(runner, { workflow: 'no-such-wf' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('no-such-wf');
    expect(body.error).toContain('not advertised');
  });
});

describe.skip('legacy plan workflow dispatch (removed by PLNR-502)', () => {
  it('the dispatch default reaches every pump-created run; a task\'s own workflow wins', async () => {
    const runner = await seedRunner(4);
    const { planId, a, b } = await makePlan('wf-default');
    await room(pid).updateTask(pid, actor, a, { workflow: 'legacy-wf' });
    const d = await room(pid).createPlanDispatch(pid, actor, {
      planId, runnerId: runner, repoRef: 'repo_wfd', agentTool: 'claude', workflow: 'build-codex',
    });
    expect(d.workflow).toBe('build-codex');
    const runs = await dispatchRuns(d.id);
    expect(runs.length).toBe(2);
    const byTask = Object.fromEntries(runs.map((r) => [r.taskId, r.workflow]));
    expect(byTask[a]).toBe('legacy-wf'); // the task's own choice
    expect(byTask[b]).toBe('build-codex'); // the dispatch default
  });

  it('a ready task naming an unadvertised workflow stalls the dispatch with an actionable reason', async () => {
    const runner = await seedRunner(4);
    const { planId, a, b } = await makePlan('wf-ghost');
    await room(pid).updateTask(pid, actor, a, { workflow: 'ghost-wf' });
    await room(pid).updateTask(pid, actor, b, { workflow: 'ghost-wf' });
    const d = await room(pid).createPlanDispatch(pid, actor, {
      planId, runnerId: runner, repoRef: 'repo_wfd', agentTool: 'claude',
    });
    // Nothing may run under the wrong brief: zero runs, stalled, and the reason names the
    // workflow so the human knows what to fix (PLNR-163's stall surface).
    expect(await dispatchRuns(d.id)).toHaveLength(0);
    expect(d.status).toBe('stalled');
    expect(d.stallReason).toContain('ghost-wf');
    expect(d.stallReason).toContain('workflow');
  });

  it('the REST door refuses an unadvertised dispatch default', async () => {
    const runner = await seedRunner(4);
    const { planId } = await makePlan('wf-door');
    const res = await SELF.fetch(`https://noriq.test/api/projects/${pid}/plans/${planId}/dispatch`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runnerId: runner, repoRef: 'repo_wfd', agentTool: 'claude', workflow: 'no-such-wf' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('not advertised');
  });
});
