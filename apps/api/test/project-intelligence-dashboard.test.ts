import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { rebuildProjectAnalytics } from '../src/memory/analytics';
import { getProjectIntelligenceDashboard } from '../src/memory/intelligence-dashboard';
import { createAgent, mcpCall } from './helpers';

const appEnv = env as unknown as Env;
interface MemoryRpc {
  recordEpisode(projectId: string, input: Record<string, unknown>): Promise<{ episodeId: string }>;
  reconcile(projectId: string): Promise<unknown>;
}
const memory = (projectId: string) => appEnv.PROJECT_MEMORY.get(
  appEnv.PROJECT_MEMORY.idFromName(projectId),
) as unknown as MemoryRpc;
const episode = (runId: string) => ({
  runId, sitting: 1, agentId: null, runKind: 'build', outcome: 'done', startedAt: null, finishedAt: null,
  taskId: null, repositoryKey: null, baseId: null, timeline: [], filesTouched: [], commands: [], testsRun: [],
  failures: [], findings: [], reviewRounds: 0, tokenUsage: {}, costUSD: 0, acceptanceCoverage: null,
  steeringEvents: [], landingOutcome: 'pending', remainingWork: [], actor: { kind: 'system', id: null },
});

let owner: { apiKey: string };
beforeAll(async () => { owner = await createAgent('project-intelligence-dashboard'); }, 60_000);

describe('Project Intelligence dashboard packet (PLNR-302)', () => {
  it('keeps deterministic live evidence usable before any analytics generation exists', async () => {
    const projectId = (await mcpCall(owner.apiKey, 'create_project', { key: 'PIDASH', name: 'Dashboard' })).body.id as string;
    await mcpCall(owner.apiKey, 'create_task', { projectId, title: 'Ready now' });
    const to = new Date().toISOString();
    const packet = await getProjectIntelligenceDashboard(appEnv, projectId, {
      from: new Date(Date.parse(to) - 7 * 86_400_000).toISOString(), to, caseLimit: 10,
    });
    expect(packet.live).toMatchObject({ source: 'd1_current_state', readiness: { totalTasks: expect.any(Number), readyTasks: expect.any(Number) } });
    expect(packet.analytics).toMatchObject({
      health: { state: 'not_started' },
      historical: { state: 'unavailable', result: null },
      freshness: { state: 'unavailable', generationCompletedAt: null, gapMs: null },
    });
    expect(packet.comparison).toBeNull();
  });

  it('returns frozen cases and explicit clocks without blending them into live state', async () => {
    const projectId = (await mcpCall(owner.apiKey, 'create_project', { key: 'PIDSH2', name: 'Dashboard history' })).body.id as string;
    await memory(projectId).recordEpisode(projectId, episode('run_dashboard'));
    await memory(projectId).reconcile(projectId);
    await rebuildProjectAnalytics(appEnv, projectId, { force: true });
    const to = new Date().toISOString();
    const packet = await getProjectIntelligenceDashboard(appEnv, projectId, {
      from: new Date(Date.parse(to) - 30 * 86_400_000).toISOString(), to, caseLimit: 10,
    });
    expect(packet.analytics.historical.state).toBe('available');
    if (packet.analytics.historical.state !== 'available') throw new Error('expected history');
    expect(packet.analytics.historical.result.cases).toMatchObject({ total: 1, items: [{ runId: 'run_dashboard', sitting: 1 }] });
    expect(packet.analytics.freshness.liveObservedAt).toBe(packet.live.observedAt);
    expect(packet.analytics.freshness.generationCompletedAt).toBe(packet.analytics.historical.result.generation.completedAt);
    expect(packet.analytics.freshness.gapMs).not.toBeNull();
  });
});
