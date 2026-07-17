import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall, authorizeForAllProjects } from './helpers';

// NOTE: runs in the same shared-storage suite as coordination.test.ts;
// setup endpoints are exercised first while no users beyond ours may exist.

describe('first-run setup', () => {
  it('reports and performs setup exactly once', async () => {
    const before = await SELF.fetch('https://noriq.test/api/setup/status');
    const status = (await before.json()) as { needsSetup: boolean };

    if (status.needsSetup) {
      const res = await SELF.fetch('https://noriq.test/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'founder@example.com', name: 'Founder', password: 'longenough1' }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('Set-Cookie')).toContain('noriq_session=');
    }

    // Now configured: further setup attempts are refused.
    const after = await SELF.fetch('https://noriq.test/api/setup/status');
    expect(((await after.json()) as { needsSetup: boolean }).needsSetup).toBe(false);
    const again = await SELF.fetch('https://noriq.test/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'evil@example.com', name: 'X', password: 'hackhackhack' }),
    });
    expect(again.status).toBe(409);
  });
});

describe('plans & groups', () => {
  let planner: { id: string; apiKey: string };
  let worker: { id: string; apiKey: string };
  let cookie: string;
  let projectId: string;

  beforeAll(async () => {
    planner = await createAgent('planner', 'orchestrator');
    worker = await createAgent('drone');
    // Setup may have been consumed by another suite (shared storage) — ensure the user exists either way.
    cookie = await loginSession('founder@example.com', 'longenough1').catch(async () => {
      await createUser('founder@example.com', 'Founder', 'longenough1', 'admin');
      return loginSession('founder@example.com', 'longenough1');
    });
    const proj = await mcpCall(planner.apiKey, 'create_project', { key: 'PLZ', name: 'plans-project' });
    projectId = proj.body.id;
    // Scoping (RUN-38): these agents were minted before this project existed, so their tokens
    // are scoped to nothing and only the CREATOR gains it. A human would authorize the others —
    // say so, rather than let the old implicit "every token sees everything" creep back.
    await authorizeForAllProjects(planner.apiKey, worker.apiKey);
  });

  it('create_plan builds enforced phase ordering', async () => {
    const plan = await mcpCall(planner.apiKey, 'create_plan', {
      projectId,
      title: 'Ship the feature',
      description: 'One-line summary',
      body: '# Goals\n\nShip it **properly**.\n\n## Exit gate\n\nAll e2e green.',
      phases: [
        { title: 'Foundations', body: 'Schema first — see `docs/00`.', newTasks: [{ title: 'schema' }, { title: 'api scaffold' }] },
        { title: 'Build', newTasks: [{ title: 'implement endpoints' }] },
        { title: 'Verify', newTasks: [{ title: 'e2e tests' }] },
      ],
    });
    expect(plan.body.phases).toHaveLength(3);

    // Phase-2 task is dep-blocked until phase-1 tasks are done.
    const buildTask = plan.body.phases[1].taskIds[0];
    const blocked = await mcpCall(worker.apiKey, 'claim_task', { projectId, taskId: buildTask });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain('blocked');

    // Phase-1 tasks are claimable.
    const p1 = plan.body.phases[0].taskIds[0];
    const ok = await mcpCall(worker.apiKey, 'claim_task', { projectId, taskId: p1 });
    expect(ok.isError).toBe(false);
  });

  it('get_plans reports per-phase progress and carries the documents', async () => {
    const plans = await mcpCall(planner.apiKey, 'get_plans', { projectId });
    expect(plans.body.plans).toHaveLength(1);
    expect(plans.body.plans[0].body).toContain('# Goals');
    const phases = plans.body.plans[0].phases;
    expect(phases[0].total).toBe(2);
    expect(phases[0].done).toBe(0);
    expect(phases[0].body).toContain('Schema first');
    expect(phases[0].taskKeys).toContain('PLZ-1');
  });

  it('update_plan revises the document; phases patchable too', async () => {
    const plans = await mcpCall(planner.apiKey, 'get_plans', { projectId });
    const plan = plans.body.plans[0];
    const upd = await mcpCall(planner.apiKey, 'update_plan', {
      projectId, planId: plan.id,
      body: plan.body + '\n\n> **Status:** foundations landed.',
    });
    expect(upd.isError).toBe(false);
    const phaseUpd = await mcpCall(planner.apiKey, 'update_plan', {
      projectId, planId: plan.id, phaseId: plan.phases[0].id, phaseBody: 'Schema done — see migration 0001.',
    });
    expect(phaseUpd.isError).toBe(false);
    const after = await mcpCall(planner.apiKey, 'get_plans', { projectId });
    expect(after.body.plans[0].body).toContain('foundations landed');
    expect(after.body.plans[0].phases[0].body).toContain('migration 0001');
  });

  it('snapshot exposes plans/phases/phaseTasks for the UI', async () => {
    const res = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/snapshot`, { headers: { Cookie: cookie } });
    const snap = (await res.json()) as any;
    expect(snap.plans).toHaveLength(1);
    expect(snap.phases).toHaveLength(3);
    expect(snap.phaseTasks.length).toBe(4);
  });

  it('new projects default to a 30-minute claim TTL', async () => {
    const proj = await mcpCall(planner.apiKey, 'get_project', { projectId });
    expect(proj.body.project.claimTtlSeconds).toBe(1800);
  });

  it('groups can be created and projects assigned', async () => {
    const g = await SELF.fetch('https://noriq.test/api/groups', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Platform' }),
    });
    expect(g.status).toBe(200);
    const { id: groupId } = (await g.json()) as { id: string };
    const patch = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/meta`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId }),
    });
    expect(patch.status).toBe(200);
    const list = await SELF.fetch('https://noriq.test/api/projects', { headers: { Cookie: cookie } });
    const { projects } = (await list.json()) as { projects: Array<{ id: string; groupId: string | null }> };
    expect(projects.find((p) => p.id === projectId)?.groupId).toBe(groupId);
  });

  it('static key issuance is gone; revoking an OAuth agent kills its access', async () => {
    // The old issuance endpoint must be dead (OAuth-only — PLNR-52).
    const issue = await SELF.fetch('https://noriq.test/api/agents', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ui-issued' }),
    });
    expect(issue.status).toBe(404);

    const doomed = await createAgent('doomed-agent');
    const before = await mcpCall(doomed.apiKey, 'get_briefing', {});
    expect(before.isError).toBe(false);
    const revoked = await SELF.fetch(`https://noriq.test/api/agents/${doomed.id}/revoke`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(revoked.status).toBe(200);
    const rejected = await mcpCall(doomed.apiKey, 'get_briefing', {}).catch((e) => e);
    expect(String(rejected)).toContain('401');
  });

  // ---- RUN-23: the proposed-plan approval gate --------------------------------
  it('a proposed plan gates its tasks — un-claimable until a human approves it', async () => {
    const plan = await mcpCall(planner.apiKey, 'create_plan', {
      projectId, title: 'Scoped work (proposed)', proposed: true,
      phases: [{ title: 'Phase 1', newTasks: [{ title: 'gated task A' }] }],
    });
    expect(plan.isError).toBe(false);
    expect(plan.body.status).toBe('proposed');
    const taskId = plan.body.phases[0].taskIds[0];

    // Gated: claim is refused even with no unfinished deps (plan-level gate).
    const blocked = await mcpCall(worker.apiKey, 'claim_task', { projectId, taskId });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain('proposed plan');

    // Gated: next_claimable for this project never surfaces it.
    const nc = await mcpCall(worker.apiKey, 'next_claimable', { projectId });
    expect(nc.body.task?.id === taskId).toBeFalsy();

    // Approve → proposed → active → tasks ungate.
    const appr = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/plans/${plan.body.id}/approve`, {
      method: 'POST', headers: { Cookie: cookie },
    });
    expect(appr.status).toBe(200);
    const apprBody = (await appr.json()) as { status: string; tasksUngated: number };
    expect(apprBody.status).toBe('active');
    expect(apprBody.tasksUngated).toBe(1);

    // Now claimable.
    const ok = await mcpCall(worker.apiKey, 'claim_task', { projectId, taskId });
    expect(ok.isError).toBe(false);

    // Approving a non-proposed plan is refused.
    const again = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/plans/${plan.body.id}/approve`, {
      method: 'POST', headers: { Cookie: cookie },
    });
    expect(again.status).toBe(500); // "plan is active, not proposed"
  });

  it('rejecting a proposed plan cancels its un-started tasks and discards the plan', async () => {
    const plan = await mcpCall(planner.apiKey, 'create_plan', {
      projectId, title: 'To be rejected', proposed: true,
      phases: [{ title: 'Phase 1', newTasks: [{ title: 'doomed task' }] }],
    });
    const planId = plan.body.id;
    const taskId = plan.body.phases[0].taskIds[0];

    const rej = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/plans/${planId}/reject`, {
      method: 'POST', headers: { Cookie: cookie },
    });
    expect(rej.status).toBe(200);
    expect(((await rej.json()) as { cancelledTasks: number }).cancelledTasks).toBe(1);

    // The task is cancelled (never claimable), and the plan is gone from get_plans.
    const claim = await mcpCall(worker.apiKey, 'claim_task', { projectId, taskId });
    expect(claim.isError).toBe(true);
    expect(claim.text).toContain('not claimable'); // status: cancelled
    const plans = await mcpCall(planner.apiKey, 'get_plans', { projectId });
    expect(plans.body.plans.some((p: { id: string }) => p.id === planId)).toBe(false);
  });

  // ---- PLNR-153: a deleted plan takes its minted dependency edges with it ------
  it('deleting a plan frees its phase-ordering edges but never a manual one', async () => {
    const plan = await mcpCall(planner.apiKey, 'create_plan', {
      projectId, title: 'Short-lived plan',
      phases: [
        { title: 'First', newTasks: [{ title: 'p153 groundwork' }, { title: 'p153 sibling' }] },
        { title: 'Second', newTasks: [{ title: 'p153 follow-up' }] },
      ],
    });
    const [taskA, taskB] = plan.body.phases[0].taskIds as [string, string];
    const taskC = plan.body.phases[1].taskIds[0] as string;

    // A manual edge between phase-1 siblings — no phase boundary between them, so the
    // plan minted nothing here. It must outlive the plan: a human chose it.
    const manual = await mcpCall(planner.apiKey, 'add_dependency', { projectId, taskId: taskB, dependsOnTaskId: taskA });
    expect(manual.isError).toBe(false);

    // Sanity: the phase edge blocks C while the plan lives.
    const gated = await mcpCall(worker.apiKey, 'claim_task', { projectId, taskId: taskC });
    expect(gated.isError).toBe(true);
    expect(gated.text).toContain('blocked');

    const del = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/plans/${plan.body.id}`, {
      method: 'DELETE', headers: { Cookie: cookie },
    });
    expect(del.status).toBe(200);

    // The plan's enforced edges died with it — C is claimable with nothing done.
    const freed = await mcpCall(worker.apiKey, 'claim_task', { projectId, taskId: taskC });
    expect(freed.isError).toBe(false);

    // The manual edge survived — B is still blocked behind A.
    const stillBlocked = await mcpCall(worker.apiKey, 'claim_task', { projectId, taskId: taskB });
    expect(stillBlocked.isError).toBe(true);
    expect(stillBlocked.text).toContain('blocked');

    // ---- PLNR-152: and an agent can now undo an edge itself, over MCP --------
    const undo = await mcpCall(planner.apiKey, 'remove_dependency', { projectId, taskId: taskB, dependsOnTaskId: taskA });
    expect(undo.isError).toBe(false);
    const unblocked = await mcpCall(worker.apiKey, 'claim_task', { projectId, taskId: taskB });
    expect(unblocked.isError).toBe(false);
  });

  // ---- PLNR-133: create_plan writes plan + fully-attributed tasks in one call --
  it('newTasks carry tags/milestone/type/estimate, with plan-level taskDefaults', async () => {
    const ms = await mcpCall(planner.apiKey, 'create_milestone', { projectId, title: 'M-133' });
    const plan = await mcpCall(planner.apiKey, 'create_plan', {
      projectId, title: 'One-call plan',
      taskDefaults: { milestoneId: ms.body.id, tags: ['planwide'], type: 'chore', priority: 3 },
      phases: [
        { title: 'Only', newTasks: [
          { title: 'inherits everything' },
          { title: 'overrides type+prio', type: 'bug', priority: 4, estimate: 2, tags: ['special'] },
        ] },
      ],
    });
    expect(plan.isError).toBe(false);
    const [inherited, overridden] = plan.body.phases[0].taskIds as [string, string];

    const a = await mcpCall(planner.apiKey, 'get_task', { taskId: inherited });
    expect(a.body.task.milestone_id).toBe(ms.body.id);
    expect(a.body.task.type).toBe('chore');
    expect(a.body.task.priority).toBe(3);

    const b = await mcpCall(planner.apiKey, 'get_task', { taskId: overridden });
    expect(b.body.task.type).toBe('bug');
    expect(b.body.task.priority).toBe(4);
    expect(b.body.task.estimate).toBe(2);
    expect(b.body.task.milestone_id).toBe(ms.body.id); // default still fills the gap

    // Ad-hoc dependsOn by KEY, on top of the phase chain.
    const dep = await mcpCall(planner.apiKey, 'create_plan', {
      projectId, title: 'dep plan',
      phases: [{ title: 'P', newTasks: [{ title: 'extra-gated', dependsOn: [a.body.task.key] }] }],
    });
    const gatedId = dep.body.phases[0].taskIds[0];
    const claim = await mcpCall(worker.apiKey, 'claim_task', { projectId, taskId: gatedId });
    expect(claim.isError).toBe(true);
    expect(claim.text).toContain('blocked');
  });

  // ---- PLNR-154: plan structure is editable, and the edges follow it ----------
  it('update_plan restructures phases; the enforced ordering follows the new shape', async () => {
    const plan = await mcpCall(planner.apiKey, 'create_plan', {
      projectId, title: 'Restructure me',
      phases: [
        { title: 'One', newTasks: [{ title: 'p154 base' }, { title: 'p154 movee' }] },
        { title: 'Two', newTasks: [{ title: 'p154 tail' }] },
      ],
    });
    const phase1 = plan.body.phases[0];
    const phase2 = plan.body.phases[1];
    const [base, movee] = phase1.taskIds as [string, string];
    const tail = phase2.taskIds[0] as string;

    // A hand-added edge that must survive every restructure below.
    await mcpCall(planner.apiKey, 'add_dependency', { projectId, taskId: tail, dependsOnTaskId: base });

    // Move `movee` from phase 1 to phase 2, keeping both phase ids.
    const move = await mcpCall(planner.apiKey, 'update_plan', {
      projectId, planId: plan.body.id,
      phases: [
        { id: phase1.id, title: 'One', taskIds: [base] },
        { id: phase2.id, title: 'Two', taskIds: [movee, tail] },
      ],
    });
    expect(move.isError).toBe(false);

    // movee now lives behind phase 1: blocked on base, where before it was claimable.
    const gated = await mcpCall(worker.apiKey, 'claim_task', { projectId, taskId: movee });
    expect(gated.isError).toBe(true);
    expect(gated.text).toContain('blocked');

    // Now drop `movee` from the plan entirely (and with it, nothing else changes).
    const drop = await mcpCall(planner.apiKey, 'update_plan', {
      projectId, planId: plan.body.id,
      phases: [
        { id: phase1.id, title: 'One', taskIds: [base] },
        { id: phase2.id, title: 'Two', taskIds: [tail] },
      ],
    });
    expect(drop.isError).toBe(false);

    // Out of the plan → out from under its edges: movee is claimable again.
    const freed = await mcpCall(worker.apiKey, 'claim_task', { projectId, taskId: movee });
    expect(freed.isError).toBe(false);

    // The manual edge (tail depends on base) is not the plan's to shed — still blocking.
    const manualHolds = await mcpCall(worker.apiKey, 'claim_task', { projectId, taskId: tail });
    expect(manualHolds.isError).toBe(true);
    expect(manualHolds.text).toContain('blocked');

    // Collapsing to one phase drops phase 2 and every plan-minted edge with it; the
    // structure reads back in the new shape. (tail keeps only its manual blocker.)
    const collapse = await mcpCall(planner.apiKey, 'update_plan', {
      projectId, planId: plan.body.id,
      phases: [{ id: phase1.id, title: 'Only', taskIds: [base, tail] }],
    });
    expect(collapse.isError).toBe(false);
    const after = await mcpCall(planner.apiKey, 'get_plans', { projectId });
    const shape = after.body.plans.find((p: { id: string }) => p.id === plan.body.id);
    expect(shape.phases).toHaveLength(1);
    expect(shape.phases[0].title).toBe('Only');
    expect(shape.phases[0].total).toBe(2);

    // A phase id from some other plan is refused.
    const foreign = await mcpCall(planner.apiKey, 'update_plan', {
      projectId, planId: plan.body.id,
      phases: [{ id: 'phs_not_mine', title: 'X', taskIds: [base] }],
    });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toContain('not part of this plan');
  });

  // ---- PLNR-148: plans shelve without losing anything ---------------------------
  it('archiving hides a plan from get_plans but keeps its edges enforced; restore returns it', async () => {
    const plan = await mcpCall(planner.apiKey, 'create_plan', {
      projectId, title: 'Shelvable',
      phases: [
        { title: 'A', newTasks: [{ title: 'p148 first' }] },
        { title: 'B', newTasks: [{ title: 'p148 second' }] },
      ],
    });
    const gated = plan.body.phases[1].taskIds[0];

    const arch = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/plans/${plan.body.id}/archive`, {
      method: 'POST', headers: { Cookie: cookie },
    });
    expect(arch.status).toBe(200);

    // Hidden from the agent read…
    const listed = await mcpCall(planner.apiKey, 'get_plans', { projectId });
    expect(listed.body.plans.some((p: { id: string }) => p.id === plan.body.id)).toBe(false);
    // …but the snapshot ships it flagged, and the phase edge still gates.
    const snap = (await (await SELF.fetch(`https://noriq.test/api/projects/${projectId}/snapshot`, { headers: { Cookie: cookie } })).json()) as {
      plans: Array<{ id: string; archivedAt: string | null }>;
    };
    expect(snap.plans.find((p) => p.id === plan.body.id)?.archivedAt).toBeTruthy();
    const stillGated = await mcpCall(worker.apiKey, 'claim_task', { projectId, taskId: gated });
    expect(stillGated.isError).toBe(true);
    expect(stillGated.text).toContain('blocked');

    const rest = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/plans/${plan.body.id}/restore`, {
      method: 'POST', headers: { Cookie: cookie },
    });
    expect(rest.status).toBe(200);
    const back = await mcpCall(planner.apiKey, 'get_plans', { projectId });
    expect(back.body.plans.some((p: { id: string }) => p.id === plan.body.id)).toBe(true);
  });

  it('phase order gates without minting dependency edges (PLNR-163)', async () => {
    const plan = await mcpCall(planner.apiKey, 'create_plan', {
      projectId,
      title: 'Edge-free ordering',
      description: 'phases gate directly',
      body: '# Goal\n\nNo minted edges.',
      phases: [
        { title: 'First', newTasks: [{ title: 'edgefree base' }] },
        { title: 'Second', newTasks: [{ title: 'edgefree dependent' }] },
      ],
    });
    const base = plan.body.phases[0].taskIds[0];
    const dependent = plan.body.phases[1].taskIds[0];

    // The gate is real: phase-2 claim names the phase-1 blocker…
    const gated = await mcpCall(worker.apiKey, 'claim_task', { projectId, taskId: dependent });
    expect(gated.isError).toBe(true);
    expect(gated.text).toContain('blocked');

    // …but the task carries NO dependency rows — the plan is the gate, not per-task config.
    const detail = await mcpCall(planner.apiKey, 'get_task', { taskId: dependent });
    expect(detail.body.dependencies ?? []).toHaveLength(0);

    // Finishing phase 1 lifts the gate with zero task/dependency writes.
    await mcpCall(worker.apiKey, 'claim_task', { projectId, taskId: base });
    await mcpCall(worker.apiKey, 'release_task', { projectId, taskId: base, toStatus: 'done' });
    const open = await mcpCall(worker.apiKey, 'claim_task', { projectId, taskId: dependent });
    expect(open.isError).toBe(false);
    await mcpCall(worker.apiKey, 'release_task', { projectId, taskId: dependent, toStatus: 'done' });
  });

  it('can_claim reports the phase gate without claiming — the RUN-81 backstop probe (PLNR-177)', async () => {
    const plan = await mcpCall(planner.apiKey, 'create_plan', {
      projectId,
      title: 'Probe the gate',
      description: 'can_claim',
      body: '# Goal\n\nprobe.',
      phases: [
        { title: 'One', newTasks: [{ title: 'probe base' }] },
        { title: 'Two', newTasks: [{ title: 'probe dependent' }] },
      ],
    });
    const base = plan.body.phases[0].taskIds[0];
    const baseKey = (await mcpCall(worker.apiKey, 'can_claim', { taskId: base })).body.taskKey;
    const dependent = plan.body.phases[1].taskIds[0];

    // Phase 2 is locked while phase 1 is unfinished — reported, not claimed.
    const blocked = await mcpCall(worker.apiKey, 'can_claim', { taskId: dependent });
    expect(blocked.isError).toBe(false);
    expect(blocked.body.claimable).toBe(false);
    expect(blocked.body.reason).toContain(baseKey);

    // Phase 1 itself is claimable.
    expect((await mcpCall(worker.apiKey, 'can_claim', { taskId: base })).body.claimable).toBe(true);

    // A task only in review is not claimable (the RUN-59 shape: verifier passed, not approved).
    await mcpCall(worker.apiKey, 'claim_task', { projectId, taskId: base });
    await mcpCall(worker.apiKey, 'release_task', { projectId, taskId: base, toStatus: 'review' });
    const inReview = await mcpCall(worker.apiKey, 'can_claim', { taskId: dependent });
    expect(inReview.body.claimable).toBe(false); // phase 1 in review ≠ done → phase 2 stays locked
    expect((await mcpCall(worker.apiKey, 'can_claim', { taskId: base })).body.reason).toContain('review');

    // Approving phase 1 (done) opens phase 2.
    await mcpCall(worker.apiKey, 'update_task', { projectId, taskId: base, status: 'done' });
    expect((await mcpCall(worker.apiKey, 'can_claim', { taskId: dependent })).body.claimable).toBe(true);

    // Unknown task → error, so the daemon's probe fails OPEN (never strands a run).
    expect((await mcpCall(worker.apiKey, 'can_claim', { taskId: 'task_nope' })).isError).toBe(true);
  });
});
