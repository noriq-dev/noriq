// PLNR-271: the Project Memory explorer's three load-bearing behaviours — an unreachable memory
// store must say so (never render as an empty list), a lead must read differently from a settled/
// approved item by more than colour, and a correction must leave the original memory readable
// with its replacement linked from it. These are exactly the acceptance lines that would silently
// regress if the view started re-deriving `isLead`/`validity` itself or dropped the "unreachable"
// distinction — everything else here is supporting plumbing (typing into filters, opening a row).
//
// PLNR-287 restructured the view so the star map (not Explore) is what a human lands on; the
// three behaviours above now live one tab-click into Explore — `switchTab('Explore')` is the new
// step every one of those tests takes before doing what it always did. The new describe blocks at
// the bottom cover what PLNR-287 itself is accountable for: the map is the landing surface, every
// Phase 8 surface (Explore/Graph/Operations) stays exactly one click away, and a star's own
// "open evidence inspector" / "open in ego-network" hand off through MemoryStarMap's existing
// onOpenInspector(uri) / onOpenEgoNetwork(uri) props into the right tab, pre-seeded.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiConstellation, type ApiGraphCoverageReason, type ApiMemoryHistory, type ApiMemoryItem, type ApiMemoryReviewQueue } from '../api';
import { MemoryView } from './MemoryView';
import type { AppStore } from '../store';
import { CONSTELLATION_RESIDENT_NODE_BUDGET } from '@noriq-dev/shared';

let container: HTMLDivElement;
let root: Root | null = null;

function fakeStore(canManage = true): AppStore {
  return {
    currentPid: 'prj_1',
    helpers: { tasksOf: () => [] },
    permissions: { canManage, canContribute: canManage, cappedByReadOnly: !canManage },
  } as unknown as AppStore;
}

function mount(store = fakeStore()) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<MemoryView store={store} />));
}

