import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import {
  ANALYTICS_EXTRACTION_VERSION,
  PROJECT_INTELLIGENCE_RECORD_LIFECYCLE,
  analyticsSourceWatermarks,
  getProjectAnalyticsHealth,
  rebuildProjectAnalytics,
  requestProjectAnalyticsRebuild,
} from '../src/memory/analytics';
import { createAgent, mcpCall } from './helpers';

const appEnv = env as unknown as Env;

interface MemoryRpc {
  recordEpisode(projectId: string, input: Record<string, unknown>): Promise<{ episodeId: string }>;
  beginAnalyticsGeneration(projectId: string, input: {
    extractionVersion: string; d1EventWatermark: number | null;
    orchestrationWatermark: string | null; force: boolean;
  }): Promise<{ generationId: string; unchanged: boolean }>;
  failAnalyticsGeneration(projectId: string, generationId: string, error: string): Promise<void>;
  pruneAnalyticsGenerations(projectId: string, maxBuildingAgeMs: number): Promise<{ pruned: number; abandoned: number }>;
  exportSnapshot(projectId: string): Promise<
    { ok: true; manifest: { exportedAt: string } } | { ok: false; reason: string }
  >;
  restoreSnapshot(projectId: string, input: { exportedAt: string }): Promise<{ ok: boolean; reason?: string }>;
  reconcile(projectId: string): Promise<unknown>;
  _clearAnalyticsForTest(projectId: string): Promise<void>;
  _getAnalyticsForTest(projectId: string): Promise<{
    activeGenerationId: string | null;
    generations: Array<{ id: string; status: string }>;
  }>;
}

const memory = (projectId: string) => appEnv.PROJECT_MEMORY.get(
  appEnv.PROJECT_MEMORY.idFromName(projectId),
) as unknown as MemoryRpc;

const legacyEpisode = (runId: string, findings: Array<{ summary: string }> = []) => ({
  runId, sitting: 1, agentId: null, runKind: 'build', outcome: 'done',
  startedAt: null, finishedAt: null, taskId: null, repositoryKey: null, baseId: null,
  timeline: [], filesTouched: [], commands: [], testsRun: [], failures: [], findings,
  reviewRounds: 0, tokenUsage: {}, costUSD: 0, acceptanceCoverage: null,
  steeringEvents: [], landingOutcome: 'pending', remainingWork: [],
  actor: { kind: 'system', id: null },
});

let owner: { apiKey: string };

beforeAll(async () => {
  owner = await createAgent('project-intelligence-lifecycle');
}, 60_000);

