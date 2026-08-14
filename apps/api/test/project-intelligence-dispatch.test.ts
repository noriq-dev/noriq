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
  it('preserves derived failed status and retry readiness in the full packet (PLNR-514)', async () => {
    const projectId = (await mcpCall(owner.apiKey, 'create_project', {
      key: 'PIFAIL', name: 'Failed dispatch intelligence',
    })).body.id as string;
    const taskId = (await mcpCall(owner.apiKey, 'create_task', {
      projectId, title: 'Retry through an IDE Copilot', tags: ['analytics-test'],
    })).body.id as string;
    const failedAt = '2026-08-14T00:00:00.000Z';
    await appEnv.DB.prepare("UPDATE tasks SET failed_at = ? WHERE id = ? AND status = 'todo'")
      .bind(failedAt, taskId).run();

    const full = await mcpCall(owner.apiKey, 'get_task_intelligence', {
      projectId, taskId, executorMode: 'copilot',
    });
    expect(full.isError).toBe(false);
    expect(full.body.current.readiness).toMatchObject({
      taskId, status: 'failed', primary: 'ready',
      claimability: { claimable: true, reasonCode: 'claimable' },
      reason: expect.stringMatching(/failed work is ready for retry/),
    });
    expect(await appEnv.DB.prepare('SELECT status, failed_at AS failedAt FROM tasks WHERE id = ?')
      .bind(taskId).first()).toEqual({ status: 'todo', failedAt });
  });

  it('serves a validated executor-aware packet and bounded summary to MCP Copilots', async () => {
    const projectId = (await mcpCall(owner.apiKey, 'create_project', {
      key: 'PICOP', name: 'Copilot intelligence',
    })).body.id as string;
    const taskId = (await mcpCall(owner.apiKey, 'create_task', {
      projectId, title: 'Build through an IDE Copilot', tags: ['analytics-test'],
      executionSpec: {
        anticipatedFiles: [{ path: 'apps/api/src/mcp.ts', change: 'modify', why: 'expose intelligence' }],
      },
    })).body.id as string;
    await appEnv.DB.prepare(
      `INSERT INTO project_repositories (id, project_id, repository_key, created_at)
       VALUES ('prp_picop', ?, 'noriq', datetime('now'))`,
    ).bind(projectId).run();

    const full = await mcpCall(owner.apiKey, 'get_task_intelligence', {
      projectId, taskId, executorMode: 'copilot', repositoryKey: 'noriq', branch: 'main', baseId: 'copilot-base',
    });
    expect(full.isError).toBe(false);
    expect(full.body).toMatchObject({
      advisory: true,
      targetContext: { taskId, executorMode: 'copilot', repositoryKey: 'noriq', repositoryResolutionReason: null },
      current: { readiness: { primary: 'ready' } },
    });

    const context = await mcpCall(owner.apiKey, 'get_task_context', {
      projectId, taskId, repositoryKey: 'noriq', branch: 'main', baseId: 'copilot-base', budgetTokens: 500,
    });
    expect(context.isError).toBe(false);
    expect(context.body.intelligenceSummary).toMatchObject({
      advisory: true, available: true, executorMode: 'copilot',
      repository: { key: 'noriq', reason: null },
      readiness: { taskId, primary: 'ready' },
      fullPacketTool: 'get_task_intelligence',
    });
    expect(context.body.intelligenceSummary).not.toHaveProperty('quotedEvidence');

    const unregistered = await mcpCall(owner.apiKey, 'get_task_intelligence', {
      projectId, taskId, executorMode: 'copilot', repositoryKey: 'not-this-project',
    });
    expect(unregistered.isError).toBe(false);
    expect(unregistered.body.targetContext).toMatchObject({
      repositoryKey: null, repositoryResolutionReason: 'repository key is not registered to this project',
    });
  });

  it('loads an explicitly opened completed task outside the bounded open-task inventory', async () => {
    const projectId = (await mcpCall(owner.apiKey, 'create_project', {
      key: 'PIDONE', name: 'Completed dispatch intelligence',
    })).body.id as string;
    const created = await mcpCall(owner.apiKey, 'create_task', {
      projectId, title: 'Inspect completed mobile fix', tags: ['analytics-test'],
      executionSpec: {
        anticipatedFiles: [{ path: 'apps/web/src/components/Drawer.tsx', change: 'modify', why: 'mobile fix' }],
      },
    });
    const taskId = created.body.id as string;
    const taskKey = created.body.key as string;
    await appEnv.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").bind(taskId).run();

    const result = await getDispatchIntelligence(appEnv, projectId, { taskId });

    expect(result.current.readiness).toMatchObject({
      taskId, taskKey, status: 'done', primary: 'unknown',
      claimability: { claimable: false, reasonCode: 'status' },
    });
    expect(result.current.coverage.reasons).not.toContain('focus_task_not_supplied');
    expect(result.targetContext.taskId).toBe(taskId);
  });

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
