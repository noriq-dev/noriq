import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api, ApiError, type ApiConstellationV2CommunityPage, type ApiConstellationV2IncidentPage,
  type ApiConstellationV2Overview, type ApiMemoryHit,
} from '../api';
import { useTheme } from '../theme';
import { Button, TextInput } from './ui';
import { MonoTag, SectionLabel } from './bits';
import {
  assembleConstellationV2Scene, CONSTELLATION_V2_RESIDENT_NODE_BUDGET, evictConstellationPages, type ResidentConstellationPage,
} from './constellation-v2-scene';

const LazyConstellation3D = lazy(() => import('./MemoryConstellation3D'));

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
  const incidentAbortRef = useRef<AbortController | null>(null);
  const selectionSerialRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [expanding, setExpanding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ApiMemoryHit[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => { residentsRef.current = residents; }, [residents]);
  useEffect(() => { pathRef.current = path; }, [path]);

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
      setError(reason instanceof ApiError ? reason.message : 'Constellation v2 is unavailable'); setLoading(false);
    });
    return () => controller.abort();
  }, [loadOverview]);

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

  const selectNode = useCallback((nodeId: string | null) => {
    incidentAbortRef.current?.abort();
    const serial = ++selectionSerialRef.current;
    setSelectedNodeId(nodeId); setIncidentPages([]);
    const activePage = pathRef.current.length ? residentsRef.current.get(pathRef.current.at(-1)!)?.page : null;
    if (!nodeId || !activePage?.entities.some((entity) => entity.nodeId === nodeId)) return;
    const controller = new AbortController();
    incidentAbortRef.current = controller;
    api.memoryConstellationV2Incidents(pid, nodeId, { limit: 256 }, controller.signal).then((page) => {
      if (selectionSerialRef.current !== serial || page.revision.generationId !== overviewRef.current?.revision.generationId) return;
      setIncidentPages([page]);
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Incident edges failed'); });
  }, [pid]);

  const loadMoreIncidents = async () => {
    const last = incidentPages.at(-1);
    if (!last?.nextCursor || !selectedNodeId) return;
    const serial = selectionSerialRef.current;
    const controller = new AbortController(); incidentAbortRef.current = controller;
    try {
      const page = await api.memoryConstellationV2Incidents(pid, selectedNodeId, { cursor: last.nextCursor, limit: 256 }, controller.signal);
      if (selectionSerialRef.current === serial && page.revision.generationId === overviewRef.current?.revision.generationId) setIncidentPages((current) => [...current, page]);
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Incident continuation failed'); }
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

  const selected = scene?.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedCommunity = selected?.community ? selected : null;
  const selectedEntity = selected?.uri ? selected : null;

  if (loading) return <div style={{ padding: 24, color: 'var(--text-dim)' }}>Preparing navigable memory space…</div>;
  if (!overview || !scene) return <div style={{ padding: 24, color: 'var(--red-soft)' }}>{error ?? 'Constellation v2 is unavailable'}</div>;

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--line)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <SectionLabel>Constellation v2</SectionLabel>
        <MonoTag color="var(--text-dim)" bg="var(--w-04)" size={9}>{scene.nodes.length} visible · {scene.edges.length} routes</MonoTag>
        <MonoTag color={overview.revision.state === 'current' ? 'var(--green)' : 'var(--amber)'} bg="var(--w-04)" size={9}>{overview.revision.state}</MonoTag>
        <Button variant="ghost" disabled={path.length === 0} onClick={() => { const next = path.slice(0, -1); pathRef.current = next; setPath(next); selectNode(null); }}>← parent</Button>
        <div style={{ flex: 1 }} />
        <TextInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search memory, task, file, symbol…" style={{ width: 280 }} />
      </div>
      {path.length > 0 && <div style={{ padding: '6px 14px', display: 'flex', gap: 5, borderBottom: '1px solid var(--line)', fontSize: 11 }}>
        <button type="button" onClick={() => { pathRef.current = []; setPath([]); selectNode(null); }}>Project</button>
        {path.map((id, index) => <button type="button" key={id} onClick={() => { const next = path.slice(0, index + 1); pathRef.current = next; setPath(next); selectNode(null); }}>› {residents.get(id)?.page.community.label ?? id}</button>)}
      </div>}
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <Suspense fallback={<div style={{ padding: 24, color: 'var(--text-dim)' }}>Loading 3D renderer…</div>}>
          <LazyConstellation3D
            projectId={pid} generationId={overview.revision.generationId} layoutVersion={overview.revision.layoutVersion}
            nodes={scene.nodes} edges={scene.edges} selectedNodeId={selectedNodeId} theme={theme}
            reducedMotion={window.matchMedia('(prefers-reduced-motion: reduce)').matches}
            onSelectNode={selectNode} onOpenEgoNetwork={onOpenEgoNetwork} onOpenInspector={onOpenInspector}
            onRendererFailure={onFallback}
          />
        </Suspense>
        {(selectedCommunity || selectedEntity) && <aside style={{ position: 'absolute', right: 12, bottom: 12, width: 300, padding: 12, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10 }}>
          <strong>{selected?.label}</strong>
          <div style={{ marginTop: 5, color: 'var(--text-dim)', fontSize: 11 }}>{selectedCommunity ? 'Community aggregate' : `${selected?.type} · degree ${selected?.degree}`}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            {selectedCommunity && <Button onClick={() => void expand(selectedCommunity.id)} disabled={expanding}>{expanding ? 'opening…' : 'open community'}</Button>}
            {selectedEntity?.uri && <Button variant="ghost" onClick={() => onOpenEgoNetwork?.(selectedEntity.uri!)}>ego network</Button>}
            {selectedEntity?.uri && selectedEntity.type === 'memory' && <Button variant="ghost" onClick={() => onOpenInspector?.(selectedEntity.uri!)}>evidence</Button>}
            <Button variant="ghost" onClick={() => selectNode(null)}>clear</Button>
          </div>
          {incidentPages.at(-1)?.nextCursor && <Button variant="ghost" onClick={() => void loadMoreIncidents()} style={{ marginTop: 8 }}>load more relationships</Button>}
        </aside>}
        {currentPage?.nextCursor && <Button onClick={() => void fetchCommunity(currentPage.community.id, currentPage.nextCursor!)} style={{ position: 'absolute', left: 12, bottom: 12 }}>load more in community</Button>}
        {scene.partial && <div style={{ position: 'absolute', left: 12, top: 12, padding: '5px 8px', borderRadius: 6, background: 'var(--panel)', color: 'var(--amber)', fontSize: 10 }}>Partial level · bounded continuation available</div>}
        {error && <div role="status" style={{ position: 'absolute', left: 12, bottom: 54, maxWidth: 420, color: 'var(--red-soft)', background: 'var(--panel)', padding: 8 }}>{error}</div>}
        {hits.length > 0 && <div style={{ position: 'absolute', right: 14, top: 10, width: 360, maxHeight: 300, overflow: 'auto', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8 }}>
          {hits.map((hit) => <button key={`${hit.entityType}:${hit.id}`} type="button" onClick={() => void focusHit(hit)} style={{ display: 'block', width: '100%', padding: 9, textAlign: 'left', borderBottom: '1px solid var(--line)' }}>{hit.title}<small style={{ display: 'block', color: 'var(--text-dim)' }}>{hit.entityType} · {hit.uri}</small></button>)}
        </div>}
        {searching && <div style={{ position: 'absolute', right: 18, top: 16, color: 'var(--text-dim)', fontSize: 10 }}>searching…</div>}
        <details style={{ position: 'absolute', left: 12, top: 42, maxHeight: '60%', width: 300, overflow: 'auto', background: 'var(--panel)', padding: 8, borderRadius: 8 }}>
          <summary>Accessible visible list ({scene.nodes.length})</summary>
          {scene.nodes.map((node) => <button key={node.id} type="button" onClick={() => selectNode(node.id)} onDoubleClick={() => { if (node.community) void expand(node.id); }} style={{ display: 'block', width: '100%', textAlign: 'left', padding: 5 }}>{node.label} <small>({node.type})</small></button>)}
        </details>
      </div>
    </div>
  );
}

export default MemoryConstellationV2;
