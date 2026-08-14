import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  RUNNER_CATALOG_CAPABILITY, RunnerJobServerMessage, runnerCatalogCanonicalJson,
  type RunnerJobRuntimeRepository,
} from '@noriq-dev/shared';
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

function expectNoFrame(ws: WebSocket, predicate: (message: any) => boolean, timeoutMs = 100): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', listener);
      resolve();
    }, timeoutMs);
    const listener = (event: MessageEvent) => {
      let message: any;
      try { message = JSON.parse(event.data as string); } catch { return; }
      if (predicate(message)) {
        clearTimeout(timer);
        ws.removeEventListener('message', listener);
        reject(new Error(`unexpected frame: ${JSON.stringify(message)}`));
      }
    };
    ws.addEventListener('message', listener);
  });
}

function nextClose(ws: WebSocket, timeoutMs = 3_000): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('close timeout')), timeoutMs);
    ws.addEventListener('close', (event) => {
      clearTimeout(timer);
      resolve(event);
    }, { once: true });
  });
}

async function catalogDigest(repositories: RunnerJobRuntimeRepository[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(runnerCatalogCanonicalJson(repositories)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('RunnerJob protocol v2 (PLNR-499)', () => {
  let token: string;
  let cookie: string;
  let pid: string;
  let runnerId: string;
  const repoRef = `repo-job-${crypto.randomUUID()}`;
  const repositoryKey = `runner-job-${crypto.randomUUID()}`;
  const baseRevision = '//depot/noriq/main@184205';

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
      repositories: [{ repositoryKey, repoRef, vcs: 'perforce', baseRevision }],
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

  it('serializes an immediate catalog frame behind its v2 hello and rejects an unnegotiated socket (PLNR-522)', async () => {
    const projectKey = (await env.DB.prepare('SELECT key FROM projects WHERE id = ?')
      .bind(pid).first<{ key: string }>())!.key;
    const catalogRef = `catalog-race-${crypto.randomUUID()}`;
    const catalogKey = `catalog-race-key-${crypto.randomUUID()}`;
    const registration = await SELF.fetch('https://noriq.test/api/runners', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'catalog-race', maxConcurrency: 1,
        protocolCapabilities: ['runner-job.v2', RUNNER_CATALOG_CAPABILITY],
        repos: [{ id: catalogRef, projectKey, repositoryKey: catalogKey }],
      }),
    });
    expect(registration.status).toBe(200);
    const catalogRunnerId = ((await registration.json()) as { runner: { id: string } }).runner.id;

    // Widen the hello handler's pre-negotiation D1 read without changing its registered
    // capabilities. The next wire frame must remain behind hello for the whole delayed turn.
    const stored = await env.DB.prepare('SELECT capabilities FROM runners WHERE id = ?')
      .bind(catalogRunnerId).first<{ capabilities: string }>();
    await env.DB.prepare('UPDATE runners SET capabilities = ? WHERE id = ?').bind(JSON.stringify({
      ...JSON.parse(stored!.capabilities), helloReadPadding: 'x'.repeat(512_000),
    }), catalogRunnerId).run();

    const repositories: RunnerJobRuntimeRepository[] = [{
      repositoryKey: catalogKey, repoRef: catalogRef, vcs: 'git', baseRevision: 'a'.repeat(40),
    }];
    const digest = await catalogDigest(repositories);
    const response = await SELF.fetch(`https://noriq.test/ws/runner/${catalogRunnerId}`, {
      headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    ws.accept();
    const acknowledged = nextFrame(ws, (message) => message.type === 'catalog.ack');
    ws.send(JSON.stringify({
      type: 'hello', protocolVersion: 2, runnerId: catalogRunnerId, capacity: 1, repositories,
    }));
    ws.send(JSON.stringify({
      type: 'catalog.update', catalog: { generation: 1, digest, repositories },
    }));
    expect(await acknowledged).toMatchObject({
      accepted: true, generation: 1, digest, dispatchableRepoRefs: [catalogRef], error: null,
    });
    ws.close();

    const rawResponse = await SELF.fetch(`https://noriq.test/ws/runner/${catalogRunnerId}`, {
      headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}` },
    });
    const raw = rawResponse.webSocket!;
    raw.accept();
    const closed = nextClose(raw);
    raw.send(JSON.stringify({
      type: 'catalog.update', catalog: { generation: 2, digest, repositories },
    }));
    await expect(closed).resolves.toMatchObject({ code: 1002, reason: 'protocol v2 hello required' });
  });

  it('negotiates monotonic live checkout catalogs without replaying assignments', async () => {
    const projectKey = (await env.DB.prepare('SELECT key FROM projects WHERE id = ?').bind(pid).first<{ key: string }>())!.key;
    const liveRunnerRef = `catalog-runner-${crypto.randomUUID()}`;
    const firstRef = `catalog-a-${crypto.randomUUID()}`;
    const secondRef = `catalog-b-${crypto.randomUUID()}`;
    const sharedRepositoryKey = `catalog-key-${crypto.randomUUID()}`;
    const register = (repos: Array<{ id: string; projectKey: string; repositoryKey: string }>) => SELF.fetch(
      'https://noriq.test/api/runners', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runnerId: liveRunnerRef.startsWith('rnr_') ? liveRunnerRef : undefined,
          label: 'catalog-v1', maxConcurrency: 2,
          protocolCapabilities: ['runner-job.v2', RUNNER_CATALOG_CAPABILITY], repos,
        }),
      },
    );
    const initial = await register([{ id: firstRef, projectKey, repositoryKey: sharedRepositoryKey }]);
    expect(initial.status).toBe(200);
    const catalogRunnerId = ((await initial.json()) as { runner: { id: string } }).runner.id;

    const response = await SELF.fetch(`https://noriq.test/ws/runner/${catalogRunnerId}`, {
      headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}` },
    });
    const ws = response.webSocket!;
    ws.accept();
    ws.send(JSON.stringify({
      type: 'hello', protocolVersion: 2, runnerId: catalogRunnerId, capacity: 2,
      repositories: [{ repositoryKey: sharedRepositoryKey, repoRef: firstRef, vcs: 'git', baseRevision: 'a'.repeat(40) }],
    }));

    const reregister = await SELF.fetch('https://noriq.test/api/runners', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runnerId: catalogRunnerId, label: 'catalog-v1', maxConcurrency: 2,
        protocolCapabilities: ['runner-job.v2', RUNNER_CATALOG_CAPABILITY],
        repos: [
          { id: firstRef, projectKey, repositoryKey: sharedRepositoryKey },
          { id: secondRef, projectKey, repositoryKey: sharedRepositoryKey },
        ],
      }),
    });
    expect(reregister.status).toBe(200);

    const beforeAckTask = await createTask('Catalog not yet acknowledged');
    const beforeAck = await SELF.fetch(`https://noriq.test/api/projects/${pid}/tasks/${beforeAckTask}/runner-jobs`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runnerId: catalogRunnerId, repoRef: secondRef }),
    });
    expect(beforeAck.status).toBe(409);

    const generationOne: RunnerJobRuntimeRepository[] = [
      { repositoryKey: sharedRepositoryKey, repoRef: firstRef, vcs: 'git', baseRevision: 'a'.repeat(40) },
      { repositoryKey: sharedRepositoryKey, repoRef: secondRef, vcs: 'git', baseRevision: 'b'.repeat(40) },
    ];
    const digestOne = await catalogDigest(generationOne);
    const ackOne = nextFrame(ws, (message) => message.type === 'catalog.ack' && message.generation === 1);
    ws.send(JSON.stringify({ type: 'catalog.update', catalog: { generation: 1, digest: digestOne, repositories: generationOne } }));
    expect(RunnerJobServerMessage.parse(await ackOne)).toMatchObject({
      accepted: true, digest: digestOne, dispatchableRepoRefs: [firstRef, secondRef].sort(), error: null,
    });

    const taskId = await createTask('Catalog dispatch');
    const assignment = nextFrame(ws, (message) => message.type === 'job.assign');
    const dispatched = await SELF.fetch(`https://noriq.test/api/projects/${pid}/tasks/${taskId}/runner-jobs`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runnerId: catalogRunnerId, repoRef: secondRef }),
    });
    expect(dispatched.status).toBe(201);
    await assignment;

    const generationTwo: RunnerJobRuntimeRepository[] = [
      { repositoryKey: sharedRepositoryKey, repoRef: secondRef, vcs: 'git', baseRevision: 'c'.repeat(40) },
    ];
    const digestTwo = await catalogDigest(generationTwo);
    const noReplay = expectNoFrame(ws, (message) => message.type === 'job.assign');
    const ackTwo = nextFrame(ws, (message) => message.type === 'catalog.ack' && message.generation === 2);
    ws.send(JSON.stringify({ type: 'catalog.update', catalog: { generation: 2, digest: digestTwo, repositories: generationTwo } }));
    expect(await ackTwo).toMatchObject({ accepted: true, dispatchableRepoRefs: [secondRef] });
    await noReplay;

    const stored = await env.DB.prepare('SELECT repos FROM runners WHERE id = ?')
      .bind(catalogRunnerId).first<{ repos: string }>();
    const repositories = JSON.parse(stored!.repos) as Array<Record<string, unknown>>;
    expect(repositories.find((repository) => repository.id === firstRef)).toMatchObject({ catalogAcknowledged: false });
    expect(repositories.find((repository) => repository.id === firstRef)).not.toHaveProperty('baseRevision');
    expect(repositories.find((repository) => repository.id === secondRef)).toMatchObject({
      catalogAcknowledged: true, baseRevision: 'c'.repeat(40), repositoryKey: sharedRepositoryKey,
    });

    const rejectedAck = nextFrame(ws, (message) => message.type === 'catalog.ack' && message.generation === 2 && message.accepted === false);
    ws.send(JSON.stringify({
      type: 'catalog.update',
      catalog: { generation: 2, digest: digestOne, repositories: generationOne },
    }));
    expect(await rejectedAck).toMatchObject({ error: 'catalog generation must advance monotonically from 2' });
    ws.close();
  });

  it('redelivers a durable human landing request and acknowledges its idempotent result', async () => {
    const ws = await connect();
    const taskId = await createTask('Landing protocol task');
    const assignedPromise = nextFrame(ws, (message) => message.type === 'job.assign');
    const job = await dispatch(taskId);
    await assignedPromise;
    ws.send(JSON.stringify({ type: 'job.accept', jobId: job.id, assignmentId: job.assignmentId }));
    const checkpoint = { ref: 'd'.repeat(40), label: 'noriq/task/landing-protocol', url: null };
    const acceptedAck = nextFrame(ws, (message) => message.type === 'job.event.ack' && message.seq === 1);
    ws.send(JSON.stringify({
      type: 'job.event', jobId: job.id, assignmentId: job.assignmentId, seq: 1,
      payload: {
        type: 'task.result', at: new Date().toISOString(), taskId, status: 'accepted',
        checkpoint, summary: 'reviewed', findings: [],
      },
    }));
    await acceptedAck;
    const terminalAck = nextFrame(ws, (message) => message.type === 'job.event.ack' && message.seq === 2);
    ws.send(JSON.stringify({
      type: 'job.event', jobId: job.id, assignmentId: job.assignmentId, seq: 2,
      payload: {
        type: 'terminal', at: new Date().toISOString(), status: 'succeeded',
        output: {
          workspaceMode: 'isolated', retainedLocation: { vcs: 'git', label: checkpoint.label, url: null },
          baseRevision, headRevision: checkpoint.ref, acceptedTaskCheckpoints: { [taskId]: checkpoint },
          checks: [], findings: [],
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUsd: 0, calls: 1 },
          summary: 'ready', dirtyPaths: [],
          landing: {
            policy: 'manual', status: 'retained', target: 'main', checkpoint: null,
            error: null, requestId: null,
          },
        },
      },
    }));
    await terminalAck;

    const landingFrame = nextFrame(ws, (message) => message.type === 'job.land' && message.jobId === job.id);
    const request = await SELF.fetch(`https://noriq.test/api/projects/${pid}/runner-jobs/${job.id}/land`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(request.status).toBe(200);
    const landing = RunnerJobServerMessage.parse(await landingFrame);
    expect(landing).toMatchObject({ type: 'job.land', jobId: job.id, target: 'main' });
    if (landing.type !== 'job.land') throw new Error('landing frame not received');
    ws.close();

    const reconnected = await connect();
    const replay = RunnerJobServerMessage.parse(await nextFrame(
      reconnected,
      (message) => message.type === 'job.land' && message.jobId === job.id,
    ));
    expect(replay).toEqual(landing);
    const ack = nextFrame(reconnected, (message) => message.type === 'job.land.ack' && message.jobId === job.id);
    reconnected.send(JSON.stringify({
      type: 'job.land.result', jobId: job.id, assignmentId: job.assignmentId,
      requestId: landing.requestId, status: 'landed', target: 'main',
      checkpoint: { ref: checkpoint.ref, label: 'main', url: null }, error: null,
    }));
    expect(await ack).toMatchObject({ requestId: landing.requestId });
    expect(await env.DB.prepare('SELECT status FROM tasks WHERE id = ?').bind(taskId).first<{ status: string }>())
      .toEqual({ status: 'done' });
    expect(await env.DB.prepare('SELECT landing_status AS status FROM runner_jobs WHERE id = ?').bind(job.id).first<{ status: string }>())
      .toEqual({ status: 'landed' });
    reconnected.close();
  });
});
