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
  recordMemory(
    pid: string,
    input: {
      kind: string;
      statement: string;
      evidence?: Array<{ repositoryKey: string; branch: string; baseId: string; path: string }>;
      actor: { kind: string; id: string | null };
    },
  ): Promise<{ memoryId: string; operationId: string; deduped: boolean }>;
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
  writeNode(pid: string, input: { type: string; uri: string; label: string; actor: { kind: string; id: string | null } }): Promise<{ nodeId: string }>;
  writeEdge(
    pid: string,
    input: { type: string; fromNodeId: string; toNodeId: string; actor: { kind: string; id: string | null } },
  ): Promise<{ edgeId: string }>;
  getMemoryItem(pid: string, memoryId: string): Promise<{ evidence: Array<{ path: string }> } | null>;
  traverseGraph(
    pid: string,
    input: { seedNodeIds: string[]; edgeTypes?: string[]; maxDepth?: number; maxResults?: number },
  ): Promise<Array<{ nodeId: string; uri: string; type: string; label: string; depth: number; edgePath: string }>>;
  _tableDdl(pid: string, table: string): Promise<string>;
}

/** The real read API `_traverseFrom` was a narrow test-only stand-in for (PLNR-257) — one-hop
 *  traversal via edges of a given type, extracted to the shape these tests were already
 *  written against (a plain array of reached node ids). */
async function traverseOneHop(pid: string, fromNodeId: string, edgeType: string): Promise<string[]> {
  const hits = await memory(pid).traverseGraph(pid, { seedNodeIds: [fromNodeId], edgeTypes: [edgeType], maxDepth: 1 });
  return hits.map((h) => h.nodeId);
}

