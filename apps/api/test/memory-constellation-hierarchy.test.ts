import { describe, expect, it } from 'vitest';
import {
  anchorFor, buildConstellationHierarchy, constellationSourceIsCurrent, CONSTELLATION_COMMUNITY_LABEL_MAX_LENGTH, CONSTELLATION_LEAF_SIZE,
  type PriorConstellationCommunity,
} from '../src/memory/constellation-hierarchy';
import type { ConstellationRawEdge, ConstellationRawNode } from '../src/memory/graph-queries';

const node = (i: number, type = 'task', prefix = type): ConstellationRawNode => ({
  nodeId: `n${i}`, uri: `noriq://${type}/${prefix}-${i}`, type, label: `${prefix} ${i}`, createdAt: '2026-01-01T00:00:00.000Z',
});
const edge = (i: number, from: number, to: number, type = 'related_to'): ConstellationRawEdge => ({
  edgeId: `e${i}`, type, fromNodeId: `n${from}`, toNodeId: `n${to}`, provenance: null,
});

function leafCounts(result: ReturnType<typeof buildConstellationHierarchy>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const membership of result.data.memberships) counts.set(membership.communityId, (counts.get(membership.communityId) ?? 0) + 1);
  return counts;
}

describe('anchorFor', () => {
  it('decorrelates every axis for representative persisted community ids', () => {
    for (const id of ['com_02aa3b285e20ccf1', 'com_1f8b0d7a9c3e6254', 'com_fedcba9876543210']) {
      const anchor = anchorFor(id);
      expect(Math.max(...anchor) - Math.min(...anchor)).toBeGreaterThan(0.01);
    }
  });
});

