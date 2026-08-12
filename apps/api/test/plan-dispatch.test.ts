// PLNR-170: dispatch a whole PLAN to a runner. No scheduler object exists — the
// plan_dispatches row is the record and the pump RE-DERIVES the ready set on every
// unblocking event (terminal run, task done, heartbeat, retry). These tests drive the
// DO directly and assert on the runs the pump actually creates, because the invariants
// that matter are scheduling ones: never past capacity, never past an unmet dependency,
// never re-running a failed task uninvited.
import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Actor, CreatePlanDispatchInput, CreateRunInput, PlanDispatchView, RunPatch, RunView } from '../src/do/ProjectRoom';
import type { Env } from '../src/env';
import { taskClaimability } from '../src/lib/claimability';
import { createUser, loginSession } from './helpers';

const appEnv = env as unknown as Env;
const actor: Actor = { kind: 'human', id: 'usr_pd', name: 'Plan Dispatcher' };

interface RoomRpc {
  createPlan(projectId: string, actor: Actor, input: Record<string, unknown>): Promise<{ id: string; phases: Array<{ id: string; taskIds: string[] }> }>;
  restructurePlan(projectId: string, actor: Actor, planId: string, phases: Array<{ id?: string; title: string; taskIds: string[] }>): Promise<unknown>;
  createPlanDispatch(projectId: string, actor: Actor, input: CreatePlanDispatchInput): Promise<PlanDispatchView>;
  cancelPlanDispatch(projectId: string, actor: Actor, id: string, reason?: string | null): Promise<{ ok: boolean; cancelledRuns: number }>;
  retryPlanDispatch(projectId: string, actor: Actor, id: string): Promise<{ created: number }>;
  listPlanDispatches(projectId: string, planId?: string | null): Promise<{ dispatches: PlanDispatchView[] }>;
  pumpProjectDispatches(projectId: string): Promise<{ created: number }>;
  createRun(projectId: string, actor: Actor, input: CreateRunInput): Promise<RunView>;
  transitionRun(projectId: string, actor: Actor, runId: string, patch: RunPatch): Promise<RunView>;
  claimTask(projectId: string, actor: Actor, taskId: string, agentId: string): Promise<{ key: string }>;
  releaseTask(projectId: string, actor: Actor, taskId: string, opts?: { toStatus?: string }): Promise<unknown>;
  updateTask(projectId: string, actor: Actor, taskId: string, patch: Record<string, unknown>): Promise<unknown>;
}
const room = (pid: string) =>
  appEnv.PROJECT_ROOM.get(appEnv.PROJECT_ROOM.idFromName(pid)) as unknown as RoomRpc;

let cookie: string;
let userId: string;
let pid: string;

/** A runner the pump can schedule onto. Fresh per test — capacity math reads the runs
 *  table, so sharing a runner across tests would leak slots between them. */
let runnerSeq = 0;
async function seedRunner(maxConcurrency: number, mission = false): Promise<string> {
  const id = `rnr_pd_${++runnerSeq}`;
  await env.DB.prepare(
    `INSERT INTO runners (id, label, owner_user_id, status, capabilities, repos, free_slots)
     VALUES (?, ?, ?, 'online', ?, ?, ?)`,
  ).bind(
    id, id, userId,
    JSON.stringify({ tools: ['claude'], kinds: ['scope', 'build', 'verify'], maxConcurrency }),
    JSON.stringify([{
      id: 'repo_pd', projectKey: 'PDSP', projectId: pid, name: 'pd', defaultBranch: 'main',
      workflows: mission ? [{
        name: 'mission-plan', base: 'build', description: 'Runner mission harness', capabilities: ['mission.v2'],
      }] : [],
    }]),
    maxConcurrency,
  ).run();
  return id;
}

let agentSeq = 0;
async function seedAgent(runnerId: string): Promise<string> {
  const id = `agt_pd_${++agentSeq}`;
  await env.DB.prepare(
    "INSERT INTO agents (id, name, kind, runner_id, project_id) VALUES (?, ?, 'agent', ?, ?)",
  ).bind(id, id, runnerId, pid).run();
  return id;
}

