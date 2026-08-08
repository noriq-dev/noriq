// PLNR-258: named graph-query primitives — dependency neighborhoods, validating tests,
// implementing work, decision lineage, and change impact. Storage-free (never opens
// ctx.storage, matching retrieval.ts/writes.ts/backup.ts/restore.ts/lifecycle.ts): ProjectMemory
// executes the bounded recursive-CTE traversals over its own SQLite and hands the raw rows here
// to shape into addressable entities with an honest completeness marker.
//
// No new edge type: every relationship these primitives answer already exists in
// MemoryEdgeType (depends_on/imports/calls for dependencies, tests/validated_by for tests,
// implements for implementing work, decided_by/supersedes for decision lineage,
// commonly_changes_with for co-change). None of tests/validated_by/implements/
// commonly_changes_with has a WRITER yet (nothing in src/ creates them before Phase 5/6), and
// direction is unspecified by the shared vocabulary — so every primitive here searches BOTH
// edge directions and merges, rather than guessing a convention no writer has established.
// (`dependencyNeighborhood` is the one exception: the task's own acceptance line asks for a
// directional upstream/downstream split, which the graph's declared edges — depends_on et al —
// already have an intuitive "this depends on that" reading for.)
//
// PLNR-284 adds a SIXTH primitive, `constellation` — the bounded, server-sampled whole-project
// projection behind the memory star map (§5). Unlike the five seeded primitives above it has no
// seed and no fixed edge-type dependency to check for a missing writer; it reuses this SAME
// `Coverage` shape rather than inventing a second one (locked decision), which is why
// `CoverageReason` gains one new arm below (`graph-empty`) instead of a parallel field.

import { classifyLead } from './retrieval';

export type CoverageReason = 'seed-not-found' | 'code-graph-empty' | 'no-writer-yet' | 'row-limit-reached' | 'graph-empty';

/**
 * The required, non-optional completeness marker every primitive returns (§2): what the
 * answer is derived from, and what it could not see. `complete: false` means "this graph
 * cannot fully answer that yet" — never conflate an empty `entities`/`upstream`/`downstream`
 * array with "nothing is related"; check `coverage` first.
 */
export interface Coverage {
  complete: boolean;
  reasons: CoverageReason[];
  /** Present only when 'no-writer-yet' fired — which specific edge types this query depends
   *  on have never been written anywhere in this project. */
  edgeTypesWithNoWriter?: string[];
}

export interface CoverageInputs {
  /** This project's graph has at least one node beyond coordination's 'task' type. */
  codeGraphPopulated: boolean;
  /** Edge types this query depends on that have no writer anywhere in this project yet. */
  edgeTypesWithNoWriter: string[];
  /** The traversal was capped by the shared row-limit constant — there may be more beyond it. */
  truncated: boolean;
  /** The seed URI itself didn't resolve to an existing node. */
  seedMissing?: boolean;
  /** PLNR-284: this project's `nodes` table has ZERO rows — nothing has ever been recorded or
   *  projected into memory at all. Distinct from `codeGraphPopulated` (which is about repository
   *  code intelligence specifically, and reads false even on a lively project that simply has
   *  never indexed a repository): a project with tasks/plans/memories but no repo index sets
   *  `code-graph-empty` alone, while a project with NOTHING sets both — `graph-empty` is the
   *  authoritative "the whole map is empty" signal a renderer checks first. */
  graphEmpty?: boolean;
}

export function buildCoverage(inputs: CoverageInputs): Coverage {
  const reasons: CoverageReason[] = [];
  if (inputs.seedMissing) reasons.push('seed-not-found');
  if (inputs.graphEmpty) reasons.push('graph-empty');
  if (!inputs.codeGraphPopulated) reasons.push('code-graph-empty');
  if (inputs.edgeTypesWithNoWriter.length) reasons.push('no-writer-yet');
  if (inputs.truncated) reasons.push('row-limit-reached');
  return {
    complete: reasons.length === 0,
    reasons,
    edgeTypesWithNoWriter: inputs.edgeTypesWithNoWriter.length ? inputs.edgeTypesWithNoWriter : undefined,
  };
}

