import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import type {
  ConstellationGenerationData, ConstellationGenerationStatus, ConstellationHierarchyDrift, ProjectMemoryHealth,
} from '../src/do/ProjectMemory';
import type { ConstellationV2Overview } from '../src/memory/constellation-v2';
import type { HierarchyGenerationData } from '../src/memory/constellation-hierarchy';

const appEnv = env as unknown as Env;
const SYSTEM = { kind: 'system', id: null };

interface MemoryRpc {
  health(pid: string): Promise<ProjectMemoryHealth>;
  writeNode(pid: string, input: { type: string; uri: string; label: string; actor: typeof SYSTEM }): Promise<{ nodeId: string }>;
  writeEdge(pid: string, input: { type: string; fromNodeId: string; toNodeId: string; actor: typeof SYSTEM }): Promise<{ edgeId: string }>;
  beginConstellationGeneration(pid: string, input: { topologyVersion: string; layoutVersion: string }): Promise<{ generationId: string; sourceRevision: number }>;
  stageConstellationGeneration(pid: string, generationId: string, data: ConstellationGenerationData): Promise<{ ok: true }>;
  completeConstellationGeneration(pid: string, generationId: string): Promise<{ ok: true }>;
  activateConstellationGeneration(pid: string, generationId: string): Promise<{ activated: string; superseded: string | null }>;
  failConstellationGeneration(pid: string, generationId: string, reason: string): Promise<{ ok: true }>;
  constellationGenerationStatus(pid: string, generationId?: string): Promise<ConstellationGenerationStatus | null>;
  rebuildConstellationHierarchy(pid: string): Promise<{ ok: boolean; generationId: string; nodes?: number; edges?: number }>;
  constellationHierarchyDrift(pid: string): Promise<ConstellationHierarchyDrift>;
  constellationV2Overview(pid: string): Promise<ConstellationV2Overview>;
  exportSnapshot(pid: string): Promise<{ ok: true; manifest: { exportedAt: string } } | { ok: false; reason: string }>;
  erase(pid: string): Promise<{ ok: true }>;
  restoreSnapshot(pid: string, opts: { exportedAt: string }): Promise<{ ok: true } | { ok: false; reason: string }>;
}

const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as MemoryRpc;

function generationData(a: string, b: string): ConstellationGenerationData {
  const lens = (name: 'plans' | 'memories', suffix: string): HierarchyGenerationData => ({
    lens: name,
    nodeStats: [
      { nodeId: a, degree: 1, weightedDegree: 1, rank: 1, boundaryDegree: 1 },
      { nodeId: b, degree: 1, weightedDegree: 1, rank: 0.5, boundaryDegree: 1 },
    ],
    communities: [
      { id: `com_a_${suffix}`, parentId: null, level: 0, label: 'A', coreNodeId: a, memberCount: 1, childCount: 0, typeCounts: { task: 1 }, internalEdgeCount: 0, internalWeight: 0, normalizedCohesion: 0, boundaryWeight: 1, anchor: [1, 2, 3] as [number, number, number] },
      { id: `com_b_${suffix}`, parentId: null, level: 0, label: 'B', coreNodeId: b, memberCount: 1, childCount: 0, typeCounts: { memory: 1 }, internalEdgeCount: 0, internalWeight: 0, normalizedCohesion: 0, boundaryWeight: 1, anchor: [4, 5, 6] as [number, number, number] },
    ],
    memberships: [
      { nodeId: a, communityId: `com_a_${suffix}`, level: 0 },
      { nodeId: b, communityId: `com_b_${suffix}`, level: 0 },
    ],
    ambientNodeIds: [],
    links: [
      { level: 0, fromCommunityId: `com_a_${suffix}`, toCommunityId: `com_b_${suffix}`, direction: 'forward' as const, count: 1, weight: 1, byType: { related_to: 1 } },
    ],
  });
  return { lenses: [lens('plans', 'plans'), lens('memories', 'memories')] };
}

