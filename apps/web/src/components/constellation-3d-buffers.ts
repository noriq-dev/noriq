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
  /** True only for a community node constellation-v2-scene.ts synthesized as a stand-in for an
   *  off-page incident edge's real, non-resident endpoint — never for a community that is
   *  genuinely resident/visible on this page (PLNR-448). It stays in the node map ONLY so
   *  `buildConstellation3DRenderPlan` can resolve `Constellation3DEdgeSegment.from/to` through it;
   *  the PLNR-379 honesty rule ("no synthesized node, ever") means it must be excluded from every
   *  NORMAL node pass (shape/instancing group, community gravity well, text label) below — the
   *  dedicated off-page terminus glyph (MemoryConstellation3D.tsx's `offPagePromotedEdges` pass)
   *  is the only thing that may render it. */
  offPageStandIn?: boolean;
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

export type Constellation3DLabelPriority = 'ambient' | 'promoted' | 'selected';

export interface Constellation3DLabelCandidate {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  priority: Constellation3DLabelPriority;
}

/** Presentation-only shortening for the DOM labels; callers retain the original graph label. */
export function truncateConstellationLabel(label: string, maxCharacters: number): string {
  const characters = Array.from(label);
  if (characters.length <= maxCharacters) return label;
  if (maxCharacters <= 0) return '';
  if (maxCharacters === 1) return '…';
  return `${characters.slice(0, maxCharacters - 1).join('').trimEnd()}…`;
}

export function communityEntitySubtext(entityCount: number): string {
  return `${entityCount.toLocaleString()} ${entityCount === 1 ? 'entity' : 'entities'}`;
}

/** Greedy screen-space rectangle rejection. Priority tiers are swept first while the caller's
 * existing order is retained within each tier, so selected/promoted chrome always claims space
 * before ambient labels without changing the renderer's established degree/community ordering. */
export function placeConstellation3DLabels<T extends Constellation3DLabelCandidate>(
  candidates: readonly T[],
  budget = 24,
  gap = 6,
): T[] {
  const rank: Record<Constellation3DLabelPriority, number> = { ambient: 0, promoted: 1, selected: 2 };
  const ordered = candidates.map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => rank[b.candidate.priority] - rank[a.candidate.priority] || a.index - b.index);
  const placed: T[] = [];
  for (const { candidate } of ordered) {
    if (placed.length >= Math.max(0, budget)) break;
    const overlaps = placed.some((other) =>
      Math.abs(candidate.x - other.x) < (candidate.width + other.width) / 2 + gap
      && Math.abs(candidate.y - other.y) < (candidate.height + other.height) / 2 + gap);
    if (!overlaps) placed.push(candidate);
  }
  return placed;
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

/** True when a promoted (selected-incident) edge's "other" endpoint is a community standing in
 * for a node that isn't resident on this page — constellation-v2-scene.ts's `assembleConstellationV2Scene`
 * sets `aggregate: true` on an `incident:`-prefixed edge exactly when it substituted the endpoint id
 * (`endpointId !== incident.endpoint.nodeId`). The id-prefix check is what excludes a GENUINE
 * community-to-community `aggregate:`-prefixed route from being misread as off-page: selecting a
 * community node can itself promote one of its own boundary routes to `promotedEdges`, and that
 * route is not a truncated substitution — the community at the other end is already rendered, on
 * this page, exactly where the route points. Only an `incident:` edge's `aggregate` flag means "the
 * literal target is not resident; this is a stand-in" (PLNR-379 honesty rule). */
export function isOffPageIncidentEdge(edge: Pick<Constellation3DEdge, 'aggregate' | 'id'>): boolean {
  return edge.aggregate && edge.id.startsWith('incident:');
}

