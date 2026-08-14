import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import type { AppStore } from '../store';
import type { TaskVM } from '../types';
import { Drawer } from './Drawer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

const task: TaskVM = {
  id: 'task_429', key: 'PLNR-429', title: 'Keep the detail visible', body: '', status: 'todo',
  claimedBy: null, claimExpiresAt: null, priority: 2, estimate: null, dueAt: null, deps: [],
  phaseDeps: [], milestoneId: null, boardId: 'board_1', tagIds: [], type: 'feature',
  openComments: 0, archivedAt: null, specPlanned: false, proposedAt: null,
  proposal: null, workflow: null, comments: [],
};

const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

function mount(selectedTask: TaskVM = task) {
  const store = {
    currentPid: 'prj_plnr',
    selectedTaskId: selectedTask.id,
    draftKind: 'comment',
    draftText: '',
    permissions: { canContribute: true, canManage: true },
    snapshot: {
      tags: [], milestones: [], boards: [{ id: 'board_1', name: 'Main' }], signals: [], externalTasks: [],
    },
    helpers: {
      tasksOf: () => [selectedTask],
      effStatus: () => selectedTask.status,
      agentById: () => null,
    },
    actions: {
      closeTask: vi.fn(), refreshNow: vi.fn(), restoreTask: vi.fn(), archiveTask: vi.fn(),
      deleteTask: vi.fn(), openTask: vi.fn(), removeDependency: vi.fn(), addDependency: vi.fn(),
      claimToggle: vi.fn(), answerSignal: vi.fn(), acknowledgeSignal: vi.fn(), acceptProposal: vi.fn(),
      rejectProposal: vi.fn(), setView: vi.fn(), resolveComment: vi.fn(), cycleKind: vi.fn(),
      setDraftText: vi.fn(), postComment: vi.fn(),
    },
  } as unknown as AppStore;

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<Drawer store={store} />));
}

beforeEach(() => {
  vi.spyOn(api, 'taskEvents').mockResolvedValue({ events: [] });
  vi.spyOn(api, 'taskDetail').mockResolvedValue({
    task: { body: 'Canonical task detail', executionSpec: null, executionSpecUnreadable: false },
    attachments: [], docs: [], signals: [], refs: [], dependencies: [], comments: [],
  } as never);
  vi.spyOn(api, 'docs').mockResolvedValue({ docs: [] } as never);
  vi.spyOn(api, 'updateTask').mockResolvedValue({ ok: true } as never);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  vi.restoreAllMocks();
});

describe('task detail editing (PLNR-429)', () => {
  it('opens a distinct edit modal without replacing the task detail drawer', async () => {
    mount();
    await tick();

    expect(container.querySelector('.task-drawer')?.textContent).toContain('Canonical task detail');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="Edit task"]')!.click();
    });

    const dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Edit PLNR-429"]')!;
    expect(dialog).toBeTruthy();
    expect(dialog.querySelector<HTMLInputElement>('input[aria-label="Task title"]')?.value).toBe('Keep the detail visible');
    expect(container.querySelector('.task-drawer')?.textContent).toContain('Canonical task detail');
  });

  it('renders a Copilot proposal without requiring run provenance', async () => {
    mount({
      ...task,
      status: 'proposed',
      proposedAt: '2026-08-14T12:00:00.000Z',
      proposal: {
        finding: 'The selector cannot find unloaded tasks.',
        filedBy: { kind: 'copilot', id: 'agt_copilot_123456' },
        sourceTaskId: null,
        executionId: 'exe_1',
        runId: null,
      },
    });
    await tick();
    const text = container.querySelector('.task-drawer')?.textContent ?? '';
    expect(text).toContain('proposal · filed by copilot 123456');
    expect(text).toContain('The selector cannot find unloaded tasks.');
    expect(text).not.toContain('· run ');
    expect(text).toContain('Accept');
    expect(text).toContain('Reject');
  });

  it('retains Runner run provenance when it is available', async () => {
    mount({
      ...task,
      status: 'proposed',
      proposedAt: '2026-08-14T12:00:00.000Z',
      proposal: {
        finding: 'A follow-up found during verification.',
        filedBy: { kind: 'agent', id: 'agt_runner_654321' },
        sourceTaskId: null,
        executionId: 'exe_2',
        runId: 'run_abcdef123456',
      },
    });
    await tick();
    const text = container.querySelector('.task-drawer')?.textContent ?? '';
    expect(text).toContain('filed by agent 654321');
    expect(text).toContain('run 123456');
  });
});