/** A node as ProjectMemory's `nodes` table carries it — always addressable by its stable URI. */
export interface GraphEntityRef {
  nodeId: string;
  uri: string;
  type: string;
  label: string;
}

/** One real edge on the path from a seed to a related entity — `fromNodeId`/`toNodeId` are the
 *  edge's ACTUAL direction, regardless of which way the traversal walked to find it. */
export interface EdgeHop {
  fromNodeId: string;
  edgeType: string;
  toNodeId: string;
}

export interface RelatedEntity extends GraphEntityRef {
  depth: number;
  edgePath: EdgeHop[];
}

/** The row shape ProjectMemory's bounded traversal (`rawTraverseGraph`) produces — the ONE
 *  input shape every primitive here shapes into `RelatedEntity[]`. */
export interface TraversalRow {
  nodeId: string;
  uri: string;
  type: string;
  label: string;
  depth: number;
  edgePath: string;
}

/** Parse the `;`-joined `from>type>to` path string ProjectMemory's traversal produces into
 *  structured hops — shared by every primitive's shaping step. */
export function parseEdgePath(path: string): EdgeHop[] {
  if (!path) return [];
  return path.split(';').map((hop) => {
    const [fromNodeId, edgeType, toNodeId] = hop.split('>');
    return { fromNodeId: fromNodeId ?? '', edgeType: edgeType ?? '', toNodeId: toNodeId ?? '' };
  });
}

function toRelatedEntities(rows: TraversalRow[]): RelatedEntity[] {
  return rows.map((r) => ({ nodeId: r.nodeId, uri: r.uri, type: r.type, label: r.label, depth: r.depth, edgePath: parseEdgePath(r.edgePath) }));
}

/** Merge two traversal row sets (e.g. both edge directions) into one deduped list, keeping the
 *  shallowest occurrence of each node — same dedup rule ProjectMemory's own traversal applies
 *  within one direction. */
function mergeRows(a: TraversalRow[], b: TraversalRow[]): TraversalRow[] {
  const byId = new Map<string, TraversalRow>();
  for (const r of [...a, ...b]) {
    const prev = byId.get(r.nodeId);
    if (!prev || r.depth < prev.depth) byId.set(r.nodeId, r);
  }
  return [...byId.values()].sort((x, y) => x.depth - y.depth);
}

// ---------------------------------------------------------------------------------------
// The five named primitives
// ---------------------------------------------------------------------------------------

export interface DependencyNeighborhoodResult {
  seed: GraphEntityRef | null;
  /** What this entity depends on / imports / calls — traversed forward. */
  downstream: RelatedEntity[];
  /** What depends on / imports / calls this entity — traversed backward over the SAME edges. */
  upstream: RelatedEntity[];
  coverage: Coverage;
}

export function dependencyNeighborhood(
  seed: GraphEntityRef | null,
  downstreamRows: TraversalRow[],
  upstreamRows: TraversalRow[],
  coverage: CoverageInputs,
): DependencyNeighborhoodResult {
  return { seed, downstream: toRelatedEntities(downstreamRows), upstream: toRelatedEntities(upstreamRows), coverage: buildCoverage(coverage) };
}

export interface ValidatingTestsResult {
  seed: GraphEntityRef | null;
  tests: RelatedEntity[];
  coverage: Coverage;
}

/** Tests connected to `seed` via `tests`/`validated_by`, either direction merged (no writer has
 *  established a convention yet — see module comment). */
export function validatingTests(seed: GraphEntityRef | null, forwardRows: TraversalRow[], backwardRows: TraversalRow[], coverage: CoverageInputs): ValidatingTestsResult {
  return { seed, tests: toRelatedEntities(mergeRows(forwardRows, backwardRows)), coverage: buildCoverage(coverage) };
}

export interface ImplementingWorkResult {
  seed: GraphEntityRef | null;
  implementingTasks: RelatedEntity[];
  coverage: Coverage;
}

/** Tasks connected to `seed` via `implements`, either direction merged. */
export function implementingWork(seed: GraphEntityRef | null, forwardRows: TraversalRow[], backwardRows: TraversalRow[], coverage: CoverageInputs): ImplementingWorkResult {
  return { seed, implementingTasks: toRelatedEntities(mergeRows(forwardRows, backwardRows)), coverage: buildCoverage(coverage) };
}

