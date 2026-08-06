// PLNR-254: feedback, stale/invalid validity transitions, and bounded decay/retention. Drives
// the ProjectMemory DO's RPCs directly (same technique as memory-writes.test.ts) plus the
// lifecycle sweep entry point (same technique as memory-lifecycle.test.ts).
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { createUser, mintTokenForUser, mcpCall } from './helpers';
import { sweepProjectDebris, MEMORY_HYPOTHESIS_DECAY_MAX_AGE_MS, MEMORY_HYPOTHESIS_DECAY_AUTHORITY_CEILING } from '../src/memory/lifecycle';

const appEnv = env as unknown as Env;

interface MemoryRpc {
  health(pid: string): Promise<{ schemaVersion: number; memoryRevision: number; tableCounts: Record<string, number> }>;
  recordMemory(
    pid: string,
    input: {
      kind: string;
      statement: string;
      authority?: number;
      evidence?: unknown[];
      supersedesMemoryId?: string | null;
      actor: { kind: string; id: string | null };
    },
  ): Promise<{ memoryId: string }>;
  getMemoryItem(pid: string, memoryId: string): Promise<{
    id: string;
    statement: string;
    authority: number;
    validity: string;
    evidence: Array<{ verificationState: string }>;
  } | null>;
  recordFeedback(
    pid: string,
    input: { operationId?: string; memoryItemId: string; vote?: 'up' | 'down'; kind?: string; reason?: string | null; actor: { kind: string; id: string | null } },
  ): Promise<{ feedbackId: string }>;
  transitionMemoryValidity(
    pid: string,
    input: { memoryItemId: string; validity: 'active' | 'stale' | 'invalid'; reason?: string | null; actor: { kind: string; id: string | null } },
  ): Promise<{ ok: true }>;
  decayLowAuthorityMemories(pid: string, input: { maxAgeMs: number; authorityCeiling: number }): Promise<{ decayed: string[] }>;
  approveDecision(pid: string, input: { memoryItemId: string; actorUserId: string }): Promise<{ approvedMemoryId: string }>;
  promoteMemoriesOnMerge(pid: string, input: { repositoryKey: string; branch: string; mergedBaseId: string }): Promise<{ promoted: string[] }>;
  exportSnapshot(pid: string): Promise<{ ok: true; manifest: { exportedAt: string } } | { ok: false; reason: string }>;
  restoreSnapshot(pid: string, opts: { exportedAt: string }): Promise<{ ok: true } | { ok: false; reason: string }>;
  drainOutbox(pid: string): Promise<{ delivered: number; failed: number }>;
  _setMemoryRecordedAtForTest(pid: string, memoryId: string, recordedAt: string): Promise<void>;
}

const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as MemoryRpc;
const AGENT = { kind: 'agent', id: 'agt_test' };

async function newOwnedProject(email: string, key: string) {
  const user = await createUser(email, 'Owner', 'longenough1');
  const token = await mintTokenForUser(email);
  const proj = await mcpCall(token, 'create_project', { key, name: `${key} project` });
  if (proj.isError) throw new Error(`create_project(${key}) failed: ${proj.text}`);
  return { userId: user.id, token, projectId: proj.body.id as string };
}

const old = () => new Date(Date.now() - MEMORY_HYPOTHESIS_DECAY_MAX_AGE_MS - 1000).toISOString();

