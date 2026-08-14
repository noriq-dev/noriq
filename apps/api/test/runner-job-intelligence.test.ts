import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Actor, CreateRunnerJobInput, RunnerJobView } from '../src/do/ProjectRoom';
import type { Env } from '../src/env';
import {
  pruneRunnerJobDetails, recordEpisodesForRunnerJob,
} from '../src/memory/episodes';
import { createUser, loginSession, projectRoom, SYSTEM_ACTOR } from './helpers';

interface RoomRpc {
  createTask(projectId: string, actor: Actor, input: { title: string }): Promise<{ id: string; key: string }>;
  createRunnerJob(projectId: string, actor: Actor, input: CreateRunnerJobInput): Promise<RunnerJobView>;
  assignRunnerJob(projectId: string, jobId: string, runnerId: string): Promise<{ assignmentId: string } | null>;
  acceptRunnerJob(projectId: string, jobId: string, runnerId: string, assignmentId: string): Promise<boolean>;
  recordRunnerJobEvent(
    projectId: string, jobId: string, runnerId: string, assignmentId: string,
    seq: number, event: unknown,
  ): Promise<{ accepted: boolean; ack: number; error: string | null }>;
  requestRunnerJobLanding(projectId: string, actor: Actor, jobId: string): Promise<{
    requestId: string | null; target: string | null;
  }>;
  recordRunnerJobLandingResult(
    projectId: string, jobId: string, runnerId: string, assignmentId: string,
    requestId: string, result: {
      status: 'landed' | 'failed'; target: string;
      checkpoint: { ref: string; label: string; url: string | null } | null;
      error: string | null;
    },
  ): Promise<{ accepted: boolean; error: string | null }>;
}

interface MemoryRpc {
  _getEpisodeForTest(projectId: string, runId: string, sitting?: number): Promise<Record<string, unknown> | null>;
}

const appEnv = env as unknown as Env;
const revision = 'd'.repeat(40);
let projectId: string;
let runnerId: string;
let room: RoomRpc;
let cookie: string;

const actor = {
  kind: 'agent' as const, driver: 'codex', vendor: 'openai', model: 'gpt-test',
  effort: 'medium', role: 'build', operation: 'invoke',
};
const complete = (value: number) => ({ status: 'complete' as const, value, provenance: 'driver_reported' as const });
const notApplicable = () => ({ status: 'not_applicable' as const, value: null, provenance: 'derived' as const });
const usage = (input: number, output: number, cost: number) => ({
  inputTokens: complete(input), outputTokens: complete(output),
  cacheReadTokens: complete(0), cacheWriteTokens: complete(0),
  calls: complete(1), costUsd: complete(cost),
});
const evidence = (changedPathCount: number | null) => ({
  operationDigest: null, resultDigest: null, exitCode: null, timedOut: null,
  changedPathCount, blockerFindings: null, majorFindings: null, minorFindings: null,
  checkpointRef: null, errorCode: null,
});

beforeAll(async () => {
  await createUser('runner-job-intelligence@example.com', 'Runner Intelligence', 'longenough1', 'member').catch(() => {});
  cookie = await loginSession('runner-job-intelligence@example.com', 'longenough1');
  const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind('runner-job-intelligence@example.com').first<{ id: string }>();
  const response = await SELF.fetch('https://noriq.test/api/projects', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: `RJI${crypto.randomUUID().slice(0, 5).toUpperCase()}`, name: 'runner intelligence projection' }),
  });
  projectId = ((await response.json()) as { id: string }).id;
  runnerId = `rnr_int_${crypto.randomUUID()}`;
  await env.DB.prepare(
    "INSERT INTO runners (id, owner_user_id, label, status, repos) VALUES (?, ?, 'intelligence-runner', 'online', ?)",
  ).bind(runnerId, user!.id, JSON.stringify([{
    id: 'repo', repoRef: 'repo', projectId, repositoryKey: 'repo', baseRevision: revision,
  }])).run();
  room = projectRoom<RoomRpc>(projectId);
}, 60_000);

