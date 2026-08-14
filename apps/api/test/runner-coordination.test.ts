import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { RUNNER_COORDINATION_CAPABILITY, type RunnerCoordinationLease } from '@noriq-dev/shared';
import type { Actor } from '../src/do/ProjectRoom';
import { authorizeForAllProjects, createUser, loginSession, mintTokenForUser, projectRoom, SYSTEM_ACTOR } from './helpers';

interface RoomRpc {
  assignRunnerJob(projectId: string, jobId: string, runnerId: string): Promise<unknown>;
  acceptRunnerJob(projectId: string, jobId: string, runnerId: string, assignmentId: string): Promise<boolean>;
  cancelRunnerJob(projectId: string, actor: Actor, jobId: string): Promise<unknown>;
}

describe('Runner coordination leases (PLNR-520)', () => {
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
