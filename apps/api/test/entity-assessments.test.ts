import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, loginSession, mcpCall } from './helpers';
import { AssessmentInput } from '@noriq-dev/shared';

let agent: { id: string; apiKey: string }, projectId: string, milestoneId: string;
const evidence = (purpose: 'readiness' | 'implementation' | 'document' = 'readiness') => ({
  purpose, outcome: 'passed', scope: 'repository', summary: 'Inspected the acceptance criteria against the current repository.',
  repositoryKey: 'repo', branch: 'main', baseId: 'base-a',
  evidence: [{ kind: 'inspection', reference: 'src/example.ts:10', result: 'The required seam exists and the planned change remains necessary.' }],
});
beforeAll(async () => {
  agent = await createAgent('evidence-agent');
  projectId = (await mcpCall(agent.apiKey, 'create_project', { key: 'EVD', name: 'Evidence' })).body.id;
  milestoneId = (await mcpCall(agent.apiKey, 'get_project', { projectId })).body.milestones[0].id;
});
const task = async (assessment?: unknown) => {
  const result = await mcpCall(agent.apiKey, 'create_tasks', { projectId,
    tasks: [{ title: 'Evidence task', body: 'Current intent', tags: ['testing'], milestoneId, assessment }] });
  expect(result.body.failed).toBe(0);
  return result.body.created[0].id as string;
};
const freshness = async (subjectId: string) => (await mcpCall(agent.apiKey, 'get_freshness', { projectId, subjectType: 'task', subjectId })).body;

async function humanOverride(input: Record<string,unknown>) {
  const cookie=await loginSession('agent-mint@example.com','longenough1');
  const res=await SELF.fetch(`https://noriq.test/api/projects/${projectId}/readiness-overrides`,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify(input)});
  return {isError:!res.ok,body:await res.json() as any};
}
describe('evidence-backed assessments', () => {
  it('requires meaningful evidence and repository scope', () => {
    expect(AssessmentInput.safeParse({ ...evidence(), evidence: [] }).success).toBe(false);
    expect(AssessmentInput.safeParse({ ...evidence(), baseId: undefined }).success).toBe(false);
    expect(AssessmentInput.safeParse({ ...evidence(), summary: ' ' }).success).toBe(false);
  });
  it('records initial agent evidence and keeps implementation verification separate', async () => {
    const id = await task(evidence());
    let f = await freshness(id);
    expect(f.assessment.readiness.state).toBe('passed');
    expect(f.assessment.readiness.record.provenance).toBe('actor_reported');
    expect(f.assessment.implementation.state).toBe('missing');
    await mcpCall(agent.apiKey, 'record_validation', { projectId, subjectType: 'task', subjectId: id, assessment: evidence('implementation') });
    f = await freshness(id);
    expect(f.assessment.readiness.state).toBe('passed');
    expect(f.assessment.implementation.state).toBe('passed');
    await mcpCall(agent.apiKey, 'update_tasks', { projectId, tasks: [{ taskId: id, set: { body: 'Changed intent' } }] });
    f = await freshness(id);
    expect(f.assessment.readiness.state).toBe('stale');
    expect(f.assessment.implementation.state).toBe('stale');
  });
  it('does not promote legacy attestations or overwrite code baselines when omitted', async () => {
    const id = await task();
    await mcpCall(agent.apiKey, 'record_validation', { projectId, subjectType: 'task', subjectId: id,
      baselines: { codeAssessments: [{ repositoryKey: 'repo', branch: 'main', baseId: 'a' }] } });
    await mcpCall(agent.apiKey, 'record_validation', { projectId, subjectType: 'task', subjectId: id });
    const f = await freshness(id);
    expect(f.assessment.readiness.state).toBe('missing');
    expect(f.baselines.codeAssessments[0].baseId).toBe('a');
  });
  it('retains failed checks and does not let a completion check clear readiness drift', async () => {
    const id = await task(evidence());
    await mcpCall(agent.apiKey, 'update_tasks', { projectId, tasks: [{ taskId: id, set: { body: 'Changed intent' } }] });
    await mcpCall(agent.apiKey, 'record_validation', { projectId, subjectType: 'task', subjectId: id, assessment: evidence('implementation') });
    expect((await freshness(id)).criticalCauses).toContain('content_changed');
    await mcpCall(agent.apiKey, 'record_validation', { projectId, subjectType: 'task', subjectId: id, assessment: { ...evidence(), outcome: 'failed' } });
    expect((await freshness(id)).assessment.readiness.state).toBe('failed');
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM entity_assessments WHERE subject_id = ?').bind(id).first<{n:number}>();
    expect(count?.n).toBe(3);
  });
  it('records initial document evidence', async () => {
    const made = await mcpCall(agent.apiKey, 'create_doc', { projectId, name: 'Verified contract', body: 'The interface accepts a revision identifier.', assessment: evidence('document') });
    expect(made.isError).toBeFalsy();
    const doc = await mcpCall(agent.apiKey, 'get_doc', { projectId, docId: made.body.id });
    expect(doc.body.freshness.assessment.readiness.state).toBe('passed');
  });
});

