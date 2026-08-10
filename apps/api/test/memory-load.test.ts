// PLNR-276: reproducible Project Memory load profile. This suite is deliberately part of the
// opt-in `load` project, not the ordinary API gate. It exercises real ProjectMemory SQLite,
// staged index activation, bounded recursive traversal, lexical retrieval, ProjectRoom
// coordination isolation, and chunked R2 export/restore while recording the measured envelope.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { StagedRow } from '@noriq-dev/shared';
import type { Env } from '../src/env';
import { createUser, mcpCall, mintTokenForUser, projectRoom, SYSTEM_ACTOR } from './helpers';
import { computeStagedContentHash } from '../src/memory/ingest';
import { RETRIEVAL_DEFAULTS } from '../src/memory/retrieval';

const appEnv = env as unknown as Env;
const SYSTEM = { kind: 'system', id: null } as const;
const REPOSITORY_KEY = 'memory-load-repo';
const NODE_COUNT = 1_500;
const FANOUT = 12;
const EPISODE_COUNT = 200;
const PRIOR_GENERATIONS = 6;
const BATCH_ROWS = 5_000;

// Guardrails include substantial CI variance above the measured local baseline. The exact
// observed values are logged and recorded in docs/PROJECT_MEMORY_LOAD_PROFILE.md.
const WALL_TIME_GUARDS = {
  largeIngestMs: 15_000,
  episodeWriteMs: 15_000,
  traversalMs: 5_000,
  retrievalMs: 2_000,
  coordinationMs: 5_000,
  exportMs: 10_000,
  restoreMs: 15_000,
} as const;

interface IndexManifestInput {
  generationId: string; projectId: string; repositoryKey: string; branch: string; baseId: string;
  indexerVersion: string; batchCount: number; fileCount: number; contentHash: string; deletions: string[]; createdAt: string;
}
interface MemoryRpc {
  beginIndexIngest(pid: string, manifest: IndexManifestInput): Promise<{ ok: true }>;
  ingestIndexBatch(pid: string, batch: { generationId: string; batchNumber: number; batchHash: string }, rows: StagedRow[]): Promise<{ ok: true }>;
  completeIndexIngest(pid: string, generationId: string): Promise<{ validation: { ok: boolean; problems: string[] }; activation?: unknown }>;
  recordEpisode(pid: string, input: Record<string, unknown>): Promise<{ episodeId: string }>;
  searchProjectMemory(pid: string, input: { query: string; limit: number }): Promise<{ results: unknown[] }>;
  dependencyNeighborhood(pid: string, input: { entityUri: string; maxDepth: number; maxResults: number }): Promise<{
    seed: { nodeId: string } | null; downstream: unknown[]; coverage: { complete: boolean; reasons: string[] };
  }>;
  traverseGraph(pid: string, input: { seedNodeIds: string[]; maxDepth: number; maxResults: number }): Promise<unknown[]>;
  health(pid: string): Promise<{ databaseSize: number; tableCounts: Record<string, number>; sizeStatus: string }>;
  exportSnapshot(pid: string): Promise<{
    ok: true; manifest: { exportedAt: string; r2EvidenceRefs: string[]; tableCounts: Record<string, number> }; manifestKey: string;
  } | { ok: false; reason: string }>;
  restoreSnapshot(pid: string, input: { exportedAt: string }): Promise<{
    ok: true; tableCounts: Record<string, number>;
  } | { ok: false; reason: string }>;
}
interface RoomRpc {
  registerRepository(pid: string, actor: typeof SYSTEM_ACTOR, key: string): Promise<{ id: string }>;
}

let projectId: string;
let ownerToken: string;
let largeRows: StagedRow[];
let largeFileUris: string[];
const metrics: Record<string, number> = {};
const memory = () => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(projectId)) as unknown as MemoryRpc;

function elapsed(started: number): number {
  return Math.max(0, performance.now() - started);
}

async function ingestGeneration(generationId: string, rows: StagedRow[], fileCount: number): Promise<void> {
  const batchCount = Math.ceil(rows.length / BATCH_ROWS);
  await memory().beginIndexIngest(projectId, {
    generationId, projectId, repositoryKey: REPOSITORY_KEY, branch: 'main', baseId: `base-${generationId}`,
    indexerVersion: 'memory-load-v1', batchCount, fileCount,
    contentHash: await computeStagedContentHash(rows), deletions: [], createdAt: '2026-08-10T00:00:00.000Z',
  });
  for (let batchNumber = 0; batchNumber < batchCount; batchNumber++) {
    await memory().ingestIndexBatch(projectId, {
      generationId, batchNumber, batchHash: `load-${generationId}-${batchNumber}`,
    }, rows.slice(batchNumber * BATCH_ROWS, (batchNumber + 1) * BATCH_ROWS));
  }
  const completed = await memory().completeIndexIngest(projectId, generationId);
  if (!completed.validation.ok) throw new Error(completed.validation.problems.join('; '));
}

