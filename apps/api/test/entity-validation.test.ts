// PLNR-576..580: validation records, doc@version pins, supersession, freshness claim gate, review inbox.
import { SELF } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall } from './helpers';

let agent: { id: string; apiKey: string };
let projectId: string;
let cookie: string;
let milestoneId: string;

beforeAll(async () => {
  agent = await createAgent('val-agent');
  await createUser('val@example.com', 'Val Human', 'longenough1', 'admin').catch(() => {});
  cookie = await loginSession('val@example.com', 'longenough1');
  const p = await mcpCall(agent.apiKey, 'create_project', { key: 'VALD', name: 'validation-p0' });
  projectId = p.body.id;
  const proj = await mcpCall(agent.apiKey, 'get_project', { projectId });
  milestoneId = proj.body.milestones[0].id;
}, 60000);

describe('entity validation (PLNR-576)', () => {
  it('records validation for task/plan/doc; fingerprint ignores title/tags/priority', async () => {
    const task = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId,
      tasks: [{ title: 'validate me', body: 'body-a', tags: ['schema'], milestoneId }],
    });
    expect(task.body.failed).toBe(0);
    const taskId = task.body.created[0].id;

    const fresh0 = await mcpCall(agent.apiKey, 'get_freshness', { projectId, subjectType: 'task', subjectId: taskId });
    expect(fresh0.body.causes.some((c: { code: string }) => c.code === 'never_validated')).toBe(true);
    expect(fresh0.body.lastValidatedAt).toBeNull();

    const rec = await mcpCall(agent.apiKey, 'record_validation', {
      projectId, subjectType: 'task', subjectId: taskId, note: 'looks good',
    });
    expect(rec.isError).toBeFalsy();
    expect(rec.body.contentFingerprint).toBeTruthy();
    expect(rec.body.validatedAt).toBeTruthy();

    const fresh1 = await mcpCall(agent.apiKey, 'get_freshness', { projectId, subjectType: 'task', subjectId: taskId });
    expect(fresh1.body.lastValidatedAt).toBeTruthy();
    expect(fresh1.body.causes.some((c: { code: string }) => c.code === 'never_validated')).toBe(false);
    expect(fresh1.body.causes.some((c: { code: string }) => c.code === 'content_changed')).toBe(false);

    // Title/tags/priority out of fingerprint
    await mcpCall(agent.apiKey, 'update_tasks', {
      projectId,
      tasks: [{ taskId, set: { title: 'renamed', priority: 0, tags: ['schema', 'backend'] } }],
    });
    const freshTitle = await mcpCall(agent.apiKey, 'get_freshness', { projectId, subjectType: 'task', subjectId: taskId });
    expect(freshTitle.body.lastValidatedAt).toBeTruthy();
    expect(freshTitle.body.causes.some((c: { code: string }) => c.code === 'content_changed')).toBe(false);

    // Body change → content_changed (critical)
    await mcpCall(agent.apiKey, 'update_tasks', {
      projectId, tasks: [{ taskId, set: { body: 'body-b' } }],
    });
    const freshBody = await mcpCall(agent.apiKey, 'get_freshness', { projectId, subjectType: 'task', subjectId: taskId });
    expect(freshBody.body.lastValidatedAt).toBeNull();
    expect(freshBody.body.criticalCauses).toContain('content_changed');
  });

  it('copilot can write a doc validation keyed by version', async () => {
    const doc = await mcpCall(agent.apiKey, 'create_doc', {
      projectId, name: 'Settled fact', description: 'A fact', body: 'The sky is blue.',
    });
    const docId = doc.body.id;
    const v1 = await mcpCall(agent.apiKey, 'record_validation', { projectId, subjectType: 'doc', subjectId: docId });
    expect(v1.body.contentFingerprint).toBe('v:1');

    await mcpCall(agent.apiKey, 'update_doc', {
      projectId, docId, body: 'The sky is blue on clear days.',
    });
    const fresh = await mcpCall(agent.apiKey, 'get_freshness', { projectId, subjectType: 'doc', subjectId: docId });
    expect(fresh.body.criticalCauses).toContain('content_changed');
    expect(fresh.body.contentFingerprint).toBe('v:2');
  });
});

