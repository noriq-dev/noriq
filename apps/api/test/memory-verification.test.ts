// PLNR-265: server-side citation checks and stale-memory transitions.
//
// Three layers, cheapest-first (same split memory-episodes.test.ts/memory-similar-effort.test.ts
// use):
//   - memory/verification.ts's PURE exports (citationVerdict, verifiedForBase, rollUpValidity,
//     normalizeVerificationReport) driven directly — the precise place to pin the base-mismatch
//     rule, the roll-up's exact buckets, and report-shape validation without any DO noise.
//   - ProjectMemory.verifyMemoryCitations / acceptVerificationReport end to end, against a REAL
//     projected index generation (the same begin/batch/complete/activate/project flow
//     memory-projection.test.ts drives), plus searchProjectMemory's new base-mismatch lead
//     reason.
//   - The REST verification-report route — agentAuth, the run's own bound agent only.
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { createUser, mintTokenForUser, mcpCall, createRunAgent } from './helpers';
import { buildEntityUri } from '@noriq-dev/shared';
import { citationVerdict, verifiedForBase, rollUpValidity, normalizeVerificationReport } from '../src/memory/verification';

const appEnv = env as unknown as Env;

// -------------------------------------------------------------------------------------------
// Layer 1 — memory/verification.ts's pure exports
// -------------------------------------------------------------------------------------------

describe('citationVerdict — the cheap tier\'s verdict rule', () => {
  it('no active generation to check against -> unverifiable, never valid or missing', () => {
    expect(citationVerdict(null)).toBe('unverifiable');
  });
  it('the file node is absent -> missing', () => {
    expect(citationVerdict({ pathPresent: false, symbolPresent: null })).toBe('missing');
  });
  it('the file survives but the cited symbol does not -> changed', () => {
    expect(citationVerdict({ pathPresent: true, symbolPresent: false })).toBe('changed');
  });
  it('the file survives and the citation names no symbol -> valid', () => {
    expect(citationVerdict({ pathPresent: true, symbolPresent: null })).toBe('valid');
  });
  it('the file and the cited symbol both survive -> valid', () => {
    expect(citationVerdict({ pathPresent: true, symbolPresent: true })).toBe('valid');
  });
  it('never returns \'moved\' — that verdict is reachable only through a Runner report', () => {
    const every = [null, { pathPresent: false, symbolPresent: null }, { pathPresent: true, symbolPresent: false }, { pathPresent: true, symbolPresent: true }];
    for (const check of every) expect(citationVerdict(check)).not.toBe('moved');
  });
});

describe('verifiedForBase — string equality only, never prefix/substring/length', () => {
  const validCitation = { verificationState: 'valid', lastVerifiedBaseId: 'abc123456', lastVerifiedBranch: 'main' };

  it('matches when the caller asks about the exact branch/base that was verified', () => {
    expect(verifiedForBase(validCitation, { baseId: 'abc123456', branch: 'main' })).toBe(true);
  });
  it('a caller baseId that is a PREFIX of the verified one does not match', () => {
    expect(verifiedForBase(validCitation, { baseId: 'abc1234', branch: 'main' })).toBe(false);
  });
  it('a caller baseId that the verified one is a prefix OF (a superstring) does not match either', () => {
    expect(verifiedForBase(validCitation, { baseId: 'abc123456999', branch: 'main' })).toBe(false);
  });
  it('a caller branch mismatch alone is enough to fail, even with the same baseId', () => {
    expect(verifiedForBase(validCitation, { baseId: 'abc123456', branch: 'feature-x' })).toBe(false);
  });
  it('a caller with no branch/base context at all gets no scoping penalty', () => {
    expect(verifiedForBase(validCitation, {})).toBe(true);
  });
  it('a non-\'valid\' citation is never verified for anyone, regardless of scope', () => {
    expect(verifiedForBase({ ...validCitation, verificationState: 'missing' }, {})).toBe(false);
    expect(verifiedForBase({ ...validCitation, verificationState: 'unverifiable' }, { baseId: 'abc123456', branch: 'main' })).toBe(false);
  });
});