/** Typed mono label text for a promoted incident edge (screen spec 1b). An off-page edge never gets
 * the relationship-typed text — it gets the truthful "route to a community" caption instead, so a
 * dashed line pointing at a community node never gets mislabeled as if it pointed at the real,
 * resident endpoint. `targetLabel` is the OTHER endpoint's own label (the community's name for an
 * off-page edge), resolved by the caller from the same node map the scene already has in hand. */
export function promotedEdgeLabelText(edge: Constellation3DEdge, targetLabel: string): string {
  if (isOffPageIncidentEdge(edge)) return `${targetLabel} · off-page ▸`;
  const arrow = edge.direction === 'reverse' ? '←' : edge.direction === 'both' ? '↔' : '→';
  const suffix = edge.historical ? ' · historical' : '';
  return `${arrow} ${edge.type}${suffix}`;
}

// ---------------------------------------------------------------------------------------------
// Search ignite (PLNR-441, screen spec 1c). The PLNR-439 draw-call-ceiling finding — a realistic
// pinned-selection scene already sits at exactly 14, the PLNR-371 ceiling, with zero headroom —
// means ignite cannot afford a single new draw call: it has to ride the instanced buckets that
// already exist rather than add its own. Two consequences, both load-bearing:
//   (1) The unmatched field's dim is the SAME "faded"/"unfaded" material bucket every node mesh
//       already splits into (see `constellation3DIsDimmed` below) — search just changes which
//       predicate decides bucket membership, not how many buckets or draw calls there are.
//   (2) A matched node's "flare" is the scale boost `highlighted` nodes already get in the
//       renderer's per-instance matrix (never a new mesh) — community gravity-well layers apply
//       that same boost after their visibility floor, so a flared well still grows with its core
//       for free, with no separate well-opacity bucket to split.
// This is why the combined pinned-selection + ignite measurement in
// constellation-3d-buffers.test.ts stays at 14, not higher: ignite spends zero new draw calls.
export const CONSTELLATION_IGNITE_DIM_OPACITY = 0.32;
// A fixed world-space floor keeps sparse root communities legible after a wide fit-to-content
// frame without making well size camera-dependent. Connectivity remains encoded by `scale`; only
// the well footprint clamps, and communities above this threshold pass through unchanged.
export const CONSTELLATION_COMMUNITY_WELL_SCALE_FLOOR = 16;

export function constellation3DCommunityWellScale(node: Pick<Constellation3DNodeInstance, 'community' | 'scale'>): number {
  return node.community ? Math.max(CONSTELLATION_COMMUNITY_WELL_SCALE_FLOOR, node.scale) : node.scale;
}

/** Whether a node instance renders in the dimmed material bucket. Outside search, this is the
 * pre-existing validity-based dim (superseded/expired/stale, PLNR-437). During search it is
 * replaced — not layered — by match state: a matched node (entity or community, `highlighted`
 * already carries both per MemoryConstellationV2.tsx's ignite wiring) never dims, and everything
 * else drops into the same bucket regardless of its own validity. This is a straight swap of the
 * predicate the existing 2-bucket split (`for (const faded of [false, true])` in
 * MemoryConstellation3D.tsx) already uses — it does not add a bucket. */
export function constellation3DIsDimmed(node: Pick<Constellation3DNodeInstance, 'opacity' | 'highlighted'>, searchActive: boolean): boolean {
  return searchActive ? !node.highlighted : node.opacity < 1;
}

/** The overview flare's "+N matches" community subtext (screen spec 1c) — replaces the normal
 * "N entities" line while a search is active and this community has at least one ignited match.
 * Plural handling is this task's discretion; kept trivial and testable independent of the label's
 * DOM/projection concerns, same split as `communityTooltipContent`. */
