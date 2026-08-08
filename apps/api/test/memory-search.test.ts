// PLNR-255: operational semantic search extended to memories and episodes. Two layers, tested
// the same way search.test.ts already tests tasks/docs/plans:
//   - the pure indexEntity/hydrate/semanticSearch/keywordSearch functions, driven directly with
//     a fake embedder/store (neither AI nor VECTORIZE is bound in workerd tests — see
//     search.ts's own module comment and CLAUDE.md's fetchMock isolate-boundary note);
//   - the real ProjectMemory RPCs (recordMemory, approveDecision, transitionMemoryValidity,
//     decayLowAuthorityMemories, _seedEpisodeForTest) that produce the canonical rows hydrate()
//     reads live.
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import type { Env } from '../src/env';
import { assertVectorizeTopKOk, createAgent, mcpCall } from './helpers';
import {
  indexEntity, removeEntity, semanticSearch, keywordSearch, search,
  type EmbeddingClient, type SearchBackend, type VectorStore,
} from '../src/search';
import { RETRIEVAL_DEFAULTS } from '../src/memory/retrieval';

const appEnv = env as unknown as Env;

const fakeEmbedder: EmbeddingClient = {
  async embed(texts) { return texts.map((t) => [t.length % 97, t.charCodeAt(0) % 89, 1]); },
};

function fakeStore() {
  const vectors = new Map<string, { values: number[]; metadata: Record<string, string> }>();
  const store: VectorStore = {
    async upsert(vs) { for (const v of vs) vectors.set(v.id, { values: v.values, metadata: v.metadata }); },
    async deleteByIds(ids) { for (const id of ids) vectors.delete(id); },
    async query(_vector, opts) {
      // PLNR-281: the real service throws before ever looking at the vectors — do the same.
      assertVectorizeTopKOk(opts.topK);
      const matches = [...vectors.entries()]
        .filter(([, v]) => {
          const f = opts.filter as { projectId?: { $eq: string } } | undefined;
          return !f?.projectId || v.metadata.projectId === f.projectId.$eq;
        })
        .map(([id, v], i) => ({ id, score: 1 - i * 0.01, metadata: v.metadata }));
      return { matches: matches.slice(0, opts.topK) };
    },
  };
  return { store, vectors };
}

interface MemRpc {
  recordMemory(
    pid: string,
    input: { kind: string; statement: string; authority?: number; actor: { kind: string; id: string | null } },
  ): Promise<{ memoryId: string }>;
  transitionMemoryValidity(
    pid: string,
    input: { memoryItemId: string; validity: 'active' | 'stale' | 'invalid'; actor: { kind: string; id: string | null } },
  ): Promise<{ ok: true }>;
  decayLowAuthorityMemories(pid: string, input: { maxAgeMs: number; authorityCeiling: number }): Promise<{ decayed: string[] }>;
  _setMemoryRecordedAtForTest(pid: string, memoryId: string, recordedAt: string): Promise<void>;
  recordEpisode(
    pid: string,
    input: {
      runId: string; sitting: number; agentId: string | null; runKind: string; outcome: string; startedAt: string | null; finishedAt: string | null;
      taskId: string | null; repositoryKey: string | null; baseId: string | null; timeline: Array<{ at: string; label: string }>;
      filesTouched: string[]; commands: string[]; testsRun: string[]; failures: string[];
      findings: Array<{ summary: string; severity?: string }>; reviewRounds: number; tokenUsage: Record<string, unknown>; costUSD: number;
      acceptanceCoverage: number | null; steeringEvents: string[]; landingOutcome: string; remainingWork: string[];
      actor: { kind: string; id: string | null };
    },
  ): Promise<{ episodeId: string; runId: string; created: boolean }>;
  hydrateSearchHits(
    pid: string,
    refs: Array<{ kind: 'memory' | 'episode'; id: string }>,
  ): Promise<Array<{ kind: 'memory' | 'episode'; id: string; title: string; snippet: string; status?: string; authority?: number; validity?: string }>>;
}

