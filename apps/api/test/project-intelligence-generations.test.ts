import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProjectIntelligenceEpisode } from '@noriq-dev/shared';
import type { Actor, CreateRunInput, RunPatch, RunView } from '../src/do/ProjectRoom';
import type { Env } from '../src/env';
import { applyExecutionEvent, declareExecution } from '../src/lib/orchestration-store';
import { rebuildProjectAnalytics } from '../src/memory/analytics';
import { recordEpisodeForRun } from '../src/memory/episodes';
import { createAgent, mcpCall } from './helpers';

const appEnv = env as unknown as Env;
const actor: Actor = { kind: 'human', id: 'usr_analytics_test', name: 'Analytics Test' };

interface RoomRpc {
  createRun(projectId: string, actor: Actor, input: CreateRunInput): Promise<RunView>;
  transitionRun(projectId: string, actor: Actor, runId: string, patch: RunPatch): Promise<RunView>;
  reopenRun(projectId: string, actor: Actor, runId: string, rounds: number | null): Promise<RunView>;
}
interface MemoryRpc {
  recordEpisode(projectId: string, input: Record<string, unknown>): Promise<{ episodeId: string }>;
  beginAnalyticsGeneration(projectId: string, input: {
    extractionVersion: string; d1EventWatermark: number | null; orchestrationWatermark: string | null; force: boolean;
  }): Promise<{ generationId: string; unchanged: boolean }>;
  failAnalyticsGeneration(projectId: string, generationId: string, error: string): Promise<void>;
  _getAnalyticsForTest(projectId: string): Promise<{
    activeGenerationId: string | null;
    generations: Array<{
      id: string; status: string; baseGenerationId: string | null;
      checksum: string | null; rowCount: number; error: string | null;
    }>;
    rows: Array<{ generationId: string; runId: string; sitting: number; normalized: Record<string, unknown> }>;
  }>;
  _clearAnalyticsForTest(projectId: string): Promise<void>;
  reconcile(projectId: string): Promise<{ delivered: number; failed: number; applied: number; cursor: number }>;
}
const room = (projectId: string) => appEnv.PROJECT_ROOM.get(appEnv.PROJECT_ROOM.idFromName(projectId)) as unknown as RoomRpc;
const memory = (projectId: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(projectId)) as unknown as MemoryRpc;
const at = (seconds: number) => new Date(Date.parse('2026-08-09T12:00:00.000Z') + seconds * 1_000).toISOString();

let owner: { id: string; apiKey: string };

beforeAll(async () => {
  owner = await createAgent('project-intelligence-generations');
}, 60_000);

