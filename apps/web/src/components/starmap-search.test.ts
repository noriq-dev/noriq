// PLNR-286: search wired into the star map — matching memories ignite, everything else dims.
//
// The four locked decisions this file exists to pin: (1) the join to a star is EXACT uri
// equality against `byUri`, never label/id-substring matching, and a hit outside the sampled
// field is counted, never hidden or silently dropped — both provable as plain functions of
// (ComputedStarMap, hits) against starmap-layout.ts, no DOM/canvas needed; (2) unmatched stars
// DIM, they are never removed from the layout; (3) search is debounced, cancellable and
// last-write-wins — a stale response must never repaint the highlight set, and cancelling must
// leave no spinner and no spurious error; (4) clearing the query restores the full field with NO
// map refetch and NO relayout. (3) and (4) are provable only against the mounted component
// (MemoryGraph.test.tsx's "bounded, cancellable expansion" describe block is the precedent this
// follows). Plain `.ts`, not `.tsx`: the component-level tests below mount via `createElement`
// rather than JSX syntax, so this file needs no JSX transform.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  api, type ApiConstellation, type ApiGraphCoverageReason, type ApiMemoryHit, type ApiMemorySearchFilters,
  type ApiMemorySearchResult,
} from '../api';
import { MemoryStarMap } from './MemoryStarMap';
import {
  computeHighlight, computeStarMap, decodeStarMapSearchState, encodeStarMapSearchState, highlightStateFor,
  type StarMapInputEdge, type StarMapInputNode, type StarMapSearchState,
} from './starmap-layout';

function node(overrides: Partial<StarMapInputNode> & { nodeId: string; uri: string }): StarMapInputNode {
  return {
    type: 'task', kind: null, label: overrides.uri, authority: null, validity: null,
    isLead: null, leadReasons: null, degree: 0, groupKey: 'task',
    ...overrides,
  };
}

