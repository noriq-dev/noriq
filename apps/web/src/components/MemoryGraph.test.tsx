// PLNR-272: the ego-network view's load-bearing behaviours — §5's hard constraint that the
// initial load (and every expansion) names exactly ONE seed and never a whole-project fetch, that
// an in-flight expansion can be cancelled without leaving a stale spinner or a spurious error
// banner, that `coverage.complete === false` renders as "this graph cannot answer that yet"
// rather than as an empty or complete graph, and that the textual fallback mode answers the same
// questions as the visual one. Everything else (drag-to-pin, ring collapse, the tests/impact
// panels) is supporting plumbing over the same fetch/coverage contract these four already cover.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEntityUri, MemoryEdgeType } from '@noriq-dev/shared';
import { api, type ApiDependencyNeighborhood } from '../api';
import { MemoryGraph } from './MemoryGraph';
import type { AppStore } from '../store';

let container: HTMLDivElement;
let root: Root | null = null;

function fakeStore(tasks: Array<{ id: string; key: string; title: string }> = []): AppStore {
  return { helpers: { tasksOf: () => tasks } } as unknown as AppStore;
}

function mount(store: AppStore = fakeStore(), initialSeedUri?: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<MemoryGraph pid="prj_1" store={store} initialSeedUri={initialSeedUri} />));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  vi.restoreAllMocks();
  localStorage.clear();
});

const text = () => container.textContent ?? '';
/** Advance past the panel's 200ms debounce before it fires the bounded fetch. */
const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

const setTaskSeed = (value: string) => {
  act(() => container.querySelector<HTMLInputElement>('input[aria-label="Task seed"]')!.focus());
  act(() => container.querySelector<HTMLElement>(`[role="option"][data-value="${value}"]`)!.click());
};

const setInputValue = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const findButton = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label);

const TASK = { id: 'task_1', key: 'PLNR-1', title: 'Do the thing' };
const TASK_URI = buildEntityUri({ kind: 'task', id: TASK.id });

describe('the no-whole-project-load guarantee', () => {
  it('issues no request at all until a human names one seed', async () => {
    const dep = vi.spyOn(api, 'memoryDependencyNeighborhood');
    const tests = vi.spyOn(api, 'memoryValidatingTests');
    const impact = vi.spyOn(api, 'memoryChangeImpact');

    mount();
    await tick();

    expect(text()).toContain('Nothing is fetched until you choose one seed');
    expect(dep).not.toHaveBeenCalled();
    expect(tests).not.toHaveBeenCalled();
    expect(impact).not.toHaveBeenCalled();
  });

  it('finds and loads a task seed even when the bounded memory UI state contains no tasks', async () => {
    const task = {
      ...TASK, status: 'todo', priority: 1, type: 'feature', projectId: 'prj_1', projectKey: 'PLNR',
      boardId: null, updatedAt: '2026-08-10T00:00:00.000Z',
    };
    const search = vi.spyOn(api, 'searchTasks').mockResolvedValue({ tasks: [task], matched: 1, returned: 1 });
    const dep = vi.spyOn(api, 'memoryDependencyNeighborhood').mockResolvedValue({
      seed: { nodeId: 'node_1', uri: TASK_URI, type: 'task', label: TASK.title },
      upstream: [], downstream: [], coverage: { complete: true, reasons: [] },
    });
    mount(fakeStore([]));

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Task seed"]')!;
    act(() => input.focus());
    act(() => setInputValue(input, 'PLNR-1'));
    await tick(220);
    expect(search).toHaveBeenCalledWith(
      { projectId: 'prj_1', boardId: null, text: 'PLNR-1', limit: 25 },
      expect.any(AbortSignal),
    );
    act(() => container.querySelector<HTMLElement>('[role="option"]')!.click());
    await tick(250);
    expect(dep).toHaveBeenCalledWith('prj_1', expect.objectContaining({ entityUri: TASK_URI }), expect.any(AbortSignal));
  });
});

