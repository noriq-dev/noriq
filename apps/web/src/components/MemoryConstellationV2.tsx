import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api, ApiError, type ApiConstellationV2Community, type ApiConstellationV2CommunityPage, type ApiConstellationV2IncidentPage,
  type ApiConstellationV2Overview, type ApiMemoryHit,
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

interface LoadedCommunity {
  page: ApiConstellationV2CommunityPage;
  touchedAt: number;
}

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
  const [overview, setOverview] = useState<ApiConstellationV2Overview | null>(null);
  const overviewRef = useRef<ApiConstellationV2Overview | null>(null);
  const [residents, setResidents] = useState<Map<string, LoadedCommunity>>(new Map());
  const residentsRef = useRef(residents);
  const [path, setPath] = useState<string[]>([]);
  const pathRef = useRef(path);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
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
  useEffect(() => { pathRef.current = path; }, [path]);
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
    const value = await api.memoryConstellationV2Overview(pid, signal);
    overviewRef.current = value;
    setOverview(value);
    setResidents(new Map()); setPath([]); setSelectedNodeId(null); setIncidentPages([]);
    return value;
  }, [pid]);

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

  const storeResident = useCallback((communityId: string, page: ApiConstellationV2CommunityPage, nextPath: string[]) => {
    const updated = new Map(residentsRef.current);
    updated.set(communityId, { page, touchedAt: performance.now() });
    const bounded = evictConstellationPages([...updated].map(([id, value]): ResidentConstellationPage<LoadedCommunity> => ({
      communityId: id, value, nodeCount: value.page.communities.length + value.page.entities.length,
      touchedAt: value.touchedAt, pinned: nextPath.includes(id),
    })));
    if (bounded.reduce((sum, entry) => sum + entry.nodeCount, 0) > CONSTELLATION_V2_RESIDENT_NODE_BUDGET) {
      throw new Error('Visible hierarchy reached the 12,000-node resident budget; collapse a level before expanding further');
    }
    const next = new Map(bounded.map((entry) => [entry.communityId, entry.value]));
    residentsRef.current = next;
    setResidents(next);
  }, []);

  const fetchCommunity = useCallback(async (communityId: string, cursor?: string, signal?: AbortSignal) => {
    const next = await api.memoryConstellationV2Community(pid, communityId, { cursor, limit: 256 }, signal);
    if (next.revision.generationId !== overviewRef.current?.revision.generationId) throw new Error('Constellation generation changed');
    const merged = mergeConstellationCommunityPages(residentsRef.current.get(communityId)?.page ?? null, next);
    const nextPath = pathRef.current.includes(communityId) ? pathRef.current : [...pathRef.current, communityId];
    storeResident(communityId, merged, nextPath);
    return merged;
  }, [pid, storeResident]);

  const expand = useCallback(async (communityId: string) => {
    setExpanding(true); setError(null);
    try {
      let loaded = residentsRef.current.get(communityId)?.page;
      if (!loaded) loaded = await fetchCommunity(communityId);
      const nextPath = pathRef.current.includes(communityId) ? pathRef.current.slice(0, pathRef.current.indexOf(communityId) + 1) : [...pathRef.current, communityId];
      pathRef.current = nextPath; setPath(nextPath); storeResident(communityId, loaded, nextPath);
      setSelectedNodeId(null); setIncidentPages([]);
    } catch (reason) {
      if (reason instanceof Error && reason.message === 'Constellation generation changed') await loadOverview();
      else setError(reason instanceof Error ? reason.message : 'Community expansion failed');
    } finally { setExpanding(false); }
  }, [fetchCommunity, loadOverview, storeResident]);

  const currentPage = path.length ? residents.get(path.at(-1)!)?.page ?? null : null;
  const scene = useMemo(() => overview ? assembleConstellationV2Scene(overview, currentPage, incidentPages) : null, [overview, currentPage, incidentPages]);
  const filteredScene = useMemo(() => {
    if (!scene || !typeFilter) return scene;
    const nodes = scene.nodes.filter((node) => node.community || node.type === typeFilter);
    const ids = new Set(nodes.map((node) => node.id));
    return { ...scene, nodes, edges: scene.edges.filter((edge) => ids.has(edge.fromId) && ids.has(edge.toId)) };
  }, [scene, typeFilter]);

  const selectNode = useCallback((nodeId: string | null) => {
    incidentAbortRef.current?.abort();
    const serial = ++selectionSerialRef.current;
    setSelectedNodeId(nodeId); setIncidentPages([]);
    const activePage = pathRef.current.length ? residentsRef.current.get(pathRef.current.at(-1)!)?.page : null;
    const isEntitySelection = Boolean(nodeId) && Boolean(activePage?.entities.some((entity) => entity.nodeId === nodeId));
    setRelationshipsLoading(isEntitySelection);
    if (!isEntitySelection) return;
    const controller = new AbortController();
    incidentAbortRef.current = controller;
    api.memoryConstellationV2Incidents(pid, nodeId!, { limit: 256 }, controller.signal).then((page) => {
      if (selectionSerialRef.current !== serial || page.revision.generationId !== overviewRef.current?.revision.generationId) return;
      setIncidentPages([page]); setRelationshipsLoading(false);
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : 'Incident edges failed');
      if (selectionSerialRef.current === serial) setRelationshipsLoading(false);
    });
  }, [pid]);

  const loadMoreIncidents = async () => {
    const last = incidentPages.at(-1);
    if (!last?.nextCursor || !selectedNodeId) return;
    const serial = selectionSerialRef.current;
    const controller = new AbortController(); incidentAbortRef.current = controller;
    setRelationshipsLoading(true);
    try {
      const page = await api.memoryConstellationV2Incidents(pid, selectedNodeId, { cursor: last.nextCursor, limit: 256 }, controller.signal);
      if (selectionSerialRef.current === serial && page.revision.generationId === overviewRef.current?.revision.generationId) setIncidentPages((current) => [...current, page]);
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Incident continuation failed'); }
    finally { if (selectionSerialRef.current === serial) setRelationshipsLoading(false); }
  };

  const focusHit = async (hit: ApiMemoryHit) => {
    setSearching(true); setError(null);
    try {
      if (!hit.uri) throw new Error('Search result has no canonical URI');
      const route = await api.memoryConstellationV2Route(pid, hit.uri);
      if (route.revision.generationId !== overviewRef.current?.revision.generationId) { await loadOverview(); return; }
      const routeIds = route.communityPath.map((community) => community.id);
      pathRef.current = [];
      for (const communityId of routeIds) {
        let page = residentsRef.current.get(communityId)?.page ?? await fetchCommunity(communityId);
        while (page.kind === 'entities' && !page.entities.some((entity) => entity.nodeId === route.nodeId) && page.nextCursor) page = await fetchCommunity(communityId, page.nextCursor);
        pathRef.current = [...pathRef.current, communityId];
      }
      setPath(routeIds); setHits([]); selectNode(route.nodeId);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Exact constellation route failed'); }
    finally { setSearching(false); }
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
    Promise.allSettled(toFetch.map((hit) => api.memoryConstellationV2Route(pid, hit.uri, controller.signal).then((route) => [hit.uri, route.communityPath] as const)))
      .then((settled) => {
        if (controller.signal.aborted) return;
        const next = new Map(hitRoutesRef.current);
        for (const result of settled) if (result.status === 'fulfilled') next.set(result.value[0], result.value[1]);
        hitRoutesRef.current = next; setHitRoutes(next);
      });
    return () => controller.abort();
  }, [pid, hits]);

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
    for (const id of matchedRootCommunityIds) ids.add(id);
    return [...ids];
  }, [hits, filteredScene, matchedRootCommunityIds]);
  // Sum of every currently-resident page's node count — the same figure `storeResident` compares against
  // CONSTELLATION_V2_RESIDENT_NODE_BUDGET before throwing. Surfaced as a gauge so the ceiling is watched,
  // not hit; the throw in storeResident stays the enforcement backstop.
  const residentTotal = useMemo(
    () => [...residents.values()].reduce((sum, entry) => sum + entry.page.communities.length + entry.page.entities.length, 0),
    [residents],
  );
  const crumbs = useMemo(() => [
    { id: 'root', label: 'Project', onSelect: () => { pathRef.current = []; setPath([]); selectNode(null); } },
    ...path.map((id, index) => ({
      id,
      label: residents.get(id)?.page.community.label ?? id,
      onSelect: () => { const next = path.slice(0, index + 1); pathRef.current = next; setPath(next); selectNode(null); },
    })),
  ], [path, residents, selectNode]);
  const selected = scene?.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedCommunity = selected?.community ? selected : null;
  const selectedEntity = selected?.uri ? selected : null;
  // Renderer failures retain the v2 controller and switch presentation to its full textual peer.
  // `onFallback` is reserved for API/generation incompatibility that requires the rolling 2D path.
  const handleRendererFailure = useCallback((reason: string) => { setRendererFailure(reason); }, []);

  if (loading) return <div style={{ padding: 24, color: 'var(--text-dim)' }}>Preparing navigable memory space…</div>;
  if (!overview || !scene || !filteredScene) return <div style={{ padding: 24, color: 'var(--red-soft)' }}>{error ?? 'Constellation v2 is unavailable'}</div>;

  const typeOptions = [...new Set(scene.nodes.filter((node) => !node.community).map((node) => node.type))].sort();
  const codeEntities = overview.communities.reduce((count, community) => count + (community.typeCounts.file ?? 0) + (community.typeCounts.symbol ?? 0) + (community.typeCounts.repository ?? 0), 0);

  // Renderer failure forces Catalogue (it is the only reachable path when WebGL is down) but a human
  // can also choose Catalogue deliberately — it is a peer view, not only a failure fallback (PLNR-380).
  const showCatalogue = viewMode === 'catalogue' || Boolean(rendererFailure);
  const generationColor = overview.revision.state === 'current' ? 'var(--green)' : 'var(--amber)';
  const totalEntities = overview.communities.reduce((sum, community) => sum + community.memberCount, 0);
  const countsLabel = path.length === 0
    ? `${overview.communities.length} communit${overview.communities.length === 1 ? 'y' : 'ies'} · ${totalEntities.toLocaleString()} entities`
    : `${filteredScene.nodes.length} visible · ${filteredScene.edges.length} routes`;
  const searchActive = query.trim().length > 0;
  // Search-active breadcrumb copy (screen spec 1c): states the total and the community spread up
  // front, so what follows can never be misread as a filter having removed anything — the count IS
  // the honesty mechanism, not a nicety (Navigator conventions doc §4 "dimming is not filtering").
  // Space dims non-matches to ~32% opacity on a continuous field; Catalogue is a flat list with no
  // field to dim, so silently shortening it to only-matches would be the exact thing the honesty
  // rule forbids. The textual equivalent (PLNR-442): every row stays listed and unmatched rows are
  // simply left unmarked, mirroring "dimmed, not removed" with "unmarked, not removed" — dimming's
  // job (visually de-emphasize without hiding) is done by omission of the ignite mark, not by any
  // row disappearing. Falls back to the root/expanded hints (PLNR-436) when no query is active.
  const levelHint = searchActive
    ? `— ${hits.length} match${hits.length === 1 ? '' : 'es'} ignited across ${matchedRootCommunityIds.size} communit${matchedRootCommunityIds.size === 1 ? 'y' : 'ies'} · non-matches ${showCatalogue ? 'unmarked' : 'dimmed'}, not removed`
    : path.length === 0
      ? '— root level · double-click a community to open it'
      : `· level ${path.length}`;
  const residentMeterPercent = Math.min(100, (residentTotal / CONSTELLATION_V2_RESIDENT_NODE_BUDGET) * 100);

  // One stacked status region, fixed severity order (error -> stale -> building -> partial ->
  // informational, per the Navigator conventions doc), each entry a sibling in a single flow
  // container. No entry computes its position from another entry's presence — that arithmetic
  // (`top: scene.partial ? 42 : 12` etc.) is exactly what this replaces. Message text is preserved
  // verbatim in meaning from the pre-existing strips (PLNR-372/380 truthful-degradation copy).
  const statusNotices: Array<{ key: string; token: 'error' | 'stale' | 'building' | 'partial' | 'informational'; message: string; action?: { label: string; onClick: () => void } }> = [];
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
  if (scene.partial) {
    // The former standalone "load more in community" button (bottom:12) becomes this notice's
    // inline continue action: currentPage.nextCursor is a strict subset of what makes scene.partial
    // true (incomplete incident pages can also set it), so the action only appears when there is
    // actually a community page to continue.
    const continuation = currentPage?.nextCursor
      ? { label: 'continue', onClick: () => void fetchCommunity(currentPage.community.id, currentPage.nextCursor!) }
      : undefined;
    statusNotices.push({ key: 'partial', token: 'partial', message: 'Partial level · bounded continuation available', action: continuation });
  }
  if (codeEntities === 0 && path.length === 0) {
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
        {crumbs.map((crumb, index) => (
          // Keyed by position + id, not id alone: a real community id can collide with the synthetic
          // 'root' id of the leading Project crumb (community ids are not guaranteed disjoint from it).
          <span key={`${index}:${crumb.id}`} style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
            {index > 0 && <span aria-hidden="true" style={{ color: 'var(--text-faint)' }}>▸</span>}
            <button
              type="button"
              onClick={crumb.onSelect}
              aria-current={index === crumbs.length - 1 ? 'location' : undefined}
              style={{
                background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                fontFamily: 'inherit', fontSize: 'inherit',
                color: index === crumbs.length - 1 ? 'var(--accent)' : 'var(--text-mid)',
                fontWeight: index === crumbs.length - 1 ? 600 : 400,
              }}
            >
              {crumb.label}
            </button>
          </span>
        ))}
        <span style={{ color: 'var(--text-faint)', marginLeft: 2, flex: 'none' }}>{levelHint}</span>
        <div style={{ flex: 1 }} />
        <span style={{ color: 'var(--text-dim)', flex: 'none' }}>resident {residentTotal.toLocaleString()} / {CONSTELLATION_V2_RESIDENT_NODE_BUDGET.toLocaleString()} nodes</span>
        <div
          role="img"
          aria-label={`Resident nodes: ${residentTotal.toLocaleString()} of ${CONSTELLATION_V2_RESIDENT_NODE_BUDGET.toLocaleString()} budget`}
          style={{ width: 90, height: 3, borderRadius: 2, background: 'var(--w-08)', overflow: 'hidden', flex: 'none' }}
        >
          <div style={{ width: `${residentMeterPercent}%`, height: '100%', background: 'var(--accent)' }} />
        </div>
      </div>
      {/* The docked inspector (PLNR-440) is a normal flex sibling of the canvas area below, not an
          absolutely-positioned overlay — so opening/closing it changes the canvas area's available
          width through ordinary flexbox reflow, and MemoryConstellation3D's own ResizeObserver on
          its host element (already built for window resizes) picks that up and re-projects the
          scene with no manual width arithmetic here. This is deliberately the "handle it without
          reintroducing sibling-dependent offset arithmetic" instruction: nothing in this file reads
          the inspector's width to compute the canvas area's size. */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
          {overview.communities.length === 0 ? <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--text-dim)' }}>
            <div style={{ maxWidth: 440, textAlign: 'center' }}><strong>No memory entities are present in this completed generation.</strong><div style={{ marginTop: 6, fontSize: 11 }}>This is a confirmed empty hierarchy, not a renderer or network failure.</div></div>
          </div> : !showCatalogue ? <Suspense fallback={<div style={{ padding: 24, color: 'var(--text-dim)' }}>Loading 3D renderer…</div>}>
              <LazyConstellation3D
                projectId={pid} generationId={overview.revision.generationId} layoutVersion={overview.revision.layoutVersion}
                nodes={filteredScene.nodes} edges={filteredScene.edges} selectedNodeId={selectedNodeId} highlightedNodeIds={highlightedNodeIds} theme={theme}
                searchActive={searchActive} igniteMatchCounts={matchCountsByRootCommunity}
                reducedMotion={reducedMotion}
                onSelectNode={selectNode} onOpenEgoNetwork={onOpenEgoNetwork} onOpenInspector={onOpenInspector}
                onRendererFailure={handleRendererFailure}
              />
            </Suspense> : <ConstellationCatalogue
              nodes={filteredScene.nodes}
              highlightedNodeIds={new Set(highlightedNodeIds)}
              matchCounts={matchCountsByRootCommunity}
              searchActive={searchActive}
              selectedNodeId={selectedNodeId}
              currentPage={currentPage}
              expanding={expanding}
              onSelectNode={selectNode}
              onExpandCommunity={(communityId) => void expand(communityId)}
              onLoadNextPage={() => currentPage && void fetchCommunity(currentPage.community.id, currentPage.nextCursor!)}
              onOpenEgoNetwork={onOpenEgoNetwork}
              onOpenInspector={onOpenInspector}
            />}
          {statusNotices.length > 0 && <div style={{ position: 'absolute', left: 14, top: 12, display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 420, zIndex: 1 }}>
            {statusNotices.map((notice) => <div key={notice.key} role="status" style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '4px 9px', borderRadius: 6,
              background: 'var(--panel)', border: `1px solid ${STATUS_TOKEN_COLOR[notice.token]}`,
              color: STATUS_TOKEN_COLOR[notice.token], fontFamily: 'var(--mono)', fontSize: 10,
            }}>
              <span>{notice.message}</span>
              {notice.action && <button
                type="button" onClick={notice.action.onClick}
                style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit', color: 'inherit', textDecoration: 'underline' }}
              >
                {notice.action.label}
              </button>}
            </div>)}
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
                      off-page · picking it routes via {routeCommunity.label}
                    </small>
                  )}
                </button>
              );
            })}
          </div>}
          {searching && <div style={{ position: 'absolute', right: 18, top: 16, color: 'var(--text-dim)', fontSize: 10 }}>searching…</div>}
          {/* The old <details> "Accessible visible list" disclosure lived here (Space view only).
              PLNR-436 decoupled its offset from codeEntities/path.length but deliberately left its
              content alone, scoping the promotion to this task (PLNR-442) — the audit doc's
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
            onOpenCommunity={(communityId) => void expand(communityId)}
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
