import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { RunnerJobAssignment, RunnerJobEvent, RunnerJobSource } from '@noriq-dev/shared';
import type { Actor, CreateRunnerJobInput, RunnerJobView } from '../src/do/ProjectRoom';
import { createAgent, createUser, loginSession, projectRoom, SYSTEM_ACTOR } from './helpers';

interface RoomRpc {
  createTask(projectId: string, actor: Actor, input: { title: string }): Promise<{ id: string; key: string }>;
  createRunnerJob(projectId: string, actor: Actor, input: CreateRunnerJobInput): Promise<RunnerJobView>;
  assignRunnerJob(projectId: string, jobId: string, runnerId: string): Promise<{ assignmentId: string } | null>;
  acceptRunnerJob(projectId: string, jobId: string, runnerId: string, assignmentId: string): Promise<boolean>;
  recordRunnerJobEvent(projectId: string, jobId: string, runnerId: string, assignmentId: string, seq: number, event: unknown): Promise<{ accepted: boolean; ack: number; error: string | null }>;
  requestRunnerJobLanding(projectId: string, actor: Actor, jobId: string): Promise<{
    runnerId: string; assignmentId: string; requestId: string | null; target: string | null; terminal: boolean;
  }>;
  answerRunnerJobQuestion(projectId: string, actor: Actor, jobId: string, questionId: string, answer: string): Promise<{
    runnerId: string; assignmentId: string; answer: string;
  }>;
  recordRunnerJobLandingResult(
    projectId: string, jobId: string, runnerId: string, assignmentId: string, requestId: string,
    result: { status: 'landed' | 'failed'; target: string; checkpoint: { ref: string; label: string; url: string | null } | null; error: string | null },
  ): Promise<{ accepted: boolean; error: string | null }>;
  cancelRunnerJob(projectId: string, actor: Actor, jobId: string): Promise<{ terminal: boolean }>;
}

let pid: string;
let room: RoomRpc;
let cookie: string;
const runnerId = `rnr_job_${crypto.randomUUID()}`;
const revision = 'a'.repeat(40);
let claimAgentId: string;

beforeAll(async () => {
  await createUser('runner-jobs@example.com', 'Runner Jobs', 'longenough1', 'member').catch(() => {});
  cookie = await loginSession('runner-jobs@example.com', 'longenough1');
  const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind('runner-jobs@example.com').first<{ id: string }>();
  const response = await SELF.fetch('https://noriq.test/api/projects', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: `RJ${crypto.randomUUID().slice(0, 6).toUpperCase()}`, name: 'runner jobs' }),
  });
  const projectBody = (await response.json()) as { id?: string; error?: string };
  if (!response.ok || !projectBody.id) throw new Error(`project fixture failed: ${response.status} ${JSON.stringify(projectBody)}`);
  pid = projectBody.id;
  await env.DB.prepare(
    "INSERT INTO runners (id, owner_user_id, label, status, repos) VALUES (?, ?, 'job-runner', 'online', '[]')",
  ).bind(runnerId, user!.id).run();
  claimAgentId = (await createAgent('runner-job-retry-claim')).id;
  room = projectRoom<RoomRpc>(pid);
}, 60_000);

