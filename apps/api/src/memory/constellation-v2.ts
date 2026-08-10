export const CONSTELLATION_V2_DEFAULT_ENTITY_LIMIT = 256;
export const CONSTELLATION_V2_MAX_ENTITY_LIMIT = 500;
export const CONSTELLATION_V2_DEFAULT_INCIDENT_LIMIT = 256;
export const CONSTELLATION_V2_MAX_INCIDENT_LIMIT = 500;
export const CONSTELLATION_V2_MAX_OVERVIEW_ROUTES = 512;
export const CONSTELLATION_V2_COMPACT_MEDIA_TYPE = 'application/vnd.noriq.constellation-v2.compact+json';

export interface ConstellationV2Revision {
  contract: 'constellation-v2';
  generationId: string;
  sourceRevision: number;
  currentRevision: number;
  topologyVersion: string;
  layoutVersion: string;
  state: 'current' | 'stale' | 'building';
  generatedAt: string;
}

export interface ConstellationV2Head {
  revision: ConstellationV2Revision;
}

export interface ConstellationV2Coverage {
  complete: boolean;
  reasons: Array<'page-limit-reached' | 'generation-stale' | 'excluded-at-this-level'>;
}

export interface ConstellationV2Community {
  id: string;
  parentId: string | null;
  level: number;
  label: string;
  memberCount: number;
  childCommunityCount: number;
  typeCounts: Record<string, number>;
  internalEdgeCount: number;
  internalWeight: number;
  normalizedCohesion: number;
  boundaryWeight: number;
  anchor: [number, number, number];
}

export interface ConstellationV2AggregateRoute {
  fromCommunityId: string;
  toCommunityId: string;
  direction: 'forward' | 'reverse' | 'both';
  count: number;
  weight: number;
  byType: Record<string, number>;
}

export interface ConstellationV2Entity {
  nodeId: string;
  uri: string;
  type: string;
  kind: string | null;
  label: string;
  authority: number | null;
  validity: string | null;
  isLead: boolean | null;
  leadReasons: string[] | null;
  degree: number;
  boundaryDegree: number;
  groupKey: string;
  communityId: string;
  position: [number, number, number];
}

export interface ConstellationV2Overview {
  revision: ConstellationV2Revision;
  communities: ConstellationV2Community[];
  routes: ConstellationV2AggregateRoute[];
  coverage: ConstellationV2Coverage;
}

export interface ConstellationV2CommunityPage {
  revision: ConstellationV2Revision;
  community: ConstellationV2Community;
  kind: 'communities' | 'entities';
  communities: ConstellationV2Community[];
  entities: ConstellationV2Entity[];
  routes: ConstellationV2AggregateRoute[];
  externalCommunities: ConstellationV2Community[];
  nextCursor: string | null;
  coverage: ConstellationV2Coverage;
}

export interface ConstellationV2Route {
  revision: ConstellationV2Revision;
  nodeId: string;
  uri: string;
  communityPath: ConstellationV2Community[];
}

export interface ConstellationV2IncidentEdge {
  edgeId: string;
  type: string;
  direction: 'incoming' | 'outgoing';
  provenance: string | null;
  endpoint: { nodeId: string; uri: string; type: string; label: string; communityPath: ConstellationV2Community[] };
}

export interface ConstellationV2IncidentPage {
  revision: ConstellationV2Revision;
  node: { nodeId: string; uri: string; type: string; label: string; communityPath: ConstellationV2Community[] };
  edges: ConstellationV2IncidentEdge[];
  nextCursor: string | null;
  coverage: ConstellationV2Coverage;
}

export type ConstellationV2Unavailable = {
  ok: false;
  error: 'generation-unavailable' | 'generation-stale' | 'not-found' | 'cursor-stale';
  currentRevision: number;
  retryAfter?: number;
};

export interface ConstellationV2CompactDictionary {
  ids: string[];
  uris: string[];
  labels: string[];
  types: string[];
  kinds: Array<string | null>;
}

export interface ConstellationV2CompactCommunityPage {
  encoding: 'constellation-v2-community-v1';
  dictionary: ConstellationV2CompactDictionary;
  revision: ConstellationV2Revision;
  community: ConstellationV2Community;
  kind: 'communities' | 'entities';
  communities: ConstellationV2Community[];
  /** node id, uri, type, kind, label, authority, validity, lead, reasons, degree, boundary degree, group, community id, x, y, z */
  entities: Array<[number, number, number, number, number, number | null, string | null, boolean | null, string[] | null, number, number, number, number, number, number, number]>;
  /** from community id, to community id, direction, count, weight, by-type */
  routes: Array<[number, number, ConstellationV2AggregateRoute['direction'], number, number, Record<string, number>]>;
  externalCommunities: ConstellationV2Community[];
  nextCursor: string | null;
  coverage: ConstellationV2Coverage;
}

