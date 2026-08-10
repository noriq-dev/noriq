import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiAgentRoster, type ApiRunnerRoster } from '../api';
import type { AppStore } from '../store';
import { AgentsView } from './AgentsView';

let container: HTMLDivElement;
let root: Root | null = null;
const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

const emptyAgents: ApiAgentRoster = {
  agents: [],
  counts: { live: 2, recent: 1, historical: 5, total: 9, byLifecycle: { live: 2, recent: 1, dormant: 1, retired: 2, archived: 2, revoked: 1 } },
  page: { limit: 50, hasMore: false, nextCursor: null },
  policy: { onlineSeconds: 300, recentDays: 7 },
};
const emptyRunners: ApiRunnerRoster = {
  runners: [],
  counts: { active: 1, dormant: 2, historical: 3, total: 6, byLifecycle: { active: 1, dormant: 2, retired: 2, archived: 1 } },
  page: { limit: 50, hasMore: false, nextCursor: null },
  policy: { heartbeatSeconds: 90 },
};

function mount() {
  vi.spyOn(api, 'agents').mockResolvedValue(emptyAgents);
  vi.spyOn(api, 'runners').mockResolvedValue(emptyRunners);
  vi.spyOn(api, 'users').mockResolvedValue({ users: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<AgentsView store={{
    currentPid: 'prj_1', user: { id: 'usr_1', email: 'admin@example.com', name: 'Admin', role: 'admin' },
  } as unknown as AppStore} />));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  vi.restoreAllMocks();
});

const button = (label: string) => [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);

describe('actor lifecycle inventory (PLNR-368)', () => {
  it('defaults to Active and exposes distinct Dormant and History views with server-side filters', async () => {
    mount();
    await tick();
    expect(container.textContent).toContain('Active 3');
    expect(container.textContent).toContain('Dormant 1');
    expect(container.textContent).toContain('History 5');
    expect(api.agents).toHaveBeenCalledWith('prj_1', 'agent', expect.objectContaining({ view: 'active', limit: 50 }));

    await act(async () => { button('Dormant 1')!.click(); });
    await tick();
    expect(api.agents).toHaveBeenLastCalledWith('prj_1', 'agent', expect.objectContaining({ view: 'dormant' }));
  });

  it('moves Runners into the same lifecycle inventory and surfaces bounded cleanup preview', async () => {
    mount();
    await tick();
    await act(async () => { button('runner')!.click(); });
    await tick();
    expect(api.runners).toHaveBeenCalledWith(expect.objectContaining({ all: true, projectId: 'prj_1', view: 'active', limit: 50 }));
    expect(container.textContent).toContain('Active 1');
    expect(container.textContent).toContain('Dormant 2');
    expect(container.textContent).toContain('History 3');

    vi.spyOn(api, 'agentLifecycleSweep').mockResolvedValue({
      sweepId: 'als_1', dryRun: true, generatedAt: new Date().toISOString(),
      examined: { actors: 4, presences: 3, runners: 2 }, transitions: { 'actor:active->retired': 1 }, protections: {},
      referenceCheck: { complete: true, blockers: [] }, errorCounts: {}, errors: [],
      cursor: { actorId: null, presenceId: null, runnerId: null }, complete: true,
    });
    await act(async () => { button('dry run')!.click(); });
    expect(container.textContent).toContain('DRY RUN · examined 4 actors / 3 presences / 2 Runners');
    expect(container.textContent).toContain('reference probe passed');
  });
});
