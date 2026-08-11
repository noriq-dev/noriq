import { encodingForType, type Constellation3DShape } from './constellation-encoding';

export type { Constellation3DShape };
export type Constellation3DEdgeState = 'base' | 'unrelated-dimmed' | 'selected-incident';

export interface Constellation3DNode {
  id: string;
  uri: string | null;
  label: string;
  type: string;
  position: [number, number, number];
  degree: number;
  authority?: number | null;
  validity?: string | null;
  isLead?: boolean | null;
  community?: boolean;
  parentId?: string | null;
  radius?: number;
  /** Community aggregates only (PLNR-438) — entity count backing the community, straight off
   *  `ApiConstellationV2Community.memberCount`. `degree` on a community node is `internalEdgeCount`,
   *  not an entity count, so the two-line label and hover tooltip need this separately. */
  memberCount?: number;
  /** Community aggregates only — `ApiConstellationV2Community.typeCounts` verbatim, the source
   *  the dominant-type tint and the tooltip's top-type-count rows both read from. */
  typeCounts?: Record<string, number>;
  /** Community aggregates only — sum of `ApiConstellationV2RouteEdge.count` across every boundary
   *  route touching this community (computed in constellation-v2-scene.ts, where the routes are
   *  in scope). Distinct from `degree`/internalEdgeCount, which counts INTERNAL edges only. */
  boundaryRouteCount?: number;
}

export interface Constellation3DEdge {
  id: string;
  fromId: string;
  toId: string;
  type: string;
  direction: 'forward' | 'reverse' | 'both';
  weight: number;
  aggregate: boolean;
  provenance?: string | null;
  historical?: boolean;
}

export interface Constellation3DNodeInstance extends Constellation3DNode {
  shape: Constellation3DShape;
  scale: number;
  opacity: number;
  halo: boolean;
  highlighted: boolean;
}

export interface Constellation3DEdgeSegment extends Constellation3DEdge {
  from: [number, number, number];
  to: [number, number, number];
  state: Constellation3DEdgeState;
  width: number;
  opacity: number;
  directionMarker: boolean;
}

export interface Constellation3DRenderPlan {
  nodeGroups: Map<Constellation3DShape, Constellation3DNodeInstance[]>;
  baseEdges: Constellation3DEdgeSegment[];
  promotedEdges: Constellation3DEdgeSegment[];
  labels: Constellation3DNodeInstance[];
  nodeCount: number;
  drawCallCeiling: number;
}

// Shape/scale-multiplier both come from the shared type encoding table (PLNR-437) — this module
// no longer owns type→shape grouping itself, it just applies the table's per-node consequences
// (community aggregates are the one case the table doesn't cover: shape stays `sphere` regardless
// of dominant member type — the community "gravity well" is a distinct visual family from any
// single entity shape — but colour DOES follow the dominant type; see `constellation3DColorType`).
export function constellation3DShape(node: Constellation3DNode): Constellation3DShape {
  if (node.community) return 'sphere';
  return encodingForType(node.type).shape;
}

/** `typeCounts` sorted by count desc, count ties broken alphabetically for determinism — the one
 * ranking both the dominant-type tint and the tooltip's top-type rows read from, so the two can
 * never disagree about which type is "dominant". */
