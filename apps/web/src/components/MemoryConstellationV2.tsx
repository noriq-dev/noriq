import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api, ApiError, type ApiConstellationV2Community, type ApiConstellationV2CommunityPage, type ApiConstellationV2IncidentPage,
  type ApiConstellationLens, type ApiConstellationV2Overview, type ApiMemoryHit,
} from '../api';
import { useTheme } from '../theme';
import { Select, TextInput } from './ui';
import { MonoTag } from './bits';
import { CONSTELLATION_SHAPE_GLYPH, encodingForType } from './constellation-encoding';
import { ConstellationCatalogue } from './ConstellationCatalogue';
import { ConstellationInspector } from './ConstellationInspector';
import {
  assembleConstellationV2Scene, CONSTELLATION_V2_RESIDENT_NODE_BUDGET, evictConstellationPages, type ResidentConstellationPage,
} from './constellation-v2-scene';

const LazyConstellation3D = lazy(() => import('./MemoryConstellation3D'));

// The overview encoding legend's rows (PLNR-438) — the Navigator conventions doc §1's "locked,
// not re-litigated" primary types, in the design's own order. Reads shape/token/label straight
// off constellation-encoding.ts (PLNR-437) so the legend can never disagree with what the renderer
// actually draws — this is the "same colour source" the task explicitly warns against duplicating.
const LEGEND_TYPES = ['memory', 'task', 'artifact', 'file', 'plan'] as const;

// PLNR-443 audit fix: the search "Matches" panel below (screen spec 1c) has a fixed dark background
// (`rgba(14,16,20,.96)`) in BOTH themes, same as the docked inspector (ConstellationInspector.tsx,
// which documents the same reasoning) — its `var(--text*)`/`var(--line)` children must therefore use
// the dark theme's own fixed values rather than the theme-following tokens, which flip to near-black
// in light theme and become illegible against this panel's own always-dark fill.
const MATCHES_TEXT = '#e6e8ec';
const MATCHES_TEXT_SOFT = '#c9ccd1';
const MATCHES_TEXT_MID = '#8a8f98';
const MATCHES_TEXT_DIM = '#6b7280';
const MATCHES_LINE = 'rgba(255,255,255,.07)';
const CONSTELLATION_AUTO_EXPANSION_CONCURRENCY = 4;

export const constellationLensStorageKey = (projectId: string) => `noriq.memory.constellationLens.${projectId}`;
export function loadConstellationLens(projectId: string, storage: Pick<Storage, 'getItem'> = localStorage): ApiConstellationLens {
  try { return storage.getItem(constellationLensStorageKey(projectId)) === 'plans' ? 'plans' : 'memories'; }
  catch { return 'memories'; }
}
export function saveConstellationLens(projectId: string, lens: ApiConstellationLens, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try { storage.setItem(constellationLensStorageKey(projectId), lens); } catch { /* optional local preference */ }
}

interface LoadedCommunity {
  page: ApiConstellationV2CommunityPage;
  touchedAt: number;
}

const residentPageNodeCount = (page: ApiConstellationV2CommunityPage) => page.communities.length + page.entities.length;

const mergeUnique = <T,>(left: T[], right: T[], key: (value: T) => string): T[] => {
  const values = new Map(left.map((value) => [key(value), value]));
  for (const value of right) values.set(key(value), value);
  return [...values.values()];
};

export function mergeConstellationCommunityPages(
  current: ApiConstellationV2CommunityPage | null,
  next: ApiConstellationV2CommunityPage,
): ApiConstellationV2CommunityPage {
  if (!current || current.kind !== next.kind || current.revision.generationId !== next.revision.generationId) return next;
  const reasons = [...new Set([...current.coverage.reasons, ...next.coverage.reasons])]
    .filter((reason) => next.nextCursor !== null || reason !== 'page-limit-reached');
  return {
    ...next,
    communities: mergeUnique(current.communities, next.communities, (value) => value.id),
    entities: mergeUnique(current.entities, next.entities, (value) => value.nodeId),
    backboneEdges: mergeUnique(current.backboneEdges, next.backboneEdges, (value) => value.edgeId),
    routes: mergeUnique(current.routes, next.routes, (value) => `${value.fromCommunityId}:${value.toCommunityId}`),
    externalCommunities: mergeUnique(current.externalCommunities, next.externalCommunities, (value) => value.id),
    coverage: { complete: next.nextCursor === null && reasons.length === 0, reasons },
  };
}

