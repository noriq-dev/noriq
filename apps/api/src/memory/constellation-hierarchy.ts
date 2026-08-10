import type { ConstellationRawEdge, ConstellationRawNode } from './graph-queries';

export const CONSTELLATION_TOPOLOGY_VERSION = 'connectivity-v1';
export const CONSTELLATION_LAYOUT_VERSION = 'space-v1';
export const CONSTELLATION_MAX_CHILDREN = 128;
export const CONSTELLATION_LEAF_SIZE = 500;

const EDGE_WEIGHTS: Readonly<Record<string, number>> = {
  calls: 4, imports: 4, depends_on: 4, tests: 4, validated_by: 4, implements: 4,
  modifies: 3, declares: 3, derived_from: 3, decided_by: 3, observed_in: 3, commonly_changes_with: 3,
  blocks: 2, owned_by: 2, failed_because: 2,
  related_to: 1, supersedes: 1, contradicts: 1,
};

export interface PriorConstellationCommunity {
  id: string;
  level: number;
  memberUris: string[];
}

export interface HierarchyGenerationData {
  nodeStats: Array<{ nodeId: string; degree: number; weightedDegree: number; rank: number; boundaryDegree: number }>;
  communities: Array<{
    id: string; parentId: string | null; level: number; label: string; memberCount: number; childCount: number;
    typeCounts: Record<string, number>; internalEdgeCount: number; internalWeight: number; normalizedCohesion: number; boundaryWeight: number;
    anchor: [number, number, number];
  }>;
  memberships: Array<{ nodeId: string; communityId: string; level: number }>;
  links: Array<{
    level: number; fromCommunityId: string; toCommunityId: string; direction: 'forward' | 'reverse' | 'both';
    count: number; weight: number; byType: Record<string, number>;
  }>;
}

export interface HierarchyGenerationResult {
  data: HierarchyGenerationData;
  diagnostics: { nodeCount: number; edgeCount: number; danglingEdges: number; unknownEdgeTypes: string[]; maxDepth: number };
}

interface WeightedEdge extends ConstellationRawEdge { weight: number }
interface DraftCommunity { members: string[]; children: DraftCommunity[]; id?: string; level?: number; parentId?: string | null }

function fnv64(input: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = BigInt.asUintN(64, h * 0x100000001b3n);
  }
  return h.toString(16).padStart(16, '0');
}

function anchorFor(id: string): [number, number, number] {
  const unit = (salt: string) => (Number.parseInt(fnv64(`${id}:${salt}`).slice(0, 8), 16) / 0xffffffff) * 2 - 1;
  return [unit('x') * 1000, unit('y') * 1000, unit('z') * 1000];
}

function compareNodeIds(a: string, b: string, byId: ReadonlyMap<string, ConstellationRawNode>): number {
  return byId.get(a)!.uri.localeCompare(byId.get(b)!.uri);
}

function connectedComponents(nodeIds: string[], adjacency: ReadonlyMap<string, Map<string, number>>, byId: ReadonlyMap<string, ConstellationRawNode>): string[][] {
  const unseen = new Set(nodeIds);
  const components: string[][] = [];
  for (const seed of nodeIds) {
    if (!unseen.delete(seed)) continue;
    const queue = [seed];
    const component: string[] = [];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]!;
      component.push(id);
      const neighbors = [...(adjacency.get(id)?.keys() ?? [])].sort((a, b) => compareNodeIds(a, b, byId));
      for (const neighbor of neighbors) if (unseen.delete(neighbor)) queue.push(neighbor);
    }
    component.sort((a, b) => compareNodeIds(a, b, byId));
    components.push(component);
  }
  return components.sort((a, b) => compareNodeIds(a[0]!, b[0]!, byId));
}

/** Deterministic, connectivity-aware balanced partition. Seeds are structural-rank leaders;
 * every following node joins the cluster to which it has the strongest already-assigned link,
 * with a hard size cap and total-order ties. */