describe('versioned Project Intelligence generations (PLNR-292)', () => {
  it('rebuilds equivalent output, keeps sittings separate, coalesces parked time, and never activates failure', async () => {
    const projectId = (await mcpCall(owner.apiKey, 'create_project', {
      key: 'PIGEN', name: 'Project intelligence generation test',
    })).body.id as string;
    const taskId = (await mcpCall(owner.apiKey, 'create_task', {
      projectId, title: 'continued analytics work', tags: ['analytics-test'],
    })).body.id as string;
    const runnerId = 'rnr_pi_gen';
    await env.DB.prepare(
      `INSERT INTO runners (id, label, status, repos) VALUES (?, ?, 'online', ?)`,
    ).bind(runnerId, runnerId, JSON.stringify([{ id: 'repo' }])).run();
    for (const agentId of ['agt_pi_gen_1', 'agt_pi_gen_2']) {
      await env.DB.prepare(
        `INSERT INTO agents (id, name, kind, runner_id, project_id) VALUES (?, ?, 'agent', ?, ?)`,
      ).bind(agentId, agentId, runnerId, projectId).run();
    }

    const run = await room(projectId).createRun(projectId, actor, {
      kind: 'build', repoRef: 'repo', agentTool: 'codex', runnerId,
      anchor: { type: 'task', id: taskId },
    });
    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'running', agentId: 'agt_pi_gen_1' });
    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'failed' });
    await room(projectId).reopenRun(projectId, actor, run.id, null);

    const sitting = await env.DB.prepare(
      `SELECT id, orchestration_id AS orchestrationId FROM execution_nodes
        WHERE run_id = ? AND sitting = 2 AND kind = 'sitting'`,
    ).bind(run.id).first<{ id: string; orchestrationId: string }>();
    const parent = await declareExecution(appEnv, {
      projectId, orchestrationId: sitting!.orchestrationId, parentExecutionId: sitting!.id,
      producerScope: `test/${run.id}/2`, localNodeKey: 'review-parent', kind: 'stage', role: 'reviewer',
      subject: { taskId, runId: run.id, sitting: 2, stage: 'review' }, observedAt: at(0),
    });
    const child = await declareExecution(appEnv, {
      projectId, orchestrationId: sitting!.orchestrationId, parentExecutionId: parent.id,
      producerScope: `test/${run.id}/2`, localNodeKey: 'verify-leaf', kind: 'step', role: 'verifier',
      subject: { taskId, runId: run.id, sitting: 2, stage: 'verify', step: 'tests' }, observedAt: at(10),
    });
    const event = async (executionId: string, revision: number, type: 'started' | 'parked' | 'resumed' | 'succeeded', seconds: number) =>
      applyExecutionEvent(appEnv, {
        projectId, orchestrationId: sitting!.orchestrationId, executionId,
        eventId: `evt_${executionId}_${revision}`, revision, type, observedAt: at(seconds),
      });
    await event(parent.id, 1, 'started', 0);
    await event(parent.id, 2, 'parked', 20);
    await event(parent.id, 3, 'resumed', 60);
    await event(child.id, 1, 'started', 10);
    await event(child.id, 2, 'parked', 30);
    await event(child.id, 3, 'resumed', 50);
    await event(child.id, 4, 'succeeded', 60);
    await event(parent.id, 4, 'succeeded', 100);

    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'running', agentId: 'agt_pi_gen_2' });
    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'done' });
    await recordEpisodeForRun(appEnv, projectId, run.id);

    // An old canonical episode has no PLNR-291 envelope. Extraction must retain it honestly.
    await memory(projectId).recordEpisode(projectId, {
      runId: 'run_legacy_pi', sitting: 1, agentId: null, runKind: 'build', outcome: 'done',
      startedAt: null, finishedAt: null, taskId: null, repositoryKey: null, baseId: null,
      timeline: [], filesTouched: [], commands: [], testsRun: [], failures: [], findings: [],
      reviewRounds: 0, tokenUsage: {}, costUSD: 0, acceptanceCoverage: null,
      steeringEvents: [], landingOutcome: 'pending', remainingWork: [],
      actor: { kind: 'system', id: null },
    });
    await memory(projectId).reconcile(projectId);

    const first = await rebuildProjectAnalytics(appEnv, projectId, { force: true, pageSize: 1 });
    expect(first.rowCount).toBe(3); // two sittings plus one legacy episode
    const firstState = await memory(projectId)._getAnalyticsForTest(projectId);
    expect(firstState.activeGenerationId).toBe(first.generationId);
    const sittingRows = firstState.rows.filter((row) => row.generationId === first.generationId && row.runId === run.id);
    expect(sittingRows.map((row) => row.sitting)).toEqual([1, 2]);
    const sitting2 = ProjectIntelligenceEpisode.parse(sittingRows[1]!.normalized);
    expect(sitting2.execution.stages).toHaveLength(1); // leaf only: parent time is not double-counted
    expect(sitting2.execution.stages[0]).toMatchObject({ executionId: child.id, role: 'verifier' });
    expect(sitting2.execution.clocks.humanBlockedMs).toMatchObject({ status: 'complete', value: 40_000 });
    expect(sitting2.execution.clocks.verifyDurationMs).toMatchObject({ status: 'complete', value: 50_000 });
    const legacy = ProjectIntelligenceEpisode.parse(firstState.rows.find((row) => row.runId === 'run_legacy_pi')!.normalized);
    expect(legacy.identity.lineage.status).toBe('partial');
    expect(legacy.execution.observedModelUsage).toMatchObject({ status: 'unavailable', value: null });

    const unchanged = await rebuildProjectAnalytics(appEnv, projectId);
    expect(unchanged).toMatchObject({ generationId: first.generationId, checksum: first.checksum, unchanged: true });

    // Change one canonical episode. The next generation seeds from the active one and replaces
    // only the row whose source fingerprint changed.
    await memory(projectId).recordEpisode(projectId, {
      runId: 'run_legacy_pi', sitting: 1, agentId: null, runKind: 'build', outcome: 'done',
      startedAt: null, finishedAt: null, taskId: null, repositoryKey: null, baseId: null,
      timeline: [], filesTouched: [], commands: [], testsRun: [], failures: [],
      findings: [{ summary: 'new canonical evidence' }], reviewRounds: 0, tokenUsage: {}, costUSD: 0,
      acceptanceCoverage: null, steeringEvents: [], landingOutcome: 'pending', remainingWork: [],
      actor: { kind: 'system', id: null },
    });
    await memory(projectId).reconcile(projectId);
    const incremental = await rebuildProjectAnalytics(appEnv, projectId);
    expect(incremental).toMatchObject({ rowCount: 3, unchanged: false });
    expect((await memory(projectId)._getAnalyticsForTest(projectId)).generations
      .find((generation) => generation.id === incremental.generationId)).toMatchObject({
        status: 'complete', baseGenerationId: first.generationId,
      });

    // Delete every disposable row and reconstruct byte-equivalent normalized output/checksum.
    await memory(projectId)._clearAnalyticsForTest(projectId);
    const rebuilt = await rebuildProjectAnalytics(appEnv, projectId, { force: true, pageSize: 2 });
    expect(rebuilt.checksum).toBe(incremental.checksum);
    expect(rebuilt.rowCount).toBe(incremental.rowCount);
    expect((await memory(projectId)._getAnalyticsForTest(projectId)).activeGenerationId).toBe(rebuilt.generationId);

    // A building/failed replacement never moves the active pointer, and coordination continues.
    const failed = await memory(projectId).beginAnalyticsGeneration(projectId, {
      extractionVersion: 'broken-test', d1EventWatermark: null, orchestrationWatermark: null, force: true,
    });
    expect((await memory(projectId)._getAnalyticsForTest(projectId)).activeGenerationId).toBe(rebuilt.generationId);
    await room(projectId).createRun(projectId, actor, { kind: 'scope', repoRef: 'repo', agentTool: 'codex' });
    await memory(projectId).failAnalyticsGeneration(projectId, failed.generationId, 'injected rebuild failure');
    const failedState = await memory(projectId)._getAnalyticsForTest(projectId);
    expect(failedState.activeGenerationId).toBe(rebuilt.generationId);
    expect(failedState.generations.find((generation) => generation.id === failed.generationId)).toMatchObject({
      status: 'failed', error: 'injected rebuild failure',
    });
  });
});