export interface ConstellationV2CompactIncidentPage {
  encoding: 'constellation-v2-incidents-v1';
  dictionary: ConstellationV2CompactDictionary;
  revision: ConstellationV2Revision;
  /** node id, uri, type, label */
  node: [number, number, number, number, ConstellationV2Community[]];
  /** edge id, type, direction, provenance, endpoint id, uri, type, label, community path */
  edges: Array<[number, number, ConstellationV2IncidentEdge['direction'], string | null, number, number, number, number, ConstellationV2Community[]]>;
  nextCursor: string | null;
  coverage: ConstellationV2Coverage;
}

interface CursorPayload {
  v: 1;
  generationId: string;
  currentRevision: number;
  scope: string;
  after: string;
}

export function encodeConstellationCursor(payload: Omit<CursorPayload, 'v'>): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, ...payload }));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeConstellationCursor(raw: string | undefined): CursorPayload | null {
  if (!raw) return null;
  try {
    const padded = raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - raw.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<CursorPayload>;
    if (parsed.v !== 1 || typeof parsed.generationId !== 'string' || typeof parsed.currentRevision !== 'number' || typeof parsed.scope !== 'string' || typeof parsed.after !== 'string') return null;
    return parsed as CursorPayload;
  } catch {
    return null;
  }
}

export function clampConstellationLimit(limit: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(limit!)));
}

export function cursorMatches(cursor: CursorPayload | null, generationId: string, currentRevision: number, scope: string): boolean {
  return cursor === null || (cursor.generationId === generationId && cursor.currentRevision === currentRevision && cursor.scope === scope);
}

export function constellationEntityPosition(uri: string, anchor: [number, number, number]): [number, number, number] {
  const hash = (salt: string) => {
    let value = 0x811c9dc5;
    const input = `${uri}:${salt}`;
    for (let i = 0; i < input.length; i++) { value ^= input.charCodeAt(i); value = Math.imul(value, 0x01000193); }
    return (value >>> 0) / 0xffffffff * 2 - 1;
  };
  return [anchor[0] + hash('x') * 80, anchor[1] + hash('y') * 80, anchor[2] + hash('z') * 80];
}

function compactDictionary() {
  const dictionary: ConstellationV2CompactDictionary = { ids: [], uris: [], labels: [], types: [], kinds: [] };
  const indices = {
    ids: new Map<string, number>(), uris: new Map<string, number>(), labels: new Map<string, number>(),
    types: new Map<string, number>(), kinds: new Map<string | null, number>(),
  };
  const add = <T extends string | null>(values: T[], index: Map<T, number>, value: T) => {
    const existing = index.get(value);
    if (existing !== undefined) return existing;
    const next = values.length;
    values.push(value);
    index.set(value, next);
    return next;
  };
  return {
    dictionary,
    id: (value: string) => add(dictionary.ids, indices.ids, value),
    uri: (value: string) => add(dictionary.uris, indices.uris, value),
    label: (value: string) => add(dictionary.labels, indices.labels, value),
    type: (value: string) => add(dictionary.types, indices.types, value),
    kind: (value: string | null) => add(dictionary.kinds, indices.kinds, value),
  };
}

export function compactConstellationCommunityPage(page: ConstellationV2CommunityPage): ConstellationV2CompactCommunityPage {
  const dict = compactDictionary();
  const entities: ConstellationV2CompactCommunityPage['entities'] = page.entities.map((entity) => [
    dict.id(entity.nodeId), dict.uri(entity.uri), dict.type(entity.type), dict.kind(entity.kind), dict.label(entity.label),
    entity.authority, entity.validity, entity.isLead, entity.leadReasons, entity.degree, entity.boundaryDegree,
    dict.type(entity.groupKey), dict.id(entity.communityId), ...entity.position,
  ]);
  const routes: ConstellationV2CompactCommunityPage['routes'] = page.routes.map((route) => [
    dict.id(route.fromCommunityId), dict.id(route.toCommunityId), route.direction, route.count, route.weight, route.byType,
  ]);
  return { ...page, encoding: 'constellation-v2-community-v1', dictionary: dict.dictionary, entities, routes };
}

export function compactConstellationIncidentPage(page: ConstellationV2IncidentPage): ConstellationV2CompactIncidentPage {
  const dict = compactDictionary();
  return {
    encoding: 'constellation-v2-incidents-v1', dictionary: dict.dictionary, revision: page.revision,
    node: [dict.id(page.node.nodeId), dict.uri(page.node.uri), dict.type(page.node.type), dict.label(page.node.label), page.node.communityPath],
    edges: page.edges.map((edge) => [
      dict.id(edge.edgeId), dict.type(edge.type), edge.direction, edge.provenance, dict.id(edge.endpoint.nodeId),
      dict.uri(edge.endpoint.uri), dict.type(edge.endpoint.type), dict.label(edge.endpoint.label), edge.endpoint.communityPath,
    ]),
    nextCursor: page.nextCursor, coverage: page.coverage,
  };
}
