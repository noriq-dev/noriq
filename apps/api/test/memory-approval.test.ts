// PLNR-253: proposed-decision approval and authority promotion. Drives the ProjectMemory DO's
// RPCs directly (same technique as memory-writes.test.ts) for the versioning/atomicity
// guarantees, plus the real HTTP surface (REST approve/reject, the GitHub webhook) for the
// human-only and merge-promotion paths.
import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import type { Actor } from '../src/do/ProjectRoom';
import { createUser, mintTokenForUser, mcpCall, mcpList, loginSession, projectRoom, SYSTEM_ACTOR } from './helpers';
import worker from '../src/index';
import { buildEntityUri } from '@noriq-dev/shared';

const appEnv = env as unknown as Env;
type FetchEnv = Parameters<typeof worker.fetch>[1];

interface IndexManifestInput {
  generationId: string; projectId: string; repositoryKey: string; branch: string; baseId: string;
  indexerVersion: string; batchCount: number; fileCount: number; contentHash: string; deletions: string[]; createdAt: string;
}
interface StagedRow { kind: 'node' | 'edge'; uri?: string; type?: string; label?: string; content?: string | null; from?: string; to?: string }

interface MemoryRpc {
  health(pid: string): Promise<{ schemaVersion: number; memoryRevision: number; tableCounts: Record<string, number> }>;
  recordMemory(
    pid: string,
    input: {
      operationId?: string;
      kind: string;
      statement: string;
      evidence?: unknown[];
      supersedesMemoryId?: string | null;
      actor: { kind: string; id: string | null };
    },
  ): Promise<{ memoryId: string; operationId: string; deduped: boolean }>;
  getMemoryItem(pid: string, memoryId: string): Promise<{
    id: string; statement: string; authority: number; supersedesMemoryId: string | null; proposedAt: string | null; rejectedAt: string | null;
  } | null>;
  listProposedDecisions(pid: string): Promise<Array<{ id: string; statement: string; authority: number; proposedAt: string }>>;
  approveDecision(pid: string, input: { memoryItemId: string; actorUserId: string; note?: string | null }): Promise<{ approvedMemoryId: string; transitionId: string }>;
  rejectDecision(pid: string, input: { memoryItemId: string; actorUserId: string; note?: string | null }): Promise<{ ok: true; transitionId: string }>;
  // PLNR-266: promotion is now gated on PLNR-265's verification path — `skipped` carries a
  // reason per skipped candidate instead of a bare count.
  promoteMemoriesOnMerge(
    pid: string,
    input: { repositoryKey: string; branch: string; mergedBaseId: string },
  ): Promise<{ promoted: string[]; skipped: Array<{ memoryItemId: string; reason: string }> }>;
  drainOutbox(pid: string): Promise<{ delivered: number; failed: number }>;
  _setForceWriteFailure(pid: string, fail: boolean): Promise<void>;
  _setForceRecordedAt(pid: string, iso: string | null): Promise<void>;
  beginIndexIngest(pid: string, manifest: IndexManifestInput): Promise<{ ok: true }>;
  ingestIndexBatch(pid: string, batch: { generationId: string; batchNumber: number; batchHash: string }, rows: StagedRow[]): Promise<{ ok: true; deduped: boolean }>;
  completeIndexIngest(pid: string, generationId: string): Promise<{ ok: true; batchesReceived: number; validation: { ok: boolean; problems: string[] } }>;
  activateIndexGeneration(pid: string, generationId: string): Promise<{
    activated: string; superseded: string[]; projection: { nodesWritten: number };
  }>;
  projectActiveGeneration(pid: string, generationId: string): Promise<{ nodesWritten: number }>;
}
interface RoomRpc {
  registerRepository(pid: string, actor: Actor, repositoryKey: string): Promise<{ id: string }>;
}

const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as MemoryRpc;
const room = (pid: string) => projectRoom<RoomRpc>(pid);
const AGENT = { kind: 'agent', id: 'agt_test' };
const actor = SYSTEM_ACTOR as Actor;

function manifestFor(over: Partial<IndexManifestInput> & Pick<IndexManifestInput, 'generationId' | 'projectId' | 'repositoryKey' | 'branch' | 'baseId'>): IndexManifestInput {
  return { indexerVersion: 'v1', batchCount: 1, fileCount: 1, contentHash: 'sha256:x', deletions: [], createdAt: new Date().toISOString(), ...over };
}

