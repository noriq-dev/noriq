// Ego-network graph + change-impact views (PLNR-272) — the Graph sub-tab of the Project Memory
// explorer (PLNR-271's shell, MemoryView.tsx). §5 is the hard constraint this whole file exists
// to satisfy: "the human graph view BEGINS with ego-network exploration around a selected
// entity. A whole-project visualization is secondary and never replaces filtered graph
// exploration." There is accordingly no code path here that requests, receives, or lays out the
// whole project graph — every fetch below names exactly ONE seed entity URI, and the server's
// own depth/result ceilings (RETRIEVAL_DEFAULTS in apps/api/src/memory/retrieval.ts) bound every
// expansion regardless of what this UI asks for.
//
// This reuses the SAME two routes MemoryView's Explore tab already exercises
// (POST /memory/search, POST /memory/explain) rather than adding a new one: `explain`'s
// `focus: 'dependencies'` primitive (ProjectMemory.dependencyNeighborhood) takes a
// caller-supplied `edgeTypes` array and walks it in BOTH directions from one seed, which makes
// it the general bounded bidirectional neighborhood query this view needs — "dependencies" is
// just its default edge set when the caller asks for nothing in particular, not a hard
// restriction on this call. `focus: 'tests'`/`'impact'` back the two side panels directly.
//
// Hand-rolled SVG, matching Graph.tsx's precedent (the live orchestration graph — a DIFFERENT
// thing: this file never touches it). No new runtime dependency: an ego-network of bounded size
// does not need a layout engine, so there is no d3/cytoscape import here, by design.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildEntityUri, MemoryEdgeType, MemoryNodeType } from '@noriq-dev/shared';
import {
  api, ApiError,
  type ApiChangeImpact, type ApiDependencyNeighborhood, type ApiEdgeHop, type ApiGraphCoverage,
  type ApiGraphEntityRef, type ApiRelatedEntity, type ApiValidatingTests,
} from '../api';
import type { AppStore } from '../store';
import { MonoTag, SectionLabel } from './bits';
import { Button, Select, TextInput } from './ui';

// Mirrors apps/api/src/memory/retrieval.ts's RETRIEVAL_DEFAULTS. That file is server-only (not
// re-exported through @noriq-dev/shared, which is the only cross-workspace import surface this
// app has), so the numbers are duplicated here ONLY to bound the depth control's UI range — the
// server clamps independently and authoritatively no matter what this sends (locked decision:
// never invent a stricter OR looser ceiling than the server's own). If retrieval.ts's constants
// ever change, this comment (and the two numbers below) need to change with them.
const MAX_DEPTH_DEFAULT = 2;
const MAX_DEPTH_CEILING = 4;

// Every relationship the shared MemoryEdgeType vocabulary declares (§5). `supersedes` and
// `contradicts` are explicitly about a version/conflict relationship rather than a current
// structural fact (§12: "Supersession creates a new version or replacement relationship... does
// not destructively erase history"; "Conflicting claims may coexist... until resolved") and
// `failed_because` names a past failed attempt — these three read as HISTORICAL. Everything else
// (declares/calls/imports/depends_on/tests/implements/modifies/observed_in/decided_by/blocks/
// related_to/validated_by/owned_by/commonly_changes_with/derived_from) describes the project's
// CURRENT structure. This classification is a discretionary visual-encoding choice (the `edges`
// table itself carries no per-row status column to read this from), documented here rather than
// invented silently.
const HISTORICAL_EDGE_TYPES: ReadonlySet<string> = new Set(['supersedes', 'contradicts', 'failed_because']);

const NODE_TYPE_META: Record<string, { abbr: string; color: string }> = {
  project: { abbr: 'PROJ', color: 'var(--text-mid)' },
  repository: { abbr: 'REPO', color: 'var(--text-mid)' },
  branch: { abbr: 'BR', color: 'var(--text-mid)' },
  revision: { abbr: 'REV', color: 'var(--text-mid)' },
  file: { abbr: 'FILE', color: 'var(--blue)' },
  symbol: { abbr: 'SYM', color: 'var(--blue)' },
  api: { abbr: 'API', color: 'var(--blue)' },
  database_entity: { abbr: 'DB', color: 'var(--blue)' },
  test: { abbr: 'TEST', color: 'var(--green)' },
  task: { abbr: 'TASK', color: 'var(--purple)' },
  plan: { abbr: 'PLAN', color: 'var(--purple)' },
  run: { abbr: 'RUN', color: 'var(--purple)' },
  agent: { abbr: 'AGT', color: 'var(--purple)' },
  decision: { abbr: 'DEC', color: 'var(--amber)' },
  memory: { abbr: 'MEM', color: 'var(--amber)' },
  error: { abbr: 'ERR', color: 'var(--red-soft)' },
  requirement: { abbr: 'REQ', color: 'var(--amber)' },
  procedure: { abbr: 'PROC', color: 'var(--amber)' },
  episode: { abbr: 'EPI', color: 'var(--amber)' },
  artifact: { abbr: 'ART', color: 'var(--text-mid)' },
  unknown: { abbr: '???', color: 'var(--text-dim)' },
};
const nodeMeta = (type: string) => NODE_TYPE_META[type] ?? { abbr: type.slice(0, 4).toUpperCase(), color: 'var(--text-mid)' };

