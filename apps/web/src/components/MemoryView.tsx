// Project Memory explorer (PLNR-271, restructured by PLNR-287) — Phase 8's ONE new project view.
// Carries an in-view four-tab strip (view-local state, never a ViewId or a store field, per the
// PLNR-271 locked decision that survives this restructuring): Map (PLNR-285/286's star map — the
// PRIMARY landing surface as of PLNR-287, §5's "searchable constellation"), Explore (this file's
// own tab — the deliberately-reachable textual mode, same answers, same evidence inspector),
// Graph (PLNR-272, MemoryGraph.tsx — the ego-network exploration §5 requires) and Operations
// (PLNR-273, MemoryOps.tsx). Nothing Phase 8 shipped was removed; the map became the front door
// and the other three are each one tab-click away.
//
// The central question this view answers for a human, for ONE memory: why does it exist, what
// supports it, is that evidence currently verified, and what replaced or contradicts it. Every
// number/label displayed here (authority, validity, isLead, verificationState) is read straight
// from the API — this file never re-derives `classifyLead` or `verifiedForBase` itself.
import { parseEntityUri } from '@noriq-dev/shared';
import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type ApiConstellationNode, type ApiGraphEntityPage, type ApiGraphEntitySort,
  type ApiMemoryFeedbackKind, type ApiMemoryHistory, type ApiMemoryHit, type ApiMemoryItem, type ApiMemoryRepository,
} from '../api';
import type { AppStore } from '../store';
import { MonoTag, SectionLabel } from './bits';
import { MemoryGraph } from './MemoryGraph';
import { MemoryOps } from './MemoryOps';
import { MemoryStarMap } from './MemoryStarMap';
import { Button, Select, TextArea, TextInput } from './ui';

type MemorySubTab = 'map' | 'explore' | 'graph' | 'operations';

const SUB_TABS: Array<{ id: MemorySubTab; label: string }> = [
  { id: 'map', label: 'Map' },
  { id: 'explore', label: 'Explore' },
  { id: 'graph', label: 'Graph' },
  { id: 'operations', label: 'Operations' },
];

// The kind vocabulary record_memory's CHECK constraint accepts (memory-migrations/0001) — a
// filter value, never re-derived logic. 'episode' is a separate entityType, not a memory kind,
// so it is deliberately absent here (the server's `kind` filter never matches an episode hit).
const MEMORY_KINDS = ['learning', 'decision', 'failed_approach', 'procedure', 'requirement', 'hazard', 'unknown'] as const;

// §12's own five-level scale, display text only — mirrors evidence-frame.ts's AUTHORITY_LABELS
// (server-side, for agent prompts). The NUMBER is what every filter/sort/gate uses; this object
// exists purely so a human sees the same words an agent's evidence frame already carries.
const AUTHORITY_LABELS: Record<number, string> = {
  5: 'human-approved decision',
  4: 'verified against merged code/tests',
  3: 'repeated successful observation',
  2: 'single-agent observation',
  1: 'hypothesis / unverified inference',
};

const FEEDBACK_KINDS: Array<{ id: ApiMemoryFeedbackKind; label: string }> = [
  { id: 'useful', label: '👍 useful' },
  { id: 'incorrect', label: '✕ incorrect' },
  { id: 'outdated', label: '⏱ outdated' },
  { id: 'harmful', label: '⚠ harmful' },
  { id: 'unverifiable', label: '? unverifiable' },
];

const shortId = (id: string) => id.slice(-8);

export function MemoryView({ store }: { store: AppStore }) {
  // Map is the landing surface (PLNR-287): the searchable whole-project constellation, §5's
  // secondary-but-primary-entry-point view. Explore/Graph/Operations are each one tab-click away —
  // nothing Phase 8 shipped lost a hop.
  const [tab, setTab] = useState<MemorySubTab>('map');

  // Pivot targets: a star's URI, carried across the tab switch as a fresh-mount initializer
  // (mirroring how `?task=` seeds MemoryGraph's own picker) rather than a controlled prop, so
  // MemoryStarMap's prop surface stays exactly `{ pid, onOpenEgoNetwork?, onOpenInspector? }`
  // (locked decision) — this file supplies the callbacks, it does not reach into the map.
  const [graphSeedUri, setGraphSeedUri] = useState<string | null>(null);
  const [inspectorUri, setInspectorUri] = useState<string | null>(null);

  useEffect(() => {
    const memoryId = sessionStorage.getItem('noriq.openMemory');
    if (!memoryId) return;
    sessionStorage.removeItem('noriq.openMemory');
    setInspectorUri(`noriq://memory/${memoryId}`);
    setTab('explore');
  }, [store.currentPid]);

  const openEgoNetwork = (uri: string) => { setGraphSeedUri(uri); setTab('graph'); };
  const openInspector = (uri: string) => { setInspectorUri(uri); setTab('explore'); };

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ flex: 'none', padding: '12px 20px 0', borderBottom: '1px solid var(--line)' }}>
        <div style={{ display: 'inline-flex', gap: 2, background: 'var(--w-04)', border: '1px solid var(--w-06)', borderRadius: 9, padding: 3, marginBottom: 10 }}>
          {SUB_TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                cursor: 'pointer', padding: '5px 14px', borderRadius: 6, fontSize: 12.5, fontWeight: 500,
                background: tab === t.id ? 'var(--w-1)' : 'transparent',
                color: tab === t.id ? 'var(--text)' : 'var(--text-mid)',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {tab === 'map' && <MemoryStarMap pid={store.currentPid} onOpenEgoNetwork={openEgoNetwork} onOpenInspector={openInspector} />}
        {tab === 'explore' && <ExploreTab pid={store.currentPid} store={store} initialSelectionUri={inspectorUri} onOpenEgoNetwork={openEgoNetwork} />}
        {tab === 'graph' && <MemoryGraph pid={store.currentPid} store={store} initialSeedUri={graphSeedUri} />}
        {tab === 'operations' && <MemoryOps pid={store.currentPid} store={store} />}
      </div>
    </div>
  );
}