/** Stage one batch and drive it all the way to a projected, active generation — same technique
 *  memory-verification.test.ts uses. Promotion (PLNR-266) verifies citations against the ACTIVE
 *  generation's graph before promoting, so a positive promotion test needs one of these covering
 *  the cited path at the merged (repositoryKey, branch, baseId). */
async function stageAndProject(projectId: string, opts: { generationId: string; repositoryKey: string; branch: string; baseId: string; rows: StagedRow[] }) {
  const m = memory(projectId);
  await m.beginIndexIngest(projectId, manifestFor({
    generationId: opts.generationId, projectId, repositoryKey: opts.repositoryKey, branch: opts.branch, baseId: opts.baseId,
    fileCount: opts.rows.filter((r) => r.kind === 'node' && r.type === 'file').length,
  }));
  await m.ingestIndexBatch(projectId, { generationId: opts.generationId, batchNumber: 0, batchHash: 'h' }, opts.rows);
  const completed = await m.completeIndexIngest(projectId, opts.generationId);
  if (!completed.validation.ok) throw new Error(`validation failed: ${completed.validation.problems.join('; ')}`);
  return (await m.activateIndexGeneration(projectId, opts.generationId)).projection;
}

async function newOwnedProject(email: string, key: string) {
  const user = await createUser(email, 'Owner', 'longenough1');
  const token = await mintTokenForUser(email);
  const cookie = await loginSession(email, 'longenough1');
  const proj = await mcpCall(token, 'create_project', { key, name: `${key} project` });
  if (proj.isError) throw new Error(`create_project(${key}) failed: ${proj.text}`);
  return { userId: user.id, token, cookie, projectId: proj.body.id as string };
}

describe('agent-recorded decisions are proposed and non-authoritative', () => {
  it('a decision recorded via recordMemory carries a non-NULL proposed marker and authority <= 2', async () => {
    const { projectId } = await newOwnedProject('pm-appr-propose@example.com', 'PMAPRPRP');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'decision', statement: 'we should use X', actor: AGENT });
    const row = await memory(projectId).getMemoryItem(projectId, memoryId);
    expect(row!.proposedAt).toBeTruthy();
    expect(row!.authority).toBeLessThanOrEqual(2);

    const proposed = await memory(projectId).listProposedDecisions(projectId);
    expect(proposed.map((p) => p.id)).toContain(memoryId);
  });

  it('a non-decision kind is never auto-proposed', async () => {
    const { projectId } = await newOwnedProject('pm-appr-nonprop@example.com', 'PMAPRNPR');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'a plain learning', actor: AGENT });
    const row = await memory(projectId).getMemoryItem(projectId, memoryId);
    expect(row!.proposedAt).toBeNull();
  });
});

