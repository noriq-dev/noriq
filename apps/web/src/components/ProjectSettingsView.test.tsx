import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import type { AppStore } from '../store';
import { ProjectSettingsView } from './ProjectSettingsView';

let container: HTMLDivElement;
let root: Root | null = null;

const access = {
  self: { effectiveRole: 'owner', accessSource: 'owner', cappedByReadOnly: false },
  owner: { id: 'usr_owner', name: 'Project Owner', email: 'owner@example.test' },
  grants: [{
    principalType: 'user' as const,
    principalId: 'usr_viewer',
    principalName: 'Project Viewer',
    principalEmail: 'viewer@example.test',
    role: 'viewer' as const,
    source: 'explicit',
  }],
  canManageAccess: true,
  canTransferOwnership: true,
};

function fakeStore({ canManage = true, canOwn = true } = {}) {
  return {
    currentPid: 'prj_alpha',
    data: { projects: [{
      id: 'prj_alpha', key: 'ALPHA', name: 'Alpha Project', phase: 'Initial description', groupId: 'grp_1',
      isPublic: false, effectiveRole: canOwn ? 'owner' : canManage ? 'manager' : 'viewer',
    }] },
    snapshot: { project: { claimTtlSeconds: 1800 } },
    groups: [{ id: 'grp_1', name: 'Product', canEdit: 1 }],
    permissions: {
      canManage, canOwn, canCreateGroups: false,
      effectiveRole: canOwn ? 'owner' : canManage ? 'manager' : 'viewer',
    },
    actions: {
      submitProjectMeta: vi.fn().mockResolvedValue(undefined),
      openModal: vi.fn(),
      refreshNow: vi.fn().mockResolvedValue(undefined),
      deleteProject: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as AppStore;
}

function render(node: ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
}

function input(target: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, value);
  target.dispatchEvent(new Event('input', { bubbles: true }));
}

const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  vi.restoreAllMocks();
});

describe('ProjectSettingsView (PLNR-401)', () => {
  it('loads the current project and lets a manager save its editable metadata', async () => {
    vi.spyOn(api, 'projectAccess').mockResolvedValue(access);
    vi.spyOn(api, 'users').mockResolvedValue({ users: [] });
    const store = fakeStore();
    render(<ProjectSettingsView store={store} />);
    await tick();

    expect(container.textContent).toContain('Project settings');
    expect(container.textContent).toContain('Alpha Project');
    expect(api.projectAccess).toHaveBeenCalledWith('prj_alpha');

    const name = container.querySelector<HTMLInputElement>('[aria-label="Project name"]')!;
    expect(name.disabled).toBe(false);
    act(() => input(name, 'Renamed Alpha'));
    const save = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Save changes')!;
    await act(async () => { save.click(); });

    expect(store.actions.submitProjectMeta).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Renamed Alpha',
      description: 'Initial description',
      groupId: 'grp_1',
      claimTtlSeconds: 1800,
    }));
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Saved');
  });

  it('uses the current project id for access mutations', async () => {
    vi.spyOn(api, 'projectAccess').mockResolvedValue(access);
    vi.spyOn(api, 'users').mockResolvedValue({ users: [] });
    vi.spyOn(api, 'setProjectGrant').mockResolvedValue({});
    render(<ProjectSettingsView store={fakeStore()} />);
    await tick();

    const role = container.querySelector<HTMLButtonElement>('[aria-label="Role for Project Viewer"]')!;
    act(() => role.click());
    const manager = [...container.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent?.includes('Manager'))!;
    await act(async () => { manager.click(); });

    expect(api.setProjectGrant).toHaveBeenCalledWith('prj_alpha', {
      principalType: 'user', principalId: 'usr_viewer', role: 'manager',
    });
  });

  it('keeps the owner-only visibility mutation in its own section', async () => {
    vi.spyOn(api, 'projectAccess').mockResolvedValue(access);
    vi.spyOn(api, 'users').mockResolvedValue({ users: [] });
    const store = fakeStore();
    render(<ProjectSettingsView store={store} />);
    await tick();

    const publicToggle = container.querySelector<HTMLInputElement>('[aria-label="Public read-only page"]')!;
    act(() => publicToggle.click());
    const save = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Save visibility')!;
    await act(async () => { save.click(); });

    expect(store.actions.submitProjectMeta).toHaveBeenCalledWith({ public: true });
    expect(container.textContent).toContain('Visibility saved');
  });

  it('is read-only for viewers and does not request the management directory', () => {
    const accessSpy = vi.spyOn(api, 'projectAccess');
    const usersSpy = vi.spyOn(api, 'users');
    render(<ProjectSettingsView store={fakeStore({ canManage: false, canOwn: false })} />);

    expect(container.textContent).toContain('A project manager or owner is required to make changes.');
    expect(container.querySelector<HTMLInputElement>('[aria-label="Project name"]')!.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('[aria-label="Public read-only page"]')!.disabled).toBe(true);
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Save changes')).toBe(false);
    expect(container.textContent).not.toContain('Danger zone');
    expect(accessSpy).not.toHaveBeenCalled();
    expect(usersSpy).not.toHaveBeenCalled();
  });

  it('keeps owner-only controls unavailable to a project manager', async () => {
    vi.spyOn(api, 'projectAccess').mockResolvedValue({ ...access, canTransferOwnership: false });
    vi.spyOn(api, 'users').mockResolvedValue({ users: [] });
    render(<ProjectSettingsView store={fakeStore({ canManage: true, canOwn: false })} />);
    await tick();

    expect(container.querySelector<HTMLInputElement>('[aria-label="Public read-only page"]')!.disabled).toBe(true);
    expect(container.textContent).toContain('Only the project owner can change public visibility.');
    expect(container.textContent).not.toContain('Danger zone');
    expect(container.querySelector('[aria-label="New project owner"]')).toBeNull();
  });
});