const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as MemRpc;

let agent: { id: string; apiKey: string };

beforeAll(async () => {
  agent = await createAgent('memory-search-agent');
}, 60000);

async function newProject(key: string) {
  const r = await mcpCall(agent.apiKey, 'create_project', { key, name: `${key} project` });
  if (r.isError) throw new Error(`create_project(${key}) failed: ${r.text}`);
  return r.body.id as string;
}

describe('vector id scheme (unit) — memory/episode are single vectors, no chunking', () => {
  it('indexEntity/removeEntity round-trip on deterministic ids', async () => {
    const { store, vectors } = fakeStore();
    const backend: SearchBackend = { embedder: fakeEmbedder, store };
    await indexEntity(backend, { kind: 'memory', id: 'mem_1', projectId: 'p1', title: 'decision', body: 'use postgres' });
    await indexEntity(backend, { kind: 'episode', id: 'epi_1', projectId: 'p1', title: 'episode run_1', body: 'tried X, failed' });
    expect([...vectors.keys()]).toEqual(['memory:mem_1', 'episode:epi_1']);
    // Re-indexing the same id upserts — one vector, not two.
    await indexEntity(backend, { kind: 'memory', id: 'mem_1', projectId: 'p1', title: 'decision', body: 'use postgres, revised' });
    expect(vectors.size).toBe(2);
    await removeEntity(backend, 'memory', 'mem_1');
    expect([...vectors.keys()]).toEqual(['episode:epi_1']);
  });
});

describe('semanticSearch hydrates memory hits LIVE from the canonical row', () => {
  it('authority/validity are read from memory_items at query time, not vector metadata', async () => {
    const projectId = await newProject('MSRCH1');
    const rec = await mcpCall(agent.apiKey, 'record_memory', {
      projectId, kind: 'decision', statement: 'use exponential backoff for PSP retries',
    });
    expect(rec.isError).toBe(false);
    const memoryId = rec.body.memoryId as string;

    const { store } = fakeStore();
    const backend: SearchBackend = { embedder: fakeEmbedder, store };
    // Simulate the DO's own fire-and-forget indexing (real in production; a fake backend can't
    // ride the DO's internal searchBackend(env) call in a workerd test with no AI/VECTORIZE
    // binding — see search.ts's module comment) by indexing directly, same technique
    // search.test.ts already uses for tasks/docs.
    await indexEntity(backend, { kind: 'memory', id: memoryId, projectId, title: 'decision', body: 'use exponential backoff for PSP retries' });

    const before = await semanticSearch(appEnv, backend, { q: 'retries', projectIds: [projectId], kinds: ['memory'] });
    expect(before).toHaveLength(1);
    expect(before[0]!.authority).toBe(1); // agent-recorded, clamped
    expect(before[0]!.validity).toBe('active');

    // Mutate validity AFTER indexing — no re-index — and see the new value in the next query.
    await memory(projectId).transitionMemoryValidity(projectId, { memoryItemId: memoryId, validity: 'stale', actor: { kind: 'system', id: null } });
    const after = await semanticSearch(appEnv, backend, { q: 'retries', projectIds: [projectId], kinds: ['memory'] });
    expect(after[0]!.validity).toBe('stale');
  });

  it('a promoted (approved) decision hydrates at its new authority', async () => {
    const projectId = await newProject('MSRCH2');
    const rec = await mcpCall(agent.apiKey, 'record_memory', {
      projectId, kind: 'decision', statement: 'ship the retry queue behind a feature flag',
    });
    const memoryId = rec.body.memoryId as string;
    // Approval is human-only REST (PLNR-253) — drive it directly on the DO the same way
    // memory-restore.test.ts drives restore/rollback, since this test only needs the RPC, not
    // the REST auth wrapper (already covered elsewhere).
    const approveResult = await (memory(projectId) as unknown as {
      approveDecision(pid: string, input: { memoryItemId: string; actorUserId: string }): Promise<{ approvedMemoryId: string }>;
    }).approveDecision(projectId, { memoryItemId: memoryId, actorUserId: 'human_1' });

    const { store } = fakeStore();
    const backend: SearchBackend = { embedder: fakeEmbedder, store };
    await indexEntity(backend, {
      kind: 'memory', id: approveResult.approvedMemoryId, projectId, title: 'decision', body: 'ship the retry queue behind a feature flag',
    });
    const hits = await semanticSearch(appEnv, backend, { q: 'retry queue', projectIds: [projectId], kinds: ['memory'] });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.authority).toBe(5);
  });
});