describe('human approval — the only path to authority 5', () => {
  it('approves a proposed decision: new authority-5 version, original untouched, proposed cleared', async () => {
    const { projectId } = await newOwnedProject('pm-appr-approve@example.com', 'PMAPRAPV');
    const { memoryId } = await memory(projectId).recordMemory(projectId, {
      kind: 'decision',
      statement: 'adopt the retry policy',
      evidence: [{ repositoryKey: 'repo-x', branch: 'main', baseId: 'base1', path: 'README.md' }],
      actor: AGENT,
    });
    const before = await memory(projectId).getMemoryItem(projectId, memoryId);

    const { approvedMemoryId } = await memory(projectId).approveDecision(projectId, { memoryItemId: memoryId, actorUserId: 'usr_approver' });
    const approved = await memory(projectId).getMemoryItem(projectId, approvedMemoryId);
    expect(approved!.authority).toBe(5);
    expect(approved!.supersedesMemoryId).toBe(memoryId);
    expect(approved!.statement).toBe('adopt the retry policy');

    const after = await memory(projectId).getMemoryItem(projectId, memoryId);
    expect(after!.authority).toBe(before!.authority); // original's own authority column never changed
    expect(after!.statement).toBe('adopt the retry policy'); // never rewritten
    expect(after!.proposedAt).toBeNull(); // cleared — no longer pending
  });

  it('rejects a proposed decision: no new version, original stays historically visible as rejected', async () => {
    const { projectId } = await newOwnedProject('pm-appr-reject@example.com', 'PMAPRRJT');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'decision', statement: 'a bad idea', actor: AGENT });
    const { transitionId } = await memory(projectId).rejectDecision(projectId, { memoryItemId: memoryId, actorUserId: 'usr_rejecter', note: 'not viable' });
    expect(transitionId).toBeTruthy();

    const row = await memory(projectId).getMemoryItem(projectId, memoryId);
    expect(row!.proposedAt).toBeNull();
    expect(row!.rejectedAt).toBeTruthy();
    expect(row!.statement).toBe('a bad idea'); // still fully readable
  });

  it('a rejected decision can later be replaced via ordinary supersession, without erasing the rejection', async () => {
    const { projectId } = await newOwnedProject('pm-appr-replace@example.com', 'PMAPRRPL');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'decision', statement: 'first attempt', actor: AGENT });
    await memory(projectId).rejectDecision(projectId, { memoryItemId: memoryId, actorUserId: 'usr_rejecter' });

    const { memoryId: replacementId } = await memory(projectId).recordMemory(projectId, {
      kind: 'decision',
      statement: 'second attempt, corrected',
      supersedesMemoryId: memoryId,
      actor: AGENT,
    });
    const original = await memory(projectId).getMemoryItem(projectId, memoryId);
    expect(original!.rejectedAt).toBeTruthy(); // rejection still visible
    const replacement = await memory(projectId).getMemoryItem(projectId, replacementId);
    expect(replacement!.supersedesMemoryId).toBe(memoryId);
  });

  it('rejects approving/rejecting a memory that is not a pending proposed decision', async () => {
    const { projectId } = await newOwnedProject('pm-appr-notpending@example.com', 'PMAPRNPD');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'not a decision', actor: AGENT });
    await expect(memory(projectId).approveDecision(projectId, { memoryItemId: memoryId, actorUserId: 'usr_x' })).rejects.toThrow();
  });

  it('approval + revision + outbox commit atomically — an injected failure leaves nothing', async () => {
    const { projectId } = await newOwnedProject('pm-appr-atomic@example.com', 'PMAPRATM');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'decision', statement: 'atomic test', actor: AGENT });
    const before = await memory(projectId).health(projectId);

    await memory(projectId)._setForceWriteFailure(projectId, true);
    await expect(memory(projectId).approveDecision(projectId, { memoryItemId: memoryId, actorUserId: 'usr_x' })).rejects.toThrow();
    await memory(projectId)._setForceWriteFailure(projectId, false);

    const after = await memory(projectId).health(projectId);
    expect(after.memoryRevision).toBe(before.memoryRevision);
    expect(after.tableCounts.memory_items).toBe(before.tableCounts.memory_items); // no partial new version
    const row = await memory(projectId).getMemoryItem(projectId, memoryId);
    expect(row!.proposedAt).toBeTruthy(); // still pending — the clear never committed either
  });

  it('every authority transition appears exactly once in the project event stream', async () => {
    const { projectId } = await newOwnedProject('pm-appr-events@example.com', 'PMAPREVT');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'decision', statement: 'to be approved', actor: AGENT });
    await memory(projectId).approveDecision(projectId, { memoryItemId: memoryId, actorUserId: 'usr_x' });
    await memory(projectId).drainOutbox(projectId);
    const { results } = await appEnv.DB.prepare(
      "SELECT payload FROM events WHERE project_id = ? AND verb = 'memory.changed'",
    ).bind(projectId).all<{ payload: string }>();
    const transitions = results.map((r) => JSON.parse(r.payload)).filter((p) => p.entityType === 'authority_transition');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.outcome).toBe('approved');
    expect(transitions[0]!.actorKind).toBe('human');
  });
});

describe('no non-human path reaches authority 5', () => {
  it('merge promotion caps at authority 4, never 5 — even when the candidate genuinely verifies at the merged base', async () => {
    const { projectId } = await newOwnedProject('pm-appr-cap@example.com', 'PMAPRCAP');
    await room(projectId).registerRepository(projectId, actor, 'repo-cap');
    // PLNR-266: promotion now requires the citation to VERIFY at the merged base — an active
    // generation for repo-cap/main/merged-sha carrying the cited file is what makes the
    // verification gate pass, so this test isolates "caps at 4" from "verification failed".
    const fileUri = buildEntityUri({ kind: 'file', projectKey: 'PMAPRCAP', repositoryKey: 'repo-cap', path: 'a.ts' });
    await stageAndProject(projectId, {
      generationId: 'gen_cap1', repositoryKey: 'repo-cap', branch: 'main', baseId: 'merged-sha',
      rows: [{ kind: 'node', uri: fileUri, type: 'file', label: 'a.ts' }],
    });
    await memory(projectId).recordMemory(projectId, {
      kind: 'learning',
      statement: 'verified by merge',
      evidence: [{ repositoryKey: 'repo-cap', branch: 'main', baseId: 'pre-merge', path: 'a.ts' }],
      actor: AGENT,
    });
    const result = await memory(projectId).promoteMemoriesOnMerge(projectId, { repositoryKey: 'repo-cap', branch: 'main', mergedBaseId: 'merged-sha' });
    expect(result.promoted).toHaveLength(1);
    expect(result.skipped).toEqual([]);
    const promoted = await memory(projectId).getMemoryItem(projectId, result.promoted[0]!);
    expect(promoted!.authority).toBe(4);
    expect(promoted!.authority).toBeLessThan(5); // the load-bearing assertion this describe block exists for
  });
});