describe('Constellation hierarchy generation storage', () => {
  it('stages and atomically selects a complete generation without changing canonical graph rows', async () => {
    const pid = 'prj_constellation_generation';
    const { nodeId: a } = await memory(pid).writeNode(pid, { type: 'task', uri: 'noriq://task/a', label: 'a', actor: SYSTEM });
    const { nodeId: b } = await memory(pid).writeNode(pid, { type: 'memory', uri: 'noriq://memory/b', label: 'b', actor: SYSTEM });
    await memory(pid).writeEdge(pid, { type: 'related_to', fromNodeId: a, toNodeId: b, actor: SYSTEM });
    const canonicalBefore = await memory(pid).health(pid);

    const first = await memory(pid).beginConstellationGeneration(pid, { topologyVersion: 'connectivity-v1', layoutVersion: 'space-v1' });
    await memory(pid).stageConstellationGeneration(pid, first.generationId, generationData(a, b));
    await expect(memory(pid).activateConstellationGeneration(pid, first.generationId)).rejects.toThrow(/not complete/);
    await memory(pid).completeConstellationGeneration(pid, first.generationId);
    expect(await memory(pid).activateConstellationGeneration(pid, first.generationId)).toEqual({ activated: first.generationId, superseded: null });
    expect((await memory(pid).constellationGenerationStatus(pid, first.generationId))?.status).toBe('active');

    const failed = await memory(pid).beginConstellationGeneration(pid, { topologyVersion: 'connectivity-v1', layoutVersion: 'space-v1' });
    await memory(pid).failConstellationGeneration(pid, failed.generationId, 'fixture failure');
    expect((await memory(pid).constellationGenerationStatus(pid))?.id).toBe(first.generationId);

    const second = await memory(pid).beginConstellationGeneration(pid, { topologyVersion: 'connectivity-v1', layoutVersion: 'space-v1' });
    await memory(pid).stageConstellationGeneration(pid, second.generationId, generationData(a, b));
    await memory(pid).completeConstellationGeneration(pid, second.generationId);
    expect(await memory(pid).activateConstellationGeneration(pid, second.generationId)).toEqual({ activated: second.generationId, superseded: first.generationId });
    expect((await memory(pid).constellationGenerationStatus(pid, first.generationId))?.status).toBe('superseded');

    const after = await memory(pid).health(pid);
    expect(after.tableCounts.nodes).toBe(canonicalBefore.tableCounts.nodes);
    expect(after.tableCounts.edges).toBe(canonicalBefore.tableCounts.edges);
    expect(after.memoryRevision).toBe(canonicalBefore.memoryRevision);
    expect(after.tableCounts.constellation_generations).toBe(3);
    expect(after.tableCounts.constellation_lens_memberships).toBe(8);
  });

  it('excludes disposable generations from backup and invalidates them on canonical restore', async () => {
    const pid = 'prj_constellation_restore';
    const { nodeId: a } = await memory(pid).writeNode(pid, { type: 'task', uri: 'noriq://task/restore-a', label: 'a', actor: SYSTEM });
    const { nodeId: b } = await memory(pid).writeNode(pid, { type: 'memory', uri: 'noriq://memory/restore-b', label: 'b', actor: SYSTEM });
    const generation = await memory(pid).beginConstellationGeneration(pid, { topologyVersion: 'connectivity-v1', layoutVersion: 'space-v1' });
    await memory(pid).stageConstellationGeneration(pid, generation.generationId, generationData(a, b));
    await memory(pid).completeConstellationGeneration(pid, generation.generationId);
    await memory(pid).activateConstellationGeneration(pid, generation.generationId);

    const exported = await memory(pid).exportSnapshot(pid);
    if (!exported.ok) throw new Error(exported.reason);
    await memory(pid).erase(pid);
    const restored = await memory(pid).restoreSnapshot(pid, { exportedAt: exported.manifest.exportedAt });
    if (!restored.ok) throw new Error(restored.reason);

    const health = await memory(pid).health(pid);
    expect(health.tableCounts.nodes).toBe(2);
    expect(health.tableCounts.constellation_generations).toBe(0);
    expect(health.tableCounts.constellation_communities).toBe(0);
    expect(health.tableCounts.constellation_lens_communities).toBe(0);
    expect(await memory(pid).constellationGenerationStatus(pid)).toBeNull();
  });

  it('refuses to activate a complete generation after its canonical source revision advances', async () => {
    const pid = 'prj_constellation_race';
    const { nodeId: a } = await memory(pid).writeNode(pid, { type: 'task', uri: 'noriq://task/race-a', label: 'a', actor: SYSTEM });
    const { nodeId: b } = await memory(pid).writeNode(pid, { type: 'memory', uri: 'noriq://memory/race-b', label: 'b', actor: SYSTEM });
    const generation = await memory(pid).beginConstellationGeneration(pid, { topologyVersion: 'connectivity-v1', layoutVersion: 'space-v1' });
    await memory(pid).stageConstellationGeneration(pid, generation.generationId, generationData(a, b));
    await memory(pid).writeNode(pid, { type: 'task', uri: 'noriq://task/race-newer', label: 'newer', actor: SYSTEM });
    await memory(pid).completeConstellationGeneration(pid, generation.generationId);

    await expect(memory(pid).activateConstellationGeneration(pid, generation.generationId)).rejects.toThrow(/source revision .* stale/);
    expect((await memory(pid).constellationGenerationStatus(pid, generation.generationId))?.status).toBe('complete');
  });

  it('reaps interrupted build payloads on retry while continuously serving the prior active generation', async () => {
    const pid = 'prj_constellation_retry';
    const { nodeId: a } = await memory(pid).writeNode(pid, { type: 'task', uri: 'noriq://task/retry-a', label: 'a', actor: SYSTEM });
    const { nodeId: b } = await memory(pid).writeNode(pid, { type: 'memory', uri: 'noriq://memory/retry-b', label: 'b', actor: SYSTEM });
    expect((await memory(pid).rebuildConstellationHierarchy(pid)).ok).toBe(true);
    const active = await memory(pid).constellationGenerationStatus(pid);

    await memory(pid).writeNode(pid, { type: 'task', uri: 'noriq://task/retry-newer', label: 'newer', actor: SYSTEM });
    expect((await memory(pid).constellationV2Overview(pid)).revision).toMatchObject({
      generationId: active!.id, state: 'stale',
    });

    const interrupted = await memory(pid).beginConstellationGeneration(pid, { topologyVersion: 'connectivity-v1', layoutVersion: 'space-v1' });
    await memory(pid).stageConstellationGeneration(pid, interrupted.generationId, generationData(a, b));
    expect((await memory(pid).constellationV2Overview(pid)).revision).toMatchObject({
      generationId: active!.id, state: 'building',
    });
    expect((await memory(pid).health(pid)).tableCounts.constellation_lens_memberships).toBe(5);

    const retry = await memory(pid).beginConstellationGeneration(pid, { topologyVersion: 'connectivity-v1', layoutVersion: 'space-v1' });
    expect(await memory(pid).constellationGenerationStatus(pid, interrupted.generationId)).toMatchObject({
      status: 'failed', failureReason: 'superseded by constellation generation retry',
    });
    expect((await memory(pid).health(pid)).tableCounts.constellation_lens_memberships).toBe(1);
    expect((await memory(pid).constellationV2Overview(pid)).revision).toMatchObject({
      generationId: active!.id, state: 'building',
    });

    await memory(pid).failConstellationGeneration(pid, retry.generationId, 'fixture stops retry');
    expect((await memory(pid).constellationV2Overview(pid)).revision).toMatchObject({
      generationId: active!.id, state: 'stale',
    });
  });

  it('builds and activates the pure hierarchy through the ProjectMemory orchestration wrapper', async () => {
    const pid = 'prj_constellation_rebuild';
    const { nodeId: a } = await memory(pid).writeNode(pid, { type: 'file', uri: 'noriq://file/rebuild-a', label: 'a', actor: SYSTEM });
    const { nodeId: b } = await memory(pid).writeNode(pid, { type: 'symbol', uri: 'noriq://symbol/rebuild-b', label: 'b', actor: SYSTEM });
    await memory(pid).writeEdge(pid, { type: 'declares', fromNodeId: a, toNodeId: b, actor: SYSTEM });

    const rebuilt = await memory(pid).rebuildConstellationHierarchy(pid);
    expect(rebuilt).toMatchObject({ ok: true, nodes: 2, edges: 1 });
    expect((await memory(pid).constellationGenerationStatus(pid))?.status).toBe('active');
    const health = await memory(pid).health(pid);
    expect(health.tableCounts.constellation_lens_node_stats).toBe(4);
    expect(health.tableCounts.constellation_lens_memberships).toBe(0);
    expect(await memory(pid).constellationHierarchyDrift(pid)).toMatchObject({ converged: true, stale: false, missingNodeStats: 0, unexpectedAggregatedEdges: 0 });

    await memory(pid).writeNode(pid, { type: 'task', uri: 'noriq://task/rebuild-newer', label: 'newer', actor: SYSTEM });
    expect(await memory(pid).constellationHierarchyDrift(pid)).toMatchObject({ converged: false, stale: true, missingNodeStats: 2 });
  });
});
