// PLNR-314: a memory graph node's label is a bounded excerpt of its own `statement`, never its
// `kind` — before this fix, `recordMemory` wrote `input.kind` as the node label, so every
// `hazard`/`decision`/`unknown` memory rendered as an identically titled star on the constellation
// map. Drives the ProjectMemory DO's RPCs directly (same technique as the other
// memory-*.test.ts files).
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { createUser, mintTokenForUser, mcpCall } from './helpers';

const appEnv = env as unknown as Env;

interface ActorRef {
  kind: string;
  id: string | null;
}
interface EvidenceInput {
  repositoryKey: string;
  branch: string;
  baseId: string;
  path: string;
  symbol?: string | null;
}
interface MemoryRpc {
  recordMemory(
    pid: string,
    input: { operationId?: string; kind: string; statement: string; authority?: number; evidence?: EvidenceInput[]; actor: ActorRef },
  ): Promise<{ memoryId: string; operationId: string; deduped: boolean }>;
  _nodeByUriForTest(pid: string, uri: string): Promise<{ nodeId: string; type: string; label: string } | null>;
  _setNodeLabelForTest(pid: string, uri: string, label: string): Promise<void>;
  _reapplyMemoryNodeLabelBackfillForTest(pid: string): Promise<void>;
}

const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as MemoryRpc;
const AGENT: ActorRef = { kind: 'agent', id: 'agt_test' };
const memoryUri = (memoryId: string) => `noriq://memory/${memoryId}`;

async function newOwnedProject(email: string, key: string) {
  await createUser(email, 'Owner', 'longenough1');
  const token = await mintTokenForUser(email);
  const proj = await mcpCall(token, 'create_project', { key, name: `${key} project` });
  if (proj.isError) throw new Error(`create_project(${key}) failed: ${proj.text}`);
  return { projectId: proj.body.id as string };
}

describe('recordMemory — graph node label is a statement excerpt, not the kind', () => {
  it('a kind="unknown" memory does not render as a star literally named "unknown"', async () => {
    const { projectId } = await newOwnedProject('pm-graph-label-unknown@example.com', 'PMGLU1');
    const rec = await memory(projectId).recordMemory(projectId, {
      kind: 'unknown',
      statement: 'it is unclear whether the retry budget should be per-task or per-run',
      actor: AGENT,
    });
    const node = await memory(projectId)._nodeByUriForTest(projectId, memoryUri(rec.memoryId));
    expect(node).not.toBeNull();
    expect(node!.type).toBe('memory');
    expect(node!.label).not.toBe('unknown');
    expect(node!.label).toContain('retry budget');
  });

  it('two memories of the same kind get two differently-labelled nodes', async () => {
    const { projectId } = await newOwnedProject('pm-graph-label-distinct@example.com', 'PMGLU2');
    const a = await memory(projectId).recordMemory(projectId, { kind: 'hazard', statement: 'deploying twice in a row corrupts the cache', actor: AGENT });
    const b = await memory(projectId).recordMemory(projectId, { kind: 'hazard', statement: 'a cold start drops the first request on the floor', actor: AGENT });

    const nodeA = await memory(projectId)._nodeByUriForTest(projectId, memoryUri(a.memoryId));
    const nodeB = await memory(projectId)._nodeByUriForTest(projectId, memoryUri(b.memoryId));
    expect(nodeA!.label).not.toBe(nodeB!.label);
    expect(nodeA!.label).not.toBe('hazard');
    expect(nodeB!.label).not.toBe('hazard');
    expect(nodeA!.label).toContain('corrupts the cache');
    expect(nodeB!.label).toContain('drops the first request');
  });

  it('a long statement is truncated to a bounded, single-line label with a visible ellipsis', async () => {
    const { projectId } = await newOwnedProject('pm-graph-label-trunc@example.com', 'PMGLU3');
    const longStatement =
      'this statement is deliberately much longer than any reasonable canvas label bound so that the ' +
      'excerpt logic has to truncate it rather than passing it through untouched, well past eighty characters';
    const rec = await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: longStatement, actor: AGENT });
    const node = await memory(projectId)._nodeByUriForTest(projectId, memoryUri(rec.memoryId));
    expect(node!.label.length).toBeLessThanOrEqual(80);
    expect(node!.label.endsWith('…')).toBe(true);
    expect(longStatement.startsWith(node!.label.slice(0, -1))).toBe(true);
  });

  it('newlines in the statement are collapsed so the label is never multi-line', async () => {
    const { projectId } = await newOwnedProject('pm-graph-label-newline@example.com', 'PMGLU4');
    const rec = await memory(projectId).recordMemory(projectId, {
      kind: 'procedure',
      statement: 'step one: acquire the lock\nstep two: do the write\nstep three: release the lock',
      actor: AGENT,
    });
    const node = await memory(projectId)._nodeByUriForTest(projectId, memoryUri(rec.memoryId));
    expect(node!.label).not.toContain('\n');
    expect(node!.label).toContain('step one: acquire the lock');
  });
});