describe('recordFeedback — the five-kind vocabulary', () => {
  it('all five kinds record successfully', async () => {
    const { projectId } = await newOwnedProject('pm-maint-kinds@example.com', 'PMMNTKND');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'a learning', actor: AGENT });
    for (const kind of ['useful', 'incorrect', 'outdated', 'harmful', 'unverifiable']) {
      const res = await memory(projectId).recordFeedback(projectId, { memoryItemId: memoryId, kind, actor: AGENT });
      expect(res.feedbackId).toBeTruthy();
    }
  });

  it('feedback leaves the target statement, evidence, and authority byte-identical', async () => {
    const { projectId } = await newOwnedProject('pm-maint-immut@example.com', 'PMMNTIMM');
    const { memoryId } = await memory(projectId).recordMemory(projectId, {
      kind: 'learning',
      statement: 'unchanged by feedback',
      evidence: [{ repositoryKey: 'repo-x', branch: 'main', baseId: 'base1', path: 'a.ts' }],
      actor: AGENT,
    });
    const before = await memory(projectId).getMemoryItem(projectId, memoryId);
    await memory(projectId).recordFeedback(projectId, { memoryItemId: memoryId, kind: 'incorrect', reason: 'this is wrong', actor: AGENT });
    const after = await memory(projectId).getMemoryItem(projectId, memoryId);
    expect(after!.statement).toBe(before!.statement);
    expect(after!.authority).toBe(before!.authority);
    expect(after!.evidence).toEqual(before!.evidence);
  });

  it('a correction is a NEW version via supersedesMemoryId, never an edit of the original', async () => {
    const { projectId } = await newOwnedProject('pm-maint-correct@example.com', 'PMMNTCOR');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'the wrong claim', actor: AGENT });
    await memory(projectId).recordFeedback(projectId, { memoryItemId: memoryId, kind: 'incorrect', actor: AGENT });
    const { memoryId: correctedId } = await memory(projectId).recordMemory(projectId, {
      kind: 'learning',
      statement: 'the corrected claim',
      supersedesMemoryId: memoryId,
      actor: AGENT,
    });
    const original = await memory(projectId).getMemoryItem(projectId, memoryId);
    expect(original!.statement).toBe('the wrong claim'); // untouched
    const corrected = await memory(projectId).getMemoryItem(projectId, correctedId);
    expect(corrected!.statement).toBe('the corrected claim');
  });

  it('accepts a bare up/down vote unchanged (0001 backward compatibility)', async () => {
    const { projectId } = await newOwnedProject('pm-maint-vote@example.com', 'PMMNTVOT');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'votable', actor: AGENT });
    const res = await memory(projectId).recordFeedback(projectId, { memoryItemId: memoryId, vote: 'up', actor: AGENT });
    expect(res.feedbackId).toBeTruthy();
  });
});

describe('transitionMemoryValidity — stale/invalid without erasing history', () => {
  it('a memory transitioned to stale is still fully retrievable, and per-evidence verificationState is unchanged', async () => {
    const { projectId } = await newOwnedProject('pm-maint-stale@example.com', 'PMMNTSTL');
    const { memoryId } = await memory(projectId).recordMemory(projectId, {
      kind: 'learning',
      statement: 'may be stale now',
      evidence: [{ repositoryKey: 'repo-x', branch: 'main', baseId: 'base1', path: 'a.ts' }],
      actor: AGENT,
    });
    const before = await memory(projectId).getMemoryItem(projectId, memoryId);
    expect(before!.evidence[0]!.verificationState).toBe('unverifiable'); // 0001 default

    await memory(projectId).transitionMemoryValidity(projectId, { memoryItemId: memoryId, validity: 'stale', reason: 'file moved', actor: AGENT });
    const after = await memory(projectId).getMemoryItem(projectId, memoryId);
    expect(after!.validity).toBe('stale');
    expect(after!.statement).toBe('may be stale now'); // history intact
    expect(after!.evidence[0]!.verificationState).toBe('unverifiable'); // untouched by the memory-level transition
  });

  it('transitions to invalid and back to active without losing anything', async () => {
    const { projectId } = await newOwnedProject('pm-maint-invalid@example.com', 'PMMNTINV');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'flip-flopping validity', actor: AGENT });
    await memory(projectId).transitionMemoryValidity(projectId, { memoryItemId: memoryId, validity: 'invalid', actor: AGENT });
    expect((await memory(projectId).getMemoryItem(projectId, memoryId))!.validity).toBe('invalid');
    await memory(projectId).transitionMemoryValidity(projectId, { memoryItemId: memoryId, validity: 'active', actor: AGENT });
    const row = await memory(projectId).getMemoryItem(projectId, memoryId);
    expect(row!.validity).toBe('active');
    expect(row!.statement).toBe('flip-flopping validity');
  });
});

