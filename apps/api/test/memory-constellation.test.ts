// PLNR-284: the bounded constellation endpoint feeding the memory star map.
//
// Two layers, matching the module split this task's own execution spec calls for (SQL in the
// DO, shaping/sampling/coverage in memory/graph-queries.ts's pure `constellation`):
//  - Bounding, tie-break determinism, dangling-edge pruning, and coverage classification are
//    exercised directly against the PURE function with synthetic rows — no workerd/DO needed,
//    and it is the only practical way to exceed the shared 12k resident-node budget in a test.
//  - URI parity with `/memory/search`, provenance passthrough, revision-keyed determinism across
//    real calls, the four distinct degraded states, and the REST route's auth gate are exercised
//    against the real DO/REST stack (same technique as memory-graph-queries.test.ts).
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { buildEntityUri, CONSTELLATION_RESIDENT_NODE_BUDGET, parseEntityUri } from '@noriq-dev/shared';
import {
  constellation, listGraphEntities, CONSTELLATION_NODE_CEILING, CONSTELLATION_EDGE_CEILING, CONSTELLATION_MEMORY_RESERVE,
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
  it('uses the shared 2D/3D resident-node budget and keeps edges at exactly twice it', () => {
    expect(CONSTELLATION_NODE_CEILING).toBe(CONSTELLATION_RESIDENT_NODE_BUDGET);
    expect(CONSTELLATION_EDGE_CEILING).toBe(CONSTELLATION_RESIDENT_NODE_BUDGET * 2);
  });

  it('returns exactly CONSTELLATION_NODE_CEILING nodes when the graph exceeds it, and counts the rest as omitted', () => {
    const total = CONSTELLATION_NODE_CEILING + 5;
    // Zero-padded ids sort lexicographically identically to numerically — with every OTHER
    // scoring input tied, the uri ASC tie-break alone decides which budget-sized prefix survives.
    const width = String(total - 1).length;
    const nodes = Array.from({ length: total }, (_, i) => node(`noriq://task/n${String(i).padStart(width, '0')}`, 'task'));
    const result = constellation(1, { nodes, edges: [], memoryItems: [], episodes: [] }, { codeGraphPopulated: true }, { includeIsolated: true });

    expect(result.nodes).toHaveLength(CONSTELLATION_NODE_CEILING);
    expect(result.omitted.nodes).toBe(5);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.reasons).toContain('row-limit-reached');
    // uri ASC tie-break: the first budget-sized lexicographic prefix survives.
    expect(result.nodes[0]!.uri).toBe(`noriq://task/n${String(0).padStart(width, '0')}`);
    expect(result.nodes.at(-1)!.uri).toBe(`noriq://task/n${String(CONSTELLATION_NODE_CEILING - 1).padStart(width, '0')}`);
    expect(result.nodes.some((n) => n.uri === `noriq://task/n${String(CONSTELLATION_NODE_CEILING).padStart(width, '0')}`)).toBe(false);
  });

  it('returns exactly CONSTELLATION_EDGE_CEILING edges when surviving edges exceed it, independent of node truncation', () => {
    // A complete directed graph sized from the exported ceiling always supplies one excess edge.
    const nodeCount = Math.ceil(Math.sqrt(CONSTELLATION_EDGE_CEILING + 1)) + 2;
    const nodes = Array.from({ length: nodeCount }, (_, i) => node(`noriq://task/n${i}`, 'task'));
    const types = ['depends_on'];
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
    const r1 = constellation(7, { nodes, edges, memoryItems: [], episodes: [] }, { codeGraphPopulated: true }, { includeIsolated: true });
    const r2 = constellation(7, { nodes: [...nodes].reverse(), edges, memoryItems: [], episodes: [] }, { codeGraphPopulated: true }, { includeIsolated: true });

    expect(r1).toEqual(r2);
    // Every input row here ties on degree/authority/validity/createdAt — uri ASC alone orders them.
    expect(r1.nodes.map((n) => n.uri)).toEqual(['noriq://task/a', 'noriq://task/b', 'noriq://task/c']);
  });

  it('breaks a degree/authority/validity tie by createdAt DESC before falling back to uri', () => {
    const nodes = [
      node('noriq://task/older', 'task', { createdAt: '2026-01-01T00:00:00.000Z' }),
      node('noriq://task/newer', 'task', { createdAt: '2026-06-01T00:00:00.000Z' }),
    ];
    const result = constellation(1, { nodes, edges: [], memoryItems: [], episodes: [] }, { codeGraphPopulated: true }, { includeIsolated: true });
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
      { includeIsolated: true },
    );
    const order = result.nodes.map((n) => n.uri);
    // hub (degree 4) outranks the authority-5 decision (degree 0), which outranks the
    // authority-1 hypothesis (degree 0) — degree is the primary signal, authority the bonus.
    expect(order.indexOf('noriq://task/hub')).toBeLessThan(order.indexOf('noriq://memory/mem-strong'));
    expect(order.indexOf('noriq://memory/mem-strong')).toBeLessThan(order.indexOf('noriq://memory/mem-weak'));
  });
});