function hit(overrides: Partial<ApiMemoryHit> & { id: string }): ApiMemoryHit {
  return {
    entityType: 'memory', title: overrides.id, snippet: overrides.id, stage: 'lexical', score: 1,
    isLead: false, leadReasons: [], finalScore: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// Pure: computeHighlight's join + the dim-not-remove partition (starmap-layout.ts) — testable
// without a canvas or React, same as PLNR-285's starmap-layout.test.ts.
// ---------------------------------------------------------------------------------------------

describe('computeHighlight — join by exact uri, never label or id-substring (locked decision)', () => {
  const nodes: StarMapInputNode[] = [
    node({ nodeId: 'n1', uri: 'noriq://task/t1', groupKey: 'task', label: 'Fix the retry bug' }),
    node({ nodeId: 'n2', uri: 'noriq://memory/m1', type: 'memory', groupKey: 'memory' }),
    node({ nodeId: 'n3', uri: 'noriq://file/f1', type: 'file', groupKey: 'file' }),
  ];
  const edges: StarMapInputEdge[] = [
    { type: 'related_to', fromNodeId: 'n1', toNodeId: 'n2', provenance: null },
  ];
  const map = computeStarMap(nodes, edges);

  it('ignites a star on an exact uri match', () => {
    const h = computeHighlight(map, [hit({ id: 'h1', uri: 'noriq://task/t1' })]);
    expect(h.matched).toEqual(new Set(['noriq://task/t1']));
    expect(h.matchedHitCount).toBe(1);
    expect(h.unmatchedCount).toBe(0);
  });

  it('a uri that is a PREFIX of a real star uri is a miss, never a fuzzy match', () => {
    const h = computeHighlight(map, [hit({ id: 'h1', uri: 'noriq://task/t' })]); // prefix of t1, not equal
    expect(h.matched.size).toBe(0);
    expect(h.matchedHitCount).toBe(0);
    expect(h.unmatchedCount).toBe(1);
  });

  it('never joins by label, even when the label text matches a real star exactly', () => {
    // A hit whose uri is absent, carrying the SAME label text as n1 — must not ignite n1.
    const h = computeHighlight(map, [hit({ id: 'h1', title: 'Fix the retry bug' })]);
    expect(h.matched.size).toBe(0);
    expect(h.unmatchedCount).toBe(1);
  });

  it('counts a hit with no uri at all as unmatched, never silently dropped', () => {
    const h = computeHighlight(map, [hit({ id: 'h1' })]);
    expect(h.unmatchedCount).toBe(1);
    expect(h.hitCount).toBe(1);
  });

  it('counts a hit whose uri is outside the sampled field as unmatched — a real hit, a bounded sample', () => {
    const h = computeHighlight(map, [hit({ id: 'h1', uri: 'noriq://task/not-in-sample' })]);
    expect(h.matched.size).toBe(0);
    expect(h.unmatchedCount).toBe(1);
  });

  it('matchedHitCount + unmatchedCount always equals hitCount, even with duplicate-uri hits', () => {
    const h = computeHighlight(map, [
      hit({ id: 'h1', uri: 'noriq://task/t1' }),
      hit({ id: 'h2', uri: 'noriq://task/t1' }), // same star, a second hit
      hit({ id: 'h3', uri: 'noriq://nowhere/x' }),
    ]);
    expect(h.matchedHitCount + h.unmatchedCount).toBe(h.hitCount);
    expect(h.hitCount).toBe(3);
    expect(h.matchedHitCount).toBe(2);
    expect(h.unmatchedCount).toBe(1);
    // Deduped at the STAR level: two hits landing on the same star ignite it once, not twice —
    // `matched` is a set of uris, so its size can be smaller than `matchedHitCount`.
    expect(h.matched.size).toBe(1);
  });

  it('halos the one-hop neighbour of a match via a real edge, never a two-hop or edgeless star', () => {
    const h = computeHighlight(map, [hit({ id: 'h1', uri: 'noriq://task/t1' })]);
    expect(h.halo).toEqual(new Set(['noriq://memory/m1']));
    expect(h.halo.has('noriq://file/f1')).toBe(false); // no edge to n3 at all
  });
});

describe('dim, never remove (locked decision)', () => {
  const nodes: StarMapInputNode[] = [
    node({ nodeId: 'n1', uri: 'noriq://task/t1', groupKey: 'task' }),
    node({ nodeId: 'n2', uri: 'noriq://memory/m1', type: 'memory', groupKey: 'memory' }),
    node({ nodeId: 'n3', uri: 'noriq://file/f1', type: 'file', groupKey: 'file' }),
  ];
  const map = computeStarMap(nodes, []);

  it('every star in the layout still gets a highlight state when only one of them matches — none omitted', () => {
    const h = computeHighlight(map, [hit({ id: 'h1', uri: 'noriq://task/t1' })]);
    expect(map.stars).toHaveLength(3); // the layout itself is untouched by highlighting
    for (const s of map.stars) {
      const state = highlightStateFor(h, s.uri);
      expect(['match', 'halo', 'dim']).toContain(state);
    }
  });

  it('an unmatched, unconnected star is classified "dim", not left out of any category', () => {
    const h = computeHighlight(map, [hit({ id: 'h1', uri: 'noriq://task/t1' })]);
    expect(highlightStateFor(h, 'noriq://file/f1')).toBe('dim');
  });

  it('with no active query (a null highlight), a star reads as unhighlighted, not as dimmed', () => {
    for (const s of map.stars) expect(highlightStateFor(null, s.uri)).toBeNull();
  });

  it('a zero-hit search still dims the whole field rather than reporting "no query active"', () => {
    const h = computeHighlight(map, []);
    expect(h.hitCount).toBe(0);
    for (const s of map.stars) expect(highlightStateFor(h, s.uri)).toBe('dim');
  });
});

describe('search/facet/selection URL round-trip (locked decision: separate from localStorage camera/pins)', () => {
  const full: StarMapSearchState = {
    query: 'race condition', kind: 'decision', minAuthority: '3', validity: 'active',
    repositoryKey: 'noriq', branch: 'main', selectedUri: 'noriq://memory/m1',
  };

  it('round-trips every field through a query string', () => {
    expect(decodeStarMapSearchState(encodeStarMapSearchState('', full))).toEqual(full);
  });

  it('preserves a param this module does not own, e.g. the board view\'s ?task=', () => {
    const qs = encodeStarMapSearchState('?task=task_123', { ...full, query: 'x' });
    expect(qs).toContain('task=task_123');
    expect(qs).toContain('q=x');
  });

  it('deletes an unset field rather than writing it as an empty value', () => {
    const empty: StarMapSearchState = { query: '', kind: '', minAuthority: '', validity: '', repositoryKey: '', branch: '', selectedUri: null };
    const qs = encodeStarMapSearchState('?q=old&kind=decision', empty);
    expect(qs).not.toContain('q=');
    expect(qs).not.toContain('kind=');
  });
});

// ---------------------------------------------------------------------------------------------
// Component-level: debounced/cancellable/last-write-wins, and clear-without-refetch. Both need
// the mounted component's actual effects — not provable as pure functions.
// ---------------------------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root | null = null;

function mount(pid = 'prj_1') {
  container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true });
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(MemoryStarMap, { pid })));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  vi.restoreAllMocks();
  localStorage.clear();
  history.replaceState(null, '', '/'); // this task writes query/facets/selection to location.search
});

