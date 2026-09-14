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

function mount(selectedTask: TaskVM = task, permissions = { canContribute: true, canManage: true }) {
  const moveTask = vi.fn();
  const acceptProposal = vi.fn();
  const store = {
    currentPid: 'prj_plnr',
    selectedTaskId: selectedTask.id,
    draftKind: 'comment',
    draftText: '',
    permissions,
    snapshot: {
      tags: [], milestones: [], boards: [{ id: 'board_1', name: 'Main' }], signals: [], externalTasks: [],
    },
    helpers: {
      tasksOf: () => [selectedTask],
      effStatus: () => selectedTask.status,
      agentById: () => null,
    },
    commentsHasMore: false,
    commentCounts: { open: 0, resolved: 0, total: 0 },
    user: { id: 'usr_you', email: 'you@example.com', name: 'You', role: 'admin', accessMode: 'read_write', canCreateProjects: true, canCreateGroups: true },
    actions: {
      closeTask: vi.fn(), refreshNow: vi.fn(), restoreTask: vi.fn(), archiveTask: vi.fn(),
      deleteTask: vi.fn(), openTask: vi.fn(), removeDependency: vi.fn(), addDependency: vi.fn(),
      claimToggle: vi.fn(), answerSignal: vi.fn(), acknowledgeSignal: vi.fn(), acceptProposal,
      rejectProposal: vi.fn(), setView: vi.fn(), resolveComment: vi.fn(), cycleKind: vi.fn(),
      setDraftText: vi.fn(), postComment: vi.fn(), moveTask,
    },
  } as unknown as AppStore;

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<Drawer store={store} />));
  return { moveTask, acceptProposal };
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
  it('keeps task tools in a non-wrapping cluster on the right of wrapping metadata', async () => {
    mount();
    await tick();

    const metadata = container.querySelector<HTMLElement>('[data-testid="task-header-metadata"]')!;
    const actions = container.querySelector<HTMLElement>('[data-testid="task-header-actions"]')!;
    expect(metadata.style.flex).toBe('1 1 0%');
    expect(metadata.style.minWidth).toBe('0');
    expect(metadata.style.flexWrap).toBe('wrap');
    expect(actions.style.flex).toBe('0 0 auto');
    expect(actions.style.flexWrap).toBe('nowrap');
    expect(actions.style.marginLeft).toBe('auto');
  });

  it('changes status from the task overview using every user-settable status', async () => {
    const { moveTask } = mount();
    await tick();

    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Change task status"]')!.click();
    });
    expect([...container.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.dataset.value)).toEqual([
      'todo', 'in_progress', 'blocked', 'review', 'done', 'cancelled',
    ]);

    act(() => {
      container.querySelector<HTMLElement>('[role="option"][data-value="review"]')!.click();
    });
    expect(moveTask).toHaveBeenCalledWith('task_429', 'review');
  });

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

  it('lets contributors decide a proposed task from its drawer', async () => {
    const { acceptProposal } = mount({
      ...task,
      status: 'proposed',
      proposedAt: '2026-08-14T12:00:00.000Z',
      proposal: {
        finding: 'A contributor should be able to accept this work.',
        filedBy: { kind: 'copilot', id: 'agt_copilot_123456' },
        sourceTaskId: null,
        executionId: 'exe_1',
        runId: null,
      },
    }, { canContribute: true, canManage: false });
    await tick();

    expect(container.querySelector('.task-drawer')?.textContent).toContain('Accept');
    expect(container.querySelector('.task-drawer')?.textContent).toContain('Reject');
    act(() => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Accept')!.click());
    expect(acceptProposal).toHaveBeenCalledWith(task.id);
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

describe('task comments at volume', () => {
  it('collapses a long task body behind Show more', async () => {
    vi.mocked(api.taskDetail).mockResolvedValue({
      task: { body: `${'checkpoint line\n'.repeat(20)}end`, executionSpec: null, executionSpecUnreadable: false },
      attachments: [], docs: [], signals: [], refs: [], dependencies: [], comments: [],
    } as never);
    mount();
    await tick();
    expect(container.querySelector('.task-drawer')?.textContent).toContain('Show more');
  });

  it('pins an open question above agent activity and newest notes first', async () => {
    const comments = [
      {
        id: 'cmt_old', author: 'agt_1', role: 'agent' as const, kind: 'comment' as const,
        body: 'scale-48 failed', status: 'addressed' as const,
        createdAt: '2026-09-12T10:00:00.000Z', parentCommentId: null,
      },
      {
        id: 'cmt_new', author: 'agt_1', role: 'agent' as const, kind: 'comment' as const,
        body: 'scale-50 failed', status: 'addressed' as const,
        createdAt: '2026-09-13T22:00:00.000Z', parentCommentId: null,
      },
      {
        id: 'cmt_q', author: 'usr_you', role: 'human' as const, kind: 'question' as const,
        body: 'Was CPU the cause?', status: 'open' as const,
        createdAt: '2026-09-13T21:00:00.000Z', parentCommentId: null,
      },
    ];
    const selected = {
      ...task,
      openComments: 1,
      comments,
    };
    const moveTask = vi.fn();
    const store = {
      currentPid: 'prj_plnr',
      selectedTaskId: selected.id,
      draftKind: 'comment',
      draftText: '',
      permissions: { canContribute: true, canManage: true },
      snapshot: { tags: [], milestones: [], boards: [{ id: 'board_1', name: 'Main' }], signals: [], externalTasks: [] },
      helpers: { tasksOf: () => [selected], effStatus: () => selected.status, agentById: () => ({ name: 'Astra', color: '#4c9dff' }) },
      commentsHasMore: true,
      commentCounts: { open: 1, resolved: 2, total: 3 },
      user: { id: 'usr_you', email: 'you@example.com', name: 'You', role: 'admin', accessMode: 'read_write', canCreateProjects: true, canCreateGroups: true },
      actions: {
        closeTask: vi.fn(), refreshNow: vi.fn(), restoreTask: vi.fn(), archiveTask: vi.fn(),
        deleteTask: vi.fn(), openTask: vi.fn(), removeDependency: vi.fn(), addDependency: vi.fn(),
        claimToggle: vi.fn(), answerSignal: vi.fn(), acknowledgeSignal: vi.fn(), acceptProposal: vi.fn(),
        rejectProposal: vi.fn(), setView: vi.fn(), resolveComment: vi.fn(), cycleKind: vi.fn(),
        setDraftText: vi.fn(), postComment: vi.fn(), moveTask,
      },
    } as unknown as AppStore;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<Drawer store={store} />));
    await tick();

    const panel = container.querySelector('[data-testid="drawer-comments"]')!;
    const text = panel.textContent ?? '';
    expect(text).toContain('1 need you');
    expect(text).toContain('2 notes');
    expect(text).toContain('Was CPU the cause?');
    expect(text).toContain('scale-50 failed');
    expect(text).toContain('scale-48 failed');
    expect(text.indexOf('Was CPU the cause?')).toBeLessThan(text.indexOf('scale-50 failed'));
    expect(text.indexOf('scale-50 failed')).toBeLessThan(text.indexOf('scale-48 failed'));
    expect(container.querySelector('[data-testid="load-older-comments"]')).toBeTruthy();
  });
});

