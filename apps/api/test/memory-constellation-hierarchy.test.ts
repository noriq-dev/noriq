import { describe, expect, it } from 'vitest';
import {
  anchorFor,
  buildConstellationHierarchy,
  constellationSourceIsCurrent,
  CONSTELLATION_COMMUNITY_LABEL_MAX_LENGTH,
  CONSTELLATION_LEAF_SIZE,
  CONSTELLATION_TOPOLOGY_VERSION,
} from '../src/memory/constellation-hierarchy';
import type { ConstellationRawEdge, ConstellationRawNode } from '../src/memory/graph-queries';

const node = (id: string, type = 'task', label = id): ConstellationRawNode => ({
  nodeId: id,
  uri: `noriq://${type}/${id}`,
  type,
  label,
  createdAt: '2026-01-01T00:00:00.000Z',
});
const edge = (id: string, fromNodeId: string, toNodeId: string, type = 'related_to'): ConstellationRawEdge => ({
  edgeId: id, type, fromNodeId, toNodeId, provenance: null,
});

const rootForNode = (result: ReturnType<typeof buildConstellationHierarchy>, nodeId: string) => {
  const communities = new Map(result.data.communities.map((community) => [community.id, community]));
  let community = communities.get(result.data.memberships.find((membership) => membership.nodeId === nodeId)!.communityId)!;
  while (community.parentId) community = communities.get(community.parentId)!;
  return community;
};

describe('anchorFor', () => {
  it('decorrelates every axis for representative persisted community ids', () => {
    for (const id of ['com_02aa3b285e20ccf1', 'com_1f8b0d7a9c3e6254', 'com_fedcba9876543210']) {
      const anchor = anchorFor(id);
      expect(Math.max(...anchor) - Math.min(...anchor)).toBeGreaterThan(0.01);
    }
  });
});

