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
import { runMemoryBackup } from '../src/lib/project-memory';
import {
  BACKUP_TABLES, MEMORY_BACKUP_EXPORT_CHUNKS_PER_INVOCATION, MEMORY_BACKUP_EXPORT_SESSION_TTL_MS,
  MEMORY_BACKUP_SNAPSHOT_BATCHES_PER_INVOCATION, MEMORY_BACKUP_SNAPSHOT_ROWS_PER_BATCH,
} from '../src/do/ProjectMemory';

const appEnv = env as unknown as Env;

interface MemoryRpc {
  health(pid: string): Promise<{ schemaVersion: number; memoryRevision: number; tableCounts: Record<string, number> }>;
  recordMemory(
    pid: string,
    input: { kind: string; statement: string; actor: { kind: string; id: string | null } },
  ): Promise<{ memoryId: string; operationId: string; deduped: boolean }>;
  // PLNR-430: reconcile() (not drainOutbox() alone) settles both the outbox and the projector
  // cursor — see memory-lifecycle.test.ts's newOwnedProject (PLNR-419). (drainOutbox() itself is
  // unused in this file — nothing here was ever calling it.)
  reconcile(pid: string): Promise<{ delivered: number; failed: number; applied: number; cursor: number }>;
  exportSnapshot(pid: string, opts?: { tier?: 'core' | 'full' }): Promise<
    { ok: true; manifest: unknown; manifestKey: string } | { ok: false; reason: string }
  >;
  exportBegin(pid: string, opts?: { tier?: 'core' | 'full' }): Promise<
    { ok: true; exportId: string; sweptSessions: number } | { ok: false; reason: string }
  >;
  exportContinue(pid: string, exportId: string): Promise<
    | { ok: false; reason: string }
    | {
      ok: true; done: false;
      progress: { phase: 'snapshot' | 'export'; table: string | null; tableIndex: number; cursor: number | null };
      metrics: { snapshotRows: number; chunks: number };
    }
    | { ok: true; done: true; manifest: unknown; manifestKey: string; metrics: { snapshotRows: number; chunks: number } }
  >;
  exportAbort(pid: string, exportId: string, reason?: string): Promise<{ ok: true }>;
  eraseAll(pid: string): Promise<{ ok: boolean; steps: Array<{ step: string; ok: boolean; detail: string }> }>;
  restoreSnapshot(pid: string, input: { exportedAt: string }): Promise<{ ok: boolean; reason?: string }>;
  _backdateExportSessionForTest(pid: string, exportId: string, updatedAt: string): Promise<{ ok: true }>;
  _exportCopyTableCountForTest(pid: string, exportId: string): Promise<number>;
  _exportCopyRowCountForTest(pid: string, exportId: string): Promise<number>;
  _exportMirrorTriggerCountForTest(pid: string, exportId: string): Promise<number>;
  _seedBackupScaleForTest(pid: string, input: {
    start: number; count: number; nodeCount: number; payloadBytes: number; evidencePerMemory?: number;
  }): Promise<{ ok: true }>;
  _seedBackupIndexScaleForTest(pid: string, input: {
    start: number; count: number; payloadBytes?: number;
  }): Promise<{ ok: true }>;
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
    // PLNR-430: settle create_project's own coordination events (the seeded "Backlog" milestone)
    // BEFORE capturing the baseline node count. This test previously asserted a hardcoded total
    // (3) with no settling call anywhere in it — an unpredictably-timed alarm-driven runProjector
    // pass could materialise that milestone as a 4th node between here and the export below and
    // fail the count on timing alone. See memory-lifecycle.test.ts's newOwnedProject (PLNR-419).
    await memory(projectId).reconcile(projectId);
    const baselineNodes = (await memory(projectId).health(projectId)).tableCounts.nodes;