describe('decay de-indexes: a decayed memory hydrates to nothing and its vector is dropped', () => {
  it('hydrateSearchHits silently skips a decayed id; removeEntity drops its vector', async () => {
    const projectId = await newProject('MSRCH3');
    const rec = await mcpCall(agent.apiKey, 'record_memory', { projectId, kind: 'learning', statement: 'the staging cluster ignores retry-after' });
    const memoryId = rec.body.memoryId as string;
    await memory(projectId)._setMemoryRecordedAtForTest(projectId, memoryId, '2000-01-01T00:00:00.000Z');

    const { store, vectors } = fakeStore();
    const backend: SearchBackend = { embedder: fakeEmbedder, store };
    await indexEntity(backend, { kind: 'memory', id: memoryId, projectId, title: 'learning', body: 'the staging cluster ignores retry-after' });
    expect(vectors.has(`memory:${memoryId}`)).toBe(true);

    const decay = await memory(projectId).decayLowAuthorityMemories(projectId, { maxAgeMs: 1000, authorityCeiling: 3 });
    expect(decay.decayed).toEqual([memoryId]);

    const hydrated = await memory(projectId).hydrateSearchHits(projectId, [{ kind: 'memory', id: memoryId }]);
    expect(hydrated).toEqual([]); // row is gone — silent skip, same contract as D1 hydration

    // The fire-and-forget de-index a real backend would run — proven directly (the DO's own
    // internal call can't ride a fake backend across the env boundary in a workerd test).
    await removeEntity(backend, 'memory', memoryId);
    expect(vectors.has(`memory:${memoryId}`)).toBe(false);
  });
});

describe('cross-project isolation over one shared operational index', () => {
  it('a caller scoped to project A never receives project B\'s memory, even in a multi-project query', async () => {
    const pA = await newProject('MSRCHA');
    const pB = await newProject('MSRCHB');
    const pC = await newProject('MSRCHC');
    const recA = await mcpCall(agent.apiKey, 'record_memory', { projectId: pA, kind: 'learning', statement: 'shared secret token rotation' });
    const recB = await mcpCall(agent.apiKey, 'record_memory', { projectId: pB, kind: 'learning', statement: 'shared secret token rotation' });

    const { store } = fakeStore();
    const backend: SearchBackend = { embedder: fakeEmbedder, store };
    await indexEntity(backend, { kind: 'memory', id: recA.body.memoryId, projectId: pA, title: 'learning', body: 'shared secret token rotation' });
    await indexEntity(backend, { kind: 'memory', id: recB.body.memoryId, projectId: pB, title: 'learning', body: 'shared secret token rotation' });

    // Two allowed projectIds (A and C, NOT B) — length > 1 so semanticSearch does not filter
    // server-side (that path is single-project only) and must rely on its own post-filter
    // (`allowed.has(projectId)`) to keep B out, exactly the leak surface the locked decision
    // names: the shared multi-project index, not anything inside the DO.
    const hits = await semanticSearch(appEnv, backend, { q: 'token rotation', projectIds: [pA, pC], kinds: ['memory'] });
    expect(hits.map((h) => h.projectId)).toEqual([pA]);
    expect(hits.some((h) => h.id === recB.body.memoryId)).toBe(false);
  });
});