describe('phase readiness and explicit exceptions', () => {
  it('requires a new second-phase check after predecessors settle, with separate completion evidence', async () => {
    const made = await mcpCall(agent.apiKey, 'create_plan', { projectId, title: 'Two phase evidence workflow',
      taskDefaults: { milestoneId, tags: ['testing'] }, phases: [
        { title: 'First', newTasks: [{ title: 'First task', assessment: evidence() }] },
        { title: 'Second', newTasks: [{ title: 'Second task', assessment: evidence() }] },
      ] });
    expect(made.isError).toBeFalsy();
    const first = made.body.phases[0].taskIds[0], second = made.body.phases[1].taskIds[0];
    expect((await freshness(first)).assessment.required).toBe(true);
    expect((await mcpCall(agent.apiKey, 'claim_task', { repositoryKey:'repo', branch:'main', projectId, taskId: first, baseId: 'base-a' })).isError).toBeFalsy();
    const noCompletion = await mcpCall(agent.apiKey, 'release_task', { projectId, taskId: first, toStatus: 'done' });
    expect(noCompletion.isError).toBe(true);
    expect(noCompletion.text).toContain('Implementation evidence');
    await mcpCall(agent.apiKey, 'record_validation', { projectId, subjectType: 'task', subjectId: first, assessment: evidence('implementation') });
    expect((await mcpCall(agent.apiKey, 'release_task', { projectId, taskId: first, toStatus: 'done', commitId: 'base-a' })).isError).toBeFalsy();
    const f = await freshness(second);
    expect(f.assessment.readiness.state).toBe('stale');
    expect(f.criticalCauses).toContain('readiness_required');
    expect((await mcpCall(agent.apiKey, 'claim_task', { repositoryKey:'repo', branch:'main', projectId, taskId: second })).isError).toBe(true);
    await mcpCall(agent.apiKey, 'record_validation', { projectId, subjectType: 'task', subjectId: second,
      assessment: { ...evidence(), baseId: 'base-b', summary: 'Rechecked after phase one landed; its new interface matches this task.' } });
    expect((await mcpCall(agent.apiKey, 'claim_task', { repositoryKey:'repo', branch:'main', projectId, taskId: second, baseId: 'base-b' })).isError).toBeFalsy();
    // A new revision is a request for reassessment, not inferred proof that the work is wrong.
    expect((await mcpCall(agent.apiKey, 'claim_task', { repositoryKey:'repo', branch:'main', projectId, taskId: second, baseId: 'base-c' })).isError).toBe(true);
    await mcpCall(agent.apiKey, 'release_task', { projectId, taskId: second, toStatus: 'todo' });
  });

  it('binds overrides to context, expires them, and retains audit history', async () => {
    const made = await mcpCall(agent.apiKey, 'create_plan', { projectId, title: 'Override evidence workflow',
      taskDefaults: { milestoneId, tags: ['testing'] }, phases: [{ title: 'First', newTasks: [{ title: 'Exception task' }] }] });
    const id = made.body.phases[0].taskIds[0];
    expect((await mcpCall(agent.apiKey, 'claim_task', { repositoryKey:'repo', branch:'main', projectId, taskId: id })).isError).toBe(true);
    const override = await humanOverride( { projectId, subjectId: id,
      scope: 'readiness', reason: 'Investigating a production issue before all evidence is available.', durationSeconds: 3600 });
    expect(override.isError).toBeFalsy();
    expect(override.body.actorName).toBeTruthy();
    expect((await freshness(id)).assessment.overrides).toHaveLength(1);
    expect((await mcpCall(agent.apiKey, 'claim_task', { repositoryKey:'repo', branch:'main', projectId, taskId: id })).isError).toBeFalsy();
    await mcpCall(agent.apiKey, 'release_task', { projectId, taskId: id, toStatus: 'todo' });
    await env.DB.prepare('UPDATE entity_readiness_overrides SET expires_at = ? WHERE id = ?').bind('2020-01-01T00:00:00.000Z', override.body.id).run();
    expect((await mcpCall(agent.apiKey, 'claim_task', { repositoryKey:'repo', branch:'main', projectId, taskId: id })).isError).toBe(true);
    await humanOverride( { projectId, subjectId: id,
      scope: 'readiness', reason: 'Accept this specific task intent for the investigation.', durationSeconds: 3600 });
    await mcpCall(agent.apiKey, 'update_tasks', { projectId, tasks: [{ taskId: id, set: { body: 'Materially changed scope' } }] });
    expect((await freshness(id)).assessment.overrides).toHaveLength(0);
    expect((await mcpCall(agent.apiKey, 'claim_task', { repositoryKey:'repo', branch:'main', projectId, taskId: id })).isError).toBe(true);
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM entity_readiness_overrides WHERE subject_id = ?').bind(id).first<{n:number}>();
    expect(rows?.n).toBe(2);
  });

  it('does not let an override bypass human plan approval or unfinished dependencies', async () => {
    const made = await mcpCall(agent.apiKey, 'create_plan', { projectId, title: 'Proposed evidence workflow', proposed: true,
      taskDefaults: { milestoneId, tags: ['testing'] }, phases: [{ title: 'First', newTasks: [{ title: 'Proposed task' }] }] });
    const id = made.body.phases[0].taskIds[0];
    await humanOverride( { projectId, subjectId: id,
      scope: 'readiness', reason: 'Checking that this exception does not grant plan approval.', durationSeconds: 3600 });
    const claim = await mcpCall(agent.apiKey, 'claim_task', { repositoryKey:'repo', branch:'main', projectId, taskId: id });
    expect(claim.isError).toBe(true);
    expect(claim.text).toMatch(/approv|proposed/);
  });

  it('exposes evidence-required tasks in the existing Review inbox', async () => {
    const made = await mcpCall(agent.apiKey, 'create_plan', { projectId, title: 'Inbox evidence workflow',
      taskDefaults: { milestoneId, tags: ['testing'] }, phases: [{ title: 'First', newTasks: [{ title: 'Needs initial evidence' }] }] });
    const id = made.body.phases[0].taskIds[0];
    const inbox = await mcpCall(agent.apiKey, 'list_review_inbox', { projectId, cause: 'readiness_required' });
    expect(inbox.isError).toBeFalsy();
    expect(inbox.body.items.some((i: any) => i.subjectId === id)).toBe(true);
  });
});

