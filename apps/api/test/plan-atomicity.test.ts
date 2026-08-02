// PLNR-232: create_plan is failure-atomic, and a same-title retry names its twin.
//
// The live incident (NOD, 2026-08-02): a plan's FOURTH newTask hit the curated-tag rejection
// after the plan row, both phases, and three tasks were already committed. The agent fixed the
// tag and retried — and got a second plan plus three duplicate tasks, because nothing told it
// the first call had half-succeeded. These tests pin the two halves of the fix:
//   1. a rejection ANYWHERE in the plan writes NOTHING (validate-all-then-write);
//   2. re-issuing a create_plan whose earlier call actually succeeded is refused with a
//      pointer to the surviving plan, instead of minting a duplicate.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { authorizeForAllProjects, createAgent, mcpCall } from './helpers';

describe('create_plan atomicity (PLNR-232)', () => {
  let agent: { id: string; apiKey: string };
  let pid: string;

  const counts = async () => {
    const row = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM plans WHERE project_id = ?1) AS plans,
         (SELECT COUNT(*) FROM phases ph JOIN plans pl ON pl.id = ph.plan_id WHERE pl.project_id = ?1) AS phases,
         (SELECT COUNT(*) FROM tasks WHERE project_id = ?1) AS tasks`,
    ).bind(pid).first<{ plans: number; phases: number; tasks: number }>();
    return row!;
  };

  beforeAll(async () => {
    agent = await createAgent('plan-atomicity-agent', 'orchestrator');
    pid = (await mcpCall(agent.apiKey, 'create_project', { key: 'PATM', name: 'plan-atomicity' })).body.id;
    await authorizeForAllProjects(agent.apiKey);
    // Mint the one approved tag while the vocabulary is still open, then close it — the same
    // curated posture the incident project had.
    const seed = await mcpCall(agent.apiKey, 'create_task', {
      projectId: pid, title: 'vocabulary seed', tags: ['approved-area'], allowNewTags: true,
    });
    expect(seed.isError).toBeFalsy();
    await env.DB.prepare("UPDATE projects SET tag_policy = 'curated' WHERE id = ?").bind(pid).run();
  }, 60000);

  it('a curated-tag rejection on a LATER task writes nothing at all — the incident, replayed', async () => {
    const before = await counts();
    const res = await mcpCall(agent.apiKey, 'create_plan', {
      projectId: pid,
      title: 'Live shard administration, replayed',
      description: 'PLNR-232 regression',
      body: '# Goal\n\nFail on task three of four; leave no residue.',
      phases: [
        { title: 'One', newTasks: [{ title: 'fine one', tags: ['approved-area'] }] },
        {
          title: 'Two',
          newTasks: [
            { title: 'fine two', tags: ['approved-area'] },
            { title: 'rejected — unminted tag', tags: ['animation'] }, // the incident's exact shape
          ],
        },
      ],
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('curated');
    // The whole point: NOTHING was committed — no plan, no phases, no tasks, so a corrected
    // retry starts from zero instead of duplicating three tasks and a plan shell.
    expect(await counts()).toEqual(before);
    const plans = await mcpCall(agent.apiKey, 'get_plans', { projectId: pid });
    expect(plans.body.plans).toHaveLength(0);
  });

  it('an unknown milestone in taskDefaults fails clean too, not as a mid-plan FK abort', async () => {
    const before = await counts();
    const res = await mcpCall(agent.apiKey, 'create_plan', {
      projectId: pid,
      title: 'Bad milestone plan',
      phases: [{ title: 'One', newTasks: [{ title: 'never lands', tags: ['approved-area'] }] }],
      taskDefaults: { milestoneId: 'ms_does_not_exist' },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('milestone');
    expect(await counts()).toEqual(before);
  });

  it('re-issuing a same-title create_plan is refused and names the survivor', async () => {
    const first = await mcpCall(agent.apiKey, 'create_plan', {
      projectId: pid,
      title: 'Twice-issued plan',
      phases: [{ title: 'One', newTasks: [{ title: 'the real one', tags: ['approved-area'] }] }],
    });
    expect(first.isError).toBeFalsy();
    const planId = first.body.id as string;

    // The response-lost retry: same call again, moments later.
    const retry = await mcpCall(agent.apiKey, 'create_plan', {
      projectId: pid,
      title: 'Twice-issued plan',
      phases: [{ title: 'One', newTasks: [{ title: 'the duplicate', tags: ['approved-area'] }] }],
    });
    expect(retry.isError).toBe(true);
    expect(retry.text).toContain('already exists');
    expect(retry.text).toContain(planId); // the error points at the survivor, not just at a rule

    const plans = await mcpCall(agent.apiKey, 'get_plans', { projectId: pid });
    expect(plans.body.plans.filter((p: { title: string }) => p.title === 'Twice-issued plan')).toHaveLength(1);
  });

  it('an ARCHIVED same-title plan does not block a genuine re-creation', async () => {
    // The guard is a retry tripwire, not a permanent title lock: shelving the survivor ends
    // its claim on the name.
    const plans = await mcpCall(agent.apiKey, 'get_plans', { projectId: pid });
    const survivor = plans.body.plans.find((p: { title: string }) => p.title === 'Twice-issued plan');
    await env.DB.prepare('UPDATE plans SET archived_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), survivor.id).run();

    const again = await mcpCall(agent.apiKey, 'create_plan', {
      projectId: pid,
      title: 'Twice-issued plan',
      phases: [{ title: 'One', newTasks: [{ title: 'the successor', tags: ['approved-area'] }] }],
    });
    expect(again.isError).toBeFalsy();
  });
});