function sortedTypeCounts(typeCounts: Record<string, number> | undefined): Array<[string, number]> {
  return Object.entries(typeCounts ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** A community's dominant entity type, straight off `typeCounts` (PLNR-438 locked decision: the
 * overview response already carries this — no extra request). Null when a node has no counts to
 * rank (not a community, or a community with an empty membership). */
export function dominantCommunityType(node: Pick<Constellation3DNode, 'typeCounts'>): string | null {
  return sortedTypeCounts(node.typeCounts)[0]?.[0] ?? null;
}

/** The type key `colorForType` (MemoryConstellation3D.tsx) should resolve a node's tint against —
 * a community's dominant type, or the node's own type for anything else. One function so the
 * renderer and any DOM consumer read colour off the identical decision. Falls through to
 * `encodingForType`'s own 'unknown' handling when a community has no typeCounts to rank. */
export function constellation3DColorType(node: Constellation3DNode): string {
  return node.community ? dominantCommunityType(node) ?? 'unknown' : node.type;
}

export interface ConstellationCommunityTooltip {
  name: string;
  entityCount: number;
  boundaryRouteCount: number;
  topTypeCounts: Array<{ type: string; count: number }>;
  affordance: string;
}

/** The overview hover tooltip's content (PLNR-438) — a pure data transform, kept separate from
 * the DOM/positioning concern so it is unit-testable without WebGL. Null for a non-community node:
 * this task's hover treatment is scoped to community supernodes only (entity-level hover is
 * Phase 3 selection/promoted-edge work, deliberately deferred). */
export function communityTooltipContent(node: Constellation3DNode, maxTypeRows = 3): ConstellationCommunityTooltip | null {
  if (!node.community) return null;
  return {
    name: node.label,
    entityCount: node.memberCount ?? 0,
    boundaryRouteCount: node.boundaryRouteCount ?? 0,
    topTypeCounts: sortedTypeCounts(node.typeCounts).slice(0, maxTypeRows).map(([type, count]) => ({ type, count })),
    affordance: 'click to select · double-click to open',
  };
}

/** Aggregate route thickness maps to boundary weight (PLNR-438 locked decision, PLNR-379). Mirrors
 * the screen spec's 0.8–2.4 stroke-width range, min/max-normalized against whatever aggregate
 * weights are actually present in the current plan — a scene with one boundary weight gets the
 * range's midpoint rather than a divide-by-zero. The renderer applies this as an instanced tube
 * RADIUS (not a `LineBasicMaterial.linewidth`, which most browsers silently clamp to 1px) — see
 * MemoryConstellation3D.tsx's `renderEdges`. */
export function aggregateRouteWidth(weight: number, minWeight: number, maxWeight: number): number {
  if (!Number.isFinite(weight) || maxWeight <= minWeight) return 1.6;
  const t = Math.max(0, Math.min(1, (weight - minWeight) / (maxWeight - minWeight)));
  return 0.8 + t * 1.6;
}

export function constellation3DNodeEncoding(node: Constellation3DNode): Constellation3DNodeInstance {
  const authority = node.authority === null || node.authority === undefined ? 0 : Math.max(0, Math.min(5, node.authority));
  const scaleMultiplier = node.community ? 1 : encodingForType(node.type).scaleMultiplier;
  return {
    ...node,
    shape: constellation3DShape(node),
    scale: ((node.community ? 8 : 2.4) + Math.log2(Math.max(1, node.degree + 1)) * (node.community ? 1.4 : 0.65) + authority * 0.25) * scaleMultiplier,
    opacity: node.validity === 'superseded' || node.validity === 'expired' || node.validity === 'stale' ? 0.42 : 1,
    halo: node.isLead === true,
    highlighted: false,
  };
}

function compareLabelPriority(a: Constellation3DNodeInstance, b: Constellation3DNodeInstance, selectedNodeId: string | null) {
  const score = (node: Constellation3DNodeInstance) =>
    (node.id === selectedNodeId ? 1_000_000 : 0) + (node.highlighted ? 500_000 : 0)
      + (node.community ? 100_000 : 0) + (node.halo ? 10_000 : 0) + node.degree;
  return score(b) - score(a) || a.id.localeCompare(b.id);
}

/** Pure adapter from page state to bounded GPU buffers. Edges are split into two passes so the
 * selected incident pass is always submitted last and can never be buried by unrelated routes. */
export function buildConstellation3DRenderPlan(
  nodes: Constellation3DNode[],
  edges: Constellation3DEdge[],
  selectedNodeId: string | null,
  labelBudget = 24,
  highlightedNodeIds: ReadonlySet<string> = new Set(),
): Constellation3DRenderPlan {
  const nodeGroups = new Map<Constellation3DShape, Constellation3DNodeInstance[]>();
  const byId = new Map<string, Constellation3DNodeInstance>();
  for (const input of nodes) {
    const node = constellation3DNodeEncoding(input);
    node.highlighted = highlightedNodeIds.has(node.id);
    byId.set(node.id, node);
    const group = nodeGroups.get(node.shape);
    if (group) group.push(node);
    else nodeGroups.set(node.shape, [node]);
  }

  // Normalized once per plan, over every aggregate edge regardless of selection state, so the
  // width band stays stable as a node gets selected/deselected rather than rescaling under it.
  const aggregateWeights = edges.filter((edge) => edge.aggregate).map((edge) => edge.weight);
  const minAggregateWeight = aggregateWeights.length ? Math.min(...aggregateWeights) : 0;
  const maxAggregateWeight = aggregateWeights.length ? Math.max(...aggregateWeights) : 0;

  const baseEdges: Constellation3DEdgeSegment[] = [];
  const promotedEdges: Constellation3DEdgeSegment[] = [];
  for (const edge of edges) {
    const from = byId.get(edge.fromId);
    const to = byId.get(edge.toId);
    if (!from || !to) continue;
    const selectedIncident = selectedNodeId !== null && (edge.fromId === selectedNodeId || edge.toId === selectedNodeId);
    const state: Constellation3DEdgeState = selectedIncident ? 'selected-incident' : selectedNodeId ? 'unrelated-dimmed' : 'base';
    const segment: Constellation3DEdgeSegment = {
      ...edge, from: from.position, to: to.position, state,
      width: selectedIncident ? 3 : edge.aggregate ? aggregateRouteWidth(edge.weight, minAggregateWeight, maxAggregateWeight) : 1,
      opacity: selectedIncident ? 1 : state === 'unrelated-dimmed' ? 0.1 : edge.aggregate ? 0.42 : 0.3,
      directionMarker: edge.direction !== 'both',
    };
    (selectedIncident ? promotedEdges : baseEdges).push(segment);
  }

  const labels = [...byId.values()].sort((a, b) => compareLabelPriority(a, b, selectedNodeId)).slice(0, Math.max(0, labelBudget));
  // Five shape meshes (faded/unfaded) + lead halo mesh + community gravity-well falloff (outer +
  // mid, only when a community node is present — never for the pure-entity 12k fixture) +
  // aggregate-route instanced tubes (only when an aggregate edge is present) + base/promoted line
  // passes + promoted direction markers. The hover pre-selection ring is deliberately NOT counted
  // here: it is one reusable Object3D that never scales with node/edge count (see
  // MemoryConstellation3D.tsx), the same reason the camera-control DOM buttons aren't counted.
  const drawCallCeiling = nodeGroups.size * 2
    + (nodes.some((node) => node.isLead) ? 1 : 0)
    + (nodes.some((node) => node.community) ? 2 : 0)
    + (aggregateWeights.length > 0 ? 1 : 0)
    + 3;
  return { nodeGroups, baseEdges, promotedEdges, labels, nodeCount: byId.size, drawCallCeiling };
}
