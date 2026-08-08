// PLNR-248: portable ProjectMemory snapshot export to R2. Exercises the pipeline
// (exportMemorySnapshot/verifyMemorySnapshot) directly for cases needing a controlled
// environment (no-R2 degradation, forced-collision namespacing), and the ProjectMemory RPC +
// ProjectRoom registry write end to end for the realistic path.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { createUser, mintTokenForUser, mcpCall, projectRoom } from './helpers';
import { exportMemorySnapshot, verifyMemorySnapshot } from '../src/memory/backup';
import { MemoryBackupManifest } from '@noriq-dev/shared';

const appEnv = env as unknown as Env;

interface MemoryRpc {
  health(pid: string): Promise<{ schemaVersion: number; memoryRevision: number; tableCounts: Record<string, number> }>;
  recordMemory(
    pid: string,
    input: { kind: string; statement: string; actor: { kind: string; id: string | null } },
  ): Promise<{ memoryId: string; operationId: string; deduped: boolean }>;
  drainOutbox(pid: string): Promise<{ delivered: number; failed: number }>;
  runProjector(pid: string): Promise<{ applied: number; cursor: number }>;
  exportSnapshot(pid: string, opts?: { tier?: 'core' | 'full' }): Promise<
    { ok: true; manifest: unknown; manifestKey: string } | { ok: false; reason: string }
  >;
  writeNode(pid: string, input: { type: string; uri: string; label: string; actor: { kind: string; id: string | null } }): Promise<{ nodeId: string }>;
}
interface RoomRpc {
  updateMemoryBackupStatus(pid: string, outcome: { ok: boolean }): Promise<{ ok: true }>;
}
const SYSTEM = { kind: 'system', id: null };

const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as MemoryRpc;
const room = (pid: string) => projectRoom<RoomRpc>(pid);

async function newOwnedProject(email: string, key: string) {
  const user = await createUser(email, 'Owner', 'longenough1');
  const token = await mintTokenForUser(email);
  const proj = await mcpCall(token, 'create_project', { key, name: `${key} project` });
  if (proj.isError) throw new Error(`create_project(${key}) failed: ${proj.text}`);
  return { userId: user.id, token, projectId: proj.body.id as string };
}

describe('exportSnapshot — end to end via the DO RPC', () => {
  it('produces chunks + a manifest, and the manifest parses as the shared MemoryBackupManifest', async () => {
    const { projectId } = await newOwnedProject('pm-backup-e2e@example.com', 'PMBKE2E');
    await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/seed_a', label: 'seed a', actor: SYSTEM });
    await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/seed_b', label: 'seed b', actor: SYSTEM });
    await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'seed memory', actor: SYSTEM });

    const result = await memory(projectId).exportSnapshot(projectId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const manifest = MemoryBackupManifest.parse(result.manifest);
    expect(manifest.projectId).toBe(projectId);
    // 2 explicit seed nodes + the memory's OWN node (PLNR-283: recordMemory always writes one).
    expect(manifest.tableCounts.nodes).toBe(3);
    expect(manifest.tableCounts.outbox).toBeGreaterThan(0);
    expect(manifest.tier).toBe('core');
    expect(Object.keys(manifest.checksums).length).toBeGreaterThan(0);
    // every checksum key corresponds to a real, listed chunk
    for (const relKey of Object.keys(manifest.checksums)) {
      expect(manifest.r2EvidenceRefs.some((k) => k.endsWith(relKey))).toBe(true);
    }

    // the manifest object is fetchable at the well-known key
    const manifestObj = await appEnv.FILES!.get(result.manifestKey);
    expect(manifestObj).not.toBeNull();
    const stored = JSON.parse(await manifestObj!.text());
    expect(stored.projectId).toBe(projectId);
  });

  it('verifies cleanly right after export, and reports backup_status=ok in the D1 registry', async () => {
    const { projectId } = await newOwnedProject('pm-backup-verify@example.com', 'PMBKVRFY');
    await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/x', label: 'x', actor: SYSTEM });
    const result = await memory(projectId).exportSnapshot(projectId);
    if (!result.ok) throw new Error('unreachable');

    const verified = await verifyMemorySnapshot(appEnv, MemoryBackupManifest.parse(result.manifest));
    expect(verified).toEqual({ ok: true });

    const row = await appEnv.DB.prepare('SELECT backup_status, last_backup_at FROM project_memory_registry WHERE project_id = ?')
      .bind(projectId)
      .first<{ backup_status: string; last_backup_at: string | null }>();
    expect(row?.backup_status).toBe('ok');
    expect(row?.last_backup_at).toBeTruthy();
  });

  it('detects a corrupted chunk and a missing chunk from the manifest alone', async () => {
    const { projectId } = await newOwnedProject('pm-backup-tamper@example.com', 'PMBKTMPR');
    await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/y1', label: 'y1', actor: SYSTEM });
    await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/y2', label: 'y2', actor: SYSTEM });
    const result = await memory(projectId).exportSnapshot(projectId);
    if (!result.ok) throw new Error('unreachable');
    const manifest = MemoryBackupManifest.parse(result.manifest);

    const nodesChunkKey = manifest.r2EvidenceRefs.find((k) => k.includes('/nodes/'))!;
    await appEnv.FILES!.put(nodesChunkKey, new TextEncoder().encode('not the real gzip bytes'));

    const verified = await verifyMemorySnapshot(appEnv, manifest);
    expect(verified.ok).toBe(false);
    if (verified.ok) throw new Error('unreachable');
    expect(verified.problems.some((p) => p.includes('checksum mismatch'))).toBe(true);

    await appEnv.FILES!.delete(nodesChunkKey);
    const verifiedAfterDelete = await verifyMemorySnapshot(appEnv, manifest);
    expect(verifiedAfterDelete.ok).toBe(false);
    if (verifiedAfterDelete.ok) throw new Error('unreachable');
    expect(verifiedAfterDelete.problems.some((p) => p.includes('missing chunk'))).toBe(true);
  });
});