describe('decayLowAuthorityMemories — bounded, policy-driven, reversible from backup', () => {
  it('decays an old, unused, authority-1 hypothesis', async () => {
    const { projectId } = await newOwnedProject('pm-maint-decay@example.com', 'PMMNTDCY');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'an old unused hypothesis', actor: AGENT });
    await memory(projectId)._setMemoryRecordedAtForTest(projectId, memoryId, old());

    const result = await memory(projectId).decayLowAuthorityMemories(projectId, {
      maxAgeMs: MEMORY_HYPOTHESIS_DECAY_MAX_AGE_MS,
      authorityCeiling: MEMORY_HYPOTHESIS_DECAY_AUTHORITY_CEILING,
    });
    expect(result.decayed).toContain(memoryId);
    expect(await memory(projectId).getMemoryItem(projectId, memoryId)).toBeNull();
  });

  it('never decays a memory that has received any feedback — feedback IS usage', async () => {
    const { projectId } = await newOwnedProject('pm-maint-decay-fb@example.com', 'PMMNTDFB');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'old but used', actor: AGENT });
    await memory(projectId)._setMemoryRecordedAtForTest(projectId, memoryId, old());
    await memory(projectId).recordFeedback(projectId, { memoryItemId: memoryId, vote: 'up', actor: AGENT });

    const result = await memory(projectId).decayLowAuthorityMemories(projectId, {
      maxAgeMs: MEMORY_HYPOTHESIS_DECAY_MAX_AGE_MS,
      authorityCeiling: MEMORY_HYPOTHESIS_DECAY_AUTHORITY_CEILING,
    });
    expect(result.decayed).not.toContain(memoryId);
    expect(await memory(projectId).getMemoryItem(projectId, memoryId)).not.toBeNull();
  });

  it('never decays an authority-5 human-approved decision, even when old', async () => {
    const { projectId } = await newOwnedProject('pm-maint-decay-appr@example.com', 'PMMNTDAP');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'decision', statement: 'proposed then approved', actor: AGENT });
    const { approvedMemoryId } = await memory(projectId).approveDecision(projectId, { memoryItemId: memoryId, actorUserId: 'usr_x' });
    await memory(projectId)._setMemoryRecordedAtForTest(projectId, approvedMemoryId, old());
    await memory(projectId)._setMemoryRecordedAtForTest(projectId, memoryId, old());

    const result = await memory(projectId).decayLowAuthorityMemories(projectId, {
      maxAgeMs: MEMORY_HYPOTHESIS_DECAY_MAX_AGE_MS,
      authorityCeiling: MEMORY_HYPOTHESIS_DECAY_AUTHORITY_CEILING,
    });
    expect(result.decayed).not.toContain(approvedMemoryId); // authority 5, excluded by the ceiling itself
    expect(result.decayed).not.toContain(memoryId); // the ORIGINAL is part of approval history — excluded
    expect(await memory(projectId).getMemoryItem(projectId, approvedMemoryId)).not.toBeNull();
    expect(await memory(projectId).getMemoryItem(projectId, memoryId)).not.toBeNull();
  });

  it('never decays an authority-4 merge-promoted memory or the original it superseded', async () => {
    const { projectId } = await newOwnedProject('pm-maint-decay-merge@example.com', 'PMMNTDMG');
    const { memoryId } = await memory(projectId).recordMemory(projectId, {
      kind: 'learning',
      statement: 'verified by merge',
      evidence: [{ repositoryKey: 'repo-merge', branch: 'main', baseId: 'pre', path: 'a.ts' }],
      actor: AGENT,
    });
    const { promoted } = await memory(projectId).promoteMemoriesOnMerge(projectId, { repositoryKey: 'repo-merge', branch: 'main', mergedBaseId: 'post' });
    const promotedId = promoted[0]!;
    await memory(projectId)._setMemoryRecordedAtForTest(projectId, promotedId, old());
    await memory(projectId)._setMemoryRecordedAtForTest(projectId, memoryId, old());

    const result = await memory(projectId).decayLowAuthorityMemories(projectId, {
      maxAgeMs: MEMORY_HYPOTHESIS_DECAY_MAX_AGE_MS,
      authorityCeiling: MEMORY_HYPOTHESIS_DECAY_AUTHORITY_CEILING,
    });
    expect(result.decayed).not.toContain(promotedId);
    expect(result.decayed).not.toContain(memoryId);
  });

  it('never decays a memory that has been superseded by anything', async () => {
    const { projectId } = await newOwnedProject('pm-maint-decay-super@example.com', 'PMMNTDSP');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'superseded original', actor: AGENT });
    await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'the replacement', supersedesMemoryId: memoryId, actor: AGENT });
    await memory(projectId)._setMemoryRecordedAtForTest(projectId, memoryId, old());

    const result = await memory(projectId).decayLowAuthorityMemories(projectId, {
      maxAgeMs: MEMORY_HYPOTHESIS_DECAY_MAX_AGE_MS,
      authorityCeiling: MEMORY_HYPOTHESIS_DECAY_AUTHORITY_CEILING,
    });
    expect(result.decayed).not.toContain(memoryId); // it is superseded-version history, not a cache entry
  });

  it('does not decay a fresh (not-yet-old) hypothesis', async () => {
    const { projectId } = await newOwnedProject('pm-maint-decay-fresh@example.com', 'PMMNTDFR');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'brand new', actor: AGENT });
    const result = await memory(projectId).decayLowAuthorityMemories(projectId, {
      maxAgeMs: MEMORY_HYPOTHESIS_DECAY_MAX_AGE_MS,
      authorityCeiling: MEMORY_HYPOTHESIS_DECAY_AUTHORITY_CEILING,
    });
    expect(result.decayed).not.toContain(memoryId);
  });

  it('emits one audit event through the outbox carrying no memory body', async () => {
    const { projectId } = await newOwnedProject('pm-maint-decay-audit@example.com', 'PMMNTDAU');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'to be decayed and audited', actor: AGENT });
    await memory(projectId)._setMemoryRecordedAtForTest(projectId, memoryId, old());
    await memory(projectId).decayLowAuthorityMemories(projectId, {
      maxAgeMs: MEMORY_HYPOTHESIS_DECAY_MAX_AGE_MS,
      authorityCeiling: MEMORY_HYPOTHESIS_DECAY_AUTHORITY_CEILING,
    });
    await memory(projectId).drainOutbox(projectId);
    const { results } = await appEnv.DB.prepare("SELECT payload FROM events WHERE project_id = ? AND verb = 'memory.changed'").bind(projectId).all<{ payload: string }>();
    const decayEvents = results.map((r) => JSON.parse(r.payload)).filter((p) => p.entityType === 'decay');
    expect(decayEvents).toHaveLength(1);
    expect(decayEvents[0]!.decayedIds).toContain(memoryId);
    expect(decayEvents[0]!.statement).toBeUndefined();
  });

  it('is reversible from a pre-decay backup snapshot', async () => {
    const { projectId } = await newOwnedProject('pm-maint-decay-restore@example.com', 'PMMNTDRS');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'will be decayed, then restored', actor: AGENT });
    await memory(projectId)._setMemoryRecordedAtForTest(projectId, memoryId, old());

    const snapshot = await memory(projectId).exportSnapshot(projectId);
    if (!snapshot.ok) throw new Error('export failed');
    await memory(projectId).decayLowAuthorityMemories(projectId, {
      maxAgeMs: MEMORY_HYPOTHESIS_DECAY_MAX_AGE_MS,
      authorityCeiling: MEMORY_HYPOTHESIS_DECAY_AUTHORITY_CEILING,
    });
    expect(await memory(projectId).getMemoryItem(projectId, memoryId)).toBeNull();

    const restored = await memory(projectId).restoreSnapshot(projectId, { exportedAt: snapshot.manifest.exportedAt });
    expect(restored.ok).toBe(true);
    expect(await memory(projectId).getMemoryItem(projectId, memoryId)).not.toBeNull();
  });

  it('running decay twice back to back changes nothing the second time', async () => {
    const { projectId } = await newOwnedProject('pm-maint-decay-rerun@example.com', 'PMMNTDRR');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'decayed once', actor: AGENT });
    await memory(projectId)._setMemoryRecordedAtForTest(projectId, memoryId, old());
    const opts = { maxAgeMs: MEMORY_HYPOTHESIS_DECAY_MAX_AGE_MS, authorityCeiling: MEMORY_HYPOTHESIS_DECAY_AUTHORITY_CEILING };
    const first = await memory(projectId).decayLowAuthorityMemories(projectId, opts);
    expect(first.decayed).toContain(memoryId);
    const second = await memory(projectId).decayLowAuthorityMemories(projectId, opts);
    expect(second.decayed).toHaveLength(0);
  });
});

describe('decay joins the existing lifecycle sweep — no second scheduler', () => {
  it('sweepProjectDebris decays eligible memories and reports the count, idempotently', async () => {
    const { projectId } = await newOwnedProject('pm-maint-sweep@example.com', 'PMMNTSWP');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'swept away', actor: AGENT });
    await memory(projectId)._setMemoryRecordedAtForTest(projectId, memoryId, old());
    // sweepProjectDebris only iterates registered projects — touch the DO via export so a
    // registry row exists, same technique the existing lifecycle sweep tests use.
    const exported = await memory(projectId).exportSnapshot(projectId);
    if (!exported.ok) throw new Error('seed export failed');

    const first = await sweepProjectDebris(appEnv);
    const firstForProject = first.find((r) => r.projectId === projectId);
    expect(firstForProject?.decayedMemories).toBe(1);
    expect(await memory(projectId).getMemoryItem(projectId, memoryId)).toBeNull();

    const second = await sweepProjectDebris(appEnv);
    const secondForProject = second.find((r) => r.projectId === projectId);
    expect(secondForProject?.decayedMemories).toBe(0);
  });
});