/** Two phases: [a, b] then [c]. Phase order is computed live (PLNR-163) — c waits on the whole of phase 1, no edges minted. */
async function makePlan(title: string) {
  const plan = await room(pid).createPlan(pid, actor, {
    title,
    phases: [
      { title: 'p1', newTasks: [{ title: `${title} a` }, { title: `${title} b` }] },
      { title: 'p2', newTasks: [{ title: `${title} c` }] },
    ],
  });
  const [a, b] = plan.phases[0]!.taskIds;
  const [c] = plan.phases[1]!.taskIds;
  return { planId: plan.id, a: a!, b: b!, c: c! };
}

const dispatchRuns = async (dispatchId: string) => {
  const { results } = await env.DB.prepare(
    'SELECT id, anchor_id AS taskId, status FROM runs WHERE plan_dispatch_id = ? ORDER BY created_at',
  ).bind(dispatchId).all<{ id: string; taskId: string; status: string }>();
  return results;
};

const createDispatch = (runnerId: string, planId: string, over: Partial<CreatePlanDispatchInput> = {}) =>
  room(pid).createPlanDispatch(pid, actor, {
    planId, runnerId, repoRef: 'repo_pd', agentTool: 'claude', ...over,
  });

/** Walk one run through the daemon's happy path: running (with its agent) → done. */
async function finishRun(runId: string, agentId: string) {
  await room(pid).transitionRun(pid, actor, runId, { status: 'running', agentId });
  await room(pid).transitionRun(pid, actor, runId, { status: 'done' });
}

beforeAll(async () => {
  await createUser('pd-owner@example.com', 'PD Owner', 'longenough1', 'member').catch(() => {});
  cookie = await loginSession('pd-owner@example.com', 'longenough1');
  userId = (await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind('pd-owner@example.com').first<{ id: string }>())!.id;
  const p = await SELF.fetch('https://noriq.test/api/projects', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'PDSP', name: 'plan-dispatch' }),
  });
  pid = ((await p.json()) as { id: string }).id;
}, 60000);

describe('fan-out respects the dependency graph and the runner capacity', () => {
  it('dispatches only phase-1 tasks, only up to maxConcurrency', async () => {
    const runner = await seedRunner(1);
    const { planId } = await makePlan('cap1');
    const d = await createDispatch(runner, planId);
    expect(d.status).toBe('active');
    // Two tasks are ready (a, b) but the runner advertises one slot.
    const runs = await dispatchRuns(d.id);
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe('dispatched');
  });

  it('runs phase-1 tasks in PARALLEL when the runner has the slots — phase 2 held back', async () => {
    const runner = await seedRunner(4);
    const { planId, a, b, c } = await makePlan('par');
    const d = await createDispatch(runner, planId);
    const runs = await dispatchRuns(d.id);
    // Both phase-1 tasks at once; c waits on the computed phase order, not on minted edges.
    expect(runs.map((r) => r.taskId).sort()).toEqual([a, b].sort());
    expect(runs.map((r) => r.taskId)).not.toContain(c);
  });

  it('a terminal run IS the wake-up: finishing one dispatches the next ready task', async () => {
    const runner = await seedRunner(1);
    const agent = await seedAgent(runner);
    const { planId, a, b } = await makePlan('wake');
    const d = await createDispatch(runner, planId);
    const [first] = await dispatchRuns(d.id);
    await finishRun(first!.id, agent);
    // The pump ran inside transitionRun — no timer, no extra call.
    const runs = await dispatchRuns(d.id);
    expect(runs.length).toBe(2);
    expect(runs.map((r) => r.taskId).sort()).toEqual([a, b].sort());
  });

  it('never re-dispatches a task that already has a live run (a manual one counts)', async () => {
    const runner = await seedRunner(4);
    const { planId, a } = await makePlan('manual');
    // A human already dispatched task a by hand.
    await room(pid).createRun(pid, actor, {
      kind: 'build', repoRef: 'repo_pd', agentTool: 'claude', runnerId: runner,
      anchor: { type: 'task', id: a },
    });
    const d = await createDispatch(runner, planId);
    const runs = await dispatchRuns(d.id);
    expect(runs.map((r) => r.taskId)).not.toContain(a);
  });
});

