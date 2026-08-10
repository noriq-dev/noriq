import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ProjectIntelligenceEpisode,
  ProjectQualityEvent,
  type ProjectIntelligenceEpisode as IntelligenceEpisode,
} from '@noriq-dev/shared';
import type {
  Actor, CreateRunInput, RecordQualityEventInput, RecordedQualityEvent, RunPatch, RunView, TaskPatch,
} from '../src/do/ProjectRoom';
import type { Env } from '../src/env';
import { aggregateHistoricalAnalytics, type HistoricalAnalyticsResult } from '../src/memory/analytics-query';
import { rebuildProjectAnalytics } from '../src/memory/analytics';
import { createAgent, mcpCall } from './helpers';

const appEnv = env as unknown as Env;
const actor: Actor = { kind: 'human', id: 'usr_quality_test', name: 'Quality Test' };

interface RoomRpc {
  updateTask(projectId: string, actor: Actor, taskId: string, patch: TaskPatch): Promise<unknown>;
  deleteTask(projectId: string, actor: Actor, taskId: string): Promise<unknown>;
  recordQualityEvent(projectId: string, actor: Actor, input: RecordQualityEventInput): Promise<RecordedQualityEvent>;
  createRun(projectId: string, actor: Actor, input: CreateRunInput): Promise<RunView>;
  transitionRun(projectId: string, actor: Actor, runId: string, patch: RunPatch): Promise<RunView>;
  reopenRun(projectId: string, actor: Actor, runId: string, rounds: number | null): Promise<RunView>;
}
const room = (projectId: string) => appEnv.PROJECT_ROOM.get(
  appEnv.PROJECT_ROOM.idFromName(projectId),
) as unknown as RoomRpc;
interface MemoryRpc {
  _clearAnalyticsForTest(projectId: string): Promise<void>;
  queryHistoricalAnalytics(projectId: string, query: Record<string, unknown>): Promise<HistoricalAnalyticsResult>;
}
const memory = (projectId: string) => appEnv.PROJECT_MEMORY.get(
  appEnv.PROJECT_MEMORY.idFromName(projectId),
) as unknown as MemoryRpc;

const metric = (value: number) => ({
  status: 'complete' as const, value, provenance: 'runner_observed' as const,
  source: 'runner' as const, sourceId: null, observedAt: '2026-01-01T00:00:00.000Z',
  acceptedAt: '2026-01-01T00:00:00.000Z', reason: null,
});

function landedEpisode(capturedAt: string): IntelligenceEpisode {
  return ProjectIntelligenceEpisode.parse({
    schemaVersion: 1,
    identity: {
      episodeId: 'epi_quality', projectId: 'prj_quality_unit', runId: 'run_quality', sitting: 1,
      taskId: 'task_quality', planId: null, planDispatchId: null, orchestrationId: null,
      executionId: null, repositoryKey: null, branch: null, baseId: null,
      lineage: { status: 'complete', missing: [], reason: null },
    },
    sources: { memoryRevision: 1, coordinationEventSequence: 2, orchestrationAcceptedAt: null, capturedAt },
    versions: { extraction: 'quality-test', retrieval: null, risk: null, comparison: null },
    preExecution: {
      task: { taskType: 'feature', tags: [], executionSpecFingerprint: null, capturedAt },
      requestedStrategy: null, commissionedStrategy: null, commissionedSpec: null,
      budget: null, configuration: [],
    },
    execution: {
      executedStrategy: null, executedSpec: null,
      observedModelUsage: {
        status: 'unavailable', value: null, provenance: 'unavailable', source: 'runner',
        sourceId: null, observedAt: null, acceptedAt: null, reason: 'not reported',
      },
      clocks: {
        queueDurationMs: metric(0), dispatchToStartMs: metric(0), elapsedExecutionMs: metric(1),
        humanBlockedMs: metric(0), verifyDurationMs: metric(0),
      },
      stages: [],
      changes: {
        backend: null, changedFiles: metric(0), additions: metric(0), deletions: metric(0), churn: metric(0),
      },
    },
    outcome: { runOutcome: 'done', landingOutcome: 'landed', reviewRounds: metric(0), acceptanceCoverage: metric(1) },
  });
}

const generation: HistoricalAnalyticsResult['generation'] = {
  id: 'ang_quality', extractionVersion: 'quality-test', completedAt: '2026-02-15T00:00:00.000Z',
  memoryRevision: 1, coordinationEventSequence: 2, orchestrationWatermark: null,
  completeness: { status: 'complete', reasons: [] },
};

let owner: { id: string; apiKey: string };
beforeAll(async () => { owner = await createAgent('project-intelligence-quality'); }, 60_000);

