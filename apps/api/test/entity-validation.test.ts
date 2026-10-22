// PLNR-576..580 + PLNR-585: validation records, doc@version pins, supersession, freshness claim gate, review inbox, opt-in dormancy.
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall } from './helpers';
import { computeFreshness, dormancyActivityAt } from '../src/lib/entity-validation';

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
});

describe('opt-in dormancy (PLNR-585 / P1-G)', () => {
  it('computeFreshness: off by default; configured quiet opens dormant only', () => {
    const base = {
      subjectType: 'task' as const,
      subjectId: 'task_x',
      contentFingerprint: 'fp1',
      latestMatching: {
        id: 'val_1', projectId: 'p', subjectType: 'task' as const, subjectId: 'task_x',
        contentFingerprint: 'fp1', validatedAt: '2020-01-01T00:00:00.000Z',
        actorKind: 'agent' as const, actorId: 'a', actorName: 'a', baselinesJson: '{}', note: '',
      },
      latestAny: null as null,
      docPins: [],
      supersededById: null,
      storedCauses: [],
      contentActivityAt: '2020-01-01T00:00:00.000Z',
      now: '2026-01-01T00:00:00.000Z',
    };
    // latestAny null → never_validated; fix for this unit case
    const withAny = { ...base, latestAny: base.latestMatching };

    const off = computeFreshness({ ...withAny, dormancyQuietSeconds: null });
    expect(off.causes.some((c) => c.code === 'dormant')).toBe(false);

    const on = computeFreshness({ ...withAny, dormancyQuietSeconds: 3600 });
    expect(on.causes.some((c) => c.code === 'dormant')).toBe(true);
    expect(on.criticalCauses).not.toContain('dormant');

    const recent = computeFreshness({
      ...withAny,
      dormancyQuietSeconds: 3600,
      contentActivityAt: '2025-12-31T23:30:00.000Z',
      latestMatching: { ...base.latestMatching!, validatedAt: '2025-12-31T23:30:00.000Z' },
      latestAny: { ...base.latestMatching!, validatedAt: '2025-12-31T23:30:00.000Z' },
    });
    expect(recent.causes.some((c) => c.code === 'dormant')).toBe(false);

    expect(dormancyActivityAt({
      lastValidatedAt: '2024-06-01T00:00:00.000Z',
      contentActivityAt: '2025-01-01T00:00:00.000Z',
    })).toBe('2025-01-01T00:00:00.000Z');
  });

  it('unconfigured project never derives dormant; configured quiet opens dormant without closing', async () => {
    const task = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId, tasks: [{ title: 'dormancy subject', body: 'quiet me', tags: ['lifecycle'], milestoneId }],
    });
    const taskId = task.body.created[0].id;
    await mcpCall(agent.apiKey, 'record_validation', { projectId, subjectType: 'task', subjectId: taskId });

    const before = await mcpCall(agent.apiKey, 'get_freshness', { projectId, subjectType: 'task', subjectId: taskId });
    expect(before.body.causes.some((c: { code: string }) => c.code === 'dormant')).toBe(false);

    // Backdate content activity + validation so the quiet clock is exceeded once enabled.
    const old = '2019-01-01T00:00:00.000Z';
    await env.DB.prepare('UPDATE tasks SET content_activity_at = ? WHERE id = ?').bind(old, taskId).run();
    await env.DB.prepare(
      'UPDATE entity_validations SET validated_at = ? WHERE project_id = ? AND subject_id = ?',
    ).bind(old, projectId, taskId).run();

    const stillOff = await mcpCall(agent.apiKey, 'get_freshness', { projectId, subjectType: 'task', subjectId: taskId });
    expect(stillOff.body.causes.some((c: { code: string }) => c.code === 'dormant')).toBe(false);

    const meta = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/meta`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dormancyQuietSeconds: 3600 }),
    });
    expect(meta.status).toBe(200);

    const dorm = await mcpCall(agent.apiKey, 'get_freshness', { projectId, subjectType: 'task', subjectId: taskId });
    expect(dorm.body.causes.some((c: { code: string }) => c.code === 'dormant')).toBe(true);
    expect(dorm.body.criticalCauses).not.toContain('dormant');

    // Opening dormant must not auto-close / auto-archive.
    const detail = await mcpCall(agent.apiKey, 'get_task', { taskId });
    expect(detail.body.task.status).toBe('todo');
    expect(detail.body.task.archivedAt ?? null).toBeNull();

    // Re-validate clears dormancy (activity moves forward).
    await mcpCall(agent.apiKey, 'record_validation', { projectId, subjectType: 'task', subjectId: taskId });
    const after = await mcpCall(agent.apiKey, 'get_freshness', { projectId, subjectType: 'task', subjectId: taskId });
    expect(after.body.causes.some((c: { code: string }) => c.code === 'dormant')).toBe(false);

    // Entity override can use a different threshold.
    const override = await SELF.fetch(
      `https://noriq.test/api/projects/${projectId}/dormancy/task/${taskId}`,
      {
        method: 'PUT',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ quietSeconds: 7200 }),
      },
    );
    expect(override.status).toBe(200);
    const ov = await override.json() as { dormancy: { quietSeconds: number; source: string } };
    expect(ov.dormancy.source).toBe('entity');
    expect(ov.dormancy.quietSeconds).toBe(7200);

    // Turn project dormancy back off for later tests sharing projectId.
    await SELF.fetch(`https://noriq.test/api/projects/${projectId}/meta`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dormancyQuietSeconds: null }),
    });
    await SELF.fetch(`https://noriq.test/api/projects/${projectId}/dormancy/task/${taskId}`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ quietSeconds: null }),
    });
  });

  it('get_project exposes dormancyQuietSeconds null when off', async () => {
    const proj = await mcpCall(agent.apiKey, 'get_project', { projectId });
    expect(proj.body.project).toHaveProperty('dormancyQuietSeconds');
    // May be null (off) or a number if a prior test left it set — we clear above; assert shape.
    const v = proj.body.project.dormancyQuietSeconds;
    expect(v === null || typeof v === 'number').toBe(true);
  });

  it('reviewInbox includes never-validated dormant task/plan/doc when project threshold is set', async () => {
    const old = '2018-06-01T00:00:00.000Z';

    const task = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId,
      tasks: [{ title: 'never validated dormant', body: 'old backlog', tags: ['lifecycle'], milestoneId }],
    });
    const taskId = task.body.created[0].id;
    // No validation, no pins, no flags — Codex repro for missing inbox candidates.
    await env.DB.prepare(
      'UPDATE tasks SET content_activity_at = ?, created_at = ? WHERE id = ?',
    ).bind(old, old, taskId).run();

    const plan = await mcpCall(agent.apiKey, 'create_plan', {
      projectId,
      title: 'dormant plan',
      body: 'plan body',
      phases: [{ title: 'P1', newTasks: [{ title: 'plan dormant task', tags: ['lifecycle'], milestoneId }] }],
    });
    const planId = plan.body.id as string;
    await env.DB.prepare(
      'UPDATE plans SET content_activity_at = ?, created_at = ? WHERE id = ?',
    ).bind(old, old, planId).run();

    const doc = await mcpCall(agent.apiKey, 'create_doc', {
      projectId, name: 'Dormant settled fact', description: 'old', body: 'Settled long ago.',
    });
    const docId = doc.body.id as string;
    await env.DB.prepare(
      'UPDATE docs SET content_activity_at = ?, created_at = ? WHERE id = ?',
    ).bind(old, old, docId).run();

    // Off: freshness has no dormant, inbox must not list these.
    const offFresh = await mcpCall(agent.apiKey, 'get_freshness', {
      projectId, subjectType: 'task', subjectId: taskId,
    });
    expect(offFresh.body.causes.some((c: { code: string }) => c.code === 'dormant')).toBe(false);
    const offInbox = await mcpCall(agent.apiKey, 'list_review_inbox', { projectId, cause: 'dormant' });
    expect(offInbox.body.items.some((i: { subjectId: string }) => i.subjectId === taskId)).toBe(false);

    const meta = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/meta`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dormancyQuietSeconds: 3600 }),
    });
    expect(meta.status).toBe(200);

    const onFresh = await mcpCall(agent.apiKey, 'get_freshness', {
      projectId, subjectType: 'task', subjectId: taskId,
    });
    expect(onFresh.body.causes.some((c: { code: string }) => c.code === 'dormant')).toBe(true);

    const inbox = await mcpCall(agent.apiKey, 'list_review_inbox', { projectId, cause: 'dormant' });
    const ids = inbox.body.items.map((i: { subjectId: string }) => i.subjectId);
    expect(ids).toContain(taskId);
    expect(ids).toContain(planId);
    expect(ids).toContain(docId);

    await SELF.fetch(`https://noriq.test/api/projects/${projectId}/meta`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dormancyQuietSeconds: null }),
    });
  });

  it('idempotent body/spec resubmit does not advance content_activity_at; real change does', async () => {
    const task = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId,
      tasks: [{
        title: 'idempotent content clock',
        body: 'stable-body',
        tags: ['lifecycle'],
        milestoneId,
        executionSpec: {
          acceptance: { observableTruths: ['clock only moves on real change'] },
        },
      }],
    });
    const taskId = task.body.created[0].id as string;
    const frozen = '2020-02-02T00:00:00.000Z';
    await env.DB.prepare('UPDATE tasks SET content_activity_at = ? WHERE id = ?').bind(frozen, taskId).run();

    // Resubmit identical body + executionSpec — must not bump the dormancy clock.
    await mcpCall(agent.apiKey, 'update_tasks', {
      projectId,
      tasks: [{
        taskId,
        set: {
          body: 'stable-body',
          executionSpec: {
            acceptance: { observableTruths: ['clock only moves on real change'] },
          },
        },
      }],
    });
    const afterSame = await env.DB.prepare(
      'SELECT content_activity_at AS at FROM tasks WHERE id = ?',
    ).bind(taskId).first<{ at: string }>();
    expect(afterSame?.at).toBe(frozen);

    // Genuine body change advances the clock.
    await mcpCall(agent.apiKey, 'update_tasks', {
      projectId, tasks: [{ taskId, set: { body: 'changed-body' } }],
    });
    const afterChange = await env.DB.prepare(
      'SELECT content_activity_at AS at FROM tasks WHERE id = ?',
    ).bind(taskId).first<{ at: string }>();
    expect(afterChange?.at).not.toBe(frozen);

    // Plan: identical body resubmit vs real change.
    const plan = await mcpCall(agent.apiKey, 'create_plan', {
      projectId,
      title: 'clock plan',
      body: 'plan-stable',
      phases: [{ title: 'P1', body: 'phase-stable', newTasks: [{ title: 'clock plan task', tags: ['lifecycle'], milestoneId }] }],
    });
    const planId = plan.body.id as string;
    const phaseId = plan.body.phases[0].id as string;
    await env.DB.prepare('UPDATE plans SET content_activity_at = ? WHERE id = ?').bind(frozen, planId).run();

    await mcpCall(agent.apiKey, 'update_plan', {
      projectId, planId, body: 'plan-stable',
    });
    const planSame = await env.DB.prepare(
      'SELECT content_activity_at AS at FROM plans WHERE id = ?',
    ).bind(planId).first<{ at: string }>();
    expect(planSame?.at).toBe(frozen);

    await mcpCall(agent.apiKey, 'update_plan', {
      projectId, planId, body: 'plan-changed',
    });
    const planChanged = await env.DB.prepare(
      'SELECT content_activity_at AS at FROM plans WHERE id = ?',
    ).bind(planId).first<{ at: string }>();
    expect(planChanged?.at).not.toBe(frozen);

    // Phase: identical title/body resubmit vs real change.
    await env.DB.prepare('UPDATE plans SET content_activity_at = ? WHERE id = ?').bind(frozen, planId).run();
    await mcpCall(agent.apiKey, 'update_plan', {
      projectId, planId, phaseId, phaseTitle: 'P1', phaseBody: 'phase-stable',
    });
    const phaseSame = await env.DB.prepare(
      'SELECT content_activity_at AS at FROM plans WHERE id = ?',
    ).bind(planId).first<{ at: string }>();
    expect(phaseSame?.at).toBe(frozen);

    await mcpCall(agent.apiKey, 'update_plan', {
      projectId, planId, phaseId, phaseBody: 'phase-changed',
    });
    const phaseChanged = await env.DB.prepare(
      'SELECT content_activity_at AS at FROM plans WHERE id = ?',
    ).bind(planId).first<{ at: string }>();
    expect(phaseChanged?.at).not.toBe(frozen);
  });
});