describe('anchor-lens hierarchy', () => {
  it('uses the anchor-lens topology generation', () => {
    expect(CONSTELLATION_TOPOLOGY_VERSION).toBe('anchor-lens-v1');
  });

  it('seeds exactly one root per plan, labels it from the anchor, and leaves disconnected base entities ambient', () => {
    const nodes = [
      node('plan_a', 'plan', 'Project Memory'), node('a1'), node('a2'),
      node('plan_b', 'plan', 'Security &amp; correctness remediation across every access boundary'), node('b1'),
      node('loose_1'), node('loose_2'),
    ];
    const edges = [
      edge('e1', 'plan_a', 'a1'), edge('e2', 'a1', 'a2'),
      edge('e3', 'plan_b', 'b1'), edge('bridge', 'plan_a', 'plan_b', 'depends_on'),
    ];
    const result = buildConstellationHierarchy(nodes, edges, 'plans');
    const roots = result.data.communities.filter((community) => community.parentId === null);

    expect(roots).toHaveLength(2);
    expect(roots.map((root) => root.coreNodeId).sort()).toEqual(['plan_a', 'plan_b']);
    expect(roots.find((root) => root.coreNodeId === 'plan_a')).toMatchObject({ label: 'Project Memory' });
    const bounded = roots.find((root) => root.coreNodeId === 'plan_b')!.label;
    expect(bounded).toContain('Security & correctness');
    expect(bounded).toHaveLength(CONSTELLATION_COMMUNITY_LABEL_MAX_LENGTH);
    expect(bounded.endsWith('…')).toBe(true);
    expect(result.data.ambientNodeIds).toEqual(['loose_1', 'loose_2']);
    expect(result.data.memberships.map((membership) => membership.nodeId).sort()).toEqual(
      ['a1', 'a2', 'b1', 'plan_a', 'plan_b'],
    );
    expect(result.data.links.filter((link) => link.level === 0)).toEqual([
      expect.objectContaining({ count: 1, byType: { depends_on: 1 } }),
    ]);
  });

  it('uses hop count before cumulative weight', () => {
    const nodes = [node('plan_a', 'plan'), node('plan_b', 'plan'), node('middle'), node('target')];
    const edges = [
      edge('strong_1', 'plan_a', 'middle', 'calls'), edge('strong_2', 'middle', 'target', 'calls'),
      edge('weak_direct', 'plan_b', 'target', 'related_to'),
    ];
    const result = buildConstellationHierarchy(nodes, edges, 'plans');
    expect(rootForNode(result, 'target').coreNodeId).toBe('plan_b');
  });

  it('uses strongest cumulative path weight for equal hops, then canonical anchor URI for an exact tie', () => {
    const weighted = buildConstellationHierarchy(
      [node('plan_a', 'plan'), node('plan_b', 'plan'), node('target')],
      [edge('weak', 'plan_a', 'target'), edge('strong', 'plan_b', 'target', 'calls')],
      'plans',
    );
    expect(rootForNode(weighted, 'target').coreNodeId).toBe('plan_b');

    const tied = buildConstellationHierarchy(
      [node('plan_z', 'plan'), node('plan_a', 'plan'), node('target')],
      [edge('one', 'plan_z', 'target'), edge('two', 'plan_a', 'target')],
      'plans',
    );
    expect(rootForNode(tied, 'target').coreNodeId).toBe('plan_a');
  });

  it('makes a zero-anchor memories lens valid with every entity in the ambient field', () => {
    const nodes = [node('task_a'), node('task_b'), node('plan_a', 'plan')];
    const result = buildConstellationHierarchy(nodes, [edge('e', 'task_a', 'task_b')], 'memories');
    expect(result.data.communities).toEqual([]);
    expect(result.data.memberships).toEqual([]);
    expect(result.data.links).toEqual([]);
    expect(result.data.ambientNodeIds).toEqual(['plan_a', 'task_a', 'task_b']);
    expect(result.data.nodeStats).toHaveLength(3);
  });

  it('uses memory anchors only in the memories lens and never promotes base entity types', () => {
    const nodes = [node('memory_a', 'memory', 'API decision'), node('task_a'), node('file_a', 'file'), node('plan_a', 'plan')];
    const edges = [edge('e1', 'memory_a', 'task_a', 'observed_in'), edge('e2', 'task_a', 'file_a', 'modifies')];
    const result = buildConstellationHierarchy(nodes, edges, 'memories');
    expect(result.data.communities.filter((community) => community.parentId === null)).toEqual([
      expect.objectContaining({ label: 'API decision', coreNodeId: 'memory_a', memberCount: 3 }),
    ]);
    expect(result.data.ambientNodeIds).toEqual(['plan_a']);
  });

  it('keeps other-lens anchors visible: reachable ones join a system and unreachable ones are ambient', () => {
    const nodes = [
      node('plan_a', 'plan'), node('task_a'),
      node('memory_linked', 'memory'), node('memory_unlinked', 'memory'),
    ];
    const edges = [
      edge('plan_task', 'plan_a', 'task_a'),
      edge('memory_evidence', 'memory_linked', 'task_a', 'observed_in'),
    ];

    const plans = buildConstellationHierarchy(nodes, edges, 'plans');
    expect(rootForNode(plans, 'memory_linked').coreNodeId).toBe('plan_a');
    expect(plans.data.ambientNodeIds).toEqual(['memory_unlinked']);

    const memories = buildConstellationHierarchy(nodes, edges, 'memories');
    expect(rootForNode(memories, 'plan_a').coreNodeId).toBe('memory_linked');
    expect(rootForNode(memories, 'task_a').coreNodeId).toBe('memory_linked');
    expect(rootForNode(memories, 'memory_unlinked').coreNodeId).toBe('memory_unlinked');
    expect(memories.data.ambientNodeIds).toEqual([]);
  });

  it('recurses inside an oversized anchored system while preserving the anchor as the root core', () => {
    const nodes = [node('plan_a', 'plan', 'Large system'), ...Array.from({ length: 600 }, (_, i) => node(`task_${i}`))];
    const edges = nodes.slice(1).map((task, index) => edge(`e${index}`, 'plan_a', task.nodeId, 'related_to'));
    const result = buildConstellationHierarchy(nodes, edges, 'plans');
    const root = result.data.communities.find((community) => community.parentId === null)!;

    expect(root).toMatchObject({ coreNodeId: 'plan_a', memberCount: 601 });
    expect(root.childCount).toBeGreaterThan(0);
    const membershipCounts = new Map<string, number>();
    for (const membership of result.data.memberships) {
      membershipCounts.set(membership.communityId, (membershipCounts.get(membership.communityId) ?? 0) + 1);
    }
    expect(Math.max(...membershipCounts.values())).toBeLessThanOrEqual(CONSTELLATION_LEAF_SIZE);
    expect(result.data.memberships).toHaveLength(nodes.length);
  });

  it('is byte-deterministic across input ordering', () => {
    const nodes = [node('plan_a', 'plan'), node('plan_b', 'plan'), ...Array.from({ length: 20 }, (_, i) => node(`task_${i}`))];
    const edges = nodes.slice(2).map((task, i) => edge(`e${i}`, i % 2 ? 'plan_a' : 'plan_b', task.nodeId, i % 3 ? 'related_to' : 'depends_on'));
    const a = buildConstellationHierarchy(nodes, edges, 'plans');
    const b = buildConstellationHierarchy([...nodes].reverse(), [...edges].reverse(), 'plans');
    expect(b).toEqual(a);
  });
});

describe('generation source revision guard', () => {
  it('accepts only the exact canonical revision captured by the build', () => {
    expect(constellationSourceIsCurrent(7, 7)).toBe(true);
    expect(constellationSourceIsCurrent(7, 8)).toBe(false);
  });
});
