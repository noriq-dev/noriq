import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { getDispatchIntelligence } from '../src/memory/dispatch-intelligence';
import { createAgent, mcpCall } from './helpers';

const appEnv = env as unknown as Env;
interface MemoryRpc {
  recordEpisode(projectId: string, input: Record<string, unknown>): Promise<{ episodeId: string }>;
  reconcile(projectId: string): Promise<unknown>;
}
const memory = (projectId: string) => appEnv.PROJECT_MEMORY.get(
  appEnv.PROJECT_MEMORY.idFromName(projectId),
) as unknown as MemoryRpc;
let owner: { apiKey: string };
beforeAll(async () => { owner = await createAgent('dispatch-intelligence'); }, 60_000);

describe('dispatch-time Project Intelligence (PLNR-303)', () => {
  it('returns case cards and honest lock uncertainty without writing preview calibration rows', async () => {
    const projectId = (await mcpCall(owner.apiKey, 'create_project', { key: 'PIDISP', name: 'Dispatch intelligence' })).body.id as string;
    const taskId = (await mcpCall(owner.apiKey, 'create_task', {
      projectId, title: 'Repair shared dispatch cache', body: 'Prevent stale dispatch cache reuse.', tags: ['analytics-test'],
      executionSpec: { anticipatedFiles: [{ path: 'apps/api/src/dispatch-cache.ts', change: 'modify', why: 'repair cache' }] },
    })).body.id as string;
    const now = new Date().toISOString();
    for (let index = 1; index <= 3; index++) {
      await memory(projectId).recordEpisode(projectId, {
        runId: `run_dispatch_prior_${index}`, sitting: 1, agentId: null, runKind: 'build', outcome: index === 1 ? 'failed' : 'done',
        startedAt: now, finishedAt: now, taskId, taskTitle: `Repair shared dispatch cache attempt ${index}`,
        repositoryKey: null, baseId: null, timeline: [], filesTouched: ['apps/api/src/dispatch-cache.ts'], commands: [], testsRun: [],
        failures: index === 1 ? ['stale dispatch cache reused'] : [], findings: [{ summary: 'shared dispatch cache repair' }],
        reviewRounds: index, tokenUsage: {}, costUSD: 0, acceptanceCoverage: null, steeringEvents: [],
        landingOutcome: index === 1 ? 'failed' : 'landed', remainingWork: [],
        selfSummary: { approachSummary: `repair shared dispatch cache approach ${index}`, rejectedHypotheses: [], durableLearnings: [], unresolvedQuestions: [] },
        actor: { kind: 'system', id: null },
      });
    }
    await memory(projectId).reconcile(projectId);
    const before = await appEnv.DB.prepare('SELECT COUNT(*) AS count FROM similar_effort_occurrences WHERE project_id = ?')
      .bind(projectId).first<{ count: number }>();
    const result = await getDispatchIntelligence(appEnv, projectId, {
      taskId, budget: { maxTokens: 1000, maxUsd: null, maxDurationSeconds: null, maxRounds: null },
    });
    const after = await appEnv.DB.prepare('SELECT COUNT(*) AS count FROM similar_effort_occurrences WHERE project_id = ?')
      .bind(projectId).first<{ count: number }>();
    expect(result).toMatchObject({
      advisory: true, version: 'dispatch-intelligence-v1',
      feedback: { requiresExplicitHumanAction: true, previewCreatesOccurrence: false },
      current: { collisions: { locking: { status: 'unanswerable', enabled: false, current: [] } } },
      targetContext: { repositoryKey: null, repositoryResolutionReason: 'runner checkout context was not supplied' },
    });
    expect(result.current.coverage.reasons).toContain('locking_disabled');
    expect(result.historical.cases).toHaveLength(3);
    expect(result.historical.cases.map((item) => `${item.runId}/${item.sitting}`)).toEqual(expect.arrayContaining([
      'run_dispatch_prior_1/1', 'run_dispatch_prior_2/1', 'run_dispatch_prior_3/1',
    ]));
    expect(result.historical.cases.every((item) => item.retrieval.support.length > 0)).toBe(true);
    expect(after?.count).toBe(before?.count ?? 0);
  });
});
