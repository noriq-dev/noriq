import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import type { AppStore } from '../store';
import type { ProjectVM } from '../types';
import { Home } from './Home';

const originalMatchMedia = window.matchMedia;
let container: HTMLDivElement;
let root: Root | null = null;

function viewportMatchMedia(width: number) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: width <= Number(query.match(/max-width: (\d+)px/)?.[1] ?? Number.POSITIVE_INFINITY),
    media: query, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  } as MediaQueryList));
}

const project: ProjectVM = {
  id: 'prj_1', key: 'MOB', name: 'Mobile companion', phase: 'Implementation', dotColor: '#4c9dff', badge: '',
  hasLive: true, groupId: null, openTasks: 3, totalTasks: 5, doneTasks: 2, effectiveRole: 'owner', accessSource: 'owner',
  canView: true, canContribute: true, canManage: true, canOwn: true, cappedByReadOnly: false,
};

function store(): AppStore {
  return {
    user: { id: 'usr_1', name: 'Mara Chen' }, groups: [], data: { projects: [project] },
    permissions: { canCreateProjects: true }, actions: { selectProject: vi.fn(), createProject: vi.fn() },
  } as unknown as AppStore;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

describe('Home phone composition', () => {
  it('focuses on catching up and projects without workstation agent setup', async () => {
    viewportMatchMedia(390);
    vi.spyOn(api, 'attention').mockResolvedValue({ signals: [], overdue: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<Home store={store()} />); });

    expect(container.textContent).toContain('Choose a project to catch up');
    expect(container.textContent).not.toContain('Connect an agent');
    expect(container.textContent).not.toContain('How Noriq works');
    expect(container.querySelector('a[href="/skill.md"]')).toBeNull();
    expect([...container.querySelectorAll<HTMLElement>('.hover-border')].find((card) => card.textContent?.includes('Mobile companion'))?.style.minHeight).toBe('72px');
  });
});
