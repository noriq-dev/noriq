import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api, type ApiExecutionNode, type ApiExecutionRelation, type ApiExecutionTimelineEvent,
  type ApiOrchestrationSummary, type ApiOrchestrationTree,
} from '../api';
import type { AppStore } from '../store';
import { MonoTag, SectionLabel } from './bits';
import { Button } from './ui';

const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 129600) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
};

export function ExecutionView({ store }: { store: AppStore }) {
  const pid = store.currentPid;
  const [view, setView] = useState<'active' | 'history'>('active');
  const [items, setItems] = useState<ApiOrchestrationSummary[]>([]);
  const [counts, setCounts] = useState({ active: 0, history: 0, total: 0 });
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const initial = new URLSearchParams(location.search).get('orchestration');
  const [selectedId, setSelectedId] = useState<string | null>(initial);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(new URLSearchParams(location.search).get('execution'));
  const [tree, setTree] = useState<ApiOrchestrationTree | null>(null);
  const [mode, setMode] = useState<'hierarchy' | 'timeline'>('hierarchy');
  const listRequest = useRef(0);
  const previousPid = useRef(pid);

  const loadList = async (cursor?: string, append = false) => {
    if (!pid) return;
    const request = ++listRequest.current;
    const result = await api.orchestrations(pid, { view, cursor, limit: 40 });
    if (request !== listRequest.current) return;
    setItems((current) => append ? [...current, ...result.orchestrations] : result.orchestrations);
    setCounts(result.counts);
    setNextCursor(result.page.nextCursor);
    const first = result.orchestrations[0];
    if (first) setSelectedId((current) => current ?? first.id);
  };
  useEffect(() => {
    if (previousPid.current === pid) return;
    previousPid.current = pid;
    setSelectedId(null);
    setSelectedExecutionId(null);
    setTree(null);
  }, [pid]);
  useEffect(() => { setItems([]); void loadList(); }, [pid, view]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!pid || !selectedId) { setTree(null); return; }
    let current = true;
    setTree(null);
    void api.orchestration(pid, selectedId, { timelineLimit: 100 })
      .then((result) => { if (current) setTree(result); })
      .catch(() => { if (current) setTree(null); });
    const params = new URLSearchParams(location.search);
    params.set('orchestration', selectedId);
    history.replaceState(null, '', `${location.pathname}?${params}`);
    return () => { current = false; };
  }, [pid, selectedId]);
  useEffect(() => {
    if (!tree || !selectedExecutionId) return;
    document.getElementById(`execution-${selectedExecutionId}`)?.scrollIntoView({ block: 'center' });
  }, [tree, selectedExecutionId]);

  const selectExecution = (executionId: string) => {
    setSelectedExecutionId(executionId);
    const params = new URLSearchParams(location.search);
    if (selectedId) params.set('orchestration', selectedId);
    params.set('execution', executionId);
    history.replaceState(null, '', `${location.pathname}?${params}`);
  };

  const selectOrchestration = (orchestrationId: string) => {
    setSelectedId(orchestrationId);
    setSelectedExecutionId(null);
    const params = new URLSearchParams(location.search);
    params.set('orchestration', orchestrationId);
    params.delete('execution');
    history.replaceState(null, '', `${location.pathname}?${params}`);
  };

  const selectView = (next: 'active' | 'history') => {
    if (next === view) return;
    listRequest.current += 1;
    setView(next);
    setSelectedId(null);
    setSelectedExecutionId(null);
    setTree(null);
    const params = new URLSearchParams(location.search);
    params.delete('orchestration');
    params.delete('execution');
    history.replaceState(null, '', params.size ? `${location.pathname}?${params}` : location.pathname);
  };

  const loadMoreTimeline = async () => {
    if (!pid || !selectedId || !tree?.timelinePage.nextCursor) return;
    const orchestrationId = selectedId;
    const more = await api.orchestration(pid, orchestrationId, { timelineCursor: tree.timelinePage.nextCursor, timelineLimit: 100 });
    setTree((current) => current?.orchestration.id === orchestrationId
      ? { ...current, timeline: [...current.timeline, ...more.timeline], timelinePage: more.timelinePage }
      : current);
  };

  return <div style={{ position: 'absolute', inset: 0, display: 'grid', gridTemplateColumns: '310px 1fr', minHeight: 0 }}>
    <aside style={{ borderRight: '1px solid var(--line)', overflowY: 'auto', padding: 14 }}>
      <SectionLabel>Executions · {counts.total}</SectionLabel>
      <div style={{ display: 'flex', gap: 4, margin: '10px 0' }}>
        <Button variant={view === 'active' ? 'primary' : 'ghost'} onClick={() => selectView('active')}>Active {counts.active}</Button>
        <Button variant={view === 'history' ? 'primary' : 'ghost'} onClick={() => selectView('history')}>History {counts.history}</Button>
      </div>
      {items.map((item) => <button key={item.id} onClick={() => selectOrchestration(item.id)} style={{ display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer', padding: '10px', marginBottom: 6, borderRadius: 8, background: selectedId === item.id ? 'var(--w-07)' : 'var(--w-02)', border: '1px solid var(--w-07)' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}><b style={{ fontSize: 12 }}>{item.anchorLabel ?? item.anchorType}</b><MonoTag color="var(--text-mid)" bg="var(--w-05)" size={8}>{item.status}</MonoTag></div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)', marginTop: 4 }}>{item.nodeCount} nodes · {item.liveNodeCount} live · updated {ago(item.updatedAt)}</div>
        {item.incompleteNodeCount > 0 && <div style={{ color: 'var(--amber)', fontSize: 9.5, marginTop: 3 }}>{item.incompleteNodeCount} incomplete lineage</div>}
      </button>)}
      {!items.length && <div style={{ padding: 20, color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 10 }}>no {view} executions</div>}
      {nextCursor && <Button variant="ghost" onClick={() => void loadList(nextCursor, true)} style={{ width: '100%' }}>load more</Button>}
    </aside>
    <main style={{ overflowY: 'auto', padding: '18px 22px' }}>
      {!tree ? <div style={{ color: 'var(--text-dim)' }}>Select an execution.</div> : <ExecutionDetail tree={tree} mode={mode} setMode={setMode} selectedExecutionId={selectedExecutionId} onSelectExecution={selectExecution} onMoreTimeline={loadMoreTimeline} />}
    </main>
  </div>;
}