describe('constellation (pure) — PLNR-339 relationship and memory preservation', () => {
  it('reserves memory representation even when connected coordination nodes would otherwise fill the ceiling', () => {
    const memories = Array.from({ length: 400 }, (_, i) => node(`noriq://memory/m${String(i).padStart(4, '0')}`, 'memory'));
    const tasks = Array.from({ length: CONSTELLATION_NODE_CEILING }, (_, i) => node(`noriq://task/t${String(i).padStart(5, '0')}`, 'task'));
    const edges = Array.from({ length: CONSTELLATION_NODE_CEILING / 2 }, (_, i) => edge('related_to', tasks[i * 2]!.uri, tasks[i * 2 + 1]!.uri));
    const memoryItems = memories.map((_, i) => ({ id: `m${String(i).padStart(4, '0')}`, kind: 'learning', authority: 1, validity: 'active' }));

    const result = constellation(1, { nodes: [...tasks, ...memories], edges, memoryItems, episodes: [] }, { codeGraphPopulated: true });

    expect(result.nodes.filter((n) => n.type === 'memory')).toHaveLength(CONSTELLATION_MEMORY_RESERVE);
    expect(result.sampling.byType.memory).toMatchObject({ total: 400, selected: CONSTELLATION_MEMORY_RESERVE });
  });

  it('keeps every memory when memories fit and the connected core leaves capacity', () => {
    const memories = Array.from({ length: CONSTELLATION_MEMORY_RESERVE + 25 }, (_, i) => node(`noriq://memory/m${i}`, 'memory'));
    const memoryItems = memories.map((_, i) => ({ id: `m${i}`, kind: 'learning', authority: 1, validity: 'active' }));
    const result = constellation(1, { nodes: memories, edges: [], memoryItems, episodes: [] }, { codeGraphPopulated: true });
    expect(result.nodes).toHaveLength(memories.length);
    expect(result.omitted.nodes).toBe(0);
  });

  it('selects connected nodes with an endpoint so every returned connected star retains a visible relationship', () => {
    const nodes = Array.from({ length: CONSTELLATION_NODE_CEILING + 200 }, (_, i) => node(`noriq://task/t${String(i).padStart(5, '0')}`, 'task'));
    const edges = Array.from({ length: nodes.length / 2 }, (_, i) => edge('related_to', nodes[i * 2]!.uri, nodes[i * 2 + 1]!.uri));
    const result = constellation(1, { nodes, edges, memoryItems: [], episodes: [] }, { codeGraphPopulated: true });
    const endpoints = new Set(result.edges.flatMap((e) => [e.fromNodeId, e.toNodeId]));

    expect(result.nodes).toHaveLength(CONSTELLATION_NODE_CEILING);
    expect(result.nodes.every((n) => endpoints.has(n.nodeId))).toBe(true);
    expect(result.sampling.selectedConnectedNodes).toBe(CONSTELLATION_NODE_CEILING);
  });
});

