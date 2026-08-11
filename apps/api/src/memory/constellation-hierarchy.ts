import type { ConstellationRawEdge, ConstellationRawNode } from './graph-queries';

export const CONSTELLATION_TOPOLOGY_VERSION = 'semantic-roots-v4';
export const CONSTELLATION_LAYOUT_VERSION = 'space-v1';
export const CONSTELLATION_MAX_CHILDREN = 128;
export const CONSTELLATION_LEAF_SIZE = 500;
export const CONSTELLATION_COMMUNITY_LABEL_MAX_LENGTH = 40;

const CONSTELLATION_ROOT_COMMUNITY_MIN_SIZE = 8;
const COMMUNITY_SCORE_EPSILON = 1e-12;

const EDGE_WEIGHTS: Readonly<Record<string, number>> = {
  calls: 4, imports: 4, depends_on: 4, tests: 4, validated_by: 4, implements: 4,
  modifies: 3, declares: 3, derived_from: 3, decided_by: 3, observed_in: 3, commonly_changes_with: 3,
  blocks: 2, owned_by: 2, failed_because: 2,
  related_to: 1, supersedes: 1, contradicts: 1,
};

export const constellationEdgeBaseWeight = (type: string): number => EDGE_WEIGHTS[type] ?? 1;

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
interface DraftCommunity { members: string[]; children: DraftCommunity[]; labelHint?: string; id?: string; level?: number; parentId?: string | null }

function fnv64(input: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = BigInt.asUintN(64, h * 0x100000001b3n);
  }
  return h.toString(16).padStart(16, '0');
}