it('reports live health with the same readiness blockers as claiming', async () => {
  const { projectHealth } = await import('../src/lib/project-health');
  const page = await projectHealth(env.DB, projectId);
  expect(page.items.length).toBeLessThanOrEqual(10);
  expect(page.totalOpenTasks).toBeGreaterThan(0);
  for (const item of page.items) {
    if (item.blockingCauses.includes('readiness_required') && !item.overrides.length) expect(item.claimability.claimable).toBe(false);
  }
});

it('keeps failed checks blocking after content edits and retains their readable history', async () => {
  const id = await task({ ...evidence(), outcome: 'failed' });
  await mcpCall(agent.apiKey, 'update_tasks', { projectId, tasks: [{ taskId: id, set: { body: 'Revised after a failed check' } }] });
  expect((await freshness(id)).criticalCauses).toContain('assessment_failed');
  const history = await mcpCall(agent.apiKey, 'get_validation', { projectId, subjectType: 'task', subjectId: id });
  expect(history.body.assessments[0].outcome).toBe('failed');
  expect(history.body.assessments[0].provenance).toBe('actor_reported');
});

it('does not let plan archival remove evidence gates', async () => {
  const plan = await mcpCall(agent.apiKey, 'create_plan', { projectId, title: 'Archived evidence policy', taskDefaults: { milestoneId, tags: ['testing'] },
    phases: [{ title: 'Only', newTasks: [{ title: 'Still requires evidence' }] }] });
  const id = plan.body.phases[0].taskIds[0];
  await env.DB.prepare('UPDATE plans SET archived_at = ? WHERE id = ?').bind(new Date().toISOString(), plan.body.id).run();
  expect((await freshness(id)).criticalCauses).toContain('readiness_required');
  const claim = await mcpCall(agent.apiKey, 'claim_task', { repositoryKey:'repo', branch:'main', projectId, taskId: id });
  expect(claim.isError).toBe(true);
});