function partition(
  members: string[],
  adjacency: ReadonlyMap<string, Map<string, number>>,
  rank: ReadonlyMap<string, number>,
  byId: ReadonlyMap<string, ConstellationRawNode>,
): string[][] {
  const count = Math.min(CONSTELLATION_MAX_CHILDREN, Math.ceil(members.length / CONSTELLATION_LEAF_SIZE));
  if (count <= 1) return [members];
  const ordered = [...members].sort((a, b) => (rank.get(b)! - rank.get(a)!) || compareNodeIds(a, b, byId));
  const clusters = ordered.slice(0, count).map((seed) => ({ seed, members: [seed], ids: new Set([seed]) }));
  const cap = Math.ceil(members.length / count);
  for (const id of ordered.slice(count)) {
    let best = clusters[0]!;
    let bestScore = -1;
    for (const cluster of clusters) {
      if (cluster.members.length >= cap) continue;
      let score = 0;
      for (const [neighbor, weight] of adjacency.get(id) ?? []) if (cluster.ids.has(neighbor)) score += weight;
      if (score > bestScore || (score === bestScore && (cluster.members.length < best.members.length ||
        (cluster.members.length === best.members.length && compareNodeIds(cluster.seed, best.seed, byId) < 0)))) {
        best = cluster;
        bestScore = score;
      }
    }
    best.members.push(id);
    best.ids.add(id);
  }
  return clusters.map((c) => c.members.sort((a, b) => compareNodeIds(a, b, byId)));
}

function buildCommunity(members: string[], adjacency: ReadonlyMap<string, Map<string, number>>, rank: ReadonlyMap<string, number>, byId: ReadonlyMap<string, ConstellationRawNode>): DraftCommunity {
  if (members.length <= CONSTELLATION_LEAF_SIZE) return { members, children: [] };
  const groups = partition(members, adjacency, rank, byId);
  return { members, children: groups.map((group) => buildCommunity(group, adjacency, rank, byId)) };
}

function wrapForest(children: DraftCommunity[], byId: ReadonlyMap<string, ConstellationRawNode>): DraftCommunity[] {
  let current = children;
  while (current.length > CONSTELLATION_MAX_CHILDREN) {
    const sorted = [...current].sort((a, b) => compareNodeIds(a.members[0]!, b.members[0]!, byId));
    const wrapped: DraftCommunity[] = [];
    for (let i = 0; i < sorted.length; i += CONSTELLATION_MAX_CHILDREN) {
      const chunk = sorted.slice(i, i + CONSTELLATION_MAX_CHILDREN);
      wrapped.push({ members: chunk.flatMap((c) => c.members).sort((a, b) => compareNodeIds(a, b, byId)), children: chunk });
    }
    current = wrapped;
  }
  return current;
}

function flatten(forest: DraftCommunity[]): DraftCommunity[] {
  const out: DraftCommunity[] = [];
  const visit = (community: DraftCommunity, level: number, parentId: string | null) => {
    community.level = level;
    community.parentId = parentId;
    out.push(community);
    for (const child of community.children) visit(child, level + 1, community.id ?? null);
  };
  // IDs are assigned separately before parent IDs become meaningful.
  for (const root of forest) visit(root, 0, null);
  return out;
}

function jaccard(a: readonly string[], b: readonly string[]): { score: number; intersection: number } {
  const set = new Set(a);
  let intersection = 0;
  for (const value of b) if (set.has(value)) intersection++;
  return { score: intersection / (a.length + b.length - intersection || 1), intersection };
}

function assignCommunityIds(forest: DraftCommunity[], byId: ReadonlyMap<string, ConstellationRawNode>, previous: readonly PriorConstellationCommunity[]): DraftCommunity[] {
  const used = new Set<string>();
  const assign = (community: DraftCommunity, level: number, parentId: string | null) => {
    const uris = community.members.map((id) => byId.get(id)!.uri);
    const candidates = previous
      .filter((p) => p.level === level && !used.has(p.id))
      .map((p) => ({ prior: p, ...jaccard(uris, p.memberUris) }))
      .filter((p) => p.score >= 0.60)
      .sort((a, b) => b.score - a.score || b.intersection - a.intersection || a.prior.id.localeCompare(b.prior.id));
    community.id = candidates[0]?.prior.id ?? `com_${fnv64(`${CONSTELLATION_TOPOLOGY_VERSION}\0${parentId ?? 'root'}\0${uris.join('\0')}`)}`;
    if (candidates[0]) used.add(candidates[0].prior.id);
    community.level = level;
    community.parentId = parentId;
    for (const child of community.children) assign(child, level + 1, community.id);
  };
  for (const root of forest) assign(root, 0, null);
  return flatten(forest);
}

