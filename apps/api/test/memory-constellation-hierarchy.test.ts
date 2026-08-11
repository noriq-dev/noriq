import { describe, expect, it } from 'vitest';
import {
  anchorFor, buildConstellationHierarchy, constellationSourceIsCurrent, CONSTELLATION_COMMUNITY_LABEL_MAX_LENGTH,
  CONSTELLATION_LEAF_SIZE, CONSTELLATION_MAX_CHILDREN,
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

function measuredPlanClusterFixture(): { nodes: ConstellationRawNode[]; edges: ConstellationRawEdge[] } {
  const nodes: ConstellationRawNode[] = [
    { ...node(0, 'plan'), label: 'Project Memory and Constellation Intelligence Platform Expansion' },
    ...Array.from({ length: 10 }, (_, i) => ({ ...node(i + 1), label: `Memory system task ${i + 1}` })),
    { ...node(11, 'plan'), label: 'Security Remediation' },
    ...Array.from({ length: 10 }, (_, i) => ({ ...node(i + 12), label: `Security system task ${i + 1}` })),
    ...Array.from({ length: 20 }, (_, i) => ({ ...node(i + 22), label: `Disconnected backlog task ${i + 1}` })),
  ];
  const edges: ConstellationRawEdge[] = [];
  for (let i = 1; i <= 10; i++) edges.push(edge(edges.length, 0, i));
  for (let i = 12; i <= 21; i++) edges.push(edge(edges.length, 11, i));
  edges.push(edge(edges.length, 0, 11, 'depends_on'));
  return { nodes, edges };
}

function oversizedClusterFixture(): { nodes: ConstellationRawNode[]; edges: ConstellationRawEdge[] } {
  const clusterSize = 251;
  const nodes = Array.from({ length: clusterSize * 2 }, (_, i) => ({
    ...node(i),
    label: `Implement the complete subsystem requirement number ${i} with all supporting details and acceptance criteria.`,
  }));
  const edges: ConstellationRawEdge[] = [];
  for (const start of [0, clusterSize]) {
    for (let i = 0; i < clusterSize; i++) {
      for (let j = i + 1; j < clusterSize; j++) {
        edges.push(edge(edges.length, start + i, start + j, 'calls'));
      }
    }
  }
  edges.push(edge(edges.length, 0, clusterSize, 'depends_on'));
  edges.push(edge(edges.length, 1, clusterSize + 1, 'depends_on'));
  return { nodes, edges };
}

function rootMemberSets(result: ReturnType<typeof buildConstellationHierarchy>): string[][] {
  const communities = new Map(result.data.communities.map((community) => [community.id, community]));
  const rootFor = (id: string) => {
    let community = communities.get(id)!;
    while (community.parentId) community = communities.get(community.parentId)!;
    return community.id;
  };
  const members = new Map<string, string[]>();
  for (const membership of result.data.memberships) {
    const root = rootFor(membership.communityId);
    const group = members.get(root) ?? [];
    group.push(membership.nodeId);
    members.set(root, group);
  }
  return [...members.values()].map((group) => group.sort()).sort((a, b) => a[0]!.localeCompare(b[0]!));
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
    expect(roots.map((community) => community.label).sort()).toEqual(['Docs', 'Files', 'Memories', 'Tasks']);
    expect(a).toEqual(b);
    expect(a.data.communities.every((community) => community.label.length <= CONSTELLATION_COMMUNITY_LABEL_MAX_LENGTH)).toBe(true);
    expect(a.data.communities.every((community) => !nodes.some((n) => n.label === community.label))).toBe(true);
  });

  it('promotes measured plan systems with curated labels and routes while bucketing singleton tasks', () => {
    const { nodes, edges } = measuredPlanClusterFixture();
    const first = buildConstellationHierarchy(nodes, edges);
    const second = buildConstellationHierarchy(nodes, edges);
    const roots = first.data.communities.filter((community) => community.parentId === null);
    const singletonBucket = roots.find((community) => community.label === 'Tasks');
    const security = roots.find((community) => community.label === 'Security Remediation');
    const memory = roots.find((community) => community.label.endsWith('…'));

    expect(roots).toHaveLength(3);
    expect(singletonBucket).toMatchObject({ memberCount: 20, typeCounts: { task: 20 } });
    expect(security).toMatchObject({ memberCount: 11, typeCounts: { plan: 1, task: 10 } });
    expect(memory).toMatchObject({ memberCount: 11, typeCounts: { plan: 1, task: 10 } });
    expect(memory!.label).toHaveLength(CONSTELLATION_COMMUNITY_LABEL_MAX_LENGTH);
    const rootRoutes = first.data.links.filter((link) => link.level === 0);
    expect(rootRoutes).toEqual([
      expect.objectContaining({
        fromCommunityId: expect.stringMatching(/^com_/), toCommunityId: expect.stringMatching(/^com_/),
        count: 1, byType: { depends_on: 1 },
      }),
    ]);
    expect(rootMemberSets(second)).toEqual(rootMemberSets(first));
  });

  it('promotes one cohesive ten-node component as its own root', () => {
    const nodes = Array.from({ length: 10 }, (_, i) => node(i));
    const edges = Array.from({ length: 10 }, (_, i) => edge(i, i, (i + 1) % 10, 'calls'));
    const result = buildConstellationHierarchy(nodes, edges);
    expect(result.data.communities.filter((community) => community.parentId === null)).toEqual([
      expect.objectContaining({ label: 'Tasks', memberCount: 10, childCount: 0 }),
    ]);
  });

  it('decodes an escaped plan title before applying the root-label bound', () => {
    const nodes = [
      { ...node(0, 'plan'), label: 'Security &amp; correctness remediation across every access boundary' },
      ...Array.from({ length: 9 }, (_, i) => node(i + 1)),
    ];
    const edges = Array.from({ length: 9 }, (_, i) => edge(i, 0, i + 1));
    const result = buildConstellationHierarchy(nodes, edges);
    const label = result.data.communities.find((community) => community.parentId === null)!.label;

    expect(label).toContain('Security & correctness');
    expect(label).not.toContain('&amp;');
    expect(label).toHaveLength(CONSTELLATION_COMMUNITY_LABEL_MAX_LENGTH);
    expect(label.endsWith('…')).toBe(true);
  });

  it('wraps promoted roots and residual type buckets together at the global child cap', () => {
    const componentCount = CONSTELLATION_MAX_CHILDREN + 1;
    const nodes: ConstellationRawNode[] = [];
    const edges: ConstellationRawEdge[] = [];
    for (let component = 0; component < componentCount; component++) {
      const start = component * 8;
      for (let i = 0; i < 8; i++) nodes.push(node(start + i));
      for (let i = 0; i < 8; i++) edges.push(edge(edges.length, start + i, start + ((i + 1) % 8), 'calls'));
    }
    nodes.push(node(componentCount * 8, 'memory'));
    const result = buildConstellationHierarchy(nodes, edges);
    const roots = result.data.communities.filter((community) => community.parentId === null);

    expect(roots.map((community) => community.childCount).sort((a, b) => a - b)).toEqual([2, CONSTELLATION_MAX_CHILDREN]);
    expect(roots.reduce((sum, community) => sum + community.memberCount, 0)).toBe(nodes.length);
    expect(result.data.communities.filter((community) => community.level === 1)).toHaveLength(componentCount + 1);
    expect(result.data.memberships).toHaveLength(nodes.length);
  });

  it('promotes deterministic structural communities and their boundary routes from an oversized component', () => {
    const { nodes, edges } = oversizedClusterFixture();
    const first = buildConstellationHierarchy(nodes, edges);
    const second = buildConstellationHierarchy(nodes, edges);
    const roots = first.data.communities.filter((community) => community.parentId === null);

    expect(roots.length).toBeGreaterThan(1);
    expect(roots.length).toBeLessThanOrEqual(CONSTELLATION_MAX_CHILDREN);
    expect(roots.every((community) => community.memberCount >= 8)).toBe(true);
    expect(roots.reduce((sum, community) => sum + community.memberCount, 0)).toBe(nodes.length);
    expect(roots.every((community) => community.label.length <= CONSTELLATION_COMMUNITY_LABEL_MAX_LENGTH)).toBe(true);
    expect(roots.every((community) => !nodes.some((n) => n.label === community.label))).toBe(true);
    const rootRoutes = first.data.links.filter((link) => link.level === 0);
    expect(rootRoutes.length).toBeGreaterThan(0);
    expect(rootRoutes.reduce((sum, route) => sum + (route.byType.depends_on ?? 0), 0)).toBe(2);
    expect(rootMemberSets(second)).toEqual(rootMemberSets(first));
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
    const roots = result.data.communities.filter((community) => community.parentId === null);
    expect(roots.reduce((sum, community) => sum + (community.typeCounts.memory ?? 0), 0)).toBe(5);
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
