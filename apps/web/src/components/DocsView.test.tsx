// PLNR-540: the Docs workspace exposes immutable history and reversible archive as distinct
// lifecycle affordances. Historical snapshots and archived docs must never look editable.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiProjectDoc } from '../api';
import type { AppStore } from '../store';
import { DialogHost } from './Dialog';
import { DocsView } from './DocsView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

const activeDoc: ApiProjectDoc = {
  id: 'doc_active', name: 'Runtime contract', description: 'current rules',
  body: 'Current protocol body.', folder: 'architecture', tags: ['protocol'],
  authorKind: 'human', authorName: 'Montana', version: 2, archivedAt: null,
  updatedAt: '2026-08-20T12:00:00.000Z',
};
const archivedDoc: ApiProjectDoc = {
  id: 'doc_archived', name: 'Retired contract', description: 'retained history',
  body: 'Archived protocol body.', folder: 'archive', tags: ['protocol'],
  authorKind: 'human', authorName: 'Montana', version: 3,
  archivedAt: '2026-08-20T13:00:00.000Z', updatedAt: '2026-08-20T12:30:00.000Z',
};

function store(): AppStore {
  return {
    currentPid: 'prj_1',
    snapshot: { taskDocs: [], tasks: [], tags: [{ id: 'tag_1', name: 'protocol', color: '#4c9dff' }] },
    actions: { openTask: vi.fn() },
  } as unknown as AppStore;
}

function mockApi() {
  vi.spyOn(api, 'docs').mockImplementation(async (_pid, archived = false) => ({ docs: archived ? [archivedDoc] : [activeDoc] }));
  vi.spyOn(api, 'docVersions').mockResolvedValue({
    currentVersion: 2, archivedAt: null,
    versions: [
      { version: 2, name: activeDoc.name, description: activeDoc.description, authorKind: 'human', authorName: 'Montana', createdAt: '2026-08-20T12:00:00.000Z' },
      { version: 1, name: 'Runtime contract v1', description: 'old rules', authorKind: 'agent', authorName: 'codex', createdAt: '2026-08-19T12:00:00.000Z' },
    ],
  });
  vi.spyOn(api, 'docVersion').mockResolvedValue({
    id: activeDoc.id, version: 1, currentVersion: 2, name: 'Runtime contract v1',
    description: 'old rules', body: 'Historical protocol body.', folder: 'design', tags: ['protocol'],
    authorKind: 'agent', authorName: 'codex', archivedAt: null, createdAt: '2026-08-19T12:00:00.000Z',
  });
  vi.spyOn(api, 'archiveDoc').mockResolvedValue({ ok: true, archived: true, version: 2 });
  vi.spyOn(api, 'restoreDoc').mockResolvedValue({ ok: true, archived: false, version: 3 });
  vi.spyOn(api, 'deleteDoc').mockResolvedValue({ ok: true } as never);
}

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<><DocsView store={store()} /><DialogHost /></>));
}

const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const text = () => container.textContent ?? '';
const button = (label: string) => [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
const click = async (element: Element | undefined) => {
  expect(element).toBeDefined();
  await act(async () => { (element as HTMLElement).click(); });
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  vi.restoreAllMocks();
});

describe('Docs version history', () => {
  it('opens historical snapshots read-only and returns explicitly to the current version', async () => {
    mockApi();
    mount();
    await tick();
    await click(container.querySelector(`[data-doc-id="${activeDoc.id}"]`) ?? undefined);
    await tick();

    expect(text()).toContain('Current protocol body.');
    expect(button('edit')).toBeDefined();
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Document version"]')!;
    expect(select).not.toBeNull();
    await act(async () => {
      select.value = '1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await tick();

    expect(api.docVersion).toHaveBeenCalledWith('prj_1', activeDoc.id, 1);
    expect(text()).toContain('Historical protocol body.');
    expect(text()).toContain('HISTORY');
    expect(text()).toContain('Read-only historical snapshot');
    expect(button('edit')).toBeUndefined();
    await click(button('current'));
    expect(text()).toContain('Current protocol body.');
    expect(button('edit')).toBeDefined();
  });
});

describe('Docs archive lifecycle', () => {
  it('confirms archive, browses retained docs, and keeps restore separate from permanent delete', async () => {
    mockApi();
    mount();
    await tick();
    await click(container.querySelector(`[data-doc-id="${activeDoc.id}"]`) ?? undefined);
    await tick();
    await click(button('archive'));

    expect(text()).toContain('It will leave search and task context');
    expect(api.archiveDoc).not.toHaveBeenCalled();
    await click(button('Archive'));
    await tick();
    expect(api.archiveDoc).toHaveBeenCalledWith('prj_1', activeDoc.id);

    await click(button('archive · 1'));
    await click(container.querySelector(`[data-doc-id="${archivedDoc.id}"]`) ?? undefined);
    await tick();
    expect(text()).toContain('Archived · excluded from search and task context');
    expect(button('edit')).toBeUndefined();
    expect(button('restore')).toBeDefined();
    expect(button('delete')).toBeDefined();

    await click(button('restore'));
    await tick();
    expect(api.restoreDoc).toHaveBeenCalledWith('prj_1', archivedDoc.id);
  });
});