describe('exportMemorySnapshot — bounded reads and namespacing (direct pipeline calls)', () => {
  it('never reads more than one chunk worth of rows per readBatch call', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ id: `row_${i}` }));
    let maxRequestedLimit = 0;
    await exportMemorySnapshot({
      env: appEnv,
      projectId: 'prj_bounded_test',
      schemaVersion: 1,
      memoryRevision: 0,
      tier: 'core',
      exportedAt: '2026-08-06T00:00:00.000Z',
      tables: ['fake_table'],
      chunkRowLimit: 10,
      readBatch: (_table, offset, limit) => {
        maxRequestedLimit = Math.max(maxRequestedLimit, limit);
        return rows.slice(offset, offset + limit);
      },
      tableCount: () => rows.length,
    });
    expect(maxRequestedLimit).toBe(10); // never asked for the whole table in one call
  });

  it('two projects exporting at the IDENTICAL exportedAt land under distinct prefixes', async () => {
    const fixedExportedAt = '2026-08-06T12:00:00.000Z';
    const common = {
      env: appEnv,
      schemaVersion: 1,
      memoryRevision: 0,
      tier: 'core' as const,
      exportedAt: fixedExportedAt,
      tables: ['fake_table'],
      readBatch: (_table: string, offset: number, limit: number) =>
        offset === 0 ? [{ id: 'only-row' }].slice(0, limit) : [],
      tableCount: () => 1,
    };
    const a = await exportMemorySnapshot({ ...common, projectId: 'prj_ns_a' });
    const b = await exportMemorySnapshot({ ...common, projectId: 'prj_ns_b' });
    expect(a.manifestKey).not.toBe(b.manifestKey);
    expect(a.manifestKey.startsWith('memory-backups/prj_ns_a/')).toBe(true);
    expect(b.manifestKey.startsWith('memory-backups/prj_ns_b/')).toBe(true);
    expect(a.manifest.r2EvidenceRefs[0]).not.toBe(b.manifest.r2EvidenceRefs[0]);
  });

  it('throws clearly when R2 (FILES) is not configured — the caller decides the degradation response', async () => {
    const fakeEnv = { FILES: undefined } as unknown as Env;
    await expect(
      exportMemorySnapshot({
        env: fakeEnv,
        projectId: 'prj_no_r2',
        schemaVersion: 1,
        memoryRevision: 0,
        tier: 'core',
        exportedAt: '2026-08-06T00:00:00.000Z',
        tables: [],
        readBatch: () => [],
        tableCount: () => 0,
      }),
    ).rejects.toThrow('R2 (FILES) not configured');
  });
});

describe('registerRepository-style backup status write via ProjectRoom', () => {
  it('a failed outcome reported to the room shows backup_status=failed', async () => {
    const { projectId } = await newOwnedProject('pm-backup-fail-status@example.com', 'PMBKFAIL');
    await room(projectId).updateMemoryBackupStatus(projectId, { ok: false });
    const row = await appEnv.DB.prepare('SELECT backup_status FROM project_memory_registry WHERE project_id = ?')
      .bind(projectId)
      .first<{ backup_status: string }>();
    expect(row?.backup_status).toBe('failed');
  });
});