describe('merge promotion — verification against the merged repository/branch (PLNR-266)', () => {
  it('does not promote when cited evidence is for a DIFFERENT repository', async () => {
    const { projectId } = await newOwnedProject('pm-appr-nomatch@example.com', 'PMAPRNMT');
    await memory(projectId).recordMemory(projectId, {
      kind: 'learning',
      statement: 'cites a different repo',
      evidence: [{ repositoryKey: 'repo-other', branch: 'main', baseId: 'x', path: 'a.ts' }],
      actor: AGENT,
    });
    const result = await memory(projectId).promoteMemoriesOnMerge(projectId, { repositoryKey: 'repo-cap', branch: 'main', mergedBaseId: 'merged-sha' });
    expect(result.promoted).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toMatch(/different repository or branch/);
  });

  it('does not promote a memory with no evidence at all — skipped with its own reason', async () => {
    const { projectId } = await newOwnedProject('pm-appr-noev@example.com', 'PMAPRNEV');
    await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'unevidenced', actor: AGENT });
    const result = await memory(projectId).promoteMemoriesOnMerge(projectId, { repositoryKey: 'repo-cap', branch: 'main', mergedBaseId: 'merged-sha' });
    expect(result.promoted).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toMatch(/no repository evidence/);
  });

  it('does not re-promote something already at or above authority 4', async () => {
    const { projectId } = await newOwnedProject('pm-appr-already@example.com', 'PMAPRALR');
    await memory(projectId).recordMemory(projectId, {
      kind: 'decision',
      statement: 'already human-approved',
      evidence: [{ repositoryKey: 'repo-cap', branch: 'main', baseId: 'x', path: 'a.ts' }],
      actor: AGENT,
    });
    const proposed = (await memory(projectId).listProposedDecisions(projectId))[0]!;
    const { approvedMemoryId } = await memory(projectId).approveDecision(projectId, { memoryItemId: proposed.id, actorUserId: 'usr_x' });
    const result = await memory(projectId).promoteMemoriesOnMerge(projectId, { repositoryKey: 'repo-cap', branch: 'main', mergedBaseId: 'merged-sha' });
    expect(result.promoted).not.toContain(approvedMemoryId);
  });

  it("promotes a memory whose citations VERIFY at the merged base — the stated acceptance's positive case", async () => {
    const { projectId } = await newOwnedProject('pm-appr-verifies@example.com', 'PMAPRVFY');
    const fileUri = buildEntityUri({ kind: 'file', projectKey: 'PMAPRVFY', repositoryKey: 'repo-v', path: 'lib/thing.ts' });
    await stageAndProject(projectId, {
      generationId: 'gen_v1', repositoryKey: 'repo-v', branch: 'main', baseId: 'merged-sha-v',
      rows: [{ kind: 'node', uri: fileUri, type: 'file', label: 'thing.ts' }],
    });
    const { memoryId } = await memory(projectId).recordMemory(projectId, {
      kind: 'learning',
      statement: 'the thing lives in lib/thing.ts',
      evidence: [{ repositoryKey: 'repo-v', branch: 'main', baseId: 'old-sha', path: 'lib/thing.ts' }],
      actor: AGENT,
    });
    const result = await memory(projectId).promoteMemoriesOnMerge(projectId, { repositoryKey: 'repo-v', branch: 'main', mergedBaseId: 'merged-sha-v' });
    expect(result.promoted).toEqual([expect.any(String)]);
    expect(result.skipped).toEqual([]);
    const promoted = await memory(projectId).getMemoryItem(projectId, result.promoted[0]!);
    expect(promoted!.authority).toBe(4);
    expect(promoted!.supersedesMemoryId).toBe(memoryId);
    // The superseded original is still fully readable with its own (lower) authority intact.
    const original = await memory(projectId).getMemoryItem(projectId, memoryId);
    expect(original).not.toBeNull();
    expect(original!.statement).toBe('the thing lives in lib/thing.ts');
  });

  it("does NOT promote an otherwise-identical memory whose citations do NOT verify at the merged base — matches the repository/branch but the file simply isn't in that generation's graph", async () => {
    const { projectId } = await newOwnedProject('pm-appr-noverify@example.com', 'PMAPRNVF');
    // An active generation exists for repo-v/main/merged-sha-v (something real to check
    // against), but it projects no node for the cited path — same shape as memory-
    // verification.test.ts's "missing" case, just reached through the promotion path instead.
    await stageAndProject(projectId, {
      generationId: 'gen_nv1', repositoryKey: 'repo-v', branch: 'main', baseId: 'merged-sha-v', rows: [],
    });
    await memory(projectId).recordMemory(projectId, {
      kind: 'learning',
      statement: 'the thing lives in lib/gone.ts',
      evidence: [{ repositoryKey: 'repo-v', branch: 'main', baseId: 'old-sha', path: 'lib/gone.ts' }],
      actor: AGENT,
    });
    const result = await memory(projectId).promoteMemoriesOnMerge(projectId, { repositoryKey: 'repo-v', branch: 'main', mergedBaseId: 'merged-sha-v' });
    expect(result.promoted).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toMatch(/do not verify at the merged base/);
  });

  it('citations verified at a DIFFERENT base than the one just merged are skipped, not promoted — merge alone never promotes unsupported claims', async () => {
    const { projectId } = await newOwnedProject('pm-appr-stalebase@example.com', 'PMAPRSTB');
    const fileUri = buildEntityUri({ kind: 'file', projectKey: 'PMAPRSTB', repositoryKey: 'repo-v', path: 'lib/thing.ts' });
    // The active generation is for an OLDER base — a prior merge, not the one this call names.
    await stageAndProject(projectId, {
      generationId: 'gen_old1', repositoryKey: 'repo-v', branch: 'main', baseId: 'older-sha',
      rows: [{ kind: 'node', uri: fileUri, type: 'file', label: 'thing.ts' }],
    });
    await memory(projectId).recordMemory(projectId, {
      kind: 'learning',
      statement: 'the thing lives in lib/thing.ts',
      evidence: [{ repositoryKey: 'repo-v', branch: 'main', baseId: 'ancient-sha', path: 'lib/thing.ts' }],
      actor: AGENT,
    });
    const result = await memory(projectId).promoteMemoriesOnMerge(projectId, { repositoryKey: 'repo-v', branch: 'main', mergedBaseId: 'brand-new-sha' });
    expect(result.promoted).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain('brand-new-sha');
  });
});

