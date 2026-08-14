// PLNR-256: the code-intelligence Vectorize adapter — a SEPARATE index from PLNR-184/255's
// operational `noriq-search`. Two layers, same technique as search.test.ts/memory-search.test.ts:
//   - the pure indexCodeEntity/removeCodeEntity/queryCodeIndex/rebuildCodeIndex functions,
//     driven directly with a fake embedder/store (neither AI nor CODE_VECTORIZE is bound in
//     workerd tests);
//   - the real ProjectMemory RPCs (activateCodeGeneration, pruneSupersededGenerations) that
//     drive the `index_generations` registry's status transitions.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { assertVectorizeTopKOk, createUser, mintTokenForUser, mcpCall } from './helpers';
import {
  codeSearchBackend, indexCodeEntity, removeCodeEntity, queryCodeIndex, rebuildCodeIndex,
  type CodeEntity, type CodeSearchBackend,
} from '../src/memory/code-index';
import { indexEntity as indexOperationalEntity, type SearchBackend, type EmbeddingClient, type VectorStore } from '../src/search';
import { buildEntityUri, parseEntityUri } from '@noriq-dev/shared';
import { computeStagedContentHash } from '../src/memory/ingest';

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
          const f = opts.filter as { projectId?: { $eq: string }; repositoryKey?: { $eq: string } } | undefined;
          if (f?.projectId && v.metadata.projectId !== f.projectId.$eq) return false;
          if (f?.repositoryKey && v.metadata.repositoryKey !== f.repositoryKey.$eq) return false;
          return true;
        })
        .map(([id, v], i) => ({ id, score: 1 - i * 0.01, metadata: v.metadata }));
      return { matches: matches.slice(0, opts.topK) };
    },
  };
  return { store, vectors };
}

interface StagedNodeRow { kind: 'node'; uri: string; type: string; label: string; content?: string | null }

interface MemRpc {
  beginIndexIngest(pid: string, manifest: {
    generationId: string; projectId: string; repositoryKey: string; branch: string; baseId: string;
    indexerVersion: string; batchCount: number; fileCount: number; contentHash: string; deletions: string[]; createdAt: string;
  }): Promise<{ ok: true }>;
  ingestIndexBatch(pid: string, batch: { generationId: string; batchNumber: number; batchHash: string }, rows: StagedNodeRow[]): Promise<{ ok: true; deduped: boolean }>;
  completeIndexIngest(pid: string, generationId: string): Promise<{
    ok: true;
    batchesReceived: number;
    validation: { ok: boolean; problems: string[] };
    activation?: { activated: string; superseded: string[] };
  }>;
  activateIndexGeneration(pid: string, generationId: string): Promise<{ activated: string; superseded: string[] }>;
  pruneSupersededGenerations(pid: string, maxAgeMs: number): Promise<number>;
  _seedSupersededIndexGenerationForTest(pid: string, repositoryKey: string, activatedAt: string): Promise<string>;
  _getIndexGenerationStatusForTest(pid: string, generationId: string): Promise<string | null>;
  readActiveCodeIndex(pid: string, input: {
    repositoryKey: string; generationId?: string; branch?: string; baseId?: string; uris?: string[]; maxContentChars?: number;
  }): Promise<
    | { available: false; reason: string }
    | { available: true; scope: { generationId: string; branch: string; baseId: string }; entities: Array<{ uri: string; path: string; content: string; contentTruncated: boolean }> }
  >;
}
const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as MemRpc;

/** Drive one file-only generation through the whole PLNR-261 stage/validate/promote sequence in
 *  a single batch — the shape every activateIndexGeneration test below needs. */
async function stageAndActivate(
  projectId: string,
  opts: { generationId: string; repositoryKey: string; branch: string; baseId: string; entities: StagedNodeRow[]; deletions?: string[] },
) {
  const m = memory(projectId);
  await m.beginIndexIngest(projectId, {
    generationId: opts.generationId, projectId, repositoryKey: opts.repositoryKey, branch: opts.branch, baseId: opts.baseId,
    indexerVersion: 'test', batchCount: 1, fileCount: opts.entities.filter((e) => e.type === 'file').length,
    contentHash: await computeStagedContentHash(opts.entities as never), deletions: opts.deletions ?? [], createdAt: new Date().toISOString(),
  });
  await m.ingestIndexBatch(projectId, { generationId: opts.generationId, batchNumber: 0, batchHash: 'unused-in-fake-test-path' }, opts.entities);
  const completed = await m.completeIndexIngest(projectId, opts.generationId);
  if (!completed.validation.ok) throw new Error(`validation failed: ${completed.validation.problems.join('; ')}`);
  return completed.activation ?? m.activateIndexGeneration(projectId, opts.generationId);
}

