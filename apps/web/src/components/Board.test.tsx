import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppStore } from '../store';
import type { TaskVM } from '../types';
import { Board } from './Board';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

const task = (id: string, key: string, title: string): TaskVM => ({
  id,
  key,
  title,
  body: '',
  status: 'todo',
  claimedBy: null,
  claimExpiresAt: null,
  priority: 2,
  estimate: null,
  dueAt: null,
  deps: [],
  phaseDeps: [],
  milestoneId: null,
  boardId: 'board_1',
  tagIds: [],
  type: 'feature',
  openComments: 0,
  archivedAt: null,
  specPlanned: false,
  proposedAt: null,
  spinoffRunId: null,
  spinoffSourceTaskId: null,
  spinoffFinding: null,
  workflow: null,
  comments: [],
});

function mount() {
  const tasks = [
    task('task_planned', 'BRD-1', 'Task from the release plan'),
    task('task_standalone', 'BRD-2', 'Standalone board task'),
  ];
  const store = {
    currentPid: 'project_board',
    boardId: 'board_1',
    draggedId: null,
    showArchived: false,
    permissions: { canContribute: false },
    snapshot: {
      boards: [{ id: 'board_1', name: 'Main' }],
      milestones: [],
      tags: [],
      locks: [],
      phaseTasks: [{ phaseId: 'phase_1', taskId: 'task_planned' }],
    },
    helpers: {
      tasksOf: () => tasks,
      allTasksOf: () => tasks,
      effStatus: (_pid: string, item: TaskVM) => item.status,
      agentById: () => null,
    },
    actions: {
      setBoard: vi.fn(),
      toggleArchived: vi.fn(),
      openTask: vi.fn(),
      setDraggedId: vi.fn(),
    },
  } as unknown as AppStore;

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<Board store={store} />));
}

function planSelect(): HTMLSelectElement {
  return [...container.querySelectorAll('select')].find((select) =>
    [...select.options].some((option) => option.textContent === 'plan: any'),
  )!;
}

function selectPlanFilter(value: 'planned' | 'standalone') {
  const select = planSelect();
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
});

describe('Board plan membership filter', () => {
  it('can isolate tasks in plans or tasks outside plans', () => {
    mount();
    expect(container.textContent).toContain('Task from the release plan');
    expect(container.textContent).toContain('Standalone board task');

    selectPlanFilter('planned');
    expect(container.textContent).toContain('Task from the release plan');
    expect(container.textContent).not.toContain('Standalone board task');

    selectPlanFilter('standalone');
    expect(container.textContent).not.toContain('Task from the release plan');
    expect(container.textContent).toContain('Standalone board task');
  });
});
