// PLNR-284: the bounded constellation endpoint feeding the memory star map.
//
// Two layers, matching the module split this task's own execution spec calls for (SQL in the
// DO, shaping/sampling/coverage in memory/graph-queries.ts's pure `constellation`):
//  - Bounding, tie-break determinism, dangling-edge pruning, and coverage classification are
//    exercised directly against the PURE function with synthetic rows — no workerd/DO needed,
//    and it is the only practical way to exceed CONSTELLATION_NODE_CEILING/EDGE_CEILING (1000/2000
//    as of PLNR-315) in a fast test.
//  - URI parity with `/memory/search`, provenance passthrough, revision-keyed determinism across
//    real calls, the four distinct degraded states, and the REST route's auth gate are exercised
//    against the real DO/REST stack (same technique as memory-graph-queries.test.ts).
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { buildEntityUri, parseEntityUri } from '@noriq-dev/shared';
import {
  constellation, CONSTELLATION_NODE_CEILING, CONSTELLATION_EDGE_CEILING,
  type ConstellationRawNode, type ConstellationRawEdge,
} from '../src/memory/graph-queries';
import { createUser, mintTokenForUser, mcpCall, loginSession } from './helpers';

const appEnv = env as unknown as Env;
const SYSTEM = { kind: 'system', id: null };

// ---------------------------------------------------------------------------------------
// Part 1: the pure shaping function
// ---------------------------------------------------------------------------------------

function node(uri: string, type: string, overrides: Partial<ConstellationRawNode> = {}): ConstellationRawNode {
  return { nodeId: `n_${uri}`, uri, type, label: uri, createdAt: '2026-01-01T00:00:00.000Z', ...overrides };
}
function edge(type: string, fromUri: string, toUri: string, provenance: string | null = null): ConstellationRawEdge {
  return { edgeId: `e_${fromUri}_${type}_${toUri}`, type, fromNodeId: `n_${fromUri}`, toNodeId: `n_${toUri}`, provenance };
}

describe('constellation (pure) — bounding', () => {
  it('returns exactly CONSTELLATION_NODE_CEILING nodes when the graph exceeds it, and counts the rest as omitted', () => {
    const total = CONSTELLATION_NODE_CEILING + 5;
    // Zero-padded ids sort lexicographically identically to numerically — with every OTHER
    // scoring input tied, the uri ASC tie-break alone decides which 1000 of 1005 survive.
    const nodes = Array.from({ length: total }, (_, i) => node(`noriq://task/n${String(i).padStart(4, '0')}`, 'task'));
    const result = constellation(1, { nodes, edges: [], memoryItems: [], episodes: [] }, { codeGraphPopulated: true });

    expect(result.nodes).toHaveLength(CONSTELLATION_NODE_CEILING);
    expect(result.omitted.nodes).toBe(5);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.reasons).toContain('row-limit-reached');
    // uri ASC tie-break: the first 1000 lexicographically sorted uris survive.
    expect(result.nodes[0]!.uri).toBe('noriq://task/n0000');
    expect(result.nodes.at(-1)!.uri).toBe('noriq://task/n0999');
    expect(result.nodes.some((n) => n.uri === 'noriq://task/n1000')).toBe(false);
  });

  it('returns exactly CONSTELLATION_EDGE_CEILING edges when surviving edges exceed it, independent of node truncation', () => {
    // 20 nodes * 19 non-self pairs * 10 edge types = 3800 possible edges — comfortably past
    // CONSTELLATION_EDGE_CEILING + 1 (2001) so the `break outer` below always has enough supply.
    const nodeCount = 20;
    const nodes = Array.from({ length: nodeCount }, (_, i) => node(`noriq://task/n${i}`, 'task'));
    const types = ['depends_on', 'imports', 'calls', 'tests', 'implements', 'modifies', 'related_to', 'blocks', 'contradicts', 'supersedes'];
    const edges: ConstellationRawEdge[] = [];
    outer: for (const type of types) {
      for (let i = 0; i < nodeCount; i++) {
        for (let j = 0; j < nodeCount; j++) {
          if (i === j) continue;
          edges.push(edge(type, `noriq://task/n${i}`, `noriq://task/n${j}`));
          if (edges.length >= CONSTELLATION_EDGE_CEILING + 1) break outer;
        }
      }
    }
    expect(edges.length).toBe(CONSTELLATION_EDGE_CEILING + 1);

    const result = constellation(1, { nodes, edges, memoryItems: [], episodes: [] }, { codeGraphPopulated: true });
    expect(result.nodes).toHaveLength(nodeCount);
    expect(result.omitted.nodes).toBe(0);
    expect(result.edges).toHaveLength(CONSTELLATION_EDGE_CEILING);
    expect(result.omitted.edges).toBe(1);
    expect(result.coverage.reasons).toContain('row-limit-reached');
  });
});