/** Likewise for `_evidencePathsFor` — the real read API is getMemoryItem's `.evidence`. */
async function evidencePathsFor(pid: string, memoryItemId: string): Promise<string[]> {
  const item = await memory(pid).getMemoryItem(pid, memoryItemId);
  return (item?.evidence ?? []).map((e) => e.path).sort();
}
const SYSTEM = { kind: 'system', id: null };

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
    const { operationId } = await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'pre-export marker', actor: SYSTEM });
    void operationId;
    await memory(projectId).drainOutbox(projectId);
    await memory(projectId).runProjector(projectId);

    const { nodeId: nodeA } = await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/a', label: 'a', actor: SYSTEM });
    const { nodeId: nodeB } = await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/b', label: 'b', actor: SYSTEM });
    await memory(projectId).writeEdge(projectId, { type: 'related_to', fromNodeId: nodeA, toNodeId: nodeB, actor: SYSTEM });
    const { memoryId: memItem } = await memory(projectId).recordMemory(projectId, {
      kind: 'learning',
      statement: 'evidence-backed learning',
      evidence: [{ repositoryKey: 'repo-x', branch: 'main', baseId: 'a1b2c3', path: 'README.md' }],
      actor: SYSTEM,
    });
    // Every write above (node/edge/memory) queued its own outbox row — drain and project again
    // so the ledgers are caught up before export, matching the comment above.
    await memory(projectId).drainOutbox(projectId);
    await memory(projectId).runProjector(projectId);

    const beforeHealth = await memory(projectId).health(projectId);
    const beforeTraversal = await traverseOneHop(projectId, nodeA, 'related_to');
    const beforeEvidence = await evidencePathsFor(projectId, memItem);

    const exported = await memory(projectId).exportSnapshot(projectId);
    if (!exported.ok) throw new Error(`export failed: ${exported.reason}`);
    await memory(projectId).erase(projectId);

    const restored = await memory(projectId).restoreSnapshot(projectId, { exportedAt: exported.manifest.exportedAt });
    if (!restored.ok) throw new Error(`restore failed: ${restored.reason}`);

    const afterHealth = await memory(projectId).health(projectId);
    expect(afterHealth.schemaVersion).toBe(beforeHealth.schemaVersion);
    expect(afterHealth.memoryRevision).toBe(beforeHealth.memoryRevision);
    expect(afterHealth.tableCounts).toEqual(beforeHealth.tableCounts);

    expect(await traverseOneHop(projectId, nodeA, 'related_to')).toEqual(beforeTraversal);
    expect(await evidencePathsFor(projectId, memItem)).toEqual(beforeEvidence);

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
    await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/keep', label: 'keep', actor: SYSTEM });
    await memory(projectId).runProjector(projectId);
    const exportedNodeCount = (await memory(projectId).health(projectId)).tableCounts.nodes;
    const exported = await memory(projectId).exportSnapshot(projectId);
    if (!exported.ok) throw new Error(`export failed: ${exported.reason}`);

    await memory(projectId).erase(projectId); // pre-restore state: empty
    const restored = await memory(projectId).restoreSnapshot(projectId, { exportedAt: exported.manifest.exportedAt });
    if (!restored.ok) throw new Error(`restore failed: ${restored.reason}`);
    expect((await memory(projectId).health(projectId)).tableCounts.nodes).toBe(exportedNodeCount);

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
    await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/for-snapshot', label: 'for-snapshot', actor: SYSTEM });
    const exported = await memory(projectId).exportSnapshot(projectId);
    if (!exported.ok) throw new Error(`export failed: ${exported.reason}`);

    // Corrupt the nodes chunk this snapshot depends on.
    const nodesChunkKey = exported.manifest.r2EvidenceRefs.find((k) => k.includes('/nodes/'))!;
    await appEnv.FILES!.put(nodesChunkKey, new TextEncoder().encode('corrupted'));

    // Live state diverges from the (now-corrupted) snapshot after export.
    await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/live-only', label: 'live-only', actor: SYSTEM });
    const liveCountBefore = (await memory(projectId).health(projectId)).tableCounts.nodes;

    const restored = await memory(projectId).restoreSnapshot(projectId, { exportedAt: exported.manifest.exportedAt });
    expect(restored.ok).toBe(false);

    const liveCountAfter = (await memory(projectId).health(projectId)).tableCounts.nodes;
    expect(liveCountAfter).toBe(liveCountBefore); // untouched — nothing was ever deleted to make room
  });

  // Regression: the original staging mechanism created a staging_ twin lazily per imported
  // chunk, then ran BOTH integrity anti-joins whenever EITHER edges or evidence was present —
  // so restoring a project that had edges but no evidence died on
  // "no such table: staging_evidence". A graph without evidence is an entirely ordinary shape.
  it('restores a project that has edges but NO evidence rows', async () => {
    const { projectId } = await newOwnedProject('pm-restore-noev@example.com', 'PMRSTNEV');
    const { nodeId: a } = await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/ne-a', label: 'ne-a', actor: SYSTEM });
    const { nodeId: b } = await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/ne-b', label: 'ne-b', actor: SYSTEM });
    await memory(projectId).writeEdge(projectId, { type: 'related_to', fromNodeId: a, toNodeId: b, actor: SYSTEM });
    await memory(projectId).runProjector(projectId);
    const beforeExport = await memory(projectId).health(projectId);

    const exported = await memory(projectId).exportSnapshot(projectId);
    if (!exported.ok) throw new Error('export failed');
    await memory(projectId).erase(projectId);

    const restored = await memory(projectId).restoreSnapshot(projectId, { exportedAt: exported.manifest.exportedAt });
    expect(restored.ok).toBe(true);
    const h = await memory(projectId).health(projectId);
    expect(h.tableCounts.nodes).toBe(beforeExport.tableCounts.nodes);
    expect(h.tableCounts.edges).toBe(beforeExport.tableCounts.edges);
    expect(h.tableCounts.evidence).toBe(0);
    expect(await traverseOneHop(projectId, a, 'related_to')).toEqual([b]);
  });

  // Regression: the original mechanism activated by RENAMING tables. SQLite stores a renamed
  // table's name QUOTED (`CREATE TABLE "edges"`), which broke the textual `CREATE TABLE <t>`
  // munging used to derive the staging schema — so a SECOND restore failed with "could not
  // derive staging schema for edges". The rename also rewrote OTHER tables' FK clauses, leaving
  // `edges` pointing at `prev_nodes`. Restoring twice must simply work, and the schema must not
  // drift.
  it('restores twice in a row without schema drift', async () => {
    const { projectId } = await newOwnedProject('pm-restore-twice@example.com', 'PMRSTTWC');
    const { nodeId: a } = await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/tw-a', label: 'tw-a', actor: SYSTEM });
    const { nodeId: b } = await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/tw-b', label: 'tw-b', actor: SYSTEM });
    await memory(projectId).writeEdge(projectId, { type: 'related_to', fromNodeId: a, toNodeId: b, actor: SYSTEM });
    await memory(projectId).recordMemory(projectId, {
      kind: 'learning',
      statement: 'twice',
      evidence: [{ repositoryKey: 'repo-x', branch: 'main', baseId: 'base1', path: 'README.md' }],
      actor: SYSTEM,
    });
    await memory(projectId).runProjector(projectId);
    const beforeExport = await memory(projectId).health(projectId);

    const first = await memory(projectId).exportSnapshot(projectId);
    if (!first.ok) throw new Error('export 1 failed');
    const r1 = await memory(projectId).restoreSnapshot(projectId, { exportedAt: first.manifest.exportedAt });
    expect(r1.ok).toBe(true);

    const second = await memory(projectId).exportSnapshot(projectId);
    if (!second.ok) throw new Error('export 2 failed');
    const r2 = await memory(projectId).restoreSnapshot(projectId, { exportedAt: second.manifest.exportedAt });
    expect(r2.ok).toBe(true);

    // Data intact after two round trips, and the graph still traverses. Compare with the settled
    // pre-export snapshot so the automatically projected project node is part of both sides.
    const h = await memory(projectId).health(projectId);
    expect(h.tableCounts.nodes).toBe(beforeExport.tableCounts.nodes);
    expect(h.tableCounts.edges).toBe(beforeExport.tableCounts.edges);
    expect(h.tableCounts.evidence).toBe(1);
    expect(await traverseOneHop(projectId, a, 'related_to')).toEqual([b]);

    // …and the live schema is still the ORIGINAL schema: `edges` references `nodes`, never a
    // `prev_`/`staging_` table, and its name is not a renamed artifact.
    const edgesDdl = await memory(projectId)._tableDdl(projectId, 'edges');
    expect(edgesDdl).toContain('REFERENCES nodes(id)');
    expect(edgesDdl).not.toContain('prev_');
    expect(edgesDdl).not.toContain('staging_');
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

    await memory(honestProjectId).writeNode(honestProjectId, { type: 'unknown', uri: 'noriq://unknown/untouched', label: 'untouched', actor: SYSTEM });
    await memory(honestProjectId).runProjector(honestProjectId);
    const before = await memory(honestProjectId).health(honestProjectId);

    const result = await memory(honestProjectId).restoreSnapshot(honestProjectId, { exportedAt: fixedExportedAt });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain(otherProjectId);

    expect(await memory(honestProjectId).health(honestProjectId)).toEqual(before);
  });
});
