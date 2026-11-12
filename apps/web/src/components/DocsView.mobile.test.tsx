import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiProjectDoc } from '../api';
import type { AppStore } from '../store';
import { DocsView } from './DocsView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;
const originalMatchMedia = window.matchMedia;

const activeDoc: ApiProjectDoc = {
  id: 'doc_active', name: 'Mobile reader', description: 'readable on phone',
  body: '## Heading\n\nBody copy for the mobile document view.', folder: '', tags: ['mobile'],
  authorKind: 'human', authorName: 'Montana', version: 1, archivedAt: null,
  updatedAt: '2026-08-20T12:00:00.000Z',
};

function store(): AppStore {
  return {
    currentPid: 'prj_1',
    snapshot: { taskDocs: [], tasks: [], tags: [{ id: 'tag_1', name: 'mobile', color: '#3fd98b' }] },
    permissions: { canContribute: true },
    actions: { openTask: vi.fn(), setView: vi.fn() },
  } as unknown as AppStore;
}

function mockPhone() {
  window.matchMedia = vi.fn((query: string) => ({
    matches: query.includes('max-width: 767px'),
    media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as typeof window.matchMedia;
}

function mount() {
  vi.spyOn(api, 'docs').mockResolvedValue({ docs: [activeDoc] });
  vi.spyOn(api, 'docVersions').mockResolvedValue({ currentVersion: 1, archivedAt: null, versions: [] });
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

describe('DocsView phone composition', () => {
  beforeEach(() => mockPhone());

  it('shows the document list first, then a reader with back navigation', async () => {
    mount();
    await tick();

    expect(container.querySelector('[data-testid="docs-view"]')).toBeTruthy();
    expect(container.textContent).toContain('Mobile reader');
    expect(container.querySelector('button[aria-label="Back to document list"]')).toBeNull();

    await act(async () => { container.querySelector<HTMLElement>('[data-doc-id="doc_active"]')!.click(); });
    await tick();

    expect(container.textContent).toContain('Body copy for the mobile document view.');
    const back = container.querySelector<HTMLButtonElement>('button[aria-label="Back to document list"]');
    expect(back).toBeTruthy();
    await act(async () => back!.click());
    await tick();
    expect(container.querySelector('button[aria-label="Back to document list"]')).toBeNull();
    expect(container.textContent).toContain('Mobile reader');
  });
});
