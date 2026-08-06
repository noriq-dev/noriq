// PLNR-256: the code-intelligence Vectorize adapter — a SECOND, separate logical index from
// PLNR-184/255's operational `noriq-search` (§9). Deliberately its own module so the two
// indexes cannot share a code path by accident: this file never imports `../search`'s
// `searchBackend`/`indexEntity`/etc, and nothing here ever reaches for `env.VECTORIZE`.
//
// The code graph is EMPTY today — nothing in src/ writes a file/symbol/api/test node yet
// (PLNR-262 does that). This module ships the adapter, the binding, generation-scoped
// publish/retire, query-time generation filtering, and the resumable rebuild — all as
// storage-free functions exercised against caller-supplied entities (a test seeds them; a
// future Phase 5 ingest pipeline will supply real ones). It does NOT build that ingest.
//
// Vector id = the entity's stable URI (buildEntityUri, §18) — generation-free by design, so
// re-indexing the same file/symbol under a later generation is a plain upsert at the same id;
// `generationId` rides in metadata only. This is why "retiring a superseded generation" is not
// "find every vector with metadata.generationId = X" (Vectorize has no delete-by-filter) — it is
// the ENTITIES REMOVED between generations (an ingest manifest's `deletions`, see
// `IndexGenerationManifest` in @noriq-dev/shared) whose URIs need an explicit `removeCodeEntity`.
// Everything else is a same-id upsert whose metadata simply advances to the new generation.
//
// Filtering server-side on `projectId` or `generationId` requires an explicitly created
// Vectorize metadata index per property (`wrangler vectorize create-metadata-index … --property-
// name=…`) — see env.ts's CODE_VECTORIZE doc comment and README.md for the provisioning
// commands. The fake store used in tests filters by plain object comparison and will happily
// honour a filter the real index would reject, so an unprovisioned property passes every test
// and fails only in production.

import type { Env } from '../env';
import { chunkText, type EmbeddingClient, type VectorStore } from '../search';

const CODE_EMBEDDING_MODEL = '@cf/baai/bge-m3'; // same model as the operational index today;
// §9 anticipates a code-specialized one later — this seam (a narrow EmbeddingClient) is what
// lets that swap happen without touching indexCodeEntity/rebuildCodeIndex.
const CHUNK_CHARS = 1500;
const MAX_CHUNKS = 32;

export interface CodeSearchBackend {
  embedder: EmbeddingClient;
  store: VectorStore;
}

/** The live backend from Worker bindings, or null → callers degrade to lexical/graph (§20).
 *  Reaches for `env.CODE_VECTORIZE` ONLY — never `env.VECTORIZE`, which is what keeps a code
 *  reindex from ever touching an operational memory/episode vector. */
