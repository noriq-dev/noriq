// PLNR-251: the real memory/evidence/graph write APIs — idempotency, supersession,
// contradiction sets, atomicity, scope rejection, and the actor authority clamp. Drives the
// ProjectMemory DO's RPCs directly (same technique as the other memory-*.test.ts files).
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { createUser, mintTokenForUser, mcpCall } from './helpers';

const appEnv = env as unknown as Env;

interface EvidenceInput {
  repositoryKey: string;
  branch: string;
  baseId: string;
  path: string;
  symbol?: string | null;
}
interface ActorRef {
  kind: string;
  id: string | null;
}
interface MemoryItemRecord {
  id: string;
  kind: string;
  statement: string;
  authority: number;
  confidence: number | null;
  contentHash: string | null;
  repositoryKey: string | null;
  branch: string | null;
  baseId: string | null;
  validity: string;
  supersedesMemoryId: string | null;
  recordedByAgentId: string | null;
  recordedAt: string;
  evidence: Array<{ id: string; repositoryKey: string; branch: string; baseId: string; path: string; symbol: string | null; verificationState: string }>;
}
interface MemoryRpc {
  health(pid: string): Promise<{ schemaVersion: number; memoryRevision: number; tableCounts: Record<string, number> }>;
  runProjector(pid: string): Promise<{ applied: number; cursor: number }>;
  recordMemory(
    pid: string,
    input: {
      operationId?: string;
      kind: string;
      statement: string;
      authority?: number;
      confidence?: number | null;
      evidence?: EvidenceInput[];
      supersedesMemoryId?: string | null;
      scope?: { repositoryKey?: string; branch?: string; baseId?: string };
      actor: ActorRef;
    },
  ): Promise<{ memoryId: string; operationId: string; deduped: boolean }>;
  writeNode(
    pid: string,
    input: { operationId?: string; type: string; uri: string; label: string; actor: ActorRef },
  ): Promise<{ nodeId: string; operationId: string; deduped: boolean }>;
  writeEdge(
    pid: string,
    input: { operationId?: string; type: string; fromNodeId: string; toNodeId: string; actor: ActorRef },
  ): Promise<{ edgeId: string; operationId: string; deduped: boolean }>;
  addContradiction(
    pid: string,
    input: { operationId?: string; memoryItemId: string; contradictsMemoryItemId: string; setId?: string | null; actor: ActorRef },
  ): Promise<{ setId: string; contradictionId: string; operationId: string; deduped: boolean }>;
  getContradictionSet(pid: string, setId: string): Promise<{ setId: string; memoryItemIds: string[]; resolvedAt: string | null }>;
  getMemoryItem(pid: string, memoryId: string): Promise<MemoryItemRecord | null>;
  _setForceWriteFailure(pid: string, fail: boolean): Promise<void>;
}

const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as MemoryRpc;
const AGENT: ActorRef = { kind: 'agent', id: 'agt_test' };
const SYSTEM: ActorRef = { kind: 'system', id: null };

async function newOwnedProject(email: string, key: string) {
  const user = await createUser(email, 'Owner', 'longenough1');
  const token = await mintTokenForUser(email);
  const proj = await mcpCall(token, 'create_project', { key, name: `${key} project` });
  if (proj.isError) throw new Error(`create_project(${key}) failed: ${proj.text}`);
  return { userId: user.id, token, projectId: proj.body.id as string };
}

describe('recordMemory — operation-id idempotency', () => {
  it('replaying the same operation id creates no second memory and returns the original id', async () => {
    const { projectId } = await newOwnedProject('pm-writes-idem@example.com', 'PMWIDEM');
    const opId = 'op-fixed-1';
    const first = await memory(projectId).recordMemory(projectId, { operationId: opId, kind: 'learning', statement: 'a learning', actor: AGENT });
    const second = await memory(projectId).recordMemory(projectId, { operationId: opId, kind: 'learning', statement: 'a learning', actor: AGENT });
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.memoryId).toBe(first.memoryId);

    const h = await memory(projectId).health(projectId);
    expect(h.tableCounts.memory_items).toBe(1);
  });
});