describe('doc@version pins (PLNR-577)', () => {
  it('pins current version on link; doc update surfaces doc_baseline_moved and blocks claim', async () => {
    const doc = await mcpCall(agent.apiKey, 'create_doc', {
      projectId, name: 'Auth pin', description: 'Pin target', body: 'Use OAuth 2.1 with PKCE.',
    });
    const docId = doc.body.id;
    const task = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId,
      tasks: [{ title: 'implement auth', body: 'follow the doc', tags: ['auth'], milestoneId, docIds: [docId] }],
    });
    const taskId = task.body.created[0].id;

    const detail = await mcpCall(agent.apiKey, 'get_task', { taskId });
    expect(detail.body.docs[0].pinnedVersion).toBe(1);
    expect(detail.body.docs[0].drifted).toBe(false);

    await mcpCall(agent.apiKey, 'update_doc', {
      projectId, docId, body: 'Use OAuth 2.1 with PKCE. Refresh tokens rotate.',
    });

    const fresh = await mcpCall(agent.apiKey, 'get_freshness', { projectId, subjectType: 'task', subjectId: taskId });
    expect(fresh.body.criticalCauses).toContain('doc_baseline_moved');

    const claim = await mcpCall(agent.apiKey, 'claim_task', { projectId, taskId });
    expect(claim.isError).toBe(true);
    expect(claim.text).toMatch(/doc_baseline_moved/);
  });

  it('accepts explicit docId@version', async () => {
    const doc = await mcpCall(agent.apiKey, 'create_doc', {
      projectId, name: 'Explicit pin', description: 'v pin', body: 'Version one fact.',
    });
    const docId = doc.body.id;
    await mcpCall(agent.apiKey, 'update_doc', { projectId, docId, body: 'Version two fact.' });
    const task = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId,
      tasks: [{
        title: 'pin v1', body: 'still on v1', tags: ['docs'], milestoneId, docIds: [`${docId}@1`],
      }],
    });
    const detail = await mcpCall(agent.apiKey, 'get_task', { taskId: task.body.created[0].id });
    expect(detail.body.docs[0].pinnedVersion).toBe(1);
    expect(detail.body.docs[0].currentVersion).toBe(2);
    expect(detail.body.docs[0].drifted).toBe(true);
  });
});

describe('supersession (PLNR-578)', () => {
  it('links supersedes and surfaces superseded cause', async () => {
    const a = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId, tasks: [{ title: 'old task', body: 'v1', tags: ['lifecycle'], milestoneId }],
    });
    const b = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId, tasks: [{ title: 'new task', body: 'v2', tags: ['lifecycle'], milestoneId }],
    });
    const oldId = a.body.created[0].id;
    const newId = b.body.created[0].id;
    await mcpCall(agent.apiKey, 'set_supersedes', {
      projectId, subjectType: 'task', subjectId: newId, priorId: oldId,
    });
    const link = await mcpCall(agent.apiKey, 'get_supersession', {
      projectId, subjectType: 'task', subjectId: oldId,
    });
    expect(link.body.supersededById).toBe(newId);
    const fresh = await mcpCall(agent.apiKey, 'get_freshness', { projectId, subjectType: 'task', subjectId: oldId });
    expect(fresh.body.causes.some((c: { code: string }) => c.code === 'superseded')).toBe(true);
  });
});