describe('a restructure mid-flight regates the pump live (PLNR-163 / RUN-187)', () => {
  it('a kept phase moved LATER waits for the phases inserted in front of it', async () => {
    // The live incident, at the level it actually bit: a plan already dispatched, its later
    // phase KEPT by id but pushed back behind newly inserted work. Phase order is computed from
    // the structure at read time — no edges exist to go stale — so the pump must see the new
    // shape on its very next wake-up, not the shape the dispatch was created under.
    const runner = await seedRunner(1);
    const agent = await seedAgent(runner);
    const plan = await room(pid).createPlan(pid, actor, {
      title: 'restructure-live',
      phases: [
        { title: 'first', newTasks: [{ title: 'rsl a' }] },
        { title: 'last', newTasks: [{ title: 'rsl z' }] },
      ],
    });
    const ph1 = plan.phases[0]!;
    const ph2 = plan.phases[1]!;
    const a = ph1.taskIds[0]!;
    const z = ph2.taskIds[0]!;
    // gate='landed' so finishing a's RUN unlocks the next phase without a human review click —
    // the same gate the incident ran under.
    const d = await createDispatch(runner, plan.id, { gate: 'landed' });
    const [runA] = await dispatchRuns(d.id);
    expect(runA!.taskId).toBe(a);

    // Mid-flight, a new phase is inserted in front of the kept last phase.
    await env.DB.prepare(
      "INSERT INTO tasks (id, project_id, key, title, status) VALUES ('task_rsl_m', ?, 'PDRS-M', 'rsl m', 'todo')",
    ).bind(pid).run();
    await room(pid).restructurePlan(pid, actor, plan.id, [
      { id: ph1.id, title: 'first', taskIds: [a] },
      { title: 'inserted', taskIds: ['task_rsl_m'] },
      { id: ph2.id, title: 'last', taskIds: [z] },
    ]);

    // a's run finishing is the pump's wake-up. Under the OLD shape z would be next; under the
    // restructured shape the inserted phase gates it.
    // Claim as the run's agent before finishing — what claim-at-mint (RUN-181) does for every
    // real run. Without the claim the settle owns nothing, the task stays `todo`, and it blocks
    // its own phase: the exact behaviour this suite's DO-driven runs must model to be realistic.
    await room(pid).claimTask(pid, actor, a, agent);
    await finishRun(runA!.id, agent);
    const afterA = await dispatchRuns(d.id);
    expect(afterA.map((r) => r.taskId)).toContain('task_rsl_m');
    expect(afterA.map((r) => r.taskId)).not.toContain(z);

    // …and once the inserted phase's run lands, z is finally dispatched.
    const runM = afterA.find((r) => r.taskId === 'task_rsl_m')!;
    // A FRESH agent — finishing a's run retired the first one, as production would. Bound to its
    // run BEFORE claiming: an anchored claim resolves the dispatch's landed gate (a in
    // review-with-landed-run satisfies), where an unanchored one gets the strict gate and is
    // refused. The same dance the dispatched-FOR test below models.
    const agentM = await seedAgent(runner);
    await room(pid).transitionRun(pid, actor, runM.id, { status: 'running', agentId: agentM });
    await room(pid).claimTask(pid, actor, 'task_rsl_m', agentM);
    await room(pid).transitionRun(pid, actor, runM.id, { status: 'done' });
    expect((await dispatchRuns(d.id)).map((r) => r.taskId)).toContain(z);
  });
});

