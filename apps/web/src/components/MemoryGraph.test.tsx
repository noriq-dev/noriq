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

const setSelectValue = (select: HTMLSelectElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
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
});

describe('bounded, cancellable expansion', () => {
  it('names exactly the chosen seed, never exceeds the server-mirrored depth ceiling, and can be cancelled mid-flight', async () => {
    let rejectFn: ((err: unknown) => void) | null = null;
    const dep = vi.spyOn(api, 'memoryDependencyNeighborhood').mockImplementation(
      () => new Promise((_resolve, reject) => { rejectFn = reject; }),
    );

    mount(fakeStore([TASK]));
    const select = container.querySelector('select') as HTMLSelectElement;
    act(() => setSelectValue(select, TASK.id));
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
    act(() => setSelectValue(container.querySelector('select') as HTMLSelectElement, TASK.id));
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
    const select = container.querySelector('select') as HTMLSelectElement;
    act(() => setSelectValue(select, TASK.id));
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
    const select = container.querySelector('select') as HTMLSelectElement;
    act(() => setSelectValue(select, TASK.id));
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