describe('rollUpValidity — the memory-level roll-up', () => {
  it('zero evidence rows -> null (never demoted by this path)', () => {
    expect(rollUpValidity([])).toBeNull();
  });
  it('every citation valid -> active', () => {
    expect(rollUpValidity(['valid', 'valid'])).toBe('active');
  });
  it('every citation missing -> invalid', () => {
    expect(rollUpValidity(['missing', 'missing'])).toBe('invalid');
  });
  it('a mix of valid and missing -> stale', () => {
    expect(rollUpValidity(['valid', 'missing'])).toBe('stale');
  });
  it('every citation unverifiable (never checked, or unindexed) -> stale, not active', () => {
    expect(rollUpValidity(['unverifiable', 'unverifiable'])).toBe('stale');
  });
});

describe('normalizeVerificationReport — validation and within-report dedup', () => {
  it('defaults source to runner-report and dedupes an exact-duplicate citation within one report', () => {
    const report = normalizeVerificationReport({
      citations: [
        { memoryItemId: 'mem_1', evidenceHash: 'h1', state: 'valid', baseId: 'sha_1', branch: 'main' },
        { memoryItemId: 'mem_1', evidenceHash: 'h1', state: 'valid', baseId: 'sha_1', branch: 'main' },
      ],
    });
    expect(report.source).toBe('runner-report');
    expect(report.citations).toHaveLength(1);
  });
  it('a differently-stated citation for the SAME evidence is kept, not deduped away', () => {
    const report = normalizeVerificationReport({
      citations: [
        { memoryItemId: 'mem_1', evidenceHash: 'h1', state: 'valid', baseId: 'sha_1', branch: 'main' },
        { memoryItemId: 'mem_1', evidenceHash: 'h1', state: 'missing', baseId: 'sha_2', branch: 'main' },
      ],
    });
    expect(report.citations).toHaveLength(2);
  });
  it('throws on an empty citations array', () => {
    expect(() => normalizeVerificationReport({ citations: [] })).toThrow();
  });
  it('throws on an empty baseId — BaseId rejects emptiness, not shape', () => {
    expect(() =>
      normalizeVerificationReport({ citations: [{ memoryItemId: 'm', evidenceHash: 'h', state: 'valid', baseId: '', branch: 'main' }] }),
    ).toThrow();
  });
  it('throws on an unknown verification state', () => {
    expect(() =>
      normalizeVerificationReport({ citations: [{ memoryItemId: 'm', evidenceHash: 'h', state: 'definitely-fine', baseId: 'sha_1', branch: 'main' }] }),
    ).toThrow();
  });
});

// -------------------------------------------------------------------------------------------
// Layer 2 — ProjectMemory.verifyMemoryCitations / acceptVerificationReport / searchProjectMemory
// -------------------------------------------------------------------------------------------

interface EvidenceRecord {
  id: string;
  repositoryKey: string;
  branch: string;
  baseId: string;
  path: string;
  symbol: string | null;
  verificationState: string;
  evidenceHash: string | null;
  lastVerifiedAt: string | null;
  lastVerifiedBaseId: string | null;
  lastVerifiedBranch: string | null;
  verificationSource: string | null;
  observedPath: string | null;
}
interface MemoryItemRecord {
  id: string;
  validity: string;
  authority: number;
  statement: string;
  kind: string;
  evidence: EvidenceRecord[];
}
interface RankedHit {
  id: string;
  entityType: string;
  authority?: number;
  validity?: string;
  evidenceVerification?: string[];
  evidenceVerifiedForCaller?: boolean[];
  isLead: boolean;
  leadReasons: string[];
}
interface IndexManifestInput {
  generationId: string; projectId: string; repositoryKey: string; branch: string; baseId: string;
  indexerVersion: string; batchCount: number; fileCount: number; contentHash: string; deletions: string[]; createdAt: string;
}
interface StagedRow { kind: 'node' | 'edge'; uri?: string; type?: string; label?: string; content?: string | null; from?: string; to?: string }
interface VerificationReportCitationInput {
  memoryItemId: string; evidenceHash: string; state: string; baseId: string; branch: string; observedPath?: string | null;
}

