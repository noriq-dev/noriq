import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiProjectDoc } from '../api';
import type { AppStore } from '../store';
import { TABLET_DOCS_SPLIT_MIN } from '../viewport';
import { DocsView } from './DocsView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;
const originalMatchMedia = window.matchMedia;
let innerWidth = 1000;

const activeDoc: ApiProjectDoc = {
  id: 'doc_active', name: 'Tablet layout', description: 'split band',
  body: 'Readable tablet body.', folder: '', tags: ['docs'],
  authorKind: 'human', authorName: 'Agent', version: 1, archivedAt: null,
  updatedAt: '2026-08-20T12:00:00.000Z',
};

function mockTablet(width: number) {
  innerWidth = width;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  window.matchMedia = vi.fn((query: string) => ({
    matches: query.includes('767px') ? width < 768 : query.includes('1023px') ? width < 1024 : false,
    media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as typeof window.matchMedia;
}

function store(): AppStore {
  return {
    currentPid: 'prj_1',
    snapshot: { taskDocs: [], tasks: [], tags: [] },
    permissions: { canContribute: true },
    actions: { openTask: vi.fn(), setView: vi.fn() },
  } as unknown as AppStore;
}

function mount() {
  vi.spyOn(api, 'docs').mockResolvedValue({ docs: [activeDoc] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<DocsView store={store()} />));
}

const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

describe('DocsView tablet composition', () => {
  it('uses stacked list/detail below the split threshold', async () => {
    mockTablet(TABLET_DOCS_SPLIT_MIN - 40);
    mount();
    await tick();
    const view = container.querySelector('[data-testid="docs-view"]')!;
    expect(view.className).toContain('docs-view--tablet-stacked');
    expect(container.querySelector('button[aria-label="Back to document list"]')).toBeNull();
    await act(async () => { container.querySelector<HTMLElement>('[data-doc-id="doc_active"]')!.click(); });
    await tick();
    expect(container.querySelector('button[aria-label="Back to document list"]')).toBeTruthy();
  });

  it('keeps a wide split pane at landscape tablet widths', async () => {
    mockTablet(TABLET_DOCS_SPLIT_MIN);
    mount();
    await tick();
    const view = container.querySelector('[data-testid="docs-view"]')!;
    expect(view.className).toContain('docs-view--tablet-split');
    expect(container.querySelector('.docs-sidebar')).toBeTruthy();
    expect(container.textContent).toContain('select a doc — or write one');
  });
});
