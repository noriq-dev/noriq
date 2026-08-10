import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProjectIntelligenceEpisode, type ProjectIntelligenceEpisode as IntelligenceEpisode } from '@noriq-dev/shared';
import type { Env } from '../src/env';
import { aggregateHistoricalAnalytics, type HistoricalAnalyticsResult } from '../src/memory/analytics-query';
import { getCurrentProjectFlowSummary, rebuildProjectAnalytics } from '../src/memory/analytics';
import { createAgent, mcpCall } from './helpers';

const appEnv = env as unknown as Env;
const at = '2026-08-09T12:00:00.000Z';
const unavailable = {
  status: 'unavailable' as const, value: null, provenance: 'unavailable' as const,
  source: 'runner' as const, sourceId: null, observedAt: null, acceptedAt: null, reason: 'not reported',
};
const metric = (value: number) => ({
  status: 'complete' as const, value, provenance: 'runner_observed' as const,
  source: 'runner' as const, sourceId: null, observedAt: at, acceptedAt: at, reason: null,
});

function episode(sitting: number, role: 'worker' | 'reviewer', stageTokens: number): IntelligenceEpisode {
  return ProjectIntelligenceEpisode.parse({
    schemaVersion: 1,
    identity: {
      episodeId: `epi_description_${sitting}`, projectId: 'prj_description', runId: 'run_description', sitting,
      taskId: 'task_original', planId: 'plan_original', planDispatchId: 'dispatch_original',
      orchestrationId: 'orc_original', executionId: `exe_${sitting}`,
      lineage: { status: 'complete', missing: [], reason: null },
    },
    sources: { memoryRevision: 2, coordinationEventSequence: 8, capturedAt: at },
    versions: { extraction: 'test-v1' },
    preExecution: {
      task: { taskType: 'feature', tags: ['analytics'], executionSpecFingerprint: 'spec-original', capturedAt: at },
      requestedStrategy: { tool: 'claude', workflow: 'original-workflow' },
      commissionedStrategy: { tool: 'claude', workflow: 'original-workflow' },
      budget: { maxTokens: 50, maxUsd: 1, maxDurationSeconds: 60, maxRounds: 1 },
      configuration: [{ kind: 'workflow', name: 'original-workflow', version: 'v1', fingerprint: 'fp-original' }],
    },
    execution: {
      executedStrategy: { tool: 'claude', workflow: 'executed-workflow' },
      observedModelUsage: {
        status: 'complete',
        value: { model: { inputTokens: stageTokens, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: stageTokens / 100 } },
        provenance: 'runner_observed', source: 'runner', sourceId: null, observedAt: at, acceptedAt: at, reason: null,
      },
      clocks: {
        queueDurationMs: metric(0), dispatchToStartMs: metric(1_000), elapsedExecutionMs: metric(90_000),
        humanBlockedMs: metric(0), verifyDurationMs: unavailable,
      },
      stages: [{
        executionId: `stage_${sitting}`, kind: 'stage', role, stage: role,
        elapsedMs: metric(1_000), tokens: metric(stageTokens), costUSD: metric(stageTokens / 100),
      }],
      changes: {
        backend: 'git', changedFiles: metric(2), additions: metric(3), deletions: metric(1), churn: metric(4),
      },
    },
    outcome: { runOutcome: 'done', landingOutcome: 'landed', reviewRounds: metric(2), acceptanceCoverage: metric(1) },
  });
}

const generation: HistoricalAnalyticsResult['generation'] = {
  id: 'ang_description', extractionVersion: 'test-v1', completedAt: at, memoryRevision: 2,
  coordinationEventSequence: 8, orchestrationWatermark: '{"eventCount":2}',
  completeness: { status: 'complete', reasons: [] },
};

interface MemoryRpc {
  recordEpisode(projectId: string, input: Record<string, unknown>): Promise<{ episodeId: string }>;
  reconcile(projectId: string): Promise<unknown>;
  queryHistoricalAnalytics(projectId: string, query: Record<string, unknown>): Promise<HistoricalAnalyticsResult>;
}
const memory = (projectId: string) => appEnv.PROJECT_MEMORY.get(
  appEnv.PROJECT_MEMORY.idFromName(projectId),
) as unknown as MemoryRpc;

const legacyEpisode = (runId: string, sitting: number) => ({
  runId, sitting, agentId: null, runKind: 'build', outcome: 'done', startedAt: null, finishedAt: null,
  taskId: null, repositoryKey: null, baseId: null, timeline: [], filesTouched: [], commands: [],
  testsRun: [], failures: [], findings: [], reviewRounds: 0, tokenUsage: {}, costUSD: 0,
  acceptanceCoverage: null, steeringEvents: [], landingOutcome: 'pending', remainingWork: [],
  actor: { kind: 'system', id: null },
});

let owner: { id: string; apiKey: string };
beforeAll(async () => { owner = await createAgent('project-intelligence-descriptive'); }, 60_000);

