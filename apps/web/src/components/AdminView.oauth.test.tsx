import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import type { AppStore } from '../store';
import { AdminView, redirectHosts } from './AdminView';

let root: Root | null = null;
let container: HTMLDivElement;

vi.mock('../api', () => ({
  api: {
    adminConnections: vi.fn(),
    adminClients: vi.fn(),
    adminRevokeConnection: vi.fn(async () => ({ ok: true })),
    adminDeleteClient: vi.fn(async () => ({ ok: true })),
    adminAuthorization: vi.fn(async () => ({
      settings: { defaultCanCreateProjects: true, defaultCanCreateGroups: true },
      accounts: [],
      projects: [],
      groups: [],
      audit: [],
    })),
    authorizationParityAudit: vi.fn(),
    users: vi.fn(async () => ({ users: [] })),
    groups: vi.fn(async () => ({ groups: [] })),
  },
}));

vi.mock('./Dialog', () => ({
  confirm: vi.fn(async () => true),
  prompt: vi.fn(),
}));

function fakeStore(): AppStore {
  return {
    isAdmin: true,
    adminProjects: [],
    groups: [],
    permissions: { canCreateGroups: true, canCreateProjects: true },
    user: { id: 'usr_1', name: 'Admin', role: 'admin', accessMode: 'read_write' },
    actions: { refreshAdmin: vi.fn(async () => {}), selectProject: vi.fn() },
  } as unknown as AppStore;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  vi.restoreAllMocks();
});

describe('redirectHosts', () => {
  it('parses DCR redirect_uris JSON into distinct hosts', () => {
    expect(redirectHosts(JSON.stringify(['http://localhost:3118/cb', 'http://127.0.0.1:9/x']))).toEqual([
      'localhost:3118',
      '127.0.0.1:9',
    ]);
    expect(redirectHosts('not-json')).toEqual(['not-json']);
    expect(redirectHosts('[]')).toEqual([]);
  });
});

describe('Admin OAuth clients multi-select (PLNR-642)', () => {
  it('shows idle/in-use filters, checkboxes, and bulk delete for idle selection', async () => {
    vi.mocked(api.adminConnections).mockResolvedValue({ connections: [] });
    vi.mocked(api.adminClients).mockResolvedValue({
      clients: [
        {
          id: 'client_idle',
          name: 'Localhost MCP client',
          redirectUris: JSON.stringify(['http://localhost:1/cb']),
          createdAt: '2026-11-01T00:00:00.000Z',
          liveTokens: 0,
        },
        {
          id: 'client_busy',
          name: 'Claude Code',
          redirectUris: JSON.stringify(['https://claude.ai/callback']),
          createdAt: '2026-11-02T00:00:00.000Z',
          liveTokens: 2,
        },
      ],
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<AdminView store={fakeStore()} />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain('Dynamic Client Registration');
    expect(container.textContent).toContain('Idle · 1');
    expect(container.textContent).toContain('In use · 1');
    expect(container.textContent).toContain('localhost:1');
    expect(container.textContent).toContain('claude.ai');

    const selectIdle = container.querySelector('[data-testid="oauth-select-idle"]') as HTMLButtonElement;
    expect(selectIdle).toBeTruthy();
    act(() => selectIdle.click());
    expect(container.querySelector('[data-testid="oauth-clients-bulk"]')?.textContent).toContain('1 selected');

    const bulkDelete = [...container.querySelectorAll('[data-testid="oauth-clients-bulk"] button')]
      .find((b) => b.textContent?.includes('delete idle')) as HTMLButtonElement;
    await act(async () => { bulkDelete.click(); await Promise.resolve(); });
    expect(api.adminDeleteClient).toHaveBeenCalledWith('client_idle');
  });
});