export interface DecisionLineageResult {
  seed: GraphEntityRef | null;
  implementingTasks: RelatedEntity[];
  /** Code entities reached via the implementing tasks' `modifies` edges — a decision has no
   *  direct "affects" edge of its own (not in MemoryEdgeType); this composes existing edges
   *  (`implements` then `modifies`) rather than inventing one. */
  affectedEntities: RelatedEntity[];
  supersedingDecisions: RelatedEntity[];
  /** The backing memory's evidence citations, when `seed.uri` resolves to one (a `decision`
   *  node's uri IS `noriq://decision/<memoryItemId>` — §1's evidence contract rides the graph
   *  claim the same way it rides a retrieval result). Empty when the seed has no backing memory
   *  or none was found — see `coverage` for why. */
  evidence: Array<{ repositoryKey: string; branch: string; baseId: string; path: string; verificationState: string }>;
  coverage: Coverage;
}

export function decisionLineage(
  seed: GraphEntityRef | null,
  implementingRows: TraversalRow[],
  implementingRowsBackward: TraversalRow[],
  affectedRows: TraversalRow[],
  supersedingRows: TraversalRow[],
  supersedingRowsBackward: TraversalRow[],
  evidence: DecisionLineageResult['evidence'],
  coverage: CoverageInputs,
): DecisionLineageResult {
  return {
    seed,
    implementingTasks: toRelatedEntities(mergeRows(implementingRows, implementingRowsBackward)),
    affectedEntities: toRelatedEntities(affectedRows),
    supersedingDecisions: toRelatedEntities(mergeRows(supersedingRows, supersedingRowsBackward)),
    evidence,
    coverage: buildCoverage(coverage),
  };
}

export interface UncertainEdge {
  /** A change-target that named no existing graph node — this graph cannot answer for it yet,
   *  which is a DIFFERENT claim than "no tests are impacted". */
  entityUri: string;
  reason: 'not-yet-indexed';
}

export interface ChangeImpactResult {
  resolvedSeeds: GraphEntityRef[];
  uncertainEdges: UncertainEdge[];
  impactedTests: RelatedEntity[];
  coverage: Coverage;
}

/** Impacted tests for a proposed set of changed entities (by URI) — reuses `validatingTests`'
 *  own edge set/merge rule across every RESOLVED seed; an entity URI with no matching node
 *  becomes an uncertain edge rather than being silently dropped or asserted as unaffected. */
export function changeImpact(
  resolvedSeeds: GraphEntityRef[],
  unresolvedUris: string[],
  forwardRows: TraversalRow[],
  backwardRows: TraversalRow[],
  coverage: CoverageInputs,
): ChangeImpactResult {
  return {
    resolvedSeeds,
    uncertainEdges: unresolvedUris.map((entityUri) => ({ entityUri, reason: 'not-yet-indexed' as const })),
    impactedTests: toRelatedEntities(mergeRows(forwardRows, backwardRows)),
    coverage: buildCoverage(coverage),
  };
}

// ---------------------------------------------------------------------------------------
// PLNR-284: the constellation — a bounded, deterministically-sampled whole-project projection
// (§5's "searchable constellation"). Unlike the five primitives above, it has no seed: it scores
// EVERY node in the project and keeps the top `CONSTELLATION_NODE_CEILING`, then keeps every
// edge whose BOTH endpoints survived, up to `CONSTELLATION_EDGE_CEILING`. ProjectMemory hands
// this the project's full node/edge/memory_items/episodes rows, unsorted and unfiltered — the
// scoring, sampling, tie-breaking and coverage classification all happen here so they are one
// legible, unit-testable rule rather than a SQL ORDER BY expression no test can address in
// isolation.
// ---------------------------------------------------------------------------------------

/** A real project renders smoothly at a few hundred stars — well past that, a force-directed
 *  canvas degrades before a human can read it. Independent of RETRIEVAL_DEFAULTS' single-seed
 *  neighborhood ceilings (retrieval.ts): this samples the WHOLE project, not a bounded expansion
 *  from one seed, so it needs its own, larger numbers. Edge ceiling is 2x the node ceiling — a
 *  reasonably dense sampled subgraph has more edges than nodes, and a canvas reads a dense knot
 *  of edges before it reads a large count of stars. */
