// PLNR-271: the Project Memory explorer's three load-bearing behaviours — an unreachable memory
// store must say so (never render as an empty list), a lead must read differently from a settled/
// approved item by more than colour, and a correction must leave the original memory readable
// with its replacement linked from it. These are exactly the acceptance lines that would silently
// regress if the view started re-deriving `isLead`/`validity` itself or dropped the "unreachable"
// distinction — everything else here is supporting plumbing (typing into filters, opening a row).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiMemoryHistory, type ApiMemoryItem } from '../api';
import { MemoryView } from './MemoryView';
import type { AppStore } from '../store';

let container: HTMLDivElement;
let root: Root | null = null;

function fakeStore(): AppStore {
  return {
    currentPid: 'prj_1',
    helpers: { tasksOf: () => [] },
  } as unknown as AppStore;
}

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<MemoryView store={fakeStore()} />));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  vi.restoreAllMocks();
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

const emptyFrame = { text: '', itemsIncluded: 0, itemsOmitted: 0, truncated: false, charsUsed: 0, suspiciousCount: 0 };

describe('an unreachable memory store', () => {
  it('says so, rather than rendering as though there were nothing to find', async () => {
    vi.spyOn(api, 'memoryHealth').mockRejectedValue(new Error('DO unreachable'));
    vi.spyOn(api, 'memoryRepositories').mockResolvedValue({ repositories: [] });
    const search = vi.spyOn(api, 'memorySearch');

    mount();
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
    vi.spyOn(api, 'memoryHealth').mockResolvedValue({
      projectId: 'prj_1', schemaVersion: 1, memoryRevision: 1, tableCounts: {}, databaseSize: 0, sizeStatus: 'ok',
    });
    vi.spyOn(api, 'memoryRepositories').mockResolvedValue({ repositories: [] });
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
    vi.spyOn(api, 'memoryHealth').mockResolvedValue({
      projectId: 'prj_1', schemaVersion: 1, memoryRevision: 1, tableCounts: {}, databaseSize: 0, sizeStatus: 'ok',
    });
    vi.spyOn(api, 'memoryRepositories').mockResolvedValue({ repositories: [] });
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
