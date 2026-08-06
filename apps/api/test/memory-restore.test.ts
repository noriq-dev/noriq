// PLNR-249: generation-based ProjectMemory restore and rollback. Drives the DO's RPCs
// directly (same technique as the other memory-*.test.ts files) plus the pure header-check
// function in lib/memory/restore.ts.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { createUser, mintTokenForUser, mcpCall } from './helpers';
import { checkManifestHeader } from '../src/memory/restore';
import { MemoryBackupManifest } from '@noriq-dev/shared';

const appEnv = env as unknown as Env;

interface MemoryRpc {
  health(pid: string): Promise<{ schemaVersion: number; memoryRevision: number; tableCounts: Record<string, number> }>;
  _mutate(pid: string, verb: string, subjectType: string, subjectId: string, summary?: Record<string, unknown>): Promise<{ operationId: string }>;
  drainOutbox(pid: string): Promise<{ delivered: number; failed: number }>;
  runProjector(pid: string): Promise<{ applied: number; cursor: number }>;
  exportSnapshot(pid: string, opts?: { tier?: 'core' | 'full' }): Promise<
    { ok: true; manifest: { exportedAt: string; r2EvidenceRefs: string[] }; manifestKey: string } | { ok: false; reason: string }
  >;
  restoreSnapshot(pid: string, opts: { exportedAt: string }): Promise<
    { ok: true; tableCounts: Record<string, number> } | { ok: false; reason: string }
  >;
  rollback(pid: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  rebuildVectorIndex(pid: string): Promise<{ ok: true; rebuilt: false; reason: string }>;
  erase(pid: string): Promise<{ ok: true }>;
  _seedNode(pid: string, uri: string, label: string): Promise<string>;
  _seedEdge(pid: string, type: string, from: string, to: string): Promise<string>;
  _seedMemoryItem(pid: string, kind: string, statement: string): Promise<string>;
  _seedEvidence(pid: string, memoryItemId: string, repositoryKey: string, branch: string, baseId: string, path: string): Promise<string>;
  _traverseFrom(pid: string, from: string, type: string): Promise<string[]>;
  _evidencePathsFor(pid: string, memoryItemId: string): Promise<string[]>;
}

const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as MemoryRpc;

async function newOwnedProject(email: string, key: string) {
  const user = await createUser(email, 'Owner', 'longenough1');
  const token = await mintTokenForUser(email);
  const proj = await mcpCall(token, 'create_project', { key, name: `${key} project` });
  if (proj.isError) throw new Error(`create_project(${key}) failed: ${proj.text}`);
  return { userId: user.id, token, projectId: proj.body.id as string };
}

describe('checkManifestHeader — pure, no R2 involved', () => {
  const base = {
    formatVersion: 1,
    projectMemorySchemaVersion: 1,
    memoryRevision: 0,
    exportedAt: '2026-08-06T00:00:00.000Z',
    tier: 'core' as const,
    tableCounts: {},
    checksums: {},
    activeIndexGenerations: [],
    r2EvidenceRefs: [],
  };

  it('refuses a manifest naming a different project', () => {
    const manifest = MemoryBackupManifest.parse({ ...base, projectId: 'prj_a' });
    const result = checkManifestHeader(manifest, 'prj_b', 1);
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain('prj_a');
  });

  it('refuses a manifest from a newer schema than this store runs', () => {
    const manifest = MemoryBackupManifest.parse({ ...base, projectId: 'prj_a', projectMemorySchemaVersion: 99 });
    const result = checkManifestHeader(manifest, 'prj_a', 1);
    expect(result.ok).toBe(false);
  });

  it('accepts a matching project at a compatible schema version', () => {
    const manifest = MemoryBackupManifest.parse({ ...base, projectId: 'prj_a' });
    expect(checkManifestHeader(manifest, 'prj_a', 1)).toEqual({ ok: true, problems: [] });
  });
});

describe('restoreSnapshot — round trip reproduces canonical state', () => {
  it('export -> erase -> restore matches health, graph traversal, and evidence exactly', async () => {
    const { token, projectId } = await newOwnedProject('pm-restore-roundtrip@example.com', 'PMRSTRT');
    const task = await mcpCall(token, 'create_task', { projectId, title: 'projected', tags: ['memory-restore-test'], allowNewTags: true });
    if (task.isError) throw new Error(`create_task failed: ${task.text}`);

    // Catch every ledger up BEFORE exporting, so a restore's idempotency claim is testable:
    // nothing should be newly applicable afterward. drainOutbox itself emits a fresh D1 event
    // (the delivered memory.changed), so the projector must run AGAIN after it to consume that
    // too — otherwise the snapshot exports with a cursor already behind the live event log.
    await memory(projectId).runProjector(projectId);
    const { operationId } = await memory(projectId)._mutate(projectId, 'memory.changed', 'memory', 'mem_pre', {});
    void operationId;
    await memory(projectId).drainOutbox(projectId);
    await memory(projectId).runProjector(projectId);

    const nodeA = await memory(projectId)._seedNode(projectId, 'noriq://unknown/a', 'a');
    const nodeB = await memory(projectId)._seedNode(projectId, 'noriq://unknown/b', 'b');
    await memory(projectId)._seedEdge(projectId, 'related_to', nodeA, nodeB);
    const memItem = await memory(projectId)._seedMemoryItem(projectId, 'learning', 'evidence-backed learning');
    await memory(projectId)._seedEvidence(projectId, memItem, 'repo-x', 'main', 'a1b2c3', 'README.md');

    const beforeHealth = await memory(projectId).health(projectId);
    const beforeTraversal = await memory(projectId)._traverseFrom(projectId, nodeA, 'related_to');
    const beforeEvidence = await memory(projectId)._evidencePathsFor(projectId, memItem);

    const exported = await memory(projectId).exportSnapshot(projectId);
    if (!exported.ok) throw new Error(`export failed: ${exported.reason}`);
    await memory(projectId).erase(projectId);

    const restored = await memory(projectId).restoreSnapshot(projectId, { exportedAt: exported.manifest.exportedAt });
    if (!restored.ok) throw new Error(`restore failed: ${restored.reason}`);

    const afterHealth = await memory(projectId).health(projectId);
    expect(afterHealth.schemaVersion).toBe(beforeHealth.schemaVersion);
    expect(afterHealth.memoryRevision).toBe(beforeHealth.memoryRevision);
    expect(afterHealth.tableCounts).toEqual(beforeHealth.tableCounts);

    expect(await memory(projectId)._traverseFrom(projectId, nodeA, 'related_to')).toEqual(beforeTraversal);
    expect(await memory(projectId)._evidencePathsFor(projectId, memItem)).toEqual(beforeEvidence);

    // Ledger idempotency: nothing left to deliver or project — the restored ledgers already
    // reflect the pre-export catch-up state.
    expect(await memory(projectId).drainOutbox(projectId)).toEqual({ delivered: 0, failed: 0 });
    const projectorResult = await memory(projectId).runProjector(projectId);
    expect(projectorResult.applied).toBe(0);

    // Vector-dirty is set, and the rebuild hook is an honest no-op (Phase 4 territory).
    const registryRow = await appEnv.DB.prepare('SELECT vector_dirty FROM project_memory_registry WHERE project_id = ?')
      .bind(projectId)
      .first<{ vector_dirty: number }>();
    expect(registryRow?.vector_dirty).toBe(1);
    const rebuild = await memory(projectId).rebuildVectorIndex(projectId);
    expect(rebuild).toEqual({ ok: true, rebuilt: false, reason: expect.stringContaining('nothing to rebuild') });
  });

  it('rollback returns to the pre-restore state without touching R2, and is single-level', async () => {
    const { projectId } = await newOwnedProject('pm-restore-rollback@example.com', 'PMRSTRB');
    await memory(projectId)._seedNode(projectId, 'noriq://unknown/keep', 'keep');
    const exported = await memory(projectId).exportSnapshot(projectId);
    if (!exported.ok) throw new Error(`export failed: ${exported.reason}`);

    await memory(projectId).erase(projectId); // pre-restore state: empty
    const restored = await memory(projectId).restoreSnapshot(projectId, { exportedAt: exported.manifest.exportedAt });
    if (!restored.ok) throw new Error(`restore failed: ${restored.reason}`);
    expect((await memory(projectId).health(projectId)).tableCounts.nodes).toBe(1);

    // Delete the backup's R2 objects entirely — rollback must not need them.
    for (const key of exported.manifest.r2EvidenceRefs) await appEnv.FILES!.delete(key);
    await appEnv.FILES!.delete(exported.manifestKey);

    const rollback1 = await memory(projectId).rollback(projectId);
    expect(rollback1).toEqual({ ok: true });
    expect((await memory(projectId).health(projectId)).tableCounts.nodes).toBe(0); // back to erased state

    const rollback2 = await memory(projectId).rollback(projectId);
    expect(rollback2.ok).toBe(false); // nothing left to roll back to
  });

  it('a corrupted chunk fails validation and leaves the active generation untouched', async () => {
    const { projectId } = await newOwnedProject('pm-restore-corrupt@example.com', 'PMRSTCRP');
    await memory(projectId)._seedNode(projectId, 'noriq://unknown/for-snapshot', 'for-snapshot');
    const exported = await memory(projectId).exportSnapshot(projectId);
    if (!exported.ok) throw new Error(`export failed: ${exported.reason}`);

    // Corrupt the nodes chunk this snapshot depends on.
    const nodesChunkKey = exported.manifest.r2EvidenceRefs.find((k) => k.includes('/nodes/'))!;
    await appEnv.FILES!.put(nodesChunkKey, new TextEncoder().encode('corrupted'));

    // Live state diverges from the (now-corrupted) snapshot after export.
    await memory(projectId)._seedNode(projectId, 'noriq://unknown/live-only', 'live-only');
    const liveCountBefore = (await memory(projectId).health(projectId)).tableCounts.nodes;

    const restored = await memory(projectId).restoreSnapshot(projectId, { exportedAt: exported.manifest.exportedAt });
    expect(restored.ok).toBe(false);

    const liveCountAfter = (await memory(projectId).health(projectId)).tableCounts.nodes;
    expect(liveCountAfter).toBe(liveCountBefore); // untouched — nothing was ever deleted to make room
  });

  it('a manifest with a mismatched projectId (placed under this project by mistake) is refused before any staging write', async () => {
    const { projectId: honestProjectId } = await newOwnedProject('pm-restore-honest@example.com', 'PMRSTHNS');
    const { projectId: otherProjectId } = await newOwnedProject('pm-restore-other@example.com', 'PMRSTOTH');

    const exportedOther = await memory(otherProjectId).exportSnapshot(otherProjectId);
    if (!exportedOther.ok) throw new Error('export failed');

    // Simulate operator error: manually place the OTHER project's manifest under THIS
    // project's own prefix, at a timestamp this project will ask for.
    const fixedExportedAt = '2026-08-06T09:00:00.000Z';
    const mismatched = { ...(exportedOther.manifest as unknown as Record<string, unknown>), projectId: otherProjectId };
    await appEnv.FILES!.put(
      `memory-backups/${honestProjectId}/${fixedExportedAt.replace(/[:.]/g, '-')}/manifest.json`,
      JSON.stringify(mismatched),
    );

    await memory(honestProjectId)._seedNode(honestProjectId, 'noriq://unknown/untouched', 'untouched');
    const before = await memory(honestProjectId).health(honestProjectId);

    const result = await memory(honestProjectId).restoreSnapshot(honestProjectId, { exportedAt: fixedExportedAt });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain(otherProjectId);

    expect(await memory(honestProjectId).health(honestProjectId)).toEqual(before);
  });
});