describe('approve/reject exist only under userAuth REST — no MCP tool reaches them', () => {
  it('tools/list contains no approve/reject-shaped memory tool', async () => {
    const { token } = await newOwnedProject('pm-appr-notool@example.com', 'PMAPRNTL');
    const tools = await mcpList(token);
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('approve_decision');
    expect(names).not.toContain('reject_decision');
    expect(names.some((n) => /approve|reject/i.test(n))).toBe(false);
  });

  it('a human can list, approve, and reject over REST', async () => {
    const { cookie, projectId } = await newOwnedProject('pm-appr-rest@example.com', 'PMAPRRST');
    const { memoryId: toApprove } = await memory(projectId).recordMemory(projectId, { kind: 'decision', statement: 'approve me', actor: AGENT });
    const { memoryId: toReject } = await memory(projectId).recordMemory(projectId, { kind: 'decision', statement: 'reject me', actor: AGENT });

    const list = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/memory/proposed-decisions`, { headers: { Cookie: cookie } });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { decisions: Array<{ id: string }> };
    expect(listBody.decisions.map((d) => d.id).sort()).toEqual([toApprove, toReject].sort());

    const approveRes = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/memory/items/${toApprove}/approve`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'looks good' }),
    });
    expect(approveRes.status).toBe(200);

    const rejectRes = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/memory/items/${toReject}/reject`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(rejectRes.status).toBe(200);

    const afterList = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/memory/proposed-decisions`, { headers: { Cookie: cookie } });
    const afterBody = (await afterList.json()) as { decisions: unknown[] };
    expect(afterBody.decisions).toHaveLength(0); // both decided, neither still pending
  });
});