beforeAll(async () => {
  await createUser('project-memory-load@example.com', 'Memory Load', 'longenough1').catch(() => {});
  ownerToken = await mintTokenForUser('project-memory-load@example.com');
  const created = await mcpCall(ownerToken, 'create_project', { key: 'PMLOAD', name: 'Project Memory load profile' });
  if (created.isError) throw new Error(created.text);
  projectId = created.body.id as string;
  await projectRoom<RoomRpc>(projectId).registerRepository(projectId, SYSTEM_ACTOR, REPOSITORY_KEY);

  largeFileUris = Array.from({ length: NODE_COUNT }, (_, i) => `noriq://file/PMLOAD/${REPOSITORY_KEY}/src/file-${i}.ts`);
  const nodes: StagedRow[] = largeFileUris.map((uri, i) => ({
    kind: 'node', uri, type: 'file', label: `file-${i}.ts`, content: `load-profile common phrase ${i}`,
  }));
  const edges: StagedRow[] = [];
  for (let i = 0; i < NODE_COUNT; i++) {
    for (let offset = 1; offset <= FANOUT; offset++) {
      edges.push({ kind: 'edge', type: 'imports', from: largeFileUris[i]!, to: largeFileUris[(i + offset) % NODE_COUNT]! });
    }
  }
  largeRows = [...nodes, ...edges];
}, 60_000);

