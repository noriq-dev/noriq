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
import { backupPrefix, gunzip, sha256HexBytes } from './backup';

export interface ManifestHeaderCheck {
  ok: boolean;
  problems: string[];
}

/**
 * Cross-project refusal and schema-compatibility check — pure and synchronous, run before any
 * R2 chunk is even fetched. A snapshot from a different project is refused outright; a snapshot
 * newer than this store's running schema can never be safely imported (there is nothing to
 * migrate it FORWARD from on this server). A snapshot from an OLDER schema version is accepted
 * — today there is only schema v1, so that path is exercised only once this store's schema
 * moves past v1, at which point a real forward-migration-of-staging step belongs here.
 */
export function checkManifestHeader(manifest: Manifest, projectId: string, currentSchemaVersion: number): ManifestHeaderCheck {
  const problems: string[] = [];
  if (manifest.projectId !== projectId) {
    problems.push(`manifest names project ${manifest.projectId}, not ${projectId}`);
  }
  if (manifest.projectMemorySchemaVersion > currentSchemaVersion) {
    problems.push(
      `manifest schema version ${manifest.projectMemorySchemaVersion} is newer than this store's ${currentSchemaVersion} — cannot restore a snapshot from a newer server`,
    );
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

/**
 * Yield one chunk's rows at a time, oldest table-order first, verifying EACH chunk's checksum
 * against the manifest before it is ever parsed as rows — a corrupted or substituted chunk
 * throws immediately rather than handing the caller data it never should have trusted. Never
 * holds more than one chunk in memory, mirroring the export's own bounded-memory rule.
 */
export async function* readSnapshotChunks(env: Env, manifest: Manifest): AsyncGenerator<SnapshotChunk> {
  if (!env.FILES) throw new Error('R2 (FILES) not configured');
  const files = env.FILES;
  const prefix = backupPrefix(manifest.projectId, manifest.exportedAt);
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
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const actualHash = await sha256HexBytes(bytes);
    const expectedHash = manifest.checksums[relKey];
    if (actualHash !== expectedHash) throw new Error(`checksum mismatch: ${relKey}`);
    const jsonl = await gunzip(bytes);
    const rows = jsonl.length === 0 ? [] : jsonl.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    yield { table, chunkIndex, rows };
  }
}