describe('constellation (pure) — determinism and the explicit tie-break', () => {
  it('is byte-identical across two calls regardless of input row order, including ties', () => {
    const nodes = [
      node('noriq://task/c', 'task'),
      node('noriq://task/a', 'task'),
      node('noriq://task/b', 'task'),
    ];
    const edges = [edge('related_to', 'noriq://task/a', 'noriq://task/b', 'coordination:seq-1')];
    const r1 = constellation(7, { nodes, edges, memoryItems: [], episodes: [] }, { codeGraphPopulated: true });
    const r2 = constellation(7, { nodes: [...nodes].reverse(), edges, memoryItems: [], episodes: [] }, { codeGraphPopulated: true });

    expect(r1).toEqual(r2);
    // Every input row here ties on degree/authority/validity/createdAt — uri ASC alone orders them.
    expect(r1.nodes.map((n) => n.uri)).toEqual(['noriq://task/a', 'noriq://task/b', 'noriq://task/c']);
  });

  it('breaks a degree/authority/validity tie by createdAt DESC before falling back to uri', () => {
    const nodes = [
      node('noriq://task/older', 'task', { createdAt: '2026-01-01T00:00:00.000Z' }),
      node('noriq://task/newer', 'task', { createdAt: '2026-06-01T00:00:00.000Z' }),
    ];
    const result = constellation(1, { nodes, edges: [], memoryItems: [], episodes: [] }, { codeGraphPopulated: true });
    expect(result.nodes.map((n) => n.uri)).toEqual(['noriq://task/newer', 'noriq://task/older']);
  });

  it('ranks a well-connected, high-authority, active memory above an isolated hypothesis', () => {
    const hub = node('noriq://task/hub', 'task');
    const leaves = Array.from({ length: 4 }, (_, i) => node(`noriq://task/leaf${i}`, 'task'));
    const decision = node('noriq://memory/mem-strong', 'memory', { label: 'decision' });
    const hypothesis = node('noriq://memory/mem-weak', 'memory', { label: 'learning' });
    const edges = leaves.map((leaf) => edge('related_to', 'noriq://task/hub', leaf.uri));

    const result = constellation(
      1,
      {
        nodes: [hypothesis, decision, ...leaves, hub],
        edges,
        memoryItems: [
          { id: 'mem-strong', kind: 'decision', authority: 5, validity: 'active' },
          { id: 'mem-weak', kind: 'learning', authority: 1, validity: 'active' },
        ],
        episodes: [],
      },
      { codeGraphPopulated: true },
    );
    const order = result.nodes.map((n) => n.uri);
    // hub (degree 4) outranks the authority-5 decision (degree 0), which outranks the
    // authority-1 hypothesis (degree 0) — degree is the primary signal, authority the bonus.
    expect(order.indexOf('noriq://task/hub')).toBeLessThan(order.indexOf('noriq://memory/mem-strong'));
    expect(order.indexOf('noriq://memory/mem-strong')).toBeLessThan(order.indexOf('noriq://memory/mem-weak'));
  });
});