interface MemRpc {
  health(pid: string): Promise<{ memoryRevision: number; tableCounts: Record<string, number> }>;
  recordMemory(
    pid: string,
    input: {
      kind: string; statement: string; authority?: number;
      evidence?: Array<{ repositoryKey: string; branch: string; baseId: string; path: string; symbol?: string | null }>;
      actor: { kind: string; id: string | null };
    },
  ): Promise<{ memoryId: string }>;
  getMemoryItem(pid: string, memoryId: string): Promise<MemoryItemRecord | null>;
  searchProjectMemory(
    pid: string,
    opts: { memoryItemId?: string; branch?: string; baseId?: string },
  ): Promise<{ mode: string; results: RankedHit[] }>;
  verifyMemoryCitations(
    pid: string,
    input: { memoryItemId?: string; limit?: number },
  ): Promise<{ checked: number; updated: number; results: Array<{ evidenceId: string; memoryItemId: string; verificationState: string }> }>;
  acceptVerificationReport(
    pid: string,
    report: { citations: VerificationReportCitationInput[]; source: string },
    actor: { kind: string; id: string | null },
  ): Promise<{ applied: number; skipped: number; touchedMemoryIds: string[] }>;
  beginIndexIngest(pid: string, manifest: IndexManifestInput): Promise<{ ok: true }>;
  ingestIndexBatch(pid: string, batch: { generationId: string; batchNumber: number; batchHash: string }, rows: StagedRow[]): Promise<{ ok: true; deduped: boolean }>;
  completeIndexIngest(pid: string, generationId: string): Promise<{ ok: true; batchesReceived: number; validation: { ok: boolean; problems: string[] } }>;
  activateIndexGeneration(pid: string, generationId: string): Promise<{ activated: string; superseded: string[] }>;
  projectActiveGeneration(pid: string, generationId: string): Promise<{ nodesWritten: number }>;
}
const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as MemRpc;

async function newOwnedProject(email: string, key: string) {
  await createUser(email, 'Owner', 'longenough1');
  const token = await mintTokenForUser(email);
  const proj = await mcpCall(token, 'create_project', { key, name: `${key} project` });
  if (proj.isError) throw new Error(`create_project(${key}) failed: ${proj.text}`);
  return { token, projectId: proj.body.id as string };
}

function manifestFor(over: Partial<IndexManifestInput> & Pick<IndexManifestInput, 'generationId' | 'projectId' | 'repositoryKey' | 'branch' | 'baseId'>): IndexManifestInput {
  return { indexerVersion: 'v1', batchCount: 1, fileCount: 1, contentHash: 'sha256:x', deletions: [], createdAt: new Date().toISOString(), ...over };
}

/** Stage one batch and drive it all the way to a projected, active generation — same technique
 *  memory-projection.test.ts uses. `branch`/`baseId` are REQUIRED here (not defaulted) because
 *  this suite's whole point is exercising DIFFERENT bases, and a default that only sometimes
 *  applies is exactly the kind of footgun that hides a base-scoping bug. */
async function stageAndProject(projectId: string, opts: { generationId: string; repositoryKey: string; branch: string; baseId: string; rows: StagedRow[] }) {
  const m = memory(projectId);
  await m.beginIndexIngest(projectId, manifestFor({
    generationId: opts.generationId, projectId, repositoryKey: opts.repositoryKey, branch: opts.branch, baseId: opts.baseId,
    fileCount: opts.rows.filter((r) => r.kind === 'node' && r.type === 'file').length,
  }));
  await m.ingestIndexBatch(projectId, { generationId: opts.generationId, batchNumber: 0, batchHash: 'h' }, opts.rows);
  const completed = await m.completeIndexIngest(projectId, opts.generationId);
  if (!completed.validation.ok) throw new Error(`validation failed: ${completed.validation.problems.join('; ')}`);
  await m.activateIndexGeneration(projectId, opts.generationId);
  return m.projectActiveGeneration(projectId, opts.generationId);
}

