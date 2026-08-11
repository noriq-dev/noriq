import type {
  ApiConstellationV2Community, ApiConstellationV2CommunityPage, ApiConstellationV2IncidentPage,
  ApiConstellationV2Overview,
} from '../api';
import type { Constellation3DEdge, Constellation3DNode } from './constellation-3d-buffers';

export const CONSTELLATION_V2_RESIDENT_NODE_BUDGET = 12_000;

export interface ConstellationV2Scene {
  nodes: Constellation3DNode[];
  edges: Constellation3DEdge[];
  currentCommunity: ApiConstellationV2Community | null;
  partial: boolean;
}
const communityNode = (community: ApiConstellationV2Community, boundaryRouteCount = 0): Constellation3DNode => ({
  id: community.id, uri: null, label: community.label, type: 'community', position: community.anchor,
  degree: community.internalEdgeCount, community: true, parentId: community.parentId,
  radius: Math.max(45, Math.min(180, Math.sqrt(community.memberCount) * 9)),
  memberCount: community.memberCount, typeCounts: community.typeCounts, boundaryRouteCount,
});

export function assembleConstellationV2Scene(
  overview: ApiConstellationV2Overview,
  page: ApiConstellationV2CommunityPage | null,
  incidentPages: ApiConstellationV2IncidentPage[],
): ConstellationV2Scene {
  const nodes = new Map<string, Constellation3DNode>();
  const edges = new Map<string, Constellation3DEdge>();
  const visibleCommunities = page
    ? page.kind === 'communities' ? page.communities : []
    : overview.communities;
  // Sum of underlying-edge counts (route.count, not route.weight) across every boundary route
  // touching a community — the "N boundary routes" figure the hover tooltip states (PLNR-438).
  // Computed from the same route list `assembleConstellationV2Scene` already uses for edges below,
  // so it can never disagree with what the scene actually renders.
  const boundaryRouteCounts = new Map<string, number>();
  for (const route of page?.routes ?? overview.routes) {
    boundaryRouteCounts.set(route.fromCommunityId, (boundaryRouteCounts.get(route.fromCommunityId) ?? 0) + route.count);
    boundaryRouteCounts.set(route.toCommunityId, (boundaryRouteCounts.get(route.toCommunityId) ?? 0) + route.count);
  }
  for (const community of [...visibleCommunities, ...(page?.externalCommunities ?? [])]) {
    nodes.set(community.id, communityNode(community, boundaryRouteCounts.get(community.id) ?? 0));
  }
  for (const entity of page?.entities ?? []) nodes.set(entity.nodeId, {
    id: entity.nodeId, uri: entity.uri, label: entity.label, type: entity.type, position: entity.position,
    degree: entity.degree, authority: entity.authority, validity: entity.validity, isLead: entity.isLead,
    parentId: entity.communityId,
  });
  for (const route of page?.routes ?? overview.routes) edges.set(`aggregate:${route.fromCommunityId}:${route.toCommunityId}`, {
    id: `aggregate:${route.fromCommunityId}:${route.toCommunityId}`, fromId: route.fromCommunityId, toId: route.toCommunityId,
    type: Object.entries(route.byType).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? 'related_to',
    direction: route.direction, weight: route.weight, aggregate: true,
  });
  for (const edge of page?.backboneEdges ?? []) edges.set(`raw:${edge.edgeId}`, {
    id: `raw:${edge.edgeId}`, fromId: edge.fromNodeId, toId: edge.toNodeId, type: edge.type,
    direction: 'forward', weight: edge.weight, aggregate: false, provenance: edge.provenance, historical: edge.historical,
  });

  for (const incidentPage of incidentPages) {
    for (const incident of incidentPage.edges) {
      let endpointId = incident.endpoint.nodeId;
      if (!nodes.has(endpointId)) {
        const containing = incident.endpoint.communityPath.at(-1);
        if (!containing) continue;
        endpointId = containing.id;
        if (!nodes.has(endpointId)) nodes.set(endpointId, communityNode(containing));
      }
      const outgoing = incident.direction === 'outgoing';
      edges.set(`incident:${incident.edgeId}`, {
        id: `incident:${incident.edgeId}`, fromId: outgoing ? incidentPage.node.nodeId : endpointId,
        toId: outgoing ? endpointId : incidentPage.node.nodeId, type: incident.type, direction: 'forward',
        weight: 5, aggregate: endpointId !== incident.endpoint.nodeId, provenance: incident.provenance,
        historical: incident.type === 'supersedes' || incident.type === 'contradicts',
      });
    }
  }
  return {
    nodes: [...nodes.values()], edges: [...edges.values()], currentCommunity: page?.community ?? null,
    partial: Boolean(page && (!page.coverage.complete || page.nextCursor)) || incidentPages.some((incident) => !incident.coverage.complete || incident.nextCursor),
  };
}

export interface ResidentConstellationPage<T> { communityId: string; value: T; nodeCount: number; touchedAt: number; pinned: boolean }

/** LRU eviction for collapsed/off-route pages. Pinned path pages are never evicted; if those alone
 * exceed the budget the caller must stop expanding instead of silently dropping visible data. */
export function evictConstellationPages<T>(pages: ResidentConstellationPage<T>[], budget = CONSTELLATION_V2_RESIDENT_NODE_BUDGET): ResidentConstellationPage<T>[] {
  const result = [...pages];
  let resident = result.reduce((sum, page) => sum + page.nodeCount, 0);
  for (const candidate of result.filter((page) => !page.pinned).sort((a, b) => a.touchedAt - b.touchedAt || a.communityId.localeCompare(b.communityId))) {
    if (resident <= budget) break;
    result.splice(result.indexOf(candidate), 1);
    resident -= candidate.nodeCount;
  }
  return result;
}
