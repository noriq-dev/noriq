import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiAgent, type ApiAgentRoster } from '../api';
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

function mount(agentRoster: ApiAgentRoster) {
  vi.spyOn(api, 'attention').mockResolvedValue({ signals: [], overdue: [] });
  vi.spyOn(api, 'agents').mockResolvedValue(agentRoster);
  const setView = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<TopBar store={{
    currentPid: 'prj_1',
    view: 'memory',
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
  it('groups every project destination behind the current view and routes selection', async () => {
    const { setView } = mount(roster([]));
    await tick();

    const switcher = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    expect(switcher.textContent).toContain('Knowledge');
    expect(switcher.textContent).toContain('Memory');
    expect(container.textContent).not.toContain('AI-native project management');

    await act(async () => { switcher.click(); });
    expect(container.textContent).toContain('Overview');
    expect(container.textContent).toContain('Work');
    expect(container.textContent).toContain('Operate');
    expect(container.textContent).toContain('Mission Control');
    expect(container.textContent).toContain('Intelligence');
    expect(container.textContent).toContain('Review 1');
    expect(container.textContent).toContain('Project settings');

    const board = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent?.includes('Board'))!;
    await act(async () => { board.click(); });
    expect(setView).toHaveBeenCalledWith('board');
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
