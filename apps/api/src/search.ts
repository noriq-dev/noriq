// PLNR-184: semantic search over tasks, docs and plans.
//
// Two layers, both optional-degrading:
//   1. SEMANTIC — Workers AI embeddings (@cf/baai/bge-m3) + a Vectorize index, when the
//      `AI` and `VECTORIZE` bindings exist. Entities are embedded at write time from the
//      ProjectRoom seams (fire-and-forget — indexing never fails or slows a write) with
//      deterministic vector ids, so re-indexing is an upsert and deletes are exact.
//   2. KEYWORD — a LIKE-based scan of the same three tables. Always available: it is the
//      fallback for self-hosted instances without the bindings (and for the workerd test
//      environment), and the guarantee that search never 503s.
//
// Vector id scheme: `task:<id>` and `plan:<id>` are single vectors; docs are chunked as
// `doc:<id>#<n>` (chunks of ~CHUNK_CHARS). Reindexing a doc upserts its current chunks
// and blind-deletes the id range above them (deleting a nonexistent id is a no-op), so
// no chunk-count bookkeeping is needed. Metadata carries {projectId, kind, id} — queries
// filter on projectId server-side and post-filter kind from the id prefix.
//
// The embedding/store dependencies are narrow interfaces so tests inject fakes (the same
// pattern as resolveCimdClient's doFetch): the Workers bindings only appear in fromEnv().

import type { Env } from './env';

export type SearchKind = 'task' | 'doc' | 'plan';

export interface SearchHit {
  kind: SearchKind;
  id: string;
  projectId: string;
  /** Task display key (tasks only). */
  key?: string;
  title: string;
  snippet: string;
  score: number;
  status?: string;
}

export interface EmbeddingClient {
  /** Embed texts → one vector each. */
  embed(texts: string[]): Promise<number[][]>;
}

export interface VectorStore {
  upsert(vectors: Array<{ id: string; values: number[]; metadata: Record<string, string> }>): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
  query(vector: number[], opts: { topK: number; filter?: Record<string, unknown> }): Promise<{
    matches: Array<{ id: string; score: number; metadata?: Record<string, unknown> }>;
  }>;
}

export interface SearchBackend { embedder: EmbeddingClient; store: VectorStore }

const EMBEDDING_MODEL = '@cf/baai/bge-m3';
const CHUNK_CHARS = 1500;
const MAX_DOC_CHUNKS = 32; // ~48k chars of a doc get embedded; beyond that is ignored

/** The live backend from Worker bindings, or null → keyword fallback. */
export function searchBackend(env: Env): SearchBackend | null {
  if (!env.AI || !env.VECTORIZE) return null;
  const ai = env.AI;
  const index = env.VECTORIZE;
  return {
    embedder: {
      async embed(texts) {
        const res = (await ai.run(EMBEDDING_MODEL, { text: texts })) as { data: number[][] };
        return res.data;
      },
    },
    store: {
      upsert: (vectors) => index.upsert(vectors),
      deleteByIds: (ids) => index.deleteByIds(ids),
      query: async (vector, opts) => {
        const r = await index.query(vector, { topK: opts.topK, filter: opts.filter as VectorizeVectorMetadataFilter | undefined, returnMetadata: 'all' });
        return { matches: r.matches.map((m) => ({ id: m.id, score: m.score, metadata: m.metadata as Record<string, unknown> })) };
      },
    },
  };
}

