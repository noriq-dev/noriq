// PLNR-249: generation-based ProjectMemory restore — the R2/manifest-facing half.
//
// Like backup.ts, this module never opens SQLite storage — only the ProjectMemory DO can read
// or write its own SQLite. This file owns everything that happens BEFORE any staging write:
// fetching the manifest, checking it names this project and a compatible schema version, and
// reading chunks back one at a time with their checksum re-verified before a single row of
// theirs is trusted. The DO drives the staging/validate/switch/rollback SQL sequence itself,
// consuming what this module yields.
import type { Env } from '../env';
import { MemoryBackupManifest, type MemoryBackupManifest as Manifest } from '@noriq-dev/shared';
import {
  backupPrefix,
  gunzip,
  MEMORY_BACKUP_CHUNK_ROWS,
  MEMORY_BACKUP_FORMAT_VERSION,
  sha256HexBytes,
} from './backup';

export const MAX_MEMORY_SNAPSHOT_CHUNK_COMPRESSED_BYTES = 32 * 1024 * 1024;
export const MAX_MEMORY_SNAPSHOT_CHUNK_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;

export interface ManifestHeaderCheck {
  ok: boolean;
  problems: string[];
}

/**
 * Pure, synchronous validation run before staging or fetching any R2 chunk. The caller may
 * supply its exact table inventory so unknown, missing, or discontinuous chunk layouts fail at
 * this boundary too. A snapshot newer than this store's running schema can never be imported;
 * an older schema remains eligible for a future forward-migration-of-staging step.
 */
