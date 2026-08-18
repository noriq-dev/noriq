import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiAgent, type ApiAgentRoster } from '../api';
import type { ProjectViewId } from '../project-navigation';
import type { AppStore } from '../store';
import { TopBar } from './TopBar';

let container: HTMLDivElement;
let root: Root | null = null;
const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

const agent = (overrides: Partial<ApiAgent>): ApiAgent => ({
  id: 'agt_default', name: 'Default Agent', kind: 'agent', runnerId: 'run_1', role: 'worker', status: 'active',
  lifecycle: 'live', live: true, activityAt: '2026-08-10T13:00:00.000Z', actorClass: 'agent', retiredAt: null,
  retireReason: null, archivedAt: null, lineageStatus: 'complete', lineageReason: null,
  lastSeenAt: '2026-08-10T13:00:00.000Z', createdAt: '2026-08-10T12:00:00.000Z', heldTasks: 0,
  totalClaims: 0, ownerName: 'Owner', ownerUserId: 'usr_1', parentAgentId: null, ...overrides,
});

function roster(agents: ApiAgent[], live = agents.filter((item) => item.live && item.lifecycle === 'live').length): ApiAgentRoster {
  return {
    agents,
    counts: { live, recent: 0, historical: 0, total: agents.length, byLifecycle: { live, recent: 0, dormant: 0, retired: 0, archived: 0, revoked: 0 } },
    page: { limit: 100, hasMore: false, nextCursor: null },
    policy: { onlineSeconds: 300, recentDays: 7 },
  };
}

function mount(agentRoster: ApiAgentRoster, view: ProjectViewId = 'memory') {
  vi.spyOn(api, 'attention').mockResolvedValue({ signals: [], overdue: [] });
  vi.spyOn(api, 'agents').mockResolvedValue(agentRoster);
  const setView = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<TopBar store={{
    currentPid: 'prj_1',
    view,
    permissions: { canContribute: true, canManage: true, cappedByReadOnly: false, effectiveRole: 'owner' },
    helpers: { tasksOf: () => [{ id: 'task_1', status: 'review', archivedAt: null }] },
    actions: { setView, createTask: vi.fn() },
  } as unknown as AppStore} />));
  return { setView };
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  vi.restoreAllMocks();
});

describe('compact project TopBar (PLNR-396)', () => {
  it('keeps core destinations pinned and routes them directly', async () => {
    const { setView } = mount(roster([]));
    await tick();

    const pinned = container.querySelector<HTMLElement>('nav[aria-label="Pinned views"]')!;
    const pinnedButtons = [...pinned.querySelectorAll<HTMLButtonElement>('button')];
    expect(pinnedButtons).toHaveLength(4);
    expect(pinnedButtons.map((button) => button.textContent?.trim())).toEqual([
      'Mission Control',
      'Board',
      'Plans',
      'Review1',
    ]);
    expect(container.textContent).toContain('⌘F');
    expect(container.textContent).not.toContain('⌘K');
    expect(pinned.querySelector('[aria-current="page"]')).toBeNull();

    const board = pinnedButtons
      .find((button) => button.textContent?.includes('Board'))!;
    await act(async () => { board.click(); });
    expect(setView).toHaveBeenCalledWith('board');
  });

  it('groups non-pinned destinations and marks the current menu item', async () => {
    const { setView } = mount(roster([]), 'memory');
    await tick();

    const groups = container.querySelector<HTMLElement>('nav[aria-label="View groups"]')!;
    const triggers = [...groups.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="listbox"]')];
    expect(triggers.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Work views',
      'Operate views',
      'Knowledge views',
    ]);

    const knowledge = triggers.find((button) => button.getAttribute('aria-label') === 'Knowledge views')!;
    await act(async () => { knowledge.click(); });

    const menu = groups.querySelector<HTMLElement>('[role="listbox"][aria-label="Knowledge views"]')!;
    const items = [...menu.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(items.map((item) => item.querySelector('span span')?.textContent)).toEqual(['Docs', 'Memory']);
    expect(menu.querySelector('[aria-selected="true"]')?.textContent).toContain('Memory');

    const docs = items.find((button) => button.textContent?.includes('Docs'))!;
    await act(async () => { docs.click(); });
    expect(setView).toHaveBeenCalledWith('docs');
    expect(groups.querySelector('[role="listbox"]')).toBeNull();
  });

  it('exposes the current project settings as a direct navigation action', async () => {
    const { setView } = mount(roster([]));
    await tick();

    const settings = container.querySelector<HTMLButtonElement>('[aria-label="Project settings"]')!;
    expect(settings).toBeTruthy();
    await act(async () => { settings.click(); });
    expect(setView).toHaveBeenCalledWith('project-settings');
  });

  it('shows only server-authored live actors, working first, and opens the Agents view', async () => {
    const idle = agent({ id: 'agt_idle', name: 'Idle Agent', activityAt: '2026-08-10T13:10:00.000Z' });
    const stale = agent({ id: 'agt_stale', name: 'Stale Agent', lifecycle: 'recent', live: false, heldTasks: 3 });
    const working = agent({ id: 'agt_working', name: 'Working Agent', activityAt: '2026-08-10T13:05:00.000Z', heldTasks: 1 });
    const { setView } = mount(roster([idle, stale, working], 2));
    await tick();

    expect(api.agents).toHaveBeenCalledWith('prj_1', undefined, { lifecycle: 'live', limit: 100 });
    const presence = container.querySelector<HTMLButtonElement>('[aria-label="2 live agents; open Agents"]')!;
    expect(presence).toBeTruthy();
    expect(presence.textContent).toContain('2 live');
    expect(presence.textContent).not.toContain('Stale Agent');
    const avatarTitles = [...presence.querySelectorAll<HTMLElement>('[title]')].map((item) => item.title);
    expect(avatarTitles).toEqual([
      'Working Agent — working · 1 held task',
      'Idle Agent — live, idle',
    ]);

    await act(async () => { presence.click(); });
    expect(setView).toHaveBeenCalledWith('agents');
  });
});