async function newOwnedProject(email: string, key: string) {
  const user = await createUser(email, 'Owner', 'longenough1');
  const token = await mintTokenForUser(email);
  const proj = await mcpCall(token, 'create_project', { key, name: `${key} project` });
  if (proj.isError) throw new Error(`create_project(${key}) failed: ${proj.text}`);
  return { userId: user.id, token, projectId: proj.body.id as string };
}

describe('codeSearchBackend degrades cleanly without bindings', () => {
  it('returns null when AI or CODE_VECTORIZE is unbound (the default workerd state)', () => {
    expect(codeSearchBackend({} as Env)).toBeNull();
    expect(codeSearchBackend({ AI: {} } as unknown as Env)).toBeNull();
  });
});

describe('vector id scheme — generation-free, entity-URI keyed', () => {
  it('re-indexing the same uri under a LATER generation is a plain upsert at the same id', async () => {
    const { store, vectors } = fakeStore();
    const backend: CodeSearchBackend = { embedder: fakeEmbedder, store };
    const uri = 'noriq://file/PLNR/repo-a/src/index.ts';
    await indexCodeEntity(backend, { uri, projectId: 'p1', repositoryKey: 'repo-a', generationId: 'gen-a', type: 'file', label: 'index.ts' });
    expect([...vectors.keys()]).toEqual([uri]);
    expect(vectors.get(uri)!.metadata.generationId).toBe('gen-a');

    await indexCodeEntity(backend, { uri, projectId: 'p1', repositoryKey: 'repo-a', generationId: 'gen-b', type: 'file', label: 'index.ts (revised)' });
    expect(vectors.size).toBe(1); // same id — an upsert, not a second vector
    expect(vectors.get(uri)!.metadata.generationId).toBe('gen-b'); // metadata advanced
  });

  it('a multi-chunk symbol\'s chunk suffix does not corrupt its #name fragment (PLNR-262)', async () => {
    const { store, vectors } = fakeStore();
    const backend: CodeSearchBackend = { embedder: fakeEmbedder, store };
    const ref = { kind: 'symbol' as const, projectKey: 'PLNR', repositoryKey: 'repo-a', path: 'src/big.ts', name: 'bigFunction' };
    const uri = buildEntityUri(ref);
    await indexCodeEntity(backend, {
      uri, projectId: 'p1', repositoryKey: 'repo-a', generationId: 'gen-a', type: 'symbol', label: 'bigFunction',
      content: `${'x'.repeat(1400)}\n\n${'y'.repeat(1400)}`,
    });
    const ids = [...vectors.keys()];
    expect(ids).toContain(uri); // chunk 0 — the bare uri
    const chunk1 = ids.find((id) => id !== uri)!;
    expect(chunk1.startsWith(`${uri}#`)).toBe(false); // the OLD scheme would have appended #1 here
    // Stripping the chunk suffix (whatever it is) and parsing what's left recovers the SAME ref
    // that buildEntityUri produced — the collision the old `#${chunk}` scheme would have caused.
    const base = chunk1.slice(0, uri.length);
    expect(base).toBe(uri);
    expect(parseEntityUri(base)).toEqual(ref);

    await removeCodeEntity(backend, uri);
    expect(vectors.size).toBe(0);
  });

  it('file content chunks (like search.ts docs); a bare label with no content is one vector', async () => {
    const { store, vectors } = fakeStore();
    const backend: CodeSearchBackend = { embedder: fakeEmbedder, store };
    await indexCodeEntity(backend, {
      uri: 'noriq://file/PLNR/repo-a/big.ts', projectId: 'p1', repositoryKey: 'repo-a', generationId: 'gen-a', type: 'file', label: 'big.ts',
      content: `${'x'.repeat(1400)}\n\n${'y'.repeat(1400)}`,
    });
    // PLNR-262: the chunk separator is U+241E (␞), not `#` — `#` is reserved for a repository-
    // scoped entity's own {path}#{name} fragment (symbol/test/api), so a chunk suffix must never
    // collide with it.
    expect([...vectors.keys()]).toEqual(['noriq://file/PLNR/repo-a/big.ts', 'noriq://file/PLNR/repo-a/big.ts␞1']);
  });
});