export function buildConstellationHierarchy(
  inputNodes: readonly ConstellationRawNode[],
  inputEdges: readonly ConstellationRawEdge[],
  previous: readonly PriorConstellationCommunity[] = [],
): HierarchyGenerationResult {
  const nodes = [...inputNodes].sort((a, b) => a.uri.localeCompare(b.uri));
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const rawDegree = new Map(nodes.map((n) => [n.nodeId, 0]));
  const validEdges: ConstellationRawEdge[] = [];
  let danglingEdges = 0;
  for (const edge of inputEdges) {
    if (!byId.has(edge.fromNodeId) || !byId.has(edge.toNodeId)) { danglingEdges++; continue; }
    validEdges.push(edge);
    rawDegree.set(edge.fromNodeId, rawDegree.get(edge.fromNodeId)! + 1);
    rawDegree.set(edge.toNodeId, rawDegree.get(edge.toNodeId)! + 1);
  }
  validEdges.sort((a, b) => a.type.localeCompare(b.type) ||
    byId.get(a.fromNodeId)!.uri.localeCompare(byId.get(b.fromNodeId)!.uri) ||
    byId.get(a.toNodeId)!.uri.localeCompare(byId.get(b.toNodeId)!.uri) || a.edgeId.localeCompare(b.edgeId));
  const unknownEdgeTypes = [...new Set(validEdges.map((e) => e.type).filter((type) => EDGE_WEIGHTS[type] === undefined))].sort();
  const weighted: WeightedEdge[] = validEdges.map((edge) => ({
    ...edge,
    weight: (EDGE_WEIGHTS[edge.type] ?? 1) /
      Math.sqrt(Math.max(1, rawDegree.get(edge.fromNodeId)!) * Math.max(1, rawDegree.get(edge.toNodeId)!)),
  }));
  const adjacency = new Map<string, Map<string, number>>();
  const weightedDegree = new Map(nodes.map((n) => [n.nodeId, 0]));
  for (const edge of weighted) {
    const a = adjacency.get(edge.fromNodeId) ?? new Map<string, number>();
    a.set(edge.toNodeId, (a.get(edge.toNodeId) ?? 0) + edge.weight);
    adjacency.set(edge.fromNodeId, a);
    const b = adjacency.get(edge.toNodeId) ?? new Map<string, number>();
    b.set(edge.fromNodeId, (b.get(edge.fromNodeId) ?? 0) + edge.weight);
    adjacency.set(edge.toNodeId, b);
    weightedDegree.set(edge.fromNodeId, weightedDegree.get(edge.fromNodeId)! + edge.weight);
    weightedDegree.set(edge.toNodeId, weightedDegree.get(edge.toNodeId)! + edge.weight);
  }
  const rank = new Map(nodes.map((n) => [n.nodeId, Math.log2(rawDegree.get(n.nodeId)! + 1) + weightedDegree.get(n.nodeId)!]));
  const components = connectedComponents(nodes.map((n) => n.nodeId), adjacency, byId);
  const forest = wrapForest(components.map((members) => buildCommunity(members, adjacency, rank, byId)), byId);
  const communities = assignCommunityIds(forest, byId, previous);

  const pathByNode = new Map<string, DraftCommunity[]>();
  for (const community of communities) {
    for (const nodeId of community.members) {
      const path = pathByNode.get(nodeId) ?? [];
      path[community.level!] = community;
      pathByNode.set(nodeId, path);
    }
  }
  const leafByNode = new Map([...pathByNode].map(([id, path]) => [id, path[path.length - 1]!]));
  const boundaryDegree = new Map(nodes.map((n) => [n.nodeId, 0]));
  for (const edge of weighted) {
    if (leafByNode.get(edge.fromNodeId)?.id === leafByNode.get(edge.toNodeId)?.id) continue;
    boundaryDegree.set(edge.fromNodeId, boundaryDegree.get(edge.fromNodeId)! + edge.weight);
    boundaryDegree.set(edge.toNodeId, boundaryDegree.get(edge.toNodeId)! + edge.weight);
  }

  const connectivity = new Map(communities.map((community) => [community.id!, { internalEdgeCount: 0, internalWeight: 0, boundaryWeight: 0 }]));
  for (const edge of weighted) {
    const aPath = pathByNode.get(edge.fromNodeId)!, bPath = pathByNode.get(edge.toNodeId)!;
    const aIds = new Set(aPath.map((community) => community.id!));
    const bIds = new Set(bPath.map((community) => community.id!));
    for (const id of aIds) {
      const stats = connectivity.get(id)!;
      if (bIds.has(id)) { stats.internalEdgeCount++; stats.internalWeight += edge.weight; }
      else stats.boundaryWeight += edge.weight;
    }
    for (const id of bIds) if (!aIds.has(id)) connectivity.get(id)!.boundaryWeight += edge.weight;
  }
  const summaries = communities.map((community) => {
    const { internalEdgeCount, internalWeight, boundaryWeight } = connectivity.get(community.id!)!;
    const typeCounts: Record<string, number> = {};
    for (const id of community.members) typeCounts[byId.get(id)!.type] = (typeCounts[byId.get(id)!.type] ?? 0) + 1;
    const representative = [...community.members].sort((a, b) => (rank.get(b)! - rank.get(a)!) || compareNodeIds(a, b, byId))[0]!;
    return {
      id: community.id!, parentId: community.parentId!, level: community.level!, label: byId.get(representative)!.label,
      memberCount: community.members.length, childCount: community.children.length, typeCounts, internalEdgeCount,
      internalWeight, normalizedCohesion: internalWeight / (internalWeight + boundaryWeight || 1), boundaryWeight,
      anchor: anchorFor(community.id!),
    };
  });

  const maxDepth = communities.reduce((max, c) => Math.max(max, c.level!), 0);
  const links: HierarchyGenerationData['links'] = [];
  for (let level = 0; level <= maxDepth; level++) {
    const aggregate = new Map<string, { from: string; to: string; forward: boolean; reverse: boolean; count: number; weight: number; byType: Record<string, number> }>();
    for (const edge of weighted) {
      const aPath = pathByNode.get(edge.fromNodeId)!, bPath = pathByNode.get(edge.toNodeId)!;
      const a = aPath[Math.min(level, aPath.length - 1)]!.id!, b = bPath[Math.min(level, bPath.length - 1)]!.id!;
      if (a === b) continue;
      const forward = a < b;
      const from = forward ? a : b, to = forward ? b : a;
      const key = `${from}\0${to}`;
      const row = aggregate.get(key) ?? { from, to, forward: false, reverse: false, count: 0, weight: 0, byType: {} };
      if (forward) row.forward = true; else row.reverse = true;
      row.count++;
      row.weight += edge.weight;
      row.byType[edge.type] = (row.byType[edge.type] ?? 0) + 1;
      aggregate.set(key, row);
    }
    for (const row of [...aggregate.values()].sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))) {
      links.push({ level, fromCommunityId: row.from, toCommunityId: row.to, direction: row.forward && row.reverse ? 'both' : row.forward ? 'forward' : 'reverse', count: row.count, weight: row.weight, byType: row.byType });
    }
  }

  return {
    data: {
      nodeStats: nodes.map((n) => ({ nodeId: n.nodeId, degree: rawDegree.get(n.nodeId)!, weightedDegree: weightedDegree.get(n.nodeId)!, rank: rank.get(n.nodeId)!, boundaryDegree: boundaryDegree.get(n.nodeId)! })),
      communities: summaries,
      memberships: nodes.map((n) => ({ nodeId: n.nodeId, communityId: leafByNode.get(n.nodeId)!.id!, level: leafByNode.get(n.nodeId)!.level! })),
      links,
    },
    diagnostics: { nodeCount: nodes.length, edgeCount: validEdges.length, danglingEdges, unknownEdgeTypes, maxDepth },
  };
}

export function constellationSourceIsCurrent(sourceRevision: number, currentRevision: number): boolean {
  return sourceRevision === currentRevision;
}