describe('memory-migration 0011 — backfill for nodes written before the PLNR-314 fix', () => {
  it('re-running the backfill derives a statement excerpt for a node whose label was left as the bare kind', async () => {
    const { projectId } = await newOwnedProject('pm-graph-backfill@example.com', 'PMGLBF1');
    const rec = await memory(projectId).recordMemory(projectId, {
      kind: 'decision',
      statement: 'the export pipeline chunks at 500 rows per R2 write',
      actor: AGENT,
    });
    const uri = memoryUri(rec.memoryId);

    // Simulate a row written by pre-fix code: label == bare kind, exactly what recordMemory used
    // to write before this task.
    await memory(projectId)._setNodeLabelForTest(projectId, uri, 'decision');
    const corrupted = await memory(projectId)._nodeByUriForTest(projectId, uri);
    expect(corrupted!.label).toBe('decision');

    await memory(projectId)._reapplyMemoryNodeLabelBackfillForTest(projectId);

    const backfilled = await memory(projectId)._nodeByUriForTest(projectId, uri);
    expect(backfilled!.label).not.toBe('decision');
    expect(backfilled!.label).toContain('export pipeline chunks at 500 rows');
  });

  it('is idempotent — re-running it again against an already-backfilled node is a no-op', async () => {
    const { projectId } = await newOwnedProject('pm-graph-backfill-idem@example.com', 'PMGLBF2');
    const rec = await memory(projectId).recordMemory(projectId, { kind: 'requirement', statement: 'every migration must be additive', actor: AGENT });
    const uri = memoryUri(rec.memoryId);

    const before = await memory(projectId)._nodeByUriForTest(projectId, uri);
    await memory(projectId)._reapplyMemoryNodeLabelBackfillForTest(projectId);
    const after = await memory(projectId)._nodeByUriForTest(projectId, uri);
    expect(after!.label).toBe(before!.label);
  });

  it('leaves non-memory nodes alone', async () => {
    const { projectId } = await newOwnedProject('pm-graph-backfill-scope@example.com', 'PMGLBF3');
    // recordMemory's own evidence-citation path writes non-memory nodes too (e.g. a repository
    // citation's file node) — reuse it rather than reaching for a second RPC.
    const rec = await memory(projectId).recordMemory(projectId, {
      kind: 'learning',
      statement: 'unrelated to the file node below',
      actor: AGENT,
      evidence: [{ repositoryKey: 'repo-x', branch: 'main', baseId: 'base1', path: 'README.md' }],
    });
    void rec;

    // A file node's label is its path — assert the backfill migration does not touch it even
    // though its type isn't 'memory'.
    const fileNodeUri = 'noriq://file/PMGLBF3/repo-x/README.md';
    const before = await memory(projectId)._nodeByUriForTest(projectId, fileNodeUri);
    expect(before).not.toBeNull();
    expect(before!.type).toBe('file');
    await memory(projectId)._reapplyMemoryNodeLabelBackfillForTest(projectId);
    const after = await memory(projectId)._nodeByUriForTest(projectId, fileNodeUri);
    expect(after!.label).toBe(before!.label);
  });
});
