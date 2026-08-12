// PLNR-248: portable ProjectMemory snapshot export to R2.
//
// This module is pure pipeline — it never opens storage itself. The ProjectMemory DO (the only
// thing that can read its own SQLite) drives it with two synchronous callbacks (`readBatch`,
// `tableCount`) and its own `env.FILES`; this file only knows how to turn rows into bounded
// gzip chunks, checksum them, and assemble the manifest PLNR-249 will validate against.
//
// R2 layout, project-namespaced by construction — one project's backup can never collide with
// or overwrite another's, even at the same exportedAt:
//
//   memory-backups/<projectId>/<exportedAt>/manifest.json
//   memory-backups/<projectId>/<exportedAt>/<table>/chunk-<n>.jsonl.gz
//
// The manifest is written LAST. Its presence is what marks a backup complete — a crashed or
// partial export leaves chunks on disk but no manifest, and nothing downstream may treat that
// as a restorable backup.
import type { Env } from '../env';
import { MemoryBackupManifest, type MemoryBackupManifest as Manifest } from '@noriq-dev/shared';

export const MEMORY_BACKUP_FORMAT_VERSION = 1;

/** Rows per chunk. A bound, not a tune-for-performance number — the point is that the exporter
 *  never holds more than one chunk's worth of one table's rows in memory at a time. */
export const MEMORY_BACKUP_CHUNK_ROWS = 500;

// Exported for restore.ts (PLNR-249) and lifecycle.ts (PLNR-250) — they read/enumerate exactly
// what this file writes, so the prefix convention, the compression codec, and the checksum
// algorithm are shared, not re-derived.
export const projectBackupsPrefix = (projectId: string): string => `memory-backups/${projectId}/`;
export const backupPrefix = (projectId: string, exportedAt: string): string =>
  `${projectBackupsPrefix(projectId)}${exportedAt.replace(/[:.]/g, '-')}`;

async function drainStream(readable: ReadableStream<Uint8Array>, maxBytes = Number.POSITIVE_INFINITY): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = readable.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`decompressed payload exceeds ${maxBytes} bytes`);
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

export async function gzip(text: string): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  const writeDone = writer.write(new TextEncoder().encode(text)).then(() => writer.close());
  const out = await drainStream(cs.readable);
  await writeDone;
  return out;
}

export async function gunzip(bytes: Uint8Array, maxOutputBytes = Number.POSITIVE_INFINITY): Promise<string> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  // Same ArrayBufferLike/ArrayBuffer generic mismatch as sha256HexBytes above — bytes here are
  // always a freshly allocated ArrayBuffer (R2's arrayBuffer() produces one).
  const writeDone = writer.write(bytes as unknown as Uint8Array<ArrayBuffer>).then(() => writer.close());
  try {
    const out = await drainStream(ds.readable, maxOutputBytes);
    await writeDone;
    return new TextDecoder().decode(out);
  } catch (error) {
    await writer.abort(error).catch(() => {});
    await writeDone.catch(() => {});
    throw error;
  }
}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  // TS's DOM lib types Uint8Array's `buffer` as possibly-SharedArrayBuffer, which digest()'s
  // BufferSource rejects; these bytes are always a freshly allocated ArrayBuffer (gzip() and
  // R2's arrayBuffer() both produce one), so the cast is safe, not a type-check bypass.
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface ExportMemorySnapshotOptions {
  env: Env;
  projectId: string;
  schemaVersion: number;
  memoryRevision: number;
  tier: 'core' | 'full';
  exportedAt: string;
  /** The tables to export, parents before children. This module has no knowledge of
   *  ProjectMemory's own schema — the caller (the DO, which owns that list) supplies it,
   *  keeping this pipeline generic and avoiding an import cycle back into the DO module. */
  tables: readonly string[];
  /** Synchronous — SqlStorage.exec() is sync, and this must never be awaited mid-batch in a way
   *  that lets the chunk grow past `chunkRowLimit` rows. */
  readBatch: (table: string, offset: number, limit: number) => Array<Record<string, unknown>>;
  tableCount: (table: string) => number;
  chunkRowLimit?: number;
}

export interface ExportMemorySnapshotResult {
  manifest: Manifest;
  manifestKey: string;
  prefix: string;
}

export interface MemorySnapshotChunkWriteResult {
  relKey: string;
  key: string;
  checksum: string;
  serializedBytes: number;
  compressedBytes: number;
}

/** Write one already-bounded JSONL chunk using the original PLNR-248 key/metadata/checksum
 * contract. The session exporter and the legacy one-shot helper share this exact sink. */