describe('GitHub webhook triggers merge promotion end to end', () => {
  const secret = 'wh-secret-appr-test';
  async function signature(payload: string): Promise<string> {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    return 'sha256=' + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function sendWebhook(payload: string) {
    const ctx = createExecutionContext();
    const sig = await signature(payload);
    const req = new Request('https://noriq.test/api/webhooks/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'pull_request', 'X-Hub-Signature-256': sig },
      body: payload,
    });
    const res = await worker.fetch(req, { ...appEnv, GITHUB_WEBHOOK_SECRET: secret } as unknown as FetchEnv, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("promotes memory whose evidence matches the project's single registered repository/branch AND verifies at the merged commit", async () => {
    const { token, projectId } = await newOwnedProject('pm-appr-webhook@example.com', 'PMAPRWHK');
    await room(projectId).registerRepository(projectId, actor, 'repo-wh');
    const task = await mcpCall(token, 'create_task', { projectId, title: 'ship it', tags: ['memory-approval-test'], allowNewTags: true });
    if (task.isError) throw new Error(`create_task failed: ${task.text}`);
    await memory(projectId).recordMemory(projectId, {
      kind: 'learning',
      statement: 'the fix lives in lib/x.ts',
      evidence: [{ repositoryKey: 'repo-wh', branch: 'main', baseId: 'old-sha', path: 'lib/x.ts' }],
      actor: AGENT,
    });
    // PLNR-266: the webhook hands promoteMemoriesOnMerge the PR's merge_commit_sha as the
    // verification base — an active generation must already cover it (indexing has caught up
    // to the merge by the time this runs, in the real flow) for the citation to verify.
    const fileUri = buildEntityUri({ kind: 'file', projectKey: 'PMAPRWHK', repositoryKey: 'repo-wh', path: 'lib/x.ts' });
    await stageAndProject(projectId, {
      generationId: 'gen_wh1', repositoryKey: 'repo-wh', branch: 'main', baseId: 'new-merged-sha',
      rows: [{ kind: 'node', uri: fileUri, type: 'file', label: 'x.ts' }],
    });
    const beforeCount = (await memory(projectId).health(projectId)).tableCounts.memory_items;

    const payload = JSON.stringify({
      pull_request: {
        title: 'PMAPRWHK-1 ship it', number: 9, state: 'closed', merged: true,
        html_url: 'https://gh/pr/9', head: { ref: 'feat/x' }, base: { ref: 'main' }, merge_commit_sha: 'new-merged-sha',
      },
    });
    const res = await sendWebhook(payload);
    expect(res.status).toBe(200);

    // Promotion runs inline within the webhook handler (best-effort, but awaited before the
    // response is sent) — no polling needed, unlike the fire-and-forget deletion paths elsewhere.
    const afterCount = (await memory(projectId).health(projectId)).tableCounts.memory_items;
    expect(afterCount).toBe((beforeCount ?? 0) + 1);
  });

  it('does NOT promote via the webhook when the merged commit has no verifying index generation yet', async () => {
    const { token, projectId } = await newOwnedProject('pm-appr-webhook-unverified@example.com', 'PMAPRWUV');
    await room(projectId).registerRepository(projectId, actor, 'repo-whu');
    const task = await mcpCall(token, 'create_task', { projectId, title: 'ship it unverified', tags: ['memory-approval-test'], allowNewTags: true });
    if (task.isError) throw new Error(`create_task failed: ${task.text}`);
    await memory(projectId).recordMemory(projectId, {
      kind: 'learning',
      statement: 'the fix lives in lib/z.ts',
      evidence: [{ repositoryKey: 'repo-whu', branch: 'main', baseId: 'old-sha', path: 'lib/z.ts' }],
      actor: AGENT,
    });
    const beforeCount = (await memory(projectId).health(projectId)).tableCounts.memory_items;

    // No index generation staged at all this time — indexing has not caught up to the merge.
    const payload = JSON.stringify({
      pull_request: {
        title: 'PMAPRWUV-1 ship it unverified', number: 11, state: 'closed', merged: true,
        html_url: 'https://gh/pr/11', head: { ref: 'feat/z' }, base: { ref: 'main' }, merge_commit_sha: 'unverified-sha',
      },
    });
    const res = await sendWebhook(payload);
    expect(res.status).toBe(200);

    const afterCount = (await memory(projectId).health(projectId)).tableCounts.memory_items;
    expect(afterCount).toBe(beforeCount); // merge evidence alone never promotes an unsupported claim
  });

  it('does NOT promote when the project has no single registered repository to correlate against', async () => {
    const { token, projectId } = await newOwnedProject('pm-appr-webhook-noreg@example.com', 'PMAPRWNR');
    const task = await mcpCall(token, 'create_task', { projectId, title: 'ship it too', tags: ['memory-approval-test'], allowNewTags: true });
    if (task.isError) throw new Error(`create_task failed: ${task.text}`);
    await memory(projectId).recordMemory(projectId, {
      kind: 'learning',
      statement: 'unregistered repo evidence',
      evidence: [{ repositoryKey: 'repo-unregistered', branch: 'main', baseId: 'old-sha', path: 'lib/y.ts' }],
      actor: AGENT,
    });
    const beforeCount = (await memory(projectId).health(projectId)).tableCounts.memory_items;

    const payload = JSON.stringify({
      pull_request: {
        title: 'PMAPRWNR-1 ship it too', number: 10, state: 'closed', merged: true,
        html_url: 'https://gh/pr/10', head: { ref: 'feat/y' }, base: { ref: 'main' }, merge_commit_sha: 'sha-2',
      },
    });
    const res = await sendWebhook(payload);
    expect(res.status).toBe(200);

    const afterCount = (await memory(projectId).health(projectId)).tableCounts.memory_items;
    expect(afterCount).toBe(beforeCount); // no registered repo to correlate against — left alone
  });
});

// PLNR-312: getMemoryHistory had NO coverage at all — not the DO method, not the route, not the
// UI path — and shipped 500ing for every memory in production ("Wrong number of parameter
// bindings for SQL query"): `placeholders` is numbered (`?1,…,?N`) and was reused in two IN
// clauses while `idList` was spread TWICE, declaring N parameters and binding 2N. These drive the
// real HTTP surface, so the route and the DO query are both covered.
describe('memory history (PLNR-271 surface, PLNR-312 regression)', () => {
  it('returns 200 for a lone memory with no supersession chain — the everyday case that 500d', async () => {
    const { cookie, projectId } = await newOwnedProject('pm-hist-lone@example.com', 'PMHISTLN');
    const { memoryId } = await memory(projectId).recordMemory(projectId, {
      kind: 'learning', statement: 'a lone memory, superseding nothing', actor: AGENT,
    });

    const res = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/memory/items/${memoryId}/history`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200); // pre-fix: 500, one `?1` declared against two bindings
    const body = (await res.json()) as {
      versions: Array<{ id: string; supersedesMemoryId: string | null; supersededByMemoryId: string | null }>;
      transitions: unknown[]; contradictions: unknown[]; feedback: unknown[];
    };
    expect(body.versions.map((v) => v.id)).toEqual([memoryId]);
    const [only] = body.versions;
    expect(only?.supersedesMemoryId).toBeNull();
    expect(only?.supersededByMemoryId).toBeNull();
    expect(body.transitions).toEqual([]);
    expect(body.contradictions).toEqual([]);
    expect(body.feedback).toEqual([]);
  });

  it('returns the whole chain, oldest first, from either end of a supersession', async () => {
    const { cookie, projectId } = await newOwnedProject('pm-hist-chain@example.com', 'PMHISTCH');
    const { memoryId: original } = await memory(projectId).recordMemory(projectId, {
      kind: 'learning', statement: 'the original claim', actor: AGENT,
    });
    const { memoryId: correction } = await memory(projectId).recordMemory(projectId, {
      kind: 'learning', statement: 'the corrected claim', supersedesMemoryId: original, actor: AGENT,
    });

    // Reachable from the NEW id (walks back) and from the OLD id (walks forward) — the traversal
    // seeds from whichever end the caller happens to hold.
    for (const seed of [original, correction]) {
      const res = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/memory/items/${seed}/history`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        versions: Array<{ id: string; supersedesMemoryId: string | null; supersededByMemoryId: string | null }>;
      };
      expect(body.versions.map((v) => v.id)).toEqual([original, correction]); // ORDER BY recorded_at
      const [older, newer] = body.versions;
      expect(older?.supersededByMemoryId).toBe(correction);
      expect(newer?.supersedesMemoryId).toBe(original);
    }
  });

  it('orders a chain oldest-first even when both versions land in the SAME millisecond (PLNR-323)', async () => {
    // The original flake needed real CPU contention to land two `recordMemory` calls in the same
    // millisecond — occasional, not reproducible on demand. `_setForceRecordedAt` pins the clock
    // so the tie happens on every run. (Verified empirically: this exact tie alone does NOT
    // reproduce wrong ordering against the pre-fix `ORDER BY recorded_at` in this harness — a
    // fresh two-row table's scan/sort here happens to preserve insertion order, and insertion
    // order is FK-forced correct for a supersession pair since the superseded row must already
    // exist. The real flake needed genuine multi-shard resource contention this test cannot
    // manufacture. Kept anyway as a literal regression test of the reported symptom and to lock
    // in full SQL-level determinism; the test below is the one that actually falsifies a
    // recorded_at-based fix.)
    const { cookie, projectId } = await newOwnedProject('pm-hist-tie@example.com', 'PMHISTTI');
    const m = memory(projectId);
    const tiedInstant = '2026-01-01T00:00:00.000Z';
    await m._setForceRecordedAt(projectId, tiedInstant);
    let original: string, correction: string;
    try {
      ({ memoryId: original } = await m.recordMemory(projectId, {
        kind: 'learning', statement: 'the original claim, clock pinned', actor: AGENT,
      }));
      ({ memoryId: correction } = await m.recordMemory(projectId, {
        kind: 'learning', statement: 'the corrected claim, clock pinned', supersedesMemoryId: original, actor: AGENT,
      }));
    } finally {
      await m._setForceRecordedAt(projectId, null); // restore the real clock
    }

    for (const seed of [original, correction]) {
      const res = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/memory/items/${seed}/history`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        versions: Array<{ id: string; recordedAt: string; supersedesMemoryId: string | null; supersededByMemoryId: string | null }>;
      };
      // Prove the tie actually landed — otherwise this test would pass even against the old,
      // tiebreaker-free `ORDER BY recorded_at` and demonstrate nothing.
      expect(body.versions.map((v) => v.recordedAt)).toEqual([tiedInstant, tiedInstant]);
      expect(body.versions.map((v) => v.id)).toEqual([original, correction]);
      const [older, newer] = body.versions;
      expect(older?.supersededByMemoryId).toBe(correction);
      expect(newer?.supersedesMemoryId).toBe(original);
    }
  });

  it('orders a chain oldest-first from the supersession graph, not recorded_at, even when the clock reads backwards (PLNR-323)', async () => {
    // The stronger, actually-falsifying version of the test above: force the CORRECTION's
    // recorded_at to read EARLIER than the ORIGINAL's. Any fix that sorts by recorded_at — with
    // or without a tiebreaker column — gets this backwards every single time; only a fix that
    // orders from the supersedes_memory_id graph itself (a version can never precede what it
    // supersedes) gets it right. This is what makes the ordering "genuinely total": correct
    // because of the chain's structure, not because of who happened to win a coin flip on a tied
    // millisecond.
    const { cookie, projectId } = await newOwnedProject('pm-hist-skew@example.com', 'PMHISTSK');
    const m = memory(projectId);
    let original: string, correction: string;
    try {
      await m._setForceRecordedAt(projectId, '2026-01-01T00:00:00.900Z');
      ({ memoryId: original } = await m.recordMemory(projectId, {
        kind: 'learning', statement: 'the original claim, clock reads LATER', actor: AGENT,
      }));
      await m._setForceRecordedAt(projectId, '2026-01-01T00:00:00.100Z');
      ({ memoryId: correction } = await m.recordMemory(projectId, {
        kind: 'learning', statement: 'the corrected claim, clock reads EARLIER', supersedesMemoryId: original, actor: AGENT,
      }));
    } finally {
      await m._setForceRecordedAt(projectId, null);
    }

    for (const seed of [original, correction]) {
      const res = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/memory/items/${seed}/history`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        versions: Array<{ id: string; recordedAt: string; supersedesMemoryId: string | null; supersededByMemoryId: string | null }>;
      };
      // Confirm the clock really does read backwards — otherwise this test proves nothing either.
      const originalRecordedAt = body.versions.find((v) => v.id === original)?.recordedAt;
      const correctionRecordedAt = body.versions.find((v) => v.id === correction)?.recordedAt;
      expect(originalRecordedAt).toBeTruthy();
      expect(correctionRecordedAt).toBeTruthy();
      expect(originalRecordedAt! > correctionRecordedAt!).toBe(true);
      expect(body.versions.map((v) => v.id)).toEqual([original, correction]); // still oldest-first
      const [older, newer] = body.versions;
      expect(older?.supersededByMemoryId).toBe(correction);
      expect(newer?.supersedesMemoryId).toBe(original);
    }
  });

  it('404s an unknown memory id rather than 500ing', async () => {
    const { cookie, projectId } = await newOwnedProject('pm-hist-404@example.com', 'PMHIST44');
    const res = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/memory/items/mem_does_not_exist/history`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(404);
  });
});