describe('keyword fallback (no backend) covers memories and episodes', () => {
  it('finds a recorded memory by substring and reports current authority/validity', async () => {
    const projectId = await newProject('MSRCH4');
    const rec = await mcpCall(agent.apiKey, 'record_memory', { projectId, kind: 'hazard', statement: 'the nightly batch job leaks file descriptors' });
    const memoryId = rec.body.memoryId as string;

    const { mode, results } = await search(appEnv, { q: 'file descriptors', projectIds: [projectId], kinds: ['memory'] });
    expect(mode).toBe('keyword'); // no AI/VECTORIZE bound in workerd tests
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(memoryId);
    expect(results[0]!.authority).toBe(1);
    expect(results[0]!.validity).toBe('active');
  });

  it('finds a seeded episode by substring in its body', async () => {
    const projectId = await newProject('MSRCH5');
    const { episodeId } = await memory(projectId).recordEpisode(projectId, {
      runId: 'run_abc123', sitting: 1, agentId: null, runKind: 'build', outcome: 'done', startedAt: null, finishedAt: null,
      taskId: null, repositoryKey: null, baseId: null, timeline: [], filesTouched: [], commands: [], testsRun: [], failures: [],
      findings: [{ summary: 'discovered the webhook retries indefinitely without backoff' }],
      reviewRounds: 0, tokenUsage: {}, costUSD: 0, acceptanceCoverage: null, steeringEvents: [],
      landingOutcome: 'landed', remainingWork: [], actor: { kind: 'system', id: null },
    });

    const { mode, results } = await search(appEnv, { q: 'webhook retries', projectIds: [projectId], kinds: ['episode'] });
    expect(mode).toBe('keyword');
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(episodeId);
    expect(results[0]!.status).toBe('landed');
    expect(results[0]!.title).toContain('run_abc123');
  });

  it('every kind together still answers with no bindings, merging D1 and ProjectMemory results', async () => {
    const projectId = await newProject('MSRCH6');
    await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'investigate webhook timeouts', tags: ['webhooks'] });
    await mcpCall(agent.apiKey, 'record_memory', { projectId, kind: 'learning', statement: 'webhook timeouts correlate with cold starts' });

    const results = await keywordSearch(appEnv, { q: 'webhook', projectIds: [projectId] });
    const kinds = new Set(results.map((h) => h.kind));
    expect(kinds.has('task')).toBe(true);
    expect(kinds.has('memory')).toBe(true);
  });
});

describe('search_project_memory\'s DEFAULT limit does not exceed the real topK ceiling (PLNR-281)', () => {
  it('RETRIEVAL_DEFAULTS.maxResults (20) — the over-fetch product (x5=100) used to exceed Vectorize\'s 50-max-topK and throw', async () => {
    // do/ProjectMemory.ts's own semanticRetrievalRows (searchProjectMemory's/get_task_context's
    // actual call site — see its PLNR-281 comment) shares the exact same clamp helper this
    // module's semanticSearch uses, so proving the clamp holds at limit=20 here covers the
    // shared arithmetic even though the DO's private method can't take an injected fake backend
    // (DO RPC args are structurally cloned — a closure-bearing fake can't cross that boundary).
    const projectId = await newProject('MSRCH7');
    const rec = await mcpCall(agent.apiKey, 'record_memory', {
      projectId, kind: 'learning', statement: 'exponential backoff prevents PSP retry storms',
    });
    const memoryId = rec.body.memoryId as string;
    const { store } = fakeStore();
    const backend: SearchBackend = { embedder: fakeEmbedder, store };
    await indexEntity(backend, { kind: 'memory', id: memoryId, projectId, title: 'learning', body: 'exponential backoff prevents PSP retry storms' });
    const hits = await semanticSearch(appEnv, backend, {
      q: 'retry storms', projectIds: [projectId], kinds: ['memory'], limit: RETRIEVAL_DEFAULTS.maxResults,
    });
    expect(hits).toHaveLength(1);
  });
});
