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

export type CoverageReason = 'seed-not-found' | 'code-graph-empty' | 'no-writer-yet' | 'row-limit-reached';

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
}

export function buildCoverage(inputs: CoverageInputs): Coverage {
  const reasons: CoverageReason[] = [];
  if (inputs.seedMissing) reasons.push('seed-not-found');
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
