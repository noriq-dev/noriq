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
import type {
  AcceptedRevisionHandoff, AcceptedRevisionHandoffView, MissionCommission, MissionHandoffAck,
  MissionAdoptionResult, MissionInventoryItem, MissionLeaseRef,
  MissionQuestionAck, MissionQuestionPublication,
  MissionTaskAck, MissionTaskBeginReport, MissionTaskSettleReport,
} from '@noriq-dev/shared';
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
  beginMissionTask(projectId: string, rootRunId: string, input: MissionTaskBeginReport, lease?: MissionLeaseRef): Promise<MissionTaskAck>;
  settleMissionTask(projectId: string, rootRunId: string, input: MissionTaskSettleReport, lease?: MissionLeaseRef): Promise<MissionTaskAck>;
  missionLease(projectId: string, rootRunId: string): Promise<MissionLeaseRef>;
  validateMissionLease(projectId: string, rootRunId: string, lease: MissionLeaseRef | null): Promise<boolean>;
  openRunnerMissionReconciliation(projectId: string, runnerId: string, deadlineMs?: number): Promise<{ deadline: string; items: MissionInventoryItem[] }>;
  currentRunnerMissionReconciliation(projectId: string, runnerId: string): Promise<{ deadline: string | null; items: MissionInventoryItem[] }>;
  adoptRunnerMission(projectId: string, runnerId: string, inventory: MissionInventoryItem): Promise<MissionAdoptionResult>;
  reconcileRunnerRuns(projectId: string, actor: Actor, runnerId: string, options?: { excludeMission?: boolean }): Promise<{ failed: number }>;
  sweepRunnerMissionReconciliations(projectId: string, actor?: Actor): Promise<{ failed: number }>;
  getMissionCommission(projectId: string, rootRunId: string): Promise<MissionCommission | null>;
  publishMissionHandoff(projectId: string, rootRunId: string, reportId: string, handoff: AcceptedRevisionHandoff, lease: MissionLeaseRef): Promise<MissionHandoffAck>;
  getMissionHandoff(projectId: string, rootRunId: string): Promise<AcceptedRevisionHandoffView | null>;
  consumeMissionHandoff(projectId: string, actor: Actor, rootRunId: string, handoff: AcceptedRevisionHandoff): Promise<{ handoff: AcceptedRevisionHandoffView }>;
  publishMissionQuestion(projectId: string, rootRunId: string, question: MissionQuestionPublication, lease: MissionLeaseRef): Promise<MissionQuestionAck>;
  answerSignal(projectId: string, actor: Actor, signalId: string, response: string): Promise<{ ok: boolean; alreadyResolved?: boolean }>;
}
const room = (pid: string) =>
  appEnv.PROJECT_ROOM.get(appEnv.PROJECT_ROOM.idFromName(pid)) as unknown as RoomRpc;

let cookie: string;
let userId: string;
let pid: string;

/** A runner the pump can schedule onto. Fresh per test — capacity math reads the runs
 *  table, so sharing a runner across tests would leak slots between them. */