export const CONSTELLATION_NODE_CEILING = 300;
export const CONSTELLATION_EDGE_CEILING = 600;

export interface ConstellationRawNode {
  nodeId: string;
  uri: string;
  type: string;
  label: string;
  createdAt: string;
}

export interface ConstellationRawEdge {
  edgeId: string;
  type: string;
  fromNodeId: string;
  toNodeId: string;
  /** PLNR-283's `edges.provenance` — nullable, passed through verbatim, never invented here. */
  provenance: string | null;
}

export interface ConstellationRawMemory {
  id: string;
  kind: string;
  authority: number;
  validity: string;
}

export interface ConstellationRawEpisode {
  id: string;
  landingOutcome: string;
}

export interface ConstellationInputRows {
  nodes: ConstellationRawNode[];
  edges: ConstellationRawEdge[];
  memoryItems: ConstellationRawMemory[];
  episodes: ConstellationRawEpisode[];
}

export interface ConstellationNode {
  nodeId: string;
  uri: string;
  type: string;
  /** Sub-category beyond `type`: a memory node's `memory_items.kind` (learning/decision/failed_
   *  approach/procedure/requirement/hazard/unknown), or an episode node's landing outcome
   *  (landed/not_landed/failed/pending). `null` for every other node type — a task's own `type`
   *  (feature/bug/…), for instance, lives in D1, not in `nodes`, and joining it here would cost a
   *  per-node D1 round trip on every constellation call for a field nothing downstream needs yet
   *  (discretionary simplification, not an oversight). */
  kind: string | null;
  label: string;
  /** memory nodes only, live from `memory_items.authority` (1-5) — null for every other type. */
  authority: number | null;
  /** memory nodes only, live from `memory_items.validity` — null for every other type. */
  validity: string | null;
  /** `classifyLead` (memory/retrieval.ts), reused verbatim so a star's lead status is computed
   *  the identical way a search hit's is (locked decision: never a second definition). `null`
   *  wherever authority/validity are both null (nothing to classify). Deliberately does NOT fold
   *  in evidence verification the way a real `RetrievalHit` does: checking every citation for up
   *  to CONSTELLATION_NODE_CEILING memories on every call would multiply this endpoint's cost for
   *  a signal the evidence inspector (opened by selecting the star, §5) already gives in full —
   *  this is a coarse authority/validity-only hint for color/size, not the definitive answer. */
  isLead: boolean | null;
  leadReasons: string[] | null;
  /** Degree over the FULL project graph, computed BEFORE node sampling (discretion, resolved
   *  here per the task's own instruction to document the choice): a highly-connected node
   *  sampled into a small neighborhood would otherwise look falsely peripheral if degree were
   *  recomputed over just the returned edge set, and full-graph degree is also `importanceScore`'s
   *  primary input below, so it has to already be a whole-graph fact before sampling happens. */
  degree: number;
  /** Discretionary grouping hint (task's own "left entirely to the client" option) — this node's
   *  own `type`. Simple, always present, deterministic, and clusters/colors by the same
   *  vocabulary the rest of the memory UI already reads by. A floor, not a ceiling: nothing stops
   *  PLNR-285 from deriving a richer grouping client-side (e.g. by repositoryKey parsed from a
   *  file/symbol URI) on top of this. */
  groupKey: string;
}

export interface ConstellationEdge {
  type: string;
  fromNodeId: string;
  toNodeId: string;
  provenance: string | null;
}

export interface ConstellationOmitted {
  /** Nodes that existed but did not survive CONSTELLATION_NODE_CEILING sampling. */
  nodes: number;
  /** Edges whose both endpoints survived node sampling but did not survive
   *  CONSTELLATION_EDGE_CEILING sampling. */
  edges: number;
  /** Edges dropped because exactly one endpoint did NOT survive node sampling — tracked
   *  separately from `edges` above (locked decision: "prune edges after node selection... count
   *  the pruned ones into coverage"). A human reads the two differently: "there was more graph
   *  than fit" versus "this edge's other end wasn't important enough to make the cut". An edge
   *  touching NEITHER selected node is not counted anywhere — it was never a candidate for this
   *  response at all. */
  edgesDanglingPruned: number;
}