export function chunkText(text: string, size = CHUNK_CHARS): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const chunks: string[] = [];
  // Split on paragraph boundaries where possible, hard-split otherwise.
  let current = '';
  for (const para of trimmed.split(/\n{2,}/)) {
    if (current && current.length + para.length + 2 > size) { chunks.push(current); current = ''; }
    if (para.length > size) {
      if (current) { chunks.push(current); current = ''; }
      for (let i = 0; i < para.length; i += size) chunks.push(para.slice(i, i + size));
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** The text an entity is embedded from. Title/name is prepended to every chunk so short
 *  queries land even when the matching chunk is deep in the body. */
export function entityChunks(e: { kind: SearchKind; title: string; body?: string | null; extra?: string | null }): string[] {
  const head = [e.title, e.extra ?? ''].filter(Boolean).join('\n');
  if (e.kind !== 'doc') return [[head, (e.body ?? '').slice(0, CHUNK_CHARS * 4)].filter(Boolean).join('\n\n')];
  const body = chunkText(e.body ?? '');
  if (!body.length) return [head];
  return body.slice(0, MAX_DOC_CHUNKS).map((c) => `${head}\n\n${c}`);
}

const vecId = (kind: SearchKind, id: string, chunk: number) => (kind === 'doc' ? `doc:${id}#${chunk}` : `${kind}:${id}`);

/** (Re-)index one entity. Upserts current chunks, then blind-deletes the doc chunk range
 *  above them so a shrunk doc leaves no stale vectors. */
export async function indexEntity(
  backend: SearchBackend,
  entity: { kind: SearchKind; id: string; projectId: string; title: string; body?: string | null; extra?: string | null },
): Promise<void> {
  const chunks = entityChunks(entity);
  if (chunks.length) {
    const vectors = await backend.embedder.embed(chunks);
    await backend.store.upsert(vectors.map((values, i) => ({
      id: vecId(entity.kind, entity.id, i),
      values,
      metadata: { projectId: entity.projectId, kind: entity.kind, entityId: entity.id },
    })));
  }
  if (entity.kind === 'doc') {
    const stale: string[] = [];
    for (let i = chunks.length; i < MAX_DOC_CHUNKS; i++) stale.push(vecId('doc', entity.id, i));
    await backend.store.deleteByIds(stale);
  }
}

export async function removeEntity(backend: SearchBackend, kind: SearchKind, id: string): Promise<void> {
  const ids = kind === 'doc'
    ? Array.from({ length: MAX_DOC_CHUNKS }, (_, i) => vecId('doc', id, i))
    : [vecId(kind, id, 0)];
  await backend.store.deleteByIds(ids);
}

// ---------------------------------------------------------------------------------------
// Query side
// ---------------------------------------------------------------------------------------

export interface SearchOptions {
  q: string;
  /** Allowed project ids — results are hard-limited to these. */
  projectIds: string[];
  kinds?: SearchKind[];
  limit?: number;
}

const ALL_KINDS: SearchKind[] = ['task', 'doc', 'plan'];

/** Semantic query: embed, over-fetch, post-filter to allowed projects/kinds, dedupe doc
 *  chunks to their best-scoring chunk, hydrate display fields from D1. */
export async function semanticSearch(db: D1Database, backend: SearchBackend, opts: SearchOptions): Promise<SearchHit[]> {
  const limit = opts.limit ?? 12;
  const kinds = opts.kinds?.length ? opts.kinds : ALL_KINDS;
  const [vector] = await backend.embedder.embed([opts.q]);
  if (!vector) return [];
  // Single-project queries filter server-side; multi-project post-filters an over-fetch.
  const filter = opts.projectIds.length === 1 ? { projectId: { $eq: opts.projectIds[0] } } : undefined;
  const { matches } = await backend.store.query(vector, { topK: Math.min(limit * 5, 100), filter });
  const allowed = new Set(opts.projectIds);
  const best = new Map<string, { kind: SearchKind; id: string; projectId: string; score: number }>();
  for (const m of matches) {
    const kind = String(m.id).split(':')[0] as SearchKind;
    if (!kinds.includes(kind)) continue;
    const entityId = (m.metadata?.entityId as string) ?? String(m.id).slice(kind.length + 1).split('#')[0]!;
    const projectId = String(m.metadata?.projectId ?? '');
    if (!allowed.has(projectId)) continue;
    const prev = best.get(`${kind}:${entityId}`);
    if (!prev || m.score > prev.score) best.set(`${kind}:${entityId}`, { kind, id: entityId, projectId, score: m.score });
  }
  const ranked = [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  return hydrate(db, ranked);
}

async function hydrate(
  db: D1Database,
  refs: Array<{ kind: SearchKind; id: string; projectId: string; score: number }>,
): Promise<SearchHit[]> {
  const byKind: Record<SearchKind, string[]> = { task: [], doc: [], plan: [] };
  for (const r of refs) byKind[r.kind].push(r.id);
  const rows = new Map<string, { title: string; snippet: string; key?: string; status?: string }>();
  const inList = (ids: string[]) => ids.map(() => '?').join(',');
  if (byKind.task.length) {
    const { results } = await db.prepare(
      `SELECT id, key, title, substr(body, 1, 200) AS snippet, CASE WHEN failed_at IS NOT NULL THEN 'failed' ELSE status END AS status
       FROM tasks WHERE id IN (${inList(byKind.task)})`,
    ).bind(...byKind.task).all<{ id: string; key: string; title: string; snippet: string; status: string }>();
    for (const t of results) rows.set(`task:${t.id}`, { title: t.title, snippet: t.snippet ?? '', key: t.key, status: t.status });
  }
  if (byKind.doc.length) {
    const { results } = await db.prepare(
      `SELECT id, name, description, substr(body, 1, 200) AS snippet FROM docs WHERE id IN (${inList(byKind.doc)})`,
    ).bind(...byKind.doc).all<{ id: string; name: string; description: string; snippet: string }>();
    for (const d of results) rows.set(`doc:${d.id}`, { title: d.name, snippet: d.description || d.snippet || '' });
  }
  if (byKind.plan.length) {
    const { results } = await db.prepare(
      `SELECT id, title, description, substr(body, 1, 200) AS snippet, status FROM plans WHERE id IN (${inList(byKind.plan)})`,
    ).bind(...byKind.plan).all<{ id: string; title: string; description: string; snippet: string; status: string }>();
    for (const p of results) rows.set(`plan:${p.id}`, { title: p.title, snippet: p.description || p.snippet || '', status: p.status });
  }
  const hits: SearchHit[] = [];
  for (const r of refs) {
    const row = rows.get(`${r.kind}:${r.id}`);
    if (!row) continue; // vector for a row deleted since indexing — skip silently
    hits.push({ kind: r.kind, id: r.id, projectId: r.projectId, score: r.score, ...row });
  }
  return hits;
}

/** Keyword fallback: term-wise LIKE over the same three tables — every term must appear
 *  somewhere in the row (any column), so "payment retry" finds a doc whose NAME says
 *  payment and whose BODY says retries. Title hits rank above body-only hits. Same
 *  result shape as semanticSearch. */
export async function keywordSearch(db: D1Database, opts: SearchOptions): Promise<SearchHit[]> {
  const limit = opts.limit ?? 12;
  const kinds = opts.kinds?.length ? opts.kinds : ALL_KINDS;
  if (!opts.projectIds.length) return [];
  const terms = opts.q.replace(/[%_]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!terms.length) return [];
  const likes = terms.map((t) => `%${t}%`);
  const pids = opts.projectIds;
  const inPids = pids.map(() => '?').join(',');
  const hits: SearchHit[] = [];

  const run = async (cols: { title: string; body: string[]; table: string; select: string; order: string }) => {
    const columns = [cols.title, ...cols.body];
    const binds: unknown[] = [];
    // rank = how many terms hit the title (binds come first — rank sits in the SELECT).
    const rank = `(${likes.map((l) => { binds.push(l); return `(CASE WHEN ${cols.title} LIKE ? THEN 1 ELSE 0 END)`; }).join(' + ')})`;
    binds.push(...pids);
    // Every term must appear in SOME column; terms AND together.
    const where = likes.map((l) => `(${columns.map((cn) => { binds.push(l); return `${cn} LIKE ?`; }).join(' OR ')})`).join(' AND ');
    return db.prepare(
      `SELECT ${cols.select}, ${rank} AS rank FROM ${cols.table}
       WHERE project_id IN (${inPids}) AND ${where}
       ORDER BY rank DESC, ${cols.order} DESC LIMIT ${limit}`,
    ).bind(...binds).all();
  };

  if (kinds.includes('task')) {
    const { results } = await run({
      table: 'tasks', title: 'title', body: ['body', 'key'], order: 'updated_at',
      select: `id, project_id AS projectId, key, title, substr(body, 1, 200) AS snippet, CASE WHEN failed_at IS NOT NULL THEN 'failed' ELSE status END AS status`,
    });
    for (const t of results as Array<{ id: string; projectId: string; key: string; title: string; snippet: string; status: string; rank: number }>) {
      hits.push({ kind: 'task', id: t.id, projectId: t.projectId, key: t.key, title: t.title, snippet: t.snippet ?? '', status: t.status, score: (t.rank + 1) / (terms.length + 1) });
    }
  }
  if (kinds.includes('doc')) {
    const { results } = await run({
      table: 'docs', title: 'name', body: ['description', 'body'], order: 'updated_at',
      select: 'id, project_id AS projectId, name AS title, description, substr(body, 1, 200) AS snippet',
    });
    for (const d of results as Array<{ id: string; projectId: string; title: string; description: string; snippet: string; rank: number }>) {
      hits.push({ kind: 'doc', id: d.id, projectId: d.projectId, title: d.title, snippet: d.description || d.snippet || '', score: (d.rank + 1) / (terms.length + 1) });
    }
  }
  if (kinds.includes('plan')) {
    const { results } = await run({
      table: 'plans', title: 'title', body: ['description', 'body'], order: 'created_at',
      select: 'id, project_id AS projectId, title, description, substr(body, 1, 200) AS snippet, status',
    });
    for (const p of results as Array<{ id: string; projectId: string; title: string; description: string; snippet: string; status: string; rank: number }>) {
      hits.push({ kind: 'plan', id: p.id, projectId: p.projectId, title: p.title, snippet: p.description || p.snippet || '', status: p.status, score: (p.rank + 1) / (terms.length + 1) });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Backfill/repair a project's vector index: walk its tasks/docs/plans and re-embed a
 *  batch starting at `offset`. Shared by the REST endpoint and the reindex_search MCP
 *  tool. Returns progress so callers loop while `remaining > 0`. */
export async function reindexProject(
  env: Env, backend: SearchBackend, projectId: string, offset = 0, batch = 100,
): Promise<{ indexed: number; offset: number; total: number; remaining: number }> {
  const entities: Array<{ kind: SearchKind; id: string; title: string; body: string | null; extra: string | null }> = [];
  const [tasks, docs, plans] = await Promise.all([
    env.DB.prepare(
      `SELECT t.id, t.title, t.body,
              (SELECT GROUP_CONCAT(g.name, ' ') FROM task_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.task_id = t.id) AS extra
       FROM tasks t WHERE t.project_id = ? ORDER BY t.created_at`,
    ).bind(projectId).all<{ id: string; title: string; body: string | null; extra: string | null }>(),
    env.DB.prepare('SELECT id, name AS title, body, description AS extra FROM docs WHERE project_id = ? ORDER BY created_at')
      .bind(projectId).all<{ id: string; title: string; body: string | null; extra: string | null }>(),
    env.DB.prepare('SELECT id, title, body, description AS extra FROM plans WHERE project_id = ? ORDER BY created_at')
      .bind(projectId).all<{ id: string; title: string; body: string | null; extra: string | null }>(),
  ]);
  for (const t of tasks.results) entities.push({ kind: 'task', ...t });
  for (const d of docs.results) entities.push({ kind: 'doc', ...d });
  for (const p of plans.results) entities.push({ kind: 'plan', ...p });
  const slice = entities.slice(offset, offset + batch);
  for (const e of slice) {
    await indexEntity(backend, { kind: e.kind, id: e.id, projectId, title: e.title, body: e.body, extra: e.extra });
  }
  return { indexed: slice.length, offset, total: entities.length, remaining: Math.max(0, entities.length - offset - slice.length) };
}

/** The one entry point callers use: semantic when the bindings exist, keyword otherwise. */
export async function search(env: Env, opts: SearchOptions): Promise<{ mode: 'semantic' | 'keyword'; results: SearchHit[] }> {
  const backend = searchBackend(env);
  if (backend) {
    try {
      return { mode: 'semantic', results: await semanticSearch(env.DB, backend, opts) };
    } catch {
      // Embedding/index hiccups must not take search down — degrade to keyword.
    }
  }
  return { mode: 'keyword', results: await keywordSearch(env.DB, opts) };
}
