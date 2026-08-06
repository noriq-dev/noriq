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

const appEnv = env as unknown as Env;
type FetchEnv = Parameters<typeof worker.fetch>[1];

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
  promoteMemoriesOnMerge(pid: string, input: { repositoryKey: string; branch: string; mergedBaseId: string }): Promise<{ promoted: string[]; skipped: number }>;
  drainOutbox(pid: string): Promise<{ delivered: number; failed: number }>;
  _setForceWriteFailure(pid: string, fail: boolean): Promise<void>;
}
interface RoomRpc {
  registerRepository(pid: string, actor: Actor, repositoryKey: string): Promise<{ id: string }>;
}

const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as MemoryRpc;
const room = (pid: string) => projectRoom<RoomRpc>(pid);
const AGENT = { kind: 'agent', id: 'agt_test' };
const actor = SYSTEM_ACTOR as Actor;

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
  it('merge promotion caps at authority 4, never 5', async () => {
    const { projectId } = await newOwnedProject('pm-appr-cap@example.com', 'PMAPRCAP');
    await room(projectId).registerRepository(projectId, actor, 'repo-cap');
    await memory(projectId).recordMemory(projectId, {
      kind: 'learning',
      statement: 'verified by merge',
      evidence: [{ repositoryKey: 'repo-cap', branch: 'main', baseId: 'pre-merge', path: 'a.ts' }],
      actor: AGENT,
    });
    const result = await memory(projectId).promoteMemoriesOnMerge(projectId, { repositoryKey: 'repo-cap', branch: 'main', mergedBaseId: 'merged-sha' });
    expect(result.promoted).toHaveLength(1);
    const promoted = await memory(projectId).getMemoryItem(projectId, result.promoted[0]!);
    expect(promoted!.authority).toBe(4);
  });
});

describe('merge promotion — verification against the merged repository/branch', () => {
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
    expect(result.skipped).toBe(1);
  });

  it('does not promote a memory with no evidence at all', async () => {
    const { projectId } = await newOwnedProject('pm-appr-noev@example.com', 'PMAPRNEV');
    await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'unevidenced', actor: AGENT });
    const result = await memory(projectId).promoteMemoriesOnMerge(projectId, { repositoryKey: 'repo-cap', branch: 'main', mergedBaseId: 'merged-sha' });
    expect(result.promoted).toHaveLength(0);
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

  it("promotes memory whose evidence matches the project's single registered repository/branch", async () => {
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