describe('the review gate (the design decision of PLNR-170)', () => {
  it("gate='landed': dependents start once the dependency's run is done, its task still in review", async () => {
    const runner = await seedRunner(2);
    const { planId, a, b, c } = await makePlan('landed');
    const d = await createDispatch(runner, planId, { gate: 'landed' }); // explicit opt-in (PLNR-176 made 'approved' the default)
    const runs = await dispatchRuns(d.id);

    // Simulate both agents: claim, release to review (the build agent's normal exit), run lands.
    for (const run of runs) {
      const agent = await seedAgent(runner);
      await room(pid).transitionRun(pid, actor, run.id, { status: 'running', agentId: agent });
      await room(pid).claimTask(pid, actor, run.taskId, agent);
      await room(pid).releaseTask(pid, { kind: 'agent', id: agent, name: agent }, run.taskId, { toStatus: 'review' });
      await room(pid).transitionRun(pid, actor, run.id, { status: 'done' });
    }
    // a and b sit in review — but their runs LANDED, so c is materially unblocked.
    const after = await dispatchRuns(d.id);
    expect(after.map((r) => r.taskId)).toContain(c);
    expect([a, b].every((t) => after.some((r) => r.taskId === t))).toBe(true);
  });

  it("gate='approved': dependents wait for the human; approval resumes the stalled dispatch", async () => {
    const runner = await seedRunner(2);
    const { planId, a, b, c } = await makePlan('approved');
    const d = await createDispatch(runner, planId, { gate: 'approved' });
    for (const run of await dispatchRuns(d.id)) {
      const agent = await seedAgent(runner);
      await room(pid).transitionRun(pid, actor, run.id, { status: 'running', agentId: agent });
      await room(pid).claimTask(pid, actor, run.taskId, agent);
      await room(pid).releaseTask(pid, { kind: 'agent', id: agent, name: agent }, run.taskId, { toStatus: 'review' });
      await room(pid).transitionRun(pid, actor, run.id, { status: 'done' });
    }
    // Strict gate: nothing live, nothing dispatchable, tasks awaiting a human → stalled, and
    // the reason says what to click.
    let view = (await room(pid).listPlanDispatches(pid, planId)).dispatches[0]!;
    expect((await dispatchRuns(d.id)).map((r) => r.taskId)).not.toContain(c);
    expect(view.status).toBe('stalled');
    expect(view.stallReason).toMatch(/review/);

    // The human approves both — updateTask(done) is the pump's wake-up here.
    await room(pid).updateTask(pid, actor, a, { status: 'done' });
    await room(pid).updateTask(pid, actor, b, { status: 'done' });
    expect((await dispatchRuns(d.id)).map((r) => r.taskId)).toContain(c);
    view = (await room(pid).listPlanDispatches(pid, planId)).dispatches[0]!;
    expect(view.status).toBe('active');
    expect(view.stallReason).toBeNull();
  });

  it("the default gate is 'approved' — review locks the next phase unless the operator opts into 'landed' (PLNR-176)", async () => {
    const runner = await seedRunner(2);
    const { planId } = await makePlan('defgate');
    const d = await createDispatch(runner, planId);
    expect(d.gate).toBe('approved');
  });

  it('a pump-dispatched claim re-checks readiness — an upstream kicked back to todo refuses the claim (PLNR-176)', async () => {
    const runner = await seedRunner(3);
    const { planId, a, b, c } = await makePlan('stale');
    const d = await createDispatch(runner, planId, { gate: 'landed' });
    for (const run of await dispatchRuns(d.id)) {
      const agent = await seedAgent(runner);
      await room(pid).transitionRun(pid, actor, run.id, { status: 'running', agentId: agent });
      await room(pid).claimTask(pid, actor, run.taskId, agent);
      await room(pid).releaseTask(pid, { kind: 'agent', id: agent, name: agent }, run.taskId, { toStatus: 'review' });
      await room(pid).transitionRun(pid, actor, run.id, { status: 'done' });
    }
    // Landed gate: c dispatches while a/b sit in review with landed runs.
    const runC = (await dispatchRuns(d.id)).find((r) => r.taskId === c)!;
    // The human reviews a and REJECTS it — back to todo. The dispatch-time readiness call
    // is now stale; c's agent must not get to claim on top of rejected baseline work.
    await room(pid).updateTask(pid, actor, a, { status: 'todo' });
    const cAgent = await seedAgent(runner);
    await room(pid).transitionRun(pid, actor, runC.id, { status: 'running', agentId: cAgent });
    await expect(room(pid).claimTask(pid, actor, c, cAgent)).rejects.toThrow(/readiness changed since dispatch/);
    // Re-approving a (done) clears the block for the same agent.
    await room(pid).updateTask(pid, actor, a, { status: 'done' });
    await expect(room(pid).claimTask(pid, actor, c, cAgent)).resolves.toMatchObject({ key: expect.any(String) });
    void b;
  });

  it("can_claim resolves the task's dispatch gate — landed unlocks a phase-2 task strict would block (PLNR-177)", async () => {
    const runner = await seedRunner(2);
    const { planId, a, b, c } = await makePlan('ccgate');
    const d = await createDispatch(runner, planId, { gate: 'landed' });
    for (const run of await dispatchRuns(d.id)) {
      const agent = await seedAgent(runner);
      await room(pid).transitionRun(pid, actor, run.id, { status: 'running', agentId: agent });
      await room(pid).claimTask(pid, actor, run.taskId, agent);
      await room(pid).releaseTask(pid, { kind: 'agent', id: agent, name: agent }, run.taskId, { toStatus: 'review' });
      await room(pid).transitionRun(pid, actor, run.id, { status: 'done' });
    }
    // a and b sit in review with landed runs. The probe reads the dispatch's landed gate, so
    // c reads claimable — where under the strict default it would be blocked (plans.test.ts).
    expect((await taskClaimability(env.DB, c)).claimable).toBe(true);
    void a;
    void b;
  });

  it('an agent claiming the task its run was dispatched FOR skips the dependency gate — nobody else does', async () => {
    const runner = await seedRunner(3);
    const { planId, a, b, c } = await makePlan('claims');
    const d = await createDispatch(runner, planId, { gate: 'landed' });
    for (const run of await dispatchRuns(d.id)) {
      const agent = await seedAgent(runner);
      await room(pid).transitionRun(pid, actor, run.id, { status: 'running', agentId: agent });
      await room(pid).claimTask(pid, actor, run.taskId, agent);
      await room(pid).releaseTask(pid, { kind: 'agent', id: agent, name: agent }, run.taskId, { toStatus: 'review' });
      await room(pid).transitionRun(pid, actor, run.id, { status: 'done' });
    }
    // c was dispatched under the landed gate while a/b await review. Its OWN agent may claim
    // it — the dispatcher made the readiness call — but a pool-shopping agent may not.
    const runC = (await dispatchRuns(d.id)).find((r) => r.taskId === c)!;
    const stranger = await seedAgent(runner);
    await expect(room(pid).claimTask(pid, actor, c, stranger)).rejects.toThrow(/unfinished dependencies/);
    const cAgent = await seedAgent(runner);
    await room(pid).transitionRun(pid, actor, runC.id, { status: 'running', agentId: cAgent });
    await expect(room(pid).claimTask(pid, actor, c, cAgent)).resolves.toMatchObject({ key: expect.any(String) });
    void a; void b;
  });
});

