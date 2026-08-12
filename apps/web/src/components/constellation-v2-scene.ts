import type {
  ApiConstellationV2Community, ApiConstellationV2CommunityPage, ApiConstellationV2IncidentPage,
  ApiConstellationV2Overview,
} from '../api';
import { CONSTELLATION_RESIDENT_NODE_BUDGET } from '@noriq-dev/shared';
import {
  constellation3DCommunityWellScale, type Constellation3DEdge, type Constellation3DNode,
} from './constellation-3d-buffers';

/** Compatibility name retained for existing scene/loader consumers; the value is shared with
 * the 2D fallback endpoint rather than independently tuned here. */
export const CONSTELLATION_V2_RESIDENT_NODE_BUDGET = CONSTELLATION_RESIDENT_NODE_BUDGET;

/** An incident edge TYPE that reads as superseded/replaced rather than a live relationship — the
 * one predicate this scene assembler treats as historical for a raw incident edge (backbone edges
 * instead carry a server-computed `historical` flag verbatim, no client-side guess needed). Exported
 * so ConstellationInspector.tsx's relationship-list rows apply the EXACT same test the canvas
 * promoted-edge pass already uses below — a row must never disagree with the 3D scene about which
 * relationships are historical (PLNR-440, mirroring the "one colour source" rule constellation-encoding.ts
 * already established for types). */
export function isHistoricalIncidentEdgeType(type: string): boolean {
  return type === 'supersedes' || type === 'contradicts';
}

export interface ConstellationV2Scene {
  nodes: Constellation3DNode[];
  edges: Constellation3DEdge[];
}
const communityNode = (community: ApiConstellationV2Community, boundaryRouteCount = 0): Constellation3DNode => ({
  id: community.id, uri: null, label: community.label, type: 'community', position: community.anchor,
  degree: community.internalEdgeCount, community: true, systemId: community.id,
  communityLevel: community.level, parentId: community.parentId,
  // The layout parent clamp must contain the server's 0.75× well-radius member cloud; using the
  // well itself here keeps every scattered member inside without shrinking mid-sized systems.
  radius: constellation3DCommunityWellScale({ community: true, memberCount: community.memberCount, scale: 0 }),
  memberCount: community.memberCount, typeCounts: community.typeCounts, boundaryRouteCount,
});

