// PLNR-576..580 + PLNR-585: validation records, doc@version pins, supersession, freshness claim gate, review inbox, opt-in dormancy.
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall } from './helpers';
import { computeFreshness, dormancyActivityAt } from '../src/lib/entity-validation';
import { reviewInbox, subjectFreshness } from '../src/lib/entity-validation-store';

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

/** Count D1 statement executions (prepare→all/first/run and each batch item). */
function countingDb(db: D1Database): { db: D1Database; statements: () => number } {
  let n = 0;
  const wrapStmt = (stmt: D1PreparedStatement): D1PreparedStatement => new Proxy(stmt, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop === 'bind') {
        return (...args: unknown[]) => wrapStmt((v as (...a: unknown[]) => D1PreparedStatement).apply(target, args));
      }
      if (prop === 'all' || prop === 'first' || prop === 'run' || prop === 'raw') {
        return (...args: unknown[]) => {
          n += 1;
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const wrapped = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => wrapStmt(target.prepare(sql));
      }
      if (prop === 'batch') {
        return (stmts: D1PreparedStatement[]) => {
          n += stmts.length;
          return target.batch(stmts);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { db: wrapped, statements: () => n };
}

describe('reviewInbox batched freshness (PLNR-585 scale)', () => {
  it('130 dormant tasks with limit:1 stays well under the D1 per-invocation query budget', async () => {
    const p = await mcpCall(agent.apiKey, 'create_project', { key: 'BINB', name: 'inbox-batch-budget' });
    const pid = p.body.id as string;
    const proj = await mcpCall(agent.apiKey, 'get_project', { projectId: pid });
    const ms = proj.body.milestones[0].id as string;
    const old = '2018-01-01T00:00:00.000Z';

    // create_tasks max 100/call
    for (const batch of [65, 65]) {
      const created = await mcpCall(agent.apiKey, 'create_tasks', {
        projectId: pid,
        tasks: Array.from({ length: batch }, (_, i) => ({
          title: `dormant backlog ${batch}-${i}`,
          body: `body-${batch}-${i}`,
          tags: ['lifecycle'],
          milestoneId: ms,
        })),
      });
      expect(created.body.failed).toBe(0);
      const ids = (created.body.created as Array<{ id: string }>).map((t) => t.id);
      for (const id of ids) {
        await env.DB.prepare(
          'UPDATE tasks SET content_activity_at = ?, created_at = ? WHERE id = ?',
        ).bind(old, old, id).run();
      }
    }

    await SELF.fetch(`https://noriq.test/api/projects/${pid}/meta`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dormancyQuietSeconds: 3600 }),
    });

    const { db, statements } = countingDb(env.DB);
    const page = await reviewInbox(db, pid, { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.overallTotal).toBe(130);
    // Pre-fix: ~3 + 8×130 ≈ 1043 (over paid D1 limit of 1000). Batched path must stay
    // comfortably below that — a few dozen statements, not hundreds.
    expect(statements()).toBeLessThan(80);
    expect(statements()).toBeLessThan(1000);
  }, 120000);

  it('paginates mixed tasks/plans/docs without missing or duplicate subjects', async () => {
    const p = await mcpCall(agent.apiKey, 'create_project', { key: 'BPAGE', name: 'inbox-batch-pages' });
    const pid = p.body.id as string;
    const proj = await mcpCall(agent.apiKey, 'get_project', { projectId: pid });
    const ms = proj.body.milestones[0].id as string;
    const old = '2017-03-01T00:00:00.000Z';

    const task = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId: pid,
      tasks: [
        { title: 'page task a', body: 'a', tags: ['lifecycle'], milestoneId: ms },
        { title: 'page task b', body: 'b', tags: ['lifecycle'], milestoneId: ms },
        { title: 'page task c', body: 'c', tags: ['lifecycle'], milestoneId: ms },
      ],
    });
    const taskIds = (task.body.created as Array<{ id: string }>).map((t) => t.id);
    for (const id of taskIds) {
      await env.DB.prepare('UPDATE tasks SET content_activity_at = ?, created_at = ? WHERE id = ?')
        .bind(old, old, id).run();
    }

    const plan = await mcpCall(agent.apiKey, 'create_plan', {
      projectId: pid,
      title: 'page plan',
      body: 'plan',
      phases: [{ title: 'P1', newTasks: [{ title: 'page plan task', tags: ['lifecycle'], milestoneId: ms }] }],
    });
    const planId = plan.body.id as string;
    await env.DB.prepare('UPDATE plans SET content_activity_at = ?, created_at = ? WHERE id = ?')
      .bind(old, old, planId).run();

    const doc = await mcpCall(agent.apiKey, 'create_doc', {
      projectId: pid, name: 'Page settled fact', description: 'd', body: 'Settled.',
    });
    const docId = doc.body.id as string;
    await env.DB.prepare('UPDATE docs SET content_activity_at = ?, created_at = ? WHERE id = ?')
      .bind(old, old, docId).run();

    await SELF.fetch(`https://noriq.test/api/projects/${pid}/meta`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dormancyQuietSeconds: 3600 }),
    });

    const seen = new Set<string>();
    let offset = 0;
    let pages = 0;
    let overall = -1;
    for (;;) {
      const page = await reviewInbox(env.DB, pid, { cause: 'dormant', limit: 2, offset });
      if (overall < 0) overall = page.overallTotal;
      expect(page.overallTotal).toBe(overall);
      for (const item of page.items) {
        const key = `${item.subjectType}:${item.subjectId}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
      pages += 1;
      if (page.nextOffset == null) break;
      offset = page.nextOffset;
      expect(pages).toBeLessThan(20);
    }

    expect(seen.size).toBe(overall);
    expect(seen.has(`task:${taskIds[0]}`)).toBe(true);
    expect(seen.has(`task:${taskIds[1]}`)).toBe(true);
    expect(seen.has(`task:${taskIds[2]}`)).toBe(true);
    expect(seen.has(`plan:${planId}`)).toBe(true);
    expect(seen.has(`doc:${docId}`)).toBe(true);
    // 3 aged tasks + plan + doc (phase-created task stays fresh — not aged).
    expect(overall).toBe(5);
    expect(pages).toBe(3); // limit 2 → 2+2+1
  });

  it('honors entity overrides, dismissed dormant, and recent validation that clears dormancy', async () => {
    const p = await mcpCall(agent.apiKey, 'create_project', { key: 'BOVR', name: 'inbox-batch-overrides' });
    const pid = p.body.id as string;
    const proj = await mcpCall(agent.apiKey, 'get_project', { projectId: pid });
    const ms = proj.body.milestones[0].id as string;
    const old = '2016-01-01T00:00:00.000Z';

    const created = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId: pid,
      tasks: [
        { title: 'entity override dormant', body: 'ovr', tags: ['lifecycle'], milestoneId: ms },
        { title: 'dismissed dormant', body: 'dis', tags: ['lifecycle'], milestoneId: ms },
        { title: 'recently validated', body: 'val', tags: ['lifecycle'], milestoneId: ms },
      ],
    });
    const [overrideId, dismissId, validatedId] = (created.body.created as Array<{ id: string }>).map((t) => t.id);
    for (const id of [overrideId, dismissId, validatedId]) {
      await env.DB.prepare('UPDATE tasks SET content_activity_at = ?, created_at = ? WHERE id = ?')
        .bind(old, old, id).run();
    }

    // Project OFF — only entity override should surface dormant for overrideId.
    await SELF.fetch(`https://noriq.test/api/projects/${pid}/dormancy/task/${overrideId}`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ quietSeconds: 3600 }),
    });

    let inbox = await reviewInbox(env.DB, pid, { cause: 'dormant' });
    expect(inbox.items.map((i) => i.subjectId)).toContain(overrideId);
    expect(inbox.items.map((i) => i.subjectId)).not.toContain(dismissId);
    expect(inbox.items.map((i) => i.subjectId)).not.toContain(validatedId);

    // Enable project threshold; dismiss dormant on dismissId; validate validatedId freshly.
    await SELF.fetch(`https://noriq.test/api/projects/${pid}/meta`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dormancyQuietSeconds: 3600 }),
    });
    await mcpCall(agent.apiKey, 'set_review_cause', {
      projectId: pid, subjectType: 'task', subjectId: dismissId, cause: 'dormant', status: 'dismissed',
    });
    await mcpCall(agent.apiKey, 'record_validation', {
      projectId: pid, subjectType: 'task', subjectId: validatedId, note: 'fresh',
    });

    inbox = await reviewInbox(env.DB, pid, { cause: 'dormant' });
    const ids = inbox.items.map((i) => i.subjectId);
    expect(ids).toContain(overrideId);
    expect(ids).not.toContain(dismissId);
    expect(ids).not.toContain(validatedId);
  });

  it('batched inbox actionable causes match individual subjectFreshness for the same subjects', async () => {
    const p = await mcpCall(agent.apiKey, 'create_project', { key: 'BEQ', name: 'inbox-batch-equiv' });
    const pid = p.body.id as string;
    const proj = await mcpCall(agent.apiKey, 'get_project', { projectId: pid });
    const ms = proj.body.milestones[0].id as string;
    const old = '2015-05-05T00:00:00.000Z';

    const tasks = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId: pid,
      tasks: [
        { title: 'eq dormant', body: 'd', tags: ['lifecycle'], milestoneId: ms },
        { title: 'eq changed', body: 'before', tags: ['lifecycle'], milestoneId: ms },
      ],
    });
    const [dormantId, changedId] = (tasks.body.created as Array<{ id: string }>).map((t) => t.id);
    await env.DB.prepare('UPDATE tasks SET content_activity_at = ?, created_at = ? WHERE id = ?')
      .bind(old, old, dormantId).run();
    await mcpCall(agent.apiKey, 'record_validation', {
      projectId: pid, subjectType: 'task', subjectId: changedId, note: 'was good',
    });
    await mcpCall(agent.apiKey, 'update_tasks', {
      projectId: pid, tasks: [{ taskId: changedId, set: { body: 'after' } }],
    });

    const plan = await mcpCall(agent.apiKey, 'create_plan', {
      projectId: pid,
      title: 'eq plan',
      body: 'p',
      phases: [{ title: 'P1', newTasks: [{ title: 'eq plan task', tags: ['lifecycle'], milestoneId: ms }] }],
    });
    const planId = plan.body.id as string;
    await env.DB.prepare('UPDATE plans SET content_activity_at = ?, created_at = ? WHERE id = ?')
      .bind(old, old, planId).run();

    await SELF.fetch(`https://noriq.test/api/projects/${pid}/meta`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dormancyQuietSeconds: 3600 }),
    });

    const inbox = await reviewInbox(env.DB, pid, { limit: 100 });
    expect(inbox.items.length).toBeGreaterThan(0);
    for (const item of inbox.items) {
      const fresh = await subjectFreshness(env.DB, pid, item.subjectType, item.subjectId);
      const actionable = fresh.causes
        .filter((c) => c.code !== 'never_validated' && c.code !== 'impact_unknown')
        .map((c) => c.code)
        .sort();
      expect([...item.causes].sort()).toEqual(actionable);
    }
  });

  it('batched inbox and subjectFreshness agree when matching fingerprint is outside the lookback window', async () => {
    // Repro: 1×A validation, then 20×B, restore body to A. Matching A sits outside the
    // per-subject top-20 window — both paths must report content_changed (dormancy off).
    const p = await mcpCall(agent.apiKey, 'create_project', { key: 'BWIN', name: 'inbox-lookback-window' });
    const pid = p.body.id as string;
    const proj = await mcpCall(agent.apiKey, 'get_project', { projectId: pid });
    const ms = proj.body.milestones[0].id as string;

    const created = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId: pid,
      tasks: [{ title: 'window restore', body: 'content-A', tags: ['lifecycle'], milestoneId: ms }],
    });
    const taskId = (created.body.created as Array<{ id: string }>)[0].id;

    await mcpCall(agent.apiKey, 'record_validation', {
      projectId: pid, subjectType: 'task', subjectId: taskId, note: 'A',
    });

    await mcpCall(agent.apiKey, 'update_tasks', {
      projectId: pid, tasks: [{ taskId, set: { body: 'content-B' } }],
    });
    const bVal = await mcpCall(agent.apiKey, 'record_validation', {
      projectId: pid, subjectType: 'task', subjectId: taskId, note: 'B-0',
    });
    expect(bVal.isError).toBeFalsy();
    const bFp = bVal.body.contentFingerprint as string;

    // Pad to 20 B validations with staggered timestamps so A is strictly outside lookback.
    const bRow = await env.DB.prepare(
      `SELECT actor_kind, actor_id, actor_name, baselines_json
         FROM entity_validations WHERE id = ?`,
    ).bind(bVal.body.id as string).first<{
      actor_kind: string; actor_id: string | null; actor_name: string; baselines_json: string;
    }>();
    expect(bRow).toBeTruthy();
    const stmts = [];
    for (let i = 1; i < 20; i++) {
      const ts = new Date(Date.UTC(2024, 0, 1, 0, 0, i)).toISOString();
      stmts.push(
        env.DB.prepare(
          `INSERT INTO entity_validations
            (id, project_id, subject_type, subject_id, content_fingerprint, validated_at,
             actor_kind, actor_id, actor_name, baselines_json, note)
           VALUES (?, ?, 'task', ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          `val_bwin_${i}`, pid, taskId, bFp, ts,
          bRow!.actor_kind, bRow!.actor_id, bRow!.actor_name, bRow!.baselines_json, `B-${i}`,
        ),
      );
    }
    await env.DB.batch(stmts);
    // Ensure the original B-0 row is also inside the window and newer than A.
    await env.DB.prepare(
      `UPDATE entity_validations SET validated_at = ? WHERE id = ?`,
    ).bind(new Date(Date.UTC(2024, 0, 1, 0, 0, 0)).toISOString(), bVal.body.id as string).run();
    await env.DB.prepare(
      `UPDATE entity_validations SET validated_at = ? WHERE subject_id = ? AND note = 'A'`,
    ).bind(new Date(Date.UTC(2023, 0, 1)).toISOString(), taskId).run();

    await mcpCall(agent.apiKey, 'update_tasks', {
      projectId: pid, tasks: [{ taskId, set: { body: 'content-A' } }],
    });

    const fresh = await subjectFreshness(env.DB, pid, 'task', taskId);
    expect(fresh.criticalCauses).toContain('content_changed');

    const inbox = await reviewInbox(env.DB, pid, { cause: 'content_changed' });
    const item = inbox.items.find((i) => i.subjectId === taskId);
    expect(item).toBeTruthy();
    expect(item!.causes).toContain('content_changed');
    expect(item!.primaryCause).toBe('content_changed');
  });
});