describe('failure, retry, cancel, completion', () => {
  it('does not auto-redispatch gated work, frees capacity for peers, and surfaces review (PLNR-477)', async () => {
    const runner = await seedRunner(1);
    const { planId, a, b, c } = await makePlan('gated');
    const d = await createDispatch(runner, planId);
    const runA = (await dispatchRuns(d.id)).find((r) => r.taskId === a)!;
    const agent = await seedAgent(runner);
    await room(pid).transitionRun(pid, actor, runA.id, { status: 'running', agentId: agent });
    await room(pid).claimTask(pid, actor, a, agent);

    // Compatibility frame emitted by pipeline-v2 before the shared vocabulary landed.
    const gated = await room(pid).transitionRun(pid, actor, runA.id, {
      status: 'failed', exit: { outcome: 'failed', reason: 'gated', finishedAt: new Date().toISOString() },
    });
    expect(gated.status).toBe('gated');

    // The terminal wake-up spends the free slot on the independent peer, never another a.
    let runs = await dispatchRuns(d.id);
    expect(runs.filter((r) => r.taskId === a)).toHaveLength(1);
    expect(runs.map((r) => r.taskId)).toContain(b);
    expect(runs.map((r) => r.taskId)).not.toContain(c);
    await room(pid).pumpProjectDispatches(pid);
    runs = await dispatchRuns(d.id);
    expect(runs.filter((r) => r.taskId === a)).toHaveLength(1);

    const task = await env.DB.prepare('SELECT status, failed_at AS failedAt, claimed_by AS claimedBy FROM tasks WHERE id = ?')
      .bind(a).first<{ status: string; failedAt: string | null; claimedBy: string | null }>();
    expect(task).toEqual({ status: 'review', failedAt: null, claimedBy: null });
    const view = (await room(pid).listPlanDispatches(pid, planId)).dispatches[0]!;
    expect(view.tasks.find((t) => t.taskId === a)?.runStatus).toBe('gated');
  });

  it.each(['review:structural', 'review:no-verdict', 'review:floor'])(
    'does not auto-redispatch the terminal review stop %s (PLNR-477)',
    async (reason) => {
      const runner = await seedRunner(1);
      const { planId, a, b } = await makePlan(`stop-${reason}`);
      const d = await createDispatch(runner, planId);
      const runA = (await dispatchRuns(d.id)).find((r) => r.taskId === a)!;
      // Remove the peer from readiness, leaving enough capacity to expose an accidental retry.
      await room(pid).updateTask(pid, actor, b, { status: 'done' });
      await room(pid).transitionRun(pid, actor, runA.id, { status: 'running' });
      await room(pid).transitionRun(pid, actor, runA.id, { status: 'failed', reason });
      await room(pid).pumpProjectDispatches(pid);
      expect((await dispatchRuns(d.id)).filter((r) => r.taskId === a)).toHaveLength(1);
    },
  );

  it('a gate-failed phase task becomes failed, holds the plan (blocks the next phase), and retry re-arms it (PLNR-178)', async () => {
    const runner = await seedRunner(2);
    const { planId, a, b, c } = await makePlan('failgate');
    const d = await createDispatch(runner, planId); // approved (strict) — the default
    const runA = (await dispatchRuns(d.id)).find((r) => r.taskId === a)!;
    const agent = await seedAgent(runner);
    // The agent claims a (→ in_progress), then its build run FAILS the daemon's gate.
    await room(pid).transitionRun(pid, actor, runA.id, { status: 'running', agentId: agent });
    await room(pid).claimTask(pid, actor, a, agent);
    await room(pid).transitionRun(pid, actor, runA.id, { status: 'failed', reason: 'verify' });

    // a is the derived 'failed' — a REAL todo (re-armable) carrying failed_at.
    const rowA = await env.DB.prepare('SELECT status, failed_at AS f, claimed_by AS cb FROM tasks WHERE id = ?')
      .bind(a).first<{ status: string; f: string | null; cb: string | null }>();
    expect(rowA!.status).toBe('todo');
    expect(rowA!.f).toBeTruthy();
    expect(rowA!.cb).toBeNull(); // the claim was cleared — the run is over

    // The failed (not done) phase-1 task holds the plan: phase 2 is not dispatched, and c is blocked.
    expect((await dispatchRuns(d.id)).map((r) => r.taskId)).not.toContain(c);
    expect((await taskClaimability(env.DB, c)).claimable).toBe(false);

    // Retry re-arms the failed task with a fresh run (the pump's one-attempt guard blocked auto).
    const before = (await dispatchRuns(d.id)).filter((r) => r.taskId === a).length;
    const { created } = await room(pid).retryPlanDispatch(pid, actor, d.id);
    expect(created).toBeGreaterThanOrEqual(1);
    const runsA = (await dispatchRuns(d.id)).filter((r) => r.taskId === a);
    expect(runsA.length).toBe(before + 1);

    // Claiming the retry run clears failed_at, so it is not shown failed while it re-runs.
    const agent2 = await seedAgent(runner);
    await room(pid).transitionRun(pid, actor, runsA.at(-1)!.id, { status: 'running', agentId: agent2 });
    await room(pid).claimTask(pid, actor, a, agent2);
    const cleared = await env.DB.prepare('SELECT failed_at AS f FROM tasks WHERE id = ?').bind(a).first<{ f: string | null }>();
    expect(cleared!.f).toBeNull();
    void b;
  });

  it('a failed run is NOT retried by the pump; /retry re-arms it', async () => {
    const runner = await seedRunner(2);
    const agent = await seedAgent(runner);
    const { planId, a } = await makePlan('fail');
    const d = await createDispatch(runner, planId);
    const runA = (await dispatchRuns(d.id)).find((r) => r.taskId === a)!;
    await room(pid).transitionRun(pid, actor, runA.id, { status: 'running', agentId: agent });
    await room(pid).transitionRun(pid, actor, runA.id, { status: 'failed', reason: 'agent crashed' });
    // The terminal pump ran — and deliberately did not re-dispatch a.
    expect((await dispatchRuns(d.id)).filter((r) => r.taskId === a).length).toBe(1);
    const { created } = await room(pid).retryPlanDispatch(pid, actor, d.id);
    expect(created).toBeGreaterThanOrEqual(1);
    expect((await dispatchRuns(d.id)).filter((r) => r.taskId === a).length).toBe(2);
  });

  it('stalls — with the failure named — when every remaining path needs a human', async () => {
    const runner = await seedRunner(2);
    const agent = await seedAgent(runner);
    const { planId, a, b } = await makePlan('stall');
    const d = await createDispatch(runner, planId);
    const runs = await dispatchRuns(d.id);
    await finishRun(runs.find((r) => r.taskId === b)!.id, agent);
    const agent2 = await seedAgent(runner);
    const runA = runs.find((r) => r.taskId === a)!;
    await room(pid).transitionRun(pid, actor, runA.id, { status: 'running', agentId: agent2 });
    await room(pid).transitionRun(pid, actor, runA.id, { status: 'failed', reason: 'boom' });
    const view = (await room(pid).listPlanDispatches(pid, planId)).dispatches[0]!;
    expect(view.status).toBe('stalled');
    expect(view.stallReason).toMatch(/failed/);
  });

  it('cancel kills the live runs and halts the pump for good', async () => {
    const runner = await seedRunner(2);
    const { planId } = await makePlan('cancel');
    const d = await createDispatch(runner, planId);
    const before = await dispatchRuns(d.id);
    expect(before.length).toBe(2);
    const res = await room(pid).cancelPlanDispatch(pid, actor, d.id, 'testing');
    expect(res.cancelledRuns).toBe(2);
    for (const r of await dispatchRuns(d.id)) expect(r.status).toBe('cancelled');
    const view = (await room(pid).listPlanDispatches(pid, planId)).dispatches[0]!;
    expect(view.status).toBe('cancelled');
    // Cancelled is terminal for the pump: a later project sweep creates nothing new.
    const { created } = await room(pid).pumpProjectDispatches(pid);
    expect((await dispatchRuns(d.id)).length).toBe(2);
    void created;
  });

  it('completes itself when the last plan task closes', async () => {
    const runner = await seedRunner(4);
    const { planId, a, b, c } = await makePlan('complete');
    const d = await createDispatch(runner, planId);
    for (const t of [a, b, c]) await room(pid).updateTask(pid, actor, t, { status: 'done' });
    const view = (await room(pid).listPlanDispatches(pid, planId)).dispatches[0]!;
    expect(view.status).toBe('completed');
    expect(view.finishedAt).not.toBeNull();
    void d;
  });
});