describe('bounded, cancellable expansion', () => {
  it('names exactly the chosen seed, never exceeds the server-mirrored depth ceiling, and can be cancelled mid-flight', async () => {
    let rejectFn: ((err: unknown) => void) | null = null;
    const dep = vi.spyOn(api, 'memoryDependencyNeighborhood').mockImplementation(
      () => new Promise((_resolve, reject) => { rejectFn = reject; }),
    );

    mount(fakeStore([TASK]));
    setTaskSeed(TASK.id);
    await tick(250);

    expect(dep).toHaveBeenCalledTimes(1);
    const [, input] = dep.mock.calls[0]!;
    expect(input.entityUri).toBe(TASK_URI);
    expect(input.maxDepth ?? 2).toBeLessThanOrEqual(4); // the server's own ceiling — never invented looser here

    expect(text()).toContain('expanding…');
    const cancelBtn = findButton('cancel');
    expect(cancelBtn).toBeTruthy();
    act(() => cancelBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    // Cancelling must not leave a stale spinner...
    expect(text()).not.toContain('expanding…');

    // ...and the aborted request's eventual rejection (arriving after the user already moved on)
    // must not surface as an error — the view stays consistent, not half-updated.
    act(() => rejectFn?.(new DOMException('aborted', 'AbortError')));
    await tick();
    expect(text()).not.toContain('did not answer');
  });
});

describe('relationship filtering (PLNR-384)', () => {
  const emptyResult: ApiDependencyNeighborhood = {
    seed: { nodeId: 'n1', uri: TASK_URI, type: 'task', label: TASK.title },
    downstream: [], upstream: [], coverage: { complete: true, reasons: [] },
  };

  it('sends every shared edge type by default, an exact selected subset, and every type again after clear', async () => {
    const dep = vi.spyOn(api, 'memoryDependencyNeighborhood').mockResolvedValue(emptyResult);
    mount(fakeStore([TASK]));
    setTaskSeed(TASK.id);
    await tick(250);
    expect(dep.mock.calls[0]![1].edgeTypes).toEqual([...MemoryEdgeType.options]);

    act(() => findButton('edge types (all)')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const derivedFrom = [...container.querySelectorAll('label')].find((label) => label.textContent?.includes('derived_from'))!;
    act(() => derivedFrom.querySelector('input')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await tick(250);
    expect(dep.mock.calls.at(-1)![1].edgeTypes).toEqual(['derived_from']);

    act(() => findButton('clear')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await tick(250);
    expect(dep.mock.calls.at(-1)![1].edgeTypes).toEqual([...MemoryEdgeType.options]);
  });

  it('renders a decision connected to its underlying memory by derived_from under the all default', async () => {
    const decisionUri = 'noriq://decision/mem_live';
    const memoryUri = 'noriq://memory/mem_live';
    vi.spyOn(api, 'memoryDependencyNeighborhood').mockResolvedValue({
      seed: { nodeId: 'decision_1', uri: decisionUri, type: 'decision', label: 'Use the canonical graph' },
      downstream: [{
        nodeId: 'memory_1', uri: memoryUri, type: 'memory', label: 'Canonical graph decision memory', depth: 1,
        edgePath: [{ fromNodeId: 'decision_1', edgeType: 'derived_from', toNodeId: 'memory_1' }],
      }],
      upstream: [], coverage: { complete: true, reasons: [] },
    });

    mount(fakeStore(), decisionUri);
    await tick(250);
    act(() => findButton('List')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(text()).toContain('Canonical graph decision memory');
    expect(text()).toContain('derived_from');
    expect(text()).not.toContain('has no recorded relationships');
  });
});

describe('selected-node incident edge emphasis (PLNR-387)', () => {
  const uri = (id: string) => `noriq://task/${id}`;
  const graphResult: ApiDependencyNeighborhood = {
    seed: { nodeId: 'n1', uri: uri('n1'), type: 'task', label: 'Seed' },
    downstream: [
      {
        nodeId: 'n2', uri: uri('n2'), type: 'task', label: 'Selected first', depth: 1,
        edgePath: [{ fromNodeId: 'n1', edgeType: 'depends_on', toNodeId: 'n2' }],
      },
      {
        nodeId: 'n3', uri: uri('n3'), type: 'task', label: 'Selected second', depth: 1,
        edgePath: [{ fromNodeId: 'n3', edgeType: 'implements', toNodeId: 'n1' }],
      },
      {
        nodeId: 'n4', uri: uri('n4'), type: 'task', label: 'Historical target', depth: 2,
        edgePath: [
          { fromNodeId: 'n1', edgeType: 'depends_on', toNodeId: 'n2' },
          { fromNodeId: 'n2', edgeType: 'supersedes', toNodeId: 'n4' },
        ],
      },
    ],
    upstream: [],
    coverage: { complete: true, reasons: [] },
  };

  const edgeGroups = () => [...container.querySelectorAll<SVGGElement>('g[data-edge-key]')];
  const edge = (key: string) => edgeGroups().find((group) => group.dataset.edgeKey === key)!;
  const node = (nodeUri: string) => [...container.querySelectorAll<SVGGElement>('g[data-node-uri]')]
    .find((group) => group.dataset.nodeUri === nodeUri)!;

  it('promotes inbound and outbound edges, draws them last, and clears or recomputes without refetching', async () => {
    const dep = vi.spyOn(api, 'memoryDependencyNeighborhood').mockResolvedValue(graphResult);
    mount(fakeStore(), uri('n1'));
    await tick(250);

    // With no selection, the original presentation remains exact.
    expect(edgeGroups().map((group) => group.dataset.edgeState)).toEqual(['default', 'default', 'default']);
    for (const group of edgeGroups()) {
      const line = group.querySelector('[data-edge-part="line"]')!;
      expect(line.getAttribute('stroke-width')).toBe('1.4');
      expect(line.getAttribute('opacity')).toBe('0.65');
      expect(line.getAttribute('marker-end')).toBe('url(#mg-arrow)');
    }

    act(() => node(uri('n2')).dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const inbound = edge('depends_on:n1:n2');
    const outboundHistorical = edge('supersedes:n2:n4');
    const unrelated = edge('implements:n3:n1');
    expect(edgeGroups().map((group) => group.dataset.edgeState)).toEqual(['subdued', 'incident', 'incident']);
    expect(inbound.dataset.edgeState).toBe('incident');
    expect(outboundHistorical.dataset.edgeState).toBe('incident');
    expect(unrelated.dataset.edgeState).toBe('subdued');

    const inboundLine = inbound.querySelector('[data-edge-part="line"]')!;
    const inboundLabel = inbound.querySelector('[data-edge-part="label"]')!;
    expect(inboundLine.getAttribute('stroke-width')).toBe('2.8');
    expect(inboundLine.getAttribute('opacity')).toBe('1');
    expect(inboundLine.getAttribute('marker-end')).toBe('url(#mg-arrow-selected)');
    expect(inboundLabel.getAttribute('font-weight')).toBe('700');
    expect(inboundLabel.textContent).toBe('depends_on');

    const historicalLine = outboundHistorical.querySelector('[data-edge-part="line"]')!;
    expect(outboundHistorical.dataset.edgeHistorical).toBe('true');
    expect(historicalLine.getAttribute('stroke-dasharray')).toBe('3 3');
    expect(historicalLine.getAttribute('marker-end')).toBe('url(#mg-arrow-historical-selected)');
    expect(outboundHistorical.querySelector('[data-edge-part="label"]')!.textContent).toBe('supersedes');

    const unrelatedLine = unrelated.querySelector('[data-edge-part="line"]')!;
    expect(unrelatedLine.getAttribute('stroke-width')).toBe('1.1');
    expect(unrelatedLine.getAttribute('opacity')).toBe('0.28');
    expect(unrelatedLine.getAttribute('marker-end')).toBe('url(#mg-arrow-subdued)');

    act(() => container.querySelector('svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(edgeGroups().every((group) => group.dataset.edgeState === 'default')).toBe(true);
    expect(edgeGroups().every((group) => group.querySelector('[data-edge-part="line"]')!.getAttribute('stroke-width') === '1.4')).toBe(true);

    act(() => node(uri('n3')).dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(edge('implements:n3:n1').dataset.edgeState).toBe('incident');
    expect(edge('depends_on:n1:n2').dataset.edgeState).toBe('subdued');
    expect(edge('supersedes:n2:n4').dataset.edgeState).toBe('subdued');
    expect(dep).toHaveBeenCalledTimes(1);
  });
});

describe('coverage.complete === false', () => {
  it('renders as its own explained state, never as "nothing is related"', async () => {
    const result: ApiDependencyNeighborhood = {
      seed: { nodeId: 'n1', uri: TASK_URI, type: 'task', label: TASK.title },
      downstream: [],
      upstream: [],
      coverage: { complete: false, reasons: ['code-graph-empty'] },
    };
    vi.spyOn(api, 'memoryDependencyNeighborhood').mockResolvedValue(result);

    mount(fakeStore([TASK]));
    setTaskSeed(TASK.id);
    await tick(250);

    expect(text()).toContain('This graph cannot answer that yet');
    // The DIFFERENT claim — a real, complete answer of zero relationships — must not also appear.
    expect(text()).not.toContain('has no recorded relationships');
  });
});

describe('the textual fallback mode', () => {
  it('is reachable deliberately and answers the same question the visual mode does', async () => {
    const result: ApiDependencyNeighborhood = {
      seed: { nodeId: 'n1', uri: TASK_URI, type: 'task', label: TASK.title },
      downstream: [{
        nodeId: 'n2', uri: 'noriq://file/PLNR/repo/src/x.ts', type: 'file', label: 'x.ts', depth: 1,
        edgePath: [{ fromNodeId: 'n1', edgeType: 'depends_on', toNodeId: 'n2' }],
      }],
      upstream: [],
      coverage: { complete: true, reasons: [] },
    };
    vi.spyOn(api, 'memoryDependencyNeighborhood').mockResolvedValue(result);

    mount(fakeStore([TASK]));
    setTaskSeed(TASK.id);
    await tick(250);

    // Visual is the default landing mode.
    expect(container.querySelector('svg')).toBeTruthy();

    const listBtn = findButton('List');
    expect(listBtn).toBeTruthy();
    act(() => listBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(container.querySelector('svg')).toBeFalsy();
    expect(text()).toContain('x.ts');
    expect(text()).toContain('depends_on');
  });
});