export function assembleConstellationV2Scene(
  overview: ApiConstellationV2Overview,
  residentPages: ApiConstellationV2CommunityPage | readonly ApiConstellationV2CommunityPage[] | null,
  incidentPages: ApiConstellationV2IncidentPage[],
): ConstellationV2Scene {
  const pages = residentPages === null ? [] : Array.isArray(residentPages) ? residentPages : [residentPages];
  const nodes = new Map<string, Constellation3DNode>();
  const edges = new Map<string, Constellation3DEdge>();
  const routes = new Map<string, (typeof overview.routes)[number]>();
  for (const route of overview.routes) routes.set(`${route.fromCommunityId}:${route.toCommunityId}`, route);
  for (const page of pages) {
    for (const route of page.routes) routes.set(`${route.fromCommunityId}:${route.toCommunityId}`, route);
  }
  // Sum of underlying-edge counts (route.count, not route.weight) across every boundary route
  // touching a community — the "N boundary routes" figure the hover tooltip states (PLNR-438).
  // Computed from the same route list `assembleConstellationV2Scene` already uses for edges below,
  // so it can never disagree with what the scene actually renders.
  const boundaryRouteCounts = new Map<string, number>();
  for (const route of routes.values()) {
    boundaryRouteCounts.set(route.fromCommunityId, (boundaryRouteCounts.get(route.fromCommunityId) ?? 0) + route.count);
    boundaryRouteCounts.set(route.toCommunityId, (boundaryRouteCounts.get(route.toCommunityId) ?? 0) + route.count);
  }
  const communities = new Map<string, ApiConstellationV2Community>();
  for (const community of overview.communities) communities.set(community.id, community);
  for (const page of pages) {
    for (const community of [page.community, ...page.communities, ...page.externalCommunities]) {
      communities.set(community.id, community);
    }
  }
  const entities = new Map(pages.flatMap((page) => page.entities).map((entity) => [entity.nodeId, entity]));
  const rootCommunityId = (communityId: string): string => {
    let current = communities.get(communityId);
    while (current?.parentId) current = communities.get(current.parentId);
    return current?.id ?? communityId;
  };
  // A resident system's real plan/memory anchor replaces the synthetic sphere as the rendered sun.
  // Community ids still key server routes/pages; render ids key selection and therefore become the
  // anchor entity id only when that real entity is present in the resident page.
  const communityRenderIds = new Map<string, string>();
  for (const community of communities.values()) {
    communityRenderIds.set(community.id, community.coreNodeId && entities.has(community.coreNodeId) ? community.coreNodeId : community.id);
  }
  for (const community of [...communities.values()].sort((a, b) => a.level - b.level || a.id.localeCompare(b.id))) {
    const renderId = communityRenderIds.get(community.id)!;
    const parentRenderId = community.parentId ? communityRenderIds.get(community.parentId) ?? community.parentId : null;
    const residentRootId = rootCommunityId(community.id);
    const core = community.coreNodeId ? entities.get(community.coreNodeId) : undefined;
    if (core) {
      nodes.set(renderId, {
        id: core.nodeId, uri: core.uri, label: core.label, type: core.type, position: community.anchor,
        degree: community.internalEdgeCount, authority: core.authority, validity: core.validity, isLead: core.isLead,
        community: true, anchorEntity: true, systemId: community.id, residentRootId,
        communityLevel: community.level, parentId: parentRenderId,
        radius: constellation3DCommunityWellScale({ community: true, memberCount: community.memberCount, scale: 0, communityLevel: community.level }),
        memberCount: community.memberCount, typeCounts: community.typeCounts,
        boundaryRouteCount: boundaryRouteCounts.get(community.id) ?? 0,
      });
    } else {
      nodes.set(renderId, {
        ...communityNode(community, boundaryRouteCounts.get(community.id) ?? 0),
        parentId: parentRenderId, residentRootId,
      });
    }
  }
  for (const entity of entities.values()) {
    if ([...communities.values()].some((community) => community.coreNodeId === entity.nodeId)) continue;
    const communityId = entity.communityId;
    nodes.set(entity.nodeId, {
      id: entity.nodeId, uri: entity.uri, label: entity.label, type: entity.type, position: entity.position,
      degree: entity.degree, authority: entity.authority, validity: entity.validity, isLead: entity.isLead,
      parentId: communityId ? communityRenderIds.get(communityId) ?? communityId : null,
      residentRootId: communityId ? rootCommunityId(communityId) : undefined,
    });
  }
  for (const entity of overview.ambient?.entities ?? []) nodes.set(entity.nodeId, {
    id: entity.nodeId, uri: entity.uri, label: entity.label, type: entity.type, position: entity.position,
    degree: entity.degree, authority: entity.authority, validity: entity.validity, isLead: entity.isLead,
    parentId: null, ambient: true,
  });
  for (const route of routes.values()) edges.set(`aggregate:${route.fromCommunityId}:${route.toCommunityId}`, {
    id: `aggregate:${route.fromCommunityId}:${route.toCommunityId}`,
    fromId: communityRenderIds.get(route.fromCommunityId) ?? route.fromCommunityId,
    toId: communityRenderIds.get(route.toCommunityId) ?? route.toCommunityId,
    type: Object.entries(route.byType).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? 'related_to',
    direction: route.direction, weight: route.weight, aggregate: true,
  });
  for (const page of pages) {
    for (const edge of page.backboneEdges) edges.set(`raw:${edge.edgeId}`, {
      id: `raw:${edge.edgeId}`, fromId: edge.fromNodeId, toId: edge.toNodeId, type: edge.type,
      direction: 'forward', weight: edge.weight, aggregate: false, provenance: edge.provenance, historical: edge.historical,
    });
  }

  for (const incidentPage of incidentPages) {
    for (const incident of incidentPage.edges) {
      let endpointId = incident.endpoint.nodeId;
      if (!nodes.has(endpointId)) {
        const containing = incident.endpoint.communityPath.at(-1);
        if (!containing) continue;
        endpointId = communityRenderIds.get(containing.id) ?? containing.id;
        // PLNR-448: `offPageStandIn` marks this node as purely a substitute so the renderer can
        // exclude it from the normal community passes (gravity well, core sphere, label) the
        // PLNR-379 honesty rule forbids for it — it exists here only so the edge below has
        // somewhere to point. Only set on the fresh-node branch: if `containing` is ALREADY in
        // `nodes` (a genuinely resident/neighbour community added above), that node is untouched
        // and keeps its normal treatment.
        if (!nodes.has(endpointId)) nodes.set(endpointId, { ...communityNode(containing), id: endpointId, offPageStandIn: true });
      }
      const outgoing = incident.direction === 'outgoing';
      // PLNR-445: `direction` here is the typed-label arrow (promotedEdgeLabelText reads it, not
      // fromId/toId), and it must agree with the fromId/toId swap two lines up rather than being
      // hardcoded — an incoming incident edge (fromId=endpoint, toId=the pin) is a 'reverse' edge
      // by the same 'forward'|'reverse'|'both' vocabulary every other edge kind here already uses;
      // an incident edge's direction is never 'both' (ApiConstellationV2IncidentPage.edges[].direction
      // is 'incoming' | 'outgoing' only), so there is no third case to thread through.
      edges.set(`incident:${incident.edgeId}`, {
        id: `incident:${incident.edgeId}`, fromId: outgoing ? incidentPage.node.nodeId : endpointId,
        toId: outgoing ? endpointId : incidentPage.node.nodeId, type: incident.type,
        direction: outgoing ? 'forward' : 'reverse',
        weight: 5, aggregate: endpointId !== incident.endpoint.nodeId, provenance: incident.provenance,
        historical: isHistoricalIncidentEdgeType(incident.type),
      });
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

export interface ResidentConstellationPage<T> { communityId: string; value: T; nodeCount: number; touchedAt: number; pinned: boolean }

/** LRU eviction for resident systems. A caller may pin the system being interacted with so loading
 * it evicts an older resident rather than immediately evicting the requested page itself. */
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
