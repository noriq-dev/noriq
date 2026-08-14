import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { RUNNER_COORDINATION_CAPABILITY, type RunnerCoordinationLease } from '@noriq-dev/shared';
import type { Actor } from '../src/do/ProjectRoom';
import { authorizeForAllProjects, createUser, loginSession, mintTokenForUser, projectRoom, SYSTEM_ACTOR } from './helpers';

interface RoomRpc {
  assignRunnerJob(projectId: string, jobId: string, runnerId: string): Promise<unknown>;
  acceptRunnerJob(projectId: string, jobId: string, runnerId: string, assignmentId: string): Promise<boolean>;
  cancelRunnerJob(projectId: string, actor: Actor, jobId: string): Promise<unknown>;
  recordRunnerJobEvent(
    projectId: string, jobId: string, runnerId: string, assignmentId: string,
    seq: number, event: unknown,
  ): Promise<{ accepted: boolean }>;
  requestRunnerJobLanding(
    projectId: string, actor: Actor, jobId: string,
  ): Promise<{ requestId: string | null; target: string | null }>;
  recordRunnerJobLandingResult(
    projectId: string, jobId: string, runnerId: string, assignmentId: string,
    requestId: string, result: {
      status: 'landed' | 'failed'; target: string;
      checkpoint: { ref: string; label: string; url: string | null } | null; error: string | null;
    },
  ): Promise<{ accepted: boolean; error: string | null }>;
}