describe('descriptive Project Intelligence queries (PLNR-294)', () => {
  it('rolls up by sitting without counting nested stages and exposes explicit composition denominators', () => {
    const result = aggregateHistoricalAnalytics({
      episodes: [episode(1, 'reviewer', 38), episode(2, 'worker', 62)],
      scannedRows: 2, truncated: false, query: { from: at, to: at }, generation, observedAt: at,
    });
    const aggregate = result.groups[0]!;
    expect(aggregate.sample).toEqual({ sittings: 2, runs: 1 });
    expect(aggregate.composition.reviewRepairTokenShare).toMatchObject({ value: 38, denominator: 100, share: 0.38 });
    expect(aggregate.metrics.tokens).toMatchObject({ observedCount: 2, denominator: 2, median: 50, total: 100 });
    expect(aggregate.metrics.budgetTokenUse!.max).toBeCloseTo(1.24); // ratios may honestly exceed budget
    expect(aggregate.supportingCases[0]).toMatchObject({ taskId: 'task_original', orchestrationId: 'orc_original' });
  });

  it('reads only the active completed generation and paginates canonical sitting cases', async () => {
    const projectId = (await mcpCall(owner.apiKey, 'create_project', {
      key: 'PIDESC', name: 'Project intelligence descriptive query',
    })).body.id as string;
    await memory(projectId).recordEpisode(projectId, legacyEpisode('run_continued', 1));
    await memory(projectId).recordEpisode(projectId, legacyEpisode('run_continued', 2));
    await memory(projectId).recordEpisode(projectId, legacyEpisode('run_other', 1));
    await memory(projectId).reconcile(projectId);
    const built = await rebuildProjectAnalytics(appEnv, projectId, { force: true });

    const first = await memory(projectId).queryHistoricalAnalytics(projectId, { caseLimit: 1 });
    expect(first.generation.id).toBe(built.generationId);
    expect(first.groups[0]!.sample).toEqual({ sittings: 3, runs: 2 });
    expect(first.cases).toMatchObject({ total: 3, items: [{ sitting: 1 }] });
    expect(first.cases.nextCursor).toEqual(expect.any(String));
    const second = await memory(projectId).queryHistoricalAnalytics(projectId, {
      caseLimit: 1, caseCursor: first.cases.nextCursor,
    });
    expect(second.cases.items[0]!.episodeId).not.toBe(first.cases.items[0]!.episodeId);
    await expect(memory(projectId).queryHistoricalAnalytics(projectId, { caseCursor: 'epi_missing' }))
      .rejects.toThrow('cursor is not present');
  });

  it('observes current D1 flow independently of historical generations', async () => {
    const projectId = (await mcpCall(owner.apiKey, 'create_project', {
      key: 'PICURR', name: 'Project intelligence current flow',
    })).body.id as string;
    const readyTask = (await mcpCall(owner.apiKey, 'create_task', {
      projectId, title: 'ready task', tags: ['analytics-test'],
    })).body.id as string;
    await mcpCall(owner.apiKey, 'create_task', { projectId, title: 'blocked task', tags: ['analytics-test'] });
    const blockedTask = await appEnv.DB.prepare(
      `SELECT id FROM tasks WHERE project_id = ? AND id != ? ORDER BY created_at DESC LIMIT 1`,
    ).bind(projectId, readyTask).first<{ id: string }>();
    await appEnv.DB.prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").bind(blockedTask!.id).run();
    const future = new Date(Date.now() + 60_000).toISOString();
    await appEnv.DB.batch([
      appEnv.DB.prepare(
        `INSERT INTO claims (id, task_id, agent_id, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      ).bind('clm_pi_current', readyTask, owner.id, at, future),
      appEnv.DB.prepare(
        `INSERT INTO file_locks
          (id, project_id, agent_id, task_id, kind, raw_pattern, canon_pattern, branch, all_branches, acquired_at, expires_at)
         VALUES (?, ?, ?, ?, 'file', 'src/a.ts', 'src/a.ts', 'main', 0, ?, ?)`,
      ).bind('lck_pi_current', projectId, owner.id, readyTask, at, future),
      appEnv.DB.prepare(
        `INSERT INTO orchestrations
          (id, project_id, anchor_type, anchor_id, status, completeness_status, created_by_kind, created_by_id, created_at, updated_at)
         VALUES ('orc_pi_current', ?, 'task', ?, 'parked', 'complete', 'system', 'test', ?, ?)`,
      ).bind(projectId, readyTask, at, at),
      appEnv.DB.prepare(
        `INSERT INTO execution_nodes
          (id, orchestration_id, project_id, kind, role, task_id, status, completeness_status, created_at, updated_at)
         VALUES ('exe_pi_current', 'orc_pi_current', ?, 'stage', 'worker', ?, 'parked', 'complete', ?, ?)`,
      ).bind(projectId, readyTask, at, at),
    ]);
    const summary = await getCurrentProjectFlowSummary(appEnv, projectId);
    expect(summary.source).toBe('d1_current_state');
    expect(summary.readiness).toMatchObject({ totalTasks: 2, readyTasks: 1, blockedTasks: 1 });
    expect(summary.coordination).toEqual({ activeClaims: 1, activeLocks: 1 });
    expect(summary.execution).toMatchObject({ parkedNodes: 1, nodeStatuses: { parked: 1 } });
    expect(summary.observedAt).toEqual(expect.any(String));
  });
});