it('rejects changing task intent in the same completion patch as old evidence', async () => {
  const plan = await mcpCall(agent.apiKey, 'create_plan', { projectId, title: 'Atomic completion evidence', taskDefaults: { milestoneId, tags: ['testing'] },
    phases: [{ title: 'Only', newTasks: [{ title: 'Validate final intent' }] }] });
  const id = plan.body.phases[0].taskIds[0];
  await mcpCall(agent.apiKey, 'record_validation', { projectId, subjectType: 'task', subjectId: id, assessment: evidence('implementation') });
  const result = await mcpCall(agent.apiKey, 'update_tasks', { projectId, tasks: [{ taskId: id, set: { status: 'done', body: 'A different implementation contract' } }] });
  expect(result.body.failed).toBe(1);
  const current = await env.DB.prepare('SELECT status FROM tasks WHERE id = ?').bind(id).first<{status:string}>();
  expect(current?.status).toBe('todo');
});

it('excludes released locks from live project health', async () => {
  const { projectHealth } = await import('../src/lib/project-health');
  const baseline = await projectHealth(env.DB, projectId);
  await env.DB.prepare(`INSERT INTO file_locks (id, project_id, agent_id, kind, raw_pattern, canon_pattern, all_branches, acquired_at, expires_at, released_at)
    VALUES ('released_health_fixture', ?, ?, 'file', 'fixture.ts', 'fixture.ts', 1, ?, ?, ?)`)
    .bind(projectId, agent.id, new Date().toISOString(), new Date(Date.now() + 60000).toISOString(), new Date().toISOString()).run();
  expect((await projectHealth(env.DB, projectId)).activeLocks).toBe(baseline.activeLocks);
});

it('pages past blocked readiness candidates without declaring the whole queue empty', async () => {
  const queueProject = (await mcpCall(agent.apiKey, 'create_project', { key: 'EQP', name: 'Evidence queue pagination' })).body.id;
  const milestone = (await mcpCall(agent.apiKey, 'get_project', { projectId: queueProject })).body.milestones[0].id;
  const plan = await mcpCall(agent.apiKey, 'create_plan', { projectId: queueProject, title: 'Readiness backlog', taskDefaults: { milestoneId: milestone, tags: ['testing'] },
    phases: [{ title: 'Only', newTasks: Array.from({ length: 20 }, (_, i) => ({ title: `Needs evidence ${i}`, priority: 0 })) }] });
  expect(plan.isError).toBe(false);
  const loose = await mcpCall(agent.apiKey, 'create_tasks', { projectId: queueProject, tasks: [{ title: 'Independent ready work', priority: 4, milestoneId: milestone, tags: ['testing'] }] });
  const first = await mcpCall(agent.apiKey, 'next_claimable', { projectId: queueProject });
  expect(first.body.task).toBeNull();
  expect(first.body.nextOffset).toBe(20);
  const next = await mcpCall(agent.apiKey, 'next_claimable', { projectId: queueProject, offset: first.body.nextOffset });
  expect(next.body.task.id).toBe(loose.body.created[0].id);
});