describe('Runner coordination leases (PLNR-520/PLNR-521)', () => {
  let token: string;
  let otherToken: string;
  let cookie: string;
  let projectId: string;
  let projectKey: string;
  let firstRunnerId: string;
  let secondRunnerId: string;
  const repositoryKey = `coordination-${crypto.randomUUID()}`;
  const firstCheckout = `checkout-a-${crypto.randomUUID()}`;
  const secondCheckout = `checkout-b-${crypto.randomUUID()}`;

  beforeAll(async () => {
    await createUser('runner-coordination@example.com', 'Runner Coordination', 'longenough1', 'member').catch(() => {});
    token = await mintTokenForUser('runner-coordination@example.com');
    otherToken = await mintTokenForUser('runner-coordination@example.com');
    cookie = await loginSession('runner-coordination@example.com', 'longenough1');
    const project = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: `CO${crypto.randomUUID().slice(0, 6).toUpperCase()}`, name: 'Runner coordination' }),
    });
    const body = await project.json() as { id: string; key: string };
    projectId = body.id;
    projectKey = body.key;
    await authorizeForAllProjects(token);
    await authorizeForAllProjects(otherToken);
    const register = async (checkoutId: string) => {
      const response = await SELF.fetch('https://noriq.test/api/runners', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: checkoutId, maxConcurrency: 2,
          protocolCapabilities: ['runner-job.v2', RUNNER_COORDINATION_CAPABILITY],
          repos: [{ id: checkoutId, projectKey, repositoryKey }],
        }),
      });
      expect(response.status).toBe(200);
      const runnerId = ((await response.json()) as { runner: { id: string } }).runner.id;
      const row = await env.DB.prepare('SELECT repos FROM runners WHERE id = ?')
        .bind(runnerId).first<{ repos: string }>();
      const repos = (JSON.parse(row!.repos) as Array<Record<string, unknown>>).map((repo) => ({
        ...repo, repoRef: checkoutId, vcs: 'git', baseRevision: 'a'.repeat(40),
      }));
      await env.DB.prepare('UPDATE runners SET repos = ? WHERE id = ?')
        .bind(JSON.stringify(repos), runnerId).run();
      return runnerId;
    };
    firstRunnerId = await register(firstCheckout);
    secondRunnerId = await register(secondCheckout);
  }, 60_000);

  async function commissioned(runnerId: string, checkoutId: string, title: string) {
    const taskResponse = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/tasks`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    const task = await taskResponse.json() as { id: string };
    const dispatch = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/tasks/${task.id}/runner-jobs`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runnerId, repoRef: checkoutId }),
    });
    expect(dispatch.status).toBe(201);
    const job = (await dispatch.json() as { job: { id: string; assignmentId: string } }).job;
    const room = projectRoom<RoomRpc>(projectId);
    await room.assignRunnerJob(projectId, job.id, runnerId);
    expect(await room.acceptRunnerJob(projectId, job.id, runnerId, job.assignmentId)).toBe(true);
    return { taskId: task.id, ...job };
  }

  const post = (operation: string, body: unknown, bearer = token) => SELF.fetch(
    `https://noriq.test/api/runner-coordination/${operation}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );

  const acquisition = (
    runnerId: string, checkoutId: string,
    job: { id: string; assignmentId: string; taskId: string },
    idempotencyKey: string, kind: 'repository' | 'paths' | 'landing', paths: string[] = [],
  ) => ({
    runnerId, checkoutId, projectId, jobId: job.id, assignmentId: job.assignmentId,
    taskId: job.taskId, idempotencyKey, repositoryKey, lane: 'main', kind, paths, ttlSeconds: 90,
  });

  async function requestManualLanding(
    runnerId: string,
    job: { id: string; assignmentId: string; taskId: string },
  ): Promise<string> {
    const at = new Date().toISOString();
    const checkpoint = { ref: 'c'.repeat(40), label: `retained/${job.taskId}`, url: null };
    const room = projectRoom<RoomRpc>(projectId);
    expect(await room.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 1, {
      type: 'task.result', at, taskId: job.taskId, status: 'accepted', checkpoint,
      summary: 'reviewed', findings: [],
    })).toMatchObject({ accepted: true });
    expect(await room.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 2, {
      type: 'terminal', at, status: 'succeeded',
      output: {
        workspaceMode: 'isolated', retainedLocation: { vcs: 'git', label: checkpoint.label, url: null },
        baseRevision: 'a'.repeat(40), headRevision: checkpoint.ref,
        acceptedTaskCheckpoints: { [job.taskId]: checkpoint }, checks: [], findings: [],
        usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUsd: 0, calls: 1 },
        summary: 'ready for human landing', dirtyPaths: [],
        landing: {
          policy: 'manual', status: 'retained', target: 'main', checkpoint: null,
          error: null, requestId: null,
        },
      },
    })).toMatchObject({ accepted: true });
    const request = await room.requestRunnerJobLanding(projectId, SYSTEM_ACTOR as Actor, job.id);
    expect(request).toMatchObject({ requestId: expect.any(String), target: 'main' });
    return request.requestId!;
  }

  it('permits only the exact live manual landing request after successful terminalization', async () => {
    const firstJob = await commissioned(firstRunnerId, firstCheckout, 'First manual landing');
    const secondJob = await commissioned(secondRunnerId, secondCheckout, 'Second manual landing');
    const firstRequestId = await requestManualLanding(firstRunnerId, firstJob);
    const secondRequestId = await requestManualLanding(secondRunnerId, secondJob);
    const landing = {
      ...acquisition(firstRunnerId, firstCheckout, firstJob, 'first:manual-land', 'landing'),
      taskId: null, landingRequestId: firstRequestId,
    };
    const expectRejected = async (body: unknown, bearer = token, status = 409) => {
      const response = await post('acquire', body, bearer);
      expect(response.status).toBe(status);
    };
    await expectRejected({ ...landing, landingRequestId: undefined });
    await expectRejected({ ...landing, landingRequestId: `land_${crypto.randomUUID()}` });
    await expectRejected({ ...landing, lane: 'release' });
    await expectRejected({ ...landing, repositoryKey: `wrong-${repositoryKey}` }, token, 404);
    await expectRejected({ ...landing, checkoutId: secondCheckout }, token, 404);
    await expectRejected({ ...landing, runnerId: secondRunnerId }, token, 404);
    await expectRejected({ ...landing, assignmentId: `asgn_${crypto.randomUUID()}` }, token, 404);
    await expectRejected({ ...landing, projectId: `prj_${crypto.randomUUID()}` }, token, 404);
    await expectRejected({ ...landing, taskId: firstJob.taskId });
    await expectRejected({ ...landing, kind: 'repository' });
    await expectRejected(landing, otherToken, 404);

    await env.DB.prepare("UPDATE runner_jobs SET landing_status = 'retained' WHERE id = ?")
      .bind(firstJob.id).run();
    await expectRejected(landing);
    await env.DB.prepare(
      "UPDATE runner_jobs SET landing_status = 'requested', landing_policy = 'auto' WHERE id = ?",
    ).bind(firstJob.id).run();
    await expectRejected(landing);
    await env.DB.prepare("UPDATE runner_jobs SET landing_policy = 'manual' WHERE id = ?")
      .bind(firstJob.id).run();

    const acquiredResponse = await post('acquire', landing);
    expect(acquiredResponse.status).toBe(200);
    const acquired = ((await acquiredResponse.json()) as {
      status: 'acquired'; lease: RunnerCoordinationLease;
    }).lease;
    expect(acquired).toMatchObject({
      kind: 'landing', lane: 'main', taskId: null, landingRequestId: firstRequestId,
    });
    expect(await (await post('acquire', landing)).json()).toMatchObject({
      status: 'acquired', lease: { leaseId: acquired.leaseId, fencingToken: acquired.fencingToken },
    });
    expect((await post('exchange', {
      lease: acquired,
      scope: { repositoryKey, lane: 'main', kind: 'landing', paths: [] },
      ttlSeconds: 90,
    })).status).toBe(409);

    const secondLanding = {
      ...acquisition(secondRunnerId, secondCheckout, secondJob, 'second:manual-land', 'landing'),
      taskId: null, landingRequestId: secondRequestId,
    };
    expect(await (await post('acquire', secondLanding)).json()).toEqual({
      status: 'conflict', retryAfterMs: 2_000, conflictingKind: 'landing',
    });

    const recoveredResponse = await post('recover', { ...acquired, ttlSeconds: 90 });
    expect(recoveredResponse.status).toBe(200);
    const recovered = ((await recoveredResponse.json()) as {
      status: 'acquired'; lease: RunnerCoordinationLease;
    }).lease;
    expect(recovered.fencingToken).toBeGreaterThan(acquired.fencingToken);
    expect(await (await post('recover', { ...acquired, ttlSeconds: 90 })).json()).toMatchObject({
      status: 'acquired', lease: { leaseId: recovered.leaseId, fencingToken: recovered.fencingToken },
    });
    expect((await post('renew', {
      leaseId: acquired.leaseId, fencingToken: acquired.fencingToken, ttlSeconds: 90,
    })).status).toBe(409);
    expect((await post('renew', {
      leaseId: recovered.leaseId, fencingToken: recovered.fencingToken, ttlSeconds: 90,
    })).status).toBe(200);
    expect((await post('renew', {
      leaseId: recovered.leaseId, fencingToken: recovered.fencingToken, ttlSeconds: 90,
    })).status).toBe(200);
    expect((await post('release', {
      leaseId: recovered.leaseId, fencingToken: recovered.fencingToken,
    })).status).toBe(200);
    expect((await post('recover', { ...recovered, ttlSeconds: 90 })).status).toBe(409);

    const secondAcquired = ((await (await post('acquire', secondLanding)).json()) as {
      status: 'acquired'; lease: RunnerCoordinationLease;
    }).lease;
    const room = projectRoom<RoomRpc>(projectId);
    expect(await room.recordRunnerJobLandingResult(
      projectId, secondJob.id, secondRunnerId, secondJob.assignmentId, secondRequestId,
      { status: 'failed', target: 'main', checkpoint: null, error: 'landing cancelled' },
    )).toEqual({ accepted: true, error: null });
    expect((await post('renew', {
      leaseId: secondAcquired.leaseId, fencingToken: secondAcquired.fencingToken, ttlSeconds: 90,
    })).status).toBe(409);
    expect(await env.DB.prepare(
      'SELECT released_at AS releasedAt FROM runner_coordination_leases WHERE lease_id = ?',
    ).bind(secondAcquired.leaseId).first()).toMatchObject({ releasedAt: expect.any(String) });

    const retried = await room.requestRunnerJobLanding(projectId, SYSTEM_ACTOR as Actor, secondJob.id);
    expect(retried.requestId).not.toBe(secondRequestId);
    await expectRejected(secondLanding);
    const retryLanding = { ...secondLanding, landingRequestId: retried.requestId! };
    const retryLease = ((await (await post('acquire', retryLanding)).json()) as {
      status: 'acquired'; lease: RunnerCoordinationLease;
    }).lease;
    expect(retryLease.fencingToken).toBeGreaterThan(secondAcquired.fencingToken);
    expect((await post('release', {
      leaseId: retryLease.leaseId, fencingToken: retryLease.fencingToken,
    })).status).toBe(200);
    expect((await post('release', {
      leaseId: retryLease.leaseId, fencingToken: retryLease.fencingToken,
    })).status).toBe(200);
  }, 60_000);

  it('serializes the conflict matrix with idempotent acquire/exchange and monotonic recovery fences', async () => {
    const firstJob = await commissioned(firstRunnerId, firstCheckout, 'First coordinated task');
    const secondJob = await commissioned(secondRunnerId, secondCheckout, 'Second coordinated task');
    const firstScope = acquisition(firstRunnerId, firstCheckout, firstJob, 'first:src', 'paths', ['src']);
    const secondScope = acquisition(secondRunnerId, secondCheckout, secondJob, 'second:docs', 'paths', ['docs']);

    const firstResponse = await post('acquire', firstScope);
    expect(firstResponse.status).toBe(200);
    const firstLease = ((await firstResponse.json()) as { status: 'acquired'; lease: RunnerCoordinationLease }).lease;
    const replay = await post('acquire', firstScope);
    expect(await replay.json()).toMatchObject({ status: 'acquired', lease: { leaseId: firstLease.leaseId, fencingToken: firstLease.fencingToken } });

    const secondResponse = await post('acquire', secondScope);
    const secondLease = ((await secondResponse.json()) as { status: 'acquired'; lease: RunnerCoordinationLease }).lease;
    expect(secondLease.paths).toEqual(['docs']);
    expect(secondLease.fencingToken).toBeGreaterThan(firstLease.fencingToken);

    const overlap = acquisition(secondRunnerId, secondCheckout, secondJob, 'second:src', 'paths', ['src/a.ts']);
    expect(await (await post('acquire', overlap)).json()).toEqual({
      status: 'conflict', retryAfterMs: 2_000, conflictingKind: 'paths',
    });
    expect(await env.DB.prepare('SELECT status FROM runner_jobs WHERE id = ?').bind(secondJob.id).first())
      .toEqual({ status: 'waiting' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM runner_coordination_waits WHERE job_id = ?')
      .bind(secondJob.id).first()).toEqual({ n: 1 });

    expect((await post('release', { leaseId: firstLease.leaseId, fencingToken: firstLease.fencingToken })).status).toBe(200);
    const acquiredOverlap = await post('acquire', overlap);
    const overlapLease = ((await acquiredOverlap.json()) as { status: 'acquired'; lease: RunnerCoordinationLease }).lease;
    expect(overlapLease.fencingToken).toBeGreaterThan(secondLease.fencingToken);
    expect(await env.DB.prepare('SELECT status FROM runner_jobs WHERE id = ?').bind(secondJob.id).first())
      .toEqual({ status: 'running' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM runner_coordination_waits WHERE job_id = ?')
      .bind(secondJob.id).first()).toEqual({ n: 0 });

    const landingExchange = await post('exchange', {
      lease: overlapLease,
      scope: { repositoryKey, lane: 'main', kind: 'landing', paths: [] },
      ttlSeconds: 90,
    });
    const landingLease = ((await landingExchange.json()) as { status: 'acquired'; lease: RunnerCoordinationLease }).lease;
    expect(landingLease.fencingToken).toBeGreaterThan(overlapLease.fencingToken);

    const firstOther = acquisition(firstRunnerId, firstCheckout, firstJob, 'first:other', 'paths', ['other']);
    const firstOtherLease = ((await (await post('acquire', firstOther)).json()) as {
      status: 'acquired'; lease: RunnerCoordinationLease;
    }).lease;
    const blockedExchange = await post('exchange', {
      lease: firstOtherLease,
      scope: { repositoryKey, lane: 'main', kind: 'landing', paths: [] },
      ttlSeconds: 90,
    });
    expect(await blockedExchange.json()).toEqual({
      status: 'conflict', retryAfterMs: 2_000, conflictingKind: 'landing',
    });
    expect(await env.DB.prepare(
      'SELECT kind, fencing_token AS fencingToken FROM runner_coordination_leases WHERE lease_id = ?',
    ).bind(firstOtherLease.leaseId).first()).toEqual({ kind: 'paths', fencingToken: firstOtherLease.fencingToken });

    await post('release', { leaseId: landingLease.leaseId, fencingToken: landingLease.fencingToken });
    const exchanged = await post('exchange', {
      lease: firstOtherLease,
      scope: { repositoryKey, lane: 'main', kind: 'landing', paths: [] },
      ttlSeconds: 90,
    });
    const exchangedLease = ((await exchanged.json()) as { status: 'acquired'; lease: RunnerCoordinationLease }).lease;
    expect(exchangedLease.fencingToken).toBeGreaterThan(firstOtherLease.fencingToken);

    const exchangeReplay = await post('exchange', {
      lease: firstOtherLease,
      scope: { repositoryKey, lane: 'main', kind: 'landing', paths: [] },
      ttlSeconds: 90,
    });
    expect(exchangeReplay.status).toBe(200);
    expect((await exchangeReplay.json()) as { status: string; lease: RunnerCoordinationLease }).toMatchObject({
      status: 'acquired',
      lease: { leaseId: exchangedLease.leaseId, fencingToken: exchangedLease.fencingToken },
    });

    const recovered = await post('recover', { ...exchangedLease, ttlSeconds: 90 });
    const recoveredLease = ((await recovered.json()) as { status: 'acquired'; lease: RunnerCoordinationLease }).lease;
    expect(recoveredLease.fencingToken).toBeGreaterThan(exchangedLease.fencingToken);
    expect((await post('renew', {
      leaseId: exchangedLease.leaseId, fencingToken: exchangedLease.fencingToken, ttlSeconds: 90,
    })).status).toBe(409);
    expect((await post('renew', {
      leaseId: recoveredLease.leaseId, fencingToken: recoveredLease.fencingToken, ttlSeconds: 90,
    })).status).toBe(200);

    const waitingJob = await commissioned(secondRunnerId, secondCheckout, 'Cancelled coordination wait');
    const repositoryWait = acquisition(
      secondRunnerId, secondCheckout, waitingJob, 'waiting:repository', 'repository', [],
    );
    expect(await (await post('acquire', repositoryWait)).json()).toEqual({
      status: 'conflict', retryAfterMs: 2_000, conflictingKind: 'paths',
    });
    expect(await env.DB.prepare('SELECT status FROM runner_jobs WHERE id = ?').bind(waitingJob.id).first())
      .toEqual({ status: 'waiting' });
    const room = projectRoom<RoomRpc>(projectId);
    await room.cancelRunnerJob(projectId, SYSTEM_ACTOR as Actor, waitingJob.id);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM runner_coordination_waits WHERE job_id = ?')
      .bind(waitingJob.id).first()).toEqual({ n: 0 });

    expect((await post('release', {
      leaseId: recoveredLease.leaseId, fencingToken: recoveredLease.fencingToken,
    }, otherToken)).status).toBe(404);

    await room.cancelRunnerJob(projectId, SYSTEM_ACTOR as Actor, firstJob.id);
    expect(await env.DB.prepare(
      'SELECT released_at AS releasedAt FROM runner_coordination_leases WHERE lease_id = ?',
    ).bind(recoveredLease.leaseId).first()).toMatchObject({ releasedAt: expect.any(String) });
    expect((await post('release', {
      leaseId: recoveredLease.leaseId, fencingToken: recoveredLease.fencingToken,
    })).status).toBe(200);
    await room.cancelRunnerJob(projectId, SYSTEM_ACTOR as Actor, firstJob.id);

    const withoutCapability = await SELF.fetch('https://noriq.test/api/runners', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runnerId: firstRunnerId, label: firstCheckout, maxConcurrency: 2,
        protocolCapabilities: ['runner-job.v2'],
        repos: [{ id: firstCheckout, projectKey, repositoryKey }],
      }),
    });
    expect(withoutCapability.status).toBe(200);
    const rejected = await post('acquire', firstScope);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ error: 'runner.coordination.v1 was not registered' });
  }, 60_000);
});