describe('constellation (pure) — edges: dangling pruning vs ceiling truncation', () => {
  it('prunes an edge whose other endpoint never made it into the returned node set, and counts it separately from ceiling omissions', () => {
    const a = node('noriq://task/a', 'task');
    const b = node('noriq://task/b', 'task');
    const edges = [
      edge('related_to', 'noriq://task/a', 'noriq://task/b', 'coordination:seq-1'), // both endpoints present — survives
      edge('related_to', 'noriq://task/a', 'noriq://task/ghost', null), // "ghost" never appears in `nodes` at all — dangling
    ];
    const result = constellation(1, { nodes: [a, b], edges, memoryItems: [], episodes: [] }, { codeGraphPopulated: true });

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toEqual({ type: 'related_to', fromNodeId: a.nodeId, toNodeId: b.nodeId, provenance: 'coordination:seq-1' });
    expect(result.omitted.edgesDanglingPruned).toBe(1);
    expect(result.omitted.edges).toBe(0); // this was never a ceiling casualty
    // Every returned edge's both endpoints exist in the returned node set (stated acceptance).
    const returnedIds = new Set(result.nodes.map((n) => n.nodeId));
    for (const e of result.edges) {
      expect(returnedIds.has(e.fromNodeId)).toBe(true);
      expect(returnedIds.has(e.toNodeId)).toBe(true);
    }
  });

  it('an edge touching neither surviving node is not counted anywhere', () => {
    const a = node('noriq://task/a', 'task');
    const edges = [edge('related_to', 'noriq://task/ghost1', 'noriq://task/ghost2', null)];
    const result = constellation(1, { nodes: [a], edges, memoryItems: [], episodes: [] }, { codeGraphPopulated: true });
    expect(result.edges).toEqual([]);
    expect(result.omitted.edges).toBe(0);
    expect(result.omitted.edgesDanglingPruned).toBe(0);
  });
});

describe('constellation (pure) — per-node kind/authority/validity/isLead/degree/groupKey', () => {
  it('derives memory-only fields from memory_items, reusing classifyLead verbatim', () => {
    const memNode = node('noriq://memory/mem-1', 'memory', { label: 'decision' });
    const result = constellation(
      1,
      { nodes: [memNode], edges: [], memoryItems: [{ id: 'mem-1', kind: 'decision', authority: 1, validity: 'active' }], episodes: [] },
      { codeGraphPopulated: true },
    );
    const n = result.nodes[0]!;
    expect(n.kind).toBe('decision');
    expect(n.authority).toBe(1);
    expect(n.validity).toBe('active');
    expect(n.isLead).toBe(true); // authority <= 2 — classifyLead's own rule
    expect(n.leadReasons).toEqual(['low-authority']);
    expect(n.groupKey).toBe('memory');
  });

  it('derives an episode node\'s kind from its landing outcome, and leaves authority/validity/isLead null', () => {
    const epNode = node('noriq://episode/ep-1', 'episode');
    const result = constellation(
      1,
      { nodes: [epNode], edges: [], memoryItems: [], episodes: [{ id: 'ep-1', landingOutcome: 'landed' }] },
      { codeGraphPopulated: true },
    );
    const n = result.nodes[0]!;
    expect(n.kind).toBe('landed');
    expect(n.authority).toBeNull();
    expect(n.validity).toBeNull();
    expect(n.isLead).toBeNull();
    expect(n.leadReasons).toBeNull();
  });

  it('a coordination node (task/plan/artifact/…) carries null kind/authority/validity/isLead and degree over the FULL graph', () => {
    const a = node('noriq://task/a', 'task');
    const b = node('noriq://task/b', 'task');
    const c = node('noriq://task/c', 'task');
    const edges = [edge('related_to', 'noriq://task/a', 'noriq://task/b'), edge('blocks', 'noriq://task/c', 'noriq://task/a')];
    const result = constellation(1, { nodes: [a, b, c], edges, memoryItems: [], episodes: [] }, { codeGraphPopulated: true });
    const nodeA = result.nodes.find((n) => n.uri === 'noriq://task/a')!;
    expect(nodeA.kind).toBeNull();
    expect(nodeA.authority).toBeNull();
    expect(nodeA.validity).toBeNull();
    expect(nodeA.isLead).toBeNull();
    expect(nodeA.degree).toBe(2); // one edge out (to b), one edge in (from c)
    expect(nodeA.groupKey).toBe('task');
  });
});