/** The star map hands off by stable entity URI only (locked decision); this is the one place
 *  that URI is resolved back into the `Selection` the Explore tab's evidence Inspector already
 *  understands. `onOpenInspector` is only ever invoked by MemoryStarMap for a `memory`-kind star
 *  or search hit (see MemoryStarMap.tsx's own gating), so the non-memory arm here is defensive,
 *  not a real path — a malformed or foreign-kind URI opens Explore with nothing pre-selected
 *  rather than guessing. The placeholder text/snippet fields are never read: Inspector's fetch
 *  effect only branches on `hit.entityType`/`hit.id` for a memory hit; title/snippet only matter
 *  for the episode/node arm, which this path never takes. */
function selectionFromUri(uri: string): Selection | null {
  let ref;
  try { ref = parseEntityUri(uri); } catch { return null; }
  if (ref.kind !== 'memory') return null;
  return {
    hit: {
      entityType: 'memory', id: ref.id, uri, title: '', snippet: '',
      stage: 'exact', score: 1, isLead: false, leadReasons: [], finalScore: 1,
    },
  };
}

function hitFromEntity(item: ApiConstellationNode): ApiMemoryHit {
  let id = item.nodeId;
  try {
    const ref = parseEntityUri(item.uri);
    if ('id' in ref) id = ref.id;
  } catch { /* keep the stable graph id */ }
  return {
    entityType: item.type === 'memory' ? 'memory' : item.type === 'episode' ? 'episode' : 'node',
    id,
    uri: item.uri,
    kind: item.kind ?? item.type,
    title: item.label,
    snippet: item.label,
    stage: 'exact',
    score: 1,
    authority: item.authority ?? undefined,
    validity: item.validity ?? undefined,
    isLead: item.isLead ?? false,
    leadReasons: item.leadReasons ?? [],
    finalScore: 1,
  };
}

function UnreachableBanner({ detail }: { detail?: string }) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div
        style={{
          maxWidth: 420, textAlign: 'center', padding: '18px 22px', borderRadius: 12,
          background: 'rgba(255,92,92,.06)', border: '1px solid rgba(255,92,92,.3)',
        }}
      >
        <div style={{ fontSize: 20, marginBottom: 8 }}>⚠</div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--red-soft)', marginBottom: 6 }}>Project memory is unreachable</div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          The memory store did not answer. This is NOT "no memories exist" — retry once the store
          is back, rather than reading an empty explorer as settled fact.
          {detail && <div style={{ marginTop: 8, color: 'var(--text-faint)' }}>{detail}</div>}
        </div>
      </div>
    </div>
  );
}

function authorityLabel(authority?: number): string {
  if (authority == null) return '';
  return AUTHORITY_LABELS[authority] ?? `authority ${authority}`;
}

/** Lead vs. approved-decision — never colour-only (locked decision): the word itself
 *  ("LEAD"/"SETTLED") and a distinct glyph carry the same information as the colour. */
function LeadBadge({ isLead, leadReasons }: { isLead: boolean; leadReasons: string[] }) {
  if (isLead) {
    return (
      <MonoTag color="var(--amber)" bg="rgba(245,166,35,.14)" size={9.5}>
        <span title={leadReasons.length ? leadReasons.join(', ') : 'lead'}>◐ LEAD</span>
      </MonoTag>
    );
  }
  return <MonoTag color="var(--green)" bg="rgba(63,217,139,.12)" size={9.5}>● SETTLED</MonoTag>;
}

