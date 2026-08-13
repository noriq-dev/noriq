import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { RunnerJobAssignment, RunnerJobSource } from '@noriq-dev/shared';
import type { Actor, CreateRunnerJobInput, RunnerJobView } from '../src/do/ProjectRoom';
import { createUser, loginSession, projectRoom, SYSTEM_ACTOR } from './helpers';

interface RoomRpc {
  createTask(projectId: string, actor: Actor, input: { title: string }): Promise<{ id: string; key: string }>;
  createRunnerJob(projectId: string, actor: Actor, input: CreateRunnerJobInput): Promise<RunnerJobView>;
  assignRunnerJob(projectId: string, jobId: string, runnerId: string): Promise<{ assignmentId: string } | null>;
  acceptRunnerJob(projectId: string, jobId: string, runnerId: string, assignmentId: string): Promise<boolean>;
  recordRunnerJobEvent(projectId: string, jobId: string, runnerId: string, assignmentId: string, seq: number, event: unknown): Promise<{ accepted: boolean; ack: number; error: string | null }>;
  cancelRunnerJob(projectId: string, actor: Actor, jobId: string): Promise<{ terminal: boolean }>;
}

let pid: string;
let room: RoomRpc;
let cookie: string;
const runnerId = `rnr_job_${crypto.randomUUID()}`;
const revision = 'a'.repeat(40);

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
  room = projectRoom<RoomRpc>(pid);
}, 60_000);

describe('RunnerJob commissioning (PLNR-498)', () => {
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

  it('creates a bounded immutable snapshot, one root, and a live reservation atomically', async () => {
    const task = await room.createTask(pid, SYSTEM_ACTOR as Actor, { title: 'Reserved task' });
    const job = await room.createRunnerJob(pid, SYSTEM_ACTOR as Actor, {
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

    await expect(room.createRunnerJob(pid, SYSTEM_ACTOR as Actor, {
      source: { kind: 'task', id: task.id }, runnerId, repoRef: 'repo', expectedBaseRevision: revision,
    })).rejects.toThrow(/reserved by another live RunnerJob/);
    await expect(env.DB.prepare('UPDATE runner_jobs SET snapshot = ? WHERE id = ?')
      .bind('{}', job.id).run()).rejects.toThrow(/immutable/);
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
  });
});
