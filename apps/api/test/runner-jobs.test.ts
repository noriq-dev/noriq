import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { RunnerJobAssignment, RunnerJobSource } from '@noriq-dev/shared';
import type { Actor, CreateRunnerJobInput, RunnerJobView } from '../src/do/ProjectRoom';
import { createUser, loginSession, projectRoom, SYSTEM_ACTOR } from './helpers';

interface RoomRpc {
  createTask(projectId: string, actor: Actor, input: { title: string }): Promise<{ id: string; key: string }>;
  createRunnerJob(projectId: string, actor: Actor, input: CreateRunnerJobInput): Promise<RunnerJobView>;
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
});