describe('verifyMemoryCitations — the cheap server-side tier', () => {
  it('the load-bearing acceptance: valid at branch A / base X is not verified for a caller at branch B / base Y — it surfaces as a lead naming the base mismatch', async () => {
    const { projectId } = await newOwnedProject('pm-verify-basemismatch@example.com', 'PMVBM1');
    const fileUri = buildEntityUri({ kind: 'file', projectKey: 'PMVBM1', repositoryKey: 'repo-a', path: 'src/a.ts' });
    await stageAndProject(projectId, {
      generationId: 'gen_bm1', repositoryKey: 'repo-a', branch: 'main', baseId: 'sha_1',
      rows: [{ kind: 'node', uri: fileUri, type: 'file', label: 'a.ts' }],
    });

    // authority 5 / actor kind 'human' — bypasses the agent authority clamp so this test isolates
    // the base-mismatch reason from the unrelated 'low-authority' one.
    const { memoryId } = await memory(projectId).recordMemory(projectId, {
      kind: 'procedure', statement: 'run migrations with --safe-mode', authority: 5,
      evidence: [{ repositoryKey: 'repo-a', branch: 'main', baseId: 'sha_1', path: 'src/a.ts' }],
      actor: { kind: 'human', id: 'user_1' },
    });

    const verify = await memory(projectId).verifyMemoryCitations(projectId, { memoryItemId: memoryId });
    expect(verify.results).toEqual([{ evidenceId: expect.any(String), memoryItemId: memoryId, verificationState: 'valid' }]);

    const item = await memory(projectId).getMemoryItem(projectId, memoryId);
    expect(item!.evidence[0]!.lastVerifiedBaseId).toBe('sha_1');
    expect(item!.evidence[0]!.lastVerifiedBranch).toBe('main');
    expect(item!.evidence[0]!.verificationSource).toBe('server-index');
    expect(item!.evidence[0]!.lastVerifiedAt).not.toBeNull();
    expect(item!.validity).toBe('active');

    // Same branch/base the citation was verified against -> genuinely verified, no lead at all.
    const sameBase = await memory(projectId).searchProjectMemory(projectId, { memoryItemId: memoryId, branch: 'main', baseId: 'sha_1' });
    expect(sameBase.results[0]!.isLead).toBe(false);
    expect(sameBase.results[0]!.leadReasons).toEqual([]);

    // A DIFFERENT baseId, same branch: the citation still reads 'valid' in its own row, but it is
    // NOT verified for this caller — the task's own first acceptance line.
    const otherBase = await memory(projectId).searchProjectMemory(projectId, { memoryItemId: memoryId, branch: 'main', baseId: 'sha_2' });
    expect(otherBase.results[0]!.evidenceVerification).toEqual(['valid']);
    expect(otherBase.results[0]!.evidenceVerifiedForCaller).toEqual([false]);
    expect(otherBase.results[0]!.leadReasons).toContain('evidence-base-mismatch');
    expect(otherBase.results[0]!.isLead).toBe(true);

    // A different BRANCH at the SAME baseId is caught too — both fields are part of scope.
    const otherBranch = await memory(projectId).searchProjectMemory(projectId, { memoryItemId: memoryId, branch: 'feature-x', baseId: 'sha_1' });
    expect(otherBranch.results[0]!.leadReasons).toContain('evidence-base-mismatch');

    // No branch/baseId supplied at all — nothing to compare against, so no mismatch penalty.
    const noScope = await memory(projectId).searchProjectMemory(projectId, { memoryItemId: memoryId });
    expect(noScope.results[0]!.leadReasons).toEqual([]);
  });

  it("a citation whose file no longer exists at the verified base is 'missing'; validity is demoted but the memory, its statement, its evidence, and its authority all stay fully readable", async () => {
    const { projectId } = await newOwnedProject('pm-verify-missing@example.com', 'PMVMISS');
    // An active generation exists for repo-a (something real to check against) but projects NO
    // node at all for the cited path — the file has been deleted at this base.
    await stageAndProject(projectId, { generationId: 'gen_miss1', repositoryKey: 'repo-a', branch: 'main', baseId: 'sha_1', rows: [] });

    const { memoryId } = await memory(projectId).recordMemory(projectId, {
      kind: 'learning', statement: 'the retry helper lives in src/deleted.ts', authority: 3,
      evidence: [{ repositoryKey: 'repo-a', branch: 'main', baseId: 'sha_1', path: 'src/deleted.ts' }],
      actor: { kind: 'human', id: 'user_1' },
    });
    expect((await memory(projectId).getMemoryItem(projectId, memoryId))!.validity).toBe('active');

    const verify = await memory(projectId).verifyMemoryCitations(projectId, { memoryItemId: memoryId });
    expect(verify.results[0]!.verificationState).toBe('missing');

    const after = await memory(projectId).getMemoryItem(projectId, memoryId);
    expect(after!.validity).toBe('invalid'); // sole citation missing -> rollUpValidity('invalid')
    expect(after!.statement).toBe('the retry helper lives in src/deleted.ts'); // untouched
    expect(after!.authority).toBe(3); // untouched
    expect(after!.evidence).toHaveLength(1); // never deleted
    expect(after!.evidence[0]!.verificationState).toBe('missing');
    expect(after!.evidence[0]!.verificationSource).toBe('server-index');
  });

  it('a memory with no repository evidence keeps its validity through every verification sweep', async () => {
    const { projectId } = await newOwnedProject('pm-verify-noevidence@example.com', 'PMVNOEV');
    const { memoryId } = await memory(projectId).recordMemory(projectId, {
      kind: 'decision', statement: 'adopt trunk-based development', authority: 5, actor: { kind: 'human', id: 'user_1' },
    });
    expect((await memory(projectId).getMemoryItem(projectId, memoryId))!.validity).toBe('active');

    // A project-wide bounded sweep touches OTHER citations, if any — this memory has none, so it
    // must never be touched by this path.
    await memory(projectId).verifyMemoryCitations(projectId, { limit: 50 });
    expect((await memory(projectId).getMemoryItem(projectId, memoryId))!.validity).toBe('active');
  });

  it("verifying with no active index generation at all degrades to 'unverifiable' rather than throwing — never 'valid', never 'missing'", async () => {
    const { projectId } = await newOwnedProject('pm-verify-noindex@example.com', 'PMVNOIDX');
    const { memoryId } = await memory(projectId).recordMemory(projectId, {
      kind: 'learning', statement: 'the retry cap is 5', authority: 2,
      evidence: [{ repositoryKey: 'repo-unindexed', branch: 'main', baseId: 'sha_1', path: 'src/x.ts' }],
      actor: { kind: 'human', id: 'user_1' },
    });

    const result = await memory(projectId).verifyMemoryCitations(projectId, { memoryItemId: memoryId });
    expect(result.results[0]!.verificationState).toBe('unverifiable');

    const item = await memory(projectId).getMemoryItem(projectId, memoryId);
    expect(item!.evidence[0]!.verificationState).toBe('unverifiable');
    expect(item!.evidence[0]!.lastVerifiedBaseId).toBeNull();
    expect(item!.evidence[0]!.verificationSource).toBe('server-index');
    // Sole citation unverifiable -> not "every valid", not "every missing" -> stale (the
    // documented reading of "some valid, some not" in rollUpValidity).
    expect(item!.validity).toBe('stale');
  });

  it('a never-verified citation reports every verification field as null, never implying valid', async () => {
    const { projectId } = await newOwnedProject('pm-verify-neverchecked@example.com', 'PMVNEVER');
    const { memoryId } = await memory(projectId).recordMemory(projectId, {
      kind: 'learning', statement: 'the flag lives in config.toml', authority: 2,
      evidence: [{ repositoryKey: 'repo-a', branch: 'main', baseId: 'sha_1', path: 'config.toml' }],
      actor: { kind: 'human', id: 'user_1' },
    });
    const ev = (await memory(projectId).getMemoryItem(projectId, memoryId))!.evidence[0]!;
    expect(ev.verificationState).toBe('unverifiable'); // 0001's own default, unrelated to this task
    expect(ev.lastVerifiedAt).toBeNull();
    expect(ev.lastVerifiedBaseId).toBeNull();
    expect(ev.lastVerifiedBranch).toBeNull();
    expect(ev.verificationSource).toBeNull();
  });

  it('re-sweeping with no underlying change updates nothing (idempotent by construction, not just by report dedup)', async () => {
    const { projectId } = await newOwnedProject('pm-verify-sweepidem@example.com', 'PMVSWIDM');
    const fileUri = buildEntityUri({ kind: 'file', projectKey: 'PMVSWIDM', repositoryKey: 'repo-a', path: 'src/a.ts' });
    await stageAndProject(projectId, {
      generationId: 'gen_swidm', repositoryKey: 'repo-a', branch: 'main', baseId: 'sha_1',
      rows: [{ kind: 'node', uri: fileUri, type: 'file', label: 'a.ts' }],
    });
    const { memoryId } = await memory(projectId).recordMemory(projectId, {
      kind: 'procedure', statement: 'safe-mode migrations', authority: 3,
      evidence: [{ repositoryKey: 'repo-a', branch: 'main', baseId: 'sha_1', path: 'src/a.ts' }],
      actor: { kind: 'human', id: 'user_1' },
    });
    const first = await memory(projectId).verifyMemoryCitations(projectId, { memoryItemId: memoryId });
    expect(first.updated).toBe(1);
    const revisionAfterFirst = (await memory(projectId).health(projectId)).memoryRevision;

    const second = await memory(projectId).verifyMemoryCitations(projectId, { memoryItemId: memoryId });
    expect(second.updated).toBe(0); // nothing changed — the graph, the base, and the source are identical
    expect((await memory(projectId).health(projectId)).memoryRevision).toBe(revisionAfterFirst);
  });
});