describe('listGraphEntities (pure) — ordered cursor catalogue', () => {
  it('includes files, excludes symbols, sorts explicitly, and advances by stable URI cursor', () => {
    const older = node('noriq://memory/older', 'memory', { createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = node('noriq://memory/newer', 'memory', { createdAt: '2026-02-01T00:00:00.000Z' });
    const file = node('noriq://file/PLNR/repo/a.ts', 'file', { createdAt: '2026-03-01T00:00:00.000Z' });
    const symbol = node('noriq://symbol/PLNR/repo/a.ts#A', 'symbol', { createdAt: '2026-04-01T00:00:00.000Z' });
    const rows = {
      nodes: [older, newer, file, symbol], edges: [], episodes: [],
      memoryItems: [
        { id: 'older', kind: 'learning', authority: 2, validity: 'active' },
        { id: 'newer', kind: 'decision', authority: 5, validity: 'active' },
      ],
    };

    const first = listGraphEntities(9, rows, { sort: 'newest', limit: 2 });
    expect(first.items.map((item) => item.uri)).toEqual([file.uri, newer.uri]);
    expect(first.nextCursor).toBe(newer.uri);
    expect(first.byType).toEqual({ memory: 2, file: 1 });

    const second = listGraphEntities(9, rows, { sort: 'newest', limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.uri)).toEqual([older.uri]);
    expect(second.nextCursor).toBeNull();
  });

  it('supports a memory-only authority order and memory filters', () => {
    const low = node('noriq://memory/low', 'memory');
    const high = node('noriq://memory/high', 'memory');
    const rows = {
      nodes: [low, high], edges: [], episodes: [],
      memoryItems: [
        { id: 'low', kind: 'learning', authority: 1, validity: 'active' },
        { id: 'high', kind: 'decision', authority: 5, validity: 'active' },
      ],
    };
    const page = listGraphEntities(1, rows, { type: 'memory', sort: 'authority', minAuthority: 3 });
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ uri: high.uri, authority: 5, kind: 'decision' });
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
      { includeIsolated: true },
    );
    const n = result.nodes[0]!;
    expect(n.kind).toBe('landed');
    expect(n.authority).toBeNull();
    expect(n.validity).toBeNull();
    expect(n.isLead).toBeNull();
    expect(n.leadReasons).toBeNull();
  });

  it('a coordination node (task/plan/artifact/…) carries null kind/authority/validity/isLead and degree over the eligible graph', () => {
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
    const result = constellation(1, { nodes: [task], edges: [], memoryItems: [], episodes: [] }, { codeGraphPopulated: false }, { includeIsolated: true });
    expect(result.nodes).toHaveLength(1);
    expect(result.coverage.reasons).toEqual(['code-graph-empty']);
    expect(result.coverage.reasons).not.toContain('graph-empty');
  });

  it('a fully populated, indexed project reports complete coverage and includes file landmarks', () => {
    const task = node('noriq://task/t1', 'task');
    const file = node('noriq://file/PROJ/repo-x/a.ts', 'file');
    const result = constellation(1, { nodes: [task, file], edges: [], memoryItems: [], episodes: [] }, { codeGraphPopulated: true }, { includeIsolated: true });
    expect(result.coverage).toEqual({ complete: true, reasons: [] });
    expect(result.nodes.map((n) => n.type).sort()).toEqual(['file', 'task']);
    expect(result.omitted.codeEntitiesExcluded).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------
// PLNR-339: files are first-class landmarks; symbols alone stay excluded. Degree is calculated
// over this eligible graph, so an edge only to a symbol cannot create a fake connected star.
// ---------------------------------------------------------------------------------------
describe('constellation (pure) — PLNR-339 file inclusion and symbol exclusion', () => {
  it('includes files and their relationships while excluding symbol detail', () => {
    const task = node('noriq://task/t1', 'task');
    const file = node('noriq://file/PROJ/repo-x/a.ts', 'file');
    const symbol = node('noriq://symbol/PROJ/repo-x/a.ts#Foo', 'symbol');
    const edges = [edge('depends_on', 'noriq://task/t1', file.uri), edge('imports', file.uri, symbol.uri)];
    const result = constellation(1, { nodes: [task, file, symbol], edges, memoryItems: [], episodes: [] }, { codeGraphPopulated: true });

    expect(result.nodes.map((n) => n.type).sort()).toEqual(['file', 'task']);
    expect(result.nodes.some((n) => n.type === 'symbol')).toBe(false);
    expect(result.edges).toEqual([expect.objectContaining({ type: 'depends_on' })]);
  });

  it('reports excluded symbols by type without counting files as excluded', () => {
    const task = node('noriq://task/t1', 'task');
    const files = Array.from({ length: 7 }, (_, i) => node(`noriq://file/PROJ/repo-x/f${i}.ts`, 'file'));
    const symbols = Array.from({ length: 3 }, (_, i) => node(`noriq://symbol/PROJ/repo-x/s${i}`, 'symbol'));
    const result = constellation(1, { nodes: [task, ...files, ...symbols], edges: [], memoryItems: [], episodes: [] }, { codeGraphPopulated: true });

    expect(result.omitted.codeEntitiesExcluded).toBe(3);
    expect(result.sampling.excludedByType).toEqual({ symbol: 3 });
    expect(result.omitted.isolatedHidden).toBe(8); // task + seven files; symbols are not eligible
  });

  it('isolated files can be explicitly included and consume the ordinary overview budget', () => {
    const coordinationNodes = Array.from({ length: 5 }, (_, i) => node(`noriq://task/t${i}`, 'task'));
    // Far more file nodes than CONSTELLATION_NODE_CEILING — if exclusion happened AFTER sampling
    // (or client-side), these would crowd out every coordination node instead.
    const codeNodes = Array.from({ length: CONSTELLATION_NODE_CEILING * 3 }, (_, i) => node(`noriq://file/PROJ/repo-x/f${i}.ts`, 'file'));
    const result = constellation(1, { nodes: [...coordinationNodes, ...codeNodes], edges: [], memoryItems: [], episodes: [] }, { codeGraphPopulated: true }, { includeIsolated: true });

    expect(result.nodes).toHaveLength(CONSTELLATION_NODE_CEILING);
    expect(result.nodes.some((n) => n.type === 'file')).toBe(true);
    expect(result.omitted.nodes).toBe(CONSTELLATION_NODE_CEILING * 2 + 5);
    expect(result.omitted.codeEntitiesExcluded).toBe(0);
    expect(result.coverage.reasons).toContain('row-limit-reached');
  });

  it('retains an eligible task-to-file edge and reports eligible degree', () => {
    const task = node('noriq://task/t1', 'task');
    const file = node('noriq://file/PROJ/repo-x/a.ts', 'file');
    const edges = [edge('modifies', task.uri, file.uri)];
    const result = constellation(1, { nodes: [task, file], edges, memoryItems: [], episodes: [] }, { codeGraphPopulated: true });

    expect(result.edges).toEqual([expect.objectContaining({ type: 'modifies' })]);
    expect(result.nodes.map((n) => n.degree)).toEqual([1, 1]);
    expect(result.omitted.edgesDanglingPruned).toBe(0);
  });

  it('a project with only an isolated file is non-empty but hidden by the default overview policy', () => {
    const file = node('noriq://file/PROJ/repo-x/a.ts', 'file');
    const result = constellation(1, { nodes: [file], edges: [], memoryItems: [], episodes: [] }, { codeGraphPopulated: true });

    expect(result.nodes).toEqual([]);
    expect(result.omitted.codeEntitiesExcluded).toBe(0);
    expect(result.omitted.isolatedHidden).toBe(1);
    expect(result.coverage.reasons).not.toContain('graph-empty');
  });

  it('does not count a file-to-symbol edge toward the file\'s visible degree', () => {
    const file = node('noriq://file/PROJ/repo-x/a.ts', 'file');
    const symbol = node('noriq://symbol/PROJ/repo-x/a.ts#Foo', 'symbol');
    const result = constellation(
      1,
      { nodes: [file, symbol], edges: [edge('declares', file.uri, symbol.uri)], memoryItems: [], episodes: [] },
      { codeGraphPopulated: true },
      { includeIsolated: true },
    );
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.type).toBe('file');
    expect(result.nodes[0]!.degree).toBe(0);
    expect(result.sampling.totalEligibleEdges).toBe(0);
    expect(result.omitted.edgesExcludedEndpoint).toBe(1);
    expect(result.omitted.edgesDanglingPruned).toBe(0);
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
  constellation(pid: string, options?: { includeIsolated?: boolean }): Promise<{
    memoryRevision: number;
    nodeCeiling: number;
    edgeCeiling: number;
    nodes: Array<{ nodeId: string; uri: string; type: string; label: string; provenance?: unknown }>;
    edges: Array<{ type: string; fromNodeId: string; toNodeId: string; provenance: string | null }>;
    omitted: { nodes: number; edges: number; edgesDanglingPruned: number; edgesExcludedEndpoint: number; codeEntitiesExcluded: number; isolatedHidden: number };
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
    const result = await memory(projectId).constellation(projectId, { includeIsolated: true });
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.coverage.reasons).toContain('graph-empty');
  });

  it('a project with coordination nodes but no repository index reports code-graph-empty, not graph-empty', async () => {
    const { token, projectId } = await newOwnedProject('pm-const-unidx@example.com', 'PMCONUIX');
    await mcpCall(token, 'create_task', { tags: ['test-fixture'], projectId, title: 'unindexed project task' });
    await memory(projectId).rebuildProjection(projectId);

    const result = await memory(projectId).constellation(projectId, { includeIsolated: true });
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

describe('POST /api/projects/:pid/memory/entities (REST)', () => {
  it('returns an explicitly ordered memory page with a stable cursor shape', async () => {
    await createUser('pm-entities-rest@example.com', 'Member', 'longenough1').catch(() => {});
    const cookie = await loginSession('pm-entities-rest@example.com', 'longenough1');
    const projRes = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'PMERST', name: 'PMERST project' }),
    });
    const pid = ((await projRes.json()) as { id: string }).id;
    await memory(pid).recordMemory(pid, { kind: 'learning', statement: 'catalogued memory', actor: SYSTEM });

    const res = await SELF.fetch(`https://noriq.test/api/projects/${pid}/memory/entities`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'memory', sort: 'newest', limit: 50 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { sort: string; total: number; items: Array<{ type: string; label: string }>; nextCursor: string | null };
    expect(body).toMatchObject({ sort: 'newest', total: 1, nextCursor: null });
    expect(body.items).toEqual([expect.objectContaining({ type: 'memory', label: 'catalogued memory' })]);
  });
});