const text = () => container.textContent ?? '';
const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const setInputValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const queryInput = () => container.querySelector('input[placeholder^="search memory"]') as HTMLInputElement;

const baseCoverage = { complete: true, reasons: [] as ApiGraphCoverageReason[] };
function constellationResponse(overrides: Partial<ApiConstellation>): ApiConstellation {
  return {
    memoryRevision: 1, nodeCeiling: 300, edgeCeiling: 600,
    nodes: [], edges: [], omitted: { nodes: 0, edges: 0, edgesDanglingPruned: 0 },
    coverage: baseCoverage, ...overrides,
  };
}
const emptyFrame = { text: '', itemsIncluded: 0, itemsOmitted: 0, truncated: false, charsUsed: 0, suspiciousCount: 0 };
const starNode = {
  nodeId: 'n1', uri: 'noriq://memory/m1', type: 'memory', kind: 'learning', label: 'A learning',
  authority: 3, validity: 'active', isLead: false, leadReasons: [], degree: 0, groupKey: 'memory',
};

describe('search is debounced, cancellable, and last-write-wins', () => {
  it('a superseded query is aborted, and its late settlement never repaints results or shows an error', async () => {
    vi.spyOn(api, 'memoryConstellation').mockResolvedValue(constellationResponse({ nodes: [starNode] }));
    vi.spyOn(api, 'memoryRepositories').mockResolvedValue({ repositories: [] });

    const calls: Array<{ query: string; signal?: AbortSignal; resolve: (r: ApiMemorySearchResult) => void; reject: (e: unknown) => void }> = [];
    vi.spyOn(api, 'memorySearch').mockImplementation((_pid: string, filters: ApiMemorySearchFilters, signal?: AbortSignal) =>
      new Promise<ApiMemorySearchResult>((resolve, reject) => { calls.push({ query: filters.query ?? '', signal, resolve, reject }); }));

    mount();
    await tick(); // let the constellation load

    const input = queryInput();
    act(() => setInputValue(input, 'first'));
    await tick(300); // debounce fires -> call #1 in flight, unresolved

    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toBe('first');
    expect(calls[0]!.signal?.aborted).toBe(false);

    act(() => setInputValue(input, 'second')); // supersedes call #1 before it resolves
    await tick(300); // effect cleanup aborts call #1's controller; debounce fires -> call #2

    expect(calls).toHaveLength(2);
    expect(calls[1]!.query).toBe('second');
    expect(calls[0]!.signal?.aborted).toBe(true); // the superseded request really was cancelled

    // Settle the FRESH call first, then let the STALE one arrive late — exactly the ordering the
    // acceptance line describes ("a slow response never repaints a stale highlight set").
    act(() => calls[1]!.resolve({ mode: 'keyword', results: [hit({ id: 'fresh result' })], evidenceFrame: emptyFrame }));
    await tick();
    expect(text()).toContain('fresh result');

    act(() => calls[0]!.reject(new DOMException('aborted', 'AbortError'))); // what a real aborted fetch does
    await tick();
    expect(text()).toContain('fresh result'); // unchanged
    expect(text()).not.toMatch(/search failed/i); // cancelling leaves no spurious error
  });
});

describe('clearing the query restores the full field with no refetch and no relayout', () => {
  it('does not call memoryConstellation again after typing then clearing the query', async () => {
    const constellationSpy = vi.spyOn(api, 'memoryConstellation').mockResolvedValue(constellationResponse({ nodes: [starNode] }));
    vi.spyOn(api, 'memoryRepositories').mockResolvedValue({ repositories: [] });
    vi.spyOn(api, 'memorySearch').mockResolvedValue({ mode: 'keyword', results: [hit({ id: 'h1', uri: 'noriq://memory/m1' })], evidenceFrame: emptyFrame });

    mount();
    await tick();
    expect(constellationSpy).toHaveBeenCalledTimes(1);
    expect(text()).toContain('1 stars');

    const input = queryInput();
    act(() => setInputValue(input, 'anything'));
    await tick(300);
    expect(text()).toMatch(/ignited/); // a query is active — the header states the ignite count

    act(() => setInputValue(input, ''));
    await tick(300);

    // Clearing never re-fetches the constellation — the same single fetched response still backs
    // the layout (`computeStarMap` runs once per fetch, never per interaction, per locked decision).
    expect(constellationSpy).toHaveBeenCalledTimes(1);
    expect(text()).toContain('1 stars'); // the full field, unchanged
    expect(text()).not.toMatch(/ignited/); // back to plain, un-highlighted brightness
  });
});