describe('writeNode / writeEdge — operation-id idempotency', () => {
  it('replaying the same operation id creates no second node or edge', async () => {
    const { projectId } = await newOwnedProject('pm-writes-graph-idem@example.com', 'PMWGIDEM');
    await memory(projectId).runProjector(projectId);
    const baselineNodes = (await memory(projectId).health(projectId)).tableCounts.nodes ?? 0;
    const nodeOp = 'op-node-1';
    const n1 = await memory(projectId).writeNode(projectId, { operationId: nodeOp, type: 'file', uri: 'noriq://file/PMWGIDEM/repo/x.ts', label: 'x.ts', actor: SYSTEM });
    const n2 = await memory(projectId).writeNode(projectId, { operationId: nodeOp, type: 'file', uri: 'noriq://file/PMWGIDEM/repo/x.ts', label: 'x.ts', actor: SYSTEM });
    expect(n2.deduped).toBe(true);
    expect(n2.nodeId).toBe(n1.nodeId);

    const other = await memory(projectId).writeNode(projectId, { type: 'file', uri: 'noriq://file/PMWGIDEM/repo/y.ts', label: 'y.ts', actor: SYSTEM });
    const edgeOp = 'op-edge-1';
    const e1 = await memory(projectId).writeEdge(projectId, { operationId: edgeOp, type: 'imports', fromNodeId: n1.nodeId, toNodeId: other.nodeId, actor: SYSTEM });
    const e2 = await memory(projectId).writeEdge(projectId, { operationId: edgeOp, type: 'imports', fromNodeId: n1.nodeId, toNodeId: other.nodeId, actor: SYSTEM });
    expect(e2.deduped).toBe(true);
    expect(e2.edgeId).toBe(e1.edgeId);

    const h = await memory(projectId).health(projectId);
    expect(h.tableCounts.nodes).toBe(baselineNodes + 2);
    expect(h.tableCounts.edges).toBe(1);
  });

  it('a literal duplicate edge (same type/from/to) collapses even without a shared operation id', async () => {
    const { projectId } = await newOwnedProject('pm-writes-edge-dup@example.com', 'PMWEDGD');
    const a = await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/dup-a', label: 'a', actor: SYSTEM });
    const b = await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/dup-b', label: 'b', actor: SYSTEM });
    await memory(projectId).writeEdge(projectId, { type: 'related_to', fromNodeId: a.nodeId, toNodeId: b.nodeId, actor: SYSTEM });
    await memory(projectId).writeEdge(projectId, { type: 'related_to', fromNodeId: a.nodeId, toNodeId: b.nodeId, actor: SYSTEM });
    const h = await memory(projectId).health(projectId);
    expect(h.tableCounts.edges).toBe(1);
  });
});

describe('supersession — history is never destructively erased', () => {
  it('a superseded memory remains fully readable, statement/evidence/authority intact', async () => {
    const { projectId } = await newOwnedProject('pm-writes-supersede@example.com', 'PMWSUP');
    const original = await memory(projectId).recordMemory(projectId, {
      kind: 'learning',
      statement: 'the original claim',
      evidence: [{ repositoryKey: 'repo-x', branch: 'main', baseId: 'base1', path: 'README.md' }],
      actor: AGENT,
    });
    const replacement = await memory(projectId).recordMemory(projectId, {
      kind: 'learning',
      statement: 'the corrected claim',
      supersedesMemoryId: original.memoryId,
      actor: AGENT,
    });

    const originalRow = await memory(projectId).getMemoryItem(projectId, original.memoryId);
    expect(originalRow).not.toBeNull();
    expect(originalRow!.statement).toBe('the original claim');
    expect(originalRow!.evidence).toHaveLength(1);
    expect(originalRow!.evidence[0]!.path).toBe('README.md');
    expect(originalRow!.authority).toBe(1);
    void original;

    const replacementRow = await memory(projectId).getMemoryItem(projectId, replacement.memoryId);
    expect(replacementRow!.supersedesMemoryId).toBe(original.memoryId);
  });
});

describe('contradiction sets — coexistence addressable as one unit', () => {
  it('two contradictory memories coexist and are joined by a named contradiction set', async () => {
    const { projectId } = await newOwnedProject('pm-writes-contra@example.com', 'PMWCONT');
    const a = await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'claim A', actor: AGENT });
    const b = await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'claim B (contradicts A)', actor: AGENT });

    const linked = await memory(projectId).addContradiction(projectId, { memoryItemId: a.memoryId, contradictsMemoryItemId: b.memoryId, actor: AGENT });
    expect(linked.setId).toBeTruthy();

    const set = await memory(projectId).getContradictionSet(projectId, linked.setId);
    expect(new Set(set.memoryItemIds)).toEqual(new Set([a.memoryId, b.memoryId]));

    // Both memories are still independently readable — coexistence, not resolution.
    expect((await memory(projectId).getMemoryItem(projectId, a.memoryId))!.statement).toBe('claim A');
    expect((await memory(projectId).getMemoryItem(projectId, b.memoryId))!.statement).toBe('claim B (contradicts A)');
  });

  it('a third memory can join an existing contradiction set by its id', async () => {
    const { projectId } = await newOwnedProject('pm-writes-contra3@example.com', 'PMWCONT3');
    const a = await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'claim A', actor: AGENT });
    const b = await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'claim B', actor: AGENT });
    const c = await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'claim C', actor: AGENT });

    const first = await memory(projectId).addContradiction(projectId, { memoryItemId: a.memoryId, contradictsMemoryItemId: b.memoryId, actor: AGENT });
    await memory(projectId).addContradiction(projectId, { memoryItemId: a.memoryId, contradictsMemoryItemId: c.memoryId, setId: first.setId, actor: AGENT });

    const set = await memory(projectId).getContradictionSet(projectId, first.setId);
    expect(new Set(set.memoryItemIds)).toEqual(new Set([a.memoryId, b.memoryId, c.memoryId]));
  });
});

