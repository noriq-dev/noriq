// PLNR-285: component-level coverage for the star map's four honest states (empty graph,
// unindexed project, truncated sample, unreachable store) and for the locked decision that
// camera/filter preferences round-trip through localStorage under the `noriq.*` convention and
// are never sent back to the server. Layout determinism, encoding and hit-testing are covered
// directly against the DOM-free starmap-layout.ts (jsdom has no canvas 2D context, so nothing
// pixel-level is assertable here) — this file only proves the component wires that module to the
// right on-screen state and to localStorage correctly.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiConstellation, type ApiGraphCoverageReason } from '../api';
import { MemoryStarMap } from './MemoryStarMap';

let container: HTMLDivElement;
let root: Root | null = null;

function mount(pid = 'prj_1') {
  container = document.createElement('div');
  // The component measures its container for the canvas viewport — give it real, non-zero size.
  Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true });
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<MemoryStarMap pid={pid} />));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  vi.restoreAllMocks();
  localStorage.clear();
});

const text = () => container.textContent ?? '';
const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

const baseCoverage = { complete: true, reasons: [] as ApiGraphCoverageReason[] };

function response(overrides: Partial<ApiConstellation>): ApiConstellation {
  return {
    memoryRevision: 1,
    nodeCeiling: 300,
    edgeCeiling: 600,
    nodes: [],
    edges: [],
    omitted: { nodes: 0, edges: 0, edgesDanglingPruned: 0 },
    coverage: baseCoverage,
    ...overrides,
  };
}

describe('the four honest states', () => {
  it('renders an unreachable-store state on a rejected fetch, never as an empty map', async () => {
    vi.spyOn(api, 'memoryConstellation').mockRejectedValue(new Error('network down'));
    mount();
    await tick();
    expect(text()).toMatch(/unreachable/i);
    expect(text()).not.toMatch(/nothing has been recorded/i);
  });

  it('renders the empty-graph state when coverage says graph-empty', async () => {
    vi.spyOn(api, 'memoryConstellation').mockResolvedValue(response({ coverage: { complete: false, reasons: ['graph-empty'] } }));
    mount();
    await tick();
    expect(text()).toMatch(/nothing has been recorded/i);
  });

  it('renders the unindexed-project banner (code-graph-empty alone) while still drawing the nodes it has', async () => {
    const node = {
      nodeId: 'n1', uri: 'noriq://task/t1', type: 'task', kind: null, label: 'A real task',
      authority: null, validity: null, isLead: null, leadReasons: null, degree: 0, groupKey: 'task',
    };
    vi.spyOn(api, 'memoryConstellation').mockResolvedValue(response({
      nodes: [node],
      coverage: { complete: false, reasons: ['code-graph-empty'] },
    }));
    mount();
    await tick();
    expect(text()).toMatch(/no repository index yet/i);
    expect(text()).not.toMatch(/nothing has been recorded/i);
  });

  it('renders a truncation note with the server\'s own omitted counts', async () => {
    const node = {
      nodeId: 'n1', uri: 'noriq://task/t1', type: 'task', kind: null, label: 'A task',
      authority: null, validity: null, isLead: null, leadReasons: null, degree: 0, groupKey: 'task',
    };
    vi.spyOn(api, 'memoryConstellation').mockResolvedValue(response({
      nodes: [node],
      omitted: { nodes: 12, edges: 4, edgesDanglingPruned: 2 },
      coverage: { complete: false, reasons: ['row-limit-reached'] },
    }));
    mount();
    await tick();
    expect(text()).toMatch(/truncated sample/i);
    expect(text()).toMatch(/12 node/);
    expect(text()).toMatch(/4 edge/);
  });
});

describe('localStorage persistence (locked decision: noriq.* convention, never written to the server)', () => {
  it('never calls memoryConstellation with anything but the read-only GET-equivalent (no body/write path)', async () => {
    const spy = vi.spyOn(api, 'memoryConstellation').mockResolvedValue(response({}));
    mount('prj_write_check');
    await tick();
    expect(spy).toHaveBeenCalledWith('prj_write_check', expect.anything());
    // Only ever called with (pid, signal) — never handed prefs/camera/filters to send anywhere.
    expect(spy.mock.calls[0]).toHaveLength(2);
  });

  it('persists filter/camera preferences under a noriq.starmap.<pid> localStorage key, not any other key', async () => {
    vi.spyOn(api, 'memoryConstellation').mockResolvedValue(response({}));
    mount('prj_2');
    await tick();
    // Toggling "hide lines" patches prefs, which the component's own effect writes to localStorage.
    const hideLinesBtn = [...container.querySelectorAll('button')].find((b) => /lines/i.test(b.textContent ?? ''));
    expect(hideLinesBtn).toBeTruthy();
    act(() => hideLinesBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await tick();
    const raw = localStorage.getItem('noriq.starmap.prj_2');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.showEdges).toBe(false);
  });

  it('restores persisted preferences on the next mount for the same project', async () => {
    localStorage.setItem('noriq.starmap.prj_3', JSON.stringify({ camera: { x: 1, y: 2, zoom: 1.5 }, pins: {}, hiddenGroups: ['file'], showEdges: false }));
    vi.spyOn(api, 'memoryConstellation').mockResolvedValue(response({}));
    mount('prj_3');
    await tick();
    const showLinesBtn = [...container.querySelectorAll('button')].find((b) => /show lines/i.test(b.textContent ?? ''));
    expect(showLinesBtn).toBeTruthy(); // showEdges: false restored -> button reads "show lines"
  });
});

describe('mounting is safe without a canvas 2D context (jsdom has none)', () => {
  it('mounts and unmounts cleanly on a populated map', async () => {
    const node = {
      nodeId: 'n1', uri: 'noriq://memory/m1', type: 'memory', kind: 'learning', label: 'A learning',
      authority: 3, validity: 'active', isLead: false, leadReasons: [], degree: 2, groupKey: 'memory',
    };
    vi.spyOn(api, 'memoryConstellation').mockResolvedValue(response({ nodes: [node], edges: [] }));
    expect(() => mount('prj_4')).not.toThrow();
    await tick();
    expect(text()).toMatch(/1 stars/);
  });
});