describe('hard claim gate (PLNR-579)', () => {
  it('blocks claim on content_changed after validation + body edit', async () => {
    const task = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId, tasks: [{ title: 'gate me', body: 'stable', tags: ['claims'], milestoneId }],
    });
    const taskId = task.body.created[0].id;
    await mcpCall(agent.apiKey, 'record_validation', { projectId, subjectType: 'task', subjectId: taskId });
    const ok = await mcpCall(agent.apiKey, 'claim_task', { projectId, taskId });
    expect(ok.isError).toBeFalsy();
    await mcpCall(agent.apiKey, 'release_task', { projectId, taskId, toStatus: 'todo' });

    await mcpCall(agent.apiKey, 'update_tasks', {
      projectId, tasks: [{ taskId, set: { body: 'changed' } }],
    });
    const blocked = await mcpCall(agent.apiKey, 'claim_task', { projectId, taskId });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/content_changed/);

    await mcpCall(agent.apiKey, 'record_validation', { projectId, subjectType: 'task', subjectId: taskId });
    const ok2 = await mcpCall(agent.apiKey, 'claim_task', { projectId, taskId });
    expect(ok2.isError).toBeFalsy();
  });

  it('get_task and get_task_context expose freshness', async () => {
    const task = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId, tasks: [{ title: 'context fresh', body: 'x', tags: ['mcp'], milestoneId }],
    });
    const taskId = task.body.created[0].id;
    const detail = await mcpCall(agent.apiKey, 'get_task', { taskId });
    expect(detail.body.freshness).toBeTruthy();
    expect(detail.body.freshness.impactUnknown).toBe(true);

    const ctx = await mcpCall(agent.apiKey, 'get_task_context', { projectId, taskId });
    expect(ctx.body.taskFacts.freshness).toBeTruthy();
    expect(ctx.body.taskFacts.freshness.impactUnknown).toBe(true);
  });
});

