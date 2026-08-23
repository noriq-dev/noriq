import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiSnapshot } from '../api';
import type { AppStore } from '../store';
import { ModalHost, activePlacementPlans } from './modals';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const placementSnapshot = {
  plans: [
    { id: 'plan_active', title: 'Release plan', status: 'active', archivedAt: null },
    { id: 'plan_archived', title: 'Retired plan', status: 'active', archivedAt: '2026-08-20T00:00:00.000Z' },
  ],
  phases: [
    { id: 'phase_build', planId: 'plan_active', title: 'Build', body: '', order: 0 },
    { id: 'phase_ship', planId: 'plan_active', title: 'Ship', body: '', order: 1 },
    { id: 'phase_old', planId: 'plan_archived', title: 'Old', body: '', order: 0 },
  ],
} as Pick<ApiSnapshot, 'plans' | 'phases'>;

let container: HTMLDivElement;
let root: Root | null = null;

function mount(store: AppStore) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<ModalHost store={store} />));
}

function dropdown(label: string) {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
}

function button(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === label)!;
}

async function choose(label: string, optionLabel: string) {
  await act(async () => {
    dropdown(label).click();
  });
  const option = [...container.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((candidate) => candidate.textContent?.trim() === optionLabel);
  expect(option).toBeDefined();
  await act(async () => {
    option!.click();
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  vi.restoreAllMocks();
});

describe('task plan placement', () => {
  it('filters archived plans and preserves ordered human-readable phases', () => {
    expect(activePlacementPlans(placementSnapshot)).toEqual([{
      id: 'plan_active', title: 'Release plan', status: 'active',
      phases: [
        { id: 'phase_build', title: 'Build', order: 0 },
        { id: 'phase_ship', title: 'Ship', order: 1 },
      ],
    }]);
  });

  it('creates a task directly in the selected plan phase', async () => {
    const submitTask = vi.fn().mockResolvedValue(undefined);
    mount({
      modal: 'task', currentPid: 'prj_1', snapshot: {
        ...placementSnapshot, milestones: [], tags: [],
      },
      data: { projects: [{ id: 'prj_1', name: 'Project One' }] },
      actions: { closeModal: vi.fn(), submitTask, openModal: vi.fn() },
    } as unknown as AppStore);

    await act(async () => {
      const title = container.querySelector<HTMLInputElement>('input[placeholder="Implement the claim arbiter"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, 'Place this work');
      title.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await choose('Task plan', 'Release plan');
    expect(dropdown('Task phase').disabled).toBe(false);
    await choose('Task phase', 'Ship');
    await act(async () => { button('Create task').click(); });

    expect(submitTask).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Place this work', phaseId: 'phase_ship',
    }));
  });

  it('loads the owning project for cross-project proposal placement', async () => {
    vi.spyOn(api, 'uiState').mockResolvedValue(placementSnapshot as ApiSnapshot);
    const submitProposalAcceptance = vi.fn().mockResolvedValue(undefined);
    mount({
      modal: 'proposal', currentPid: 'prj_other', snapshot: null,
      proposalTarget: { projectId: 'prj_owner', taskId: 'task_1', taskKey: 'OWN-1' },
      actions: { closeModal: vi.fn(), submitProposalAcceptance },
    } as unknown as AppStore);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(api.uiState).toHaveBeenCalledWith('prj_owner', 'plans');
    await act(async () => { dropdown('Proposal plan').click(); });
    expect([...container.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.textContent?.trim())).not.toContain('Retired plan');
    await act(async () => { dropdown('Proposal plan').click(); });
    await choose('Proposal plan', 'Release plan');
    await choose('Proposal phase', 'Build');
    await act(async () => { button('Accept into phase').click(); });
    expect(submitProposalAcceptance).toHaveBeenCalledWith('phase_build');
  });
});