describe('RunnerJob durable intelligence projection (PLNR-510)', () => {
  it('creates one job summary, one task episode per plan task, and explicit unreallocated overhead', async () => {
    const first = await room.createTask(projectId, SYSTEM_ACTOR as Actor, { title: 'First projected task' });
    const second = await room.createTask(projectId, SYSTEM_ACTOR as Actor, { title: 'Second projected task' });
    const planId = `pln_${crypto.randomUUID()}`;
    const phaseId = `phs_${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO plans (id, project_id, title, status) VALUES (?, ?, 'Projection plan', 'active')")
        .bind(planId, projectId),
      env.DB.prepare("INSERT INTO phases (id, plan_id, title, \"order\") VALUES (?, ?, 'Build', 0)")
        .bind(phaseId, planId),
      env.DB.prepare('INSERT INTO phase_tasks (phase_id, task_id) VALUES (?, ?)').bind(phaseId, first.id),
      env.DB.prepare('INSERT INTO phase_tasks (phase_id, task_id) VALUES (?, ?)').bind(phaseId, second.id),
    ]);
    const job = await room.createRunnerJob(projectId, SYSTEM_ACTOR as Actor, {
      source: { kind: 'plan', id: planId }, runnerId, repoRef: 'repo', expectedBaseRevision: revision,
    });
    await room.assignRunnerJob(projectId, job.id, runnerId);
    await room.acceptRunnerJob(projectId, job.id, runnerId, job.assignmentId);
    const base = Date.parse('2026-08-13T12:00:00.000Z');
    const at = (offset: number) => new Date(base + offset).toISOString();
    let seq = 0;
    const report = (event: unknown) => room.recordRunnerJobEvent(
      projectId, job.id, runnerId, job.assignmentId, ++seq, event,
    );
    expect(await report({
      type: 'job.context', at: at(0), vcs: 'git', workspaceMode: 'isolated',
      landingPolicy: 'manual', agents: [{
        role: 'build', driver: 'codex', vendor: 'openai', model: 'gpt-test', effort: 'medium',
      }],
    })).toMatchObject({ accepted: true });
    expect(await report({
      type: 'stage.finished', at: at(1_000), startedAt: at(0), observationId: 'obs_overhead',
      taskId: null, stage: 'workspace', attempt: 1,
      actor: { ...actor, kind: 'vcs', driver: 'git', vendor: null, model: null, effort: null, role: null, operation: 'prepare' },
      outcome: 'succeeded', duration: complete(1_000),
      usage: {
        inputTokens: notApplicable(), outputTokens: notApplicable(), cacheReadTokens: notApplicable(),
        cacheWriteTokens: notApplicable(), calls: complete(1), costUsd: notApplicable(),
      }, recovery: 'none', evidence: evidence(0),
    })).toMatchObject({ accepted: true });
    for (const [task, start, input, output, cost] of [
      [first, 1_000, 100, 20, 0.25], [second, 3_000, 200, 40, 0.5],
    ] as const) {
      expect(await report({
        type: 'stage.finished', at: at(start + 1_000), startedAt: at(start),
        observationId: `obs_${task.id}`, taskId: task.id, stage: 'build', attempt: 1,
        actor, outcome: 'succeeded', duration: complete(1_000), usage: usage(input, output, cost),
        recovery: 'none', evidence: evidence(2),
      })).toMatchObject({ accepted: true });
      expect(await report({
        type: 'task.result', at: at(start + 1_100), taskId: task.id, status: 'accepted',
        checkpoint: { ref: revision, label: task.key, url: null }, summary: 'done', findings: [],
      })).toMatchObject({ accepted: true });
    }
    expect(await report({
      type: 'terminal', at: at(5_000), status: 'succeeded', output: {
        workspaceMode: 'isolated', retainedLocation: { vcs: 'git', label: 'worktree', url: null },
        baseRevision: revision, headRevision: revision,
        acceptedTaskCheckpoints: {
          [first.id]: { ref: revision, label: first.key, url: null },
          [second.id]: { ref: revision, label: second.key, url: null },
        },
        checks: [], findings: [],
        usage: { inputTokens: 300, outputTokens: 60, cachedTokens: 0, costUsd: 0.75, calls: 2 },
        summary: 'complete', dirtyPaths: [],
        landing: {
          policy: 'manual', status: 'retained', target: 'main', checkpoint: null,
          error: null, requestId: null,
        },
      },
    })).toMatchObject({ accepted: true });

    const projected = await recordEpisodesForRunnerJob(appEnv, projectId, job.id);
    expect(projected.episodeIds).toHaveLength(2);
    const summary = await env.DB.prepare(
      'SELECT task_count AS taskCount, task_episode_count AS episodeCount, usage, overhead FROM runner_job_intelligence_jobs WHERE job_id = ?',
    ).bind(job.id).first<{ taskCount: number; episodeCount: number; usage: string; overhead: string }>();
    expect(summary).toMatchObject({ taskCount: 2, episodeCount: 2 });
    const rollup = JSON.parse(summary!.usage) as any;
    for (const axis of ['durationMs', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'calls', 'costUsd']) {
      expect(rollup.total[axis].value).toBeCloseTo(
        (rollup.tasks[axis].value ?? 0) + (rollup.overhead[axis].value ?? 0),
      );
    }
    expect(JSON.parse(summary!.overhead)).toMatchObject({ observations: { observationCount: 1 } });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM runner_job_intelligence_tasks WHERE job_id = ?')
      .bind(job.id).first<{ n: number }>()).toEqual({ n: 2 });

    const intelligenceResponse = await SELF.fetch(
      `https://noriq.test/api/projects/${projectId}/runner-jobs/${job.id}/intelligence`,
      { headers: { Cookie: cookie } },
    );
    expect(intelligenceResponse.status).toBe(200);
    expect(await intelligenceResponse.json()).toMatchObject({
      state: 'available', job: { jobId: job.id, taskCount: 2, taskEpisodeCount: 2 },
      tasks: [{ taskId: first.id, episodeId: projected.episodeIds[0] }, { taskId: second.id }],
    });

    const memory = appEnv.PROJECT_MEMORY.get(
      appEnv.PROJECT_MEMORY.idFromName(projectId),
    ) as unknown as MemoryRpc;
    const firstRunId = `runner_job:${job.id}:task:${first.id}`;
    const firstEpisode = await memory._getEpisodeForTest(projectId, firstRunId, 1) as any;
    expect(firstEpisode).toMatchObject({
      id: projected.episodeIds[0], taskId: first.id, landingOutcome: 'pending',
      workSource: { kind: 'runner_job', jobId: job.id, scope: 'task', taskId: first.id },
      intelligence: { identity: { planId, orchestrationId: job.orchestrationId } },
    });

    const landing = await room.requestRunnerJobLanding(projectId, SYSTEM_ACTOR as Actor, job.id);
    expect(landing).toMatchObject({ requestId: expect.any(String), target: 'main' });
    expect(await room.recordRunnerJobLandingResult(
      projectId, job.id, runnerId, job.assignmentId, landing.requestId!, {
        status: 'landed', target: 'main', checkpoint: { ref: revision, label: 'main', url: null }, error: null,
      },
    )).toEqual({ accepted: true, error: null });
    const refreshed = await recordEpisodesForRunnerJob(appEnv, projectId, job.id);
    expect(refreshed.episodeIds).toEqual(projected.episodeIds);
    expect(await memory._getEpisodeForTest(projectId, firstRunId, 1)).toMatchObject({
      id: projected.episodeIds[0], landingOutcome: 'landed',
      intelligence: { outcome: { runOutcome: 'done', landingOutcome: 'landed' } },
    });

    await env.DB.prepare(
      `UPDATE runner_jobs SET finished_at = '2025-01-01T00:00:00.000Z',
              intelligence_finished_received_at = '2025-01-01T00:00:00.000Z'
        WHERE id = ?`,
    ).bind(job.id).run();
    expect(await pruneRunnerJobDetails(appEnv, new Date('2026-08-13T00:00:00.000Z'))).toBeGreaterThanOrEqual(1);
    expect(await env.DB.prepare('SELECT detail_pruned_at AS prunedAt FROM runner_jobs WHERE id = ?')
      .bind(job.id).first<{ prunedAt: string | null }>()).toMatchObject({ prunedAt: expect.any(String) });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM runner_job_observations WHERE job_id = ?')
      .bind(job.id).first<{ n: number }>()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM runner_job_intelligence_tasks WHERE job_id = ?')
      .bind(job.id).first<{ n: number }>()).toEqual({ n: 2 });
    expect(await memory._getEpisodeForTest(projectId, firstRunId, 1)).not.toBeNull();
    const activityResponse = await SELF.fetch(
      `https://noriq.test/api/projects/${projectId}/runner-jobs/${job.id}/activity`,
      { headers: { Cookie: cookie } },
    );
    const expiredActivity = await activityResponse.json() as { items: Array<Record<string, unknown>>; expired: boolean };
    expect(expiredActivity.expired).toBe(true);
    expect(expiredActivity.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'milestone', type: 'commissioned' }),
    ]));
    const detailResponse = await SELF.fetch(
      `https://noriq.test/api/projects/${projectId}/runner-jobs/${job.id}`,
      { headers: { Cookie: cookie } },
    );
    expect(await detailResponse.json()).toMatchObject({ job: { detailPrunedAt: expect.any(String) } });
  }, 60_000);

  it('projects adaptive routes and price basis idempotently while task progress stays task-scoped', async () => {
    const task = await room.createTask(projectId, SYSTEM_ACTOR as Actor, { title: 'Adaptive projected task' });
    const job = await room.createRunnerJob(projectId, SYSTEM_ACTOR as Actor, {
      source: { kind: 'task', id: task.id }, runnerId, repoRef: 'repo', expectedBaseRevision: revision,
    });
    await room.assignRunnerJob(projectId, job.id, runnerId);
    await room.acceptRunnerJob(projectId, job.id, runnerId, job.assignmentId);
    const at = '2026-08-14T12:00:00.000Z';
    const routeEvent = {
      type: 'agent.route', at,
      route: {
        taskId: task.id, role: 'build', attempt: 1, policyVersion: 'adaptive-v1',
        size: 'medium', risk: 'high', specCoverage: 'complete',
        reasons: ['risk.high'], candidateCount: 2, eligibleCount: 1,
        actor, decision: 'invoke',
      },
    };
    expect(await room.recordRunnerJobEvent(
      projectId, job.id, runnerId, job.assignmentId, 1, routeEvent,
    )).toMatchObject({ accepted: true, ack: 1 });
    expect(await room.recordRunnerJobEvent(
      projectId, job.id, runnerId, job.assignmentId, 1, routeEvent,
    )).toMatchObject({ accepted: true, ack: 1 });
    expect(await room.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 2, {
      type: 'progress', at, taskId: task.id, phase: 'building', message: 'task build', progress: 0.4,
    })).toMatchObject({ accepted: true, ack: 2 });
    expect(await env.DB.prepare(
      'SELECT phase, progress FROM runner_job_items WHERE job_id = ? AND task_id = ?',
    ).bind(job.id, task.id).first()).toEqual({ phase: 'building', progress: 0.4 });
    expect(await env.DB.prepare('SELECT phase FROM runner_jobs WHERE id = ?').bind(job.id).first())
      .toEqual({ phase: 'preparing' });
    const derivedUsage = {
      inputTokens: complete(100), outputTokens: complete(25),
      cacheReadTokens: notApplicable(), cacheWriteTokens: notApplicable(), calls: complete(1),
      costUsd: { status: 'partial' as const, value: 0.125, provenance: 'derived' as const },
    };
    const stageEvent = {
      type: 'stage.finished', at, startedAt: at, observationId: 'obs_adaptive', taskId: task.id,
      stage: 'build', attempt: 1, actor, outcome: 'succeeded', duration: complete(1_000),
      usage: derivedUsage,
      costBasis: {
        kind: 'api_list_estimate',
        priceSource: {
          provider: 'openai', catalog: 'official-api-list', fetchedAt: at, ageSeconds: 7_200, stale: true,
        },
      },
      recovery: 'none', evidence: evidence(1),
    };
    expect(await room.recordRunnerJobEvent(
      projectId, job.id, runnerId, job.assignmentId, 3, stageEvent,
    )).toMatchObject({ accepted: true, ack: 3 });
    expect(await room.recordRunnerJobEvent(
      projectId, job.id, runnerId, job.assignmentId, 3, stageEvent,
    )).toMatchObject({ accepted: true, ack: 3 });
    expect(await room.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 4, {
      ...stageEvent, observationId: 'obs_no_price', stage: 'review',
      usage: {
        ...derivedUsage,
        costUsd: { status: 'unavailable', value: null, provenance: 'not_reported' },
      },
      costBasis: undefined,
    })).toMatchObject({ accepted: true, ack: 4 });
    expect(await room.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 5, {
      type: 'task.result', at, taskId: task.id, status: 'accepted',
      checkpoint: { ref: revision, label: task.key, url: null }, summary: 'done', findings: [],
    })).toMatchObject({ accepted: true, ack: 5 });
    expect(await room.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 6, {
      type: 'terminal', at, status: 'succeeded', output: {
        workspaceMode: 'isolated', retainedLocation: { vcs: 'git', label: 'worktree', url: null },
        baseRevision: revision, headRevision: revision,
        acceptedTaskCheckpoints: { [task.id]: { ref: revision, label: task.key, url: null } },
        checks: [], findings: [],
        usage: { inputTokens: 100, outputTokens: 25, cachedTokens: 0, costUsd: null, calls: 1 },
        summary: 'complete', dirtyPaths: [],
      },
    })).toMatchObject({ accepted: true, ack: 6 });

    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM runner_job_routes WHERE job_id = ?')
      .bind(job.id).first<{ n: number }>()).toEqual({ n: 1 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM runner_job_observations WHERE job_id = ?')
      .bind(job.id).first<{ n: number }>()).toEqual({ n: 2 });
    expect(await env.DB.prepare('SELECT phase FROM runner_jobs WHERE id = ?').bind(job.id).first())
      .toEqual({ phase: 'finalizing' });

    const firstProjection = await recordEpisodesForRunnerJob(appEnv, projectId, job.id);
    const secondProjection = await recordEpisodesForRunnerJob(appEnv, projectId, job.id);
    expect(secondProjection).toEqual(firstProjection);
    const taskSummary = await env.DB.prepare(
      'SELECT usage, stages FROM runner_job_intelligence_tasks WHERE job_id = ? AND task_id = ?',
    ).bind(job.id, task.id).first<{ usage: string; stages: string }>();
    expect(JSON.parse(taskSummary!.usage).costUsd).toMatchObject({ status: 'partial', value: 0.125 });
    expect(JSON.parse(taskSummary!.stages)).toMatchObject({
      routes: [{ policyVersion: 'adaptive-v1', actor: { model: 'gpt-test' } }],
      build: {
        facts: [{
          route: { size: 'medium', risk: 'high', specCoverage: 'complete' },
          costBasis: { kind: 'api_list_estimate', priceSource: { stale: true, ageSeconds: 7_200 } },
          costUsd: { status: 'partial', value: 0.125, provenance: 'derived' },
        }],
      },
      review: { facts: [{ costBasis: null, costUsd: { status: 'unavailable', value: null } }] },
    });
    const memory = appEnv.PROJECT_MEMORY.get(
      appEnv.PROJECT_MEMORY.idFromName(projectId),
    ) as unknown as MemoryRpc;
    const episode = await memory._getEpisodeForTest(
      projectId, `runner_job:${job.id}:task:${task.id}`, 1,
    ) as any;
    expect(episode.intelligence.execution.stages).toHaveLength(2);
    expect(episode.intelligence.execution.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actor: expect.objectContaining({ model: 'gpt-test', effort: 'medium' }),
        route: expect.objectContaining({ policyVersion: 'adaptive-v1', size: 'medium', risk: 'high' }),
        costBasis: expect.objectContaining({ kind: 'api_list_estimate' }),
        costUSD: expect.objectContaining({ status: 'partial', value: 0.125, provenance: 'derived' }),
      }),
      expect.objectContaining({
        stage: 'review', costUSD: expect.objectContaining({ status: 'unavailable', value: null }),
      }),
    ]));
    const activity = await SELF.fetch(
      `https://noriq.test/api/projects/${projectId}/runner-jobs/${job.id}/activity?taskId=${task.id}`,
      { headers: { Cookie: cookie } },
    );
    expect(await activity.json()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          kind: 'milestone', type: 'agent_route', route: expect.objectContaining({ taskId: task.id }),
        }),
        expect.objectContaining({
          kind: 'stage', observationId: 'obs_adaptive',
          costBasis: expect.objectContaining({ kind: 'api_list_estimate' }),
        }),
      ]),
    });
  }, 60_000);

  it('merges exact-task memory consumption into the server-owned episode without a duplicate', async () => {
    const task = await room.createTask(projectId, SYSTEM_ACTOR as Actor, { title: 'Memory-context projected task' });
    const outside = await room.createTask(projectId, SYSTEM_ACTOR as Actor, { title: 'Outside memory task' });
    const job = await room.createRunnerJob(projectId, SYSTEM_ACTOR as Actor, {
      source: { kind: 'task', id: task.id }, runnerId, repoRef: 'repo', expectedBaseRevision: revision,
    });
    await room.assignRunnerJob(projectId, job.id, runnerId);
    await room.acceptRunnerJob(projectId, job.id, runnerId, job.assignmentId);
    const at = '2026-08-14T15:00:00.000Z';
    const consumption = {
      status: 'partial' as const,
      value: {
        mode: 'keyword' as const, role: 'build' as const, charBudget: 8_000, charsUsed: 2_400,
        sections: [{
          id: 'known_hazards' as const, excerptCount: 1, graphEntityCount: 0,
          truncated: true, unanswerable: false,
        }],
        similarEpisodesConsidered: 2, staleCitationsCount: 1, noticesCount: 1, retrievalTookMs: 35,
      },
      provenance: 'runner_observed' as const, source: 'runner' as const,
      sourceId: null, observedAt: at, acceptedAt: null, reason: 'bounded retrieval',
    };
    expect(await room.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 1, {
      type: 'memory.context', at, taskId: outside.id, packDigest: 'b'.repeat(64), generatedAt: at,
      consumption,
    })).toMatchObject({ accepted: false, ack: 0, error: 'event names a task outside the snapshot' });
    expect(await room.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 1, {
      type: 'memory.context', at, taskId: task.id, packDigest: 'a'.repeat(64), generatedAt: at,
      consumption,
    })).toMatchObject({ accepted: true, ack: 1 });
    expect(await room.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 2, {
      type: 'task.result', at, taskId: task.id, status: 'accepted',
      checkpoint: { ref: revision, label: task.key, url: null }, summary: 'done', findings: [],
    })).toMatchObject({ accepted: true, ack: 2 });
    expect(await room.recordRunnerJobEvent(projectId, job.id, runnerId, job.assignmentId, 3, {
      type: 'terminal', at, status: 'succeeded', output: {
        workspaceMode: 'isolated', retainedLocation: { vcs: 'git', label: 'worktree', url: null },
        baseRevision: revision, headRevision: revision,
        acceptedTaskCheckpoints: { [task.id]: { ref: revision, label: task.key, url: null } },
        checks: [], findings: [],
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: null, calls: 0 },
        summary: 'complete', dirtyPaths: [],
      },
    })).toMatchObject({ accepted: true, ack: 3 });

    const first = await recordEpisodesForRunnerJob(appEnv, projectId, job.id);
    const second = await recordEpisodesForRunnerJob(appEnv, projectId, job.id);
    expect(second).toEqual(first);
    expect(first.episodeIds).toHaveLength(1);
    const memory = appEnv.PROJECT_MEMORY.get(
      appEnv.PROJECT_MEMORY.idFromName(projectId),
    ) as unknown as MemoryRpc;
    const episode = await memory._getEpisodeForTest(
      projectId, `runner_job:${job.id}:task:${task.id}`, 1,
    ) as any;
    expect(episode.intelligence.contextConsumption).toMatchObject({
      status: 'partial', value: { mode: 'keyword', charsUsed: 2_400 },
      provenance: 'runner_observed', source: 'runner', sourceId: job.id,
      observedAt: at, acceptedAt: expect.any(String), reason: 'bounded retrieval',
    });
  });
});
