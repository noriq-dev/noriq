import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { api, type ApiProjectHealth } from '../api';
import type { AppStore } from '../store';
import { IntelligenceView, partitionHealthTasks } from './IntelligenceView';

let root: Root, container: HTMLDivElement;
const openTask = vi.fn(), setView = vi.fn();

const packet: ApiProjectHealth = {
  observedAt: new Date().toISOString(),
  totalOpenTasks: 3,
  activeClaims: 1,
  activeLocks: 0,
  offset: 0,
  nextOffset: null,
  pageSize: 10,
  items: [
    {
      id: 't1',
      key: 'APP-1',
      title: 'Recheck phase two',
      status: 'todo',
      priority: 2,
      claimability: { claimable: false, reason: 'Readiness required', reasonCode: 'freshness_critical' },
      phases: [],
      readiness: 'missing',
      implementation: 'missing',
      evidenceRequired: true,
      checkedAt: null,
      checkedRevision: null,
      causes: [{ code: 'readiness_required', severity: 'critical' }],
      blockingCauses: ['readiness_required'],
      overrides: [],
    },
    {
      id: 't2',
      key: 'APP-2',
      title: 'Ship health chrome',
      status: 'todo',
      priority: 1,
      claimability: { claimable: true, reason: 'Claimable', reasonCode: 'ok' },
      phases: [],
      readiness: 'passed',
      implementation: 'missing',
      evidenceRequired: true,
      checkedAt: null,
      checkedRevision: 'abc123',
      causes: [],
      blockingCauses: [],
      overrides: [],
    },
    {
      id: 't3',
      key: 'APP-3',
      title: 'Waiting on dependency',
      status: 'todo',
      priority: 3,
      claimability: { claimable: false, reason: 'Blocked by APP-9', reasonCode: 'dependency' },
      phases: [],
      readiness: 'passed',
      implementation: 'missing',
      evidenceRequired: true,
      checkedAt: null,
      checkedRevision: null,
      causes: [],
      blockingCauses: [],
      overrides: [],
    },
  ],
};

async function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(
    <IntelligenceView store={{ currentPid: 'p1', actions: { openTask, setView } } as unknown as AppStore} />,
  ));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

it('partitions claimable, evidence gaps, and held-back work', () => {
  const groups = partitionHealthTasks(packet.items);
  expect(groups.claimable.map((t) => t.key)).toEqual(['APP-2']);
  expect(groups.evidenceGaps.map((t) => t.key)).toEqual(['APP-1']);
  expect(groups.heldBack.map((t) => t.key)).toEqual(['APP-3']);
});

it('shows sectioned health and opens the existing task', async () => {
  vi.spyOn(api, 'projectHealth').mockResolvedValue(packet);
  await render();
  expect(container.textContent).toContain('Ready to claim · 1');
  expect(container.textContent).toContain('Evidence gaps · 1');
  expect(container.textContent).toContain('Held back · 1');
  expect(container.textContent).toContain('Readiness required');
  expect(container.textContent).toContain('Ship health chrome');
  expect(container.textContent).toContain('Blocked by APP-9');
  act(() => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('APP-1'))!.click());
  expect(openTask).toHaveBeenCalledWith('t1');
});

it('keeps Review and historical lineage entry points', async () => {
  vi.spyOn(api, 'projectHealth').mockResolvedValue(packet);
  await render();
  expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Open Review')).toBe(true);
  expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Review validity')).toBe(true);
  expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Historical evidence and lineage')).toBe(true);
});

it('shows load failure and retries without presenting empty health', async () => {
  vi.spyOn(api, 'projectHealth').mockRejectedValueOnce(new Error('offline')).mockResolvedValue(packet);
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('offline');
  expect(container.textContent).not.toContain('No open tasks');
  await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!.click());
  expect(container.textContent).toContain('Recheck phase two');
});

it('uses the live endpoint without requesting removed runner APIs', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(packet)));
  await render();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]![0]).toBe('/api/projects/p1/health-summary?offset=0');
});