export function codeSearchBackend(env: Env): CodeSearchBackend | null {
  if (!env.AI || !env.CODE_VECTORIZE) return null;
  const ai = env.AI;
  const index = env.CODE_VECTORIZE;
  return {
    embedder: {
      async embed(texts) {
        const res = (await ai.run(CODE_EMBEDDING_MODEL, { text: texts })) as { data: number[][] };
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

export type CodeEntityType = 'file' | 'symbol' | 'api' | 'test' | 'database_entity' | 'procedure' | 'artifact';

export interface CodeEntity {
  /** Stable entity URI (buildEntityUri) — the vector id. Generation-free (§18). */
  uri: string;
  projectId: string;
  repositoryKey: string;
  /** Rides in vector METADATA only — never part of the id (see module comment). */
  generationId: string;
  type: CodeEntityType;
  label: string;
  /** Chunked when present (file/doc content); a bare label-only vector when absent — nothing
   *  supplies real repository content before Phase 5's ingest lands. */
  content?: string | null;
}

// PLNR-262: the chunk separator is NOT `#` — symbol/test/api URIs already end in `#{name}`
// (PLNR-278's fragment convention), so a multi-chunk entity's OLD `${uri}#${chunk}` id produced
// `noriq://symbol/K/repo/x.ts#foo#3`, and parseEntityUri (splitting on the FIRST `#`) read that
// back as `name: "foo#3"`. Chunk 0 was always safe (it IS the bare uri), which is why this was
// invisible until an entity's content exceeded one chunk. U+241E (SYMBOL FOR RECORD SEPARATOR)
// cannot appear in a real path or identifier, so appending it never collides with a `#name`
// fragment or a path segment — nothing in this codebase parses a vector id back through
// parseEntityUri today (queryCodeIndex reads the real uri from vector METADATA, never the id),
// but this keeps that reconstructable rather than silently ambiguous.
const CHUNK_SEPARATOR = '␞';
const vecId = (uri: string, chunk: number) => (chunk === 0 ? uri : `${uri}${CHUNK_SEPARATOR}${chunk}`);

function entityChunks(e: CodeEntity): string[] {
  const head = e.label;
  if (!e.content) return [head];
  const body = chunkText(e.content, CHUNK_CHARS);
  if (!body.length) return [head];
  return body.slice(0, MAX_CHUNKS).map((c) => `${head}\n\n${c}`);
}

/** (Re-)index one code entity. Upserts current chunks at `${uri}[#n]`, then blind-deletes the
 *  chunk range above them (mirrors search.ts's doc handling) so shrunk content leaves no stale
 *  chunks. Re-indexing the SAME uri under a LATER generationId is exactly this — a plain
 *  upsert whose metadata advances, never a new vector id. */
export async function indexCodeEntity(backend: CodeSearchBackend, entity: CodeEntity): Promise<void> {
  const chunks = entityChunks(entity);
  const vectors = await backend.embedder.embed(chunks);
  await backend.store.upsert(
    vectors.map((values, i) => ({
      id: vecId(entity.uri, i),
      values,
      metadata: {
        projectId: entity.projectId,
        repositoryKey: entity.repositoryKey,
        generationId: entity.generationId,
        type: entity.type,
        uri: entity.uri,
      },
    })),
  );
  const stale: string[] = [];
  for (let i = chunks.length; i < MAX_CHUNKS; i++) stale.push(vecId(entity.uri, i));
  await backend.store.deleteByIds(stale);
}

/** Drop every chunk of one code entity by its stable URI — the retirement primitive for
 *  entities an ingest generation's manifest reports as DELETED (see module comment: this is
 *  the only real "superseded vector" case, since a surviving entity is a same-id upsert). */
export async function removeCodeEntity(backend: CodeSearchBackend, uri: string): Promise<void> {
  const ids = Array.from({ length: MAX_CHUNKS }, (_, i) => vecId(uri, i));
  await backend.store.deleteByIds(ids);
}

export interface CodeSearchHit {
  uri: string;
  type: string;
  repositoryKey: string;
  generationId: string;
  score: number;
}

export interface CodeQueryOptions {
  q: string;
  projectId: string;
  repositoryKey?: string;
  /** Query-time generation filter (§4/§8) — NEVER "we deleted the old generation's vectors".
   *  A vector from a generation not in this set is excluded here even if its delete was never
   *  attempted or failed; correctness comes from this filter, not from cleanup succeeding. */
  activeGenerationIds?: string[];
  topK?: number;
}

/** Semantic query over the code index, scoped to a project (and optionally one repository),
 *  filtered to the caller's active generation(s). Dedupes chunks of the same uri to its
 *  best-scoring chunk, same technique as search.ts's semanticSearch. */
export async function queryCodeIndex(backend: CodeSearchBackend, opts: CodeQueryOptions): Promise<CodeSearchHit[]> {
  const topK = opts.topK ?? 12;
  const [vector] = await backend.embedder.embed([opts.q]);
  if (!vector) return [];
  const filter: Record<string, unknown> = { projectId: { $eq: opts.projectId } };
  if (opts.repositoryKey) filter.repositoryKey = { $eq: opts.repositoryKey };
  const { matches } = await backend.store.query(vector, { topK: Math.min(topK * 3, 100), filter });
  const allowedGenerations = opts.activeGenerationIds ? new Set(opts.activeGenerationIds) : null;
  const best = new Map<string, CodeSearchHit>();
  for (const m of matches) {
    const projectId = String(m.metadata?.projectId ?? '');
    if (projectId !== opts.projectId) continue; // belt-and-suspenders — see search.ts's own note on this being the real leak surface
    const generationId = String(m.metadata?.generationId ?? '');
    if (allowedGenerations && !allowedGenerations.has(generationId)) continue;
    const uri = String(m.metadata?.uri ?? m.id);
    const prev = best.get(uri);
    if (!prev || m.score > prev.score) {
      best.set(uri, { uri, type: String(m.metadata?.type ?? 'unknown'), repositoryKey: String(m.metadata?.repositoryKey ?? ''), generationId, score: m.score });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, topK);
}

export interface RebuildCodeIndexProgress {
  indexed: number;
  offset: number;
  total: number;
  remaining: number;
}

/** Resumable, idempotent rebuild over a caller-supplied entity list — mirrors search.ts's
 *  `reindexProject` contract exactly: `(offset, batch) → {indexed, offset, total, remaining}`,
 *  caller loops while `remaining > 0`. Deterministic vector ids (uri-keyed) make re-running the
 *  whole thing twice produce the same vector set rather than duplicates. Takes the entities as
 *  a parameter rather than reading them from the graph itself: nothing populates file/symbol/
 *  api/test nodes before PLNR-262, and this function has no opinion on where they come from. */
export async function rebuildCodeIndex(
  backend: CodeSearchBackend,
  entities: CodeEntity[],
  offset = 0,
  batch = 100,
): Promise<RebuildCodeIndexProgress> {
  const slice = entities.slice(offset, offset + batch);
  for (const e of slice) await indexCodeEntity(backend, e);
  return { indexed: slice.length, offset, total: entities.length, remaining: Math.max(0, entities.length - offset - slice.length) };
}
