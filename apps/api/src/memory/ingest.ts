// PLNR-260/261: repository-index and episode ingest — the TRANSPORT, validation, and staged-row
// parsing layer. This module is pure pipeline (like backup.ts/restore.ts/retrieval.ts/graph-
// queries.ts): it never opens `ctx.storage` and holds no Durable Object state itself.
// Index-generation state (PLNR-261) lives in ProjectMemory's own SQL tables
// (index_generations/index_batches/index_staged_entities/index_staged_edges) — this file only
// decides whether a batch's BYTES are well-formed and shapes a decoded row into a typed staged
// entity/edge; ProjectMemory's methods drive the actual stage/validate/promote sequence.
// Episode ingest (below) still uses the in-memory bridge PLNR-260 built — real episode RECORD
// semantics remain PLNR-263's, so there is no SQL staging to move it onto yet.
import { gunzip, sha256HexBytes } from './backup';

/** Per-batch byte ceiling — a bound, not a tune-for-performance number (mirrors backup.ts's
 *  DEFAULT_CHUNK_ROWS comment): the point is that a batch is never allowed to grow the Worker's
 *  memory past this, not that this number is tuned for throughput. */
export const MAX_INGEST_BATCH_BYTES = 8 * 1024 * 1024;
export const INGEST_TOKEN_TTL_SECONDS = 15 * 60;

/** Read a stream up to `maxBytes`, throwing the moment it is exceeded — never buffers more than
 *  one over-limit chunk beyond the ceiling. Works whether or not the request carries a
 *  Content-Length (a chunked/streamed body has none — PLNR-98's streaming precedent). */
