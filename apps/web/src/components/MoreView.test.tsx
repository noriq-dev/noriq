import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import type { AppStore } from '../store';
import { MoreView } from './MoreView';

let root: Root | null = null;
let container: HTMLDivElement;
const originalMatchMedia = window.matchMedia;

function store(admin: boolean): AppStore {
  return {
    currentPid: 'prj_1', isAdmin: admin,
    user: { id: 'usr_1', name: 'Mara', role: admin ? 'admin' : 'member', accessMode: 'read_write' },
    data: { projects: [{ id: 'prj_1', key: 'MOB', name: 'Mobile' }] },
    actions: { setView: vi.fn(), openAdmin: vi.fn(), selectProject: vi.fn() },
  } as unknown as AppStore;
}

afterEach(() => {
  act(() => root?.unmount()); container?.remove(); root = null;
  window.matchMedia = originalMatchMedia; localStorage.clear(); vi.restoreAllMocks();
});

describe('More mobile hub', () => {
  it('hides Admin from non-admins and exposes settings and desktop tools', () => {
    window.matchMedia = vi.fn(() => ({ matches: false, media: '', onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }));
    const appStore = store(false);
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    act(() => root!.render(<MoreView store={appStore} />));

    expect(container.textContent).not.toContain('Instance projects and access');
    const settings = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Settings'))!;
    act(() => settings.click());
    expect(appStore.actions.setView).toHaveBeenCalledWith('settings');
    const graph = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Coordination graph'))!;
    act(() => graph.click());
    expect(appStore.actions.setView).toHaveBeenCalledWith('graph');
  });

  it('shows an admin-only pending invitation count', async () => {
    window.matchMedia = vi.fn(() => ({ matches: false, media: '', onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }));
    vi.spyOn(api, 'users').mockResolvedValue({ users: [
      { id: 'u1', email: 'one@example.com', name: 'One', role: 'member', disabled: 0, createdAt: '', pending: 1, passkeys: 0, groupIds: null, ownedProjects: 0 },
      { id: 'u2', email: 'two@example.com', name: 'Two', role: 'member', disabled: 0, createdAt: '', pending: 0, passkeys: 1, groupIds: null, ownedProjects: 0 },
    ] });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    act(() => root!.render(<MoreView store={store(true)} />));
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[aria-label="1 pending"]')).toBeTruthy();
  });
});