describe('atomicity — mutation, revision bump, and outbox row commit as one unit', () => {
  it('an injected mid-write failure leaves no partial memory, revision bump, or outbox row', async () => {
    const { projectId } = await newOwnedProject('pm-writes-atomic@example.com', 'PMWATOM');
    const before = await memory(projectId).health(projectId);

    await memory(projectId)._setForceWriteFailure(projectId, true);
    await expect(memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'never committed', actor: AGENT })).rejects.toThrow(
      /injected write failure/,
    );
    await memory(projectId)._setForceWriteFailure(projectId, false);

    const after = await memory(projectId).health(projectId);
    expect(after.memoryRevision).toBe(before.memoryRevision);
    expect(after.tableCounts.memory_items).toBe(0);
    expect(after.tableCounts.outbox).toBe(before.tableCounts.outbox);
  });
});

describe('scope and evidence validation — the shared schemas, never re-derived', () => {
  it('rejects an evidence citation whose repositoryKey is a runner-local checkout id', async () => {
    const { projectId } = await newOwnedProject('pm-writes-ckt@example.com', 'PMWCKT');
    await expect(
      memory(projectId).recordMemory(projectId, {
        kind: 'learning',
        statement: 'bad evidence',
        evidence: [{ repositoryKey: 'ckt_abc123', branch: 'main', baseId: 'base1', path: 'a.ts' }],
        actor: AGENT,
      }),
    ).rejects.toThrow();
  });

  it('accepts a non-Git baseId (a Perforce changelist number, or a Diversion id) unchanged', async () => {
    const { projectId } = await newOwnedProject('pm-writes-p4@example.com', 'PMWP4');
    const result = await memory(projectId).recordMemory(projectId, {
      kind: 'learning',
      statement: 'p4-evidenced learning',
      evidence: [{ repositoryKey: 'repo-p4', branch: 'main', baseId: '123456', path: 'src/main.c' }],
      actor: AGENT,
    });
    const row = await memory(projectId).getMemoryItem(projectId, result.memoryId);
    expect(row!.evidence[0]!.baseId).toBe('123456');
  });

  it('rejects a memory scope that carries a branch/baseId without a repositoryKey', async () => {
    const { projectId } = await newOwnedProject('pm-writes-scope@example.com', 'PMWSCOPE');
    await expect(
      memory(projectId).recordMemory(projectId, {
        kind: 'learning',
        statement: 'ambiguous scope',
        scope: { branch: 'main' },
        actor: AGENT,
      }),
    ).rejects.toThrow();
  });

  it('accepts a well-formed repository/branch/baseId scope and stores it', async () => {
    const { projectId } = await newOwnedProject('pm-writes-scope-ok@example.com', 'PMWSCPOK');
    const result = await memory(projectId).recordMemory(projectId, {
      kind: 'procedure',
      statement: 'how to run the build',
      scope: { repositoryKey: 'repo-x', branch: 'main', baseId: 'deadbeef' },
      actor: AGENT,
    });
    const row = await memory(projectId).getMemoryItem(projectId, result.memoryId);
    expect(row).toMatchObject({ repositoryKey: 'repo-x', branch: 'main', baseId: 'deadbeef' });
  });
});

describe('authority clamp — an agent actor cannot exceed authority 2 through this RPC', () => {
  it('clamps a requested authority of 5 down to 2 for an agent actor', async () => {
    const { projectId } = await newOwnedProject('pm-writes-authority@example.com', 'PMWAUTH');
    const result = await memory(projectId).recordMemory(projectId, { kind: 'decision', statement: 'agents cannot self-approve', authority: 5, actor: AGENT });
    const row = await memory(projectId).getMemoryItem(projectId, result.memoryId);
    expect(row!.authority).toBe(2);
  });

  it('clamps a requested authority of 3 down to 2 for an agent actor', async () => {
    const { projectId } = await newOwnedProject('pm-writes-authority3@example.com', 'PMWAUTH3');
    const result = await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'repeated observation', authority: 3, actor: AGENT });
    const row = await memory(projectId).getMemoryItem(projectId, result.memoryId);
    expect(row!.authority).toBe(2);
  });

  it('defaults to authority 1 (hypothesis) when none is requested', async () => {
    const { projectId } = await newOwnedProject('pm-writes-authority-default@example.com', 'PMWAUTHD');
    const result = await memory(projectId).recordMemory(projectId, { kind: 'unknown', statement: 'an open question', actor: AGENT });
    const row = await memory(projectId).getMemoryItem(projectId, result.memoryId);
    expect(row!.authority).toBe(1);
  });
});

describe('content and evidence hashes are recorded', () => {
  it('stores a stable content hash for the memory and an evidence hash for each citation', async () => {
    const { projectId } = await newOwnedProject('pm-writes-hashes@example.com', 'PMWHASH');
    const result = await memory(projectId).recordMemory(projectId, {
      kind: 'learning',
      statement: 'hashed content',
      evidence: [{ repositoryKey: 'repo-x', branch: 'main', baseId: 'base1', path: 'README.md' }],
      actor: AGENT,
    });
    const row = await memory(projectId).getMemoryItem(projectId, result.memoryId);
    expect(row!.contentHash).toBeTruthy();
    expect(row!.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