describe('Project Intelligence lifecycle and health (PLNR-293)', () => {
  it('distinguishes not-started, complete, stale, failed, and building source state', async () => {
    const projectId = (await mcpCall(owner.apiKey, 'create_project', {
      key: 'PIHLTH', name: 'Project intelligence health',
    })).body.id as string;

    expect(await getProjectAnalyticsHealth(appEnv, projectId)).toMatchObject({
      state: 'not_started', active: null, staleSources: [],
      storage: { canonicalRetainedRows: 0, disposableDerivedRows: 0 },
    });

    await memory(projectId).recordEpisode(projectId, legacyEpisode('run_health'));
    await memory(projectId).reconcile(projectId);
    const built = await rebuildProjectAnalytics(appEnv, projectId, { force: true });
    const complete = await getProjectAnalyticsHealth(appEnv, projectId);
    expect(complete).toMatchObject({
      state: 'complete',
      active: { id: built.generationId, state: 'complete' },
      staleSources: [],
      lastSuccessfulFullRebuildAt: expect.any(String),
      storage: { canonicalRetainedRows: 1 },
    });
    expect(complete.storage.byKind.analyticsSnapshotRows).toBe(0);

    await memory(projectId).recordEpisode(projectId, legacyEpisode('run_health', [{ summary: 'changed' }]));
    await memory(projectId).reconcile(projectId);
    const stale = await getProjectAnalyticsHealth(appEnv, projectId);
    expect(stale.state).toBe('stale');
    expect(stale.staleSources).toContain('project_memory');
    expect(stale.lag.memoryRevisions).toBeGreaterThan(0);

    const sources = await analyticsSourceWatermarks(appEnv, projectId);
    const replacement = await memory(projectId).beginAnalyticsGeneration(projectId, {
      extractionVersion: ANALYTICS_EXTRACTION_VERSION,
      d1EventWatermark: sources.eventWatermark,
      orchestrationWatermark: sources.orchestrationWatermark,
      force: true,
    });
    expect((await getProjectAnalyticsHealth(appEnv, projectId)).state).toBe('building');
    await memory(projectId).failAnalyticsGeneration(projectId, replacement.generationId, 'injected lifecycle failure');
    const failed = await getProjectAnalyticsHealth(appEnv, projectId);
    expect(failed).toMatchObject({
      state: 'failed',
      active: { id: built.generationId },
      latestFailure: { id: replacement.generationId, error: 'injected lifecycle failure' },
    });
  });

  it('rebuilds disposable loss, bounds retained generations, and queues rebuild after restore', async () => {
    const projectId = (await mcpCall(owner.apiKey, 'create_project', {
      key: 'PILIFE', name: 'Project intelligence lifecycle',
    })).body.id as string;
    await memory(projectId).recordEpisode(projectId, legacyEpisode('run_lifecycle'));
    await memory(projectId).reconcile(projectId);
    const exported = await memory(projectId).exportSnapshot(projectId);
    if (!exported.ok) throw new Error(exported.reason);

    const first = await rebuildProjectAnalytics(appEnv, projectId, { force: true });
    await memory(projectId)._clearAnalyticsForTest(projectId);
    expect((await getProjectAnalyticsHealth(appEnv, projectId)).state).toBe('not_started');
    const repaired = await rebuildProjectAnalytics(appEnv, projectId, { force: true });
    expect(repaired.checksum).toBe(first.checksum);

    await rebuildProjectAnalytics(appEnv, projectId, { force: true });
    await rebuildProjectAnalytics(appEnv, projectId, { force: true });
    const pruned = await memory(projectId).pruneAnalyticsGenerations(projectId, 24 * 60 * 60 * 1_000);
    expect(pruned.pruned).toBeGreaterThan(0);
    const retained = await memory(projectId)._getAnalyticsForTest(projectId);
    expect(retained.generations.filter((generation) => generation.status === 'complete')).toHaveLength(2);

    const restored = await memory(projectId).restoreSnapshot(projectId, { exportedAt: exported.manifest.exportedAt });
    expect(restored.ok).toBe(true);
    const afterRestore = await getProjectAnalyticsHealth(appEnv, projectId);
    expect(afterRestore).toMatchObject({ state: 'not_started', active: null, retry: { pending: true } });
    expect(afterRestore.storage.byKind.episodes).toBe(1);
    expect(afterRestore.storage.byKind.analyticsRows).toBe(0);
  });

  it('defines canonical adjuncts as project-lifetime backup records and derived rows as rebuildable', async () => {
    expect(PROJECT_INTELLIGENCE_RECORD_LIFECYCLE).toEqual({
      commissioningFacts: { authority: 'd1', retention: 'project_lifetime', backup: 'd1_logical_snapshot' },
      qualityEvents: { authority: 'd1', retention: 'project_lifetime', backup: 'd1_logical_snapshot' },
      similarityFeedback: { authority: 'd1', retention: 'project_lifetime', backup: 'd1_logical_snapshot' },
      shadowSnapshots: { authority: 'd1', retention: 'project_lifetime', backup: 'd1_logical_snapshot' },
      analyticsGenerations: { authority: 'derived', retention: 'bounded_replaceable', backup: 'rebuild' },
    });

    const projectId = (await mcpCall(owner.apiKey, 'create_project', {
      key: 'PIRETRY', name: 'Project intelligence retry',
    })).body.id as string;
    await requestProjectAnalyticsRebuild(appEnv, projectId);
    await appEnv.DB.prepare(
      `UPDATE memory_analytics_jobs SET attempts = 3, last_error = 'old failure',
              last_attempt_at = ?, next_retry_at = ? WHERE project_id = ?`,
    ).bind(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString(), projectId).run();
    await requestProjectAnalyticsRebuild(appEnv, projectId);
    expect(await getProjectAnalyticsHealth(appEnv, projectId)).toMatchObject({
      retry: { pending: true, attempts: 0, lastError: null, lastAttemptAt: null, nextRetryAt: null },
    });
  });
});