export function MemoryConstellationV2({
  pid, onOpenEgoNetwork, onOpenInspector, onFallback,
}: {
  pid: string;
  onOpenEgoNetwork?: (uri: string) => void;
  onOpenInspector?: (uri: string) => void;
  onFallback?: (reason: string) => void;
}) {
  const [theme] = useTheme();
  const [lens, setLens] = useState<ApiConstellationLens>(() => loadConstellationLens(pid));
  const [overview, setOverview] = useState<ApiConstellationV2Overview | null>(null);
  const overviewRef = useRef<ApiConstellationV2Overview | null>(null);
  const [residents, setResidents] = useState<Map<string, LoadedCommunity>>(new Map());
  const residentsRef = useRef(residents);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [cameraFocusRequest, setCameraFocusRequest] = useState<{ nodeId: string; serial: number } | null>(null);
  const cameraFocusSerialRef = useRef(0);
  const [autoExpansionComplete, setAutoExpansionComplete] = useState(false);
  const [incidentPages, setIncidentPages] = useState<ApiConstellationV2IncidentPage[]>([]);
  // True while an incident page (initial selection or a "load next page" continuation) is in
  // flight — surfaced to the docked inspector so its relationship coverage line can say "loading…"
  // instead of a premature "0 of N" between the click and the fetch resolving.
  const [relationshipsLoading, setRelationshipsLoading] = useState(false);
  const incidentAbortRef = useRef<AbortController | null>(null);
  const selectionSerialRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [expanding, setExpanding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ApiMemoryHit[]>([]);
  const [searching, setSearching] = useState(false);
  // Search ignite (PLNR-441): a hit's containing-community ancestry, resolved through the SAME
  // `memoryConstellationV2Route` endpoint focusHit already uses to route on pick — no new endpoint.
  // At overview level no entity is resident, so this is the only way to know which community to
  // flare or which community an off-page result line names; keyed by uri and never cleared on a
  // narrowing requery so a hit seen again (e.g. backspaced back to) doesn't refetch.
  const [hitRoutes, setHitRoutes] = useState<Map<string, ApiConstellationV2Community[]>>(new Map());
  const hitRoutesRef = useRef(hitRoutes);
  const [rendererFailure, setRendererFailure] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState('');
  // Default open, matching the design reference; toggleable per the screen spec ("which the design
  // exposes as a toggle") — this task's discretion on the default.
  const [legendOpen, setLegendOpen] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  // Space is the 3D scene, Catalogue is the textual peer (PLNR-380). A renderer failure forces
  // Catalogue regardless of this — see `showCatalogue` below — but the human can also choose it deliberately.
  const [viewMode, setViewMode] = useState<'space' | 'catalogue'>('space');
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { residentsRef.current = residents; }, [residents]);
  useEffect(() => { setLens(loadConstellationLens(pid)); }, [pid]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  // The header search field's `/` affordance: focuses search unless the user is already typing somewhere.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      event.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const loadOverview = useCallback(async (signal?: AbortSignal) => {
    const value = await api.memoryConstellationV2Overview(pid, lens, signal);
    incidentAbortRef.current?.abort();
    overviewRef.current = value;
    setOverview(value);
    residentsRef.current = new Map();
    setResidents(new Map()); setSelectedNodeId(null); setCameraFocusRequest(null); setIncidentPages([]);
    hitRoutesRef.current = new Map(); setHitRoutes(new Map());
    setRelationshipsLoading(false); setAutoExpansionComplete(false);
    return value;
  }, [pid, lens]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    loadOverview(controller.signal).then(() => setLoading(false)).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      const message = reason instanceof ApiError ? reason.message : 'Constellation v2 is unavailable';
      setError(message); setLoading(false); onFallback?.(message);
    });
    return () => controller.abort();
  }, [loadOverview, onFallback]);

  const storeResident = useCallback((communityId: string, page: ApiConstellationV2CommunityPage, mode: 'auto' | 'interactive'): boolean => {
    const updated = new Map(residentsRef.current);
    updated.set(communityId, { page, touchedAt: performance.now() });
    const requestedTotal = [...updated.values()].reduce((sum, value) => sum + residentPageNodeCount(value.page), 0);
    if (mode === 'auto' && requestedTotal > CONSTELLATION_V2_RESIDENT_NODE_BUDGET) return false;
    const bounded = evictConstellationPages([...updated].map(([id, value]): ResidentConstellationPage<LoadedCommunity> => ({
      communityId: id, value, nodeCount: residentPageNodeCount(value.page),
      touchedAt: value.touchedAt, pinned: mode === 'interactive' && id === communityId,
    })));
    if (bounded.reduce((sum, entry) => sum + entry.nodeCount, 0) > CONSTELLATION_V2_RESIDENT_NODE_BUDGET) {
      throw new Error('This system exceeds the 12,000-node resident budget and cannot be loaded in full');
    }
    const next = new Map(bounded.map((entry) => [entry.communityId, entry.value]));
    residentsRef.current = next;
    setResidents(next);
    return true;
  }, []);

  const fetchCompleteCommunity = useCallback(async (
    communityId: string,
    signal?: AbortSignal,
    initial: ApiConstellationV2CommunityPage | null = null,
  ) => {
    const fetchTree = async (id: string, seed: ApiConstellationV2CommunityPage | null): Promise<ApiConstellationV2CommunityPage> => {
      let merged = seed;
      let cursor = seed?.nextCursor ?? undefined;
      if (!merged || cursor) {
        do {
          const next = await api.memoryConstellationV2Community(pid, id, { cursor, limit: 256, lens }, signal);
          if (next.revision.generationId !== overviewRef.current?.revision.generationId || next.lens && next.lens !== lens) {
            throw new Error('Constellation generation changed');
          }
          merged = mergeConstellationCommunityPages(merged, next);
          cursor = next.nextCursor ?? undefined;
        } while (cursor);
      }
      if (!merged || merged.kind !== 'communities') return merged!;
      const descendants: ApiConstellationV2CommunityPage[] = [];
      for (const child of [...merged.communities].sort((a, b) => a.id.localeCompare(b.id))) {
        descendants.push(await fetchTree(child.id, null));
      }
      return {
        ...merged,
        kind: 'entities',
        communities: mergeUnique(merged.communities, descendants.flatMap((page) => [page.community, ...page.communities]), (value) => value.id),
        entities: mergeUnique(merged.entities, descendants.flatMap((page) => page.entities), (value) => value.nodeId),
        backboneEdges: mergeUnique(merged.backboneEdges, descendants.flatMap((page) => page.backboneEdges), (value) => value.edgeId),
        routes: mergeUnique(merged.routes, descendants.flatMap((page) => page.routes), (value) => `${value.fromCommunityId}:${value.toCommunityId}`),
        externalCommunities: mergeUnique(merged.externalCommunities, descendants.flatMap((page) => page.externalCommunities), (value) => value.id),
        nextCursor: null,
        coverage: {
          complete: [merged, ...descendants].every((page) => page.coverage.complete),
          reasons: [...new Set([merged, ...descendants].flatMap((page) => page.coverage.reasons))],
        },
      };
    };
    return fetchTree(communityId, initial);
  }, [pid, lens]);

  const ensureCommunityResident = useCallback(async (communityId: string): Promise<boolean> => {
    setExpanding(true); setError(null);
    try {
      const existing = residentsRef.current.get(communityId)?.page ?? null;
      const loaded = await fetchCompleteCommunity(communityId, undefined, existing);
      storeResident(communityId, loaded, 'interactive');
      return true;
    } catch (reason) {
      if (reason instanceof Error && reason.message === 'Constellation generation changed') await loadOverview();
      else setError(reason instanceof Error ? reason.message : 'System loading failed');
      return false;
    } finally { setExpanding(false); }
  }, [fetchCompleteCommunity, loadOverview, storeResident]);

  // Wells arrive with the overview first. Member pages then stream in four at a time, largest
  // systems first; results are committed in that same order so budget admission is deterministic
  // even when network completion order is not. Generation cleanup aborts every in-flight page.
  useEffect(() => {
    if (!overview) return;
    const controller = new AbortController();
    const generationId = overview.revision.generationId;
    setAutoExpansionComplete(false);
    const ordered = [...overview.communities].sort((a, b) => b.memberCount - a.memberCount || a.id.localeCompare(b.id));
    const candidates: ApiConstellationV2Community[] = [];
    let plannedNodes = 0;
    for (const community of ordered) {
      if (plannedNodes + community.memberCount > CONSTELLATION_V2_RESIDENT_NODE_BUDGET) continue;
      plannedNodes += community.memberCount;
      candidates.push(community);
    }
    void (async () => {
      for (let index = 0; index < candidates.length; index += CONSTELLATION_AUTO_EXPANSION_CONCURRENCY) {
        const batch = candidates.slice(index, index + CONSTELLATION_AUTO_EXPANSION_CONCURRENCY);
        const settled = await Promise.allSettled(batch.map((community) => fetchCompleteCommunity(community.id, controller.signal)));
        if (controller.signal.aborted || overviewRef.current?.revision.generationId !== generationId) return;
        if (settled.some((result) => result.status === 'rejected'
          && result.reason instanceof Error && result.reason.message === 'Constellation generation changed')) {
          await loadOverview(controller.signal);
          return;
        }
        settled.forEach((result, offset) => {
          if (result.status === 'fulfilled' && !residentsRef.current.has(batch[offset]!.id)) {
            storeResident(batch[offset]!.id, result.value, 'auto');
          }
        });
      }
      if (!controller.signal.aborted && overviewRef.current?.revision.generationId === generationId) setAutoExpansionComplete(true);
    })();
    return () => controller.abort();
  }, [overview, fetchCompleteCommunity, loadOverview, storeResident]);

  const residentPages = useMemo(() => [...residents.values()].map((resident) => resident.page), [residents]);
  const scene = useMemo(() => overview ? assembleConstellationV2Scene(overview, residentPages, incidentPages) : null, [overview, residentPages, incidentPages]);
  const filteredScene = useMemo(() => {
    if (!scene || !typeFilter) return scene;
    // A pinned/search-focused entity remains visible even when it falls outside the standing type
    // filter; hiding the exact focus target would make the camera request impossible to honor.
    const nodes = scene.nodes.filter((node) => node.community || node.type === typeFilter || node.id === selectedNodeId);
    const ids = new Set(nodes.map((node) => node.id));
    return { ...scene, nodes, edges: scene.edges.filter((edge) => ids.has(edge.fromId) && ids.has(edge.toId)) };
  }, [scene, selectedNodeId, typeFilter]);

  const selectNode = useCallback((nodeId: string | null) => {
    incidentAbortRef.current?.abort();
    const serial = ++selectionSerialRef.current;
    setSelectedNodeId(nodeId); setIncidentPages([]);
    const owner = nodeId ? [...residentsRef.current.entries()].find(([, resident]) =>
      resident.page.community.id === nodeId
      || resident.page.communities.some((community) => community.id === nodeId)
      || resident.page.entities.some((entity) => entity.nodeId === nodeId)) : undefined;
    const isEntitySelection = Boolean(nodeId) && Boolean(
      owner?.[1].page.entities.some((entity) => entity.nodeId === nodeId)
      || scene?.nodes.some((node) => node.id === nodeId && Boolean(node.uri)),
    );
    if (owner) {
      const next = new Map(residentsRef.current);
      next.set(owner[0], { ...owner[1], touchedAt: performance.now() });
      residentsRef.current = next; setResidents(next);
    }
    setRelationshipsLoading(isEntitySelection);
    if (!isEntitySelection) return;
    const controller = new AbortController();
    incidentAbortRef.current = controller;
    api.memoryConstellationV2Incidents(pid, nodeId!, { limit: 256, lens }, controller.signal).then((page) => {
      if (selectionSerialRef.current !== serial || page.revision.generationId !== overviewRef.current?.revision.generationId) return;
      setIncidentPages([page]); setRelationshipsLoading(false);
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : 'Incident edges failed');
      if (selectionSerialRef.current === serial) setRelationshipsLoading(false);
    });
  }, [pid, lens, scene]);

  const loadMoreIncidents = async () => {
    const last = incidentPages.at(-1);
    if (!last?.nextCursor || !selectedNodeId) return;
    const serial = selectionSerialRef.current;
    const controller = new AbortController(); incidentAbortRef.current = controller;
    setRelationshipsLoading(true);
    try {
      const page = await api.memoryConstellationV2Incidents(pid, selectedNodeId, { cursor: last.nextCursor, limit: 256, lens }, controller.signal);
      if (selectionSerialRef.current === serial && page.revision.generationId === overviewRef.current?.revision.generationId) setIncidentPages((current) => [...current, page]);
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Incident continuation failed'); }
    finally { if (selectionSerialRef.current === serial) setRelationshipsLoading(false); }
  };

  const focusHit = async (hit: ApiMemoryHit) => {
    setSearching(true); setError(null);
    try {
      if (!hit.uri) throw new Error('Search result has no canonical URI');
      const route = await api.memoryConstellationV2Route(pid, hit.uri, lens);
      if (route.revision.generationId !== overviewRef.current?.revision.generationId) { await loadOverview(); return; }
      const containingCommunityId = route.communityPath[0]?.id;
      if (!containingCommunityId) {
        if (!scene?.nodes.some((node) => node.id === route.nodeId && node.ambient)) throw new Error('Ambient result is outside the returned field page');
        setHits([]); selectNode(route.nodeId);
        setCameraFocusRequest({ nodeId: route.nodeId, serial: ++cameraFocusSerialRef.current });
        return;
      }
      if (!await ensureCommunityResident(containingCommunityId)) return;
      const resident = residentsRef.current.get(containingCommunityId)?.page;
      if (!resident?.entities.some((entity) => entity.nodeId === route.nodeId)) throw new Error('Search result is absent from its routed system');
      setHits([]); selectNode(route.nodeId);
      setCameraFocusRequest({ nodeId: route.nodeId, serial: ++cameraFocusSerialRef.current });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Exact constellation route failed'); }
    finally { setSearching(false); }
  };

  const focusCommunity = async (nodeId: string) => {
    const node = scene?.nodes.find((candidate) => candidate.id === nodeId);
    const residentRootId = node?.residentRootId ?? node?.systemId ?? nodeId;
    selectNode(nodeId);
    if (!await ensureCommunityResident(residentRootId)) return;
    const loaded = residentsRef.current.get(residentRootId)?.page;
    const coreNodeId = loaded?.community.coreNodeId;
    const focusNodeId = coreNodeId && loaded?.entities.some((entity) => entity.nodeId === coreNodeId) ? coreNodeId : nodeId;
    if (focusNodeId !== nodeId) selectNode(focusNodeId);
    setViewMode('space');
    setCameraFocusRequest({ nodeId: focusNodeId, serial: ++cameraFocusSerialRef.current });
  };

  useEffect(() => {
    if (!query.trim()) { setHits([]); return; }
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      setSearching(true);
      api.memorySearch(pid, { query: query.trim(), limit: 12 }, controller.signal)
        .then((result) => setHits(result.results)).catch(() => {}).finally(() => setSearching(false));
    }, 250);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [pid, query]);

  // Resolves each new hit's community ancestry in parallel (bounded by memorySearch's own limit:
  // 12), skipping anything already cached. A hit with no uri can never be routed at all (focusHit
  // throws on that), so it is left out of ignite/off-page reasoning entirely rather than guessed at.
  useEffect(() => {
    const toFetch = hits.filter((hit): hit is ApiMemoryHit & { uri: string } => Boolean(hit.uri) && !hitRoutesRef.current.has(hit.uri!));
    if (toFetch.length === 0) return;
    const controller = new AbortController();
    Promise.allSettled(toFetch.map((hit) => api.memoryConstellationV2Route(pid, hit.uri, lens, controller.signal).then((route) => [hit.uri, route.communityPath] as const)))
      .then((settled) => {
        if (controller.signal.aborted) return;
        const next = new Map(hitRoutesRef.current);
        for (const result of settled) if (result.status === 'fulfilled') next.set(result.value[0], result.value[1]);
        hitRoutesRef.current = next; setHitRoutes(next);
      });
    return () => controller.abort();
  }, [pid, lens, hits]);

  // Root-level community each hit lands in (communityPath[0]) — the header's "N matches ignited
  // across M communities" figure and the overview flare/count both read off this, matching the
  // "communities" the rest of the chrome already means by that word (overview.communities, always
  // root level). Deepest ancestor (`.at(-1)`) is used separately, per-hit, for the results panel's
  // off-page routing note — a more specific name is more useful there than the root.
  const matchedRootCommunityIds = useMemo(() => {
    const ids = new Set<string>();
    for (const hit of hits) { const rootId = hit.uri ? hitRoutes.get(hit.uri)?.[0]?.id : undefined; if (rootId) ids.add(rootId); }
    return ids;
  }, [hits, hitRoutes]);
  const matchCountsByRootCommunity = useMemo(() => {
    const counts = new Map<string, number>();
    for (const hit of hits) {
      const rootId = hit.uri ? hitRoutes.get(hit.uri)?.[0]?.id : undefined;
      if (rootId) counts.set(rootId, (counts.get(rootId) ?? 0) + 1);
    }
    return counts;
  }, [hits, hitRoutes]);

  const highlightedNodeIds = useMemo(() => {
    if (!filteredScene) return [];
    const ids = new Set<string>();
    if (hits.length) for (const node of filteredScene.nodes) if (node.uri && hits.some((hit) => hit.uri === node.uri)) ids.add(node.id);
    // Community ignite rides the SAME field entity ignite already used (constellation-3d-buffers.ts's
    // ignite-budget comment explains why this is one field, not two): whichever matched-root-community
    // ids happen to correspond to a node actually in frame get flared, harmlessly no-op otherwise.
    for (const id of matchedRootCommunityIds) {
      ids.add(filteredScene.nodes.find((node) => node.systemId === id)?.id ?? id);
    }
    return [...ids];
  }, [hits, filteredScene, matchedRootCommunityIds]);
  // Sum of every currently-resident page's node count — the same figure `storeResident` compares against
  // CONSTELLATION_V2_RESIDENT_NODE_BUDGET before throwing. Surfaced as a gauge so the ceiling is watched,
  // not hit; the throw in storeResident stays the enforcement backstop.
  const residentTotal = useMemo(
    () => [...residents.values()].reduce((sum, entry) => sum + residentPageNodeCount(entry.page), 0),
    [residents],
  );
  const nonResidentSystemCount = overview
    ? overview.communities.reduce((count, community) => count + Number(!residents.has(community.id)), 0)
    : 0;
  const selected = scene?.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedCommunity = selected?.community && !selected.anchorEntity ? selected : null;
  const selectedEntity = selected?.uri ? selected : null;
  // Renderer failures retain the v2 controller and switch presentation to its full textual peer.
  // `onFallback` is reserved for API/generation incompatibility that requires the rolling 2D path.
  const handleRendererFailure = useCallback((reason: string) => { setRendererFailure(reason); }, []);
  const chooseLens = (next: ApiConstellationLens) => {
    if (next === lens) return;
    saveConstellationLens(pid, next);
    incidentAbortRef.current?.abort();
    setSelectedNodeId(null); setIncidentPages([]); setCameraFocusRequest(null); setError(null);
    setLens(next);
  };

  if (loading) return <div style={{ padding: 24, color: 'var(--text-dim)' }}>Preparing navigable memory space…</div>;
  if (!overview || !scene || !filteredScene) return <div style={{ padding: 24, color: 'var(--red-soft)' }}>{error ?? 'Constellation v2 is unavailable'}</div>;

  const typeOptions = [...new Set(scene.nodes.filter((node) => !node.community || node.anchorEntity).map((node) => node.type))].sort();
  const ambient = overview.ambient ?? { count: 0, entities: [] };
  const codeEntities = overview.communities.reduce((count, community) => count + (community.typeCounts.file ?? 0) + (community.typeCounts.symbol ?? 0) + (community.typeCounts.repository ?? 0), 0)
    + ambient.entities.reduce((count, entity) => count + Number(entity.type === 'file' || entity.type === 'symbol' || entity.type === 'repository'), 0);

  // Renderer failure forces Catalogue (it is the only reachable path when WebGL is down) but a human
  // can also choose Catalogue deliberately — it is a peer view, not only a failure fallback (PLNR-380).
  const showCatalogue = viewMode === 'catalogue' || Boolean(rendererFailure);
  const generationColor = overview.revision.state === 'current' ? 'var(--green)' : 'var(--amber)';
  const totalEntities = overview.communities.reduce((sum, community) => sum + community.memberCount, 0) + ambient.count;
  const countsLabel = `${overview.communities.length} system${overview.communities.length === 1 ? '' : 's'} · ${totalEntities.toLocaleString()} entities · ${ambient.count.toLocaleString()} ambient`;
  const searchActive = query.trim().length > 0;
  // Search-active context copy (screen spec 1c): states the total and the community spread up
  // front, so what follows can never be misread as a filter having removed anything — the count IS
  // the honesty mechanism, not a nicety (Navigator conventions doc §4 "dimming is not filtering").
  // Space dims non-matches to ~32% opacity on a continuous field; Catalogue is a flat list with no
  // field to dim, so silently shortening it to only-matches would be the exact thing the honesty
  // rule forbids. The textual equivalent (PLNR-442): every row stays listed and unmatched rows are
  // simply left unmarked, mirroring "dimmed, not removed" with "unmarked, not removed" — dimming's
  // job (visually de-emphasize without hiding) is done by omission of the ignite mark, not by any
  // row disappearing. The idle copy now describes the one continuous field; there is no level path.
  const levelHint = searchActive
    ? `— ${hits.length} match${hits.length === 1 ? '' : 'es'} ignited across ${matchedRootCommunityIds.size} system${matchedRootCommunityIds.size === 1 ? '' : 's'} · non-matches ${showCatalogue ? 'unmarked' : 'dimmed'}, not removed`
    : '— continuous space · double-click a system to fly in';
  const residentMeterPercent = Math.min(100, (residentTotal / CONSTELLATION_V2_RESIDENT_NODE_BUDGET) * 100);

  // One stacked status region, fixed severity order (error -> stale -> building -> informational,
  // per the Navigator conventions doc), each entry a sibling in a single flow
  // container. No entry computes its position from another entry's presence — that arithmetic
  // (`top: scene.partial ? 42 : 12` etc.) is exactly what this replaces. Message text is preserved
  // verbatim in meaning from the pre-existing strips (PLNR-372/380 truthful-degradation copy).
  const statusNotices: Array<{ key: string; token: 'error' | 'stale' | 'building' | 'partial' | 'informational'; message: string }> = [];
  if (error) statusNotices.push({ key: 'error', token: 'error', message: error });
  if (overview.revision.state === 'stale') {
    statusNotices.push({
      key: 'stale', token: 'stale',
      message: `This generation is stale (source ${overview.revision.sourceRevision}, current ${overview.revision.currentRevision}).`,
    });
  }
  if (overview.revision.state === 'building') {
    statusNotices.push({
      key: 'building', token: 'building',
      message: 'A newer hierarchy is building; this complete generation remains navigable.',
    });
  }
  if (autoExpansionComplete && nonResidentSystemCount > 0) {
    statusNotices.push({
      key: 'resident-budget', token: 'partial',
      message: `${nonResidentSystemCount.toLocaleString()} system${nonResidentSystemCount === 1 ? '' : 's'} not loaded — double-click one to load it.`,
    });
  }
  if (codeEntities === 0) {
    statusNotices.push({
      key: 'unindexed', token: 'informational',
      message: 'No repository entities are present in this generation; repository indexing may not have run.',
    });
  }
  // Catalogue-by-failure (PLNR-442, lockedDecisions): the failure reason rides the SAME status
  // region every other truthful-degradation message uses, rather than a separate ad hoc box — one
  // flow container stays the single source of "what's wrong right now". Informational severity:
  // per the Navigator conventions doc §4 "Unavailable ≠ empty", a renderer failure is grouped with
  // "confirmed empty hierarchy" and "indexing may not have run" as a truthful capability statement,
  // not a data-quality error — Catalogue itself remains fully functional, which is the whole point.
  if (rendererFailure) {
    statusNotices.push({
      key: 'renderer-failure', token: 'informational',
      message: `3D view unavailable — textual navigation remains active. ${rendererFailure}`,
    });
  }
  const STATUS_TOKEN_COLOR: Record<(typeof statusNotices)[number]['token'], string> = {
    error: 'var(--red-soft)', stale: 'var(--amber)', building: 'var(--amber)', partial: 'var(--amber)', informational: 'var(--text-dim)',
  };
  // The chip markup itself never changes between views — same source array, same order, same
  // styling (Navigator conventions §7: Catalogue shares "the same ... status region"). Only the
  // CONTAINER differs (see below), by a fixed branch on showCatalogue, never by measuring anything.
  const noticeChips = statusNotices.map((notice) => (
    <div key={notice.key} role="status" style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '4px 9px', borderRadius: 6,
      background: 'var(--panel)', border: `1px solid ${STATUS_TOKEN_COLOR[notice.token]}`,
      color: STATUS_TOKEN_COLOR[notice.token], fontFamily: 'var(--mono)', fontSize: 10,
    }}>
      <span>{notice.message}</span>
    </div>
  ));
  // PLNR-449: Catalogue is pure DOM with real rows starting at its own top edge, so a notice
  // floating at a fixed left:14/top:12 sits on top of its first row. Space has no such collision —
  // investigated below — so only Catalogue (and only once it actually has rows to collide with)
  // gets the status region promoted out of the overlay into a normal-flow sibling above it, whose
  // own rendered height reserves its own space. Nothing here measures another element's height or
  // reads its presence to compute an offset — that arithmetic is exactly what PLNR-436 (13137ff)
  // deleted, and reintroducing it as "pad Catalogue by the notice stack's measured height" would be
  // the same defect back under a different name. This is a discrete branch on a boolean, not a
  // runtime measurement.
  const noticesReserveFlowSpace = showCatalogue && filteredScene.nodes.length > 0;
  const catalogueElement = <ConstellationCatalogue
    nodes={filteredScene.nodes}
    highlightedNodeIds={new Set(highlightedNodeIds)}
    matchCounts={matchCountsByRootCommunity}
    searchActive={searchActive}
    selectedNodeId={selectedNodeId}
    residentCommunityIds={new Set(residents.keys())}
    expanding={expanding}
    onSelectNode={selectNode}
    onFocusCommunity={(communityId) => void focusCommunity(communityId)}
    onOpenEgoNetwork={onOpenEgoNetwork}
    onOpenInspector={onOpenInspector}
  />;

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{
        height: 46, boxSizing: 'border-box', padding: '0 14px', display: 'flex', alignItems: 'center', gap: 10,
        background: 'var(--bg-raised)', borderBottom: '1px solid var(--line)', flexWrap: 'nowrap',
      }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--text-dim)', flex: 'none' }}>MEMORY</span>
        <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-.01em', color: 'var(--text)', flex: 'none' }}>Constellation</span>
        <MonoTag color="var(--accent)" bg="rgba(198,242,78,.1)" size={9}>v2</MonoTag>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 600, padding: '1px 6px', borderRadius: 4,
          background: 'var(--w-04)', border: `1px solid ${generationColor}`, color: generationColor, whiteSpace: 'nowrap', flex: 'none',
        }}>
          {overview.revision.generationId} · {overview.revision.state}
        </span>
        <MonoTag color="var(--text-dim)" bg="var(--w-04)" size={9}>{countsLabel}</MonoTag>
        <div style={{ flex: 1 }} />
        <div role="group" aria-label="Constellation lens" style={{ display: 'flex', flex: 'none', border: '1px solid var(--w-1)', borderRadius: 7, overflow: 'hidden' }}>
          {(['memories', 'plans'] as const).map((value) => (
            <button
              key={value} type="button" aria-pressed={lens === value} onClick={() => chooseLens(value)}
              style={{
                padding: '5px 10px', fontFamily: 'inherit', fontSize: 11, fontWeight: 600, border: 'none', cursor: 'pointer',
                background: lens === value ? 'var(--w-08)' : 'transparent', color: lens === value ? 'var(--text)' : 'var(--text-dim)',
              }}
            >
              {value === 'memories' ? 'Memories' : 'Plans'}
            </button>
          ))}
        </div>
        <div role="group" aria-label="View" style={{ display: 'flex', flex: 'none', border: '1px solid var(--w-1)', borderRadius: 7, overflow: 'hidden' }}>
          <button
            type="button" aria-pressed={!showCatalogue} disabled={Boolean(rendererFailure)}
            onClick={() => setViewMode('space')}
            style={{
              padding: '5px 10px', fontFamily: 'inherit', fontSize: 11, fontWeight: 600, border: 'none',
              cursor: rendererFailure ? 'default' : 'pointer',
              background: !showCatalogue ? 'var(--w-08)' : 'transparent',
              color: rendererFailure ? 'var(--text-faint)' : !showCatalogue ? 'var(--text)' : 'var(--text-dim)',
            }}
          >
            Space
          </button>
          <button
            type="button" aria-pressed={showCatalogue}
            onClick={() => setViewMode('catalogue')}
            style={{
              padding: '5px 10px', fontFamily: 'inherit', fontSize: 11, fontWeight: 600, border: 'none', cursor: 'pointer',
              background: showCatalogue ? 'var(--w-08)' : 'transparent', color: showCatalogue ? 'var(--text)' : 'var(--text-dim)',
            }}
          >
            Catalogue
          </button>
        </div>
        <Select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} aria-label="Filter visible entities by type" style={{ flex: 'none', minWidth: 108 }}>
          <option value="">all types</option>
          {typeOptions.map((type) => <option key={type} value={type}>{type}</option>)}
        </Select>
        <div style={{ position: 'relative', flex: 'none' }}>
          <span aria-hidden="true" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: searchActive ? 'var(--accent)' : 'var(--text-faint)', pointerEvents: 'none' }}>⌕</span>
          <TextInput
            ref={searchInputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && hits.length > 0) { event.preventDefault(); void focusHit(hits[0]!); } }}
            placeholder="Search memory, task, file, symbol…"
            aria-label="Search memory, task, file, symbol"
            style={{
              width: 280, paddingLeft: 28, paddingRight: searchActive ? 66 : 34,
              borderColor: searchActive ? 'rgba(198,242,78,.5)' : 'var(--w-1)',
              background: searchActive ? 'rgba(198,242,78,.04)' : 'var(--w-05)',
              boxShadow: searchActive ? '0 0 0 3px rgba(198,242,78,.07)' : 'none',
            }}
          />
          {searchActive
            ? <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)', pointerEvents: 'none', whiteSpace: 'nowrap' }}>{searching ? '…' : `${hits.length} result${hits.length === 1 ? '' : 's'}`}</span>
            : <span aria-hidden="true" style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)', border: '1px solid var(--w-12)', borderRadius: 4, padding: '0 4px', pointerEvents: 'none' }}>/</span>}
        </div>
      </div>
      <div style={{
        height: 30, boxSizing: 'border-box', padding: '0 14px', display: 'flex', alignItems: 'center', gap: 6,
        borderBottom: '1px solid var(--line)', fontFamily: 'var(--mono)', fontSize: 10, flexWrap: 'nowrap',
      }}>
        <span style={{ color: 'var(--accent)', fontWeight: 600, flex: 'none' }}>Project space</span>
        <span style={{ color: 'var(--text-faint)', flex: 'none' }}>{levelHint}</span>
        <div style={{ flex: 1 }} />
        <span style={{ color: 'var(--text-dim)', flex: 'none' }}>
          {ambient.entities.length < ambient.count
            ? `${ambient.entities.length.toLocaleString()} of ${ambient.count.toLocaleString()} ambient shown`
            : `${ambient.count.toLocaleString()} ambient`}
        </span>
        <span style={{ color: 'var(--text-dim)', flex: 'none' }}>resident {residentTotal.toLocaleString()} / {CONSTELLATION_V2_RESIDENT_NODE_BUDGET.toLocaleString()} nodes</span>
        <div
          role="img"
          aria-label={`Resident nodes: ${residentTotal.toLocaleString()} of ${CONSTELLATION_V2_RESIDENT_NODE_BUDGET.toLocaleString()} budget`}
          style={{ width: 90, height: 3, borderRadius: 2, background: 'var(--w-08)', overflow: 'hidden', flex: 'none' }}
        >
          <div style={{ width: `${residentMeterPercent}%`, height: '100%', background: 'var(--accent)' }} />
        </div>
      </div>
      {/* Montana 2026-08-11 (PLNR-462) supersedes PLNR-440's flex-sibling reflow: the canvas layer
          always fills this relative wrapper, while the inspector is an absolute right-edge overlay.
          Only the aside's own 320px box accepts its pointer events — there is no viewport-sized
          backdrop to intercept orbit/select gestures elsewhere on the canvas. */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div style={{ position: 'absolute', inset: 0 }}>
          {!showCatalogue ? <Suspense fallback={<div style={{ padding: 24, color: 'var(--text-dim)' }}>Loading 3D renderer…</div>}>
              <LazyConstellation3D
                projectId={pid} generationId={overview.revision.generationId} layoutVersion={overview.revision.layoutVersion}
                nodes={filteredScene.nodes} edges={filteredScene.edges} selectedNodeId={selectedNodeId} highlightedNodeIds={highlightedNodeIds} theme={theme}
                searchActive={searchActive} igniteMatchCounts={matchCountsByRootCommunity}
                residentCommunityIds={[...residents.keys()]}
                focusRequest={cameraFocusRequest}
                reducedMotion={reducedMotion}
                onEnsureCommunityResident={ensureCommunityResident}
                onSelectNode={selectNode} onOpenEgoNetwork={onOpenEgoNetwork} onOpenInspector={onOpenInspector}
                onRendererFailure={handleRendererFailure}
              />
            </Suspense> : noticesReserveFlowSpace ? (
              // Flow slot, scoped to Catalogue-with-rows (see noticesReserveFlowSpace above): the
              // notice stack is a normal block sibling ABOVE the Catalogue container, which fills
              // exactly the remaining flex space below it — Catalogue's own top row can never sit
              // under a notice because the browser's ordinary box layout, not a computed pixel
              // value, is what reserves the height.
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
                <div style={{ flex: 'none', padding: '12px 14px 0', display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 420 }}>
                  {noticeChips}
                </div>
                <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
                  {catalogueElement}
                </div>
              </div>
            ) : catalogueElement}
          {lens === 'memories' && overview.communities.length === 0 && (
            <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none', zIndex: 1 }}>
              <div role="status" style={{ maxWidth: 470, padding: '14px 18px', textAlign: 'center', color: 'var(--text-soft)', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10 }}>
                <strong>No memory systems yet.</strong>
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-dim)' }}>Record memories via MCP (<code>record_memory</code>) or switch to the Plans lens.</div>
              </div>
            </div>
          )}
          {/* Space (and the empty-communities message, either view) keep the status region as the
              translucent overlay the screen spec specifies ("anchored top-left of the canvas") —
              nothing else occupies that corner in Space (camera controls bottom-right, legend
              bottom-left, search matches on the right), so there is nothing for it to collide with,
              and there are no Catalogue rows to cover when the hierarchy is empty. */}
          {!noticesReserveFlowSpace && statusNotices.length > 0 && <div style={{ position: 'absolute', left: 14, top: 12, display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 420, zIndex: 1 }}>
            {noticeChips}
          </div>}
          {hits.length > 0 && <div role="region" aria-label="Search matches" style={{
            position: 'absolute', right: 14, top: 10, width: 392, maxHeight: 340, overflow: 'auto',
            background: 'rgba(14,16,20,.96)', border: `1px solid ${MATCHES_LINE}`, borderRadius: 10, backdropFilter: 'blur(10px)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: `1px solid ${MATCHES_LINE}` }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.1em', textTransform: 'uppercase', color: MATCHES_TEXT_DIM }}>Matches</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: MATCHES_TEXT_MID }}>{hits.length} · hybrid + exact URI</span>
              <div style={{ flex: 1 }} />
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: MATCHES_TEXT_DIM }}>↵ focuses top</span>
            </div>
            {hits.map((hit, index) => {
              // Off-page: this hit's uri is not among the currently resident nodes on canvas — the
              // ONLY thing that makes focusHit's flight (route, load pages, focus, pin) a surprise
              // rather than an expectation (Navigator conventions doc §4 "off-page is named, never
              // faked"). The deepest known ancestor (`.at(-1)`) is the most specific truthful name
              // available for where picking this hit will actually land.
              const resident = Boolean(hit.uri) && filteredScene.nodes.some((node) => node.uri === hit.uri);
              const routeCommunity = hit.uri ? hitRoutes.get(hit.uri)?.at(-1) : undefined;
              const top = index === 0;
              return (
                <button
                  key={`${hit.entityType}:${hit.id}`} type="button" onClick={() => void focusHit(hit)}
                  style={{
                    display: 'block', width: '100%', padding: '8px 10px', textAlign: 'left', borderBottom: `1px solid ${MATCHES_LINE}`,
                    borderLeft: top ? '2px solid var(--accent)' : '2px solid transparent',
                    background: top ? 'rgba(198,242,78,.05)' : 'transparent',
                  }}
                >
                  <span style={{ fontSize: 12, fontWeight: top ? 600 : 400, color: top ? MATCHES_TEXT : MATCHES_TEXT_SOFT }}>{hit.title}</span>
                  <small style={{ display: 'block', fontFamily: 'var(--mono)', fontSize: 9, color: MATCHES_TEXT_DIM, marginTop: 2 }}>{hit.entityType} · {hit.uri}</small>
                  {!resident && routeCommunity && (
                    <small style={{ display: 'block', fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--amber)', marginTop: 2 }}>
                      not resident · picking loads {routeCommunity.label}
                    </small>
                  )}
                </button>
              );
            })}
          </div>}
          {searching && <div style={{ position: 'absolute', right: 18, top: 16, color: 'var(--text-dim)', fontSize: 10 }}>searching…</div>}
          {/* The old <details> "Accessible visible list" disclosure lived here (Space view only).
              PLNR-442 removed it after the earlier offset coupling was retired — the audit doc's
              "Fallbacks" disposition is explicit: Delete, its function is absorbed by Catalogue.
              A disclosure widget was never a navigation surface; the Catalogue view (reachable from
              the header toggle at all times, not only on renderer failure) is. */}
          {/* Fixed bottom-left, independent of the top-left status region's presence or height —
              same "no sibling-dependent offset" rule it already follows (PLNR-436/438). Space view
              only: the legend explains the 3D encoding; every Catalogue row already carries its own
              type chip and shape glyph inline, so a second, freestanding legend would be redundant
              there. */}
          {!showCatalogue && <div aria-label={searchActive ? 'Constellation ignite legend' : 'Constellation encoding legend'} style={{
            position: 'absolute', left: 14, bottom: 14, width: 238, background: 'var(--panel)',
            border: '1px solid var(--line)', borderRadius: 8, padding: 10, fontFamily: 'var(--mono)',
          }}>
            <button
              type="button" onClick={() => setLegendOpen((open) => !open)} aria-expanded={legendOpen}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%',
                background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              <span style={{ fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>{searchActive ? 'Ignite' : 'Encoding'}</span>
              <span aria-hidden="true" style={{ color: 'var(--text-faint)', fontSize: 10 }}>{legendOpen ? '−' : '+'}</span>
            </button>
            {/* While a search is active, the ignite legend REPLACES the encoding legend (screen spec
                1c) rather than appending to it — the type/shape table stays true throughout, so
                restating it while every unmatched entry is dimmed to ~32% would bury the two lines
                that actually explain what's on screen right now. */}
            {legendOpen && (searchActive ? (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3, fontSize: 9.5, color: 'var(--text-dim)' }}>
                <span>flare + count = matches inside community</span>
                <span>field dims to 32% — off-page truth preserved</span>
              </div>
            ) : <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 8 }}>
                {LEGEND_TYPES.map((type) => {
                  const encoding = encodingForType(type);
                  return (
                    <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                      <span aria-hidden="true" style={{ color: `var(${encoding.token})`, fontSize: 16, lineHeight: 1 }}>{CONSTELLATION_SHAPE_GLYPH[encoding.shape]}</span>
                      <span style={{ color: 'var(--text-soft)' }}>{encoding.label.toLowerCase()}</span>
                    </div>
                  );
                })}
              </div>
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--w-07)', display: 'flex', flexDirection: 'column', gap: 3, fontSize: 9.5, color: 'var(--text-dim)' }}>
                <span>size = connectivity · brightness = authority</span>
                <span>amber halo = lead · amber route = selection</span>
              </div>
            </>)}
          </div>}
        </div>
        {selected && (selectedCommunity || selectedEntity) && (
          <ConstellationInspector
            pid={pid}
            selected={selected}
            incidentPages={incidentPages}
            relationshipsLoading={relationshipsLoading}
            expanding={expanding}
            onLoadMoreRelationships={() => void loadMoreIncidents()}
            onFocusCommunity={(communityId) => void focusCommunity(communityId)}
            onOpenEgoNetwork={onOpenEgoNetwork}
            onOpenInspector={onOpenInspector}
            onClear={() => selectNode(null)}
          />
        )}
      </div>
    </div>
  );
}

export default MemoryConstellationV2;