describe('indexing code entities never churns the operational noriq-search index', () => {
  it('two independent fake stores prove non-interference', async () => {
    const operational = fakeStore();
    const operationalBackend: SearchBackend = { embedder: fakeEmbedder, store: operational.store };
    const code = fakeStore();
    const codeBackend: CodeSearchBackend = { embedder: fakeEmbedder, store: code.store };

    await indexOperationalEntity(operationalBackend, { kind: 'memory', id: 'mem_1', projectId: 'p1', title: 'decision', body: 'use postgres' });
    const beforeOperational = new Map(operational.vectors);

    await indexCodeEntity(codeBackend, { uri: 'noriq://file/PLNR/repo-a/x.ts', projectId: 'p1', repositoryKey: 'repo-a', generationId: 'gen-a', type: 'file', label: 'x.ts' });

    expect(operational.vectors).toEqual(beforeOperational); // byte-identical — untouched
    expect(operational.vectors.has('noriq://file/PLNR/repo-a/x.ts')).toBe(false);
    expect(code.vectors.has('memory:mem_1')).toBe(false);
  });
});

describe('queryCodeIndex filters query-time on the active generation', () => {
  it('a vector from a superseded generation is excluded once another is active, even though it was never deleted', async () => {
    const { store } = fakeStore();
    const backend: CodeSearchBackend = { embedder: fakeEmbedder, store };
    await indexCodeEntity(backend, { uri: 'noriq://file/PLNR/repo-a/old.ts', projectId: 'p1', repositoryKey: 'repo-a', generationId: 'gen-a', type: 'file', label: 'old.ts' });
    await indexCodeEntity(backend, { uri: 'noriq://file/PLNR/repo-a/new.ts', projectId: 'p1', repositoryKey: 'repo-a', generationId: 'gen-b', type: 'file', label: 'new.ts' });

    const activeOnly = await queryCodeIndex(backend, { q: 'ts', projectId: 'p1', activeGenerationIds: ['gen-b'] });
    expect(activeOnly.map((h) => h.uri)).toEqual(['noriq://file/PLNR/repo-a/new.ts']);

    const both = await queryCodeIndex(backend, { q: 'ts', projectId: 'p1' }); // no generation filter — sees everything
    expect(both.map((h) => h.uri).sort()).toEqual(['noriq://file/PLNR/repo-a/new.ts', 'noriq://file/PLNR/repo-a/old.ts']);
  });

  it('a topK of 17 no longer exceeds the real Vectorize ceiling (17*3=51 > 50) (PLNR-281)', async () => {
    // 17 is the smallest topK argument that reproduces the bug: the x3 over-fetch multiplier
    // puts the naive request at 51, one past Vectorize's real 50-max-topK for a
    // returnMetadata:'all' query (this adapter always asks for 'all' — see module comment).
    const { store } = fakeStore();
    const backend: CodeSearchBackend = { embedder: fakeEmbedder, store };
    await indexCodeEntity(backend, { uri: 'noriq://file/PLNR/repo-a/x.ts', projectId: 'p1', repositoryKey: 'repo-a', generationId: 'gen-a', type: 'file', label: 'x.ts' });
    const hits = await queryCodeIndex(backend, { q: 'x.ts', projectId: 'p1', topK: 17 });
    expect(hits.map((h) => h.uri)).toEqual(['noriq://file/PLNR/repo-a/x.ts']);
  });

  it('never returns a vector belonging to a different project, even sharing the same store', async () => {
    const { store } = fakeStore();
    const backend: CodeSearchBackend = { embedder: fakeEmbedder, store };
    await indexCodeEntity(backend, { uri: 'noriq://file/AAA/repo-a/x.ts', projectId: 'pA', repositoryKey: 'repo-a', generationId: 'gen-a', type: 'file', label: 'x.ts' });
    await indexCodeEntity(backend, { uri: 'noriq://file/BBB/repo-a/x.ts', projectId: 'pB', repositoryKey: 'repo-a', generationId: 'gen-a', type: 'file', label: 'x.ts' });
    const hits = await queryCodeIndex(backend, { q: 'x.ts', projectId: 'pA' });
    expect(hits.map((h) => h.uri)).toEqual(['noriq://file/AAA/repo-a/x.ts']);
  });

  it('rechecks repository metadata client-side and uses URI as a deterministic equal-score tie-break', async () => {
    const backend: CodeSearchBackend = {
      embedder: fakeEmbedder,
      store: {
        async upsert() {},
        async deleteByIds() {},
        async query() {
          return {
            matches: [
              { id: 'wrong-repo', score: 1, metadata: { projectId: 'p1', repositoryKey: 'repo-b', generationId: 'gen-a', uri: 'noriq://file/PLNR/repo-b/z.ts' } },
              { id: 'z', score: 0.9, metadata: { projectId: 'p1', repositoryKey: 'repo-a', generationId: 'gen-a', uri: 'noriq://file/PLNR/repo-a/z.ts' } },
              { id: 'a', score: 0.9, metadata: { projectId: 'p1', repositoryKey: 'repo-a', generationId: 'gen-a', uri: 'noriq://file/PLNR/repo-a/a.ts' } },
            ],
          };
        },
      },
    };
    const hits = await queryCodeIndex(backend, {
      q: 'context', projectId: 'p1', repositoryKey: 'repo-a', activeGenerationIds: ['gen-a'],
    });
    expect(hits.map((hit) => hit.uri)).toEqual([
      'noriq://file/PLNR/repo-a/a.ts',
      'noriq://file/PLNR/repo-a/z.ts',
    ]);
  });
});