beforeEach(() => {
  // Most legacy star-map assertions below are not cutover tests. Pin their surface explicitly;
  // the first describe removes this preference when it verifies the new default.
  localStorage.setItem('noriq.memory.mapMode', 'legacy');
  vi.spyOn(api, 'memoryReviewQueue').mockResolvedValue({
    items: [],
    counts: { proposed_decision: 0, contradiction: 0, stale_invalid: 0, recent_negative_feedback: 0, low_authority: 0 },
    overallTotal: 0, total: 0, offset: 0, nextOffset: null,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  vi.restoreAllMocks();
  localStorage.removeItem('noriq.memory.mapMode');
  history.replaceState(null, '', '/'); // the star map writes q/facet/selection params
});

const text = () => container.textContent ?? '';
/** Advance past a real setTimeout (the view's health probe / 250ms search debounce) — a plain
 *  microtask flush is not enough once a `setTimeout` is in the chain. */
const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

const setInputValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const queryInput = () => container.querySelector('input[placeholder^="search memory"]') as HTMLInputElement;

/** The sub-tab strip (Map/Explore/Graph/Operations) — clicking is the "one extra interaction"
 *  every Phase 8 surface is now reachable through from the map landing surface. */
const switchTab = (label: 'Map' | 'Review' | 'Explore' | 'Graph' | 'Operations') => {
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith(label));
  if (!btn) throw new Error(`no "${label}" tab button found`);
  act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
};

const emptyFrame = { text: '', itemsIncluded: 0, itemsOmitted: 0, truncated: false, charsUsed: 0, suspiciousCount: 0 };

/** Map is now the landing surface, so it mounts (and fetches) in every test regardless of which
 *  tab the test actually cares about — a bare empty-graph response keeps that fetch harmless and
 *  deterministic rather than hitting the network (and, incidentally, keeps jsdom's canvas-less
 *  `getContext` warning off tests that never look at the canvas anyway). */
const baseCoverage = { complete: true, reasons: ['graph-empty'] as ApiGraphCoverageReason[] };
function emptyConstellation(overrides: Partial<ApiConstellation> = {}): ApiConstellation {
  return {
    memoryRevision: 1, nodeCeiling: CONSTELLATION_RESIDENT_NODE_BUDGET, edgeCeiling: CONSTELLATION_RESIDENT_NODE_BUDGET * 2,
    nodes: [], edges: [], omitted: { nodes: 0, edges: 0, edgesDanglingPruned: 0, codeEntitiesExcluded: 0 },
    coverage: baseCoverage, ...overrides,
  };
}

describe('the memory view lands on the map (PLNR-287)', () => {
  it('offers the integrated v2 surface without removing the established 2D escape hatch', async () => {
    localStorage.removeItem('noriq.memory.mapMode');
    vi.spyOn(api, 'memoryConstellation').mockResolvedValue(emptyConstellation());
    vi.spyOn(api, 'memoryRepositories').mockResolvedValue({ repositories: [] });
    vi.spyOn(api, 'memoryConstellationV2Overview').mockResolvedValue({
      revision: { contract: 'constellation-v2', generationId: 'g1', sourceRevision: 1, currentRevision: 1, topologyVersion: 'connectivity-v1', layoutVersion: 'space-v1', state: 'current', generatedAt: 'now' },
      communities: [], routes: [], coverage: { complete: true, reasons: [] },
    });
    mount(); await tick();
    expect(text()).toContain('No memory systems yet');
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'use 2D map')).toBe(true);
  });

  it('falls back session-only to the 2D contract when a mixed-version server has no v2 route', async () => {
    localStorage.removeItem('noriq.memory.mapMode');
    vi.spyOn(api, 'memoryConstellation').mockResolvedValue(emptyConstellation());
    vi.spyOn(api, 'memoryRepositories').mockResolvedValue({ repositories: [] });
    vi.spyOn(api, 'memoryConstellationV2Overview').mockRejectedValue(new Error('HTTP 404'));
    mount(); await tick(); await tick();
    expect(text()).toContain('Using the compatible 2D map');
    expect(text()).toContain('Nothing has been recorded yet');
    expect(localStorage.getItem('noriq.memory.mapMode')).toBeNull();
  });

  it('shows the map, search-focused, with Explore/Graph/Operations each one tab away', async () => {
    vi.spyOn(api, 'memoryConstellation').mockResolvedValue(emptyConstellation());
    vi.spyOn(api, 'memoryRepositories').mockResolvedValue({ repositories: [] });

    mount();
    await tick();

    // The map's own search bar, not Explore's — same placeholder prefix, different copy after
    // the em dash (asserted exactly so this doesn't silently pass if Explore were still default).
    expect(queryInput().placeholder).toContain('ignites matching stars');
    expect(document.activeElement).toBe(queryInput()); // "search focused" — no click needed
    expect(text()).toContain('Nothing has been recorded yet'); // the honest empty-graph state

    // Every Phase 8 surface is reachable — the tab strip itself proves "at most one interaction".
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Explore')).toBe(true);
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Graph')).toBe(true);
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Operations')).toBe(true);
  });

  it('Explore remains a deliberately reachable textual mode, not only a failure fallback', async () => {
    vi.spyOn(api, 'memoryConstellation').mockResolvedValue(emptyConstellation());
    vi.spyOn(api, 'memoryRepositories').mockResolvedValue({ repositories: [] });
    vi.spyOn(api, 'memoryHealth').mockResolvedValue({
      projectId: 'prj_1', schemaVersion: 1, memoryRevision: 1, tableCounts: {}, databaseSize: 0, sizeStatus: 'ok', hasPriorGeneration: false,
    });
    vi.spyOn(api, 'memoryEntities').mockResolvedValue({ memoryRevision: 1, sort: 'newest', items: [], nextCursor: null, total: 0, byType: {} });

    mount();
    await tick();
    switchTab('Explore');
    await tick(); // Explore's own health probe

    expect(queryInput().placeholder).toContain('how do we handle X'); // Explore's own copy, not the map's
    expect(text()).not.toContain('unreachable'); // reached deliberately, nothing failed to get here
  });
});