describe('RunnerJob commissioning (PLNR-498)', () => {
  it('accepts opaque non-Git revisions and checkpoints (PLNR-504)', async () => {
    const response = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: `VN${crypto.randomUUID().slice(0, 6).toUpperCase()}`, name: 'VCS-neutral runner job' }),
    });
    const projectId = ((await response.json()) as { id: string }).id;
    const isolatedRoom = projectRoom<RoomRpc>(projectId);
    const task = await isolatedRoom.createTask(projectId, SYSTEM_ACTOR as Actor, { title: 'Perforce checkpoint' });
    const baseRevision = '//depot/noriq/main@184205';
    const job = await isolatedRoom.createRunnerJob(projectId, SYSTEM_ACTOR as Actor, {
      source: { kind: 'task', id: task.id }, runnerId, repoRef: 'perforce-workspace', expectedBaseRevision: baseRevision,
    });
    expect(RunnerJobAssignment.parse(job.assignment).expectedBaseRevision).toBe(baseRevision);

    expect(await isolatedRoom.assignRunnerJob(projectId, job.id, runnerId)).toMatchObject({ assignmentId: job.assignmentId });
    expect(await isolatedRoom.acceptRunnerJob(projectId, job.id, runnerId, job.assignmentId)).toBe(true);
    const checkpoint = { ref: 'shelf:184206', label: 'shelf 184206', url: null };
    expect(await isolatedRoom.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 1, {
      type: 'task.result', at: new Date().toISOString(), taskId: task.id, status: 'accepted',
      checkpoint, summary: 'shelved', findings: [],
    })).toMatchObject({ accepted: true, ack: 1 });
    expect(await env.DB.prepare('SELECT checkpoint_ref AS checkpointRef FROM runner_job_items WHERE job_id = ?')
      .bind(job.id).first()).toEqual({ checkpointRef: checkpoint.ref });
  });

  it('hard-cuts legacy write endpoints while retaining historical reads (PLNR-502)', async () => {
    const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
    for (const [path, body] of [
      [`/api/projects/${pid}/runs`, {}],
      [`/api/projects/${pid}/plans/legacy-plan/dispatch`, {}],
      ['/api/plan-dispatches/legacy-dispatch/retry', {}],
      ['/api/runs/legacy-run/cancel', {}],
    ] as const) {
      const response = await SELF.fetch(`https://noriq.test${path}`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      expect(response.status, path).toBe(410);
      expect(await response.json()).toMatchObject({ code: 'runner_job_cutover' });
    }
    expect((await SELF.fetch(`https://noriq.test/api/projects/${pid}/runs`, { headers })).status).toBe(200);
    expect((await SELF.fetch(`https://noriq.test/api/projects/${pid}/plan-dispatches`, { headers })).status).toBe(200);
  });

  it('searches task and plan dispatch targets without loading them into the Runs snapshot', async () => {
    const marker = crypto.randomUUID().slice(0, 8);
    const task = await room.createTask(pid, SYSTEM_ACTOR as Actor, { title: `Searchable dispatch task ${marker}` });
    const planId = `pln_${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO plans (id, project_id, title, description, status) VALUES (?, ?, ?, 'search target', 'active')",
    ).bind(planId, pid, `Searchable dispatch plan ${marker}`).run();

    const taskResponse = await SELF.fetch(
      `https://noriq.test/api/tasks/search?projectId=${pid}&status=todo&text=${encodeURIComponent(task.key)}&limit=25`,
      { headers: { Cookie: cookie } },
    );
    expect(taskResponse.status).toBe(200);
    expect(await taskResponse.json()).toMatchObject({
      matched: 1,
      returned: 1,
      tasks: [{ id: task.id, key: task.key, status: 'todo' }],
    });

    const planResponse = await SELF.fetch(
      `https://noriq.test/api/plans/search?projectId=${pid}&status=active&text=${marker}&limit=25`,
      { headers: { Cookie: cookie } },
    );
    expect(planResponse.status).toBe(200);
    expect(await planResponse.json()).toMatchObject({
      matched: 1,
      returned: 1,
      plans: [{ id: planId, title: `Searchable dispatch plan ${marker}`, status: 'active' }],
    });
  });

  it('creates a bounded immutable snapshot, one root, and a live reservation atomically', async () => {
    const response = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: `RV${crypto.randomUUID().slice(0, 6).toUpperCase()}`, name: 'reservation isolation' }),
    });
    const projectId = ((await response.json()) as { id: string }).id;
    const isolatedRoom = projectRoom<RoomRpc>(projectId);
    const task = await isolatedRoom.createTask(projectId, SYSTEM_ACTOR as Actor, { title: 'Reserved task' });
    const job = await isolatedRoom.createRunnerJob(projectId, SYSTEM_ACTOR as Actor, {
      source: { kind: 'task', id: task.id }, runnerId, repoRef: 'repo', expectedBaseRevision: revision,
    });
    expect(RunnerJobSource.parse(job.source)).toMatchObject({ kind: 'task', task: { taskId: task.id, retry: false } });
    expect(RunnerJobAssignment.parse(job.assignment)).toMatchObject({ jobId: job.id, assignmentId: job.assignmentId });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM runner_job_items WHERE job_id = ? AND reservation_active = 1')
      .bind(job.id).first<{ n: number }>()).toEqual({ n: 1 });
    const orchestration = await env.DB.prepare(
      `SELECT o.root_execution_id AS rootId, COUNT(n.id) AS nodes
         FROM orchestrations o LEFT JOIN execution_nodes n ON n.orchestration_id = o.id
        WHERE o.id = ? GROUP BY o.id`,
    ).bind(job.orchestrationId).first<{ rootId: string; nodes: number }>();
    expect(orchestration).toMatchObject({ rootId: expect.any(String), nodes: 1 });
    const detail = await SELF.fetch(
      `https://noriq.test/api/projects/${projectId}/runner-jobs/${job.id}`,
      { headers: { Cookie: cookie } },
    );
    const detailBody = await detail.json() as { job: Record<string, unknown> };
    expect(detailBody.job.lineage).toEqual({
      orchestrationId: job.orchestrationId, nodeCount: 1, relationCount: 0, incompleteNodeCount: 0,
    });
    expect(detailBody).not.toHaveProperty('events');
    expect(detailBody.job).not.toHaveProperty('lineageNodeCount');

    const failedAt = new Date().toISOString();
    await env.DB.prepare("UPDATE tasks SET status = 'in_progress', failed_at = ? WHERE id = ?")
      .bind(failedAt, task.id).run();
    await expect(isolatedRoom.createRunnerJob(projectId, SYSTEM_ACTOR as Actor, {
      source: { kind: 'task', id: task.id }, runnerId, repoRef: 'repo', expectedBaseRevision: revision,
    })).rejects.toThrow(/reserved by another live RunnerJob/);
    expect(await env.DB.prepare('SELECT status, failed_at AS failedAt FROM tasks WHERE id = ?')
      .bind(task.id).first()).toEqual({ status: 'in_progress', failedAt });
    await expect(env.DB.prepare('UPDATE runner_jobs SET snapshot = ? WHERE id = ?')
      .bind('{}', job.id).run()).rejects.toThrow(/immutable/);
  });

  it('commissions an explicit failed retry as a fresh job without changing terminal history', async () => {
    const task = await room.createTask(pid, SYSTEM_ACTOR as Actor, { title: 'Retry failed task' });
    const prior = await room.createRunnerJob(pid, SYSTEM_ACTOR as Actor, {
      source: { kind: 'task', id: task.id }, runnerId, repoRef: 'repo', expectedBaseRevision: revision,
    });
    await room.cancelRunnerJob(pid, SYSTEM_ACTOR as Actor, prior.id);
    const historical = await env.DB.prepare(
      `SELECT snapshot, assignment_id AS assignmentId, status, updated_at AS updatedAt
         FROM runner_jobs WHERE id = ?`,
    ).bind(prior.id).first();
    const failedAt = new Date().toISOString();
    await env.DB.prepare(
      "UPDATE tasks SET status = 'in_progress', failed_at = ?, claimed_by = NULL, claim_expires_at = NULL WHERE id = ?",
    ).bind(failedAt, task.id).run();

    const retry = await room.createRunnerJob(pid, SYSTEM_ACTOR as Actor, {
      source: { kind: 'task', id: task.id }, runnerId, repoRef: 'repo', expectedBaseRevision: revision,
    });

    expect(retry.id).not.toBe(prior.id);
    expect(retry.assignmentId).not.toBe(prior.assignmentId);
    expect(RunnerJobSource.parse(retry.source)).toMatchObject({
      kind: 'task', task: { taskId: task.id, status: 'failed', retry: true },
    });
    expect(await env.DB.prepare(
      `SELECT snapshot, assignment_id AS assignmentId, status, updated_at AS updatedAt
         FROM runner_jobs WHERE id = ?`,
    ).bind(prior.id).first()).toEqual(historical);
    expect(await env.DB.prepare('SELECT status, failed_at AS failedAt FROM tasks WHERE id = ?')
      .bind(task.id).first()).toEqual({ status: 'todo', failedAt });
  });

  it('includes todo and failed items together in a plan retry snapshot', async () => {
    const response = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: `RR${crypto.randomUUID().slice(0, 6).toUpperCase()}`, name: 'plan retry runner job' }),
    });
    const projectId = ((await response.json()) as { id: string }).id;
    const isolatedRoom = projectRoom<RoomRpc>(projectId);
    const todo = await isolatedRoom.createTask(projectId, SYSTEM_ACTOR as Actor, { title: 'Todo item' });
    const failed = await isolatedRoom.createTask(projectId, SYSTEM_ACTOR as Actor, { title: 'Failed item' });
    const failedAt = new Date().toISOString();
    await env.DB.prepare("UPDATE tasks SET status = 'in_progress', failed_at = ? WHERE id = ?")
      .bind(failedAt, failed.id).run();
    const planId = `pln_${crypto.randomUUID()}`;
    const phaseId = `phs_${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO plans (id, project_id, title, status) VALUES (?, ?, 'Retry plan', 'active')").bind(planId, projectId),
      env.DB.prepare("INSERT INTO phases (id, plan_id, title, \"order\") VALUES (?, ?, 'One', 0)").bind(phaseId, planId),
      env.DB.prepare('INSERT INTO phase_tasks (phase_id, task_id) VALUES (?, ?)').bind(phaseId, todo.id),
      env.DB.prepare('INSERT INTO phase_tasks (phase_id, task_id) VALUES (?, ?)').bind(phaseId, failed.id),
    ]);

    const job = await isolatedRoom.createRunnerJob(projectId, SYSTEM_ACTOR as Actor, {
      source: { kind: 'plan', id: planId }, runnerId, repoRef: 'repo', expectedBaseRevision: revision,
    });
    const source = RunnerJobSource.parse(job.source);
    expect(source.kind).toBe('plan');
    if (source.kind !== 'plan') throw new Error('expected a plan source');
    expect(source.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: todo.id, status: 'todo', retry: false }),
      expect.objectContaining({ taskId: failed.id, status: 'failed', retry: true }),
    ]));
    expect(await env.DB.prepare('SELECT status, failed_at AS failedAt FROM tasks WHERE id = ?')
      .bind(failed.id).first()).toEqual({ status: 'todo', failedAt });
  });

  it('rejects a failed retry with a live claim', async () => {
    const response = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: `RC${crypto.randomUUID().slice(0, 6).toUpperCase()}`, name: 'claimed retry isolation' }),
    });
    const projectId = ((await response.json()) as { id: string }).id;
    const isolatedRoom = projectRoom<RoomRpc>(projectId);
    const task = await isolatedRoom.createTask(projectId, SYSTEM_ACTOR as Actor, { title: 'Claimed failed retry' });
    const failedAt = new Date().toISOString();
    await env.DB.prepare("UPDATE tasks SET status = 'in_progress', failed_at = ? WHERE id = ?")
      .bind(failedAt, task.id).run();
    const acquiredAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await env.DB.prepare(
      'INSERT INTO claims (id, task_id, agent_id, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(`clm_${crypto.randomUUID()}`, task.id, claimAgentId, acquiredAt, expiresAt).run();

    await expect(isolatedRoom.createRunnerJob(projectId, SYSTEM_ACTOR as Actor, {
      source: { kind: 'task', id: task.id }, runnerId, repoRef: 'repo', expectedBaseRevision: revision,
    })).rejects.toThrow(new RegExp(`live claims: ${task.key}`));
    expect(await env.DB.prepare('SELECT status, failed_at AS failedAt FROM tasks WHERE id = ?')
      .bind(task.id).first()).toEqual({ status: 'in_progress', failedAt });
  });

  it.each(['blocked', 'review', 'done', 'cancelled'])('does not retry a %s task even with stale failure metadata', async (status) => {
    const response = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: `RI${crypto.randomUUID().slice(0, 6).toUpperCase()}`, name: `${status} retry isolation` }),
    });
    const projectId = ((await response.json()) as { id: string }).id;
    const isolatedRoom = projectRoom<RoomRpc>(projectId);
    const task = await isolatedRoom.createTask(projectId, SYSTEM_ACTOR as Actor, { title: `Ineligible ${status} retry` });
    await env.DB.prepare('UPDATE tasks SET status = ?, failed_at = ? WHERE id = ?')
      .bind(status, new Date().toISOString(), task.id).run();

    await expect(isolatedRoom.createRunnerJob(projectId, SYSTEM_ACTOR as Actor, {
      source: { kind: 'task', id: task.id }, runnerId, repoRef: 'repo', expectedBaseRevision: revision,
    })).rejects.toThrow(new RegExp(`is ${status}`));
  });

  it('refuses unsettled plan tasks instead of silently selecting around them', async () => {
    const response = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: `RU${crypto.randomUUID().slice(0, 6).toUpperCase()}`, name: 'unsettled runner job' }),
    });
    const isolatedPid = ((await response.json()) as { id: string }).id;
    const isolatedRoom = projectRoom<RoomRpc>(isolatedPid);
    const task = await isolatedRoom.createTask(isolatedPid, SYSTEM_ACTOR as Actor, { title: 'Already running' });
    await env.DB.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").bind(task.id).run();
    const planId = `pln_${crypto.randomUUID()}`;
    const phaseId = `phs_${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO plans (id, project_id, title, status) VALUES (?, ?, 'Unsettled', 'active')").bind(planId, isolatedPid),
      env.DB.prepare("INSERT INTO phases (id, plan_id, title, \"order\") VALUES (?, ?, 'One', 0)").bind(phaseId, planId),
      env.DB.prepare('INSERT INTO phase_tasks (phase_id, task_id) VALUES (?, ?)').bind(phaseId, task.id),
    ]);
    await expect(isolatedRoom.createRunnerJob(isolatedPid, SYSTEM_ACTOR as Actor, {
      source: { kind: 'plan', id: planId }, runnerId, repoRef: 'repo', expectedBaseRevision: revision,
    })).rejects.toThrow(/unsettled tasks/);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM runner_jobs WHERE source_id = ?')
      .bind(planId).first<{ n: number }>()).toEqual({ n: 0 });
  });

  it('shared schemas reject unbounded and unknown wire fields', () => {
    expect(() => RunnerJobSource.parse({
      kind: 'task', projectId: 'p', projectKey: 'P', surprise: true,
      task: { taskId: 't', key: 'P-1', title: 't', body: '', executionSpec: null, status: 'todo', retry: false, order: 0, phaseOrder: 0 },
    })).toThrow();
    expect(() => RunnerJobSource.parse({
      kind: 'plan', projectId: 'p', projectKey: 'P', planId: 'x', planKey: 'x', planTitle: 'x',
      tasks: Array.from({ length: 501 }, (_, index) => ({ taskId: `t${index}`, key: `P-${index}`, title: 't', body: '', executionSpec: null, status: 'todo', retry: false, order: index, phaseOrder: 0 })), dependencies: [],
    })).toThrow();
    expect(() => RunnerJobEvent.parse({
      type: 'stage.finished', at: new Date().toISOString(), startedAt: new Date().toISOString(),
      observationId: 'obs_bad_unknown', taskId: null, stage: 'build', attempt: 1,
      actor: { kind: 'agent', driver: 'codex', vendor: 'openai', model: null, effort: null, role: 'build', operation: 'invoke' },
      outcome: 'succeeded', duration: { status: 'complete', value: 1, provenance: 'runner_reported' }, recovery: 'none',
      usage: {
        inputTokens: { status: 'unavailable', value: 0, provenance: 'not_reported' },
        outputTokens: { status: 'unavailable', value: null, provenance: 'not_reported' },
        cacheReadTokens: { status: 'unavailable', value: null, provenance: 'not_reported' },
        cacheWriteTokens: { status: 'unavailable', value: null, provenance: 'not_reported' },
        calls: { status: 'complete', value: 1, provenance: 'driver_reported' },
        costUsd: { status: 'unavailable', value: null, provenance: 'not_reported' },
      },
      evidence: {
        operationDigest: null, resultDigest: null, exitCode: null, timedOut: null,
        changedPathCount: null, blockerFindings: null, majorFindings: null,
        minorFindings: null, checkpointRef: null, errorCode: null,
      },
    })).toThrow();
  });

  it('accepts additive routing, pricing-basis, and task-scoped progress contracts', () => {
    const at = new Date().toISOString();
    const actor = {
      kind: 'agent' as const, driver: 'codex', vendor: 'openai', model: 'gpt-5.6-codex',
      effort: 'high', role: 'build', operation: 'invoke',
    };
    expect(RunnerJobEvent.parse({
      type: 'agent.route', at,
      route: {
        taskId: 'task_1', role: 'build', attempt: 1, policyVersion: 'adaptive-v1',
        size: 'medium', risk: 'high', specCoverage: 'complete',
        reasons: ['risk.high', 'spec.complete'], candidateCount: 3, eligibleCount: 2,
        actor, decision: 'invoke',
      },
    })).toMatchObject({ type: 'agent.route', route: { decision: 'invoke', actor } });
    expect(RunnerJobEvent.parse({
      type: 'progress', at, taskId: 'task_1', phase: 'building', message: 'building', progress: 0.5,
    })).toMatchObject({ taskId: 'task_1' });
    expect(RunnerJobEvent.parse({
      type: 'progress', at, phase: 'building', message: 'job progress', progress: 0.5,
    })).not.toHaveProperty('taskId');

    const usage = {
      inputTokens: { status: 'complete' as const, value: 100, provenance: 'driver_reported' as const },
      outputTokens: { status: 'complete' as const, value: 25, provenance: 'driver_reported' as const },
      cacheReadTokens: { status: 'unavailable' as const, value: null, provenance: 'not_reported' as const },
      cacheWriteTokens: { status: 'unavailable' as const, value: null, provenance: 'not_reported' as const },
      calls: { status: 'complete' as const, value: 1, provenance: 'driver_reported' as const },
      costUsd: { status: 'partial' as const, value: 0.0125, provenance: 'derived' as const },
    };
    const event = {
      type: 'stage.finished' as const, at, startedAt: at, observationId: 'obs_1', taskId: 'task_1',
      stage: 'build' as const, attempt: 1, actor, outcome: 'succeeded' as const,
      duration: { status: 'complete' as const, value: 250, provenance: 'runner_reported' as const },
      usage, costBasis: {
        kind: 'api_list_estimate' as const,
        priceSource: { provider: 'openai', catalog: 'official-api-list', fetchedAt: at, ageSeconds: 30, stale: false },
      },
      recovery: 'none' as const,
      evidence: {
        operationDigest: null, resultDigest: null, exitCode: null, timedOut: null,
        changedPathCount: null, blockerFindings: null, majorFindings: null,
        minorFindings: null, checkpointRef: null, errorCode: null,
      },
    };
    expect(RunnerJobEvent.parse(event)).toMatchObject({ costBasis: { kind: 'api_list_estimate' } });
    expect(() => RunnerJobEvent.parse({
      ...event,
      usage: { ...usage, costUsd: { status: 'complete', value: 0.0125, provenance: 'driver_reported' } },
    })).toThrow(/requires derived provenance/);
  });

  it('rejects unsafe or inconsistent adaptive route facts', () => {
    const at = new Date().toISOString();
    const base = {
      type: 'agent.route' as const, at,
      route: {
        taskId: 'task_1', role: 'build', attempt: 1, policyVersion: 'adaptive-v1',
        size: 'small' as const, risk: 'low' as const, specCoverage: 'partial' as const,
        reasons: ['spec.partial'], candidateCount: 1, eligibleCount: 1,
        actor: null, decision: 'skip' as const,
      },
    };
    expect(RunnerJobEvent.parse(base)).toMatchObject({ route: { decision: 'skip' } });
    expect(() => RunnerJobEvent.parse({
      ...base, route: { ...base.route, decision: 'invoke', actor: null },
    })).toThrow(/require an actor/);
    expect(() => RunnerJobEvent.parse({
      ...base, route: { ...base.route, reasons: ['contains task text'] },
    })).toThrow();
    expect(() => RunnerJobEvent.parse({
      ...base, route: { ...base.route, candidateCount: 1, eligibleCount: 2 },
    })).toThrow(/cannot exceed/);
    expect(() => RunnerJobEvent.parse({
      ...base, route: { ...base.route, reasons: Array.from({ length: 17 }, (_, i) => `reason.${i}`) },
    })).toThrow();
  });

  it('reduces bounded stage observations atomically and exposes a task-filtered cursor', async () => {
    const response = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: `RI${crypto.randomUUID().slice(0, 6).toUpperCase()}`, name: 'runner intelligence' }),
    });
    const projectId = ((await response.json()) as { id: string }).id;
    const isolatedRoom = projectRoom<RoomRpc>(projectId);
    const task = await isolatedRoom.createTask(projectId, SYSTEM_ACTOR as Actor, { title: 'Observed build' });
    const job = await isolatedRoom.createRunnerJob(projectId, SYSTEM_ACTOR as Actor, {
      source: { kind: 'task', id: task.id }, runnerId, repoRef: 'repo', expectedBaseRevision: revision,
    });
    await isolatedRoom.assignRunnerJob(projectId, job.id, runnerId);
    await isolatedRoom.acceptRunnerJob(projectId, job.id, runnerId, job.assignmentId);
    const startedAt = '2026-08-13T01:00:00.000Z';
    const finishedAt = '2026-08-13T01:00:02.500Z';
    const actor = {
      kind: 'agent' as const, driver: 'codex', vendor: 'openai', model: 'gpt-test',
      effort: 'medium', role: 'build', operation: 'invoke',
    };
    expect(await isolatedRoom.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 1, {
      type: 'job.context', at: startedAt, vcs: 'git', workspaceMode: 'isolated',
      landingPolicy: 'manual', agents: [{ role: 'build', driver: 'codex', vendor: 'openai', model: 'gpt-test', effort: 'medium' }],
    })).toMatchObject({ accepted: true, ack: 1 });
    expect(await isolatedRoom.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 2, {
      type: 'stage.started', at: startedAt, observationId: 'obs_build_1', taskId: task.id,
      stage: 'build', attempt: 1, actor,
    })).toMatchObject({ accepted: true, ack: 2 });
    const runningResponse = await SELF.fetch(
      `https://noriq.test/api/projects/${projectId}/runner-jobs/${job.id}/activity?limit=10&taskId=${task.id}`,
      { headers: { Cookie: cookie } },
    );
    const runningBody = await runningResponse.json() as {
      items: Array<Record<string, unknown>>; cursor: { next: string };
    };
    expect(runningBody.items).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: 'stage', id: 'stage:obs_build_1', status: 'running', finishSeq: null,
    })]));
    const usage = {
      inputTokens: { status: 'complete' as const, value: 100, provenance: 'driver_reported' as const },
      outputTokens: { status: 'complete' as const, value: 25, provenance: 'driver_reported' as const },
      cacheReadTokens: { status: 'complete' as const, value: 40, provenance: 'driver_reported' as const },
      cacheWriteTokens: { status: 'unavailable' as const, value: null, provenance: 'not_reported' as const },
      calls: { status: 'complete' as const, value: 1, provenance: 'driver_reported' as const },
      costUsd: { status: 'unavailable' as const, value: null, provenance: 'not_reported' as const },
    };
    const evidence = {
      operationDigest: 'b'.repeat(64), resultDigest: 'c'.repeat(64), exitCode: null,
      timedOut: null, changedPathCount: 2, blockerFindings: null, majorFindings: null,
      minorFindings: null, checkpointRef: revision, errorCode: null,
    };
    expect(await isolatedRoom.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 3, {
      type: 'stage.finished', at: finishedAt, startedAt, observationId: 'obs_build_1', taskId: task.id,
      stage: 'build', attempt: 1, actor, outcome: 'succeeded',
      duration: { status: 'complete', value: 2_500, provenance: 'runner_reported' },
      usage, recovery: 'none', evidence,
    })).toMatchObject({ accepted: true, ack: 3 });

    const cursorResponse = await SELF.fetch(
      `https://noriq.test/api/projects/${projectId}/runner-jobs/${job.id}/activity?limit=10&taskId=${task.id}&cursor=${encodeURIComponent(runningBody.cursor.next)}`,
      { headers: { Cookie: cookie } },
    );
    expect(cursorResponse.status).toBe(200);
    const activityBody = await cursorResponse.json() as { items: Array<Record<string, unknown>>; cursor: { next: string } };
    expect(activityBody).toMatchObject({
      cursor: { next: expect.any(String), hasMore: false },
      scope: { taskId: task.id }, partial: true, expired: false,
    });
    expect(activityBody.items).toEqual(expect.arrayContaining([expect.objectContaining({
        kind: 'stage', id: 'stage:obs_build_1', observationId: 'obs_build_1',
        taskId: task.id, stage: 'build', status: 'succeeded',
        duration: { status: 'complete', value: 2_500, provenance: 'runner_reported' },
        actor, usage,
        evidence: {
          changedPathCount: 2, blockerFindings: null, majorFindings: null,
          minorFindings: null, exitCode: null, timedOut: null,
          checkpointRef: revision, errorCode: null,
        },
        startSeq: 2, finishSeq: 3, cursorSeq: 3,
        occurredAt: startedAt, updatedAt: expect.any(String),
      })]));
    expect(JSON.stringify(activityBody.items)).not.toContain('operationDigest');
    expect(activityBody.items.map((item) => String(item.occurredAt))).toEqual(
      activityBody.items.map((item) => String(item.occurredAt)).sort(),
    );
    expect(await isolatedRoom.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 4, {
      type: 'stage.started', at: finishedAt, observationId: 'obs_build_1', taskId: task.id,
      stage: 'review', attempt: 1, actor,
    })).toMatchObject({ accepted: false, ack: 3, error: expect.stringContaining('identity conflicts') });
    expect(await isolatedRoom.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 4, {
      type: 'question', at: finishedAt, questionId: 'question_1', prompt: 'Choose the safe option.',
    })).toMatchObject({ accepted: true, ack: 4 });
    await env.DB.prepare(
      "UPDATE runner_jobs SET human_wait_started_received_at = datetime('now', '-2 seconds') WHERE id = ?",
    ).bind(job.id).run();
    await isolatedRoom.answerRunnerJobQuestion(projectId, SYSTEM_ACTOR as Actor, job.id, 'question_1', 'Proceed.');
    expect(await isolatedRoom.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 5, {
      type: 'task.result', at: finishedAt, taskId: task.id, status: 'accepted',
      checkpoint: { ref: revision, label: revision, url: null }, summary: 'accepted', findings: [],
    })).toMatchObject({ accepted: true, ack: 5 });
    const timingResponse = await SELF.fetch(
      `https://noriq.test/api/projects/${projectId}/runner-jobs/${job.id}/activity?cursor=${encodeURIComponent(activityBody.cursor.next)}&taskId=${task.id}`,
      { headers: { Cookie: cookie } },
    );
    const timingBody = await timingResponse.json() as {
      timing: { server: { queueMs: number; humanWaitMs: number; task: { durationMs: number } } };
    };
    expect(timingBody.timing.server.queueMs).toBeGreaterThanOrEqual(0);
    expect(timingBody.timing.server.humanWaitMs).toBeGreaterThanOrEqual(1_900);
    expect(timingBody.timing.server.task.durationMs).toBeGreaterThanOrEqual(0);
    const overheadResponse = await SELF.fetch(
      `https://noriq.test/api/projects/${projectId}/runner-jobs/${job.id}/activity?taskId=overhead`,
      { headers: { Cookie: cookie } },
    );
    const overheadBody = await overheadResponse.json() as { items: Array<{ taskId: string | null; type?: string; detail?: string | null }> };
    expect(overheadBody.items.every((item) => item.taskId === null)).toBe(true);
    expect(overheadBody.items.find((item) => item.type === 'question_opened')).toMatchObject({ detail: null });
    expect(overheadBody.items.some((item) => item.type === 'task_result')).toBe(false);
    const invalidCursor = await SELF.fetch(
      `https://noriq.test/api/projects/${projectId}/runner-jobs/${job.id}/activity?cursor=not-a-cursor`,
      { headers: { Cookie: cookie } },
    );
    expect(invalidCursor.status).toBe(400);
    const oversizedPage = await SELF.fetch(
      `https://noriq.test/api/projects/${projectId}/runner-jobs/${job.id}/activity?limit=201`,
      { headers: { Cookie: cookie } },
    );
    expect(oversizedPage.status).toBe(400);
    const oneItemPage = await SELF.fetch(
      `https://noriq.test/api/projects/${projectId}/runner-jobs/${job.id}/activity?limit=1`,
      { headers: { Cookie: cookie } },
    );
    const oneItemBody = await oneItemPage.json() as {
      items: unknown[]; cursor: { next: string; hasMore: boolean };
    };
    expect(oneItemBody.items).toHaveLength(1);
    expect(oneItemBody.cursor.hasMore).toBe(true);
    const nextOneItemPage = await SELF.fetch(
      `https://noriq.test/api/projects/${projectId}/runner-jobs/${job.id}/activity?limit=1&cursor=${encodeURIComponent(oneItemBody.cursor.next)}`,
      { headers: { Cookie: cookie } },
    );
    expect(((await nextOneItemPage.json()) as { items: unknown[] }).items.length).toBeLessThanOrEqual(1);
    const unauthorized = await SELF.fetch(
      `https://noriq.test/api/projects/${projectId}/runner-jobs/${job.id}/activity`,
    );
    expect(unauthorized.status).toBe(401);
    const removedObservations = await SELF.fetch(
      `https://noriq.test/api/projects/${projectId}/runner-jobs/${job.id}/observations`,
      { headers: { Cookie: cookie } },
    );
    expect(removedObservations.status).toBe(404);
    expect(await env.DB.prepare(
      `SELECT COUNT(*) AS nodes FROM execution_nodes WHERE orchestration_id = ?`,
    ).bind(job.orchestrationId).first<{ nodes: number }>()).toEqual({ nodes: 1 });
  });

  it('projects task and terminal outcomes without overwriting a later human terminal state', async () => {
    const response = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: `RP${crypto.randomUUID().slice(0, 6).toUpperCase()}`, name: 'projector runner job' }),
    });
    const projectId = ((await response.json()) as { id: string }).id;
    const isolatedRoom = projectRoom<RoomRpc>(projectId);
    const task = await isolatedRoom.createTask(projectId, SYSTEM_ACTOR as Actor, { title: 'Projected task' });
    const job = await isolatedRoom.createRunnerJob(projectId, SYSTEM_ACTOR as Actor, {
      source: { kind: 'task', id: task.id }, runnerId, repoRef: 'repo', expectedBaseRevision: revision,
    });
    await isolatedRoom.assignRunnerJob(projectId, job.id, runnerId);
    expect(await isolatedRoom.acceptRunnerJob(projectId, job.id, runnerId, job.assignmentId)).toBe(true);
    const at = new Date().toISOString();
    expect(await isolatedRoom.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 1, {
      type: 'task.result', at, taskId: task.id, status: 'running', checkpoint: null,
      summary: 'started', findings: [],
    })).toMatchObject({ accepted: true, ack: 1 });
    expect(await env.DB.prepare('SELECT status FROM tasks WHERE id = ?').bind(task.id).first<{ status: string }>())
      .toEqual({ status: 'in_progress' });

    await env.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").bind(task.id).run();
    expect(await isolatedRoom.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 2, {
      type: 'task.result', at, taskId: task.id, status: 'accepted', checkpoint: { ref: revision, label: revision, url: null },
      summary: 'accepted', findings: [{ severity: 'minor', title: 'note', body: 'human can inspect', path: null, line: null }],
    })).toMatchObject({ accepted: true, ack: 2 });
    const item = await env.DB.prepare(
      'SELECT status, projection_conflict AS conflict FROM runner_job_items WHERE job_id = ? AND task_id = ?',
    ).bind(job.id, task.id).first<{ status: string; conflict: string | null }>();
    expect(item?.status).toBe('accepted');
    expect(item?.conflict).toContain('"taskStatus":"done"');
    expect(await env.DB.prepare('SELECT status FROM tasks WHERE id = ?').bind(task.id).first<{ status: string }>())
      .toEqual({ status: 'done' });

    const output = {
      workspaceMode: 'isolated', retainedLocation: { vcs: 'git', label: 'noriq/task/projected-job', url: null },
      baseRevision: revision, headRevision: revision,
      acceptedTaskCheckpoints: { [task.id]: { ref: revision, label: revision, url: null } },
      checks: [], findings: [],
      usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, costUsd: 0.01, calls: 3 },
      summary: 'partial output retained', dirtyPaths: [],
    };
    expect(await isolatedRoom.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 3, {
      type: 'terminal', at, status: 'partial', output,
    })).toMatchObject({ accepted: true, ack: 3 });
    expect(await env.DB.prepare('SELECT status FROM runner_jobs WHERE id = ?').bind(job.id).first<{ status: string }>())
      .toEqual({ status: 'partial' });
    expect(await env.DB.prepare('SELECT reservation_active AS active FROM runner_job_items WHERE job_id = ?').bind(job.id).first<{ active: number }>())
      .toEqual({ active: 0 });
    const root = await env.DB.prepare(
      `SELECT o.status, COUNT(n.id) AS nodes FROM orchestrations o
         JOIN execution_nodes n ON n.orchestration_id = o.id WHERE o.id = ? GROUP BY o.id`,
    ).bind(job.orchestrationId).first<{ status: string; nodes: number }>();
    expect(root).toEqual({ status: 'failed', nodes: 1 });
    expect(await isolatedRoom.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 4, {
      type: 'warning', at, code: 'LATE', message: 'must not regress terminal state',
    })).toMatchObject({ accepted: false, ack: 3 });
  });

  it('drains a cancellation and terminalizes unfinished items without cancelling their tasks', async () => {
    const response = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: `RC${crypto.randomUUID().slice(0, 6).toUpperCase()}`, name: 'cancelled runner job' }),
    });
    const projectId = ((await response.json()) as { id: string }).id;
    const isolatedRoom = projectRoom<RoomRpc>(projectId);
    const task = await isolatedRoom.createTask(projectId, SYSTEM_ACTOR as Actor, { title: 'Cancelled execution' });
    const job = await isolatedRoom.createRunnerJob(projectId, SYSTEM_ACTOR as Actor, {
      source: { kind: 'task', id: task.id }, runnerId, repoRef: 'repo', expectedBaseRevision: revision,
    });
    await isolatedRoom.assignRunnerJob(projectId, job.id, runnerId);
    expect(await isolatedRoom.acceptRunnerJob(projectId, job.id, runnerId, job.assignmentId)).toBe(true);
    const at = new Date().toISOString();
    expect(await isolatedRoom.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 1, {
      type: 'task.result', at, taskId: task.id, status: 'running', checkpoint: null,
      summary: 'started', findings: [],
    })).toMatchObject({ accepted: true, ack: 1 });
    expect(await isolatedRoom.cancelRunnerJob(projectId, SYSTEM_ACTOR as Actor, job.id))
      .toMatchObject({ terminal: false });
    expect(await isolatedRoom.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 2, {
      type: 'progress', at, phase: 'building', message: 'late progress', progress: 0.5,
    })).toMatchObject({ accepted: false, ack: 1 });

    const output = {
      workspaceMode: 'isolated', retainedLocation: { vcs: 'git', label: 'noriq/recovery/cancelled', url: null },
      baseRevision: revision, headRevision: revision, acceptedTaskCheckpoints: {},
      checks: [], findings: [],
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, calls: 0 },
      summary: 'cancelled', dirtyPaths: [],
    };
    expect(await isolatedRoom.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 2, {
      type: 'terminal', at, status: 'cancelled', output,
    })).toMatchObject({ accepted: true, ack: 2 });
    expect(await env.DB.prepare('SELECT status FROM runner_jobs WHERE id = ?').bind(job.id).first<{ status: string }>())
      .toEqual({ status: 'cancelled' });
    expect(await env.DB.prepare(
      'SELECT status, reservation_active AS active FROM runner_job_items WHERE job_id = ?',
    ).bind(job.id).first<{ status: string; active: number }>())
      .toEqual({ status: 'cancelled', active: 0 });
    expect(await env.DB.prepare('SELECT status FROM tasks WHERE id = ?').bind(task.id).first<{ status: string }>())
      .toEqual({ status: 'todo' });
  });

  it('persists one manual landing request and marks reviewed tasks done only after Runner success', async () => {
    const response = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: `RL${crypto.randomUUID().slice(0, 6).toUpperCase()}`, name: 'runner landing' }),
    });
    const projectId = ((await response.json()) as { id: string }).id;
    const isolatedRoom = projectRoom<RoomRpc>(projectId);
    const task = await isolatedRoom.createTask(projectId, SYSTEM_ACTOR as Actor, { title: 'Land reviewed output' });
    const job = await isolatedRoom.createRunnerJob(projectId, SYSTEM_ACTOR as Actor, {
      source: { kind: 'task', id: task.id }, runnerId, repoRef: 'repo', expectedBaseRevision: revision,
    });
    await isolatedRoom.assignRunnerJob(projectId, job.id, runnerId);
    await isolatedRoom.acceptRunnerJob(projectId, job.id, runnerId, job.assignmentId);
    const at = new Date().toISOString();
    const checkpoint = { ref: 'c'.repeat(40), label: 'noriq/task/landing', url: null };
    await isolatedRoom.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 1, {
      type: 'task.result', at, taskId: task.id, status: 'accepted', checkpoint,
      summary: 'reviewed', findings: [],
    });
    await isolatedRoom.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 2, {
      type: 'terminal', at, status: 'succeeded',
      output: {
        workspaceMode: 'isolated', retainedLocation: { vcs: 'git', label: checkpoint.label, url: null },
        baseRevision: revision, headRevision: checkpoint.ref,
        acceptedTaskCheckpoints: { [task.id]: checkpoint }, checks: [], findings: [],
        usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUsd: 0, calls: 1 },
        summary: 'ready to land', dirtyPaths: [],
        landing: {
          policy: 'manual', status: 'retained', target: 'main', checkpoint: null,
          error: null, requestId: null,
        },
      },
    });
    expect(await env.DB.prepare('SELECT status FROM tasks WHERE id = ?').bind(task.id).first<{ status: string }>())
      .toEqual({ status: 'review' });

    const request = await isolatedRoom.requestRunnerJobLanding(projectId, SYSTEM_ACTOR as Actor, job.id);
    expect(request).toMatchObject({ terminal: false, target: 'main', requestId: expect.any(String) });
    const replay = await isolatedRoom.requestRunnerJobLanding(projectId, SYSTEM_ACTOR as Actor, job.id);
    expect(replay.requestId).toBe(request.requestId);
    const landingActor = {
      kind: 'vcs' as const, driver: 'git', vendor: null, model: null,
      effort: null, role: null, operation: 'land',
    };
    expect(await isolatedRoom.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 3, {
      type: 'stage.started', at, observationId: 'obs_manual_landing', taskId: null,
      stage: 'landing', attempt: 1, actor: landingActor,
    })).toMatchObject({ accepted: true, ack: 3 });
    expect(await isolatedRoom.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 4, {
      type: 'stage.finished', at, startedAt: at, observationId: 'obs_manual_landing', taskId: null,
      stage: 'landing', attempt: 1, actor: landingActor, outcome: 'succeeded',
      duration: { status: 'complete', value: 5, provenance: 'runner_reported' },
      usage: {
        inputTokens: { status: 'not_applicable', value: null, provenance: 'runner_reported' },
        outputTokens: { status: 'not_applicable', value: null, provenance: 'runner_reported' },
        cacheReadTokens: { status: 'not_applicable', value: null, provenance: 'runner_reported' },
        cacheWriteTokens: { status: 'not_applicable', value: null, provenance: 'runner_reported' },
        calls: { status: 'not_applicable', value: null, provenance: 'runner_reported' },
        costUsd: { status: 'not_applicable', value: null, provenance: 'runner_reported' },
      },
      recovery: 'none',
      evidence: {
        operationDigest: null, resultDigest: null, exitCode: null, timedOut: null,
        changedPathCount: null, blockerFindings: null, majorFindings: null,
        minorFindings: null, checkpointRef: checkpoint.ref, errorCode: null,
      },
    })).toMatchObject({ accepted: true, ack: 4 });
    const landedCheckpoint = { ref: checkpoint.ref, label: 'main', url: null };
    expect(await isolatedRoom.recordRunnerJobLandingResult(
      projectId, job.id, runnerId, job.assignmentId, request.requestId!,
      { status: 'landed', target: 'main', checkpoint: landedCheckpoint, error: null },
    )).toEqual({ accepted: true, error: null });
    expect(await env.DB.prepare('SELECT status FROM tasks WHERE id = ?').bind(task.id).first<{ status: string }>())
      .toEqual({ status: 'done' });
    expect(await env.DB.prepare(
      'SELECT landing_status AS status, landing_checkpoint AS checkpoint FROM runner_jobs WHERE id = ?',
    ).bind(job.id).first<{ status: string; checkpoint: string }>())
      .toEqual({ status: 'landed', checkpoint: JSON.stringify(landedCheckpoint) });
    expect(await isolatedRoom.recordRunnerJobLandingResult(
      projectId, job.id, runnerId, job.assignmentId, request.requestId!,
      { status: 'landed', target: 'main', checkpoint: landedCheckpoint, error: null },
    )).toEqual({ accepted: true, error: null });
  });

  it('projects an automatic terminal landing without a human request', async () => {
    const response = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: `RA${crypto.randomUUID().slice(0, 6).toUpperCase()}`, name: 'automatic landing' }),
    });
    const projectId = ((await response.json()) as { id: string }).id;
    const isolatedRoom = projectRoom<RoomRpc>(projectId);
    const task = await isolatedRoom.createTask(projectId, SYSTEM_ACTOR as Actor, { title: 'Automatically landed task' });
    const job = await isolatedRoom.createRunnerJob(projectId, SYSTEM_ACTOR as Actor, {
      source: { kind: 'task', id: task.id }, runnerId, repoRef: 'repo', expectedBaseRevision: revision,
    });
    await isolatedRoom.assignRunnerJob(projectId, job.id, runnerId);
    await isolatedRoom.acceptRunnerJob(projectId, job.id, runnerId, job.assignmentId);
    const at = new Date().toISOString();
    const checkpoint = { ref: 'e'.repeat(40), label: 'main', url: null };
    await isolatedRoom.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 1, {
      type: 'task.result', at, taskId: task.id, status: 'accepted', checkpoint,
      summary: 'accepted', findings: [],
    });
    expect(await isolatedRoom.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 2, {
      type: 'terminal', at, status: 'succeeded',
      output: {
        workspaceMode: 'isolated', retainedLocation: { vcs: 'git', label: 'noriq/task/auto', url: null },
        baseRevision: revision, headRevision: checkpoint.ref,
        acceptedTaskCheckpoints: { [task.id]: checkpoint }, checks: [], findings: [],
        usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUsd: 0, calls: 1 },
        summary: 'automatically landed', dirtyPaths: [],
        landing: {
          policy: 'auto', status: 'landed', target: 'main', checkpoint,
          error: null, requestId: null,
        },
      },
    })).toMatchObject({ accepted: true, ack: 2 });
    expect(await env.DB.prepare('SELECT status FROM tasks WHERE id = ?').bind(task.id).first<{ status: string }>())
      .toEqual({ status: 'done' });
    expect(await env.DB.prepare('SELECT landing_status AS status FROM runner_jobs WHERE id = ?').bind(job.id).first<{ status: string }>())
      .toEqual({ status: 'landed' });
  });

  it('accepts only terminal-safe task outcomes while a cancellation drains', async () => {
    const response = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: `RD${crypto.randomUUID().slice(0, 6).toUpperCase()}`, name: 'runner cancellation drain' }),
    });
    const projectId = ((await response.json()) as { id: string }).id;
    const isolatedRoom = projectRoom<RoomRpc>(projectId);
    const task = await isolatedRoom.createTask(projectId, SYSTEM_ACTOR as Actor, { title: 'Legacy cancellation drain' });
    const job = await isolatedRoom.createRunnerJob(projectId, SYSTEM_ACTOR as Actor, {
      source: { kind: 'task', id: task.id }, runnerId, repoRef: 'repo', expectedBaseRevision: revision,
    });
    await isolatedRoom.assignRunnerJob(projectId, job.id, runnerId);
    expect(await isolatedRoom.acceptRunnerJob(projectId, job.id, runnerId, job.assignmentId)).toBe(true);
    await isolatedRoom.cancelRunnerJob(projectId, SYSTEM_ACTOR as Actor, job.id);
    const at = new Date().toISOString();
    expect(await isolatedRoom.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 1, {
      type: 'task.result', at, taskId: task.id, status: 'failed', checkpoint: null,
      summary: 'builder aborted', findings: [],
    })).toMatchObject({ accepted: true, ack: 1 });
    expect(await isolatedRoom.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 2, {
      type: 'task.result', at, taskId: task.id, status: 'accepted',
      checkpoint: { ref: revision, label: revision, url: null }, summary: 'too late', findings: [],
    })).toMatchObject({ accepted: false, ack: 1 });
    const output = {
      workspaceMode: 'isolated', retainedLocation: { vcs: 'git', label: 'noriq/recovery/cancelled', url: null },
      baseRevision: revision, headRevision: revision, acceptedTaskCheckpoints: {},
      checks: [], findings: [],
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, calls: 0 },
      summary: 'cancelled', dirtyPaths: [],
    };
    expect(await isolatedRoom.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 2, {
      type: 'terminal', at, status: 'cancelled', output,
    })).toMatchObject({ accepted: true, ack: 2 });
    expect(await env.DB.prepare(
      'SELECT status FROM runner_job_items WHERE job_id = ?',
    ).bind(job.id).first<{ status: string }>()).toEqual({ status: 'cancelled' });
    expect(await env.DB.prepare(
      'SELECT status, failed_at AS failedAt FROM tasks WHERE id = ?',
    ).bind(task.id).first<{ status: string; failedAt: string | null }>())
      .toEqual({ status: 'todo', failedAt: null });
  });
});