describe('constellation (pure) — the four distinct coverage states', () => {
  it('an empty graph reports graph-empty, not merely code-graph-empty', () => {
    const result = constellation(0, { nodes: [], edges: [], memoryItems: [], episodes: [] }, { codeGraphPopulated: false });
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.reasons).toContain('graph-empty');
  });

  it('an unindexed-but-populated project reports code-graph-empty WITHOUT graph-empty', () => {
    const task = node('noriq://task/t1', 'task');
    const result = constellation(1, { nodes: [task], edges: [], memoryItems: [], episodes: [] }, { codeGraphPopulated: false });
    expect(result.nodes).toHaveLength(1);
    expect(result.coverage.reasons).toEqual(['code-graph-empty']);
    expect(result.coverage.reasons).not.toContain('graph-empty');
  });

  it('a fully populated, indexed project reports complete coverage, and its file node is excluded per PLNR-315', () => {
    const task = node('noriq://task/t1', 'task');
    const file = node('noriq://file/PROJ/repo-x/a.ts', 'file');
    const result = constellation(1, { nodes: [task, file], edges: [], memoryItems: [], episodes: [] }, { codeGraphPopulated: true });
    expect(result.coverage).toEqual({ complete: true, reasons: [] });
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.uri).toBe('noriq://task/t1');
    expect(result.omitted.codeEntitiesExcluded).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------
// PLNR-315: file/symbol nodes are excluded from the whole-project constellation, server-side and
// BEFORE scoring — so they can never eat the node ceiling — and their exclusion is reported
// rather than silent. Ego-network expansion and explain_project_area (retrieval.ts) are untouched
// by this task; nothing here exercises those primitives.
// ---------------------------------------------------------------------------------------
describe('constellation (pure) — PLNR-315 code entity exclusion', () => {
  it('excludes every file and symbol node from the returned set, regardless of how well-connected or important they score', () => {
    const task = node('noriq://task/t1', 'task');
    const file = node('noriq://file/PROJ/repo-x/a.ts', 'file');
    const symbol = node('noriq://symbol/PROJ/repo-x/a.ts#Foo', 'symbol');
    const edges = [edge('depends_on', 'noriq://task/t1', file.uri), edge('imports', file.uri, symbol.uri)];
    const result = constellation(1, { nodes: [task, file, symbol], edges, memoryItems: [], episodes: [] }, { codeGraphPopulated: true });

    expect(result.nodes.map((n) => n.type)).toEqual(['task']);
    expect(result.nodes.some((n) => n.type === 'file' || n.type === 'symbol')).toBe(false);
  });

  it('reports the excluded count via omitted.codeEntitiesExcluded rather than silently dropping them', () => {
    const task = node('noriq://task/t1', 'task');
    const files = Array.from({ length: 7 }, (_, i) => node(`noriq://file/PROJ/repo-x/f${i}.ts`, 'file'));
    const symbols = Array.from({ length: 3 }, (_, i) => node(`noriq://symbol/PROJ/repo-x/s${i}`, 'symbol'));
    const result = constellation(1, { nodes: [task, ...files, ...symbols], edges: [], memoryItems: [], episodes: [] }, { codeGraphPopulated: true });

    expect(result.omitted.codeEntitiesExcluded).toBe(10);
    expect(result.nodes).toHaveLength(1);
  });

  it('excluded code entities never consume the node ceiling — a task/memory population under the ceiling survives whole even when code entities vastly outnumber it', () => {
    const coordinationNodes = Array.from({ length: 5 }, (_, i) => node(`noriq://task/t${i}`, 'task'));
    // Far more file nodes than CONSTELLATION_NODE_CEILING — if exclusion happened AFTER sampling
    // (or client-side), these would crowd out every coordination node instead.
    const codeNodes = Array.from({ length: CONSTELLATION_NODE_CEILING * 3 }, (_, i) => node(`noriq://file/PROJ/repo-x/f${i}.ts`, 'file'));
    const result = constellation(1, { nodes: [...coordinationNodes, ...codeNodes], edges: [], memoryItems: [], episodes: [] }, { codeGraphPopulated: true });

    expect(result.nodes).toHaveLength(5);
    expect(result.nodes.every((n) => n.type === 'task')).toBe(true);
    expect(result.omitted.nodes).toBe(0); // no ceiling casualty among the eligible population
    expect(result.omitted.codeEntitiesExcluded).toBe(CONSTELLATION_NODE_CEILING * 3);
    expect(result.coverage.reasons).not.toContain('row-limit-reached');
  });

  it('prunes an edge to an excluded code entity as dangling, exactly like an edge to an unsampled node — no separate counter', () => {
    const task = node('noriq://task/t1', 'task');
    const file = node('noriq://file/PROJ/repo-x/a.ts', 'file');
    const edges = [edge('modifies', task.uri, file.uri)];
    const result = constellation(1, { nodes: [task, file], edges, memoryItems: [], episodes: [] }, { codeGraphPopulated: true });

    expect(result.edges).toEqual([]);
    expect(result.omitted.edgesDanglingPruned).toBe(1);
    expect(result.omitted.edges).toBe(0); // not a ceiling casualty
  });

  it('a project with ONLY code entities is not graph-empty — that reason is reserved for a project with zero nodes at all', () => {
    const file = node('noriq://file/PROJ/repo-x/a.ts', 'file');
    const result = constellation(1, { nodes: [file], edges: [], memoryItems: [], episodes: [] }, { codeGraphPopulated: true });

    expect(result.nodes).toEqual([]);
    expect(result.omitted.codeEntitiesExcluded).toBe(1);
    expect(result.coverage.reasons).not.toContain('graph-empty');
  });

  it('a genuinely empty project (zero rows) still reports graph-empty, and codeEntitiesExcluded is zero, not silently omitted', () => {
    const result = constellation(0, { nodes: [], edges: [], memoryItems: [], episodes: [] }, { codeGraphPopulated: false });
    expect(result.coverage.reasons).toContain('graph-empty');
    expect(result.omitted.codeEntitiesExcluded).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------
// Part 2: the real DO RPC + REST route
// ---------------------------------------------------------------------------------------

interface MemRpc {
  recordMemory(
    pid: string,
    input: { kind: string; statement: string; evidence?: unknown[]; actor: { kind: string; id: string | null } },
  ): Promise<{ memoryId: string }>;
  rebuildProjection(pid: string): Promise<{ nodesWritten: number; edgesWritten: number }>;
  searchProjectMemory(pid: string, opts: { memoryItemId?: string }): Promise<{ results: Array<{ uri?: string }> }>;
  constellation(pid: string): Promise<{
    memoryRevision: number;
    nodeCeiling: number;
    edgeCeiling: number;
    nodes: Array<{ nodeId: string; uri: string; type: string; label: string; provenance?: unknown }>;
    edges: Array<{ type: string; fromNodeId: string; toNodeId: string; provenance: string | null }>;
    omitted: { nodes: number; edges: number; edgesDanglingPruned: number; codeEntitiesExcluded: number };
    coverage: { complete: boolean; reasons: string[] };
  }>;
}
const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as MemRpc;

async function newOwnedProject(email: string, key: string) {
  await createUser(email, 'Owner', 'longenough1');
  const token = await mintTokenForUser(email);
  const proj = await mcpCall(token, 'create_project', { key, name: `${key} project` });
  if (proj.isError) throw new Error(`create_project(${key}) failed: ${proj.text}`);
  return { token, projectId: proj.body.id as string };
}

describe('ProjectMemory.constellation (real DO) — URI parity and provenance passthrough', () => {
  it('a memory node\'s uri is identical to /memory/search\'s hit uri for the same memory, and its evidence edge carries verbatim provenance', async () => {
    const { token, projectId } = await newOwnedProject('pm-const-parity@example.com', 'PMCONPAR');
    const task = await mcpCall(token, 'create_task', { tags: ['test-fixture'], projectId, title: 'do the thing' });
    const taskId = task.body.id as string;

    const { memoryId } = await memory(projectId).recordMemory(projectId, {
      kind: 'learning',
      statement: 'this took two tries',
      evidence: [{ kind: 'task', id: taskId }],
      actor: { kind: 'agent', id: 'agt_x' },
    });

    const [searchResult, result] = await Promise.all([
      memory(projectId).searchProjectMemory(projectId, { memoryItemId: memoryId }),
      memory(projectId).constellation(projectId),
    ]);

    const memNode = result.nodes.find((n) => n.type === 'memory')!;
    expect(memNode).toBeTruthy();
    expect(memNode.uri).toBe(buildEntityUri({ kind: 'memory', id: memoryId }));
    expect(memNode.uri).toBe(searchResult.results[0]!.uri);
    expect(() => parseEntityUri(memNode.uri)).not.toThrow();

    const evidenceEdge = result.edges.find((e) => e.type === 'observed_in')!;
    expect(evidenceEdge).toBeTruthy();
    expect(evidenceEdge.provenance).toBe(`evidence:${memoryId}`); // entity citation grammar (PLNR-283)
    const taskNode = result.nodes.find((n) => n.type === 'task')!;
    expect(evidenceEdge.fromNodeId).toBe(memNode.nodeId);
    expect(evidenceEdge.toNodeId).toBe(taskNode.nodeId);
  });

  it('two consecutive calls with no intervening write return byte-identical nodes/edges/ordering, keyed by an unchanged memory_revision', async () => {
    const { token, projectId } = await newOwnedProject('pm-const-det@example.com', 'PMCONDET');
    await mcpCall(token, 'create_task', { tags: ['test-fixture'], projectId, title: 'a' });
    await mcpCall(token, 'create_task', { tags: ['test-fixture'], projectId, title: 'b' });
    await memory(projectId).rebuildProjection(projectId);

    const r1 = await memory(projectId).constellation(projectId);
    const r2 = await memory(projectId).constellation(projectId);
    expect(r2).toEqual(r1);
    expect(r1.memoryRevision).toBe(r2.memoryRevision);

    // A subsequent write bumps the revision — proving the field is live, not a constant.
    await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'x', actor: { kind: 'agent', id: 'agt_x' } });
    const r3 = await memory(projectId).constellation(projectId);
    expect(r3.memoryRevision).not.toBe(r1.memoryRevision);
  });
});

describe('ProjectMemory.constellation (real DO) — degraded states', () => {
  it('a brand-new project reports graph-empty', async () => {
    const { projectId } = await newOwnedProject('pm-const-empty@example.com', 'PMCONEMP');
    const result = await memory(projectId).constellation(projectId);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.coverage.reasons).toContain('graph-empty');
  });

  it('a project with coordination nodes but no repository index reports code-graph-empty, not graph-empty', async () => {
    const { token, projectId } = await newOwnedProject('pm-const-unidx@example.com', 'PMCONUIX');
    await mcpCall(token, 'create_task', { tags: ['test-fixture'], projectId, title: 'unindexed project task' });
    await memory(projectId).rebuildProjection(projectId);

    const result = await memory(projectId).constellation(projectId);
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.coverage.reasons).toContain('code-graph-empty');
    expect(result.coverage.reasons).not.toContain('graph-empty');
  });
});

describe('POST /api/projects/:pid/memory/constellation (REST)', () => {
  it('a project member gets 200 with the bounded shape', async () => {
    await createUser('pm-const-rest@example.com', 'Member', 'longenough1').catch(() => {});
    const cookie = await loginSession('pm-const-rest@example.com', 'longenough1');
    const projRes = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'PMCREST', name: 'PMCREST project' }),
    });
    const pid = ((await projRes.json()) as { id: string }).id;

    const res = await SELF.fetch(`https://noriq.test/api/projects/${pid}/memory/constellation`, { method: 'POST', headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      memoryRevision: number; nodeCeiling: number; edgeCeiling: number;
      nodes: unknown[]; edges: unknown[]; omitted: { nodes: number; edges: number; edgesDanglingPruned: number; codeEntitiesExcluded: number };
      coverage: { complete: boolean; reasons: string[] };
    };
    expect(body.nodeCeiling).toBe(CONSTELLATION_NODE_CEILING);
    expect(body.edgeCeiling).toBe(CONSTELLATION_EDGE_CEILING);
    expect(body.nodes).toEqual([]);
    expect(body.coverage.reasons).toContain('graph-empty');
  });

  it('rejects a caller without access to the project, exactly as its memory neighbours do', async () => {
    await createUser('pm-const-owner@example.com', 'Owner', 'longenough1').catch(() => {});
    const ownerCookie = await loginSession('pm-const-owner@example.com', 'longenough1');
    const projRes = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST',
      headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'PMCPRIV', name: 'PMCPRIV project' }),
    });
    const pid = ((await projRes.json()) as { id: string }).id;

    await createUser('pm-const-outsider@example.com', 'Outsider', 'longenough1').catch(() => {});
    const outsiderCookie = await loginSession('pm-const-outsider@example.com', 'longenough1');
    const res = await SELF.fetch(`https://noriq.test/api/projects/${pid}/memory/constellation`, { method: 'POST', headers: { Cookie: outsiderCookie } });
    expect(res.status).toBe(404); // requireProjectAccess's own "unknown and unreachable collapse into one" convention
  });
});