describe('the door checks', () => {
  it('refuses a proposed plan — approval is the human gate (RUN-23)', async () => {
    const runner = await seedRunner(1);
    const plan = await room(pid).createPlan(pid, actor, {
      title: 'still proposed', proposed: true,
      phases: [{ title: 'p', newTasks: [{ title: 'x' }] }],
    });
    await expect(createDispatch(runner, plan.id)).rejects.toThrow(/proposed/);
  });

  it('refuses a second live dispatch for the same plan', async () => {
    const runner = await seedRunner(1);
    const { planId } = await makePlan('dup');
    await createDispatch(runner, planId);
    await expect(createDispatch(runner, planId)).rejects.toThrow(/already has a live dispatch/);
  });

  it('REST: dispatches via POST /plans/:planId/dispatch, and rejects a repo that is not this project', async () => {
    const runner = await seedRunner(2);
    const { planId } = await makePlan('rest');
    const bad = await SELF.fetch(`https://noriq.test/api/projects/${pid}/plans/${planId}/dispatch`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runnerId: runner, repoRef: 'repo_nope', agentTool: 'claude' }),
    });
    expect(bad.status).toBe(400);
    const ok = await SELF.fetch(`https://noriq.test/api/projects/${pid}/plans/${planId}/dispatch`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runnerId: runner, repoRef: 'repo_pd', agentTool: 'claude', gate: 'landed' }),
    });
    expect(ok.status).toBe(200);
    const { dispatch } = (await ok.json()) as { dispatch: PlanDispatchView };
    expect(dispatch.status).toBe('active');
    expect(dispatch.tasks.filter((t) => t.runId).length).toBe(2); // fanned out immediately
    // The runs the pump created are ordinary runs — visible in the runs list, tied back.
    const list = await SELF.fetch(`https://noriq.test/api/projects/${pid}/runs`, { headers: { Cookie: cookie } });
    const { runs } = (await list.json()) as { runs: Array<{ planDispatchId: string | null }> };
    expect(runs.filter((r) => r.planDispatchId === dispatch.id).length).toBe(2);
  });
});