export async function readBoundedBody(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`batch exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Verify a batch's declared hash BEFORE any row is parsed out of it — a mismatch throws without
 *  ever decompressing/parsing the (possibly hostile) payload. */
export async function verifyBatchChecksum(bytes: Uint8Array, expectedHash: string): Promise<void> {
  const actual = await sha256HexBytes(bytes);
  if (actual !== expectedHash) throw new Error(`batch checksum mismatch: expected ${expectedHash}, got ${actual}`);
}

/** Decode a checksum-verified, gzip'd JSONL batch into rows. Row SHAPE is not this task's concern
 *  (PLNR-261/262 map rows into real entities) — only that the bytes decode. */
export async function decodeBatchRows(bytes: Uint8Array): Promise<Array<Record<string, unknown>>> {
  const text = await gunzip(bytes);
  if (!text.length) return [];
  return text.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
}

export type IngestStatus = 'pending' | 'complete' | 'aborted';

// ---------------------------------------------------------------------------
// Staged row parsing (PLNR-261) — a decoded batch row is one of two shapes, discriminated by
// `kind`. This is a server-internal wire convention (no Runner produces real rows before
// RUN-215+), kept deliberately out of packages/shared: it is not yet a contract anything
// vendors, so there is nothing to keep server-first here.
// ---------------------------------------------------------------------------

export interface StagedEntityRow {
  kind: 'node';
  uri: string;
  type: string;
  label: string;
  content: string | null;
}

export interface StagedEdgeRow {
  kind: 'edge';
  type: string;
  from: string;
  to: string;
}

export type StagedRow = StagedEntityRow | StagedEdgeRow;

/** Shape-check one decoded batch row. Throws naming what's missing — never silently drops a
 *  malformed row into staging. */
export function parseStagedRow(row: Record<string, unknown>): StagedRow {
  if (row.kind === 'node') {
    if (typeof row.uri !== 'string' || !row.uri) throw new Error('staged node row missing uri');
    if (typeof row.type !== 'string' || !row.type) throw new Error('staged node row missing type');
    if (typeof row.label !== 'string' || !row.label) throw new Error('staged node row missing label');
    return { kind: 'node', uri: row.uri, type: row.type, label: row.label, content: typeof row.content === 'string' ? row.content : null };
  }
  if (row.kind === 'edge') {
    if (typeof row.type !== 'string' || !row.type) throw new Error('staged edge row missing type');
    if (typeof row.from !== 'string' || !row.from) throw new Error('staged edge row missing from');
    if (typeof row.to !== 'string' || !row.to) throw new Error('staged edge row missing to');
    return { kind: 'edge', type: row.type, from: row.from, to: row.to };
  }
  throw new Error(`staged row has unknown kind: ${JSON.stringify(row.kind)}`);
}

// ---------------------------------------------------------------------------
// Episode ingest (§14) — the same begin/batch/complete/abort/status shape, deliberately not
// sharing IndexGenerationManifest: an episode upload has no repository/branch/baseId. This
// remains an IN-MEMORY bridge (rows accumulate on the `IngestEpisodeState` instance, not in
// SQL staging tables like index ingest's PLNR-261 upgrade) — that is fine for episodes because
// nothing here needs to survive a hibernation eviction mid-upload the way a multi-hour repo
// index does; a dropped in-flight upload just gets re-POSTed. PLNR-263 is the real episode
// RECORD writer: `rows` accumulated here are parsed as partial episode enrichments and handed to
// `ProjectMemory.recordEpisode` by `completeEpisodeIngest`, which is also reachable from
// `ProjectRoom`'s durable terminal-run job via `memory/episodes.ts`'s `recordEpisodeForRun`
// — the two paths converge on the SAME upsert-by-run_id writer (see episodes.ts).
// ---------------------------------------------------------------------------

export interface EpisodeUploadManifest {
  scopeId: string; // caller-chosen episode upload id (e.g. the runId)
  projectId: string;
  batchCount: number;
}

export interface IngestEpisodeState {
  manifest: EpisodeUploadManifest;
  receivedBatches: Set<number>;
  /** Accumulated across every accepted batch, in receipt order — read back by
   *  `completeEpisodeIngest` to parse each row as a partial enrichment. Never the raw transcript:
   *  a row here is whatever the daemon's episode-upload payload shapes it as (§18), and nothing
   *  in this module inspects its fields — that parsing is PLNR-263's `recordEpisodeForRun`/
   *  `ProjectMemory.recordEpisode`'s job, not this transport layer's. */
  rows: Array<Record<string, unknown>>;
  status: IngestStatus;
}

export function beginIngestEpisode(existing: IngestEpisodeState | undefined, manifest: EpisodeUploadManifest): IngestEpisodeState {
  if (existing && existing.status !== 'pending') {
    throw new Error(`episode upload ${manifest.scopeId} already ${existing.status} — this purpose cannot be reopened`);
  }
  if (!manifest.scopeId || !Number.isInteger(manifest.batchCount) || manifest.batchCount < 1) {
    throw new Error('invalid episode upload manifest');
  }
  return existing ?? { manifest, receivedBatches: new Set(), rows: [], status: 'pending' };
}

export function applyIngestEpisodeBatch(
  state: IngestEpisodeState,
  batchNumber: number,
  rows: Array<Record<string, unknown>>,
): { deduped: boolean } {
  if (state.status !== 'pending') {
    throw new Error(`episode upload ${state.manifest.scopeId} is already ${state.status} — refusing a batch for a completed purpose`);
  }
  if (state.receivedBatches.has(batchNumber)) return { deduped: true };
  state.receivedBatches.add(batchNumber);
  state.rows.push(...rows);
  return { deduped: false };
}

export function completeIngestEpisode(state: IngestEpisodeState): void {
  if (state.status !== 'pending') throw new Error(`episode upload ${state.manifest.scopeId} is already ${state.status}`);
  if (state.receivedBatches.size !== state.manifest.batchCount) {
    throw new Error(
      `episode upload ${state.manifest.scopeId} expected ${state.manifest.batchCount} batches, received ${state.receivedBatches.size}`,
    );
  }
  state.status = 'complete';
}

export function abortIngestEpisode(state: IngestEpisodeState): void {
  if (state.status === 'complete') throw new Error(`episode upload ${state.manifest.scopeId} already completed — cannot abort`);
  state.status = 'aborted';
}
