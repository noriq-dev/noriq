// PLNR-260: repository-index and episode ingest — the TRANSPORT and validation layer. This
// module is pure pipeline (like backup.ts/restore.ts/retrieval.ts/graph-queries.ts): it never
// opens `ctx.storage` and holds no Durable Object state itself — ProjectMemory drives it and
// keeps the actual in-flight generation/episode state (see ProjectMemory.ts's ingestGenerations
// map). Staged-generation semantics — count/hash reconciliation against real entity content,
// graph-reference validation, and atomic activation — are PLNR-261's; this file only decides
// whether a batch's BYTES are well-formed and whether the batch SEQUENCE is complete.
import { IndexGenerationManifest, IndexBatch } from '@noriq-dev/shared';
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

// ---------------------------------------------------------------------------
// Pure begin/batch/complete state — operates on plain data ProjectMemory holds in memory
// (this task's bridge; PLNR-261 replaces the storage with real staged-generation tables without
// changing this module's shape). Every function here throws with a message naming what's wrong;
// callers turn that into the wire error.
// ---------------------------------------------------------------------------

export type IngestStatus = 'pending' | 'complete' | 'aborted';

export interface IngestGenerationState {
  manifest: IndexGenerationManifest;
  receivedBatches: Set<number>;
  rowCount: number;
  status: IngestStatus;
}

/** Start (or idempotently resume) a generation upload. Refuses to reopen one already completed
 *  or aborted — that refusal must come from this durable server-side state, not from the token
 *  (a stateless HMAC capability has no revocation list to check "already used" against). */
export function beginIngestGeneration(existing: IngestGenerationState | undefined, manifest: IndexGenerationManifest): IngestGenerationState {
  if (existing && existing.status !== 'pending') {
    throw new Error(`generation ${manifest.generationId} already ${existing.status} — this purpose cannot be reopened`);
  }
  IndexGenerationManifest.parse(manifest);
  return existing ?? { manifest, receivedBatches: new Set(), rowCount: 0, status: 'pending' };
}

/** Apply one verified batch. Idempotent on batchNumber — resubmitting a batch already received
 *  converges (same row count, `deduped: true`) rather than double-counting. */
export function applyIngestBatch(
  state: IngestGenerationState,
  batch: IndexBatch,
  rows: Array<Record<string, unknown>>,
): { deduped: boolean } {
  if (state.status !== 'pending') {
    throw new Error(`generation ${state.manifest.generationId} is already ${state.status} — refusing a batch for a completed purpose`);
  }
  if (batch.generationId !== state.manifest.generationId) {
    throw new Error(`batch generationId ${batch.generationId} does not match generation ${state.manifest.generationId}`);
  }
  if (state.receivedBatches.has(batch.batchNumber)) return { deduped: true };
  state.receivedBatches.add(batch.batchNumber);
  state.rowCount += rows.length;
  return { deduped: false };
}

/** Mark the generation complete once every batch NUMBER the manifest declares has arrived — a
 *  structural completeness check, not the deeper count/hash/graph-reference reconciliation
 *  against real entity content (PLNR-261). */
export function completeIngestGeneration(state: IngestGenerationState): void {
  if (state.status !== 'pending') throw new Error(`generation ${state.manifest.generationId} is already ${state.status}`);
  if (state.receivedBatches.size !== state.manifest.batchCount) {
    throw new Error(
      `generation ${state.manifest.generationId} expected ${state.manifest.batchCount} batches, received ${state.receivedBatches.size}`,
    );
  }
  state.status = 'complete';
}

export function abortIngestGeneration(state: IngestGenerationState): void {
  if (state.status === 'complete') throw new Error(`generation ${state.manifest.generationId} already completed — cannot abort`);
  state.status = 'aborted';
}

// ---------------------------------------------------------------------------
// Episode ingest (§14) — the same begin/batch/complete/abort/status shape, deliberately not
// sharing IndexGenerationManifest: an episode upload has no repository/branch/baseId, and this
// task lands only the ENDPOINT (deferred: real episode RECORD semantics — the deterministic
// skeleton, self-summary enrichment, and the episodes table's writer — are PLNR-263's;
// `_seedEpisodeForTest` remains the only episode writer until then).
// ---------------------------------------------------------------------------

export interface EpisodeUploadManifest {
  scopeId: string; // caller-chosen episode upload id (e.g. the runId)
  projectId: string;
  batchCount: number;
}

export interface IngestEpisodeState {
  manifest: EpisodeUploadManifest;
  receivedBatches: Set<number>;
  rowCount: number;
  status: IngestStatus;
}

export function beginIngestEpisode(existing: IngestEpisodeState | undefined, manifest: EpisodeUploadManifest): IngestEpisodeState {
  if (existing && existing.status !== 'pending') {
    throw new Error(`episode upload ${manifest.scopeId} already ${existing.status} — this purpose cannot be reopened`);
  }
  if (!manifest.scopeId || !Number.isInteger(manifest.batchCount) || manifest.batchCount < 1) {
    throw new Error('invalid episode upload manifest');
  }
  return existing ?? { manifest, receivedBatches: new Set(), rowCount: 0, status: 'pending' };
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
  state.rowCount += rows.length;
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