describe('single_root Runner mission commissioning (PLNR-484)', () => {
  it('commissions one plan-anchored root and excludes the legacy task pump', async () => {
    const runner = await seedRunner(4, true);
    const { planId } = await makePlan('mission-one-root');
    const dispatch = await createDispatch(runner, planId, {
      strategy: 'single_root', workflow: 'mission-plan',
    });
    expect(dispatch.strategy).toBe('single_root');
    expect(dispatch.tasks.every((task) => task.runId === null)).toBe(true);
    const roots = await env.DB.prepare(
      `SELECT id, anchor_type AS anchorType, anchor_id AS anchorId, workflow
         FROM runs WHERE plan_dispatch_id = ?`,
    ).bind(dispatch.id).all<{ id: string; anchorType: string; anchorId: string; workflow: string }>();
    expect(roots.results).toHaveLength(1);
    expect(roots.results[0]).toMatchObject({ anchorType: 'plan', anchorId: planId, workflow: 'mission-plan' });

    await room(pid).pumpProjectDispatches(pid);
    await room(pid).retryPlanDispatch(pid, actor, dispatch.id);
    expect((await env.DB.prepare('SELECT id FROM runs WHERE plan_dispatch_id = ?').bind(dispatch.id).all()).results).toHaveLength(1);
  });

  it('requires an explicit rich build mission.v2 offer while legacy dispatch remains unchanged', async () => {
    const legacyRunner = await seedRunner(2);
    const legacyPlan = await makePlan('mission-legacy');
    const legacy = await createDispatch(legacyRunner, legacyPlan.planId);
    expect(legacy.strategy).toBe('per_task');
    expect((await dispatchRuns(legacy.id)).length).toBe(2);

    const plan = await makePlan('mission-refuse');
    await expect(createDispatch(legacyRunner, plan.planId, {
      strategy: 'single_root', workflow: 'mission-plan',
    })).rejects.toThrow(/mission\.v2/);
  });

  it('cancels the root and stalls rather than claiming completion when it exits with open tasks', async () => {
    const runner = await seedRunner(2, true);
    const agent = await seedAgent(runner);
    const openPlan = await makePlan('mission-open');
    const openDispatch = await createDispatch(runner, openPlan.planId, {
      strategy: 'single_root', workflow: 'mission-plan',
    });
    const openRoot = await env.DB.prepare('SELECT id FROM runs WHERE plan_dispatch_id = ?')
      .bind(openDispatch.id).first<{ id: string }>();
    await finishRun(openRoot!.id, agent);
    const stalled = (await room(pid).listPlanDispatches(pid, openPlan.planId)).dispatches[0]!;
    expect(stalled.status).toBe('stalled');
    expect(stalled.stallReason).toMatch(/completed.*3 plan task/);
    for (const taskId of [openPlan.a, openPlan.b, openPlan.c]) {
      await room(pid).updateTask(pid, actor, taskId, { status: 'done' });
    }
    expect((await room(pid).listPlanDispatches(pid, openPlan.planId)).dispatches[0]!.status).toBe('completed');

    const cancelPlan = await makePlan('mission-cancel');
    const cancelDispatch = await createDispatch(runner, cancelPlan.planId, {
      strategy: 'single_root', workflow: 'mission-plan',
    });
    expect((await room(pid).cancelPlanDispatch(pid, actor, cancelDispatch.id)).cancelledRuns).toBe(1);
    const cancelled = await env.DB.prepare('SELECT status FROM runs WHERE plan_dispatch_id = ?')
      .bind(cancelDispatch.id).first<{ status: string }>();
    expect(cancelled?.status).toBe('cancelled');
  });
});
