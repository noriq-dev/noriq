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
// (community aggregates are the one case the table doesn't cover: they render as `sphere`
// regardless of dominant member type until PLNR-438's community-well treatment lands).
export function constellation3DShape(node: Constellation3DNode): Constellation3DShape {
  if (node.community) return 'sphere';
  return encodingForType(node.type).shape;
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
      width: selectedIncident ? 3 : edge.aggregate ? 1.4 : 1,
      opacity: selectedIncident ? 1 : state === 'unrelated-dimmed' ? 0.1 : edge.aggregate ? 0.42 : 0.3,
      directionMarker: edge.direction !== 'both',
    };
    (selectedIncident ? promotedEdges : baseEdges).push(segment);
  }

  const labels = [...byId.values()].sort((a, b) => compareLabelPriority(a, b, selectedNodeId)).slice(0, Math.max(0, labelBudget));
  // Five shape meshes + lead halo mesh + base/promoted line passes + promoted direction markers.
  const drawCallCeiling = nodeGroups.size * 2 + (nodes.some((node) => node.isLead) ? 1 : 0) + 3;
  return { nodeGroups, baseEdges, promotedEdges, labels, nodeCount: byId.size, drawCallCeiling };
}
