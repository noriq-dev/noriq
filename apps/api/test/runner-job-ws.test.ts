import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { RunnerJobServerMessage } from '@noriq-dev/shared';
import { authorizeForAllProjects, createUser, loginSession, mintTokenForUser } from './helpers';

function nextFrame(ws: WebSocket, predicate: (message: any) => boolean, timeoutMs = 3_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('frame timeout')); }, timeoutMs);
    const listener = (event: MessageEvent) => {
      let message: any;
      try { message = JSON.parse(event.data as string); } catch { return; }
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const cleanup = () => { clearTimeout(timer); ws.removeEventListener('message', listener); };
    ws.addEventListener('message', listener);
  });
}

describe('RunnerJob protocol v2 (PLNR-499)', () => {
  let token: string;
  let cookie: string;
  let pid: string;
  let runnerId: string;
  const repoRef = `repo-job-${crypto.randomUUID()}`;
  const repositoryKey = `runner-job-${crypto.randomUUID()}`;
  const baseRevision = 'b'.repeat(40);

  beforeAll(async () => {
    await createUser('runner-job-ws@example.com', 'Runner Job WS', 'longenough1', 'member').catch(() => {});
    token = await mintTokenForUser('runner-job-ws@example.com');
    cookie = await loginSession('runner-job-ws@example.com', 'longenough1');
    const project = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: `JW${crypto.randomUUID().slice(0, 6).toUpperCase()}`, name: 'Runner Job WS' }),
    });
    pid = ((await project.json()) as { id: string }).id;
    await authorizeForAllProjects(token);
    const registration = await SELF.fetch('https://noriq.test/api/runners', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'runner-job-v2', maxConcurrency: 2,
        repos: [{ id: repoRef, projectKey: (await env.DB.prepare('SELECT key FROM projects WHERE id = ?').bind(pid).first<{ key: string }>())!.key, repositoryKey }],
      }),
    });
    runnerId = ((await registration.json()) as { runner: { id: string } }).runner.id;
  }, 60_000);

  async function connect(): Promise<WebSocket> {
    const response = await SELF.fetch(`https://noriq.test/ws/runner/${runnerId}`, {
      headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    ws.accept();
    ws.send(JSON.stringify({
      type: 'hello', protocolVersion: 2, runnerId, capacity: 2,
      repositories: [{ repositoryKey, repoRef, vcs: 'git', baseRevision }],
    }));
    return ws;
  }

  async function createTask(title: string): Promise<string> {
    const response = await SELF.fetch(`https://noriq.test/api/projects/${pid}/tasks`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    return ((await response.json()) as { id: string }).id;
  }

  async function dispatch(taskId: string): Promise<{ id: string; assignmentId: string }> {
    const response = await SELF.fetch(`https://noriq.test/api/projects/${pid}/tasks/${taskId}/runner-jobs`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runnerId, repoRef }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { job: { id: string; assignmentId: string } };
    return body.job;
  }

  it('fences and acknowledges idempotent events, reconnects, answers, and cancels durably', async () => {
    const ws = await connect();
    const taskId = await createTask('Protocol task');
    const assignedPromise = nextFrame(ws, (message) => message.type === 'job.assign');
    const job = await dispatch(taskId);
    const assigned = RunnerJobServerMessage.parse(await assignedPromise);
    expect(assigned).toMatchObject({ type: 'job.assign', assignment: { jobId: job.id, assignmentId: job.assignmentId, expectedBaseRevision: baseRevision } });
    ws.send(JSON.stringify({ type: 'job.accept', jobId: job.id, assignmentId: job.assignmentId }));

    const event = {
      type: 'progress', at: new Date().toISOString(), phase: 'building',
      message: 'durable', progress: 0.25,
    };
    const ackOne = nextFrame(ws, (message) => message.type === 'job.event.ack' && message.seq === 1);
    ws.send(JSON.stringify({ type: 'job.event', jobId: job.id, assignmentId: job.assignmentId, seq: 1, payload: event }));
    expect(await ackOne).toMatchObject({ seq: 1 });
    const replayAck = nextFrame(ws, (message) => message.type === 'job.event.ack' && message.seq === 1);
    ws.send(JSON.stringify({ type: 'job.event', jobId: job.id, assignmentId: job.assignmentId, seq: 1, payload: event }));
    await replayAck;
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM runner_job_events WHERE job_id = ?').bind(job.id).first<{ n: number }>()).toEqual({ n: 1 });
    expect(await env.DB.prepare('SELECT status FROM runner_jobs WHERE id = ?').bind(job.id).first<{ status: string }>())
      .toEqual({ status: 'running' });

    ws.close();
    const reconnected = await connect();
    const replayedAssignment = await nextFrame(reconnected, (message) => message.type === 'job.assign' && message.assignment.jobId === job.id);
    expect(replayedAssignment.assignment.assignmentId).toBe(job.assignmentId);
    const reconcile = nextFrame(reconnected, (message) => message.type === 'job.reconcile.result');
    reconnected.send(JSON.stringify({ type: 'job.reconcile', jobId: job.id, assignmentId: job.assignmentId, lastLocalSeq: 1 }));
    expect(await reconcile).toMatchObject({ action: 'continue' });

    const questionAck = nextFrame(reconnected, (message) => message.type === 'job.event.ack' && message.seq === 2);
    reconnected.send(JSON.stringify({
      type: 'job.event', jobId: job.id, assignmentId: job.assignmentId, seq: 2,
      payload: { type: 'question', at: new Date().toISOString(), questionId: 'question-1', prompt: 'Proceed?' },
    }));
    await questionAck;
    const answerFrame = nextFrame(reconnected, (message) => message.type === 'job.answer');
    const answer = await SELF.fetch(`https://noriq.test/api/projects/${pid}/runner-jobs/${job.id}/questions/question-1/answer`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: 'yes' }),
    });
    expect(answer.status).toBe(200);
    expect(await answerFrame).toMatchObject({ questionId: 'question-1', answer: 'yes' });

    const cancelFrame = nextFrame(reconnected, (message) => message.type === 'job.cancel');
    const cancelled = await SELF.fetch(`https://noriq.test/api/projects/${pid}/runner-jobs/${job.id}/cancel`, {
      method: 'POST', headers: { Cookie: cookie },
    });
    expect(cancelled.status).toBe(200);
    await cancelFrame;
    const cancelReconcile = nextFrame(reconnected, (message) => message.type === 'job.reconcile.result');
    reconnected.send(JSON.stringify({ type: 'job.reconcile', jobId: job.id, assignmentId: job.assignmentId, lastLocalSeq: 2 }));
    expect(await cancelReconcile).toMatchObject({ action: 'cancel' });
    reconnected.close();
    await new Promise((resolve) => setTimeout(resolve, 25));
  });

  it('keeps an offline dispatch queued', async () => {
    const taskId = await createTask('Offline queued task');
    const offlineRef = `offline-${crypto.randomUUID()}`;
    const projectKey = (await env.DB.prepare('SELECT key FROM projects WHERE id = ?').bind(pid).first<{ key: string }>())!.key;
    const registration = await SELF.fetch('https://noriq.test/api/runners', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'offline-v2', maxConcurrency: 1, repos: [{ id: offlineRef, projectKey }] }),
    });
    const offlineRunnerId = ((await registration.json()) as { runner: { id: string } }).runner.id;
    const stored = await env.DB.prepare('SELECT repos FROM runners WHERE id = ?').bind(offlineRunnerId).first<{ repos: string }>();
    const repos = JSON.parse(stored!.repos) as Array<Record<string, unknown>>;
    repos[0] = { ...repos[0], repoRef: offlineRef, baseRevision };
    await env.DB.prepare('UPDATE runners SET repos = ?, status = \'offline\' WHERE id = ?')
      .bind(JSON.stringify(repos), offlineRunnerId).run();
    const response = await SELF.fetch(`https://noriq.test/api/projects/${pid}/tasks/${taskId}/runner-jobs`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runnerId: offlineRunnerId, repoRef: offlineRef }),
    });
    expect(response.status).toBe(201);
    const job = (await response.json() as { job: { id: string } }).job;
    expect(await env.DB.prepare('SELECT status FROM runner_jobs WHERE id = ?').bind(job.id).first<{ status: string }>())
      .toEqual({ status: 'queued' });
  });
});