function ExecutionDetail({ tree, mode, setMode, selectedExecutionId, onSelectExecution, onMoreTimeline }: { tree: ApiOrchestrationTree; mode: 'hierarchy' | 'timeline'; setMode: (mode: 'hierarchy' | 'timeline') => void; selectedExecutionId: string | null; onSelectExecution: (id: string) => void; onMoreTimeline: () => Promise<void> }) {
  const byParent = useMemo(() => {
    const map = new Map<string | null, ApiExecutionNode[]>();
    for (const node of tree.nodes) map.set(node.parentExecutionId, [...(map.get(node.parentExecutionId) ?? []), node]);
    return map;
  }, [tree.nodes]);
  const relations = useMemo(() => new Map(tree.nodes.map((node) => [node.id, tree.relations.filter((relation) => relation.fromExecutionId === node.id)])), [tree.nodes, tree.relations]);
  const nodeLabels = useMemo(() => new Map(tree.nodes.map((node) => [node.id, node.step ?? node.stage ?? node.taskKey ?? node.runId ?? node.kind])), [tree.nodes]);
  const selectedPath = useMemo(() => {
    const path = new Set<string>();
    const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
    let current = selectedExecutionId ? nodes.get(selectedExecutionId) : undefined;
    while (current && !path.has(current.id)) {
      path.add(current.id);
      current = current.parentExecutionId ? nodes.get(current.parentExecutionId) : undefined;
    }
    return path;
  }, [selectedExecutionId, tree.nodes]);
  return <div style={{ maxWidth: 1000, margin: '0 auto' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
      <div><h2 style={{ margin: 0, fontSize: 17 }}>{tree.orchestration.anchorLabel ?? `${tree.orchestration.anchorType} execution`}</h2><div style={{ fontFamily: 'var(--mono)', color: 'var(--text-dim)', fontSize: 10, marginTop: 4 }}>{tree.orchestration.id} · {tree.nodes.length} canonical nodes · created by {tree.orchestration.createdByName ?? tree.orchestration.createdById}</div></div>
      <div style={{ flex: 1 }} /><Button variant={mode === 'hierarchy' ? 'primary' : 'ghost'} onClick={() => setMode('hierarchy')}>Hierarchy</Button><Button variant={mode === 'timeline' ? 'primary' : 'ghost'} onClick={() => setMode('timeline')}>Audit timeline</Button>
    </div>
    {tree.orchestration.completenessStatus !== 'complete' && <div style={{ padding: 10, border: '1px solid rgba(245,166,35,.35)', borderRadius: 8, color: 'var(--amber)', fontSize: 11, marginBottom: 12 }}>Incomplete legacy lineage · {tree.orchestration.completenessReason ?? tree.orchestration.completenessMissing.join(', ')}</div>}
    {mode === 'hierarchy'
      ? tree.rootExecutionIds.map((id) => tree.nodes.find((node) => node.id === id)).filter((node): node is ApiExecutionNode => !!node)
        .map((node) => <ExecutionNodeRow key={node.id} node={node} byParent={byParent} relations={relations} nodeLabels={nodeLabels} depth={0} selectedId={selectedExecutionId} selectedPath={selectedPath} onSelect={onSelectExecution} />)
      : <Timeline events={tree.timeline} nodes={tree.nodes} hasMore={tree.timelinePage.hasMore} onMore={onMoreTimeline} />}
    {mode === 'hierarchy' && tree.rootExecutionIds.length === 0 && <div style={{ color: 'var(--text-dim)' }}>No canonical execution nodes recorded.</div>}
  </div>;
}

function ExecutionNodeRow({ node, byParent, relations, nodeLabels, depth, selectedId, selectedPath, onSelect }: { node: ApiExecutionNode; byParent: Map<string | null, ApiExecutionNode[]>; relations: Map<string, ApiExecutionRelation[]>; nodeLabels: Map<string, string>; depth: number; selectedId: string | null; selectedPath: Set<string>; onSelect: (id: string) => void }) {
  const children = byParent.get(node.id) ?? [];
  const done = terminal.has(node.status);
  const [expanded, setExpanded] = useState(!done || selectedPath.has(node.id));
  useEffect(() => { if (selectedPath.has(node.id)) setExpanded(true); }, [node.id, selectedPath]);
  const label = node.step ?? node.stage ?? node.taskKey ?? node.runId ?? `${node.kind} ${node.sitting ?? ''}`.trim();
  const content = <div id={`execution-${node.id}`} onClick={() => onSelect(node.id)} style={{ padding: '9px 11px', border: `1px solid ${selectedId === node.id ? 'var(--accent)' : 'var(--w-07)'}`, background: 'var(--w-02)', borderRadius: 8, marginBottom: 6, cursor: 'pointer' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>{children.length > 0 && <button aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`} onClick={(event) => { event.stopPropagation(); setExpanded((value) => !value); }} style={{ border: 0, background: 'transparent', color: 'var(--text-dim)', cursor: 'pointer', padding: 0, width: 12 }}>{expanded ? '▾' : '▸'}</button>}<b style={{ fontSize: 12.5 }}>{label}</b><MonoTag color="var(--text-mid)" bg="var(--w-05)" size={8}>{node.kind}</MonoTag><MonoTag color="var(--blue)" bg="rgba(76,157,255,.1)" size={8}>{node.role}</MonoTag><MonoTag color={node.status === 'failed' ? 'var(--red-soft)' : 'var(--text-mid)'} bg="var(--w-05)" size={8}>{node.status}</MonoTag></div>
    <div style={{ marginTop: 4, fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)' }}>{node.actorName ?? node.actorId ?? 'unassigned'}{node.taskKey ? ` · ${node.taskKey}${node.taskTitle ? ` ${node.taskTitle}` : ''}` : ''}{node.planTitle ? ` · plan ${node.planTitle}` : ''}{node.runId ? ` · run ${node.runId}` : ''}{node.sitting != null ? ` · sitting ${node.sitting}` : ''}{node.gateId ? ` · gate ${node.gateId}` : ''}{node.outcomeReason ? ` · ${node.outcomeReason}` : ''}</div>
    {node.completenessStatus !== 'complete' && <div style={{ color: 'var(--amber)', fontSize: 9.5, marginTop: 3 }}>lineage {node.completenessStatus}: {node.completenessReason ?? node.completenessMissing.join(', ')}</div>}
    {!!relations.get(node.id)?.length && <div style={{ display: 'flex', gap: 4, marginTop: 5 }}>{relations.get(node.id)!.map((relation) => <MonoTag key={relation.id} color="var(--accent-ink)" bg="rgba(198,242,78,.08)" size={8}>{relation.type} → {nodeLabels.get(relation.toExecutionId) ?? relation.toExecutionId.slice(-6)}</MonoTag>)}</div>}
  </div>;
  if (!children.length) return <div style={{ marginLeft: depth * 18 }}>{content}</div>;
  return <div style={{ marginLeft: depth * 18 }}>{content}{expanded && <div style={{ borderLeft: '1px solid var(--w-09)', marginLeft: 8 }}>{children.map((child) => <ExecutionNodeRow key={child.id} node={child} byParent={byParent} relations={relations} nodeLabels={nodeLabels} depth={1} selectedId={selectedId} selectedPath={selectedPath} onSelect={onSelect} />)}</div>}</div>;
}

function Timeline({ events, nodes, hasMore, onMore }: { events: ApiExecutionTimelineEvent[]; nodes: ApiExecutionNode[]; hasMore: boolean; onMore: () => Promise<void> }) {
  const names = new Map(nodes.map((node) => [node.id, node.step ?? node.stage ?? node.taskKey ?? node.runId ?? node.kind]));
  return <div>{events.map((event) => <div key={event.eventId} style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--w-05)', fontSize: 11 }}><span style={{ fontFamily: 'var(--mono)', color: 'var(--text-faint)' }}>{new Date(event.observedAt).toLocaleString()}</span><span><b>{event.eventType}</b> · {names.get(event.executionId) ?? event.executionId}{event.targetExecutionId ? ` → ${names.get(event.targetExecutionId) ?? event.targetExecutionId}` : ''}{event.reason ? ` · ${event.reason}` : ''}</span></div>)}{!events.length && <div style={{ color: 'var(--text-dim)' }}>No lifecycle events recorded.</div>}{hasMore && <Button variant="ghost" onClick={() => void onMore()}>load older events</Button>}</div>;
}