describe('the human memory review queue', () => {
  const pending: ApiMemoryReviewQueue['items'][number] = {
    id: 'mem_pending', kind: 'decision', statement: 'Use a single retry budget.', authority: 2,
    validity: 'active', recordedAt: '2026-08-09T12:00:00.000Z', recordedByAgentId: 'agt_1',
    proposedAt: '2026-08-09T12:00:00.000Z', repositoryKey: 'repo', branch: 'main', baseId: 'abc123',
    reasons: ['proposed_decision', 'low_authority'], contradictionSetIds: [],
    recentNegativeFeedbackCount: 0, latestNegativeFeedbackAt: null,
  };
  const queue: ApiMemoryReviewQueue = {
    items: [pending],
    counts: { proposed_decision: 1, contradiction: 0, stale_invalid: 0, recent_negative_feedback: 0, low_authority: 1 },
    overallTotal: 1, total: 1, offset: 0, nextOffset: null,
  };

  it('draws managers to actionable proposed decisions and settles them with an explicit confirmation', async () => {
    vi.mocked(api.memoryReviewQueue).mockResolvedValue(queue);
    const approve = vi.spyOn(api, 'memoryApproveDecision').mockResolvedValue({ approvedMemoryId: 'mem_approved', transitionId: 'atr_1' });
    vi.spyOn(api, 'memoryConstellation').mockResolvedValue(emptyConstellation());
    mount(fakeStore(true));
    await tick();
    expect(text()).toContain('Review · 1');

    switchTab('Review');
    await tick();
    expect(text()).toContain('Human governance');
    expect(text()).toContain('Use a single retry budget.');
    const approveButton = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Approve decision')!;
    act(() => approveButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(text()).toContain('Approve this as a settled decision');
    const confirm = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Confirm approve')!;
    await act(async () => { confirm.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await tick();
    expect(approve).toHaveBeenCalledWith('prj_1', 'mem_pending', undefined);
  });

  it('lets read-only humans inspect the same queue without rendering mutation controls', async () => {
    vi.mocked(api.memoryReviewQueue).mockResolvedValue(queue);
    vi.spyOn(api, 'memoryConstellation').mockResolvedValue(emptyConstellation());
    mount(fakeStore(false));
    await tick();
    switchTab('Review');
    await tick();
    expect(text()).toContain('READ-ONLY REVIEW');
    expect(text()).toContain('Inspect evidence & history');
    expect(text()).not.toContain('Approve decision');
    expect(text()).not.toContain('Reject');
  });
});

describe('PLNR-339 ordered catalogue', () => {
  it('browses memories newest-first without a query and advances with the returned cursor', async () => {
    vi.spyOn(api, 'memoryConstellation').mockResolvedValue(emptyConstellation());
    vi.spyOn(api, 'memoryRepositories').mockResolvedValue({ repositories: [] });
    vi.spyOn(api, 'memoryHealth').mockResolvedValue({
      projectId: 'prj_1', schemaVersion: 1, memoryRevision: 1, tableCounts: {}, databaseSize: 0, sizeStatus: 'ok', hasPriorGeneration: false,
    });
    const first = {
      nodeId: 'n_new', uri: 'noriq://memory/mem_new', type: 'memory', kind: 'learning', label: 'Newest memory', createdAt: '2026-08-09T00:00:00.000Z',
      authority: 2, validity: 'active', isLead: true, leadReasons: ['low-authority'], degree: 1, groupKey: 'memory',
    };
    const second = { ...first, nodeId: 'n_old', uri: 'noriq://memory/mem_old', label: 'Older memory', createdAt: '2026-08-08T00:00:00.000Z' };
    const browse = vi.spyOn(api, 'memoryEntities').mockImplementation(async (_pid, input) => input.cursor
      ? { memoryRevision: 1, sort: 'newest', items: [second], nextCursor: null, total: 2, byType: { memory: 2 } }
      : { memoryRevision: 1, sort: 'newest', items: [first], nextCursor: first.uri, total: 2, byType: { memory: 2 } });

    mount();
    await tick();
    switchTab('Explore');
    await tick();

    expect(browse).toHaveBeenCalledWith('prj_1', expect.objectContaining({ type: 'memory', sort: 'newest', limit: 50 }), expect.anything());
    expect(text()).toContain('Newest memory');
    const next = [...container.querySelectorAll('button')].find((button) => button.textContent === 'next →');
    expect(next).toBeTruthy();
    act(() => next!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await tick();
    expect(browse).toHaveBeenLastCalledWith('prj_1', expect.objectContaining({ cursor: first.uri }), expect.anything());
    expect(text()).toContain('Older memory');
  });
});

describe('a selected star hands off by URI, through the existing onOpenInspector/onOpenEgoNetwork props', () => {
  const starNode = {
    nodeId: 'n1', uri: 'noriq://memory/mem_star', type: 'memory', kind: 'learning', label: 'A learning worth checking',
    authority: 3, validity: 'active', isLead: false, leadReasons: [], degree: 0, groupKey: 'memory',
  };

  it('opening the evidence inspector switches to Explore, pre-selected on that exact entity', async () => {
    vi.spyOn(api, 'memoryConstellation').mockResolvedValue(emptyConstellation({ nodes: [starNode], coverage: { complete: true, reasons: [] } }));
    vi.spyOn(api, 'memoryRepositories').mockResolvedValue({ repositories: [] });
    vi.spyOn(api, 'memoryHealth').mockResolvedValue({
      projectId: 'prj_1', schemaVersion: 1, memoryRevision: 1, tableCounts: {}, databaseSize: 0, sizeStatus: 'ok', hasPriorGeneration: false,
    });
    vi.spyOn(api, 'memoryItem').mockResolvedValue({
      id: 'mem_star', kind: 'learning', statement: 'the statement', authority: 3, confidence: null,
      contentHash: null, repositoryKey: null, branch: null, baseId: null, validity: 'active',
      supersedesMemoryId: null, recordedByAgentId: 'agt_1', recordedAt: '2026-01-01T00:00:00.000Z',
      proposedAt: null, rejectedAt: null, evidence: [],
    });
    vi.spyOn(api, 'memorySearch').mockResolvedValue({ mode: 'keyword', results: [], evidenceFrame: { ...emptyFrame, text: 'quoted evidence for mem_star' } });
    vi.spyOn(api, 'memoryHistory').mockResolvedValue({ versions: [], transitions: [], contradictions: [], feedback: [] });

    mount();
    await tick(); // map's constellation + repositories fetch

    // Reach the star via the accessible list (DOM/keyboard path, per the locked "canvas is never
    // the only path to any information" decision) rather than canvas hit-testing.
    const listBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'accessible list');
    expect(listBtn).toBeTruthy();
    act(() => { listBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const starRow = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('A learning worth checking'));
    expect(starRow).toBeTruthy();
    act(() => { starRow!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const openInspectorBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Open evidence inspector'));
    expect(openInspectorBtn).toBeTruthy();
    act(() => { openInspectorBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await tick(); // Explore mounts fresh + its item/history/evidence-frame fetches

    // Landed on Explore (the "at most one extra interaction" tab), already showing this exact
    // memory's evidence — not a blank Explore the human has to re-search from scratch.
    expect(queryInput().placeholder).toContain('how do we handle X');
    expect(text()).toContain('quoted evidence for mem_star');
    expect(api.memoryItem).toHaveBeenCalledWith('prj_1', 'mem_star');
  });

  it('opening the ego-network switches to Graph, seeded with that exact entity URI', async () => {
    vi.spyOn(api, 'memoryConstellation').mockResolvedValue(emptyConstellation({ nodes: [starNode], coverage: { complete: true, reasons: [] } }));
    vi.spyOn(api, 'memoryRepositories').mockResolvedValue({ repositories: [] });
    const neighborhood = vi.spyOn(api, 'memoryDependencyNeighborhood').mockResolvedValue({
      seed: null, downstream: [], upstream: [], coverage: { complete: true, reasons: [] },
    });

    mount();
    await tick();

    const listBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'accessible list');
    act(() => { listBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const starRow = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('A learning worth checking'));
    act(() => { starRow!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const openEgoBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Open in ego-network'));
    expect(openEgoBtn).toBeTruthy();
    act(() => { openEgoBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await tick(200); // Graph mounts fresh + its debounced neighborhood fetch

    // Landed on Graph, already seeded — never a blank "pick a task or paste a URI" empty state.
    expect(text()).not.toContain('there is no whole-project view here');
    expect(neighborhood).toHaveBeenCalledWith('prj_1', expect.objectContaining({ entityUri: 'noriq://memory/mem_star' }), expect.anything());
  });

  it('opens an off-sample search result as a focused ego-network instead of leaving it unreachable', async () => {
    vi.spyOn(api, 'memoryConstellation').mockResolvedValue(emptyConstellation({ nodes: [starNode], coverage: { complete: true, reasons: [] } }));
    vi.spyOn(api, 'memoryRepositories').mockResolvedValue({ repositories: [] });
    vi.spyOn(api, 'memorySearch').mockResolvedValue({
      mode: 'keyword', evidenceFrame: emptyFrame,
      results: [{
        entityType: 'node', id: 'file_off_map', uri: 'noriq://file/PLNR/repo/src/off-map.ts', kind: 'file',
        title: 'Off-map file', snippet: 'Off-map file', stage: 'lexical', score: 1,
        isLead: false, leadReasons: [], finalScore: 1,
      }],
    });
    const neighborhood = vi.spyOn(api, 'memoryDependencyNeighborhood').mockResolvedValue({
      seed: null, downstream: [], upstream: [], coverage: { complete: true, reasons: [] },
    });

    mount();
    await tick();
    act(() => setInputValue(queryInput(), 'off map'));
    await tick(300);
    const result = [...container.querySelectorAll('div')].find((element) => element.textContent === 'Off-map file');
    expect(result).toBeTruthy();
    act(() => result!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await tick(200);

    expect(neighborhood).toHaveBeenCalledWith(
      'prj_1', expect.objectContaining({ entityUri: 'noriq://file/PLNR/repo/src/off-map.ts' }), expect.anything(),
    );
  });
});

describe('an unreachable memory store', () => {
  it('says so, rather than rendering as though there were nothing to find', async () => {
    vi.spyOn(api, 'memoryConstellation').mockResolvedValue(emptyConstellation());
    vi.spyOn(api, 'memoryRepositories').mockResolvedValue({ repositories: [] });
    vi.spyOn(api, 'memoryHealth').mockRejectedValue(new Error('DO unreachable'));
    const search = vi.spyOn(api, 'memorySearch');

    mount();
    await tick();
    switchTab('Explore');
    await tick();

    expect(text()).toContain('Project memory is unreachable');
    // The distinction that matters: this is NOT "zero results found".
    expect(text()).not.toContain('nothing matched');
    // No point even trying to search a store already known to be down.
    expect(search).not.toHaveBeenCalled();
  });
});

describe('lead vs. approved decision', () => {
  it('carries the distinction in a text label, not colour alone', async () => {
    vi.spyOn(api, 'memoryConstellation').mockResolvedValue(emptyConstellation());
    vi.spyOn(api, 'memoryRepositories').mockResolvedValue({ repositories: [] });
    vi.spyOn(api, 'memoryHealth').mockResolvedValue({
      projectId: 'prj_1', schemaVersion: 1, memoryRevision: 1, tableCounts: {}, databaseSize: 0, sizeStatus: 'ok', hasPriorGeneration: false,
    });
    vi.spyOn(api, 'memorySearch').mockResolvedValue({
      mode: 'keyword',
      evidenceFrame: emptyFrame,
      results: [
        {
          entityType: 'memory', id: 'mem_lead', kind: 'learning', title: 'learning', snippet: 'an unverified hunch',
          stage: 'lexical', score: 1, authority: 1, validity: 'active', isLead: true, leadReasons: ['low-authority'], finalScore: 1,
        },
        {
          entityType: 'memory', id: 'mem_decision', kind: 'decision', title: 'decision', snippet: 'an approved call',
          stage: 'lexical', score: 1, authority: 5, validity: 'active', isLead: false, leadReasons: [], finalScore: 1,
        },
      ],
    });

    mount();
    await tick();
    switchTab('Explore');
    await tick(); // health + repositories

    act(() => setInputValue(queryInput(), 'payment retries'));
    await tick(300); // the search debounce

    expect(text()).toContain('◐ LEAD');
    expect(text()).toContain('● SETTLED');
    // Both rows are visible at once — the label is what tells them apart, not merely their color.
    expect(text()).toContain('an unverified hunch');
    expect(text()).toContain('an approved call');
  });
});

describe('a correction', () => {
  const item: ApiMemoryItem = {
    id: 'mem_old', kind: 'learning', statement: 'the old statement', authority: 2, confidence: null,
    contentHash: null, repositoryKey: null, branch: null, baseId: null, validity: 'stale',
    supersedesMemoryId: null, recordedByAgentId: 'agt_1', recordedAt: '2026-01-01T00:00:00.000Z',
    proposedAt: null, rejectedAt: null, evidence: [],
  };
  const history: ApiMemoryHistory = {
    versions: [
      { id: 'mem_old', kind: 'learning', statement: 'the old statement', authority: 2, validity: 'stale', recordedByAgentId: 'agt_1', recordedAt: '2026-01-01T00:00:00.000Z', proposedAt: null, rejectedAt: null, supersedesMemoryId: null, supersededByMemoryId: 'mem_new' },
      { id: 'mem_new', kind: 'learning', statement: 'the corrected statement', authority: 1, validity: 'active', recordedByAgentId: null, recordedAt: '2026-01-02T00:00:00.000Z', proposedAt: null, rejectedAt: null, supersedesMemoryId: 'mem_old', supersededByMemoryId: null },
    ],
    transitions: [],
    contradictions: [],
    feedback: [],
  };

  it('leaves the original memory readable, with its replacement linked from it', async () => {
    vi.spyOn(api, 'memoryConstellation').mockResolvedValue(emptyConstellation());
    vi.spyOn(api, 'memoryRepositories').mockResolvedValue({ repositories: [] });
    vi.spyOn(api, 'memoryHealth').mockResolvedValue({
      projectId: 'prj_1', schemaVersion: 1, memoryRevision: 1, tableCounts: {}, databaseSize: 0, sizeStatus: 'ok', hasPriorGeneration: false,
    });
    vi.spyOn(api, 'memorySearch').mockImplementation(async (_pid, filters) => {
      if (filters.memoryItemId) return { mode: 'keyword', results: [], evidenceFrame: { ...emptyFrame, text: 'quoted statement' } };
      return {
        mode: 'keyword',
        evidenceFrame: emptyFrame,
        results: [{
          entityType: 'memory', id: 'mem_old', kind: 'learning', title: 'learning', snippet: 'the old statement',
          stage: 'lexical', score: 1, authority: 2, validity: 'stale', isLead: true, leadReasons: ['validity-stale'], finalScore: 1,
        }],
      };
    });
    vi.spyOn(api, 'memoryItem').mockResolvedValue(item);
    vi.spyOn(api, 'memoryHistory').mockResolvedValue(history);

    mount();
    await tick();
    switchTab('Explore');
    await tick(); // health + repositories

    act(() => setInputValue(queryInput(), 'old statement'));
    await tick(300); // debounced list search

    // The snippet is rendered as a LEAF div with nothing else inside — the row root (which
    // carries onClick) is an ANCESTOR, so dispatching here and letting it bubble is what
    // actually reaches the handler (dispatching on an ancestor would not: bubbling only
    // travels upward from the real target).
    const snippet = [...container.querySelectorAll('div')].find((d) => d.textContent === 'the old statement');
    expect(snippet).toBeTruthy();
    await act(async () => { snippet!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await tick(); // item + history + per-item search fetches

    // The original is STILL shown (readable) — never replaced or hidden by the correction.
    expect(text()).toContain('quoted statement');
    expect(text()).toContain('Replaced by a newer version');
    // Version history lists BOTH versions — history is preserved, not overwritten.
    expect(text()).toContain('mem_old'.slice(-8));
    expect(text()).toContain('mem_new'.slice(-8));

    // Following the link opens the replacement without losing the lineage.
    const jumpLink = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('View') && b.textContent.includes('→'));
    expect(jumpLink).toBeTruthy();
  });
});