describe('review inbox (PLNR-580)', () => {
  it('lists drifted subjects and REST mark-validated clears content_changed', async () => {
    const task = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId, tasks: [{ title: 'inbox item', body: 'a', tags: ['ux'], milestoneId }],
    });
    const taskId = task.body.created[0].id;
    await mcpCall(agent.apiKey, 'record_validation', { projectId, subjectType: 'task', subjectId: taskId });
    await mcpCall(agent.apiKey, 'update_tasks', {
      projectId, tasks: [{ taskId, set: { body: 'b' } }],
    });

    const inbox = await mcpCall(agent.apiKey, 'list_review_inbox', { projectId, cause: 'content_changed' });
    expect(inbox.body.items.some((i: { subjectId: string }) => i.subjectId === taskId)).toBe(true);

    const rest = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/validations`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subjectType: 'task', subjectId: taskId }),
    });
    expect(rest.status).toBe(200);

    const fresh = await mcpCall(agent.apiKey, 'get_freshness', { projectId, subjectType: 'task', subjectId: taskId });
    expect(fresh.body.criticalCauses).not.toContain('content_changed');
  });

  it('does not flood inbox with impact_unknown-only subjects', async () => {
    const task = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId, tasks: [{ title: 'never validated flood', body: 'quiet', tags: ['lifecycle'], milestoneId }],
    });
    const taskId = task.body.created[0].id;
    const fresh = await mcpCall(agent.apiKey, 'get_freshness', { projectId, subjectType: 'task', subjectId: taskId });
    expect(fresh.body.causes.some((c: { code: string }) => c.code === 'impact_unknown')).toBe(true);
    expect(fresh.body.criticalCauses).toEqual([]);

    const inbox = await mcpCall(agent.apiKey, 'list_review_inbox', { projectId });
    expect(inbox.body.items.some((i: { subjectId: string }) => i.subjectId === taskId)).toBe(false);
  });
});

describe('code assessments (PLNR-584 / P1-F)', () => {
  const assessment = {
    repositoryKey: 'github.com/noriq-dev/noriq',
    branch: 'main',
    baseId: 'abc123base',
    summary: 'Assumed auth helpers stable',
  };

  it('stores baselines.codeAssessments on record_validation', async () => {
    const task = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId, tasks: [{ title: 'assess store', body: 'with assessment', tags: ['schema'], milestoneId }],
    });
    const taskId = task.body.created[0].id;
    const rec = await mcpCall(agent.apiKey, 'record_validation', {
      projectId,
      subjectType: 'task',
      subjectId: taskId,
      baselines: { codeAssessments: [assessment] },
    });
    expect(rec.isError).toBeFalsy();
    expect(rec.body.baselines.codeAssessments).toEqual([
      expect.objectContaining(assessment),
    ]);

    const fresh = await mcpCall(agent.apiKey, 'get_freshness', {
      projectId, subjectType: 'task', subjectId: taskId,
    });
    expect(fresh.body.impactUnknown).toBe(false);
    expect(fresh.body.causes.some((c: { code: string }) => c.code === 'impact_unknown')).toBe(false);
    expect(fresh.body.causes.some((c: { code: string }) => c.code === 'code_assessment_stale')).toBe(false);
  });

  it('opens code_assessment_stale when declared baseId differs; matching baseId stays fresh', async () => {
    const task = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId, tasks: [{ title: 'assess drift', body: 'stable body', tags: ['mcp'], milestoneId }],
    });
    const taskId = task.body.created[0].id;
    await mcpCall(agent.apiKey, 'record_validation', {
      projectId,
      subjectType: 'task',
      subjectId: taskId,
      baselines: { codeAssessments: [assessment] },
    });

    const stale = await mcpCall(agent.apiKey, 'get_freshness', {
      projectId,
      subjectType: 'task',
      subjectId: taskId,
      repositoryKey: assessment.repositoryKey,
      branch: assessment.branch,
      baseId: 'zzz999new',
    });
    expect(stale.body.causes.some((c: { code: string }) => c.code === 'code_assessment_stale')).toBe(true);
    expect(stale.body.criticalCauses).not.toContain('code_assessment_stale');
    expect(stale.body.impactUnknown).toBe(false);

    const fresh = await mcpCall(agent.apiKey, 'get_freshness', {
      projectId,
      subjectType: 'task',
      subjectId: taskId,
      repositoryKey: assessment.repositoryKey,
      branch: assessment.branch,
      baseId: assessment.baseId,
    });
    expect(fresh.body.causes.some((c: { code: string }) => c.code === 'code_assessment_stale')).toBe(false);
    expect(fresh.body.criticalCauses).toEqual([]);
  });

  it('get_task_context derives stale from caller baseId; claim still allowed (advisory)', async () => {
    const task = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId, tasks: [{ title: 'assess context', body: 'ctx', tags: ['claims'], milestoneId }],
    });
    const taskId = task.body.created[0].id;
    await mcpCall(agent.apiKey, 'record_validation', {
      projectId,
      subjectType: 'task',
      subjectId: taskId,
      baselines: { codeAssessments: [assessment] },
    });

    const ctx = await mcpCall(agent.apiKey, 'get_task_context', {
      projectId,
      taskId,
      repositoryKey: assessment.repositoryKey,
      branch: assessment.branch,
      baseId: 'drifted-base',
    });
    expect(ctx.body.taskFacts.freshness.causes.some((c: { code: string }) => c.code === 'code_assessment_stale')).toBe(true);
    expect(ctx.body.taskFacts.freshness.criticalCauses).not.toContain('code_assessment_stale');

    const claim = await mcpCall(agent.apiKey, 'claim_task', { projectId, taskId });
    expect(claim.isError).toBeFalsy();
    await mcpCall(agent.apiKey, 'release_task', { projectId, taskId, toStatus: 'todo' });
  });

  it('revalidation clears open stale without forever-suppressing later B→C drift', async () => {
    const task = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId, tasks: [{ title: 'assess lifecycle', body: 'lifecycle body', tags: ['lifecycle'], milestoneId }],
    });
    const taskId = task.body.created[0].id;

    // Open a stored stale flag, then revalidate at revision B.
    await mcpCall(agent.apiKey, 'set_review_cause', {
      projectId,
      subjectType: 'task',
      subjectId: taskId,
      cause: 'code_assessment_stale',
      status: 'open',
      detail: 'prior A→somewhere drift',
    });
    await mcpCall(agent.apiKey, 'record_validation', {
      projectId,
      subjectType: 'task',
      subjectId: taskId,
      baselines: {
        codeAssessments: [{
          ...assessment,
          baseId: 'rev-B',
        }],
      },
    });

    // Freshness for C (≠ B) must still warn — dismissed sentinel must not suppress derived push.
    const forC = await mcpCall(agent.apiKey, 'get_freshness', {
      projectId,
      subjectType: 'task',
      subjectId: taskId,
      repositoryKey: assessment.repositoryKey,
      branch: assessment.branch,
      baseId: 'rev-C',
    });
    expect(forC.body.causes.some((c: { code: string }) => c.code === 'code_assessment_stale')).toBe(true);
    expect(forC.body.impactUnknown).toBe(false);

    // Matching B stays fresh (prior stored open was cleared, not forever-dismissed).
    const forB = await mcpCall(agent.apiKey, 'get_freshness', {
      projectId,
      subjectType: 'task',
      subjectId: taskId,
      repositoryKey: assessment.repositoryKey,
      branch: assessment.branch,
      baseId: 'rev-B',
    });
    expect(forB.body.causes.some((c: { code: string }) => c.code === 'code_assessment_stale')).toBe(false);
  });

  it('preserves stored open stale when no assessments; unassessed scope → impact_unknown', async () => {
    const task = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId, tasks: [{ title: 'assess none', body: 'no assessment body', tags: ['schema'], milestoneId }],
    });
    const taskId = task.body.created[0].id;
    await mcpCall(agent.apiKey, 'record_validation', {
      projectId, subjectType: 'task', subjectId: taskId,
    });
    await mcpCall(agent.apiKey, 'set_review_cause', {
      projectId,
      subjectType: 'task',
      subjectId: taskId,
      cause: 'code_assessment_stale',
      status: 'open',
      detail: 'manual stale while unassessed',
    });

    const fresh = await mcpCall(agent.apiKey, 'get_freshness', {
      projectId,
      subjectType: 'task',
      subjectId: taskId,
      repositoryKey: assessment.repositoryKey,
      branch: assessment.branch,
      baseId: 'any-base',
    });
    expect(fresh.body.impactUnknown).toBe(true);
    expect(fresh.body.causes.some((c: { code: string }) => c.code === 'impact_unknown')).toBe(true);
    expect(fresh.body.causes.some((c: { code: string }) => c.code === 'code_assessment_stale')).toBe(true);
  });

  it('preserves stored open stale on mismatched repo/branch; unassessed caller scope → impact_unknown', async () => {
    const task = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId, tasks: [{ title: 'assess mismatch', body: 'mismatch body', tags: ['mcp'], milestoneId }],
    });
    const taskId = task.body.created[0].id;
    await mcpCall(agent.apiKey, 'record_validation', {
      projectId,
      subjectType: 'task',
      subjectId: taskId,
      baselines: { codeAssessments: [assessment] },
    });
    await mcpCall(agent.apiKey, 'set_review_cause', {
      projectId,
      subjectType: 'task',
      subjectId: taskId,
      cause: 'code_assessment_stale',
      status: 'open',
      detail: 'prior scoped drift',
    });

    const fresh = await mcpCall(agent.apiKey, 'get_freshness', {
      projectId,
      subjectType: 'task',
      subjectId: taskId,
      repositoryKey: 'github.com/other/repo',
      branch: 'other-branch',
      baseId: 'zzz-unrelated',
    });
    expect(fresh.body.impactUnknown).toBe(true);
    expect(fresh.body.causes.some((c: { code: string }) => c.code === 'impact_unknown')).toBe(true);
    expect(fresh.body.causes.some((c: { code: string }) => c.code === 'code_assessment_stale')).toBe(true);
  });
});