let runnerSeq = 0;
const missionProfile = () => ({
  id: 'mission-profile', declarationFingerprint: 'decl-mission', effectiveFingerprint: 'inventory-mission',
  resolution: 'resolved', health: 'healthy', attestationCapable: true,
  observedAt: new Date().toISOString(), generation: 1,
  capacity: { maxConcurrency: 8, freeSlots: 8 },
});
async function seedRunner(maxConcurrency: number, mission = false, executionProfiles: unknown[] = []): Promise<string> {
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
      executionProfiles: mission && executionProfiles.length === 0 ? [missionProfile()] : executionProfiles,
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
    planId, runnerId, repoRef: 'repo_pd', agentTool: 'claude',
    ...(over.strategy === 'single_root' && !Object.hasOwn(over, 'executionProfileId')
      ? { executionProfileId: 'mission-profile' }
      : {}),
    ...over,
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
    const { planId, a, c } = await makePlan('mission-one-root');
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
    const commission = await room(pid).getMissionCommission(pid, roots.results[0]!.id);
    expect(commission).toMatchObject({
      digest: expect.any(String),
      snapshot: {
        schemaVersion: 1, runId: roots.results[0]!.id, planId, sitting: 1,
        planRevision: expect.any(String), tasks: expect.any(Array), dependencies: expect.any(Array),
      },
    });
    expect(commission!.snapshot.tasks).toHaveLength(3);
    expect(commission!.snapshot.tasks.find((task) => task.taskId === c)!.phaseOrder)
      .toBeGreaterThan(commission!.snapshot.tasks.find((task) => task.taskId === a)!.phaseOrder);

    await room(pid).pumpProjectDispatches(pid);
    await room(pid).retryPlanDispatch(pid, actor, dispatch.id);
    expect((await env.DB.prepare('SELECT id FROM runs WHERE plan_dispatch_id = ?').bind(dispatch.id).all()).results).toHaveLength(1);
  });

  it('keeps the commissioned task graph immutable and admits only snapshot membership', async () => {
    const runner = await seedRunner(4, true);
    const agent = await seedAgent(runner);
    const plan = await makePlan('mission-snapshot-immutable');
    const dispatch = await createDispatch(runner, plan.planId, {
      strategy: 'single_root', workflow: 'mission-plan',
    });
    const root = await env.DB.prepare('SELECT id FROM runs WHERE plan_dispatch_id = ?')
      .bind(dispatch.id).first<{ id: string }>();
    const before = await room(pid).getMissionCommission(pid, root!.id);
    expect(before!.snapshot.tasks.find((task) => task.taskId === plan.a)?.title).toContain('a');

    await room(pid).updateTask(pid, actor, plan.a, { title: 'mutated after commission', body: 'new mutable text' });
    await room(pid).restructurePlan(pid, actor, plan.planId, [
      { title: 'changed phase', taskIds: [plan.b] },
      { title: 'later', taskIds: [plan.c] },
    ]);
    const after = await room(pid).getMissionCommission(pid, root!.id);
    expect(after).toEqual(before);
    expect(after!.snapshot.tasks.map((task) => task.taskId)).toContain(plan.a);

    await room(pid).transitionRun(pid, actor, root!.id, { status: 'running', agentId: agent });
    const lease = await room(pid).missionLease(pid, root!.id);
    const accepted = await room(pid).beginMissionTask(pid, root!.id, {
      reportId: 'snapshot-old-member', attemptId: 'snapshot-old-member', taskId: plan.a,
      childKey: 'snapshot-old-member', observedAt: new Date().toISOString(),
    }, lease);
    expect(accepted).toMatchObject({ accepted: true, taskId: plan.a });

    const foreign = await makePlan('mission-snapshot-new-member');
    await expect(room(pid).beginMissionTask(pid, root!.id, {
      reportId: 'snapshot-new-member', attemptId: 'snapshot-new-member', taskId: foreign.a,
      childKey: 'snapshot-new-member', observedAt: new Date().toISOString(),
    }, lease)).rejects.toThrow(/snapshot/);
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

    const missionRunner = await seedRunner(2, true);
    const profilePlan = await makePlan('mission-profile-required');
    await expect(createDispatch(missionRunner, profilePlan.planId, {
      strategy: 'single_root', workflow: 'mission-plan', executionProfileId: null,
    })).rejects.toThrow(/exact healthy attested execution profile/);
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
    const cancelRoot = await env.DB.prepare('SELECT id FROM runs WHERE plan_dispatch_id = ?')
      .bind(cancelDispatch.id).first<{ id: string }>();
    const cancelAgent = await seedAgent(runner);
    await room(pid).transitionRun(pid, actor, cancelRoot!.id, { status: 'running', agentId: cancelAgent });
    const liveAttempt = await room(pid).beginMissionTask(pid, cancelRoot!.id, {
      reportId: 'cancel-live-begin', attemptId: 'cancel-live-attempt', taskId: cancelPlan.a,
      childKey: 'cancel-live-child', observedAt: new Date().toISOString(),
    });
    expect((await room(pid).cancelPlanDispatch(pid, actor, cancelDispatch.id)).cancelledRuns).toBe(1);
    const cancelled = await env.DB.prepare('SELECT status FROM runs WHERE plan_dispatch_id = ?')
      .bind(cancelDispatch.id).first<{ status: string }>();
    expect(cancelled?.status).toBe('cancelled');
    expect(await env.DB.prepare('SELECT status FROM mission_task_attempts WHERE id = ?')
      .bind(liveAttempt.attemptId).first<{ status: string }>()).toEqual({ status: 'interrupted' });
    expect(await env.DB.prepare('SELECT status, claimed_by AS holder FROM tasks WHERE id = ?')
      .bind(cancelPlan.a).first<{ status: string; holder: string | null }>())
      .toEqual({ status: 'todo', holder: null });
    expect(await env.DB.prepare('SELECT released_at AS releasedAt FROM claims WHERE id = ?')
      .bind(liveAttempt.claimId).first<{ releasedAt: string | null }>()).toMatchObject({ releasedAt: expect.any(String) });
    expect(await room(pid).cancelPlanDispatch(pid, actor, cancelDispatch.id)).toEqual({ ok: true, cancelledRuns: 0 });
  });
});

