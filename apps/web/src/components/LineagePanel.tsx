import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api, type ApiExecutionNode, type ApiExecutionRelation, type ApiExecutionTimelineEvent,
  type ApiOrchestrationSummary, type ApiOrchestrationTree,
} from '../api';
import { MonoTag, SectionLabel } from './bits';
import { Button, ErrorNote } from './ui';

const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5_400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 129_600) return `${Math.round(seconds / 3_600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
};

export function LineageExplorer({
  projectId,
  initialOrchestrationId = null,
  initialExecutionId = null,
  onSelectionChange,
  onOpenJob,
}: {
  projectId: string;
  initialOrchestrationId?: string | null;
  initialExecutionId?: string | null;
  onSelectionChange?: (orchestrationId: string, executionId: string | null) => void;
  onOpenJob?: (jobId: string) => void;
}) {
  const [view, setView] = useState<'active' | 'history'>('active');
  const [items, setItems] = useState<ApiOrchestrationSummary[]>([]);
  const [counts, setCounts] = useState({ active: 0, history: 0, total: 0 });
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialOrchestrationId);
  const request = useRef(0);

  const load = async (cursor?: string, append = false) => {
    const generation = ++request.current;
    const result = await api.orchestrations(projectId, { view, cursor, limit: 40 });
    if (generation !== request.current) return;
    setItems((current) => append ? [...current, ...result.orchestrations] : result.orchestrations);
    setCounts(result.counts);
    setNextCursor(result.page.nextCursor);
    if (!initialOrchestrationId) setSelectedId((current) => current ?? result.orchestrations[0]?.id ?? null);
  };

  useEffect(() => { setItems([]); void load(); }, [projectId, view]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!initialOrchestrationId) return;
    setSelectedId(initialOrchestrationId);
  }, [initialOrchestrationId]);

  const select = (id: string) => {
    setSelectedId(id);
    onSelectionChange?.(id, null);
  };

  return <div className="lineage-explorer">
    <aside className="lineage-explorer-list">
      <SectionLabel>Lineage · {counts.total}</SectionLabel>
      <div style={{ display: 'flex', gap: 4, margin: '10px 0' }}>
        <Button variant={view === 'active' ? 'primary' : 'ghost'} onClick={() => { setView('active'); setSelectedId(null); }}>Active {counts.active}</Button>
        <Button variant={view === 'history' ? 'primary' : 'ghost'} onClick={() => { setView('history'); setSelectedId(null); }}>History {counts.history}</Button>
      </div>
      {items.map((item) => <button key={item.id} type="button" onClick={() => select(item.id)} className="lineage-list-item" data-selected={selectedId === item.id || undefined}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <b style={{ fontSize: 12 }}>{item.anchorLabel ?? item.anchorType}</b>
          <MonoTag color="var(--text-mid)" bg="var(--w-05)" size={8}>{item.status}</MonoTag>
        </div>
        <div className="lineage-list-meta">{item.nodeCount} nodes · {item.liveNodeCount} live · updated {ago(item.updatedAt)}</div>
        {item.incompleteNodeCount > 0 && <div className="lineage-incomplete">{item.incompleteNodeCount} incomplete lineage</div>}
      </button>)}
      {!items.length && <div className="lineage-empty">no {view} lineage</div>}
      {nextCursor && <Button variant="ghost" onClick={() => void load(nextCursor, true)} style={{ width: '100%' }}>load more</Button>}
    </aside>
    <div className="lineage-explorer-detail">
      {selectedId
        ? <LineagePanel projectId={projectId} orchestrationId={selectedId} initialExecutionId={selectedId === initialOrchestrationId ? initialExecutionId : null} onSelectionChange={onSelectionChange} onOpenJob={onOpenJob} />
        : <div className="lineage-empty">Select lineage to inspect.</div>}
    </div>
  </div>;
}

export function LineagePanel({
  projectId,
  orchestrationId,
  initialExecutionId = null,
  onSelectionChange,
  onOpenJob,
}: {
  projectId: string;
  orchestrationId: string;
  initialExecutionId?: string | null;
  onSelectionChange?: (orchestrationId: string, executionId: string | null) => void;
  onOpenJob?: (jobId: string) => void;
}) {
  const [tree, setTree] = useState<ApiOrchestrationTree | null>(null);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(initialExecutionId);
  const [mode, setMode] = useState<'hierarchy' | 'timeline'>('hierarchy');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setTree(null);
    setError(null);
    void api.orchestration(projectId, orchestrationId, { timelineLimit: 100 })
      .then((result) => { if (current) setTree(result); })
      .catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : 'Unable to load lineage'); });
    return () => { current = false; };
  }, [projectId, orchestrationId]);
  useEffect(() => setSelectedExecutionId(initialExecutionId), [initialExecutionId]);

  useEffect(() => {
    if (!tree || !selectedExecutionId) return;
    const element = document.getElementById(`lineage-${selectedExecutionId}`);
    if (typeof element?.scrollIntoView === 'function') element.scrollIntoView({ block: 'center' });
  }, [tree, selectedExecutionId]);

  const selectExecution = (id: string) => {
    setSelectedExecutionId(id);
    onSelectionChange?.(orchestrationId, id);
  };
  const loadMoreTimeline = async () => {
    if (!tree?.timelinePage.nextCursor) return;
    const more = await api.orchestration(projectId, orchestrationId, { timelineCursor: tree.timelinePage.nextCursor, timelineLimit: 100 });
    setTree((current) => current?.orchestration.id === orchestrationId
      ? { ...current, timeline: [...current.timeline, ...more.timeline], timelinePage: more.timelinePage }
      : current);
  };

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!tree) return <div className="lineage-empty">Loading lineage…</div>;
  return <LineageDetail
    tree={tree}
    mode={mode}
    setMode={setMode}
    selectedExecutionId={selectedExecutionId}
    onSelectExecution={selectExecution}
    onMoreTimeline={loadMoreTimeline}
    onOpenJob={onOpenJob}
  />;
}

function LineageDetail({ tree, mode, setMode, selectedExecutionId, onSelectExecution, onMoreTimeline, onOpenJob }: {
  tree: ApiOrchestrationTree;
  mode: 'hierarchy' | 'timeline';
  setMode: (mode: 'hierarchy' | 'timeline') => void;
  selectedExecutionId: string | null;
  onSelectExecution: (id: string) => void;
  onMoreTimeline: () => Promise<void>;
  onOpenJob?: (jobId: string) => void;
}) {
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
  return <div className="lineage-detail">
    <div className="lineage-header">
      <div>
        <h2>{tree.orchestration.anchorLabel ?? `${tree.orchestration.anchorType} lineage`}</h2>
        <div className="lineage-list-meta">{tree.orchestration.id} · {tree.nodes.length} canonical nodes · created by {tree.orchestration.createdByName ?? tree.orchestration.createdById}</div>
      </div>
      <div style={{ flex: 1 }} />
      {tree.orchestration.runnerJobId && onOpenJob && <Button variant="ghost" onClick={() => onOpenJob(tree.orchestration.runnerJobId!)}>Open job</Button>}
      <Button variant={mode === 'hierarchy' ? 'primary' : 'ghost'} onClick={() => setMode('hierarchy')}>Hierarchy</Button>
      <Button variant={mode === 'timeline' ? 'primary' : 'ghost'} onClick={() => setMode('timeline')}>Audit timeline</Button>
    </div>
    {tree.orchestration.completenessStatus !== 'complete' && <div className="lineage-warning">Incomplete lineage · {tree.orchestration.completenessReason ?? tree.orchestration.completenessMissing.join(', ')}</div>}
    {mode === 'hierarchy'
      ? tree.rootExecutionIds.map((id) => tree.nodes.find((node) => node.id === id)).filter((node): node is ApiExecutionNode => !!node)
        .map((node) => <LineageNode key={node.id} node={node} byParent={byParent} relations={relations} nodeLabels={nodeLabels} depth={0} selectedId={selectedExecutionId} selectedPath={selectedPath} onSelect={onSelectExecution} />)
      : <Timeline events={tree.timeline} nodes={tree.nodes} hasMore={tree.timelinePage.hasMore} onMore={onMoreTimeline} />}
    {mode === 'hierarchy' && tree.rootExecutionIds.length === 0 && <div className="lineage-empty">No canonical lineage nodes recorded.</div>}
  </div>;
}

function LineageNode({ node, byParent, relations, nodeLabels, depth, selectedId, selectedPath, onSelect }: {
  node: ApiExecutionNode;
  byParent: Map<string | null, ApiExecutionNode[]>;
  relations: Map<string, ApiExecutionRelation[]>;
  nodeLabels: Map<string, string>;
  depth: number;
  selectedId: string | null;
  selectedPath: Set<string>;
  onSelect: (id: string) => void;
}) {
  const children = byParent.get(node.id) ?? [];
  const [expanded, setExpanded] = useState(!terminal.has(node.status) || selectedPath.has(node.id));
  useEffect(() => { if (selectedPath.has(node.id)) setExpanded(true); }, [node.id, selectedPath]);
  const label = node.step ?? node.stage ?? node.taskKey ?? node.runId ?? `${node.kind} ${node.sitting ?? ''}`.trim();
  return <div style={{ marginLeft: depth * 18 }}>
    <div id={`lineage-${node.id}`} onClick={() => onSelect(node.id)} className="lineage-node" data-selected={selectedId === node.id || undefined}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        {children.length > 0 && <button type="button" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`} aria-expanded={expanded} onClick={(event) => { event.stopPropagation(); setExpanded((value) => !value); }} className="lineage-expand">{expanded ? '▾' : '▸'}</button>}
        <b style={{ fontSize: 12.5 }}>{label}</b>
        <MonoTag color="var(--text-mid)" bg="var(--w-05)" size={8}>{node.kind}</MonoTag>
        <MonoTag color="var(--blue)" bg="rgba(76,157,255,.1)" size={8}>{node.role}</MonoTag>
        <MonoTag color={node.status === 'failed' ? 'var(--red-soft)' : 'var(--text-mid)'} bg="var(--w-05)" size={8}>{node.status}</MonoTag>
      </div>
      <div className="lineage-list-meta">{node.actorName ?? node.actorId ?? 'unassigned'}{node.taskKey ? ` · ${node.taskKey}${node.taskTitle ? ` ${node.taskTitle}` : ''}` : ''}{node.planTitle ? ` · plan ${node.planTitle}` : ''}{node.runId ? ` · run ${node.runId}` : ''}{node.sitting != null ? ` · sitting ${node.sitting}` : ''}{node.gateId ? ` · gate ${node.gateId}` : ''}{node.outcomeReason ? ` · ${node.outcomeReason}` : ''}</div>
      {node.completenessStatus !== 'complete' && <div className="lineage-incomplete">lineage {node.completenessStatus}: {node.completenessReason ?? node.completenessMissing.join(', ')}</div>}
      {!!relations.get(node.id)?.length && <div style={{ display: 'flex', gap: 4, marginTop: 5, flexWrap: 'wrap' }}>{relations.get(node.id)!.map((relation) => <MonoTag key={relation.id} color="var(--accent-ink)" bg="rgba(198,242,78,.08)" size={8}>{relation.type} → {nodeLabels.get(relation.toExecutionId) ?? relation.toExecutionId.slice(-6)}</MonoTag>)}</div>}
    </div>
    {expanded && children.length > 0 && <div className="lineage-children">{children.map((child) => <LineageNode key={child.id} node={child} byParent={byParent} relations={relations} nodeLabels={nodeLabels} depth={1} selectedId={selectedId} selectedPath={selectedPath} onSelect={onSelect} />)}</div>}
  </div>;
}

function Timeline({ events, nodes, hasMore, onMore }: { events: ApiExecutionTimelineEvent[]; nodes: ApiExecutionNode[]; hasMore: boolean; onMore: () => Promise<void> }) {
  const names = new Map(nodes.map((node) => [node.id, node.step ?? node.stage ?? node.taskKey ?? node.runId ?? node.kind]));
  return <div>{events.map((event) => <div key={event.eventId} className="lineage-timeline-row"><span>{new Date(event.observedAt).toLocaleString()}</span><span><b>{event.eventType}</b> · {names.get(event.executionId) ?? event.executionId}{event.targetExecutionId ? ` → ${names.get(event.targetExecutionId) ?? event.targetExecutionId}` : ''}{event.reason ? ` · ${event.reason}` : ''}</span></div>)}{!events.length && <div className="lineage-empty">No lifecycle events recorded.</div>}{hasMore && <Button variant="ghost" onClick={() => void onMore()}>load older events</Button>}</div>;
}
