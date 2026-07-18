// PLNR-184: semantic search. The workerd test env has no AI/VECTORIZE bindings, so the
// route-level tests exercise the keyword fallback (the guarantee that search always
// works); the semantic layer is unit-tested with injected fakes, same pattern as cimd.
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall } from './helpers';
import {
  chunkText, entityChunks, indexEntity, removeEntity, semanticSearch,
  type EmbeddingClient, type SearchBackend, type VectorStore,
} from '../src/search';

// ---------------------------------------------------------------------------------------
// Unit: chunking + fake-backed index/query
// ---------------------------------------------------------------------------------------

/** Deterministic fake embedder: vector = [len, firstCharCode]. */
const fakeEmbedder: EmbeddingClient = {
  async embed(texts) { return texts.map((t) => [t.length % 97, t.charCodeAt(0) % 89, 1]); },
};

function fakeStore() {
  const vectors = new Map<string, { values: number[]; metadata: Record<string, string> }>();
  const store: VectorStore = {
    async upsert(vs) { for (const v of vs) vectors.set(v.id, { values: v.values, metadata: v.metadata }); },
    async deleteByIds(ids) { for (const id of ids) vectors.delete(id); },
    async query(_vector, opts) {
      // Return everything (optionally filtered), best "score" first by insertion order.
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

describe('chunking (unit)', () => {
  it('splits on paragraphs and hard-splits oversized ones', () => {
    const chunks = chunkText(`${'a'.repeat(1400)}\n\n${'b'.repeat(1400)}\n\n${'c'.repeat(4000)}`, 1500);
    expect(chunks.length).toBe(5); // a, b, c×3 (hard-split)
    expect(chunks[0]![0]).toBe('a');
  });

  it('tasks embed as one vector; docs chunk with the title prepended to every chunk', () => {
    expect(entityChunks({ kind: 'task', title: 't', body: 'b'.repeat(20_000) })).toHaveLength(1);
    const doc = entityChunks({ kind: 'doc', title: 'Design', body: `${'x'.repeat(1400)}\n\n${'y'.repeat(1400)}` });
    expect(doc).toHaveLength(2);
    expect(doc[0]).toContain('Design');
    expect(doc[1]).toContain('Design');
  });
});

describe('index/remove with a fake backend (unit)', () => {
  it('reindexing a shrunk doc leaves no stale chunks; remove clears everything', async () => {
    const { store, vectors } = fakeStore();
    const backend: SearchBackend = { embedder: fakeEmbedder, store };
    await indexEntity(backend, { kind: 'doc', id: 'doc_1', projectId: 'p1', title: 'D', body: `${'x'.repeat(1400)}\n\n${'y'.repeat(1400)}` });
    expect([...vectors.keys()]).toEqual(['doc:doc_1#0', 'doc:doc_1#1']);
    await indexEntity(backend, { kind: 'doc', id: 'doc_1', projectId: 'p1', title: 'D', body: 'short now' });
    expect([...vectors.keys()]).toEqual(['doc:doc_1#0']);
    await removeEntity(backend, 'doc', 'doc_1');
    expect(vectors.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------
// Integration: keyword fallback through the real MCP tool + REST route
// ---------------------------------------------------------------------------------------

let agent: { id: string; apiKey: string };
let projectId: string;
let cookie: string;

beforeAll(async () => {
  agent = await createAgent('search-agent');
  await createUser('search@example.com', 'Search Human', 'longenough1', 'admin').catch(() => {});
  cookie = await loginSession('search@example.com', 'longenough1');
  projectId = (await mcpCall(agent.apiKey, 'create_project', { key: 'SRCH', name: 'searchable' })).body.id;
  await mcpCall(agent.apiKey, 'create_task', {
    projectId, title: 'implement payment retry backoff', tags: ['payments'], body: 'Exponential backoff on PSP timeouts.',
  });
  await mcpCall(agent.apiKey, 'create_doc', {
    projectId, name: 'Payment gateway design', description: 'how payments flow', body: 'All payments go through the gateway service. The retry policy is exponential backoff, budget 3 attempts.',
  });
  await mcpCall(agent.apiKey, 'create_plan', {
    projectId, title: 'Payments hardening', description: 'retry + idempotency',
    phases: [{ title: 'p1', newTasks: [{ title: 'idempotency keys', tags: ['payments'] }] }],
  });
}, 60000);

describe('semantic_search MCP tool (keyword fallback in tests)', () => {
  it('finds tasks, docs and plans across kinds and reports the mode', async () => {
    const r = await mcpCall(agent.apiKey, 'semantic_search', { query: 'payment retry' });
    expect(r.body.mode).toBe('keyword'); // no bindings in workerd tests
    const kinds = new Set(r.body.results.map((h: { kind: string }) => h.kind));
    expect(kinds.has('task')).toBe(true);
    expect(kinds.has('doc')).toBe(true);
    expect(kinds.has('plan')).toBe(true);
  });

  it('kind restriction and project scoping apply', async () => {
    const r = await mcpCall(agent.apiKey, 'semantic_search', { query: 'payment', kinds: ['doc'], projectId });
    expect(r.body.results.every((h: { kind: string }) => h.kind === 'doc')).toBe(true);
    const none = await mcpCall(agent.apiKey, 'semantic_search', { query: 'payment', projectId: 'prj_nope' });
    expect(none.isError).toBe(true); // the shared MCP guard rejects unreachable projectIds
    expect(none.text).toContain('not found or not accessible');
  });
});

describe('REST /api/projects/:pid/search', () => {
  it('serves the UI search with the same shape', async () => {
    const res = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/search?q=backoff&kinds=task,doc`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { mode: string; results: Array<{ kind: string; title: string }> };
    expect(j.mode).toBe('keyword');
    expect(j.results.length).toBeGreaterThan(0);
    expect(j.results.every((h) => h.kind === 'task' || h.kind === 'doc')).toBe(true);
  });

  it('requires q and rejects reindex without a backend', async () => {
    const bad = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/search`, { headers: { Cookie: cookie } });
    expect(bad.status).toBe(400);
    const reindex = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/search/reindex`, {
      method: 'POST', headers: { Cookie: cookie },
    });
    expect(reindex.status).toBe(503);
  });
});

describe('semanticSearch end-to-end against a fake backend + real D1', () => {
  it('hydrates matches from D1 and dedupes doc chunks to the best entity hit', async () => {
    const { store } = fakeStore();
    const backend: SearchBackend = { embedder: fakeEmbedder, store };
    const doc = await env.DB.prepare('SELECT id FROM docs WHERE project_id = ? LIMIT 1').bind(projectId).first<{ id: string }>();
    const task = await env.DB.prepare('SELECT id FROM tasks WHERE project_id = ? LIMIT 1').bind(projectId).first<{ id: string }>();
    await indexEntity(backend, { kind: 'doc', id: doc!.id, projectId, title: 'Payment gateway design', body: `${'x'.repeat(1400)}\n\n${'y'.repeat(1400)}` });
    await indexEntity(backend, { kind: 'task', id: task!.id, projectId, title: 'retry task', body: 'b' });
    const hits = await semanticSearch(env.DB as unknown as D1Database, backend, { q: 'retries', projectIds: [projectId] });
    // 3 vectors (2 doc chunks + 1 task) → 2 entities after chunk-dedupe.
    expect(hits).toHaveLength(2);
    const docHit = hits.find((h) => h.kind === 'doc')!;
    expect(docHit.title).toBe('Payment gateway design');
    expect(docHit.projectId).toBe(projectId);
    const taskHit = hits.find((h) => h.kind === 'task')!;
    expect(taskHit.key).toContain('SRCH-');
  });
});