export interface ConstellationResult {
  memoryRevision: number;
  nodeCeiling: number;
  edgeCeiling: number;
  nodes: ConstellationNode[];
  edges: ConstellationEdge[];
  omitted: ConstellationOmitted;
  coverage: Coverage;
}

const MEMORY_URI_PREFIX = 'noriq://memory/';
const EPISODE_URI_PREFIX = 'noriq://episode/';

// The true inverse of buildEntityUri's default branch (`noriq://${kind}/${id}`) for exactly
// these two kinds — a plain prefix strip rather than a full parseEntityUri/EntityRef round trip,
// since the node's own `type` column already tells us which kind we're looking at and a
// try/catch per row for a URI this code itself only ever writes well-formed would be pure
// overhead.
function memoryIdFromUri(uri: string): string | null {
  return uri.startsWith(MEMORY_URI_PREFIX) ? uri.slice(MEMORY_URI_PREFIX.length) : null;
}
function episodeIdFromUri(uri: string): string | null {
  return uri.startsWith(EPISODE_URI_PREFIX) ? uri.slice(EPISODE_URI_PREFIX.length) : null;
}

interface ScoredNode extends ConstellationRawNode {
  degree: number;
  kind: string | null;
  authority: number | null;
  validity: string | null;
}

/**
 * The importance function selection is sampled by (discretion — "state the rule in code"):
 * degree is the primary signal — a well-connected node is structurally central to the graph a
 * human is trying to get oriented in. Authority adds a bounded bonus so a well-evidenced
 * decision/learning outranks an equally-connected hypothesis. Validity ADJUSTS rather than
 * excludes: 'active' adds a small bonus, a non-active validity (stale/invalid) subtracts one, so
 * a superseded or invalidated memory sinks below its still-good neighbors without disappearing
 * outright (§12: contradicting/superseded claims may coexist, never destructively erased).
 * Recency is deliberately NOT a scoring input — it is only the tie-break's second key below —
 * so raw age never drowns out structural importance for an old, well-connected node.
 */
function importanceScore(n: { degree: number; authority: number | null; validity: string | null }): number {
  const authorityBonus = (n.authority ?? 0) * 3;
  const validityAdjust = n.validity === 'active' ? 2 : n.validity ? -2 : 0;
  return n.degree * 10 + authorityBonus + validityAdjust;
}

/**
 * Determinism's explicit tie-break (locked decision, named here because it is the single most
 * likely way "byte-identical between calls" passes at 5 nodes and fails at 3000): importance
 * score DESC, then `createdAt` DESC (newer first, on ties), then `uri` ASC as the FINAL,
 * total-order tie-break — two nodes can never compare equal under this function unless they are
 * the same node (uri is unique).
 */
function compareNodesForSelection(a: ScoredNode, b: ScoredNode): number {
  const scoreDiff = importanceScore(b) - importanceScore(a);
  if (scoreDiff !== 0) return scoreDiff;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0;
}

/**
 * Shape the project's full node/edge/memory_items/episodes rows into the bounded, deterministic
 * constellation (§5). `rows` is intentionally the WHOLE unsampled graph — sampling fairly means
 * scoring the whole population first, not a SQL LIMIT before scoring — ProjectMemory's own
 * `constellation` RPC is the one place that reads that much in one call, and it is a read-only,
 * off-the-coordination-path query (§19), never a per-second poll.
 */