// ---------------------------------------------------------------------------------------------
// Layout preferences — client-side only, keyed per project, never written back into canonical
// nodes/edges (locked decision: the graph is rebuildable derived data; a layout coordinate baked
// into a canonical row would be destroyed by the next reindex). Follows the repo's existing
// `noriq.*` localStorage convention (see Rail.tsx's `noriq.sidebar.collapsed`).
// ---------------------------------------------------------------------------------------------

interface GraphPrefs {
  edgeTypes: string[]; // [] = no filter, every edge type considered
  maxDepth: number;
  viewMode: 'visual' | 'list';
  panelMode: 'neighborhood' | 'tests' | 'impact';
  zoom: number;
  /** seedUri -> nodeUri -> pinned canvas position. Scoped per seed so a pin from one
   *  neighborhood never collides with an unrelated node reached from a different seed. */
  positions: Record<string, Record<string, { x: number; y: number }>>;
  /** `${seedUri}:${side}:${depth}` for a collapsed ring — hidden until re-expanded. */
  collapsedRings: string[];
}

const DEFAULT_PREFS: GraphPrefs = {
  edgeTypes: [], maxDepth: MAX_DEPTH_DEFAULT, viewMode: 'visual', panelMode: 'neighborhood', zoom: 1,
  positions: {}, collapsedRings: [],
};

const prefsKey = (pid: string) => `noriq.memoryGraph.${pid}`;

