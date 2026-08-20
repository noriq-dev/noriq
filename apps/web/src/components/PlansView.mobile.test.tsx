import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppStore } from '../store';
import { PlansView } from './PlansView';

let container: HTMLDivElement;
let root: Root | null = null;

function mobilePlanStore(): AppStore {
  const task = {
    id: 'task_1', key: 'MOB-1', title: `Keep this very long task title usable ${'on-a-phone-'.repeat(8)}`,
    status: 'in_progress', claimedBy: null, archivedAt: null,
  };
  return {
    currentPid: 'prj_1',
    snapshot: {
      plans: [{
        id: 'plan_1', title: `Mobile plan ${'with-a-long-name-'.repeat(8)}`,
        description: `A description ${'that-must-wrap-'.repeat(12)}`,
        body: '# Goal\n\nKeep every plan capability available.', status: 'active', agentId: null, archivedAt: null,
      }],
      phases: [{ id: 'phase_1', planId: 'plan_1', order: 0, title: `Phase ${'with-a-long-title-'.repeat(6)}`, body: 'Phase details stay readable.' }],
      phaseTasks: [{ phaseId: 'phase_1', taskId: 'task_1' }],
      planDocs: [{
        id: 'doc_1', planId: 'plan_1', name: `Working notes ${'with-a-long-name-'.repeat(5)}`,
        description: `Supporting context ${'that-wraps-'.repeat(10)}`, body: '## Notes\n\nMobile readers can open this.',
        authorKind: 'human', authorName: 'Mara', updatedAt: '2026-08-20T12:00:00.000Z',
      }],
    },
    data: { agents: { prj_1: [] } },
    helpers: {
      allTasksOf: () => [task],
      agentById: () => null,
      effStatus: (_pid: string, value: { status: string }) => value.status,
    },
    actions: {
      openTask: vi.fn(), setView: vi.fn(), refreshNow: vi.fn(),
      createPlanDoc: vi.fn(), updatePlanDoc: vi.fn(), deletePlanDoc: vi.fn(), deletePlan: vi.fn(),
    },
  } as unknown as AppStore;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('Plans phone composition', () => {
  it('keeps lifecycle, phases, task navigation, Jobs dispatch, and plan docs in the narrow layout', () => {
    const store = mobilePlanStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<PlansView store={store} />));

    expect(container.querySelector('[data-testid="plans-view"]')?.classList.contains('plans-view')).toBe(true);
    expect(container.querySelector('.plan-card-header')).toBeTruthy();
    expect(container.querySelector('.plan-phase-rail')).toBeTruthy();
    expect(container.querySelectorAll('.plan-lifecycle-button')).toHaveLength(2);

    act(() => container.querySelector<HTMLElement>('.plan-card-header')!.click());
    expect(container.querySelector('.plan-body')).toBeTruthy();
    expect(container.querySelector('.plan-phase')).toBeTruthy();
    expect(container.querySelector('.plan-task-grid')).toBeTruthy();
    expect(container.querySelector('.plan-docs')).toBeTruthy();

    act(() => container.querySelector<HTMLElement>('.plan-task-row')!.click());
    expect(store.actions.openTask).toHaveBeenCalledWith('task_1');

    const jobs = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('dispatch from Jobs'))!;
    act(() => jobs.click());
    expect(store.actions.setView).toHaveBeenCalledWith('runs');

    act(() => container.querySelector<HTMLElement>('.plan-doc-header')!.click());
    expect(container.querySelector('.plan-doc-body')?.textContent).toContain('Mobile readers can open this.');
  });

  it('defines phone-only reflow while leaving the shared app frame responsible for bottom-bar clearance', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/theme.css'), 'utf8');
    const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');

    expect(css).toContain('@media (max-width: 767px)');
    expect(css).toContain('.plans-view { padding: 10px 10px 16px;');
    expect(css).toContain('.plan-task-grid { grid-template-columns: minmax(0, 1fr); }');
    expect(css).toContain('.plan-dispatch-fields, .plan-dispatch-budget-fields { grid-template-columns: minmax(0, 1fr);');
    expect(app).toContain('marginBottom: phone ? MOBILE_TAB_BAR_HEIGHT : 0');
  });
});
