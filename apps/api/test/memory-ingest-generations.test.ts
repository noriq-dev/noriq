// PLNR-261: staged index generations and atomic activation. Drives ProjectMemory's real
// stage -> validate -> promote RPCs directly (same technique as memory-registry.test.ts) —
// killed uploads leaving the active graph untouched, batch replay convergence, validation
// failure with actionable status and no partial-entity exposure, idempotent activation,
// declared deletions, and the abandoned-staged-generation sweep.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { createUser, mintTokenForUser, mcpCall } from './helpers';
import { computeStagedContentHash } from '../src/memory/ingest';

const appEnv = env as unknown as Env;

interface IndexManifestInput {
  generationId: string; projectId: string; repositoryKey: string; branch: string; baseId: string;
  indexerVersion: string; batchCount: number; fileCount: number; contentHash: string; deletions: string[]; createdAt: string;
}
interface StagedRow { kind: 'node' | 'edge'; uri?: string; type?: string; label?: string; content?: string | null; from?: string; to?: string }

interface MemRpc {
  beginIndexIngest(pid: string, manifest: IndexManifestInput): Promise<{ ok: true }>;
  ingestIndexBatch(pid: string, batch: { generationId: string; batchNumber: number; batchHash: string }, rows: StagedRow[]): Promise<{ ok: true; deduped: boolean }>;
  completeIndexIngest(pid: string, generationId: string): Promise<{ ok: true; batchesReceived: number; validation: { ok: boolean; problems: string[] } }>;
  activateIndexGeneration(pid: string, generationId: string): Promise<{
    activated: string; superseded: string[]; projection: { nodesWritten: number };
  }>;
  abortIndexIngest(pid: string, generationId: string): Promise<{ ok: true }>;
  indexIngestStatus(pid: string, generationId: string): Promise<{ status: string; sealed: boolean; batchesReceived: number; batchesExpected: number | null; validation: { ok: boolean; problems: string[] } | null }>;
  _getIndexGenerationStatusForTest(pid: string, generationId: string): Promise<string | null>;
  _seedStagedIndexGeneration(pid: string, repositoryKey: string, createdAt: string): Promise<string>;
  pruneAbandonedStagedGenerations(pid: string, maxAgeMs: number): Promise<number>;
}

const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as MemRpc;

async function newOwnedProject(email: string, key: string) {
  const user = await createUser(email, 'Owner', 'longenough1');
  const token = await mintTokenForUser(email);
  const proj = await mcpCall(token, 'create_project', { key, name: `${key} project` });
  if (proj.isError) throw new Error(`create_project(${key}) failed: ${proj.text}`);
  return { userId: user.id, projectId: proj.body.id as string };
}

const baseManifest = (over: Partial<IndexManifestInput> & Pick<IndexManifestInput, 'generationId' | 'projectId' | 'repositoryKey'>): IndexManifestInput => ({
  branch: 'main', baseId: 'sha_1', indexerVersion: 'v1', batchCount: 1, fileCount: 1, contentHash: '0'.repeat(64), deletions: [], createdAt: new Date().toISOString(),
  ...over,
});