export function anchorFor(id: string): [number, number, number] {
  const unit = (salt: string) => (Number.parseInt(fnv64(`${salt}:${id}`).slice(0, 8), 16) / 0xffffffff) * 2 - 1;
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

function mergeDetectedCommunities(
  detected: string[][],
  adjacency: ReadonlyMap<string, Map<string, number>>,
  byId: ReadonlyMap<string, ConstellationRawNode>,
): string[][] {
  const groups = detected.map((members) => [...members].sort((a, b) => compareNodeIds(a, b, byId)));
  const compareGroups = (a: string[], b: string[]) => a.length - b.length || compareNodeIds(a[0]!, b[0]!, byId);
  const mergeSmallest = (onlyBelowFloor: boolean) => {
    const source = groups
      .map((members, index) => ({ members, index }))
      .filter(({ members }) => !onlyBelowFloor || members.length < CONSTELLATION_ROOT_COMMUNITY_MIN_SIZE)
      .sort((a, b) => compareGroups(a.members, b.members))[0];
    if (!source || groups.length <= 1) return false;
    const groupByNode = new Map(groups.flatMap((members, index) => members.map((id) => [id, index] as const)));
    const weights = new Map<number, number>();
    for (const id of source.members) {
      const neighbors = [...(adjacency.get(id) ?? [])].sort((a, b) => compareNodeIds(a[0], b[0], byId));
      for (const [neighbor, weight] of neighbors) {
        const target = groupByNode.get(neighbor)!;
        if (target !== source.index) weights.set(target, (weights.get(target) ?? 0) + weight);
      }
    }
    const target = [...weights]
      .sort((a, b) => b[1] - a[1] || compareNodeIds(groups[a[0]]![0]!, groups[b[0]]![0]!, byId))[0]?.[0];
    if (target === undefined) throw new Error('connected constellation community has no merge neighbor');
    const merged = [...source.members, ...groups[target]!].sort((a, b) => compareNodeIds(a, b, byId));
    for (const index of [source.index, target].sort((a, b) => b - a)) groups.splice(index, 1);
    groups.push(merged);
    return true;
  };
  while (groups.length > 1 && groups.some((members) => members.length < CONSTELLATION_ROOT_COMMUNITY_MIN_SIZE)) mergeSmallest(true);
  while (groups.length > CONSTELLATION_MAX_CHILDREN) mergeSmallest(false);
  return groups.sort((a, b) => compareNodeIds(a[0]!, b[0]!, byId));
}

/** Deterministic weighted Louvain local moving for promoted connected components. Each move
 * strictly improves modularity (with canonical-label ties), while sorted nodes, neighbors, and
 * candidates make the result byte-stable; tiny/capped communities merge across their strongest
 * shared boundary so structural promotion cannot recreate the old singleton soup. */
function detectConnectivityCommunities(
  members: string[],
  adjacency: ReadonlyMap<string, Map<string, number>>,
  byId: ReadonlyMap<string, ConstellationRawNode>,
): string[][] {
  const ordered = [...members].sort((a, b) => compareNodeIds(a, b, byId));
  const degree = new Map(ordered.map((id) => [id, [...(adjacency.get(id)?.values() ?? [])].reduce((sum, weight) => sum + weight, 0)]));
  const totalDegree = [...degree.values()].reduce((sum, value) => sum + value, 0);
  const communityByNode = new Map(ordered.map((id) => [id, id]));
  const communityDegree = new Map(degree);
  for (let iteration = 0; iteration < Math.min(100, ordered.length); iteration++) {
    let changed = false;
    for (const id of ordered) {
      const current = communityByNode.get(id)!;
      const nodeDegree = degree.get(id)!;
      const weightsByCommunity = new Map<string, number>();
      const neighbors = [...(adjacency.get(id) ?? [])].sort((a, b) => compareNodeIds(a[0], b[0], byId));
      for (const [neighbor, weight] of neighbors) {
        const community = communityByNode.get(neighbor)!;
        weightsByCommunity.set(community, (weightsByCommunity.get(community) ?? 0) + weight);
      }
      communityDegree.set(current, communityDegree.get(current)! - nodeDegree);
      const score = (community: string) => (weightsByCommunity.get(community) ?? 0)
        - (nodeDegree * (communityDegree.get(community) ?? 0)) / totalDegree;
      let best = current;
      const currentScore = score(current);
      let bestScore = currentScore;
      const candidates = [...weightsByCommunity.keys()].sort((a, b) => compareNodeIds(a, b, byId));
      for (const candidate of candidates) {
        const candidateScore = score(candidate);
        if (candidateScore > bestScore + COMMUNITY_SCORE_EPSILON
          || (candidateScore > currentScore + COMMUNITY_SCORE_EPSILON
            && Math.abs(candidateScore - bestScore) <= COMMUNITY_SCORE_EPSILON
            && compareNodeIds(candidate, best, byId) < 0)) {
          best = candidate;
          bestScore = candidateScore;
        }
      }
      communityByNode.set(id, best);
      communityDegree.set(best, (communityDegree.get(best) ?? 0) + nodeDegree);
      changed ||= best !== current;
    }
    if (!changed) break;
  }
  const detected = new Map<string, string[]>();
  for (const id of ordered) {
    const community = communityByNode.get(id)!;
    const group = detected.get(community) ?? [];
    group.push(id);
    detected.set(community, group);
  }
  return mergeDetectedCommunities([...detected.values()], adjacency, byId);
}

function dominantType(members: readonly string[], byId: ReadonlyMap<string, ConstellationRawNode>): string {
  const counts = new Map<string, number>();
  for (const id of members) counts.set(byId.get(id)!.type, (counts.get(byId.get(id)!.type) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
}

function boundedLabel(value: string): string {
  // Decode ampersands last so an upstream double-escape stays single-escaped, not over-decoded.
  const decoded = value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const normalized = decoded.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized.length <= CONSTELLATION_COMMUNITY_LABEL_MAX_LENGTH) return normalized || 'Community';
  return `${normalized.slice(0, CONSTELLATION_COMMUNITY_LABEL_MAX_LENGTH - 1).trimEnd()}…`;
}

function typeLabel(type: string): string {
  const singular = type.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
  const irregular: Readonly<Record<string, string>> = { memory: 'Memories', repository: 'Repositories' };
  return boundedLabel(irregular[type] ?? `${singular}${singular.endsWith('s') ? '' : 's'}`);
}

function structuralLabel(community: DraftCommunity, byId: ReadonlyMap<string, ConstellationRawNode>): string {
  if (community.labelHint) return boundedLabel(community.labelHint);
  const counts = new Map<string, number>();
  for (const id of community.members) counts.set(byId.get(id)!.type, (counts.get(byId.get(id)!.type) ?? 0) + 1);
  const types = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const visible = types.slice(0, 2).map(([type]) => typeLabel(type)).join(' / ');
  return boundedLabel(`${visible}${types.length > 2 ? ` +${types.length - 2}` : ''}`);
}

function promotedPlanLabel(
  members: readonly string[],
  degree: ReadonlyMap<string, number>,
  byId: ReadonlyMap<string, ConstellationRawNode>,
): string | undefined {
  const plan = members
    .filter((id) => byId.get(id)!.type === 'plan')
    .sort((a, b) => degree.get(b)! - degree.get(a)! || compareNodeIds(a, b, byId))[0];
  return plan ? boundedLabel(byId.get(plan)!.label) : undefined;
}

function consolidateComponents(
  components: readonly string[][],
  adjacency: ReadonlyMap<string, Map<string, number>>,
  rank: ReadonlyMap<string, number>,
  degree: ReadonlyMap<string, number>,
  byId: ReadonlyMap<string, ConstellationRawNode>,
): DraftCommunity[] {
  const roots: DraftCommunity[] = [];
  const smallByType = new Map<string, string[][]>();
  for (const members of components) {
    if (members.length >= CONSTELLATION_ROOT_COMMUNITY_MIN_SIZE) {
      for (const detected of detectConnectivityCommunities(members, adjacency, byId)) {
        const community = buildCommunity(detected, adjacency, rank, byId);
        roots.push({ ...community, labelHint: promotedPlanLabel(detected, degree, byId) });
      }
      continue;
    }
    const type = dominantType(members, byId);
    const grouped = smallByType.get(type) ?? [];
    grouped.push(members);
    smallByType.set(type, grouped);
  }
  // Type is universal, stable, and already drives constellation tinting. Assigning each small
  // whole component by its dominant type consolidates isolates without severing real edges;
  // grouping by URI namespace would turn per-entity IDs and file paths into singleton buckets.
  for (const [type, grouped] of [...smallByType].sort((a, b) => a[0].localeCompare(b[0]))) {
    const members = grouped.flat().sort((a, b) => compareNodeIds(a, b, byId));
    roots.push({ ...buildCommunity(members, adjacency, rank, byId), labelHint: typeLabel(type) });
  }
  return roots.sort((a, b) => compareNodeIds(a.members[0]!, b.members[0]!, byId));
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
  const forest = wrapForest(consolidateComponents(components, adjacency, rank, rawDegree, byId), byId);
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
    return {
      id: community.id!, parentId: community.parentId!, level: community.level!, label: structuralLabel(community, byId),
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
