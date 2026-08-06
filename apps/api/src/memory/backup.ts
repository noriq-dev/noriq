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
const DEFAULT_CHUNK_ROWS = 500;

const backupPrefix = (projectId: string, exportedAt: string): string =>
  `memory-backups/${projectId}/${exportedAt.replace(/[:.]/g, '-')}`;

async function gzip(text: string): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  const bytesIn = new TextEncoder().encode(text);
  const writeDone = writer.write(bytesIn).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  await writeDone;
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
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

/**
 * Export every BACKUP_TABLES table in bounded row batches, gzip each batch as its own R2
 * object, and write the manifest last. Throws if `env.FILES` is unbound — callers (the DO RPC,
 * the admin route, the cron) are responsible for the graceful-degradation response shape.
 */
export async function exportMemorySnapshot(opts: ExportMemorySnapshotOptions): Promise<ExportMemorySnapshotResult> {
  if (!opts.env.FILES) throw new Error('R2 (FILES) not configured');
  const files = opts.env.FILES;
  const prefix = backupPrefix(opts.projectId, opts.exportedAt);
  const limit = opts.chunkRowLimit ?? DEFAULT_CHUNK_ROWS;

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
      const jsonl = rows.map((r) => JSON.stringify(r)).join('\n');
      const compressed = await gzip(jsonl);
      const relKey = `${table}/chunk-${chunkIndex}.jsonl.gz`;
      const key = `${prefix}/${relKey}`;
      await files.put(key, compressed, {
        httpMetadata: { contentType: 'application/gzip' },
        customMetadata: { table, offset: String(offset), rows: String(rows.length) },
      });
      checksums[relKey] = await sha256HexBytes(compressed);
      r2EvidenceRefs.push(key);
      offset += rows.length;
      chunkIndex++;
    }
  }

  const manifest = MemoryBackupManifest.parse({
    formatVersion: MEMORY_BACKUP_FORMAT_VERSION,
    projectMemorySchemaVersion: opts.schemaVersion,
    projectId: opts.projectId,
    memoryRevision: opts.memoryRevision,
    exportedAt: opts.exportedAt,
    tier: opts.tier,
    tableCounts,
    checksums,
    // Phase 5 (PLNR-261/262) is what makes an index generation meaningfully "active" content —
    // nothing here fabricates an entry before that exists.
    activeIndexGenerations: [],
    r2EvidenceRefs,
  });
  const manifestKey = `${prefix}/manifest.json`;
  await files.put(manifestKey, JSON.stringify(manifest), { httpMetadata: { contentType: 'application/json' } });

  return { manifest, manifestKey, prefix };
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
