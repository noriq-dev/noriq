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
  id: 'prj_1', key: 'MOB', name: `Mobile companion ${'with-a-long-name-'.repeat(12)}`, phase: `Implementation ${'unbroken-description-'.repeat(20)}`, dotColor: '#4c9dff', badge: '',
  hasLive: true, groupId: null, openTasks: 3, totalTasks: 5, doneTasks: 2, effectiveRole: 'owner', accessSource: 'owner',
  canView: true, canContribute: true, canManage: true, canOwn: true, cappedByReadOnly: false,
};

function store(projects: ProjectVM[] = [project]): AppStore {
  return {
    user: { id: 'usr_1', name: 'Mara Chen' }, groups: [], data: { projects },
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
    vi.spyOn(api, 'attention').mockResolvedValue({ signals: [], proposed: [], overdue: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<Home store={store()} />); });

    expect(container.textContent).toContain('Choose a project to catch up');
    expect(container.textContent).not.toContain('Connect an agent');
    expect(container.textContent).not.toContain('How Noriq works');
    expect(container.querySelector('a[href="/skill.md"]')).toBeNull();
    const card = [...container.querySelectorAll<HTMLElement>('.hover-border')].find((item) => item.textContent?.includes('Mobile companion'))!;
    expect(card.style.minHeight).toBe('72px');
    expect(card.style.minWidth).toBe('0');
    expect(card.style.maxWidth).toBe('100%');
    expect(container.querySelector<HTMLElement>('[data-testid="project-grid"]')!.style.gridTemplateColumns).toBe('minmax(0, 1fr)');
    expect(container.querySelector<HTMLElement>('[data-testid="project-name"]')!.style.minWidth).toBe('0');
    const description = container.querySelector<HTMLElement>('[data-testid="project-description"]')!;
    expect(description.style.maxWidth).toBe('100%');
    expect(description.style.overflowWrap).toBe('anywhere');
    expect(description.style.webkitLineClamp).toBe('2');
  });

  it('surfaces proposed tasks as actionable attention items', async () => {
    viewportMatchMedia(390);
    const contributorProject = { ...project, effectiveRole: 'contributor' as const, canManage: false, canOwn: false };
    vi.spyOn(api, 'attention').mockResolvedValue({
      signals: [], overdue: [],
      proposed: [{
        id: 'task_proposed', key: 'MOB-6', title: 'Consider offline sync',
        proposedAt: '2026-08-18T12:00:00.000Z', finding: 'The mobile flow loses drafts offline.',
        projectId: project.id, projectKey: project.key,
      }],
    });
    const accept = vi.spyOn(api, 'acceptProposal').mockResolvedValue({ id: 'task_proposed', key: 'MOB-6', status: 'todo' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<Home store={store([contributorProject])} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain('Needs attention');
    expect(container.textContent).toContain('PROPOSED');
    expect(container.textContent).toContain('Consider offline sync');
    const acceptButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Accept')!;
    await act(async () => { acceptButton.click(); });
    expect(accept).toHaveBeenCalledWith(project.id, 'task_proposed');
  });
});