    await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/seed_a', label: 'seed a', actor: SYSTEM });
    await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/seed_b', label: 'seed b', actor: SYSTEM });
    await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'seed memory', actor: SYSTEM });

    const result = await memory(projectId).exportSnapshot(projectId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const manifest = MemoryBackupManifest.parse(result.manifest);
    expect(manifest.projectId).toBe(projectId);
    // PLNR-430: asserted relative to the settled baseline (currently 1 — the coordination-
    // projected Backlog milestone — but incidental to project setup, not what this test means to
    // check), rather than a hardcoded total. 2 explicit seed nodes + the memory's OWN node
    // (PLNR-283: recordMemory always writes one).
    expect(manifest.tableCounts.nodes).toBe((baselineNodes ?? 0) + 3);
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

describe('worker-driven multi-invocation export sessions (PLNR-456)', () => {
  it('exports and restores a representative multi-chunk store without keyset skips or duplicates', async () => {
    const { projectId } = await newOwnedProject('pm-backup-session-scale@example.com', 'PMBKSESS');
    await memory(projectId).reconcile(projectId);
    const baseline = await memory(projectId).health(projectId);
    const rows = 1_000;
    for (let start = 0; start < rows; start += 100) {
      await memory(projectId)._seedBackupScaleForTest(projectId, {
        start, count: 100, nodeCount: 300, payloadBytes: 5 * 1024, evidencePerMemory: 2,
      });
    }
    const indexRows = 3_000;
    for (let start = 0; start < indexRows; start += 250) {
      await memory(projectId)._seedBackupIndexScaleForTest(projectId, { start, count: 250, payloadBytes: 256 });
    }
    const populated = await memory(projectId).health(projectId);
    expect(populated.tableCounts.nodes).toBe((baseline.tableCounts.nodes ?? 0) + 300);
    expect(populated.tableCounts.edges).toBe((baseline.tableCounts.edges ?? 0) + 299);
    expect(populated.tableCounts.memory_items).toBe((baseline.tableCounts.memory_items ?? 0) + rows);
    expect(populated.tableCounts.evidence).toBe((baseline.tableCounts.evidence ?? 0) + rows * 2);
    expect(populated.tableCounts.episodes).toBe((baseline.tableCounts.episodes ?? 0) + rows);
    expect(populated.tableCounts.index_staged_entities).toBe((baseline.tableCounts.index_staged_entities ?? 0) + indexRows);
    expect(populated.tableCounts.index_staged_edges).toBe((baseline.tableCounts.index_staged_edges ?? 0) + indexRows - 1);

    const result = await runMemoryBackup(appEnv, projectId, 'full');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.summary.invocations).toBeGreaterThan(2); // begin + multiple fresh continue events
    expect(result.summary.snapshotRows).toBe(Object.values(result.manifest.tableCounts).reduce((sum, count) => sum + count, 0));
    expect(result.summary.chunks).toBeGreaterThan(4);
    expect(result.summary.invocations).toBeGreaterThanOrEqual(
      Math.ceil(result.summary.chunks / MEMORY_BACKUP_EXPORT_CHUNKS_PER_INVOCATION) + 1,
    );
    expect(result.summary.rows).toBe(Object.values(result.manifest.tableCounts).reduce((sum, count) => sum + count, 0));
    expect(result.summary.bytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(result.manifest.tableCounts.nodes).toBe(populated.tableCounts.nodes);
    expect(result.manifest.tableCounts.edges).toBe(populated.tableCounts.edges);
    expect(result.manifest.tableCounts.memory_items).toBe(populated.tableCounts.memory_items);
    expect(result.manifest.tableCounts.evidence).toBe(populated.tableCounts.evidence);
    expect(result.manifest.tableCounts.episodes).toBe(populated.tableCounts.episodes);
    expect(result.manifest.tableCounts.index_staged_entities).toBe(populated.tableCounts.index_staged_entities);
    expect(result.manifest.tableCounts.index_staged_edges).toBe(populated.tableCounts.index_staged_edges);
    expect(result.manifest.tableCounts.memory_revision).toBe(1);
    expect(result.manifest.tableCounts.projector_cursor).toBe(1);
    expect(Object.keys(result.manifest.tableCounts)).toEqual([...BACKUP_TABLES]);
    expect(result.manifest.r2EvidenceRefs.filter((key) => key.includes('/memory_items/')).length).toBeGreaterThan(2);
    expect(result.manifest.r2EvidenceRefs.filter((key) => key.includes('/episodes/')).length).toBeGreaterThan(2);
    expect(await verifyMemorySnapshot(appEnv, result.manifest)).toEqual({ ok: true });

    const restored = await memory(projectId).restoreSnapshot(projectId, { exportedAt: result.manifest.exportedAt });
    expect(restored.ok).toBe(true);
    const after = await memory(projectId).health(projectId);
    for (const table of BACKUP_TABLES) {
      expect(after.tableCounts[table]).toBe(populated.tableCounts[table]);
    }
  }, 60_000);

  it('materializes a live-consistent mirror over multiple bounded continuations before writing R2', async () => {
    const { projectId } = await newOwnedProject('pm-backup-snapshot-bounded@example.com', 'PMBKSNAP');
    await memory(projectId).reconcile(projectId);
    const indexRows = MEMORY_BACKUP_SNAPSHOT_ROWS_PER_BATCH * MEMORY_BACKUP_SNAPSHOT_BATCHES_PER_INVOCATION + 500;
    for (let start = 0; start < indexRows; start += 250) {
      await memory(projectId)._seedBackupIndexScaleForTest(projectId, { start, count: Math.min(250, indexRows - start) });
    }
    const baseline = await memory(projectId).health(projectId);

    const begun = await memory(projectId).exportBegin(projectId);
    if (!begun.ok) throw new Error(begun.reason);
    expect(await memory(projectId)._exportCopyTableCountForTest(projectId, begun.exportId)).toBe(BACKUP_TABLES.length);
    expect(await memory(projectId)._exportCopyRowCountForTest(projectId, begun.exportId)).toBe(0);
    expect(await memory(projectId)._exportMirrorTriggerCountForTest(projectId, begun.exportId)).toBe(BACKUP_TABLES.length * 3);

    const first = await memory(projectId).exportContinue(projectId, begun.exportId);
    expect(first).toMatchObject({ ok: true, done: false, progress: { phase: 'snapshot' } });
    if (!first.ok || first.done) throw new Error('expected an in-progress snapshot');
    expect(first.metrics.snapshotRows).toBeLessThanOrEqual(
      MEMORY_BACKUP_SNAPSHOT_ROWS_PER_BATCH * MEMORY_BACKUP_SNAPSHOT_BATCHES_PER_INVOCATION,
    );
    expect(first.metrics.chunks).toBe(0);

    // This arrives after snapshot construction began. The mirror triggers must include it in the
    // finalized generation without freezing or rejecting the normal write path.
    await memory(projectId).writeNode(projectId, {
      type: 'unknown', uri: 'noriq://unknown/during-backup', label: 'written during backup', actor: SYSTEM,
    });
    await memory(projectId)._seedBackupIndexScaleForTest(projectId, { start: indexRows, count: 1 });

    let snapshotContinuations = 1;
    let completed: Extract<Awaited<ReturnType<MemoryRpc['exportContinue']>>, { ok: true; done: true }> | null = null;
    for (;;) {
      const continued = await memory(projectId).exportContinue(projectId, begun.exportId);
      if (!continued.ok) throw new Error(continued.reason);
      if (continued.done) { completed = continued; break; }
      if (continued.progress.phase === 'snapshot') snapshotContinuations++;
    }
    expect(snapshotContinuations).toBeGreaterThan(1);
    expect(await memory(projectId)._exportMirrorTriggerCountForTest(projectId, begun.exportId)).toBe(0);
    expect(await memory(projectId)._exportCopyTableCountForTest(projectId, begun.exportId)).toBe(0);

    const manifest = MemoryBackupManifest.parse(completed!.manifest);
    expect(manifest.tableCounts.nodes).toBe((baseline.tableCounts.nodes ?? 0) + 1);
    expect(manifest.tableCounts.index_staged_entities).toBe((baseline.tableCounts.index_staged_entities ?? 0) + 1);
    expect(manifest.tableCounts.index_staged_edges).toBe((baseline.tableCounts.index_staged_edges ?? 0) + 1);
    expect(await verifyMemorySnapshot(appEnv, manifest)).toEqual({ ok: true });
  }, 60_000);

  it('sweeps an abandoned session and drops all of its immutable copy tables at the next begin', async () => {
    const { projectId } = await newOwnedProject('pm-backup-session-sweep@example.com', 'PMBKSWP');
    const abandoned = await memory(projectId).exportBegin(projectId);
    if (!abandoned.ok) throw new Error(abandoned.reason);
    expect(await memory(projectId)._exportCopyTableCountForTest(projectId, abandoned.exportId)).toBe(BACKUP_TABLES.length);
    expect(await memory(projectId)._exportMirrorTriggerCountForTest(projectId, abandoned.exportId)).toBe(BACKUP_TABLES.length * 3);
    await memory(projectId)._backdateExportSessionForTest(
      projectId,
      abandoned.exportId,
      new Date(Date.now() - MEMORY_BACKUP_EXPORT_SESSION_TTL_MS - 1_000).toISOString(),
    );

    const replacement = await memory(projectId).exportBegin(projectId);
    if (!replacement.ok) throw new Error(replacement.reason);
    expect(replacement.sweptSessions).toBe(1);
    expect(await memory(projectId)._exportCopyTableCountForTest(projectId, abandoned.exportId)).toBe(0);
    expect(await memory(projectId)._exportMirrorTriggerCountForTest(projectId, abandoned.exportId)).toBe(0);
    expect(await memory(projectId).exportContinue(projectId, abandoned.exportId)).toMatchObject({ ok: false });
    await memory(projectId).exportAbort(projectId, replacement.exportId, 'test cleanup');
    expect(await memory(projectId)._exportMirrorTriggerCountForTest(projectId, replacement.exportId)).toBe(0);
  });

  it('removes active mirror triggers before erasure drops their target tables', async () => {
    const { projectId } = await newOwnedProject('pm-backup-session-erase@example.com', 'PMBKERAS');
    const active = await memory(projectId).exportBegin(projectId);
    if (!active.ok) throw new Error(active.reason);
    expect(await memory(projectId)._exportMirrorTriggerCountForTest(projectId, active.exportId)).toBe(BACKUP_TABLES.length * 3);

    const erased = await memory(projectId).eraseAll(projectId);
    expect(erased.ok).toBe(true);
    expect(await memory(projectId)._exportMirrorTriggerCountForTest(projectId, active.exportId)).toBe(0);
    expect(await memory(projectId)._exportCopyTableCountForTest(projectId, active.exportId)).toBe(0);
    await expect(memory(projectId).writeNode(projectId, {
      type: 'unknown', uri: 'noriq://unknown/post-erase', label: 'post erase', actor: SYSTEM,
    })).resolves.toMatchObject({ nodeId: expect.any(String) });
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