describe('buildConstellationHierarchy', () => {
  it('normalizes a dense universal hub, recursively bounds leaves, and represents every node once', () => {
    const nodes = Array.from({ length: 1_201 }, (_, i) => node(i, i % 11 === 0 ? 'memory' : 'task'));
    const edges = Array.from({ length: 1_200 }, (_, i) => edge(i, 0, i + 1, i % 3 === 0 ? 'depends_on' : 'related_to'));
    const result = buildConstellationHierarchy(nodes, edges);

    expect(result.data.nodeStats).toHaveLength(nodes.length);
    expect(result.data.memberships).toHaveLength(nodes.length);
    expect(new Set(result.data.memberships.map((m) => m.nodeId)).size).toBe(nodes.length);
    expect(Math.max(...leafCounts(result).values())).toBeLessThanOrEqual(CONSTELLATION_LEAF_SIZE);
    expect(result.data.nodeStats.find((n) => n.nodeId === 'n0')!.weightedDegree).toBeLessThan(100);
    expect(result.diagnostics.edgeCount).toBe(edges.length);
  });

  it('retains disconnected islands and isolates honestly without inventing aggregate routes', () => {
    const nodes = Array.from({ length: 12 }, (_, i) => node(i));
    const edges = [edge(0, 0, 1), edge(1, 1, 2), edge(2, 4, 5)];
    const result = buildConstellationHierarchy(nodes, edges);
    expect(result.data.memberships).toHaveLength(12);
    expect(result.data.links).toHaveLength(0);
    expect(result.data.communities.filter((c) => c.parentId === null)).toHaveLength(1);
  });

  it('consolidates sparse components into readable, deterministic semantic roots with short names', () => {
    const types = ['task', 'memory', 'doc', 'file'];
    const nodes = Array.from({ length: 42 }, (_, i) => ({
      ...node(i, types[i % types.length]!),
      label: `Implement the complete long-form project requirement number ${i} with all supporting details and acceptance criteria.`,
    }));
    const edges = [edge(0, 36, 37), edge(1, 38, 39), edge(2, 40, 41)];
    const a = buildConstellationHierarchy(nodes, edges);
    const b = buildConstellationHierarchy([...nodes].reverse(), [...edges].reverse());
    const roots = a.data.communities.filter((community) => community.parentId === null);

    expect(roots.length).toBeGreaterThanOrEqual(3);
    expect(roots.length).toBeLessThanOrEqual(10);
    expect(roots.length).toBeLessThan(39);
    expect(a).toEqual(b);
    expect(a.data.communities.every((community) => community.label.length <= CONSTELLATION_COMMUNITY_LABEL_MAX_LENGTH)).toBe(true);
    expect(a.data.communities.every((community) => !nodes.some((n) => n.label === community.label))).toBe(true);
  });

  it('preserves a bridge as a typed, directed aggregate route when an oversized component splits', () => {
    const nodes = Array.from({ length: 600 }, (_, i) => node(i));
    const edges: ConstellationRawEdge[] = [];
    for (let i = 1; i < 300; i++) edges.push(edge(edges.length, 0, i, 'calls'));
    for (let i = 301; i < 600; i++) edges.push(edge(edges.length, 300, i, 'calls'));
    edges.push(edge(edges.length, 0, 300, 'depends_on'));
    const result = buildConstellationHierarchy(nodes, edges);
    const deepest = Math.max(...result.data.communities.map((c) => c.level));
    const deepestLinks = result.data.links.filter((l) => l.level === deepest);
    expect(deepestLinks.length).toBeGreaterThan(0);
    expect(deepestLinks.reduce((sum, link) => sum + (link.byType.depends_on ?? 0), 0)).toBe(1);
  });

  it('keeps repository, file, symbol, and memory-heavy populations fully reachable', () => {
    const nodes: ConstellationRawNode[] = [node(0, 'repository')];
    for (let i = 1; i <= 40; i++) nodes.push(node(i, i <= 4 ? 'file' : i <= 35 ? 'symbol' : 'memory'));
    const edges = nodes.slice(1).map((_, i) => edge(i, i < 4 ? 0 : 1 + (i % 4), i + 1, i < 4 ? 'declares' : 'related_to'));
    const result = buildConstellationHierarchy(nodes, edges);
    expect(result.data.memberships).toHaveLength(nodes.length);
    expect(result.data.nodeStats.filter((n) => nodes.find((x) => x.nodeId === n.nodeId)?.type === 'symbol')).toHaveLength(31);
    expect(result.data.communities.some((c) => c.typeCounts.memory === 5)).toBe(true);
  });

  it('is byte-deterministic across input ordering and reports dangling/unknown edges', () => {
    const nodes = Array.from({ length: 30 }, (_, i) => node(i, i % 2 ? 'task' : 'memory'));
    const edges = Array.from({ length: 50 }, (_, i) => edge(i, i % 30, (i * 7 + 1) % 30, i % 4 ? 'depends_on' : 'future_relation'));
    edges.push({ ...edge(999, 0, 1), toNodeId: 'missing' });
    const a = buildConstellationHierarchy(nodes, edges);
    const b = buildConstellationHierarchy([...nodes].reverse(), [...edges].reverse());
    expect(b).toEqual(a);
    expect(a.diagnostics.danglingEdges).toBe(1);
    expect(a.diagnostics.unknownEdgeTypes).toEqual(['future_relation']);
  });

  it('reuses an ordinary prior community identity only above the settled overlap threshold', () => {
    const nodes = Array.from({ length: 10 }, (_, i) => node(i));
    const first = buildConstellationHierarchy(nodes, []);
    const prior: PriorConstellationCommunity[] = first.data.communities.map((community) => ({
      id: community.id,
      level: community.level,
      memberUris: first.data.memberships
        .filter((membership) => membership.communityId === community.id)
        .map((membership) => nodes.find((n) => n.nodeId === membership.nodeId)!.uri),
    }));
    const second = buildConstellationHierarchy([...nodes, node(10)], [], prior);
    for (const membership of first.data.memberships) {
      expect(second.data.memberships.find((m) => m.nodeId === membership.nodeId)?.communityId).toBe(membership.communityId);
    }
  });

  it('reconciles raw edge counts at every hierarchy level as internal plus aggregate edges', () => {
    const nodes = Array.from({ length: 700 }, (_, i) => node(i));
    const edges = Array.from({ length: 1_400 }, (_, i) => edge(i, i % 700, (i * 17 + 3) % 700, i % 2 ? 'calls' : 'imports'));
    const result = buildConstellationHierarchy(nodes, edges);
    const maxDepth = result.diagnostics.maxDepth;
    for (let level = 0; level <= maxDepth; level++) {
      const visibleCommunities = result.data.communities.filter((c) => c.level === level || (c.childCount === 0 && c.level < level));
      const internal = visibleCommunities.reduce((sum, c) => sum + c.internalEdgeCount, 0);
      const crossing = result.data.links.filter((l) => l.level === level).reduce((sum, l) => sum + l.count, 0);
      expect(internal + crossing).toBe(edges.length);
    }
  });
});

describe('generation source revision guard', () => {
  it('accepts only the exact canonical revision captured by the build', () => {
    expect(constellationSourceIsCurrent(7, 7)).toBe(true);
    expect(constellationSourceIsCurrent(7, 8)).toBe(false);
  });
});