function AuthorityBadge({ authority }: { authority?: number }) {
  if (authority == null) return null;
  const color = authority >= 5 ? 'var(--green)' : authority >= 3 ? 'var(--blue)' : 'var(--amber)';
  const bg = authority >= 5 ? 'rgba(63,217,139,.12)' : authority >= 3 ? 'rgba(76,157,255,.12)' : 'rgba(245,166,35,.12)';
  return (
    <MonoTag color={color} bg={bg} size={9.5}>
      <span title={authorityLabel(authority)}>authority {authority}/5</span>
    </MonoTag>
  );
}

function ValidityBadge({ validity }: { validity?: string }) {
  if (!validity) return null;
  const meta: Record<string, { icon: string; color: string; bg: string }> = {
    active: { icon: '●', color: 'var(--green)', bg: 'rgba(63,217,139,.12)' },
    stale: { icon: '◐', color: 'var(--amber)', bg: 'rgba(245,166,35,.12)' },
    invalid: { icon: '✕', color: 'var(--red-soft)', bg: 'rgba(255,92,92,.12)' },
  };
  const m = meta[validity] ?? { icon: '?', color: 'var(--text-mid)', bg: 'var(--w-05)' };
  return <MonoTag color={m.color} bg={m.bg} size={9.5}>{m.icon} {validity}</MonoTag>;
}

function VerificationBadge({ state }: { state: string }) {
  const meta: Record<string, { icon: string; color: string; bg: string }> = {
    valid: { icon: '✓', color: 'var(--green)', bg: 'rgba(63,217,139,.12)' },
    moved: { icon: '↝', color: 'var(--blue)', bg: 'rgba(76,157,255,.12)' },
    changed: { icon: 'Δ', color: 'var(--amber)', bg: 'rgba(245,166,35,.12)' },
    missing: { icon: '✕', color: 'var(--red-soft)', bg: 'rgba(255,92,92,.12)' },
    unverifiable: { icon: '?', color: 'var(--text-mid)', bg: 'var(--w-05)' },
  };
  const m = meta[state] ?? meta.unverifiable!;
  return <MonoTag color={m.color} bg={m.bg} size={9}>{m.icon} {state}</MonoTag>;
}

// ---------------------------------------------------------------------------------------------
// Explore tab
// ---------------------------------------------------------------------------------------------

interface Selection { hit: ApiMemoryHit }