export async function writeMemorySnapshotChunk(opts: {
  env: Env;
  prefix: string;
  table: string;
  chunkIndex: number;
  rowOffset: number;
  rowCount: number;
  jsonl: string;
  serializedBytes?: number;
}): Promise<MemorySnapshotChunkWriteResult> {
  if (!opts.env.FILES) throw new Error('R2 (FILES) not configured');
  const compressed = await gzip(opts.jsonl);
  const relKey = `${opts.table}/chunk-${opts.chunkIndex}.jsonl.gz`;
  const key = `${opts.prefix}/${relKey}`;
  await opts.env.FILES.put(key, compressed, {
    httpMetadata: { contentType: 'application/gzip' },
    customMetadata: { table: opts.table, offset: String(opts.rowOffset), rows: String(opts.rowCount) },
  });
  return {
    relKey,
    key,
    checksum: await sha256HexBytes(compressed),
    serializedBytes: opts.serializedBytes ?? new TextEncoder().encode(opts.jsonl).byteLength,
    compressedBytes: compressed.byteLength,
  };
}

/** Assemble and publish the unchanged format-v1 manifest. This remains the final R2 write: until
 * it succeeds, any chunks from an interrupted session are debris rather than a backup. */
export async function writeMemorySnapshotManifest(opts: {
  env: Env;
  projectId: string;
  schemaVersion: number;
  memoryRevision: number;
  tier: 'core' | 'full';
  exportedAt: string;
  tableCounts: Record<string, number>;
  checksums: Record<string, string>;
  r2EvidenceRefs: string[];
}): Promise<ExportMemorySnapshotResult> {
  if (!opts.env.FILES) throw new Error('R2 (FILES) not configured');
  const prefix = backupPrefix(opts.projectId, opts.exportedAt);
  const manifest = MemoryBackupManifest.parse({
    formatVersion: MEMORY_BACKUP_FORMAT_VERSION,
    projectMemorySchemaVersion: opts.schemaVersion,
    projectId: opts.projectId,
    memoryRevision: opts.memoryRevision,
    exportedAt: opts.exportedAt,
    tier: opts.tier,
    tableCounts: opts.tableCounts,
    checksums: opts.checksums,
    activeIndexGenerations: [],
    r2EvidenceRefs: opts.r2EvidenceRefs,
  });
  const manifestKey = `${prefix}/manifest.json`;
  await opts.env.FILES.put(manifestKey, JSON.stringify(manifest), { httpMetadata: { contentType: 'application/json' } });
  return { manifest, manifestKey, prefix };
}

/**
 * Export every BACKUP_TABLES table in bounded row batches, gzip each batch as its own R2
 * object, and write the manifest last. Throws if `env.FILES` is unbound — callers (the DO RPC,
 * the admin route, the cron) are responsible for the graceful-degradation response shape.
 */
export async function exportMemorySnapshot(opts: ExportMemorySnapshotOptions): Promise<ExportMemorySnapshotResult> {
  if (!opts.env.FILES) throw new Error('R2 (FILES) not configured');
  const prefix = backupPrefix(opts.projectId, opts.exportedAt);
  const limit = opts.chunkRowLimit ?? MEMORY_BACKUP_CHUNK_ROWS;

  const tableCounts: Record<string, number> = {};
  const checksums: Record<string, string> = {};
  const r2EvidenceRefs: string[] = [];

  for (const table of opts.tables) {
    const total = opts.tableCount(table);
    tableCounts[table] = total;
    let offset = 0;
    let chunkIndex = 0;
    while (offset < total) {
      const rows = opts.readBatch(table, offset, limit);
      if (rows.length === 0) break; // defensive — a shrinking table mid-export stops cleanly
      const written = await writeMemorySnapshotChunk({
        env: opts.env, prefix, table, chunkIndex, rowOffset: offset, rowCount: rows.length,
        jsonl: rows.map((r) => JSON.stringify(r)).join('\n'),
      });
      checksums[written.relKey] = written.checksum;
      r2EvidenceRefs.push(written.key);
      offset += rows.length;
      chunkIndex++;
    }
  }

  return writeMemorySnapshotManifest({
    env: opts.env, projectId: opts.projectId, schemaVersion: opts.schemaVersion,
    memoryRevision: opts.memoryRevision, tier: opts.tier, exportedAt: opts.exportedAt,
    tableCounts, checksums, r2EvidenceRefs,
  });
}

/**
 * Re-fetch every chunk a manifest names and verify its checksum. Used by tests (and PLNR-249's
 * restore validation) to prove tampering — a corrupted or missing chunk — is detectable from
 * the manifest alone, without trusting anything about the chunk's content first.
 */
export async function verifyMemorySnapshot(
  env: Env,
  manifest: Manifest,
): Promise<{ ok: true } | { ok: false; problems: string[] }> {
  if (!env.FILES) return { ok: false, problems: ['R2 (FILES) not configured'] };
  const files = env.FILES;
  const prefix = backupPrefix(manifest.projectId, manifest.exportedAt);
  const problems: string[] = [];
  for (const [relKey, expectedHash] of Object.entries(manifest.checksums)) {
    const obj = await files.get(`${prefix}/${relKey}`);
    if (!obj) {
      problems.push(`missing chunk: ${relKey}`);
      continue;
    }
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const actualHash = await sha256HexBytes(bytes);
    if (actualHash !== expectedHash) problems.push(`checksum mismatch: ${relKey}`);
  }
  return problems.length ? { ok: false, problems } : { ok: true };
}