function loadPrefs(pid: string): GraphPrefs {
  try {
    const raw = localStorage.getItem(prefsKey(pid));
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<GraphPrefs>;
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(pid: string, prefs: GraphPrefs) {
  try { localStorage.setItem(prefsKey(pid), JSON.stringify(prefs)); } catch { /* private mode / quota — layout prefs are a nicety, never load-bearing */ }
}

// ---------------------------------------------------------------------------------------------
// Shaping a DependencyNeighborhoodResult into a drawable graph. `rawTraverseGraph` (server side)
// returns every reached node at every depth (not just leaves), each carrying the edge-path from
// the seed to itself, so no node is ever missing a label here — the union of seed + downstream +
// upstream entities IS the full reachable node set, and every hop across every entity's edgePath
// IS a real edge (deduped by type+from+to, since a depth-2 entity's path repeats its depth-1
// prefix).
// ---------------------------------------------------------------------------------------------

interface GraphNodeVM extends ApiGraphEntityRef {
  depth: number;
  side: 'seed' | 'downstream' | 'upstream' | 'both';
}
interface GraphEdgeVM extends ApiEdgeHop {
  key: string;
}

function buildGraph(data: ApiDependencyNeighborhood): { nodes: GraphNodeVM[]; edges: GraphEdgeVM[] } {
  const nodes = new Map<string, GraphNodeVM>();
  const edges = new Map<string, GraphEdgeVM>();
  if (data.seed) nodes.set(data.seed.nodeId, { ...data.seed, depth: 0, side: 'seed' });

  const addSide = (list: ApiRelatedEntity[], side: 'downstream' | 'upstream') => {
    for (const e of list) {
      const existing = nodes.get(e.nodeId);
      if (!existing) {
        nodes.set(e.nodeId, { nodeId: e.nodeId, uri: e.uri, type: e.type, label: e.label, depth: e.depth, side });
      } else if (existing.side !== 'seed' && existing.side !== side) {
        nodes.set(e.nodeId, { ...existing, side: 'both', depth: Math.min(existing.depth, e.depth) });
      }
      for (const hop of e.edgePath) {
        const key = `${hop.edgeType}:${hop.fromNodeId}:${hop.toNodeId}`;
        if (!edges.has(key)) edges.set(key, { key, ...hop });
      }
    }
  };
  addSide(data.downstream, 'downstream');
  addSide(data.upstream, 'upstream');
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

interface Layout {
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

const RING = 150;
const RING_PAD = 220;

function computeLayout(nodes: GraphNodeVM[], pinned: Record<string, { x: number; y: number }>, collapsed: ReadonlySet<string>, seedUri: string): Layout {
  const positions = new Map<string, { x: number; y: number }>();
  const seed = nodes.find((n) => n.side === 'seed');
  let maxDepth = 0;
  let maxGroup = 1;

  const bySideDepth = new Map<string, GraphNodeVM[]>();
  for (const n of nodes) {
    if (n.side === 'seed') continue;
    const side = n.side === 'upstream' ? 'upstream' : 'downstream'; // 'both' renders on the downstream side, distinct badge carries the ambiguity
    const k = `${side}:${n.depth}`;
    const arr = bySideDepth.get(k) ?? [];
    arr.push(n);
    bySideDepth.set(k, arr);
    maxDepth = Math.max(maxDepth, n.depth);
  }

  const centerX = Math.max(maxDepth, 1) * RING + RING_PAD / 2;
  const centerY = 280;
  if (seed) positions.set(seed.uri, pinned[seed.uri] ?? { x: centerX, y: centerY });

  for (const [key, group] of bySideDepth) {
    const [side, depthStr] = key.split(':');
    const depth = Number(depthStr);
    const dir = side === 'downstream' ? 1 : -1;
    const ringKey = `${seedUri}:${side}:${depth}`;
    maxGroup = Math.max(maxGroup, group.length);
    if (collapsed.has(ringKey)) {
      // Collapsed ring: every member of it sits at one stacked point near its ring radius so an
      // edge into/out of it still has somewhere real to land, rather than vanishing.
      const x = centerX + dir * depth * RING;
      for (const n of group) positions.set(n.uri, pinned[n.uri] ?? { x, y: centerY });
      continue;
    }
    const sorted = [...group].sort((a, b) => a.label.localeCompare(b.label));
    const spacing = Math.min(56, Math.max(26, 360 / sorted.length));
    sorted.forEach((n, i) => {
      if (pinned[n.uri]) { positions.set(n.uri, pinned[n.uri]!); return; }
      const y = centerY + (i - (sorted.length - 1) / 2) * spacing;
      const x = centerX + dir * depth * RING;
      positions.set(n.uri, { x, y });
    });
  }

  const width = centerX * 2;
  const height = Math.max(480, maxGroup * 60 + 160);
  return { positions, width, height };
}

// ---------------------------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------------------------

function NodeTypeBadge({ type }: { type: string }) {
  const m = nodeMeta(type);
  return <MonoTag color={m.color} bg="var(--w-06)" size={9}>{m.abbr}</MonoTag>;
}

/** Every rendered edge shows its type and whether it is a current or historical relationship —
 *  never colour alone (locked decision): the word "current"/"historical" and the edge type name
 *  are both plain text. */
function EdgeTypeBadge({ type }: { type: string }) {
  const historical = HISTORICAL_EDGE_TYPES.has(type);
  return (
    <MonoTag color={historical ? 'var(--amber)' : 'var(--text-mid)'} bg={historical ? 'rgba(245,166,35,.12)' : 'var(--w-06)'} size={9}>
      {type}{historical ? ' · historical' : ''}
    </MonoTag>
  );
}

/** `coverage.complete === false` is a distinct, explained state — never rendered as an empty or
 *  complete graph (§20 / locked decision). "This graph cannot answer that yet" and "nothing is
 *  related" are different claims. */
function CoverageNote({ coverage }: { coverage: ApiGraphCoverage }) {
  if (coverage.complete) return null;
  const lines: string[] = [];
  if (coverage.reasons.includes('seed-not-found')) {
    lines.push('No node matches this seed yet — it may not have been indexed or created in the graph.');
  }
  if (coverage.reasons.includes('code-graph-empty')) {
    lines.push('This project has no repository index yet (the common case today). This graph cannot answer that yet — that is not the same claim as "nothing is related".');
  }
  if (coverage.reasons.includes('no-writer-yet')) {
    lines.push(`No relationship of type ${coverage.edgeTypesWithNoWriter?.join(', ') ?? '(unknown)'} has ever been recorded in this project — absence here is not evidence of absence.`);
  }
  if (coverage.reasons.includes('row-limit-reached')) {
    lines.push('Truncated — the server’s result bound was reached; more may exist beyond it. Narrow the edge-type filter or explore from a more specific seed.');
  }
  return (
    <div style={{ margin: '10px 0', padding: '10px 12px', borderRadius: 10, background: 'rgba(245,166,35,.06)', border: '1px solid rgba(245,166,35,.28)' }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--amber)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.05em' }}>
        Incomplete answer
      </div>
      {lines.map((l, i) => (
        <div key={i} style={{ fontSize: 11.5, color: 'var(--text-soft)', lineHeight: 1.5 }}>{l}</div>
      ))}
    </div>
  );
}

function RequestErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div style={{ margin: '10px 0', padding: '10px 12px', borderRadius: 10, background: 'rgba(255,92,92,.06)', border: '1px solid rgba(255,92,92,.3)' }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--red-soft)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.05em' }}>
        Project memory did not answer
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-soft)' }}>{error}</div>
    </div>
  );
}

function EmptyNote({ text }: { text: string }) {
  return <div style={{ padding: '20px 8px', textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>{text}</div>;
}

// ---------------------------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------------------------

export function MemoryGraph({ pid, store }: { pid: string; store: AppStore }) {
  const [prefs, setPrefs] = useState<GraphPrefs>(() => loadPrefs(pid));
  useEffect(() => setPrefs(loadPrefs(pid)), [pid]);
  useEffect(() => savePrefs(pid, prefs), [pid, prefs]);
  const patchPrefs = (patch: Partial<GraphPrefs>) => setPrefs((p) => ({ ...p, ...patch }));

  // Seed selection — no request is ever issued until a human names ONE seed (this is HOW "initial
  // load never attempts a whole-project layout" holds: there is no code path that runs without a
  // seedUri).
  const [seedUri, setSeedUri] = useState('');
  const [seedInput, setSeedInput] = useState('');
  const [taskPick, setTaskPick] = useState('');
  const [seedHistory, setSeedHistory] = useState<string[]>([]);
  const tasks = store.helpers.tasksOf(pid);

  const goToSeed = useCallback((uri: string) => {
    if (!uri.trim()) return;
    setSeedHistory((h) => (seedUri ? [...h, seedUri] : h));
    setSeedUri(uri.trim());
    setSeedInput(uri.trim());
    setTaskPick('');
  }, [seedUri]);

  const goBack = () => {
    setSeedHistory((h) => {
      if (h.length === 0) return h;
      const next = h[h.length - 1]!;
      setSeedUri(next);
      setSeedInput(next);
      return h.slice(0, -1);
    });
  };

  // Selection within the rendered graph (visual or list) — a local detail pane, never a
  // canonical write; "explore from here" is the deliberate action that re-centers the network.
  const [selectedUri, setSelectedUri] = useState<string | null>(null);

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ flex: 'none', padding: '12px 16px', borderBottom: '1px solid var(--line)', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <SectionLabel>Seed</SectionLabel>
        <Select value={taskPick} onChange={(e) => { setTaskPick(e.target.value); if (e.target.value) goToSeed(buildEntityUri({ kind: 'task', id: e.target.value })); }} style={{ maxWidth: 220 }}>
          <option value="">pick a task…</option>
          {tasks.map((t) => <option key={t.id} value={t.id}>{t.key} — {t.title.slice(0, 40)}</option>)}
        </Select>
        <TextInput
          placeholder="or paste an entity URI — e.g. noriq://task/…"
          value={seedInput}
          onChange={(e) => setSeedInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') goToSeed(seedInput); }}
          style={{ flex: '1 1 260px', minWidth: 200 }}
        />
        <Button variant="ghost" onClick={() => goToSeed(seedInput)} disabled={!seedInput.trim()}>Load</Button>
        <Button variant="ghost" onClick={goBack} disabled={seedHistory.length === 0}>← back</Button>
        {seedUri && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-faint)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={seedUri}>
            {seedUri}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <div style={{ display: 'inline-flex', gap: 2, background: 'var(--w-04)', border: '1px solid var(--w-06)', borderRadius: 8, padding: 2 }}>
          {(['neighborhood', 'tests', 'impact'] as const).map((m) => (
            <button
              key={m}
              onClick={() => patchPrefs({ panelMode: m })}
              style={{
                cursor: 'pointer', padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 500,
                background: prefs.panelMode === m ? 'var(--w-1)' : 'transparent',
                color: prefs.panelMode === m ? 'var(--text)' : 'var(--text-mid)',
              }}
            >
              {m === 'neighborhood' ? 'Neighborhood' : m === 'tests' ? 'Validating tests' : 'Change impact'}
            </button>
          ))}
        </div>
      </div>

      {!seedUri && (
        <EmptyNote text="Pick a task or paste an entity URI to explore its neighborhood. Nothing is fetched until you choose one seed — there is no whole-project view here." />
      )}

      {seedUri && prefs.panelMode === 'neighborhood' && (
        <NeighborhoodPanel pid={pid} seedUri={seedUri} prefs={prefs} patchPrefs={patchPrefs} onExplore={goToSeed} selectedUri={selectedUri} setSelectedUri={setSelectedUri} />
      )}
      {seedUri && prefs.panelMode === 'tests' && <TestsPanel pid={pid} seedUri={seedUri} maxDepth={prefs.maxDepth} onExplore={goToSeed} />}
      {seedUri && prefs.panelMode === 'impact' && <ImpactPanel pid={pid} seedUri={seedUri} maxDepth={prefs.maxDepth} onExplore={goToSeed} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Neighborhood panel — the ego-network itself, visual or textual.
// ---------------------------------------------------------------------------------------------

function NeighborhoodPanel({
  pid, seedUri, prefs, patchPrefs, onExplore, selectedUri, setSelectedUri,
}: {
  pid: string; seedUri: string; prefs: GraphPrefs; patchPrefs: (p: Partial<GraphPrefs>) => void;
  onExplore: (uri: string) => void; selectedUri: string | null; setSelectedUri: (uri: string | null) => void;
}) {
  const [data, setData] = useState<ApiDependencyNeighborhood | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    setSelectedUri(null);
    const t = setTimeout(() => {
      api.memoryDependencyNeighborhood(
        pid,
        { entityUri: seedUri, edgeTypes: prefs.edgeTypes.length ? prefs.edgeTypes : undefined, maxDepth: prefs.maxDepth },
        controller.signal,
      )
        .then((r) => { setData(r); setLoading(false); })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return; // cancelled — leave the last good `data` in place
          setError(err instanceof ApiError ? err.message : 'the memory store did not answer');
          setLoading(false);
        });
    }, 200); // debounced so a depth/filter change mid-adjustment doesn't fire a request per tick
    return () => { clearTimeout(t); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, seedUri, prefs.maxDepth, prefs.edgeTypes.join(',')]);

  const cancel = () => { abortRef.current?.abort(); setLoading(false); };

  const graph = useMemo(() => (data ? buildGraph(data) : null), [data]);
  const collapsedSet = useMemo(() => new Set(prefs.collapsedRings), [prefs.collapsedRings]);
  const pinned = prefs.positions[seedUri] ?? {};
  const layout = useMemo(() => (graph ? computeLayout(graph.nodes, pinned, collapsedSet, seedUri) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph, prefs.positions, collapsedSet, seedUri]);

  const setPinned = (uri: string, pos: { x: number; y: number } | null) => {
    patchPrefs({
      positions: {
        ...prefs.positions,
        [seedUri]: pos
          ? { ...(prefs.positions[seedUri] ?? {}), [uri]: pos }
          : Object.fromEntries(Object.entries(prefs.positions[seedUri] ?? {}).filter(([k]) => k !== uri)),
      },
    });
  };
  const resetLayout = () => patchPrefs({ positions: { ...prefs.positions, [seedUri]: {} } });

  const toggleEdgeType = (t: string) => {
    const has = prefs.edgeTypes.includes(t);
    patchPrefs({ edgeTypes: has ? prefs.edgeTypes.filter((x) => x !== t) : [...prefs.edgeTypes, t] });
  };

  const selected = graph?.nodes.find((n) => n.uri === selectedUri) ?? null;
  const selectedEdges = graph && selected ? graph.edges.filter((e) => e.fromNodeId === selected.nodeId || e.toNodeId === selected.nodeId) : [];

  return (
    <div style={{ position: 'absolute', inset: 0, top: 46, display: 'grid', gridTemplateColumns: selected ? '1fr 320px' : '1fr', minHeight: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, borderRight: selected ? '1px solid var(--line)' : 'none' }}>
        <div style={{ flex: 'none', padding: '8px 16px', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', borderBottom: '1px solid var(--line)' }}>
          <div style={{ display: 'inline-flex', gap: 2, background: 'var(--w-04)', border: '1px solid var(--w-06)', borderRadius: 8, padding: 2 }}>
            {(['visual', 'list'] as const).map((m) => (
              <button
                key={m}
                onClick={() => patchPrefs({ viewMode: m })}
                style={{
                  cursor: 'pointer', padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 500,
                  background: prefs.viewMode === m ? 'var(--w-1)' : 'transparent',
                  color: prefs.viewMode === m ? 'var(--text)' : 'var(--text-mid)',
                }}
              >
                {m === 'visual' ? 'Visual' : 'List'}
              </button>
            ))}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>
            depth
            <input
              type="number" min={1} max={MAX_DEPTH_CEILING} value={prefs.maxDepth}
              onChange={(e) => patchPrefs({ maxDepth: Math.min(MAX_DEPTH_CEILING, Math.max(1, Number(e.target.value) || 1)) })}
              style={{ width: 40, background: 'var(--w-04)', border: '1px solid var(--w-1)', borderRadius: 6, color: 'var(--text)', padding: '3px 5px', font: 'inherit' }}
            />
            <span style={{ color: 'var(--text-faint)' }}>max {MAX_DEPTH_CEILING}</span>
          </label>
          <EdgeTypeFilter selected={prefs.edgeTypes} onToggle={toggleEdgeType} onClear={() => patchPrefs({ edgeTypes: [] })} />
          {prefs.viewMode === 'visual' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Button variant="ghost" onClick={() => patchPrefs({ zoom: Math.max(0.4, +(prefs.zoom - 0.15).toFixed(2)) })} style={{ padding: '4px 9px' }}>−</Button>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)', width: 34, textAlign: 'center' }}>{Math.round(prefs.zoom * 100)}%</span>
                <Button variant="ghost" onClick={() => patchPrefs({ zoom: Math.min(2, +(prefs.zoom + 0.15).toFixed(2)) })} style={{ padding: '4px 9px' }}>+</Button>
              </div>
              <Button variant="ghost" onClick={resetLayout}>reset layout</Button>
            </>
          )}
          <div style={{ flex: 1 }} />
          {loading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)' }}>expanding…</span>
              <Button variant="danger" onClick={cancel}>cancel</Button>
            </div>
          )}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 16px' }}>
          <RequestErrorNote error={error} />
          {data && <CoverageNote coverage={data.coverage} />}
          {data && !data.seed && data.coverage.complete && <EmptyNote text="No node matches this seed." />}
          {data && data.seed && graph && graph.nodes.length === 1 && data.coverage.complete && (
            <EmptyNote text={`${data.seed.label} has no recorded relationships of the selected type(s) within depth ${prefs.maxDepth}.`} />
          )}

          {graph && layout && data?.seed && graph.nodes.length > 1 && prefs.viewMode === 'visual' && (
            <NeighborhoodCanvas
              graph={graph} layout={layout} zoom={prefs.zoom} seedUri={seedUri}
              collapsedRings={collapsedSet}
              onToggleRing={(key) => patchPrefs({ collapsedRings: collapsedSet.has(key) ? prefs.collapsedRings.filter((k) => k !== key) : [...prefs.collapsedRings, key] })}
              onSelect={setSelectedUri} selectedUri={selectedUri}
              onDrag={setPinned}
            />
          )}
          {graph && data?.seed && graph.nodes.length > 1 && prefs.viewMode === 'list' && (
            <NeighborhoodList data={data} onSelect={setSelectedUri} selectedUri={selectedUri} onExplore={onExplore} />
          )}
        </div>
      </div>

      {selected && (
        <NodeDetail node={selected} edges={selectedEdges} nodes={graph?.nodes ?? []} onClose={() => setSelectedUri(null)} onExplore={onExplore} />
      )}
    </div>
  );
}

function EdgeTypeFilter({ selected, onToggle, onClear }: { selected: string[]; onToggle: (t: string) => void; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <Button variant="ghost" onClick={() => setOpen((v) => !v)}>
        edge types {selected.length ? `(${selected.length})` : '(all)'}
      </Button>
      {open && (
        <div style={{ position: 'absolute', top: '110%', left: 0, zIndex: 10, background: 'var(--card)', border: '1px solid var(--w-12)', borderRadius: 10, padding: 10, width: 220, maxHeight: 260, overflowY: 'auto', boxShadow: '0 10px 30px rgba(0,0,0,.35)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <SectionLabel>edge types</SectionLabel>
            <button onClick={onClear} style={{ cursor: 'pointer', background: 'transparent', border: 'none', color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 9.5 }}>clear</button>
          </div>
          {MemoryEdgeType.options.map((t) => (
            <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-soft)', padding: '2px 0', cursor: 'pointer' }}>
              <input type="checkbox" checked={selected.includes(t)} onChange={() => onToggle(t)} />
              {t}{HISTORICAL_EDGE_TYPES.has(t) ? ' *' : ''}
            </label>
          ))}
          <div style={{ marginTop: 6, fontSize: 9, color: 'var(--text-faint)' }}>* historical/contested relationship</div>
        </div>
      )}
    </div>
  );
}

// --- visual mode: hand-rolled SVG ego-network -------------------------------------------------

function NeighborhoodCanvas({
  graph, layout, zoom, seedUri, collapsedRings, onToggleRing, onSelect, selectedUri, onDrag,
}: {
  graph: { nodes: GraphNodeVM[]; edges: GraphEdgeVM[] };
  layout: Layout;
  zoom: number;
  seedUri: string;
  collapsedRings: ReadonlySet<string>;
  onToggleRing: (key: string) => void;
  onSelect: (uri: string | null) => void;
  selectedUri: string | null;
  onDrag: (uri: string, pos: { x: number; y: number } | null) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef<{ uri: string; offsetX: number; offsetY: number } | null>(null);
  const [dragPos, setDragPos] = useState<{ uri: string; x: number; y: number } | null>(null);

  const toSvgPoint = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };

  const startDrag = (e: React.MouseEvent, uri: string, pos: { x: number; y: number }) => {
    e.stopPropagation();
    const p = toSvgPoint(e.clientX, e.clientY);
    dragging.current = { uri, offsetX: p.x - pos.x, offsetY: p.y - pos.y };
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const cur = toSvgPoint(ev.clientX, ev.clientY);
      setDragPos({ uri: dragging.current.uri, x: cur.x - dragging.current.offsetX, y: cur.y - dragging.current.offsetY });
    };
    const onUp = (ev: MouseEvent) => {
      if (dragging.current) {
        const cur = toSvgPoint(ev.clientX, ev.clientY);
        onDrag(dragging.current.uri, { x: cur.x - dragging.current.offsetX, y: cur.y - dragging.current.offsetY });
      }
      dragging.current = null;
      setDragPos(null);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const posOf = (uri: string) => (dragPos?.uri === uri ? { x: dragPos.x, y: dragPos.y } : layout.positions.get(uri));

  // Ring headers (one per side/depth) double as the collapse toggle — a real, persisted
  // "collapsed branches" affordance (locked decision), not a stub.
  const ringKeys = useMemo(() => {
    const keys = new Map<string, { side: string; depth: number; count: number }>();
    for (const n of graph.nodes) {
      if (n.side === 'seed') continue;
      const side = n.side === 'upstream' ? 'upstream' : 'downstream';
      const k = `${seedUri}:${side}:${n.depth}`;
      const cur = keys.get(k) ?? { side, depth: n.depth, count: 0 };
      cur.count += 1;
      keys.set(k, cur);
    }
    return keys;
  }, [graph.nodes, seedUri]);

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 0' }}>
        {[...ringKeys.entries()].map(([key, v]) => (
          <button
            key={key}
            onClick={() => onToggleRing(key)}
            className="hover-border"
            style={{
              cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 9.5, padding: '3px 8px', borderRadius: 6,
              background: collapsedRings.has(key) ? 'var(--w-08)' : 'var(--w-03)', border: '1px solid var(--w-1)', color: 'var(--text-mid)',
            }}
          >
            {collapsedRings.has(key) ? '▸' : '▾'} {v.side} · depth {v.depth} ({v.count})
          </button>
        ))}
      </div>
      <div style={{ overflow: 'auto', border: '1px solid var(--w-06)', borderRadius: 10, background: 'var(--w-015)' }}>
        <svg
          ref={svgRef}
          width={layout.width * zoom}
          height={layout.height * zoom}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          onClick={() => onSelect(null)}
        >
          <defs>
            <marker id="mg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--text-dim)" />
            </marker>
          </defs>
          {graph.edges.map((e) => {
            const fromNode = graph.nodes.find((n) => n.nodeId === e.fromNodeId);
            const toNode = graph.nodes.find((n) => n.nodeId === e.toNodeId);
            if (!fromNode || !toNode) return null;
            const a = posOf(fromNode.uri);
            const b = posOf(toNode.uri);
            if (!a || !b) return null;
            const historical = HISTORICAL_EDGE_TYPES.has(e.edgeType);
            const mx = (a.x + b.x) / 2;
            const my = (a.y + b.y) / 2;
            return (
              <g key={e.key}>
                <line
                  x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={historical ? 'var(--amber)' : 'var(--text-dim)'}
                  strokeWidth={1.4}
                  strokeDasharray={historical ? '3 3' : undefined}
                  opacity={0.65}
                  markerEnd="url(#mg-arrow)"
                />
                <rect x={mx - e.edgeType.length * 3 - 3} y={my - 7} width={e.edgeType.length * 6 + 6} height={12} rx={4} fill="var(--bg-raised)" opacity={0.9} />
                <text x={mx} y={my + 3} textAnchor="middle" fontFamily="var(--mono)" fontSize={8.5} fill={historical ? 'var(--amber)' : 'var(--text-dim)'}>
                  {e.edgeType}
                </text>
              </g>
            );
          })}
          {graph.nodes.map((n) => {
            const p = posOf(n.uri);
            if (!p) return null;
            const meta = nodeMeta(n.type);
            const isSeed = n.side === 'seed';
            const isSelected = selectedUri === n.uri;
            return (
              <g
                key={n.uri}
                transform={`translate(${p.x},${p.y})`}
                onMouseDown={(e) => startDrag(e, n.uri, p)}
                onClick={(e) => { e.stopPropagation(); onSelect(n.uri); }}
                style={{ cursor: 'grab' }}
              >
                <circle r={isSeed ? 24 : 18} fill={isSeed ? 'var(--accent)' : 'var(--card)'} stroke={isSelected ? 'var(--text)' : meta.color} strokeWidth={isSelected ? 2.5 : 1.6} />
                <text y={4} textAnchor="middle" fontFamily="var(--mono)" fontSize={8} fontWeight={700} fill={isSeed ? 'var(--bg)' : meta.color}>
                  {meta.abbr}
                </text>
                <text y={isSeed ? 40 : 32} textAnchor="middle" fontFamily="var(--sans)" fontSize={10.5} fill="var(--text-soft)">
                  {n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label}
                </text>
                {n.side === 'both' && (
                  <text y={isSeed ? 52 : 44} textAnchor="middle" fontFamily="var(--mono)" fontSize={8} fill="var(--text-faint)">both directions</text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

// --- textual fallback mode — reachable deliberately, answers the same questions --------------

function NeighborhoodList({ data, onSelect, selectedUri, onExplore }: {
  data: ApiDependencyNeighborhood; onSelect: (uri: string | null) => void; selectedUri: string | null; onExplore: (uri: string) => void;
}) {
  const Row = ({ e }: { e: ApiRelatedEntity }) => (
    <div
      onClick={() => onSelect(e.uri)}
      className="hover-border"
      style={{
        padding: '8px 10px', borderRadius: 9, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4,
        background: selectedUri === e.uri ? 'var(--w-045)' : 'var(--w-02)', border: `1px solid ${selectedUri === e.uri ? 'var(--w-18)' : 'var(--w-07)'}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <NodeTypeBadge type={e.type} />
        <span style={{ fontSize: 12, color: 'var(--text-soft)' }}>{e.label}</span>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>depth {e.depth}</span>
      </div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {e.edgePath.map((hop, i) => <EdgeTypeBadge key={i} type={hop.edgeType} />)}
      </div>
      <button
        onClick={(ev) => { ev.stopPropagation(); onExplore(e.uri); }}
        style={{ cursor: 'pointer', alignSelf: 'flex-start', background: 'transparent', border: 'none', color: 'var(--blue)', fontFamily: 'var(--mono)', fontSize: 9.5, padding: 0 }}
      >
        explore from here →
      </button>
    </div>
  );
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, padding: '10px 0' }}>
      <div>
        <SectionLabel>Downstream · {data.downstream.length} (what this points at)</SectionLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          {data.downstream.length === 0 && <EmptyNote text="none" />}
          {data.downstream.map((e) => <Row key={e.nodeId} e={e} />)}
        </div>
      </div>
      <div>
        <SectionLabel>Upstream · {data.upstream.length} (what points at this)</SectionLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          {data.upstream.length === 0 && <EmptyNote text="none" />}
          {data.upstream.map((e) => <Row key={e.nodeId} e={e} />)}
        </div>
      </div>
    </div>
  );
}

function NodeDetail({ node, edges, nodes, onClose, onExplore }: {
  node: GraphNodeVM; edges: GraphEdgeVM[]; nodes: GraphNodeVM[]; onClose: () => void; onExplore: (uri: string) => void;
}) {
  const labelOf = (nodeId: string) => nodes.find((n) => n.nodeId === nodeId)?.label ?? nodeId.slice(-8);
  return (
    <div style={{ overflowY: 'auto', padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>{node.label}</div>
        <button onClick={onClose} className="drawer-x" style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: 16, width: 24, height: 24, borderRadius: 6 }}>✕</button>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <NodeTypeBadge type={node.type} />
        <MonoTag color="var(--text-mid)" bg="var(--w-05)" size={9}>depth {node.depth}</MonoTag>
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-faint)', wordBreak: 'break-all', marginBottom: 12 }}>{node.uri}</div>
      <Button onClick={() => onExplore(node.uri)} style={{ marginBottom: 14 }}>Explore from here →</Button>
      <SectionLabel>Edges · {edges.length}</SectionLabel>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
        {edges.map((e) => (
          <div key={e.key} style={{ padding: '7px 9px', borderRadius: 8, background: 'var(--w-02)', border: '1px solid var(--w-06)', fontSize: 11 }}>
            <div style={{ marginBottom: 3 }}>
              <span style={{ color: 'var(--text-soft)' }}>{labelOf(e.fromNodeId)}</span>
              <span style={{ color: 'var(--text-faint)' }}> → </span>
              <span style={{ color: 'var(--text-soft)' }}>{labelOf(e.toNodeId)}</span>
            </div>
            <EdgeTypeBadge type={e.edgeType} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Validating-tests panel — a flat list answer, so it is rendered as one (no SVG needed for a
// flat relationship list — the visual mode exists for the multi-hop neighborhood, not this).
// ---------------------------------------------------------------------------------------------

function TestsPanel({ pid, seedUri, maxDepth, onExplore }: { pid: string; seedUri: string; maxDepth: number; onExplore: (uri: string) => void }) {
  const [data, setData] = useState<ApiValidatingTests | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    api.memoryValidatingTests(pid, { entityUri: seedUri, maxDepth }, controller.signal)
      .then((r) => { setData(r); setLoading(false); })
      .catch((err: unknown) => { if (!controller.signal.aborted) { setError(err instanceof ApiError ? err.message : 'the memory store did not answer'); setLoading(false); } });
    return () => controller.abort();
  }, [pid, seedUri, maxDepth]);

  return (
    <div style={{ position: 'absolute', inset: 0, top: 46, overflowY: 'auto', padding: '14px 16px' }}>
      {loading && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)' }}>loading…</span>
          <Button variant="danger" onClick={() => abortRef.current?.abort()}>cancel</Button>
        </div>
      )}
      <RequestErrorNote error={error} />
      {data && <CoverageNote coverage={data.coverage} />}
      {data && !data.seed && data.coverage.complete && <EmptyNote text="No node matches this seed." />}
      {data && data.seed && (
        <>
          <SectionLabel>Tests validating {data.seed.label} · {data.tests.length}</SectionLabel>
          {data.tests.length === 0 && data.coverage.complete && (
            <EmptyNote text={`No test is recorded as validating ${data.seed.label}.`} />
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            {data.tests.map((t) => (
              <div key={t.nodeId} style={{ padding: '8px 10px', borderRadius: 9, background: 'var(--w-02)', border: '1px solid var(--w-07)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <NodeTypeBadge type={t.type} />
                  <span style={{ fontSize: 12, color: 'var(--text-soft)' }}>{t.label}</span>
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 4 }}>
                  {t.edgePath.map((hop, i) => <EdgeTypeBadge key={i} type={hop.edgeType} />)}
                </div>
                <button onClick={() => onExplore(t.uri)} style={{ cursor: 'pointer', background: 'transparent', border: 'none', color: 'var(--blue)', fontFamily: 'var(--mono)', fontSize: 9.5, padding: 0 }}>
                  explore from here →
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Change-impact panel — proposed change set is just the current seed (a single entity); the
// server's `impact` focus accepts more, but the UI-level "select several entities to change"
// workflow is not part of this task's scope and is not implied by any locked decision here.
// ---------------------------------------------------------------------------------------------

function ImpactPanel({ pid, seedUri, maxDepth, onExplore }: { pid: string; seedUri: string; maxDepth: number; onExplore: (uri: string) => void }) {
  const [data, setData] = useState<ApiChangeImpact | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    api.memoryChangeImpact(pid, { entityUris: [seedUri], maxDepth }, controller.signal)
      .then((r) => { setData(r); setLoading(false); })
      .catch((err: unknown) => { if (!controller.signal.aborted) { setError(err instanceof ApiError ? err.message : 'the memory store did not answer'); setLoading(false); } });
    return () => controller.abort();
  }, [pid, seedUri, maxDepth]);

  return (
    <div style={{ position: 'absolute', inset: 0, top: 46, overflowY: 'auto', padding: '14px 16px' }}>
      {loading && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)' }}>loading…</span>
          <Button variant="danger" onClick={() => abortRef.current?.abort()}>cancel</Button>
        </div>
      )}
      <RequestErrorNote error={error} />
      {data && <CoverageNote coverage={data.coverage} />}
      {data && data.uncertainEdges.length > 0 && (
        <div style={{ margin: '8px 0', padding: '8px 10px', borderRadius: 9, background: 'rgba(76,157,255,.06)', border: '1px solid rgba(76,157,255,.25)' }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--blue)', marginBottom: 4 }}>Not yet indexed — not "no impact"</div>
          {data.uncertainEdges.map((u) => (
            <div key={u.entityUri} style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-soft)' }}>{u.entityUri}</div>
          ))}
        </div>
      )}
      {data && (
        <>
          <SectionLabel>Impacted tests · {data.impactedTests.length}</SectionLabel>
          {data.impactedTests.length === 0 && data.coverage.complete && data.resolvedSeeds.length > 0 && (
            <EmptyNote text="No test is recorded as impacted by this change." />
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            {data.impactedTests.map((t) => (
              <div key={t.nodeId} style={{ padding: '8px 10px', borderRadius: 9, background: 'var(--w-02)', border: '1px solid var(--w-07)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <NodeTypeBadge type={t.type} />
                  <span style={{ fontSize: 12, color: 'var(--text-soft)' }}>{t.label}</span>
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 4 }}>
                  {t.edgePath.map((hop, i) => <EdgeTypeBadge key={i} type={hop.edgeType} />)}
                </div>
                <button onClick={() => onExplore(t.uri)} style={{ cursor: 'pointer', background: 'transparent', border: 'none', color: 'var(--blue)', fontFamily: 'var(--mono)', fontSize: 9.5, padding: 0 }}>
                  explore from here →
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Referenced only to keep MemoryNodeType imported for the drift-guard style consistency this
// file's node-type table mirrors — every MemoryNodeType value has an entry above; this line
// fails loudly (not silently) if the shared vocabulary ever widens without this table following.
void (MemoryNodeType.options.some((t) => !(t in NODE_TYPE_META)) &&
  (() => { throw new Error('MemoryGraph.NODE_TYPE_META is missing an entry for a MemoryNodeType value'); })());