function ExploreTab({ pid, store, initialSelectionUri, onOpenEgoNetwork }: {
  pid: string; store: AppStore; initialSelectionUri?: string | null; onOpenEgoNetwork: (uri: string) => void;
}) {
  const [reachable, setReachable] = useState<boolean | null>(null); // null = still probing
  const [reachError, setReachError] = useState<string | undefined>(undefined);
  const [repositories, setRepositories] = useState<ApiMemoryRepository[]>([]);

  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [minAuthority, setMinAuthority] = useState('');
  const [validity, setValidity] = useState('');
  const [repositoryKey, setRepositoryKey] = useState('');
  const [branch, setBranch] = useState('');
  const [taskId, setTaskId] = useState('');
  const [showMore, setShowMore] = useState(false);
  const [browseType, setBrowseType] = useState('memory');
  const [browseSort, setBrowseSort] = useState<ApiGraphEntitySort>('newest');
  const [browseCursor, setBrowseCursor] = useState<string | null>(null);
  const [browseBack, setBrowseBack] = useState<Array<string | null>>([]);
  const [browsePage, setBrowsePage] = useState<ApiGraphEntityPage | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseFailed, setBrowseFailed] = useState(false);

  const [mode, setMode] = useState<'semantic' | 'keyword' | null>(null);
  const [results, setResults] = useState<ApiMemoryHit[] | null>(null); // null = nothing searched yet
  const [searchFailed, setSearchFailed] = useState(false);
  // A pivot from the star map (PLNR-287) arrives as a one-shot mount-time initializer, matching
  // MemoryGraph's `initialSeedUri` precedent — the Explore tab remounts fresh every time it's
  // switched to (MemoryView conditionally renders it), so this only ever resolves once per pivot.
  const [selected, setSelected] = useState<Selection | null>(() => (initialSelectionUri ? selectionFromUri(initialSelectionUri) : null));

  const tasks = store.helpers.tasksOf(pid);

  // Reachability probe (acceptance: an unreachable store must SAY so, never render as an empty
  // list). Repositories are fetched alongside purely to populate the filter's dropdown.
  useEffect(() => {
    let cancelled = false;
    setReachable(null);
    setReachError(undefined);
    api.memoryHealth(pid)
      .then(() => { if (!cancelled) setReachable(true); })
      .catch((err) => { if (!cancelled) { setReachable(false); setReachError(err instanceof Error ? err.message : undefined); } });
    api.memoryRepositories(pid).then((r) => { if (!cancelled) setRepositories(r.repositories); }).catch(() => {});
    return () => { cancelled = true; };
  }, [pid]);

  // Retrieval here is search/seed-first (matching the server's own design — filters NARROW
  // candidates a query or a task-graph-seed already produced, they don't browse a bare table),
  // so an empty query with no task selected intentionally issues no request.
  const hasSeed = query.trim().length > 0 || taskId.length > 0;

  useEffect(() => {
    setBrowseCursor(null);
    setBrowseBack([]);
    setBrowsePage(null);
  }, [pid, browseType, browseSort, kind, minAuthority, validity]);

  useEffect(() => {
    if (reachable !== true || hasSeed) return;
    const controller = new AbortController();
    setBrowseLoading(true);
    setBrowseFailed(false);
    api.memoryEntities(pid, {
      cursor: browseCursor ?? undefined,
      limit: 50,
      sort: browseSort,
      type: browseType || undefined,
      kind: kind || undefined,
      minAuthority: minAuthority ? Number(minAuthority) : undefined,
      validity: validity || undefined,
    }, controller.signal)
      .then((page) => { setBrowsePage(page); setBrowseLoading(false); })
      .catch(() => { if (!controller.signal.aborted) { setBrowseFailed(true); setBrowseLoading(false); } });
    return () => controller.abort();
  }, [pid, reachable, hasSeed, browseCursor, browseType, browseSort, kind, minAuthority, validity]);

  useEffect(() => {
    if (reachable !== true || !hasSeed) { setResults(null); setMode(null); setSearchFailed(false); return; }
    const t = setTimeout(() => {
      api.memorySearch(pid, {
        query: query.trim() || undefined,
        taskId: taskId || undefined,
        kind: kind || undefined,
        minAuthority: minAuthority ? Number(minAuthority) : undefined,
        validity: validity || undefined,
        repositoryKey: repositoryKey || undefined,
        branch: branch || undefined,
        limit: 40,
      })
        .then((r) => { setResults(r.results); setMode(r.mode); setSearchFailed(false); })
        .catch(() => { setResults(null); setSearchFailed(true); });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, reachable, hasSeed, query, kind, minAuthority, validity, repositoryKey, branch, taskId]);

  if (reachable === false) return <UnreachableBanner detail={reachError} />;

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'grid', gridTemplateColumns: selected ? '380px 1fr' : '1fr', minHeight: 0 }}>
      <div style={{ borderRight: selected ? '1px solid var(--line)' : 'none', overflowY: 'auto', padding: '14px 16px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          <TextInput
            placeholder="search memory by meaning — “how do we handle X”"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            <Select value={kind} onChange={(e) => setKind(e.target.value)} title="kind (memory items only)">
              <option value="">any kind</option>
              {MEMORY_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </Select>
            <Select value={minAuthority} onChange={(e) => setMinAuthority(e.target.value)} title="minimum authority">
              <option value="">any authority</option>
              {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>min {n}/5</option>)}
            </Select>
            <Select value={validity} onChange={(e) => setValidity(e.target.value)}>
              <option value="">any validity</option>
              <option value="active">active</option>
              <option value="stale">stale</option>
              <option value="invalid">invalid</option>
            </Select>
          </div>
          <button
            onClick={() => setShowMore((v) => !v)}
            style={{ cursor: 'pointer', alignSelf: 'flex-start', background: 'transparent', border: 'none', color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 10.5 }}
          >
            {showMore ? '▾ fewer filters' : '▸ repository / branch / task'}
          </button>
          {showMore && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Select value={repositoryKey} onChange={(e) => setRepositoryKey(e.target.value)}>
                <option value="">any repository</option>
                {repositories.map((r) => <option key={r.id} value={r.repositoryKey}>{r.repositoryKey}</option>)}
              </Select>
              <TextInput placeholder="branch (exact match)" value={branch} onChange={(e) => setBranch(e.target.value)} />
              <Select value={taskId} onChange={(e) => setTaskId(e.target.value)} title="expand the graph from this task">
                <option value="">no task focus</option>
                {tasks.map((t) => <option key={t.id} value={t.id}>{t.key} — {t.title.slice(0, 40)}</option>)}
              </Select>
            </div>
          )}
        </div>

        {!hasSeed && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
              <Select value={browseType} onChange={(e) => setBrowseType(e.target.value)} aria-label="entity type">
                <option value="memory">memories</option>
                <option value="">all entities</option>
                {Object.keys(browsePage?.byType ?? {}).filter((type) => type !== 'memory').sort().map((type) => (
                  <option key={type} value={type}>{type} · {browsePage!.byType[type]}</option>
                ))}
              </Select>
              <Select value={browseSort} onChange={(e) => setBrowseSort(e.target.value as ApiGraphEntitySort)} aria-label="browse ordering">
                <option value="newest">newest first</option>
                <option value="connected">most connected</option>
                <option value="authority">highest authority</option>
                <option value="label">label A–Z</option>
              </Select>
            </div>
            {browseFailed && (
              <div style={{ padding: 20, textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--red-soft)' }}>
                The ordered catalogue could not be loaded. Search remains available.
              </div>
            )}
            {!browseFailed && browseLoading && !browsePage && (
              <div style={{ padding: 20, textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>Loading ordered catalogue…</div>
            )}
            {!browseFailed && browsePage && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <SectionLabel>{browsePage.total} {browseType || 'eligible'} entit{browsePage.total === 1 ? 'y' : 'ies'}</SectionLabel>
                  <MonoTag color="var(--text-dim)" bg="var(--w-04)" size={8.5}>{browsePage.sort}</MonoTag>
                  {browseLoading && <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>refreshing…</span>}
                </div>
                {browsePage.items.length === 0 && (
                  <div style={{ padding: 20, textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>nothing matches these browse filters</div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {browsePage.items.map((item) => {
                    const hit = hitFromEntity(item);
                    return <ResultRow
                      key={item.nodeId}
                      hit={hit}
                      selected={selected?.hit.uri === item.uri}
                      onClick={() => item.type === 'memory' ? setSelected({ hit }) : onOpenEgoNetwork(item.uri)}
                    />;
                  })}
                </div>
                {(browseBack.length > 0 || browsePage.nextCursor) && (
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 12 }}>
                    <Button variant="ghost" disabled={browseBack.length === 0} onClick={() => {
                      const previous = browseBack.at(-1) ?? null;
                      setBrowseBack((stack) => stack.slice(0, -1));
                      setBrowseCursor(previous);
                    }}>← previous</Button>
                    <Button variant="ghost" disabled={!browsePage.nextCursor} onClick={() => {
                      setBrowseBack((stack) => [...stack, browseCursor]);
                      setBrowseCursor(browsePage.nextCursor);
                    }}>next →</Button>
                  </div>
                )}
              </>
            )}
          </>
        )}
        {hasSeed && searchFailed && <UnreachableBanner />}
        {hasSeed && !searchFailed && results != null && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <SectionLabel>{results.length} result{results.length === 1 ? '' : 's'}</SectionLabel>
              {mode && <MonoTag color="var(--text-dim)" bg="var(--w-04)" size={8.5}>{mode}</MonoTag>}
            </div>
            {results.length === 0 && (
              <div style={{ padding: 20, textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>
                nothing matched these filters
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {results.map((hit) => (
                <ResultRow key={`${hit.entityType}:${hit.id}`} hit={hit} selected={selected?.hit.id === hit.id} onClick={() => setSelected({ hit })} />
              ))}
            </div>
          </>
        )}
      </div>
      {selected && (
        <Inspector
          pid={pid}
          hit={selected.hit}
          onClose={() => setSelected(null)}
          onJump={(id) => setSelected({ hit: { ...selected.hit, id, entityType: 'memory' } })}
        />
      )}
    </div>
  );
}

function ResultRow({ hit, selected, onClick }: { hit: ApiMemoryHit; selected: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      className="hover-border"
      style={{
        padding: '9px 12px', borderRadius: 10, cursor: 'pointer',
        background: selected ? 'var(--w-045)' : 'var(--w-02)',
        border: `1px solid ${selected ? 'var(--w-18)' : 'var(--w-07)'}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5, flexWrap: 'wrap' }}>
        <MonoTag color="var(--text-mid)" bg="var(--w-05)" size={9}>{hit.entityType === 'memory' ? (hit.kind ?? 'memory') : hit.entityType}</MonoTag>
        {hit.entityType === 'memory' && <LeadBadge isLead={hit.isLead} leadReasons={hit.leadReasons} />}
        {hit.authority != null && <AuthorityBadge authority={hit.authority} />}
        {hit.validity && <ValidityBadge validity={hit.validity} />}
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)' }}>{hit.stage}</span>
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-soft)', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
        {hit.snippet || hit.title}
      </div>
      {hit.entityType === 'node' && hit.edgePath && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)', marginTop: 4 }}>via {hit.edgePath}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Inspector — the evidence-inspector half of this task. Everything here is fetched ONLY once a
// memory is opened (acceptance: large evidence bodies are lazy-loaded, never prefetched with the
// list). Episode/graph-node hits carry no dedicated detail route yet — they render what the
// search hit itself already carried rather than guessing at a shape no route returns.
// ---------------------------------------------------------------------------------------------

function Inspector({ pid, hit, onClose, onJump }: { pid: string; hit: ApiMemoryHit; onClose: () => void; onJump: (id: string) => void }) {
  const [item, setItem] = useState<ApiMemoryItem | null>(null);
  const [frameText, setFrameText] = useState<string | null>(null);
  const [suspicious, setSuspicious] = useState(false);
  const [history, setHistory] = useState<ApiMemoryHistory | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (hit.entityType !== 'memory') { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    setItem(null);
    setFrameText(null);
    setHistory(null);
    Promise.all([
      api.memoryItem(pid, hit.id),
      // A single-item request: `memoryItemId` alone yields ONE ranked hit, so the returned
      // evidenceFrame is scoped to exactly this memory's statement — the same server-rendered,
      // suspicious-labelled quoted block search results carry, never re-rendered here.
      api.memorySearch(pid, { memoryItemId: hit.id }),
      api.memoryHistory(pid, hit.id),
    ])
      .then(([itemRes, searchRes, historyRes]) => {
        if (cancelled) return;
        setItem(itemRes);
        setFrameText(searchRes.evidenceFrame.text || null);
        setSuspicious(searchRes.evidenceFrame.suspiciousCount > 0);
        setHistory(historyRes);
      })
      .catch(() => { if (!cancelled) setLoadFailed(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [pid, hit.id, hit.entityType]);

  if (hit.entityType !== 'memory') {
    return (
      <div style={{ overflowY: 'auto', padding: '16px 20px' }}>
        <InspectorHeader onClose={onClose} title={hit.entityType === 'episode' ? 'episode' : hit.kind ?? 'graph node'} />
        <div style={{ fontSize: 13, marginBottom: 10 }}>{hit.title}</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-soft)', lineHeight: 1.6, marginBottom: 10 }}>{hit.snippet}</div>
        {hit.entityType === 'episode' && hit.status && (
          <MonoTag color="var(--text-mid)" bg="var(--w-05)" size={9.5}>landing: {hit.status}</MonoTag>
        )}
        {hit.entityType === 'node' && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)', lineHeight: 1.8 }}>
            {hit.uri && <div>uri: {hit.uri}</div>}
            {hit.edgePath && <div>path: {hit.edgePath}</div>}
            {hit.depth != null && <div>depth: {hit.depth}</div>}
          </div>
        )}
        <div style={{ marginTop: 14, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>
          No detail route exists yet for a {hit.entityType} beyond what the search hit itself carries.
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ overflowY: 'auto', padding: '16px 20px' }}>
        <InspectorHeader onClose={onClose} title="loading…" />
      </div>
    );
  }
  if (loadFailed || !item) return <div style={{ position: 'relative' }}><UnreachableBanner /></div>;

  const myVersion = history?.versions.find((v) => v.id === item.id) ?? null;

  return (
    <div style={{ overflowY: 'auto', padding: '16px 20px' }}>
      <InspectorHeader onClose={onClose} title={item.kind} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        <AuthorityBadge authority={item.authority} />
        <ValidityBadge validity={item.validity} />
        {item.proposedAt && <MonoTag color="var(--amber)" bg="rgba(245,166,35,.12)" size={9.5}>⏳ awaiting approval</MonoTag>}
        {item.rejectedAt && <MonoTag color="var(--red-soft)" bg="rgba(255,92,92,.12)" size={9.5}>✕ rejected</MonoTag>}
        {myVersion?.supersededByMemoryId && <MonoTag color="var(--text-mid)" bg="var(--w-05)" size={9.5}>superseded</MonoTag>}
      </div>

      {myVersion?.supersededByMemoryId && (
        <div style={{ marginBottom: 12, padding: '8px 10px', borderRadius: 8, background: 'var(--w-03)', border: '1px solid var(--w-08)', fontSize: 11.5 }}>
          Replaced by a newer version.{' '}
          <button onClick={() => onJump(myVersion.supersededByMemoryId!)} className="hover-bright" style={{ cursor: 'pointer', background: 'transparent', border: 'none', color: 'var(--blue)', padding: 0, font: 'inherit', textDecoration: 'underline' }}>
            View {shortId(myVersion.supersededByMemoryId)} →
          </button>
        </div>
      )}

      <div style={{ marginBottom: 6 }}><SectionLabel>Statement (quoted evidence)</SectionLabel></div>
      <EvidenceFrameBlock text={frameText} suspicious={suspicious} />

      {item.evidence.length > 0 && (
        <>
          <div style={{ margin: '16px 0 8px' }}><SectionLabel>Evidence · {item.evidence.length}</SectionLabel></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 4 }}>
            {item.evidence.map((e) => (
              <div key={e.id} style={{ padding: '8px 10px', borderRadius: 8, background: 'var(--w-02)', border: '1px solid var(--w-06)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
                  <VerificationBadge state={e.verificationState} />
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-soft)' }}>{e.repositoryKey}@{e.branch}</span>
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)', wordBreak: 'break-all' }}>
                  {e.path}{e.symbol ? ` :: ${e.symbol}` : ''}
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)', marginTop: 3 }}>
                  base {e.baseId.slice(0, 12)}
                  {e.lastVerifiedAt ? ` · checked ${new Date(e.lastVerifiedAt).toLocaleString()} (${e.verificationSource ?? 'unknown source'})` : ' · never checked'}
                  {e.observedPath ? ` · now at ${e.observedPath}` : ''}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {history && <HistorySection history={history} currentId={item.id} onJump={onJump} />}

      {item.kind === 'decision' && item.proposedAt && !item.rejectedAt && (
        <DecisionGovernance pid={pid} item={item} />
      )}

      <FeedbackPanel pid={pid} memoryItemId={item.id} feedback={history?.feedback ?? []} />

      <CorrectionPanel pid={pid} item={item} onRecorded={() => onJump(item.id)} />
    </div>
  );
}

function InspectorHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
      <div style={{ flex: 1 }} />
      <button onClick={onClose} className="drawer-x" style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: 16, width: 26, height: 26, borderRadius: 6 }}>✕</button>
    </div>
  );
}

/** Renders EXACTLY what the server produced — never re-rendered, restyled, or parsed for a
 *  "suspicious" flag client-side (§13/locked decision: the server marks suspicion, this view
 *  only displays that it did). A wide, monospace, bounded box makes it unmistakably a QUOTE, not
 *  prose belonging to this page. */
function EvidenceFrameBlock({ text, suspicious }: { text: string | null; suspicious: boolean }) {
  if (!text) return <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-faint)' }}>no statement text returned</div>;
  return (
    <div
      style={{
        border: `1px solid ${suspicious ? 'rgba(255,92,92,.4)' : 'var(--w-1)'}`,
        borderRadius: 10,
        background: suspicious ? 'rgba(255,92,92,.05)' : 'var(--w-02)',
        padding: '10px 12px',
        maxHeight: 340,
        overflow: 'auto',
      }}
    >
      {suspicious && (
        <div style={{ marginBottom: 8 }}>
          <MonoTag color="var(--red-soft)" bg="rgba(255,92,92,.14)" size={9.5}>⚠ SUSPICIOUS — see reason quoted below</MonoTag>
        </div>
      )}
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--mono)', fontSize: 10.5, lineHeight: 1.6, color: 'var(--text-soft)' }}>
        {text}
      </pre>
    </div>
  );
}

function HistorySection({ history, currentId, onJump }: { history: ApiMemoryHistory; currentId: string; onJump: (id: string) => void }) {
  const sortedVersions = useMemo(() => [...history.versions].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)), [history.versions]);
  return (
    <>
      {sortedVersions.length > 1 && (
        <>
          <div style={{ margin: '16px 0 8px' }}><SectionLabel>Version history · {sortedVersions.length}</SectionLabel></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 4 }}>
            {sortedVersions.map((v) => (
              <button
                key={v.id}
                onClick={() => onJump(v.id)}
                className="hover-border"
                style={{
                  cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8,
                  padding: '7px 10px', borderRadius: 8, background: v.id === currentId ? 'var(--w-045)' : 'var(--w-02)',
                  border: `1px solid ${v.id === currentId ? 'var(--w-18)' : 'var(--w-06)'}`, color: 'inherit', font: 'inherit',
                }}
              >
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-faint)' }}>{shortId(v.id)}</span>
                <AuthorityBadge authority={v.authority} />
                <ValidityBadge validity={v.validity} />
                {v.rejectedAt && <MonoTag color="var(--red-soft)" bg="rgba(255,92,92,.12)" size={8.5}>rejected</MonoTag>}
                <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>{new Date(v.recordedAt).toLocaleDateString()}</span>
                {v.id === currentId && <MonoTag color="var(--text-mid)" bg="var(--w-06)" size={8.5}>viewing</MonoTag>}
              </button>
            ))}
          </div>
        </>
      )}
      {history.transitions.length > 0 && (
        <>
          <div style={{ margin: '16px 0 8px' }}><SectionLabel>Authority transitions</SectionLabel></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 4 }}>
            {history.transitions.map((t) => (
              <div key={t.id} style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-mid)' }}>
                {new Date(t.createdAt).toLocaleDateString()} · {t.outcome}{t.newAuthority ? ` → authority ${t.newAuthority}` : ''}
                {t.note ? ` — "${t.note}"` : ''}
              </div>
            ))}
          </div>
        </>
      )}
      {history.contradictions.length > 0 && (
        <>
          <div style={{ margin: '16px 0 8px' }}><SectionLabel>Contradictions</SectionLabel></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 4 }}>
            {history.contradictions.map((set) => (
              <div key={set.setId} style={{ padding: '7px 10px', borderRadius: 8, background: 'rgba(255,92,92,.05)', border: '1px solid rgba(255,92,92,.2)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <MonoTag color="var(--red-soft)" bg="rgba(255,92,92,.14)" size={9}>{set.resolvedAt ? 'resolved' : 'unresolved'}</MonoTag>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {set.memoryItemIds.filter((id) => id !== currentId).map((id) => (
                    <button key={id} onClick={() => onJump(id)} className="hover-bright" style={{ cursor: 'pointer', background: 'transparent', border: 'none', color: 'var(--blue)', padding: 0, font: 'inherit', fontFamily: 'var(--mono)', fontSize: 10.5, textDecoration: 'underline' }}>
                      {shortId(id)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** Authority 5 is reachable ONLY through this path (§12) — the server's approveDecision RPC,
 *  never a value this UI supplies. */
function DecisionGovernance({ pid, item }: { pid: string; item: ApiMemoryItem }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'approved' | 'rejected' | null>(null);

  const act = async (fn: () => Promise<unknown>, outcome: 'approved' | 'rejected') => {
    setBusy(true);
    try { await fn(); setDone(outcome); } finally { setBusy(false); }
  };

  if (done) {
    return (
      <div style={{ margin: '16px 0', padding: '10px 12px', borderRadius: 8, background: 'var(--w-03)', fontSize: 11.5, color: 'var(--text-mid)' }}>
        Recorded: {done}. Reload the search to see the outcome reflected.
      </div>
    );
  }

  return (
    <div style={{ margin: '16px 0', padding: '10px 12px', borderRadius: 10, background: 'rgba(76,157,255,.06)', border: '1px solid rgba(76,157,255,.25)' }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--blue)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '.05em' }}>
        Proposed decision — awaiting your approval
      </div>
      <TextInput placeholder="optional note" value={note} onChange={(e) => setNote(e.target.value)} style={{ marginBottom: 8 }} />
      <div style={{ display: 'flex', gap: 8 }}>
        <Button disabled={busy} onClick={() => void act(() => api.memoryApproveDecision(pid, item.id, note || undefined), 'approved')}>Approve</Button>
        <Button variant="danger" disabled={busy} onClick={() => void act(() => api.memoryRejectDecision(pid, item.id, note || undefined), 'rejected')}>Reject</Button>
      </div>
    </div>
  );
}

/** §11: feedback is an operation on the memory surface, never an edit — it never touches the
 *  target's statement, evidence, or authority. */
function FeedbackPanel({ pid, memoryItemId, feedback }: { pid: string; memoryItemId: string; feedback: ApiMemoryHistory['feedback'] }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<ApiMemoryFeedbackKind | null>(null);

  const submit = async (kind: ApiMemoryFeedbackKind) => {
    setBusy(true);
    try {
      await api.memoryFeedback(pid, memoryItemId, kind, reason || undefined);
      setSent(kind);
      setReason('');
    } finally { setBusy(false); }
  };

  return (
    <>
      <div style={{ margin: '16px 0 8px' }}><SectionLabel>Feedback</SectionLabel></div>
      {feedback.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
          {feedback.map((f) => (
            <div key={f.id} style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)' }}>
              {new Date(f.createdAt).toLocaleDateString()} · {f.kind ?? f.vote}{f.reason ? ` — "${f.reason}"` : ''}
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
        {FEEDBACK_KINDS.map((k) => (
          <button
            key={k.id}
            disabled={busy}
            onClick={() => void submit(k.id)}
            className="hover-border"
            style={{
              cursor: busy ? 'default' : 'pointer', fontSize: 11, padding: '4px 10px', borderRadius: 7,
              background: sent === k.id ? 'var(--w-08)' : 'var(--w-03)', border: '1px solid var(--w-1)', color: 'var(--text-soft)',
            }}
          >
            {k.label}
          </button>
        ))}
      </div>
      <TextInput placeholder="optional reason" value={reason} onChange={(e) => setReason(e.target.value)} />
    </>
  );
}

/** Corrections create a NEW version linked back via supersedesMemoryId — there is no "edit
 *  memory" control (locked decision): the server enforces this, and this form's only field is
 *  the corrected STATEMENT, never an authority number. */
function CorrectionPanel({ pid, item, onRecorded }: { pid: string; item: ApiMemoryItem; onRecorded: () => void }) {
  const [open, setOpen] = useState(false);
  const [statement, setStatement] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!open) {
    return (
      <button
        onClick={() => { setOpen(true); setStatement(item.statement); }}
        className="rail-add"
        style={{ cursor: 'pointer', marginTop: 16, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)', border: '1px dashed var(--w-15)', padding: '5px 10px', borderRadius: 6, background: 'transparent' }}
      >
        + record a correction
      </button>
    );
  }

  const submit = async () => {
    if (!statement.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api.memoryCorrect(pid, item.id, statement.trim());
      setOpen(false);
      onRecorded();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not record correction');
    } finally { setBusy(false); }
  };

  return (
    <div style={{ marginTop: 16, padding: '10px 12px', borderRadius: 10, background: 'var(--w-03)', border: '1px solid var(--w-08)' }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '.05em' }}>
        Record a correction — creates a new version; this one stays readable
      </div>
      <TextArea value={statement} onChange={(e) => setStatement(e.target.value)} style={{ minHeight: 80, marginBottom: 8 }} />
      {error && <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--red-soft)', marginBottom: 8 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button disabled={busy || !statement.trim()} onClick={() => void submit()}>Record correction</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </div>
  );
}