describe('acceptVerificationReport — the Runner thorough tier', () => {
  it('applying the same report twice leaves identical rows, ONE validity transition, and no second outbox event', async () => {
    const { projectId } = await newOwnedProject('pm-verify-idempotent@example.com', 'PMVIDEM');
    const { memoryId } = await memory(projectId).recordMemory(projectId, {
      kind: 'procedure', statement: 'run migrations with --safe-mode', authority: 3,
      evidence: [{ repositoryKey: 'repo-a', branch: 'main', baseId: 'sha_1', path: 'src/a.ts' }],
      actor: { kind: 'human', id: 'user_1' },
    });
    const before = await memory(projectId).getMemoryItem(projectId, memoryId);
    expect(before!.validity).toBe('active'); // the default a freshly-recorded memory starts at
    const evidenceHash = before!.evidence[0]!.evidenceHash!;
    expect(evidenceHash).toBeTruthy();
    const revisionBefore = (await memory(projectId).health(projectId)).memoryRevision;

    // 'missing' (not 'valid') so the FIRST application actually moves the roll-up away from the
    // default 'active' it already started at — proving one real transition fired, not merely
    // that the RPC returned without error.
    const report = { citations: [{ memoryItemId: memoryId, evidenceHash, state: 'missing', baseId: 'sha_1', branch: 'main' }], source: 'runner-report' };
    const first = await memory(projectId).acceptVerificationReport(projectId, report, { kind: 'agent', id: 'agt_runner' });
    expect(first).toEqual({ applied: 1, skipped: 0, touchedMemoryIds: [memoryId] });
    const afterFirst = await memory(projectId).getMemoryItem(projectId, memoryId);
    expect(afterFirst!.validity).toBe('invalid'); // sole citation now missing
    expect(afterFirst!.evidence[0]!.verificationState).toBe('missing');
    expect(afterFirst!.evidence[0]!.verificationSource).toBe('runner-report');
    const revisionAfterFirst = (await memory(projectId).health(projectId)).memoryRevision;
    expect(revisionAfterFirst).toBeGreaterThan(revisionBefore); // exactly one transition fired

    const second = await memory(projectId).acceptVerificationReport(projectId, report, { kind: 'agent', id: 'agt_runner' });
    expect(second).toEqual({ applied: 0, skipped: 1, touchedMemoryIds: [] });
    const revisionAfterSecond = (await memory(projectId).health(projectId)).memoryRevision;
    expect(revisionAfterSecond).toBe(revisionAfterFirst); // no second transition, no second event

    const afterSecond = await memory(projectId).getMemoryItem(projectId, memoryId);
    expect(afterSecond!.evidence[0]!.lastVerifiedAt).toBe(afterFirst!.evidence[0]!.lastVerifiedAt); // byte-identical row
  });

  it('moves a citation from valid to missing and back to valid — both directions recorded with their own source and timestamp', async () => {
    const { projectId } = await newOwnedProject('pm-verify-flip@example.com', 'PMVFLIP');
    const { memoryId } = await memory(projectId).recordMemory(projectId, {
      kind: 'procedure', statement: 'the deploy script lives at scripts/deploy.sh', authority: 3,
      evidence: [{ repositoryKey: 'repo-a', branch: 'main', baseId: 'sha_1', path: 'scripts/deploy.sh' }],
      actor: { kind: 'human', id: 'user_1' },
    });
    const evidenceHash = (await memory(projectId).getMemoryItem(projectId, memoryId))!.evidence[0]!.evidenceHash!;

    const toMissing = { citations: [{ memoryItemId: memoryId, evidenceHash, state: 'missing', baseId: 'sha_2', branch: 'main' }], source: 'runner-report' };
    await memory(projectId).acceptVerificationReport(projectId, toMissing, { kind: 'agent', id: 'agt_runner' });
    const afterMissing = await memory(projectId).getMemoryItem(projectId, memoryId);
    expect(afterMissing!.evidence[0]!.verificationState).toBe('missing');
    expect(afterMissing!.evidence[0]!.lastVerifiedBaseId).toBe('sha_2');
    expect(afterMissing!.evidence[0]!.verificationSource).toBe('runner-report');
    expect(afterMissing!.evidence[0]!.lastVerifiedAt).not.toBeNull();
    expect(afterMissing!.validity).toBe('invalid');

    const toValid = { citations: [{ memoryItemId: memoryId, evidenceHash, state: 'valid', baseId: 'sha_3', branch: 'main' }], source: 'runner-report' };
    await memory(projectId).acceptVerificationReport(projectId, toValid, { kind: 'agent', id: 'agt_runner' });
    const afterValid = await memory(projectId).getMemoryItem(projectId, memoryId);
    expect(afterValid!.evidence[0]!.verificationState).toBe('valid');
    expect(afterValid!.evidence[0]!.lastVerifiedBaseId).toBe('sha_3');
    expect(afterValid!.evidence[0]!.verificationSource).toBe('runner-report');
    expect(afterValid!.validity).toBe('active');
    expect(afterValid!.evidence[0]!.lastVerifiedAt).not.toBe(afterMissing!.evidence[0]!.lastVerifiedAt);
  });

  it('a citation naming evidence this project no longer has is skipped, not fatal to the rest of the report', async () => {
    const { projectId } = await newOwnedProject('pm-verify-skip@example.com', 'PMVSKIP');
    const { memoryId } = await memory(projectId).recordMemory(projectId, {
      kind: 'procedure', statement: 'real citation', authority: 3,
      evidence: [{ repositoryKey: 'repo-a', branch: 'main', baseId: 'sha_1', path: 'src/a.ts' }],
      actor: { kind: 'human', id: 'user_1' },
    });
    const evidenceHash = (await memory(projectId).getMemoryItem(projectId, memoryId))!.evidence[0]!.evidenceHash!;
    const report = {
      citations: [
        { memoryItemId: 'mem_does_not_exist', evidenceHash: 'no-such-hash', state: 'valid', baseId: 'sha_1', branch: 'main' },
        { memoryItemId: memoryId, evidenceHash, state: 'valid', baseId: 'sha_1', branch: 'main' },
      ],
      source: 'runner-report',
    };
    const result = await memory(projectId).acceptVerificationReport(projectId, report, { kind: 'agent', id: 'agt_runner' });
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.touchedMemoryIds).toEqual([memoryId]);
  });

  it('never deletes evidence or the memory it belongs to, even on repeated invalidation', async () => {
    const { projectId } = await newOwnedProject('pm-verify-nodelete@example.com', 'PMVNODEL');
    const { memoryId } = await memory(projectId).recordMemory(projectId, {
      kind: 'procedure', statement: 'delete-proof citation', authority: 3,
      evidence: [{ repositoryKey: 'repo-a', branch: 'main', baseId: 'sha_1', path: 'src/a.ts' }],
      actor: { kind: 'human', id: 'user_1' },
    });
    const evidenceHash = (await memory(projectId).getMemoryItem(projectId, memoryId))!.evidence[0]!.evidenceHash!;
    for (let i = 0; i < 3; i++) {
      await memory(projectId).acceptVerificationReport(
        projectId,
        { citations: [{ memoryItemId: memoryId, evidenceHash, state: 'missing', baseId: `sha_${i}`, branch: 'main' }], source: 'runner-report' },
        { kind: 'agent', id: 'agt_runner' },
      );
    }
    const after = await memory(projectId).getMemoryItem(projectId, memoryId);
    expect(after).not.toBeNull();
    expect(after!.evidence).toHaveLength(1);
    expect(after!.validity).toBe('invalid'); // presentation demoted...
    expect(after!.statement).toBe('delete-proof citation'); // ...but nothing is gone
  });
});

