import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppStore } from '../store';
import { SettingsView } from './SettingsView';

let root: Root | null = null;
let container: HTMLDivElement;

vi.mock('../api', () => ({
  api: {
    groupInvites: vi.fn(async () => ({ invites: [] })),
    passkeys: vi.fn(async () => ({ passkeys: [] })),
    authSessions: vi.fn(async () => ({ sessions: [] })),
    users: vi.fn(async () => ({ users: [] })),
  },
}));

vi.mock('./Dialog', () => ({
  confirm: vi.fn(async () => true),
  prompt: vi.fn(),
}));

function fakeStore(): AppStore {
  return {
    user: {
      id: 'usr_1',
      email: 'mara@example.com',
      name: 'Mara',
      role: 'member',
      accessMode: 'read_write',
      canCreateProjects: true,
      canCreateGroups: true,
    },
    groups: [],
    data: { projects: [] },
    permissions: { canCreateGroups: true },
    actions: {
      updateProfile: vi.fn(async (name: string) => ({
        id: 'usr_1', email: 'mara@example.com', name, role: 'member',
        accessMode: 'read_write', canCreateProjects: true, canCreateGroups: true,
      })),
      logout: vi.fn(async () => {}),
      openModal: vi.fn(),
    },
  } as unknown as AppStore;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  vi.restoreAllMocks();
});

describe('Settings account section (PLNR-640)', () => {
  it('exposes display name editing and Sign out', async () => {
    const store = fakeStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<SettingsView store={store} />));
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector('[data-testid="settings-view"]')).toBeTruthy();
    expect(container.textContent).toContain('Your account');
    const nameInput = container.querySelector('input[aria-label="Display name"]') as HTMLInputElement;
    const emailInput = container.querySelector('input[aria-label="Email"]') as HTMLInputElement;
    expect(nameInput.value).toBe('Mara');
    expect(emailInput.value).toBe('mara@example.com');

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(nameInput, 'Mara Tuska');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const save = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save name')!;
    expect(save.disabled).toBe(false);
    await act(async () => { save.click(); });
    expect(store.actions.updateProfile).toHaveBeenCalledWith('Mara Tuska');

    const signOut = container.querySelector('[data-testid="sign-out"]') as HTMLButtonElement;
    await act(async () => { signOut.click(); });
    expect(store.actions.logout).toHaveBeenCalled();
  });
});
