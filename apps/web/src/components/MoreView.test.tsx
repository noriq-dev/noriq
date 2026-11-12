import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import type { AppStore } from '../store';
import { MoreView } from './MoreView';

let root: Root | null = null;
let container: HTMLDivElement;
const originalMatchMedia = window.matchMedia;

vi.mock('./Dialog', () => ({
  confirm: vi.fn(async () => true),
  prompt: vi.fn(),
}));

function store(admin: boolean): AppStore {
  return {
    currentPid: 'prj_1', isAdmin: admin,
    user: { id: 'usr_1', name: 'Mara', role: admin ? 'admin' : 'member', accessMode: 'read_write' },
    data: { projects: [{ id: 'prj_1', key: 'MOB', name: 'Mobile' }] },
    actions: { setView: vi.fn(), openAdmin: vi.fn(), selectProject: vi.fn(), logout: vi.fn() },
  } as unknown as AppStore;
}

afterEach(() => {
  act(() => root?.unmount()); container?.remove(); root = null;
  window.matchMedia = originalMatchMedia; localStorage.clear(); vi.restoreAllMocks();
});

describe('More mobile hub', () => {
  it('opens account menu from the avatar and keeps Plans/desktop tools', async () => {
    window.matchMedia = vi.fn(() => ({ matches: false, media: '', onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }));
    const appStore = store(false);
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    act(() => root!.render(<MoreView store={appStore} />));

    expect(container.textContent).not.toContain('Instance projects and access');
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Sign out')).toBe(false);
    expect([...container.querySelectorAll('button')].some((b) => b.textContent?.includes('Settings') && b.textContent?.includes('Account, password'))).toBe(false);

    const trigger = container.querySelector('[data-testid="user-menu-trigger"]') as HTMLButtonElement;
    act(() => trigger.click());
    const settings = container.querySelector('[data-testid="user-menu-settings"]') as HTMLButtonElement;
    act(() => settings.click());
    expect(appStore.actions.setView).toHaveBeenCalledWith('settings');

    act(() => trigger.click());
    const signOut = container.querySelector('[data-testid="user-menu-sign-out"]') as HTMLButtonElement;
    await act(async () => { signOut.click(); await Promise.resolve(); });
    expect(appStore.actions.logout).toHaveBeenCalled();

    const plans = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Review phases, tasks'))!;
    act(() => plans.click());
    expect(appStore.actions.setView).toHaveBeenCalledWith('plans');
    const documents = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Browse settled project docs'))!;
    act(() => documents.click());
    expect(appStore.actions.setView).toHaveBeenCalledWith('docs');
    const health = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Claimable work, readiness'))!;
    act(() => health.click());
    expect(appStore.actions.setView).toHaveBeenCalledWith('intelligence');
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