describe('downstream quality evidence (PLNR-297)', () => {
  it('keeps the immediate landing outcome immutable and reports a mature stability horizon separately', () => {
    const episode = landedEpisode('2026-01-01T00:00:00.000Z');
    const quality = ProjectQualityEvent.parse({
      schemaVersion: 1, id: 'qev_quality', operationKey: 'quality-op', projectId: 'prj_quality_unit',
      type: 'work_reverted', taskId: 'task_quality', relatedTaskId: null,
      runId: 'run_quality', sitting: 1, episodeId: 'epi_quality', orchestrationId: null,
      executionId: null, artifactRef: 'commit:deadbeef',
      source: { kind: 'explicit_user_action', eventId: null, eventSequence: null },
      actor: { kind: 'human', id: 'usr_quality' }, observedAt: '2026-01-10T00:00:00.000Z',
      provenance: { note: 'explicit revert record, not inferred causality' },
    });
    const result = aggregateHistoricalAnalytics({
      episodes: [episode], qualityEvents: [quality], scannedRows: 1, truncated: false,
      qualityEventsTruncated: false,
      query: { from: '2025-12-31T00:00:00.000Z', to: generation.completedAt, qualityHorizonDays: 30 },
      generation, observedAt: generation.completedAt,
    });
    expect(result.groups[0]!.outcomes.landed).toEqual({ numerator: 1, denominator: 1, rate: 1 });
    expect(result.groups[0]!.outcomes.laterInstability).toMatchObject({
      status: 'complete', count: 1, eventCount: 1, denominator: 1, rate: 1,
      horizonDays: 30, eventTypeCounts: { task_reopened: 0, work_reverted: 1, regression_task_linked: 0 },
    });
    expect(episode.outcome.landingOutcome).toBe('landed');
  });

  it('does not classify a continued failed sitting as reopened, but records a deliberate done-to-active transition', async () => {
    const projectId = (await mcpCall(owner.apiKey, 'create_project', {
      key: 'PIQUAL', name: 'Project intelligence quality events',
    })).body.id as string;
    const taskId = (await mcpCall(owner.apiKey, 'create_task', {
      projectId, title: 'quality lifecycle task', tags: ['analytics-test'],
    })).body.id as string;
    const runnerId = 'rnr_pi_quality';
    const agentId = 'agt_pi_quality';
    await appEnv.DB.batch([
      appEnv.DB.prepare(`INSERT INTO runners (id, label, status, repos) VALUES (?, ?, 'online', ?)`)
        .bind(runnerId, runnerId, JSON.stringify([{ id: 'repo-quality' }])),
      appEnv.DB.prepare(`INSERT INTO agents (id, name, kind, runner_id, project_id) VALUES (?, ?, 'agent', ?, ?)`)
        .bind(agentId, agentId, runnerId, projectId),
    ]);
    const run = await room(projectId).createRun(projectId, actor, {
      kind: 'build', repoRef: 'repo-quality', agentTool: 'codex', runnerId,
      anchor: { type: 'task', id: taskId },
    });
    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'running', agentId });
    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'failed' });
    await room(projectId).reopenRun(projectId, actor, run.id, null);
    expect((await appEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM project_quality_events WHERE project_id = ? AND event_type = 'task_reopened'`,
    ).bind(projectId).first<{ n: number }>())!.n).toBe(0);

    await room(projectId).updateTask(projectId, actor, taskId, { status: 'done' });
    await room(projectId).updateTask(projectId, actor, taskId, { status: 'todo' });
    const reopened = await appEnv.DB.prepare(
      `SELECT run_id AS runId, sitting, event_type AS type FROM project_quality_events
        WHERE project_id = ? AND event_type = 'task_reopened'`,
    ).bind(projectId).first<{ runId: string; sitting: number; type: string }>();
    expect(reopened).toEqual({ runId: run.id, sitting: 2, type: 'task_reopened' });
  });

  it('is append-only and idempotent, requires typed evidence, and survives task deletion', async () => {
    const projectId = (await mcpCall(owner.apiKey, 'create_project', {
      key: 'PIQAPP', name: 'Append only quality evidence',
    })).body.id as string;
    const taskId = (await mcpCall(owner.apiKey, 'create_task', {
      projectId, title: 'work later reverted', tags: ['analytics-test'],
    })).body.id as string;
    const relatedTaskId = (await mcpCall(owner.apiKey, 'create_task', {
      projectId, title: 'explicit regression', tags: ['analytics-test'],
    })).body.id as string;
    const input: RecordQualityEventInput = {
      operationKey: 'revert-op-1', type: 'work_reverted', taskId, artifactRef: 'commit:abc123',
      provenance: { referenceKind: 'commit' },
    };
    const first = await room(projectId).recordQualityEvent(projectId, actor, input);
    expect(first.deduped).toBe(false);
    await expect(room(projectId).recordQualityEvent(projectId, actor, input))
      .resolves.toMatchObject({ id: first.id, deduped: true });
    await expect(room(projectId).recordQualityEvent(projectId, actor, {
      ...input, artifactRef: 'commit:different',
    })).rejects.toThrow('already used for different evidence');
    expect(await appEnv.DB.prepare(
      `SELECT 1 FROM events WHERE project_id = ? AND verb = 'quality.event_rejected'`,
    ).bind(projectId).first()).toBeTruthy();
    await expect(room(projectId).recordQualityEvent(projectId, actor, {
      operationKey: 'missing-artifact', type: 'work_reverted', taskId,
    } as RecordQualityEventInput)).rejects.toThrow('requires an explicit artifactRef');
    await room(projectId).recordQualityEvent(projectId, actor, {
      operationKey: 'regression-op-1', type: 'regression_task_linked', taskId, relatedTaskId,
    });
    await room(projectId).deleteTask(projectId, actor, taskId);
    const retained = await appEnv.DB.prepare(
      `SELECT operation_key AS operationKey, task_id AS taskId FROM project_quality_events
        WHERE project_id = ? ORDER BY operation_key`,
    ).bind(projectId).all<{ operationKey: string; taskId: string }>();
    expect(retained.results).toEqual([
      { operationKey: 'regression-op-1', taskId },
      { operationKey: 'revert-op-1', taskId },
    ]);
    const firstBuild = await rebuildProjectAnalytics(appEnv, projectId, { force: true, pageSize: 1 });
    const query = await memory(projectId).queryHistoricalAnalytics(projectId, {});
    expect(query.coverage).toMatchObject({ qualityEventsScanned: 2, unassociatedQualityEvents: 2, complete: false });
    await memory(projectId)._clearAnalyticsForTest(projectId);
    const rebuilt = await rebuildProjectAnalytics(appEnv, projectId, { force: true, pageSize: 1 });
    expect(rebuilt.checksum).toBe(firstBuild.checksum);
  });
});