export function checkManifestHeader(
  manifest: Manifest,
  projectId: string,
  currentSchemaVersion: number,
  expectedTables?: readonly string[],
): ManifestHeaderCheck {
  const problems: string[] = [];
  if (manifest.formatVersion !== MEMORY_BACKUP_FORMAT_VERSION) {
    problems.push(`unsupported backup format version ${manifest.formatVersion}; expected ${MEMORY_BACKUP_FORMAT_VERSION}`);
  }
  if (manifest.projectId !== projectId) {
    problems.push(`manifest names project ${manifest.projectId}, not ${projectId}`);
  }
  if (manifest.projectMemorySchemaVersion > currentSchemaVersion) {
    problems.push(
      `manifest schema version ${manifest.projectMemorySchemaVersion} is newer than this store's ${currentSchemaVersion} — cannot restore a snapshot from a newer server`,
    );
  }
  if (expectedTables) {
    const expectedSet = new Set(expectedTables);
    const actualTables = Object.keys(manifest.tableCounts);
    for (const table of expectedTables) {
      if (!(table in manifest.tableCounts)) problems.push(`manifest is missing table count for ${table}`);
    }
    for (const table of actualTables) {
      if (!expectedSet.has(table)) problems.push(`manifest contains an unknown table count: ${table}`);
    }

    const chunkIndices = new Map<string, number[]>();
    for (const relKey of Object.keys(manifest.checksums)) {
      const match = /^(.+)\/chunk-(\d+)\.jsonl\.gz$/.exec(relKey);
      if (!match) {
        problems.push(`unrecognized chunk key in manifest: ${relKey}`);
        continue;
      }
      const table = match[1]!;
      if (!expectedSet.has(table)) {
        problems.push(`manifest contains a chunk for unknown table: ${table}`);
        continue;
      }
      const indices = chunkIndices.get(table) ?? [];
      indices.push(Number(match[2]));
      chunkIndices.set(table, indices);
    }
    for (const table of expectedTables) {
      const count = manifest.tableCounts[table];
      if (count === undefined) continue;
      const indices = (chunkIndices.get(table) ?? []).sort((a, b) => a - b);
      if (count === 0 && indices.length > 0) problems.push(`${table}: zero rows but ${indices.length} chunk(s) listed`);
      if (count > 0 && indices.length === 0) problems.push(`${table}: ${count} rows but no chunks listed`);
      if (indices.length > count) problems.push(`${table}: ${indices.length} chunks cannot contain only ${count} rows`);
      for (let i = 0; i < indices.length; i++) {
        if (indices[i] !== i) {
          problems.push(`${table}: chunk indices must be contiguous from 0`);
          break;
        }
      }
    }

    const prefix = backupPrefix(manifest.projectId, manifest.exportedAt);
    const expectedRefs = Object.keys(manifest.checksums).map((key) => `${prefix}/${key}`).sort();
    const actualRefs = [...manifest.r2EvidenceRefs].sort();
    if (expectedRefs.length !== actualRefs.length || expectedRefs.some((ref, i) => ref !== actualRefs[i])) {
      problems.push('r2EvidenceRefs do not exactly match the manifest chunk inventory');
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Fetch and parse a backup's manifest.json. Throws if absent or malformed — a missing manifest
 *  means the export never completed (PLNR-248: it's written last) and is not a backup at all. */
export async function fetchManifest(env: Env, projectId: string, exportedAt: string): Promise<Manifest> {
  if (!env.FILES) throw new Error('R2 (FILES) not configured');
  const key = `${backupPrefix(projectId, exportedAt)}/manifest.json`;
  const obj = await env.FILES.get(key);
  if (!obj) throw new Error(`no manifest at ${key}`);
  return MemoryBackupManifest.parse(JSON.parse(await obj.text()));
}

export interface SnapshotChunk {
  table: string;
  chunkIndex: number;
  rows: Array<Record<string, unknown>>;
}

export interface SnapshotReadLimits {
  maxCompressedBytes?: number;
  maxUncompressedBytes?: number;
  maxRows?: number;
}

/**
 * Yield one chunk's rows at a time, oldest table-order first, verifying EACH chunk's checksum
 * against the manifest before it is ever parsed as rows — a corrupted or substituted chunk
 * throws immediately rather than handing the caller data it never should have trusted. Never
 * holds more than one chunk in memory, mirroring the export's own bounded-memory rule.
 */
export async function* readSnapshotChunks(
  env: Env,
  manifest: Manifest,
  limits: SnapshotReadLimits = {},
): AsyncGenerator<SnapshotChunk> {
  if (!env.FILES) throw new Error('R2 (FILES) not configured');
  const files = env.FILES;
  const prefix = backupPrefix(manifest.projectId, manifest.exportedAt);
  const maxCompressedBytes = limits.maxCompressedBytes ?? MAX_MEMORY_SNAPSHOT_CHUNK_COMPRESSED_BYTES;
  const maxUncompressedBytes = limits.maxUncompressedBytes ?? MAX_MEMORY_SNAPSHOT_CHUNK_UNCOMPRESSED_BYTES;
  const maxRows = limits.maxRows ?? MEMORY_BACKUP_CHUNK_ROWS;
  // relKey shape is "<table>/chunk-<n>.jsonl.gz" (backup.ts's own naming).
  //
  // TABLE order is the manifest's own key order, which is the order the exporter wrote them in —
  // i.e. BACKUP_TABLES, parents before children. Preserved rather than re-sorted: JS keeps
  // string-key insertion order and JSON.parse preserves it, so the manifest already carries the
  // right answer. (This used to sort alphabetically, which silently yielded `edges` before
  // `nodes` — harmless for today's constraint-free staging tables, but it read as though the
  // order were meaningful while actually inverting the exporter's careful one.)
  //
  // CHUNK order within a table is sorted NUMERICALLY: a lexical sort puts "chunk-10" before
  // "chunk-2" once a table passes ten chunks.
  const byTable = new Map<string, Array<{ relKey: string; chunkIndex: number }>>();
  for (const relKey of Object.keys(manifest.checksums)) {
    const match = /^(.+)\/chunk-(\d+)\.jsonl\.gz$/.exec(relKey);
    if (!match) throw new Error(`unrecognized chunk key in manifest: ${relKey}`);
    const table = match[1]!;
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table)!.push({ relKey, chunkIndex: Number(match[2]) });
  }
  const ordered = [...byTable.entries()].flatMap(([table, chunks]) =>
    chunks.sort((a, b) => a.chunkIndex - b.chunkIndex).map((c) => ({ ...c, table })),
  );
  for (const { relKey, table, chunkIndex } of ordered) {
    const obj = await files.get(`${prefix}/${relKey}`);
    if (!obj) throw new Error(`missing chunk: ${relKey}`);
    if (obj.size > maxCompressedBytes) throw new Error(`compressed snapshot chunk exceeds ${maxCompressedBytes} bytes: ${relKey}`);
    const bytes = new Uint8Array(await obj.arrayBuffer());
    if (bytes.byteLength > maxCompressedBytes) throw new Error(`compressed snapshot chunk exceeds ${maxCompressedBytes} bytes: ${relKey}`);
    const actualHash = await sha256HexBytes(bytes);
    const expectedHash = manifest.checksums[relKey];
    if (actualHash !== expectedHash) throw new Error(`checksum mismatch: ${relKey}`);
    const jsonl = await gunzip(bytes, maxUncompressedBytes);
    const lines = jsonl.length === 0 ? [] : jsonl.split('\n');
    if (lines.length > maxRows) throw new Error(`snapshot chunk exceeds ${maxRows} rows: ${relKey}`);
    const rows = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    yield { table, chunkIndex, rows };
  }
}