describe('accepted mission handoff consumption (PLNR-488)', () => {
  it('preserves, exposes, exactly consumes, and idempotently replays an unlanded handoff', async () => {
    const runner = await seedRunner(2, true);
    const plan = await makePlan('mission-handoff');
    const dispatch = await createDispatch(runner, plan.planId, {
      strategy: 'single_root', workflow: 'mission-plan',
    });
    const root = await env.DB.prepare('SELECT id, status FROM runs WHERE plan_dispatch_id = ?')
      .bind(dispatch.id).first<{ id: string; status: string }>();
    const lease = await room(pid).missionLease(pid, root!.id);
    const handoff: AcceptedRevisionHandoff = {
      schemaVersion: 1, handoffId: 'handoff-exact-1', backend: 'opaque-vcs',
      repositoryKey: 'noriq', checkpoint: 'checkpoint-17', revision: 'revision-abc',
      reference: 'preserved-ref-17',
    };

    const published = await room(pid).publishMissionHandoff(pid, root!.id, 'publish-1', handoff, lease);
    expect(published).toMatchObject({
      accepted: true, handoffId: handoff.handoffId, state: 'preserved_unlanded',
      consumedAt: null, consumptionId: null,
    });
    expect(await room(pid).publishMissionHandoff(pid, root!.id, 'publish-replay', handoff, lease))
      .toMatchObject({ accepted: true, state: 'preserved_unlanded', preservedAt: published.preservedAt });
    await expect(room(pid).publishMissionHandoff(pid, root!.id, 'publish-conflict', {
      ...handoff, revision: 'different-revision',
    }, lease)).rejects.toThrow(/conflicting/);
    expect(await room(pid).getMissionHandoff(pid, root!.id)).toEqual({
      identity: handoff, state: 'preserved_unlanded', preservedAt: published.preservedAt,
      consumedAt: null, consumptionId: null,
    });

    await expect(room(pid).consumeMissionHandoff(pid, actor, root!.id, {
      ...handoff, reference: 'stale-ref',
    })).rejects.toThrow(/identity mismatch/);
    const consumed = await room(pid).consumeMissionHandoff(pid, actor, root!.id, handoff);
    expect(consumed.handoff).toMatchObject({ identity: handoff, state: 'consumed_unlanded' });
    expect(consumed.handoff.consumptionId).toMatch(/^hca_/);
    const replay = await room(pid).consumeMissionHandoff(pid, actor, root!.id, handoff);
    expect(replay.handoff).toEqual(consumed.handoff);

    // Neither preservation nor consumption claims that the root or its plan tasks landed.
    expect((await env.DB.prepare('SELECT status FROM runs WHERE id = ?').bind(root!.id).first<{ status: string }>())?.status)
      .toBe('dispatched');
    const open = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM phase_tasks pt JOIN phases ph ON ph.id = pt.phase_id
        JOIN tasks t ON t.id = pt.task_id WHERE ph.plan_id = ? AND t.status = 'todo'`,
    ).bind(plan.planId).first<{ n: number }>();
    expect(open?.n).toBe(3);
  });
});

describe('server-authorized mission task attempts (PLNR-485)', () => {
  async function liveMission(title: string, gate: 'approved' | 'landed' = 'approved') {
    const runner = await seedRunner(4, true);
    const agent = await seedAgent(runner);
    const plan = await makePlan(title);
    const dispatch = await createDispatch(runner, plan.planId, {
      strategy: 'single_root', workflow: 'mission-plan', gate,
    });
    const root = await env.DB.prepare('SELECT id FROM runs WHERE plan_dispatch_id = ?')
      .bind(dispatch.id).first<{ id: string }>();
    await room(pid).transitionRun(pid, actor, root!.id, { status: 'running', agentId: agent });
    return { runner, agent, ...plan, dispatch, rootRunId: root!.id };
  }

  const begin = (rootRunId: string, taskId: string, attemptId: string, childKey = attemptId) =>
    room(pid).beginMissionTask(pid, rootRunId, {
      reportId: `begin-${attemptId}`, attemptId, taskId, childKey, observedAt: new Date().toISOString(),
    });

  it('atomically claims an eligible task, records its child execution, and replays the original ack', async () => {
    const mission = await liveMission('mission-attempt');
    const input: MissionTaskBeginReport = {
      reportId: 'begin-a', attemptId: 'attempt-a', taskId: mission.a,
      childKey: 'child-a', observedAt: new Date().toISOString(),
    };
    const accepted = await room(pid).beginMissionTask(pid, mission.rootRunId, input);
    expect(accepted).toMatchObject({ accepted: true, phase: 'begin', taskId: mission.a, taskStatus: 'in_progress' });
    expect(accepted.claimId).toMatch(/^clm_/);
    const task = await env.DB.prepare('SELECT status, claimed_by AS holder FROM tasks WHERE id = ?')
      .bind(mission.a).first<{ status: string; holder: string }>();
    expect(task).toEqual({ status: 'in_progress', holder: mission.agent });
    const child = await env.DB.prepare(
      'SELECT task_id AS taskId, run_id AS runId, parent_execution_id AS parentId FROM execution_nodes WHERE id = ?',
    ).bind(accepted.executionId).first<{ taskId: string; runId: string; parentId: string }>();
    expect(child).toMatchObject({ taskId: mission.a, runId: mission.rootRunId });
    expect(child?.parentId).toMatch(/^exe_/);

    expect(await room(pid).beginMissionTask(pid, mission.rootRunId, input)).toEqual(accepted);
    await expect(room(pid).beginMissionTask(pid, mission.rootRunId, { ...input, taskId: mission.b }))
      .rejects.toThrow(/conflicts/);
    await expect(begin(mission.rootRunId, mission.c, 'attempt-c')).rejects.toThrow(/dependency gate/);
  });

  it('settles through the admitted claim CAS and refuses to overwrite a human move', async () => {
    const mission = await liveMission('mission-settle');
    const admitted = await begin(mission.rootRunId, mission.a, 'attempt-settle-a');
    const settle: MissionTaskSettleReport = {
      reportId: 'settle-a', attemptId: 'attempt-settle-a', claimId: admitted.claimId!,
      outcome: 'done', reason: null, observedAt: new Date().toISOString(),
    };
    const ack = await room(pid).settleMissionTask(pid, mission.rootRunId, settle);
    expect(ack).toMatchObject({ accepted: true, taskStatus: 'review', executionId: admitted.executionId });
    expect(await room(pid).settleMissionTask(pid, mission.rootRunId, settle)).toEqual(ack);
    await expect(room(pid).settleMissionTask(pid, mission.rootRunId, { ...settle, outcome: 'failed' }))
      .rejects.toThrow(/conflicts/);

    const b = await begin(mission.rootRunId, mission.b, 'attempt-human-move');
    await room(pid).updateTask(pid, actor, mission.b, { status: 'done' });
    await expect(room(pid).settleMissionTask(pid, mission.rootRunId, {
      reportId: 'settle-human-move', attemptId: 'attempt-human-move', claimId: b.claimId!,
      outcome: 'done', reason: null, observedAt: new Date().toISOString(),
    })).rejects.toThrow(/ownership changed/);
    expect((await env.DB.prepare('SELECT status FROM tasks WHERE id = ?').bind(mission.b).first<{ status: string }>())?.status)
      .toBe('done');
  });

  it('root terminalization interrupts live attempts without rewriting settled outcomes', async () => {
    const mission = await liveMission('mission-root-stop');
    const settled = await begin(mission.rootRunId, mission.a, 'attempt-already-settled');
    await room(pid).settleMissionTask(pid, mission.rootRunId, {
      reportId: 'settled-before-root', attemptId: 'attempt-already-settled', claimId: settled.claimId!,
      outcome: 'done', reason: null, observedAt: new Date().toISOString(),
    });
    await begin(mission.rootRunId, mission.b, 'attempt-live-at-root-stop');
    await room(pid).transitionRun(pid, actor, mission.rootRunId, { status: 'done' });
    const attempts = await env.DB.prepare(
      'SELECT id, status FROM mission_task_attempts WHERE root_run_id = ? ORDER BY id',
    ).bind(mission.rootRunId).all<{ id: string; status: string }>();
    expect(attempts.results).toEqual([
      { id: 'attempt-already-settled', status: 'review' },
      { id: 'attempt-live-at-root-stop', status: 'interrupted' },
    ]);
    const states = await env.DB.prepare('SELECT id, status, claimed_by AS holder FROM tasks WHERE id IN (?, ?) ORDER BY id')
      .bind(mission.a, mission.b).all<{ id: string; status: string; holder: string | null }>();
    expect(states.results.find((task) => task.id === mission.a)).toMatchObject({ status: 'review', holder: null });
    expect(states.results.find((task) => task.id === mission.b)).toMatchObject({ status: 'todo', holder: null });
  });

  it('unlocks gate=landed only for successful attempts backed by consumed handoff evidence (PLNR-495)', async () => {
    const mission = await liveMission('mission-landed-evidence', 'landed');
    for (const [taskId, suffix] of [[mission.a, 'a'], [mission.b, 'b']] as const) {
      const admitted = await begin(mission.rootRunId, taskId, `landed-${suffix}`);
      await room(pid).settleMissionTask(pid, mission.rootRunId, {
        reportId: `settle-landed-${suffix}`, attemptId: `landed-${suffix}`, claimId: admitted.claimId!,
        outcome: 'done', reason: null, observedAt: new Date().toISOString(),
      });
    }
    expect((await taskClaimability(env.DB, mission.c)).claimable).toBe(false);

    const lease = await room(pid).missionLease(pid, mission.rootRunId);
    const handoff: AcceptedRevisionHandoff = {
      schemaVersion: 1, handoffId: 'landed-gate-handoff', backend: 'opaque-vcs', repositoryKey: 'noriq',
      checkpoint: 'landed-checkpoint', revision: 'landed-revision', reference: 'landed-reference',
    };
    await room(pid).publishMissionHandoff(pid, mission.rootRunId, 'landed-publish', handoff, lease);
    expect((await taskClaimability(env.DB, mission.c)).claimable).toBe(false);
    await room(pid).consumeMissionHandoff(pid, actor, mission.rootRunId, handoff);
    expect((await taskClaimability(env.DB, mission.c)).claimable).toBe(true);

    const gated = await liveMission('mission-gated-not-landed', 'landed');
    for (const [taskId, suffix, outcome] of [
      [gated.a, 'a', 'gated'], [gated.b, 'b', 'done'],
    ] as const) {
      const admitted = await begin(gated.rootRunId, taskId, `not-landed-${suffix}`);
      await room(pid).settleMissionTask(pid, gated.rootRunId, {
        reportId: `settle-not-landed-${suffix}`, attemptId: `not-landed-${suffix}`, claimId: admitted.claimId!,
        outcome, reason: null, observedAt: new Date().toISOString(),
      });
    }
    const gatedLease = await room(pid).missionLease(pid, gated.rootRunId);
    const gatedHandoff = { ...handoff, handoffId: 'gated-handoff', checkpoint: 'gated-checkpoint' };
    await room(pid).publishMissionHandoff(pid, gated.rootRunId, 'gated-publish', gatedHandoff, gatedLease);
    await room(pid).consumeMissionHandoff(pid, actor, gated.rootRunId, gatedHandoff);
    expect((await taskClaimability(env.DB, gated.c)).claimable).toBe(false);
  });

  it('durably maps exact mission questions and abandons outstanding ones on settlement/cancellation (PLNR-496)', async () => {
    const mission = await liveMission('mission-question');
    await begin(mission.rootRunId, mission.a, 'question-attempt');
    const lease = await room(pid).missionLease(pid, mission.rootRunId);
    const publication: MissionQuestionPublication = {
      reportId: 'question-report', questionId: 'question-exact', attemptId: 'question-attempt',
      prompt: 'Choose the exact deployment window.', observedAt: new Date().toISOString(),
    };
    const first = await room(pid).publishMissionQuestion(pid, mission.rootRunId, publication, lease);
    expect(first).toMatchObject({ accepted: true, state: 'open', signalId: expect.any(String) });
    expect(await room(pid).publishMissionQuestion(pid, mission.rootRunId, {
      ...publication, reportId: 'question-replay',
    }, lease)).toMatchObject({ accepted: true, state: 'open', signalId: first.signalId });
    await expect(room(pid).publishMissionQuestion(pid, mission.rootRunId, {
      ...publication, prompt: 'Different prompt under same identity',
    }, lease)).rejects.toThrow(/conflicts/);
    await expect(room(pid).publishMissionQuestion(pid, mission.rootRunId, {
      ...publication, questionId: 'wrong-attempt', attemptId: 'missing-attempt',
    }, lease)).rejects.toThrow(/does not belong/);
    await expect(room(pid).publishMissionQuestion(pid, mission.rootRunId, {
      ...publication, questionId: 'stale-epoch',
    }, { ...lease, epoch: lease.epoch + 1 })).rejects.toThrow(/stale mission lease/);
    expect(await env.DB.prepare('SELECT status, task_id AS taskId FROM signals WHERE id = ?')
      .bind(first.signalId).first<{ status: string; taskId: string }>())
      .toEqual({ status: 'open', taskId: mission.a });

    await room(pid).settleMissionTask(pid, mission.rootRunId, {
      reportId: 'settle-question-attempt', attemptId: 'question-attempt',
      claimId: (await env.DB.prepare('SELECT claim_id AS claimId FROM mission_task_attempts WHERE id = ?')
        .bind('question-attempt').first<{ claimId: string }>())!.claimId,
      outcome: 'cancelled', reason: 'question no longer applies', observedAt: new Date().toISOString(),
    }, lease);
    expect(await env.DB.prepare('SELECT state FROM mission_questions WHERE question_id = ?')
      .bind('question-exact').first<{ state: string }>()).toEqual({ state: 'abandoned' });
    expect(await env.DB.prepare('SELECT status FROM signals WHERE id = ?')
      .bind(first.signalId).first<{ status: string }>()).toEqual({ status: 'dismissed' });

    const rootQuestion = await room(pid).publishMissionQuestion(pid, mission.rootRunId, {
      reportId: 'root-question', questionId: 'root-question', attemptId: null,
      prompt: 'Continue this mission?', observedAt: new Date().toISOString(),
    }, lease);
    expect(rootQuestion.state).toBe('open');
    await room(pid).cancelPlanDispatch(pid, actor, mission.dispatch.id, 'cancel unanswered question');
    expect(await env.DB.prepare('SELECT state FROM mission_questions WHERE question_id = ?')
      .bind('root-question').first<{ state: string }>()).toEqual({ state: 'abandoned' });
    await expect(room(pid).answerSignal(pid, actor, rootQuestion.signalId!, 'stale answer'))
      .resolves.toMatchObject({ ok: true, alreadyResolved: true });
  });
});

describe('durable mission restart reconciliation (PLNR-486)', () => {
  async function liveMission(title: string) {
    const runner = await seedRunner(4, true);
    const agent = await seedAgent(runner);
    const plan = await makePlan(title);
    const dispatch = await createDispatch(runner, plan.planId, {
      strategy: 'single_root', workflow: 'mission-plan',
    });
    const root = await env.DB.prepare('SELECT id FROM runs WHERE plan_dispatch_id = ?')
      .bind(dispatch.id).first<{ id: string }>();
    await room(pid).transitionRun(pid, actor, root!.id, { status: 'running', agentId: agent });
    return { runner, agent, ...plan, dispatch, rootRunId: root!.id };
  }

  it('adopts an exact durable inventory by advancing the lease without duplicating attempts or resetting spend', async () => {
    const mission = await liveMission('mission-adopt');
    const initialLease = await room(pid).missionLease(pid, mission.rootRunId);
    await room(pid).beginMissionTask(pid, mission.rootRunId, {
      reportId: 'begin-adopt', attemptId: 'attempt-adopt', taskId: mission.a,
      childKey: 'child-adopt', observedAt: new Date().toISOString(),
    }, initialLease);
    await env.DB.prepare('UPDATE runs SET tokens_used = 321, usd_spent = 4.25 WHERE id = ?')
      .bind(mission.rootRunId).run();

    const opened = await room(pid).openRunnerMissionReconciliation(pid, mission.runner, 10_000);
    expect(opened.items).toHaveLength(1);
    expect(opened.items[0]).toMatchObject({ runId: mission.rootRunId, lease: initialLease });
    expect(opened.items[0]!.attempts).toHaveLength(1);

    const adopted = await room(pid).adoptRunnerMission(pid, mission.runner, opened.items[0]!);
    expect(adopted).toMatchObject({
      runId: mission.rootRunId, decision: 'adopt',
      lease: { ...initialLease, epoch: initialLease.epoch + 1 }, reason: null,
    });
    expect(await room(pid).validateMissionLease(pid, mission.rootRunId, initialLease)).toBe(false);
    expect(await room(pid).validateMissionLease(pid, mission.rootRunId, adopted.lease)).toBe(true);
    await expect(room(pid).transitionRun(pid, actor, mission.rootRunId, {
      status: 'running', missionLease: initialLease,
    })).rejects.toThrow(/stale mission lease/);
    expect((await room(pid).transitionRun(pid, actor, mission.rootRunId, {
      status: 'running', missionLease: adopted.lease!,
    })).status).toBe('running');

    const durable = await env.DB.prepare(
      `SELECT tokens_used AS tokens, usd_spent AS usd,
              (SELECT COUNT(*) FROM mission_task_attempts WHERE root_run_id = runs.id) AS attempts,
              reconciliation_deadline AS deadline
         FROM runs WHERE id = ?`,
    ).bind(mission.rootRunId).first<{ tokens: number; usd: number; attempts: number; deadline: string | null }>();
    expect(durable).toEqual({ tokens: 321, usd: 4.25, attempts: 1, deadline: null });
  });

  it('refuses mismatched inventory and times an unadopted mission out as daemon_restart', async () => {
    const mismatch = await liveMission('mission-inventory-mismatch');
    const mismatchOpen = await room(pid).openRunnerMissionReconciliation(pid, mismatch.runner, 10_000);
    const refusal = await room(pid).adoptRunnerMission(pid, mismatch.runner, {
      ...mismatchOpen.items[0]!,
      lease: { ...mismatchOpen.items[0]!.lease, epoch: mismatchOpen.items[0]!.lease.epoch + 1 },
    });
    expect(refusal).toMatchObject({ decision: 'cancel', lease: null });
    expect((await room(pid).currentRunnerMissionReconciliation(pid, mismatch.runner)).items).toHaveLength(1);

    const timeout = await liveMission('mission-timeout');
    const lease = await room(pid).missionLease(pid, timeout.rootRunId);
    await room(pid).beginMissionTask(pid, timeout.rootRunId, {
      reportId: 'begin-timeout', attemptId: 'attempt-timeout', taskId: timeout.a,
      childKey: 'child-timeout', observedAt: new Date().toISOString(),
    }, lease);
    await room(pid).openRunnerMissionReconciliation(pid, timeout.runner, 5_000);
    await env.DB.prepare('UPDATE runs SET reconciliation_deadline = ? WHERE id = ?')
      .bind('2000-01-01T00:00:00.000Z', timeout.rootRunId).run();
    expect((await room(pid).sweepRunnerMissionReconciliations(pid)).failed).toBe(1);

    const failed = await env.DB.prepare('SELECT status, exit FROM runs WHERE id = ?')
      .bind(timeout.rootRunId).first<{ status: string; exit: string }>();
    expect(failed?.status).toBe('failed');
    expect(JSON.parse(failed!.exit)).toMatchObject({ outcome: 'failed', reason: 'daemon_restart' });
    const attempt = await env.DB.prepare('SELECT status FROM mission_task_attempts WHERE id = ?')
      .bind('attempt-timeout').first<{ status: string }>();
    expect(attempt?.status).toBe('interrupted');
  });

  it('keeps legacy restart failure behavior while excluding only pending mission roots', async () => {
    const mission = await liveMission('mission-excluded-reconcile');
    const ordinary = await room(pid).createRun(pid, actor, {
      kind: 'build', repoRef: 'repo_pd', agentTool: 'claude', runnerId: mission.runner,
    });
    await room(pid).transitionRun(pid, actor, ordinary.id, { status: 'running' });
    await room(pid).openRunnerMissionReconciliation(pid, mission.runner, 10_000);
    expect((await room(pid).reconcileRunnerRuns(pid, actor, mission.runner, { excludeMission: true })).failed).toBe(1);
    expect((await env.DB.prepare('SELECT status FROM runs WHERE id = ?').bind(ordinary.id).first<{ status: string }>())?.status)
      .toBe('failed');
    expect((await env.DB.prepare('SELECT status FROM runs WHERE id = ?').bind(mission.rootRunId).first<{ status: string }>())?.status)
      .toBe('running');
  });
});

describe('profile-aware plan scheduling (PLNR-487)', () => {
  const profile = (over: Record<string, unknown> = {}) => ({
    id: 'nod-resources', declarationFingerprint: 'decl-nod', effectiveFingerprint: 'inventory-nod',
    resolution: 'resolved', health: 'healthy', attestationCapable: true,
    observedAt: new Date().toISOString(), generation: 7,
    capacity: { maxConcurrency: 1, freeSlots: 1 }, ...over,
  });

  it('augments global capacity with singleton profile capacity and snapshots every commissioned sitting', async () => {
    const runner = await seedRunner(4, false, [profile()]);
    const plan = await makePlan('profile-singleton');
    const dispatch = await createDispatch(runner, plan.planId, { executionProfileId: 'nod-resources' });
    expect(dispatch.executionProfile).toMatchObject({
      id: 'nod-resources', declarationFingerprint: 'decl-nod', effectiveFingerprint: 'inventory-nod', generation: 7,
    });
    const runs = await env.DB.prepare(
      `SELECT id, execution_profile_id AS profileId, execution_profile AS profile
         FROM runs WHERE plan_dispatch_id = ?`,
    ).bind(dispatch.id).all<{ id: string; profileId: string; profile: string }>();
    expect(runs.results).toHaveLength(1);
    expect(runs.results[0]?.profileId).toBe('nod-resources');
    expect(JSON.parse(runs.results[0]!.profile)).toEqual(dispatch.executionProfile);

    // Global capacity is four, but one live profile sitting consumes the singleton. Re-pumping
    // cannot send the second ready phase-one task until this one exits.
    expect((await room(pid).pumpProjectDispatches(pid)).created).toBe(0);
    await room(pid).transitionRun(pid, actor, runs.results[0]!.id, { status: 'running' });
    await room(pid).transitionRun(pid, actor, runs.results[0]!.id, { status: 'done' });
    const after = await env.DB.prepare('SELECT id FROM runs WHERE plan_dispatch_id = ?')
      .bind(dispatch.id).all<{ id: string }>();
    expect(after.results).toHaveLength(2);
  });

  it('stalls on profile drift without falling back while omitted selection keeps legacy fan-out', async () => {
    const runner = await seedRunner(4, false, [profile()]);
    const selectedPlan = await makePlan('profile-drift');
    const selected = await createDispatch(runner, selectedPlan.planId, { executionProfileId: 'nod-resources' });
    const repos = JSON.parse((await env.DB.prepare('SELECT repos FROM runners WHERE id = ?')
      .bind(runner).first<{ repos: string }>())!.repos) as Array<Record<string, unknown>>;
    repos[0]!.executionProfiles = [profile({ generation: 8, effectiveFingerprint: 'inventory-drifted' })];
    await env.DB.prepare('UPDATE runners SET repos = ? WHERE id = ?').bind(JSON.stringify(repos), runner).run();
    const first = await env.DB.prepare('SELECT id FROM runs WHERE plan_dispatch_id = ?')
      .bind(selected.id).first<{ id: string }>();
    await room(pid).transitionRun(pid, actor, first!.id, { status: 'running' });
    await room(pid).transitionRun(pid, actor, first!.id, { status: 'done' });
    const stalled = (await room(pid).listPlanDispatches(pid, selectedPlan.planId)).dispatches[0]!;
    expect(stalled.status).toBe('stalled');
    expect(stalled.stallReason).toMatch(/execution profile unavailable.*drifted/);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM runs WHERE plan_dispatch_id = ?')
      .bind(selected.id).first<{ n: number }>())?.n).toBe(1);

    const legacyRunner = await seedRunner(4);
    const legacyPlan = await makePlan('profile-omitted');
    const legacy = await createDispatch(legacyRunner, legacyPlan.planId);
    expect(legacy.executionProfile).toBeNull();
    expect((await dispatchRuns(legacy.id)).length).toBe(2);
  });
});