describe('rebuildCodeIndex — resumable and idempotent, mirroring reindexProject\'s contract', () => {
  it('resumes from its returned offset and produces the same vector set on a second full run', async () => {
    const { store, vectors } = fakeStore();
    const backend: CodeSearchBackend = { embedder: fakeEmbedder, store };
    const entities: CodeEntity[] = Array.from({ length: 5 }, (_, i) => ({
      uri: `noriq://file/PLNR/repo-a/f${i}.ts`, projectId: 'p1', repositoryKey: 'repo-a', generationId: 'gen-a', type: 'file', label: `f${i}.ts`,
    }));

    let progress = await rebuildCodeIndex(backend, entities, 0, 2);
    expect(progress).toEqual({ indexed: 2, offset: 0, total: 5, remaining: 3 });
    progress = await rebuildCodeIndex(backend, entities, progress.offset + progress.indexed, 2);
    expect(progress).toEqual({ indexed: 2, offset: 2, total: 5, remaining: 1 });
    progress = await rebuildCodeIndex(backend, entities, progress.offset + progress.indexed, 2);
    expect(progress).toEqual({ indexed: 1, offset: 4, total: 5, remaining: 0 });
    expect(vectors.size).toBe(5);

    // Running the whole thing again from scratch upserts — same 5 vectors, not 10.
    await rebuildCodeIndex(backend, entities, 0, 100);
    expect(vectors.size).toBe(5);
  });
});

