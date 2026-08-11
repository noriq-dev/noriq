import { describe, expect, it } from 'vitest';
import type {
  ApiConstellationV2Community, ApiConstellationV2CommunityPage, ApiConstellationV2IncidentPage,
  ApiConstellationV2Overview, ApiConstellationV2Revision,
} from '../api';
import { mergeConstellationCommunityPages } from './MemoryConstellationV2';
import { assembleConstellationV2Scene, evictConstellationPages } from './constellation-v2-scene';

const revision: ApiConstellationV2Revision = { contract: 'constellation-v2', generationId: 'g1', sourceRevision: 1, currentRevision: 1, topologyVersion: 'connectivity-v1', layoutVersion: 'space-v1', state: 'current', generatedAt: 'now' };
const community = (id: string, parentId: string | null = null): ApiConstellationV2Community => ({ id, parentId, level: parentId ? 1 : 0, label: id, memberCount: 2, childCommunityCount: 0, typeCounts: { memory: 1, task: 1 }, internalEdgeCount: 1, internalWeight: 2, normalizedCohesion: 1, boundaryWeight: 2, anchor: [id.charCodeAt(0), 0, 0] });
const overview: ApiConstellationV2Overview = {
  revision, communities: [community('root'), community('other')],
  routes: [{ fromCommunityId: 'root', toCommunityId: 'other', direction: 'forward', count: 1, weight: 2, byType: { depends_on: 1 } }],
  coverage: { complete: true, reasons: [] },
};
const page = (entities: Array<{ nodeId: string; uri: string }>, nextCursor: string | null): ApiConstellationV2CommunityPage => ({
  revision, community: community('leaf', 'root'), kind: 'entities', communities: [],
  entities: entities.map((entity, index) => ({ ...entity, type: index ? 'task' : 'memory', kind: index ? null : 'learning', label: entity.nodeId, authority: index ? null : 4, validity: 'active', isLead: !index, leadReasons: [], degree: 2, boundaryDegree: 1, groupKey: index ? 'task' : 'memory', communityId: 'leaf', position: [index, 0, 0] })),
  backboneEdges: entities.length > 1 ? [{ edgeId: 'backbone', type: 'related_to', fromNodeId: entities[0]!.nodeId, toNodeId: entities[1]!.nodeId, direction: 'forward', provenance: 'test', weight: 1, historical: false }] : [],
  routes: [{ fromCommunityId: 'leaf', toCommunityId: 'other', direction: 'forward', count: 1, weight: 2, byType: { depends_on: 1 } }],
  externalCommunities: [community('other')], nextCursor, coverage: { complete: !nextCursor, reasons: nextCursor ? ['page-limit-reached'] : [] },
});

describe('Constellation v2 scene assembly', () => {
  it('merges pages without duplicating entities and preserves complete reachability', () => {
    const first = page([{ nodeId: 'a', uri: 'noriq://memory/a' }], 'cursor');
    const second = page([{ nodeId: 'b', uri: 'noriq://task/b' }], null);
    const merged = mergeConstellationCommunityPages(first, second);
    expect(merged.entities.map((entity) => entity.nodeId)).toEqual(['a', 'b']);
    expect(merged.nextCursor).toBeNull();
    expect(merged.coverage).toEqual({ complete: true, reasons: [] });
  });

  it('adds bounded inbound/outbound incident detail and truthful off-page community context', () => {
    const merged = page([{ nodeId: 'a', uri: 'noriq://memory/a' }, { nodeId: 'b', uri: 'noriq://task/b' }], null);
    const incidents: ApiConstellationV2IncidentPage = {
      revision, node: { nodeId: 'a', uri: 'noriq://memory/a', type: 'memory', label: 'a', communityPath: [community('root'), community('leaf', 'root')] },
      edges: [
        { edgeId: 'incoming', type: 'supersedes', direction: 'incoming', provenance: 'history', endpoint: { nodeId: 'outside', uri: 'noriq://memory/outside', type: 'memory', label: 'outside', communityPath: [community('outside-root')] } },
        { edgeId: 'outgoing', type: 'validated_by', direction: 'outgoing', provenance: 'verification', endpoint: { nodeId: 'b', uri: 'noriq://task/b', type: 'task', label: 'b', communityPath: [community('root'), community('leaf', 'root')] } },
      ],
      nextCursor: 'more', coverage: { complete: false, reasons: ['page-limit-reached'] },
    };
    const base = assembleConstellationV2Scene(overview, merged, []);
    const selected = assembleConstellationV2Scene(overview, merged, [incidents]);
    expect(base.edges.map((edge) => edge.id)).toEqual(['aggregate:leaf:other', 'raw:backbone']);
    expect(selected.nodes.map((node) => node.id)).toContain('outside-root');
    expect(selected.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'incident:incoming', fromId: 'outside-root', toId: 'a', historical: true, aggregate: true }),
      expect.objectContaining({ id: 'incident:outgoing', fromId: 'a', toId: 'b', aggregate: false }),
    ]));
    expect(selected.partial).toBe(true);
    expect(assembleConstellationV2Scene(overview, merged, []).edges).toEqual(base.edges);
  });

  it('carries memberCount/typeCounts onto every community node and sums boundary route counts from the routes actually rendered (PLNR-438)', () => {
    const scene = assembleConstellationV2Scene(overview, null, []);
    const root = scene.nodes.find((n) => n.id === 'root')!;
    const other = scene.nodes.find((n) => n.id === 'other')!;
    expect(root.memberCount).toBe(2);
    expect(root.typeCounts).toEqual({ memory: 1, task: 1 });
    // overview.routes has a single root<->other route with count: 1 — both endpoints see it.
    expect(root.boundaryRouteCount).toBe(1);
    expect(other.boundaryRouteCount).toBe(1);
  });

  it('sums multiple boundary routes touching the same community, using route.count not route.weight', () => {
    const busyOverview: ApiConstellationV2Overview = {
      revision, communities: [community('hub'), community('a'), community('b')],
      routes: [
        { fromCommunityId: 'hub', toCommunityId: 'a', direction: 'forward', count: 12, weight: 2, byType: {} },
        { fromCommunityId: 'b', toCommunityId: 'hub', direction: 'forward', count: 30, weight: 99, byType: {} },
      ],
      coverage: { complete: true, reasons: [] },
    };
    const scene = assembleConstellationV2Scene(busyOverview, null, []);
    const hub = scene.nodes.find((n) => n.id === 'hub')!;
    expect(hub.boundaryRouteCount).toBe(42); // 12 + 30, not 101 (which would be summing weight instead)
  });

  it('evicts oldest collapsed pages before pinned route pages', () => {
    const result = evictConstellationPages([
      { communityId: 'old', value: 1, nodeCount: 6, touchedAt: 1, pinned: false },
      { communityId: 'new', value: 2, nodeCount: 6, touchedAt: 2, pinned: false },
      { communityId: 'path', value: 3, nodeCount: 6, touchedAt: 0, pinned: true },
    ], 12);
    expect(result.map((entry) => entry.communityId)).toEqual(['new', 'path']);
  });
});