describe('POST /api/runs/:runId/verification-report — the run\'s own bound agent only', () => {
  it("accepts and applies a report from the run's own agent", async () => {
    const { projectId } = await newOwnedProject('pm-verify-rest@example.com', 'PMVREST');
    const { memoryId } = await memory(projectId).recordMemory(projectId, {
      kind: 'procedure', statement: 'run migrations with --safe-mode', authority: 3,
      evidence: [{ repositoryKey: 'repo-a', branch: 'main', baseId: 'sha_1', path: 'src/a.ts' }],
      actor: { kind: 'human', id: 'user_1' },
    });
    const evidenceHash = (await memory(projectId).getMemoryItem(projectId, memoryId))!.evidence[0]!.evidenceHash!;
    const { apiKey, runId } = await createRunAgent(projectId, 'verify', { ownerEmail: 'pm-verify-rest@example.com' });

    const res = await SELF.fetch(`https://noriq.test/api/runs/${runId}/verification-report`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ citations: [{ memoryItemId: memoryId, evidenceHash, state: 'valid', baseId: 'sha_1', branch: 'main' }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied: number; skipped: number; touchedMemoryIds: string[] };
    expect(body).toEqual({ applied: 1, skipped: 0, touchedMemoryIds: [memoryId] });

    const after = await memory(projectId).getMemoryItem(projectId, memoryId);
    expect(after!.evidence[0]!.verificationSource).toBe('runner-report');
    expect(after!.evidence[0]!.verificationState).toBe('valid');
  });

  it("refuses a report whose caller is not the target run's own bound agent", async () => {
    const { projectId } = await newOwnedProject('pm-verify-rest-wrong@example.com', 'PMVWRONG');
    const someoneElse = await createRunAgent(projectId, 'verify', { ownerEmail: 'pm-verify-rest-wrong@example.com' });
    const target = await createRunAgent(projectId, 'verify', { ownerEmail: 'pm-verify-rest-wrong@example.com' });

    const res = await SELF.fetch(`https://noriq.test/api/runs/${target.runId}/verification-report`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${someoneElse.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ citations: [{ memoryItemId: 'mem_x', evidenceHash: 'h', state: 'valid', baseId: 'sha_1', branch: 'main' }] }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a malformed report body with 400, not a 500', async () => {
    const { projectId } = await newOwnedProject('pm-verify-rest-bad@example.com', 'PMVBAD');
    const { apiKey, runId } = await createRunAgent(projectId, 'verify', { ownerEmail: 'pm-verify-rest-bad@example.com' });
    const res = await SELF.fetch(`https://noriq.test/api/runs/${runId}/verification-report`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ citations: [] }),
    });
    expect(res.status).toBe(400);
  });
});
