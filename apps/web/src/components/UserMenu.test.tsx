import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppStore } from '../store';
import { UserMenu } from './UserMenu';

let root: Root | null = null;
let container: HTMLDivElement;

vi.mock('./Dialog', () => ({
  confirm: vi.fn(async () => true),
}));

function fakeStore(): AppStore {
  return {
    user: { id: 'usr_1', name: 'Montana', role: 'admin', accessMode: 'read_write', email: 'm@example.com', canCreateProjects: true, canCreateGroups: true },
    actions: { setView: vi.fn(), logout: vi.fn(async () => {}) },
  } as unknown as AppStore;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  vi.restoreAllMocks();
});

describe('UserMenu', () => {
  it('opens User settings and Sign out from the avatar trigger', async () => {
    const store = fakeStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<UserMenu store={store} variant="rail" />));

    expect(container.querySelector('[role="menu"]')).toBeNull();
    act(() => (container.querySelector('[data-testid="user-menu-trigger"]') as HTMLButtonElement).click());
    expect(container.querySelector('[role="menu"]')).toBeTruthy();

    act(() => (container.querySelector('[data-testid="user-menu-settings"]') as HTMLButtonElement).click());
    expect(store.actions.setView).toHaveBeenCalledWith('settings');

    act(() => (container.querySelector('[data-testid="user-menu-trigger"]') as HTMLButtonElement).click());
    await act(async () => {
      (container.querySelector('[data-testid="user-menu-sign-out"]') as HTMLButtonElement).click();
    });
    expect(store.actions.logout).toHaveBeenCalled();
  });
});