describe('activateIndexGeneration — real index_generations status transitions (PLNR-261 stage/validate/promote)', () => {
  it('supersedes the previously-active generation for the same repository and activates the new one', async () => {
    const { projectId } = await newOwnedProject('code-idx-1@example.com', 'CIDX1');
    const first = await stageAndActivate(projectId, {
      generationId: 'gen_first', repositoryKey: 'repo-a', branch: 'main', baseId: 'sha_1',
      entities: [{ kind: 'node', uri: 'noriq://file/CIDX1/repo-a/a.ts', type: 'file', label: 'a.ts' }],
    });
    expect(first).toMatchObject({ activated: 'gen_first', superseded: [] });
    expect(await memory(projectId)._getIndexGenerationStatusForTest(projectId, 'gen_first')).toBe('active');

    const second = await stageAndActivate(projectId, {
      generationId: 'gen_second', repositoryKey: 'repo-a', branch: 'main', baseId: 'sha_2',
      entities: [{ kind: 'node', uri: 'noriq://file/CIDX1/repo-a/a.ts', type: 'file', label: 'a.ts (unchanged)' }],
      deletions: ['removed.ts'],
    });
    expect(second).toMatchObject({ activated: 'gen_second', superseded: ['gen_first'] });
    expect(await memory(projectId)._getIndexGenerationStatusForTest(projectId, 'gen_first')).toBe('superseded');
    expect(await memory(projectId)._getIndexGenerationStatusForTest(projectId, 'gen_second')).toBe('active');
  });

  it('works with no CODE_VECTORIZE bound — the status transition is unconditional; only vector publish/retire degrades', async () => {
    const { projectId } = await newOwnedProject('code-idx-2@example.com', 'CIDX2');
    // No AI/CODE_VECTORIZE bound in the workerd test env — this must not throw.
    await expect(
      stageAndActivate(projectId, { generationId: 'gen_x', repositoryKey: 'repo-b', branch: 'main', baseId: 'sha_1', entities: [] }),
    ).resolves.toMatchObject({ activated: 'gen_x', superseded: [] });
  });

  it('resolves only exact active-generation staged content in requested order and rejects an old generation after cutover', async () => {
    const { projectId } = await newOwnedProject('code-idx-read@example.com', 'CIDXR');
    const oldUri = 'noriq://file/CIDXR/repo-r/old.ts';
    const firstUri = 'noriq://file/CIDXR/repo-r/first.ts';
    const secondUri = 'noriq://file/CIDXR/repo-r/second.ts';
    await stageAndActivate(projectId, {
      generationId: 'gen_read_a', repositoryKey: 'repo-r', branch: 'main', baseId: 'sha-a',
      entities: [{ kind: 'node', uri: oldUri, type: 'file', label: 'old.ts', content: 'old only' }],
    });
    await stageAndActivate(projectId, {
      generationId: 'gen_read_b', repositoryKey: 'repo-r', branch: 'main', baseId: 'sha-b',
      entities: [
        { kind: 'node', uri: firstUri, type: 'file', label: 'first.ts', content: 'first content' },
        { kind: 'node', uri: secondUri, type: 'file', label: 'second.ts', content: 'second content' },
      ],
    });

    const active = await memory(projectId).readActiveCodeIndex(projectId, {
      repositoryKey: 'repo-r',
      generationId: 'gen_read_b',
      branch: 'main',
      baseId: 'sha-b',
      uris: [secondUri, oldUri, firstUri, secondUri],
      maxContentChars: 6,
    });
    expect(active).toMatchObject({
      available: true,
      scope: { generationId: 'gen_read_b', branch: 'main', baseId: 'sha-b' },
      entities: [
        { uri: secondUri, path: 'second.ts', content: 'second', contentTruncated: true },
        { uri: firstUri, path: 'first.ts', content: 'first ', contentTruncated: true },
      ],
    });
    await expect(memory(projectId).readActiveCodeIndex(projectId, {
      repositoryKey: 'repo-r', generationId: 'gen_read_a', uris: [oldUri],
    })).resolves.toEqual({ available: false, reason: 'active-generation-changed' });
  });
});

describe('pruneSupersededGenerations — registry-row GC, mirrors pruneAbandonedStagedGenerations', () => {
  it('discards a superseded generation past its retention window; idempotent at zero', async () => {
    const { projectId } = await newOwnedProject('code-idx-3@example.com', 'CIDX3');
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString(); // > 24h default
    await memory(projectId)._seedSupersededIndexGenerationForTest(projectId, 'repo-c', old);

    const pruned = await memory(projectId).pruneSupersededGenerations(projectId, 24 * 3600 * 1000);
    expect(pruned).toBe(1);
    const again = await memory(projectId).pruneSupersededGenerations(projectId, 24 * 3600 * 1000);
    expect(again).toBe(0);
  });

  it('leaves a recently-superseded generation alone', async () => {
    const { projectId } = await newOwnedProject('code-idx-4@example.com', 'CIDX4');
    await memory(projectId)._seedSupersededIndexGenerationForTest(projectId, 'repo-d', new Date().toISOString());
    expect(await memory(projectId).pruneSupersededGenerations(projectId, 24 * 3600 * 1000)).toBe(0);
  });
});
