// PLNR-250: ProjectMemory deletion, retention, quota visibility, and the rehearsed DR path.
// Drives the DO's RPCs and lib/memory/lifecycle.ts's pure sweep functions directly (same
// technique as the other memory-*.test.ts files).
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import type { Actor } from '../src/do/ProjectRoom';
import { createUser, mintTokenForUser, mcpCall, projectRoom, SYSTEM_ACTOR } from './helpers';
import {
  sizeStatus,
  DB_SIZE_WARN_BYTES,
  DB_SIZE_CRITICAL_BYTES,
  sweepPendingErasures,
  sweepProjectDebris,
  pruneBackupRetention,
  listProjectBackupGenerations,
  STAGED_GENERATION_MAX_AGE_MS,
  RETAINED_GENERATION_MAX_AGE_MS,
} from '../src/memory/lifecycle';

const appEnv = env as unknown as Env;
const actor = SYSTEM_ACTOR as Actor;

interface MemoryRpc {
  health(pid: string): Promise<{
    schemaVersion: number;
    memoryRevision: number;
    tableCounts: Record<string, number>;
    databaseSize: number;
    sizeStatus: 'ok' | 'warn' | 'critical';
  }>;
  exportSnapshot(pid: string): Promise<{ ok: true; manifest: { exportedAt: string } } | { ok: false; reason: string }>;
  restoreSnapshot(pid: string, opts: { exportedAt: string }): Promise<{ ok: true } | { ok: false; reason: string }>;
  rollback(pid: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  erase(pid: string): Promise<{ ok: true }>;
  eraseAll(pid: string): Promise<{ ok: boolean; steps: Array<{ step: string; ok: boolean; detail: string }> }>;
  _setForceEraseFailure(pid: string, fail: boolean): Promise<void>;
  writeNode(pid: string, input: { type: string; uri: string; label: string; actor: { kind: string; id: string | null } }): Promise<{ nodeId: string }>;
  _seedStagedIndexGeneration(pid: string, repositoryKey: string, createdAt: string): Promise<string>;
  _countIndexGenerations(pid: string): Promise<number>;
  _setMetaForTest(pid: string, key: string, value: string): Promise<void>;
  pruneAbandonedStagedGenerations(pid: string, maxAgeMs: number): Promise<number>;
  pruneRetainedGenerationIfExpired(pid: string, maxAgeMs: number): Promise<boolean>;
}
interface RoomRpc {
  deleteProject(pid: string, actor: Actor): Promise<{ ok: true; key: string; name: string }>;
}

const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as MemoryRpc;
const room = (pid: string) => projectRoom<RoomRpc>(pid);
const SYSTEM = { kind: 'system', id: null };

async function newOwnedProject(email: string, key: string) {
  const user = await createUser(email, 'Owner', 'longenough1');
  const token = await mintTokenForUser(email);
  const proj = await mcpCall(token, 'create_project', { key, name: `${key} project` });
  if (proj.isError) throw new Error(`create_project(${key}) failed: ${proj.text}`);
  return { userId: user.id, token, projectId: proj.body.id as string };
}

describe('sizeStatus — pure threshold logic', () => {
  it('classifies ok / warn / critical', () => {
    expect(sizeStatus(0)).toBe('ok');
    expect(sizeStatus(DB_SIZE_WARN_BYTES - 1)).toBe('ok');
    expect(sizeStatus(DB_SIZE_WARN_BYTES)).toBe('warn');
    expect(sizeStatus(DB_SIZE_CRITICAL_BYTES)).toBe('critical');
  });
});

describe('health() surfaces real size visibility', () => {
  it('reports a positive databaseSize and ok status for a fresh store', async () => {
    const { projectId } = await newOwnedProject('pm-life-size@example.com', 'PMLFSZ');
    const h = await memory(projectId).health(projectId);
    expect(h.databaseSize).toBeGreaterThan(0);
    expect(h.sizeStatus).toBe('ok');
  });
});

describe('auditable deletion sequence', () => {
  it('deleting a project clears the DO store, its R2 backups, and every registry row', async () => {
    const { projectId } = await newOwnedProject('pm-life-delete@example.com', 'PMLFDEL');
    await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/to-delete', label: 'to-delete', actor: SYSTEM });
    const exported = await memory(projectId).exportSnapshot(projectId);
    if (!exported.ok) throw new Error('export failed');

    await room(projectId).deleteProject(projectId, actor);

    // Inline erasure is fire-and-forget — poll briefly, same technique memory-registry.test.ts
    // uses for the same reason.
    let tombstoneCleared = false;
    for (let i = 0; i < 10 && !tombstoneCleared; i++) {
      const row = await appEnv.DB.prepare('SELECT 1 FROM memory_erasure_tombstones WHERE project_id = ?').bind(projectId).first();
      tombstoneCleared = !row;
      if (!tombstoneCleared) await new Promise((r) => setTimeout(r, 50));
    }
    expect(tombstoneCleared).toBe(true);

    const h = await memory(projectId).health(projectId);
    expect(h.tableCounts.nodes).toBe(0);
    const remainingBackups = await listProjectBackupGenerations(appEnv, projectId);
    expect(remainingBackups).toEqual([]);
    for (const table of ['project_memory_registry', 'project_repositories', 'memory_event_dedup']) {
      const row = await appEnv.DB.prepare(`SELECT 1 FROM ${table} WHERE project_id = ?`).bind(projectId).first();
      expect(row).toBeNull();
    }
  });

  it('a failed erasure attempt leaves the tombstone standing; the sweep retries and clears it', async () => {
    const { projectId } = await newOwnedProject('pm-life-fail@example.com', 'PMLFFAIL');
    await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/x', label: 'x', actor: SYSTEM });
    await memory(projectId)._setForceEraseFailure(projectId, true);

    await room(projectId).deleteProject(projectId, actor);
    // Give the inline (failing) attempt a moment, same as the success-path poll above.
    await new Promise((r) => setTimeout(r, 100));
    const stillStanding = await appEnv.DB.prepare('SELECT 1 FROM memory_erasure_tombstones WHERE project_id = ?').bind(projectId).first();
    expect(stillStanding).not.toBeNull();

    await memory(projectId)._setForceEraseFailure(projectId, false);
    const swept = await sweepPendingErasures(appEnv);
    const thisOne = swept.find((s) => s.projectId === projectId);
    expect(thisOne?.cleared).toBe(true);

    const clearedNow = await appEnv.DB.prepare('SELECT 1 FROM memory_erasure_tombstones WHERE project_id = ?').bind(projectId).first();
    expect(clearedNow).toBeNull();
  });

  it('re-erasing an already-erased project is a no-op that still reports ok', async () => {
    const { projectId } = await newOwnedProject('pm-life-reerase@example.com', 'PMLFREER');
    const first = await memory(projectId).eraseAll(projectId);
    expect(first.ok).toBe(true);
    const second = await memory(projectId).eraseAll(projectId);
    expect(second.ok).toBe(true);
    expect(second.steps.every((s) => s.ok)).toBe(true);
  });
});

describe('debris pruning', () => {
  it('prunes a staged index generation past its max age but keeps a fresh one', async () => {
    const { projectId } = await newOwnedProject('pm-life-staged@example.com', 'PMLFSTG');
    const old = new Date(Date.now() - STAGED_GENERATION_MAX_AGE_MS - 1000).toISOString();
    const fresh = new Date().toISOString();
    await memory(projectId)._seedStagedIndexGeneration(projectId, 'repo-old', old);
    await memory(projectId)._seedStagedIndexGeneration(projectId, 'repo-fresh', fresh);

    const pruned = await memory(projectId).pruneAbandonedStagedGenerations(projectId, STAGED_GENERATION_MAX_AGE_MS);
    expect(pruned).toBe(1);
    expect(await memory(projectId)._countIndexGenerations(projectId)).toBe(1);

    // Idempotent: running again prunes nothing further.
    expect(await memory(projectId).pruneAbandonedStagedGenerations(projectId, STAGED_GENERATION_MAX_AGE_MS)).toBe(0);
  });

  it('prunes a retained restore generation once its rollback window has passed', async () => {
    const { projectId } = await newOwnedProject('pm-life-retained@example.com', 'PMLFRTN');
    await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/pre-restore', label: 'pre-restore', actor: SYSTEM });
    const exported = await memory(projectId).exportSnapshot(projectId);
    if (!exported.ok) throw new Error('export failed');
    await memory(projectId).erase(projectId);
    const restored = await memory(projectId).restoreSnapshot(projectId, { exportedAt: exported.manifest.exportedAt });
    if (!restored.ok) throw new Error('restore failed');

    // Within the window: not yet eligible.
    expect(await memory(projectId).pruneRetainedGenerationIfExpired(projectId, RETAINED_GENERATION_MAX_AGE_MS)).toBe(false);

    // Backdate the retained generation past the window, then it prunes.
    const longAgo = new Date(Date.now() - RETAINED_GENERATION_MAX_AGE_MS - 1000).toISOString();
    await memory(projectId)._setMetaForTest(projectId, 'prior_generation_created_at', longAgo);
    expect(await memory(projectId).pruneRetainedGenerationIfExpired(projectId, RETAINED_GENERATION_MAX_AGE_MS)).toBe(true);

    const rollbackAfterPrune = await memory(projectId).rollback(projectId);
    expect(rollbackAfterPrune.ok).toBe(false); // nothing left to roll back to
  });

  it('prunes backup generations beyond the retention count', async () => {
    const { projectId } = await newOwnedProject('pm-life-retain@example.com', 'PMLFRTC');
    await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/y', label: 'y', actor: SYSTEM });
    for (let i = 0; i < 3; i++) {
      const res = await memory(projectId).exportSnapshot(projectId);
      if (!res.ok) throw new Error('export failed');
    }
    expect(await listProjectBackupGenerations(appEnv, projectId)).toHaveLength(3);

    const pruned = await pruneBackupRetention(appEnv, projectId, 2);
    expect(pruned).toBe(1);
    expect(await listProjectBackupGenerations(appEnv, projectId)).toHaveLength(2);

    // Idempotent at the new count.
    expect(await pruneBackupRetention(appEnv, projectId, 2)).toBe(0);
  });

  it('sweepProjectDebris is a no-op the second time it runs back to back', async () => {
    const { projectId } = await newOwnedProject('pm-life-sweep@example.com', 'PMLFSWP');
    // sweepProjectDebris iterates project_memory_registry — a project with no registry row yet
    // (nothing has exported/restored/registered against it) has nothing to sweep. Any of those
    // calls upserts the row; exportSnapshot is the cheapest for this test's purposes.
    const seedExport = await memory(projectId).exportSnapshot(projectId);
    if (!seedExport.ok) throw new Error('seed export failed');
    const old = new Date(Date.now() - STAGED_GENERATION_MAX_AGE_MS - 1000).toISOString();
    await memory(projectId)._seedStagedIndexGeneration(projectId, 'repo-x', old);

    const first = await sweepProjectDebris(appEnv);
    const firstForProject = first.find((r) => r.projectId === projectId);
    expect(firstForProject?.prunedStagedGenerations).toBe(1);

    const second = await sweepProjectDebris(appEnv);
    const secondForProject = second.find((r) => r.projectId === projectId);
    expect(secondForProject?.prunedStagedGenerations).toBe(0);
  });
});

describe('rehearsed disaster recovery — portable snapshot path', () => {
  it('export -> erase -> restore reproduces canonical state end to end', async () => {
    const { projectId } = await newOwnedProject('pm-life-dr@example.com', 'PMLFDR');
    await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/dr-1', label: 'dr-1', actor: SYSTEM });
    await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/dr-2', label: 'dr-2', actor: SYSTEM });

    const exported = await memory(projectId).exportSnapshot(projectId);
    if (!exported.ok) throw new Error('export failed');
    await memory(projectId).erase(projectId);
    expect((await memory(projectId).health(projectId)).tableCounts.nodes).toBe(0);

    const restored = await memory(projectId).restoreSnapshot(projectId, { exportedAt: exported.manifest.exportedAt });
    expect(restored.ok).toBe(true);
    expect((await memory(projectId).health(projectId)).tableCounts.nodes).toBe(2);
  });
});