export function communityIgniteSubtext(matchCount: number): string {
  return `+${matchCount.toLocaleString()} match${matchCount === 1 ? '' : 'es'}`;
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
    // PLNR-448: an off-page stand-in must resolve edge positions through `byId` (above) but never
    // join a shape/instancing group — that group is exactly what draws the core sphere the PLNR-379
    // honesty rule forbids for a synthesized node. It still gets its dedicated terminus glyph,
    // built independently from the promoted off-page edges in MemoryConstellation3D.tsx.
    if (node.offPageStandIn) continue;
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

  // PLNR-448: an off-page stand-in never earns a text label either — same honesty rule as the
  // shape-group exclusion above, applied to the label budget instead of the instancing pass.
  const labels = [...byId.values()].filter((node) => !node.offPageStandIn)
    .sort((a, b) => compareLabelPriority(a, b, selectedNodeId)).slice(0, Math.max(0, labelBudget));
  // PLNR-439: promoted edges (selection) split into up to three separate passes so historical and
  // off-page relationships can carry their own dash pattern/opacity instead of sharing the solid
  // amber line every other promoted edge gets — each pass is only allotted when the plan actually
  // has an edge of that kind, same convention the lead/community/aggregate-route terms below use.
  // Mutually exclusive over promotedEdges, matching the renderer's own partition in
  // MemoryConstellation3D.tsx: an edge that is both historical AND off-page renders (once) as
  // off-page — "where this points" outranks "when this was true" for which dashed pass it joins.
  const hasOffPagePromoted = promotedEdges.some((edge) => isOffPageIncidentEdge(edge));
  const hasHistoricalPromoted = promotedEdges.some((edge) => edge.historical && !isOffPageIncidentEdge(edge));
  const hasCurrentPromoted = promotedEdges.some((edge) => !edge.historical && !isOffPageIncidentEdge(edge));
  const hasDirectionMarkers = promotedEdges.some((edge) => edge.directionMarker && !isOffPageIncidentEdge(edge));
  // Five shape meshes (faded/unfaded) + lead halo mesh + community gravity-well falloff (outer +
  // mid, only when a community node is present — never for the pure-entity 12k fixture) +
  // aggregate-route instanced tubes (only when an aggregate edge is present) + the always-allotted
  // backbone base-edge pass + the promoted-edge passes above. The selection reticle and the hover
  // pre-selection ring are deliberately NOT counted here: both are reusable Object3Ds repositioned
  // in place, never rebuilt or multiplied per node/edge (see MemoryConstellation3D.tsx), the same
  // reason the camera-control DOM buttons aren't counted.
  // The aggregate-route TUBE mesh only ever gets built from `baseEdges` (see `renderEdges`'s
  // `aggregateBaseEdges`) — an aggregate edge incident to the current selection lands in
  // `promotedEdges` instead (rendered as the off-page pass above) and never reaches that base-pass
  // tube at all. `aggregateWeights.length` (used above for width normalization, deliberately
  // selection-independent) is the wrong signal for THIS term: it would allot a tube draw call for
  // an aggregate edge that got promoted away from the base pass and so never actually fires one.
  const hasAggregateRouteTube = baseEdges.some((edge) => edge.aggregate);
  const drawCallCeiling = nodeGroups.size * 2
    + (nodes.some((node) => node.isLead) ? 1 : 0)
    // PLNR-448: a plan whose only community node is an off-page stand-in no longer builds the
    // gravity-well pass (it was excluded from nodeGroups above, same reasoning), so the ceiling
    // must not allot draw calls for a pass that never fires. A genuinely resident community still
    // counts normally, standing in or not alongside it.
    + (nodes.some((node) => node.community && !node.offPageStandIn) ? 2 : 0)
    + (hasAggregateRouteTube ? 1 : 0)
    + 1 // base backbone line pass
    + (hasCurrentPromoted ? 1 : 0)
    + (hasHistoricalPromoted ? 1 : 0)
    + (hasOffPagePromoted ? 2 : 0) // dashed route line + instanced terminus-glyph mesh
    + (hasDirectionMarkers ? 1 : 0);
  return { nodeGroups, baseEdges, promotedEdges, labels, nodeCount: byId.size, drawCallCeiling };
}