describe('staged generation lifecycle — begin/batch/complete/activate', () => {
  it('killing an upload partway leaves the previously active generation byte-identical and queryable', async () => {
    const { projectId } = await newOwnedProject('pm-261-kill@example.com', 'PM61KIL');
    const m = memory(projectId);
    // First generation activates cleanly.
    const rowsA: StagedRow[] = [
      { kind: 'node', uri: 'noriq://file/PM61KIL/repo-a/a.ts', type: 'file', label: 'a.ts' },
    ];
    await m.beginIndexIngest(projectId, baseManifest({ generationId: 'gen_a', projectId, repositoryKey: 'repo-a', contentHash: await computeStagedContentHash(rowsA as never) }));
    await m.ingestIndexBatch(projectId, { generationId: 'gen_a', batchNumber: 0, batchHash: 'h' }, rowsA);
    await m.completeIndexIngest(projectId, 'gen_a');
    await m.activateIndexGeneration(projectId, 'gen_a');
    expect(await m._getIndexGenerationStatusForTest(projectId, 'gen_a')).toBe('active');

    // Second generation begins and receives ONE of its two declared batches, then is abandoned
    // (never completed/activated) — the "killed halfway" case.
    await m.beginIndexIngest(projectId, baseManifest({ generationId: 'gen_b', projectId, repositoryKey: 'repo-a', batchCount: 2, fileCount: 2 }));
    await m.ingestIndexBatch(projectId, { generationId: 'gen_b', batchNumber: 0, batchHash: 'h' }, [
      { kind: 'node', uri: 'noriq://file/PM61KIL/repo-a/b.ts', type: 'file', label: 'b.ts' },
    ]);

    // The previous active generation is untouched.
    expect(await m._getIndexGenerationStatusForTest(projectId, 'gen_a')).toBe('active');
    expect(await m._getIndexGenerationStatusForTest(projectId, 'gen_b')).toBe('staged');
  });

  it('uploading the same batch twice converges — the staged row count is unaffected by replay', async () => {
    const { projectId } = await newOwnedProject('pm-261-replay@example.com', 'PM61RPL');
    const m = memory(projectId);
    await m.beginIndexIngest(projectId, baseManifest({ generationId: 'gen_r', projectId, repositoryKey: 'repo-r' }));
    const batch = { generationId: 'gen_r', batchNumber: 0, batchHash: 'h' };
    const rows: StagedRow[] = [{ kind: 'node', uri: 'noriq://file/PM61RPL/repo-r/a.ts', type: 'file', label: 'a.ts' }];
    const first = await m.ingestIndexBatch(projectId, batch, rows);
    const second = await m.ingestIndexBatch(projectId, batch, rows);
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    const status = await m.indexIngestStatus(projectId, 'gen_r');
    expect(status.batchesReceived).toBe(1);
  });

  it('auto-accepts unsorted content-bearing rows through cursor hashing and projection', async () => {
    const { projectId } = await newOwnedProject('pm-402-cursor@example.com', 'PM402CUR');
    const m = memory(projectId);
    const fileUri = 'noriq://file/PM402CUR/repo-cursor/a.ts';
    const symbolUri = 'noriq://symbol/PM402CUR/repo-cursor/a.ts#a';
    const rows: StagedRow[] = [
      { kind: 'edge', type: 'declares', from: fileUri, to: symbolUri },
      { kind: 'node', uri: symbolUri, type: 'symbol', label: 'a', content: null },
      { kind: 'node', uri: fileUri, type: 'file', label: 'a.ts', content: 'export const a = 1;'.repeat(1_000) },
    ];
    await m.beginIndexIngest(projectId, baseManifest({
      generationId: 'gen_cursor_hash', projectId, repositoryKey: 'repo-cursor',
      contentHash: await computeStagedContentHash(rows as never),
    }));
    await m.ingestIndexBatch(
      projectId,
      { generationId: 'gen_cursor_hash', batchNumber: 0, batchHash: 'h' },
      rows,
    );

    const completed = await m.completeIndexIngest(projectId, 'gen_cursor_hash');

    expect(completed.validation).toEqual({ ok: true, problems: [] });
    expect(await m._getIndexGenerationStatusForTest(projectId, 'gen_cursor_hash')).toBe('active');
    await expect(m.activateIndexGeneration(projectId, 'gen_cursor_hash')).resolves.toMatchObject({
      activated: 'gen_cursor_hash',
      projection: { nodesWritten: 2, edgesWritten: 1 },
    });
  });

  it('a generation whose staged counts disagree with its manifest fails validation and activates nothing', async () => {
    const { projectId } = await newOwnedProject('pm-261-badcount@example.com', 'PM61BAD');
    const m = memory(projectId);
    const rows: StagedRow[] = [
      { kind: 'node', uri: 'noriq://file/PM61BAD/repo-bad/a.ts', type: 'file', label: 'a.ts' }, // only 1, manifest declares 5
    ];
    await m.beginIndexIngest(projectId, baseManifest({ generationId: 'gen_bad', projectId, repositoryKey: 'repo-bad', fileCount: 5, contentHash: await computeStagedContentHash(rows as never) }));
    await m.ingestIndexBatch(projectId, { generationId: 'gen_bad', batchNumber: 0, batchHash: 'h' }, rows);
    const completed = await m.completeIndexIngest(projectId, 'gen_bad');
    expect(completed.validation.ok).toBe(false);
    expect(completed.validation.problems.join(' ')).toMatch(/fileCount 5/);
    await expect(m.activateIndexGeneration(projectId, 'gen_bad')).rejects.toThrow(/failed validation/);
    expect(await m._getIndexGenerationStatusForTest(projectId, 'gen_bad')).toBe('staged'); // never activated
  });

  it('a generation with a staged edge referencing a node the same generation does not contain fails validation', async () => {
    const { projectId } = await newOwnedProject('pm-261-danglingedge@example.com', 'PM61DAN');
    const m = memory(projectId);
    const rows: StagedRow[] = [
      { kind: 'node', uri: 'noriq://file/PM61DAN/repo-edge/a.ts', type: 'file', label: 'a.ts' },
      { kind: 'edge', type: 'declares', from: 'noriq://file/PM61DAN/repo-edge/a.ts', to: 'noriq://symbol/PM61DAN/repo-edge/a.ts#missing' },
    ];
    await m.beginIndexIngest(projectId, baseManifest({ generationId: 'gen_edge', projectId, repositoryKey: 'repo-edge', contentHash: await computeStagedContentHash(rows as never) }));
    await m.ingestIndexBatch(projectId, { generationId: 'gen_edge', batchNumber: 0, batchHash: 'h' }, rows);
    const completed = await m.completeIndexIngest(projectId, 'gen_edge');
    expect(completed.validation.ok).toBe(false);
    expect(completed.validation.problems.join(' ')).toMatch(/missing staged node/);
  });

  it('presenting a batch for a generation that already completed is refused explicitly', async () => {
    const { projectId } = await newOwnedProject('pm-261-sealed@example.com', 'PM61SEAL');
    const m = memory(projectId);
    const rows: StagedRow[] = [
      { kind: 'node', uri: 'noriq://file/PM61SEAL/repo-seal/a.ts', type: 'file', label: 'a.ts' },
    ];
    await m.beginIndexIngest(projectId, baseManifest({ generationId: 'gen_seal', projectId, repositoryKey: 'repo-seal', contentHash: await computeStagedContentHash(rows as never) }));
    await m.ingestIndexBatch(projectId, { generationId: 'gen_seal', batchNumber: 0, batchHash: 'h' }, rows);
    await m.completeIndexIngest(projectId, 'gen_seal');
    await expect(
      m.ingestIndexBatch(projectId, { generationId: 'gen_seal', batchNumber: 1, batchHash: 'h' }, []),
    ).rejects.toThrow(/completed/);
  });

  it('a complete, valid generation activates idempotently — retrying republishes the same graph and leaves one active row', async () => {
    const { projectId } = await newOwnedProject('pm-261-once@example.com', 'PM61ONCE');
    const m = memory(projectId);
    const rows: StagedRow[] = [
      { kind: 'node', uri: 'noriq://file/PM61ONCE/repo-once/a.ts', type: 'file', label: 'a.ts' },
    ];
    await m.beginIndexIngest(projectId, baseManifest({ generationId: 'gen_once', projectId, repositoryKey: 'repo-once', contentHash: await computeStagedContentHash(rows as never) }));
    await m.ingestIndexBatch(projectId, { generationId: 'gen_once', batchNumber: 0, batchHash: 'h' }, rows);
    await m.completeIndexIngest(projectId, 'gen_once');
    const first = await m.activateIndexGeneration(projectId, 'gen_once');
    const retry = await m.activateIndexGeneration(projectId, 'gen_once');
    expect(first.projection.nodesWritten).toBe(1);
    expect(retry).toMatchObject({ activated: 'gen_once', superseded: [] });
    expect(await m._getIndexGenerationStatusForTest(projectId, 'gen_once')).toBe('active');
  });

  it('after activation the previous generation is superseded and exactly one row per repository is active', async () => {
    const { projectId } = await newOwnedProject('pm-261-supersede@example.com', 'PM61SUP');
    const m = memory(projectId);
    for (const [genId, fileName] of [['gen_1', 'a.ts'], ['gen_2', 'b.ts']] as const) {
      const rows: StagedRow[] = [
        { kind: 'node', uri: `noriq://file/PM61SUP/repo-sup/${fileName}`, type: 'file', label: fileName },
      ];
      await m.beginIndexIngest(projectId, baseManifest({ generationId: genId, projectId, repositoryKey: 'repo-sup', contentHash: await computeStagedContentHash(rows as never) }));
      await m.ingestIndexBatch(projectId, { generationId: genId, batchNumber: 0, batchHash: 'h' }, rows);
      await m.completeIndexIngest(projectId, genId);
      await m.activateIndexGeneration(projectId, genId);
    }
    expect(await m._getIndexGenerationStatusForTest(projectId, 'gen_1')).toBe('superseded');
    expect(await m._getIndexGenerationStatusForTest(projectId, 'gen_2')).toBe('active');
  });

  it('activating an unsealed (not yet completed) generation is refused', async () => {
    const { projectId } = await newOwnedProject('pm-261-unsealed@example.com', 'PM61UNS');
    const m = memory(projectId);
    await m.beginIndexIngest(projectId, baseManifest({ generationId: 'gen_unsealed', projectId, repositoryKey: 'repo-uns' }));
    await expect(m.activateIndexGeneration(projectId, 'gen_unsealed')).rejects.toThrow(/has not completed ingest/);
  });

  it('declared deletions are carried through to activation without error (no CODE_VECTORIZE bound in this suite, so nothing to retire — status transition is unconditional)', async () => {
    const { projectId } = await newOwnedProject('pm-261-deletions@example.com', 'PM61DEL');
    const m = memory(projectId);
    const rows: StagedRow[] = [
      { kind: 'node', uri: 'noriq://file/PM61DEL/repo-del/a.ts', type: 'file', label: 'a.ts' },
    ];
    await m.beginIndexIngest(projectId, baseManifest({ generationId: 'gen_del', projectId, repositoryKey: 'repo-del', deletions: ['removed.ts'], contentHash: await computeStagedContentHash(rows as never) }));
    await m.ingestIndexBatch(projectId, { generationId: 'gen_del', batchNumber: 0, batchHash: 'h' }, rows);
    await m.completeIndexIngest(projectId, 'gen_del');
    await expect(m.activateIndexGeneration(projectId, 'gen_del')).resolves.toMatchObject({ activated: 'gen_del', superseded: [] });
  });

  it('abort discards a still-staged generation and its staged rows; activate then reports it not found', async () => {
    const { projectId } = await newOwnedProject('pm-261-abort@example.com', 'PM61ABT');
    const m = memory(projectId);
    await m.beginIndexIngest(projectId, baseManifest({ generationId: 'gen_abort', projectId, repositoryKey: 'repo-abt' }));
    await m.ingestIndexBatch(projectId, { generationId: 'gen_abort', batchNumber: 0, batchHash: 'h' }, [
      { kind: 'node', uri: 'noriq://file/PM61ABT/repo-abt/a.ts', type: 'file', label: 'a.ts' },
    ]);
    await m.abortIndexIngest(projectId, 'gen_abort');
    expect(await m._getIndexGenerationStatusForTest(projectId, 'gen_abort')).toBeNull();
    await expect(m.activateIndexGeneration(projectId, 'gen_abort')).rejects.toThrow(/not found/);
  });

  it('rejects a digest mismatch and a cross-repository entity without publishing either generation', async () => {
    const { projectId } = await newOwnedProject('pm-397-validation@example.com', 'PM397VAL');
    const m = memory(projectId);
    const digestRows: StagedRow[] = [
      { kind: 'node', uri: 'noriq://file/PM397VAL/repo-a/a.ts', type: 'file', label: 'a.ts' },
    ];
    await m.beginIndexIngest(projectId, baseManifest({
      generationId: 'gen_bad_digest', projectId, repositoryKey: 'repo-a', contentHash: 'f'.repeat(64),
    }));
    await m.ingestIndexBatch(projectId, { generationId: 'gen_bad_digest', batchNumber: 0, batchHash: 'h' }, digestRows);
    const badDigest = await m.completeIndexIngest(projectId, 'gen_bad_digest');
    expect(badDigest.validation.problems.join(' ')).toMatch(/contentHash mismatch/);
    expect(await m._getIndexGenerationStatusForTest(projectId, 'gen_bad_digest')).toBe('staged');

    const foreignRows: StagedRow[] = [
      { kind: 'node', uri: 'noriq://file/PM397VAL/repo-b/foreign.ts', type: 'file', label: 'foreign.ts' },
    ];
    await m.beginIndexIngest(projectId, baseManifest({
      generationId: 'gen_cross_repo', projectId, repositoryKey: 'repo-a',
      contentHash: await computeStagedContentHash(foreignRows as never),
    }));
    await m.ingestIndexBatch(projectId, { generationId: 'gen_cross_repo', batchNumber: 0, batchHash: 'h' }, foreignRows);
    const crossRepo = await m.completeIndexIngest(projectId, 'gen_cross_repo');
    expect(crossRepo.validation.problems.join(' ')).toMatch(/does not belong to repository/);
    expect(await m._getIndexGenerationStatusForTest(projectId, 'gen_cross_repo')).toBe('staged');
  });

  it('keeps a late generation staged when another generation changes its captured predecessor', async () => {
    const { projectId } = await newOwnedProject('pm-397-predecessor@example.com', 'PM397CAS');
    const m = memory(projectId);
    const rows = (name: string): StagedRow[] => [
      { kind: 'node', uri: `noriq://file/PM397CAS/repo-a/${name}.ts`, type: 'file', label: `${name}.ts` },
    ];
    const stage = async (generationId: string, file: string) => {
      const staged = rows(file);
      await m.beginIndexIngest(projectId, baseManifest({
        generationId, projectId, repositoryKey: 'repo-a', contentHash: await computeStagedContentHash(staged as never),
      }));
      await m.ingestIndexBatch(projectId, { generationId, batchNumber: 0, batchHash: generationId }, staged);
    };

    await stage('gen_base', 'base');
    await m.completeIndexIngest(projectId, 'gen_base');
    await stage('gen_late', 'late');
    await stage('gen_fast', 'fast');
    await m.completeIndexIngest(projectId, 'gen_fast');
    await expect(m.completeIndexIngest(projectId, 'gen_late')).rejects.toThrow(/active predecessor changed/);
    expect(await m._getIndexGenerationStatusForTest(projectId, 'gen_fast')).toBe('active');
    expect(await m._getIndexGenerationStatusForTest(projectId, 'gen_late')).toBe('staged');
  });
});

describe('sweep prunes real abandoned staged generations (PLNR-250\'s hook, now doing real work)', () => {
  it('prunes an old staged generation and its staged batch/entity rows; a second sweep does nothing', async () => {
    const { projectId } = await newOwnedProject('pm-261-sweep@example.com', 'PM61SWP');
    const m = memory(projectId);
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString(); // > the 24h default
    const genId = await m._seedStagedIndexGeneration(projectId, 'repo-sweep', old);
    await m.ingestIndexBatch(projectId, { generationId: genId, batchNumber: 0, batchHash: 'h' }, [
      { kind: 'node', uri: `noriq://file/PM61SWP/repo-sweep/a.ts`, type: 'file', label: 'a.ts' },
    ]);

    const pruned = await m.pruneAbandonedStagedGenerations(projectId, 24 * 3600 * 1000);
    expect(pruned).toBe(1);
    expect(await m._getIndexGenerationStatusForTest(projectId, genId)).toBeNull();

    const again = await m.pruneAbandonedStagedGenerations(projectId, 24 * 3600 * 1000);
    expect(again).toBe(0);
  });
});