export function constellation(memoryRevision: number, rows: ConstellationInputRows, coverageInputs: { codeGraphPopulated: boolean }): ConstellationResult {
  const memoryById = new Map(rows.memoryItems.map((m) => [m.id, m]));
  const episodeById = new Map(rows.episodes.map((e) => [e.id, e]));

  const degreeByNodeId = new Map<string, number>();
  for (const e of rows.edges) {
    degreeByNodeId.set(e.fromNodeId, (degreeByNodeId.get(e.fromNodeId) ?? 0) + 1);
    degreeByNodeId.set(e.toNodeId, (degreeByNodeId.get(e.toNodeId) ?? 0) + 1);
  }

  const scored: ScoredNode[] = rows.nodes.map((n) => {
    let kind: string | null = null;
    let authority: number | null = null;
    let validity: string | null = null;
    if (n.type === 'memory') {
      const mem = memoryById.get(memoryIdFromUri(n.uri) ?? '');
      if (mem) {
        kind = mem.kind;
        authority = mem.authority;
        validity = mem.validity;
      }
    } else if (n.type === 'episode') {
      const ep = episodeById.get(episodeIdFromUri(n.uri) ?? '');
      if (ep) kind = ep.landingOutcome;
    }
    return { ...n, degree: degreeByNodeId.get(n.nodeId) ?? 0, kind, authority, validity };
  });
  scored.sort(compareNodesForSelection);

  const totalNodes = scored.length;
  const selected = scored.slice(0, CONSTELLATION_NODE_CEILING);
  const omittedNodes = Math.max(0, totalNodes - selected.length);

  const selectedIds = new Set(selected.map((n) => n.nodeId));
  const uriByNodeId = new Map(selected.map((n) => [n.nodeId, n.uri]));

  let edgesDanglingPruned = 0;
  const surviving: Array<ConstellationRawEdge & { fromUri: string; toUri: string }> = [];
  for (const e of rows.edges) {
    const fromOk = selectedIds.has(e.fromNodeId);
    const toOk = selectedIds.has(e.toNodeId);
    if (!fromOk && !toOk) continue; // touches neither selected node — never a candidate here
    if (fromOk && toOk) surviving.push({ ...e, fromUri: uriByNodeId.get(e.fromNodeId)!, toUri: uriByNodeId.get(e.toNodeId)! });
    else edgesDanglingPruned++; // exactly one endpoint survived node sampling
  }
  // Explicit total-order tie-break, same discipline as node selection: type ASC, then both
  // endpoints' URIs ASC. `edgeId` as a final key is defensive only — (type, fromNodeId,
  // toNodeId) is already unique (0002's idx_edges_unique), so two surviving rows can never
  // actually reach it, but it keeps the comparator a true total order on its face.
  surviving.sort((a, b) => {
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    if (a.fromUri !== b.fromUri) return a.fromUri < b.fromUri ? -1 : 1;
    if (a.toUri !== b.toUri) return a.toUri < b.toUri ? -1 : 1;
    return a.edgeId < b.edgeId ? -1 : a.edgeId > b.edgeId ? 1 : 0;
  });
  const selectedEdges = surviving.slice(0, CONSTELLATION_EDGE_CEILING);
  const omittedEdges = Math.max(0, surviving.length - selectedEdges.length);

  const coverage = buildCoverage({
    codeGraphPopulated: coverageInputs.codeGraphPopulated,
    edgeTypesWithNoWriter: [], // no fixed edge-type dependency to check — the constellation shows whatever exists
    truncated: omittedNodes > 0 || omittedEdges > 0,
    graphEmpty: totalNodes === 0,
  });

  return {
    memoryRevision,
    nodeCeiling: CONSTELLATION_NODE_CEILING,
    edgeCeiling: CONSTELLATION_EDGE_CEILING,
    nodes: selected.map((n) => {
      const hasMemoryFields = n.authority !== null || n.validity !== null;
      const lead = hasMemoryFields ? classifyLead({ authority: n.authority ?? undefined, validity: n.validity ?? undefined }) : null;
      return {
        nodeId: n.nodeId,
        uri: n.uri,
        type: n.type,
        kind: n.kind,
        label: n.label,
        authority: n.authority,
        validity: n.validity,
        isLead: lead?.isLead ?? null,
        leadReasons: lead?.leadReasons ?? null,
        degree: n.degree,
        groupKey: n.type,
      };
    }),
    edges: selectedEdges.map((e) => ({ type: e.type, fromNodeId: e.fromNodeId, toNodeId: e.toNodeId, provenance: e.provenance })),
    omitted: { nodes: omittedNodes, edges: omittedEdges, edgesDanglingPruned },
    coverage,
  };
}