describe('Project Memory measured load envelope', () => {
  it('retains many generations, activates a large cyclic graph, and stores a long episode history', async () => {
    for (let i = 0; i < PRIOR_GENERATIONS; i++) {
      const uri = `noriq://file/PMLOAD/${REPOSITORY_KEY}/prior-${i}.ts`;
      await ingestGeneration(`gen_memory_load_prior_${i}`, [{ kind: 'node', uri, type: 'file', label: `prior-${i}.ts`, content: null }], 1);
    }

    const ingestStarted = performance.now();
    await ingestGeneration('gen_memory_load_large', largeRows, NODE_COUNT);
    metrics.largeIngestMs = elapsed(ingestStarted);
    expect(metrics.largeIngestMs).toBeLessThan(WALL_TIME_GUARDS.largeIngestMs);

    const episodeStarted = performance.now();
    for (let i = 0; i < EPISODE_COUNT; i++) {
      await memory().recordEpisode(projectId, {
        runId: `run_memory_load_${i}`, sitting: 1, agentId: null, runKind: 'build', outcome: i % 9 === 0 ? 'failed' : 'done',
        startedAt: null, finishedAt: null, taskId: null, repositoryKey: REPOSITORY_KEY, baseId: 'base-gen_memory_load_large',
        timeline: [], filesTouched: [`src/file-${i % NODE_COUNT}.ts`], commands: [], testsRun: [], failures: [],
        findings: [{ summary: `load-profile common phrase episode ${i}` }], reviewRounds: i % 3,
        tokenUsage: { 'load-model': {
          inputTokens: i * 10, outputTokens: i, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0,
        } }, costUSD: 0, acceptanceCoverage: null, steeringEvents: [],
        landingOutcome: i % 9 === 0 ? 'failed' : 'landed', remainingWork: [], actor: SYSTEM,
      });
    }
    metrics.episodeWriteMs = elapsed(episodeStarted);
    expect(metrics.episodeWriteMs).toBeLessThan(WALL_TIME_GUARDS.episodeWriteMs);

    const health = await memory().health(projectId);
    metrics.databaseSizeBytes = health.databaseSize;
    metrics.nodeRows = health.tableCounts.nodes ?? 0;
    metrics.edgeRows = health.tableCounts.edges ?? 0;
    metrics.episodeRows = health.tableCounts.episodes ?? 0;
    expect(metrics.nodeRows).toBeGreaterThanOrEqual(NODE_COUNT + EPISODE_COUNT);
    expect(metrics.edgeRows).toBeGreaterThanOrEqual(NODE_COUNT * FANOUT);
    expect(metrics.episodeRows).toBe(EPISODE_COUNT);
  }, 240_000);

  it('bounds adversarial recursive fanout and lexical retrieval before returning', async () => {
    const seedProbe = await memory().dependencyNeighborhood(projectId, {
      entityUri: largeFileUris[0]!, maxDepth: RETRIEVAL_DEFAULTS.maxDepthCeiling,
      maxResults: RETRIEVAL_DEFAULTS.maxGraphResultsCeiling,
    });
    if (!seedProbe.seed) throw new Error('large graph seed was not projected');

    const traversalStarted = performance.now();
    const traversed = await memory().traverseGraph(projectId, {
      seedNodeIds: [seedProbe.seed.nodeId], maxDepth: RETRIEVAL_DEFAULTS.maxDepthCeiling,
      maxResults: RETRIEVAL_DEFAULTS.maxGraphResultsCeiling,
    });
    metrics.traversalMs = elapsed(traversalStarted);
    metrics.traversalResults = traversed.length;
    expect(traversed.length).toBeLessThanOrEqual(RETRIEVAL_DEFAULTS.maxGraphResultsCeiling);
    expect(metrics.traversalMs).toBeLessThan(WALL_TIME_GUARDS.traversalMs);
    expect(seedProbe.coverage.reasons).toContain('row-limit-reached');

    const retrievalStarted = performance.now();
    const retrieval = await memory().searchProjectMemory(projectId, { query: 'load-profile common phrase', limit: 10_000 });
    metrics.retrievalMs = elapsed(retrievalStarted);
    metrics.retrievalResults = retrieval.results.length;
    expect(retrieval.results.length).toBe(RETRIEVAL_DEFAULTS.maxResultsCeiling);
    expect(metrics.retrievalMs).toBeLessThan(WALL_TIME_GUARDS.retrievalMs);
  }, 60_000);

  it('keeps ProjectRoom coordination responsive while ProjectMemory reads are queued', async () => {
    const seed = await memory().dependencyNeighborhood(projectId, {
      entityUri: largeFileUris[0]!, maxDepth: 1, maxResults: 1,
    });
    if (!seed.seed) throw new Error('large graph seed was not projected');
    const reads = Array.from({ length: 16 }, () => memory().traverseGraph(projectId, {
      seedNodeIds: [seed.seed!.nodeId], maxDepth: RETRIEVAL_DEFAULTS.maxDepthCeiling,
      maxResults: RETRIEVAL_DEFAULTS.maxGraphResultsCeiling,
    }));
    const coordinationStarted = performance.now();
    const created = await mcpCall(ownerToken, 'create_task', {
      projectId, title: 'coordination remains independent under memory load', tags: ['test-fixture'],
    });
    metrics.coordinationMs = elapsed(coordinationStarted);
    expect(created.isError).toBe(false);
    expect(metrics.coordinationMs).toBeLessThan(WALL_TIME_GUARDS.coordinationMs);
    await Promise.all(reads);
  }, 60_000);

  it('exports and restores the loaded store in bounded chunks', async () => {
    const before = await memory().health(projectId);
    const exportStarted = performance.now();
    const exported = await memory().exportSnapshot(projectId);
    metrics.exportMs = elapsed(exportStarted);
    if (!exported.ok) throw new Error(exported.reason);
    expect(metrics.exportMs).toBeLessThan(WALL_TIME_GUARDS.exportMs);
    metrics.backupChunks = exported.manifest.r2EvidenceRefs.length;
    let compressedBytes = 0;
    for (const key of exported.manifest.r2EvidenceRefs) compressedBytes += (await appEnv.FILES!.get(key))?.size ?? 0;
    metrics.backupCompressedBytes = compressedBytes;

    const restoreStarted = performance.now();
    const restored = await memory().restoreSnapshot(projectId, { exportedAt: exported.manifest.exportedAt });
    metrics.restoreMs = elapsed(restoreStarted);
    if (!restored.ok) throw new Error(restored.reason);
    expect(metrics.restoreMs).toBeLessThan(WALL_TIME_GUARDS.restoreMs);
    expect(restored.tableCounts).toEqual(exported.manifest.tableCounts);

    // eslint-disable-next-line no-console
    console.info(`[memory-load] ${JSON.stringify({
      profile: { nodes: NODE_COUNT, fanout: FANOUT, episodes: EPISODE_COUNT, priorGenerations: PRIOR_GENERATIONS },
      guards: WALL_TIME_GUARDS, metrics,
    })}`);
  }, 240_000);
});
