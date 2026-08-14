import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiRunner } from '../api';
import type { AppStore } from '../store';
import { JOB_STATUS_STYLE, RUN_STATUS_STYLE, RunnerJobDispatchForm } from './RunsView';

let container: HTMLDivElement;
let root: Root | null = null;

const runner = {
  id: 'runner_1', projectId: 'project_1', label: 'Runner one', status: 'online',
  capabilities: { tools: [], kinds: [], maxConcurrency: 1 }, freeSlots: 1,
  repos: [{
    id: 'repo_1', projectKey: 'RUN', projectId: 'project_1', board: null, boardId: null,
    name: 'Repository', defaultBranch: 'main', workflows: [], baseRevision: 'a'.repeat(40),
  }],
  lastHeartbeatAt: null, offboardedAt: null, version: null, createdAt: '2026-08-13T00:00:00.000Z',
} satisfies ApiRunner;

const store = {
  currentPid: 'project_1',
  snapshot: { plans: [] },
  helpers: { allTasksOf: () => [] },
} as unknown as AppStore;

function renderDispatchForm() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const onDone = vi.fn().mockResolvedValue(undefined);
  act(() => root!.render(<RunnerJobDispatchForm store={store} runners={[runner]} onDone={onDone} />));
  return onDone;
}

function inputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('run status presentation (PLNR-477)', () => {
  it('renders gated as an amber decision state, distinct from failed', () => {
    expect(RUN_STATUS_STYLE.gated).toMatchObject({ color: '#f5a623' });
    expect(RUN_STATUS_STYLE.gated).not.toEqual(RUN_STATUS_STYLE.failed);
    expect(RUN_STATUS_STYLE.gated.live).not.toBe(true);
  });
});

describe('RunnerJob status presentation (PLNR-501)', () => {
  it('keeps partial output distinct from both success and failure', () => {
    expect(JOB_STATUS_STYLE.partial).not.toEqual(JOB_STATUS_STYLE.succeeded);
    expect(JOB_STATUS_STYLE.partial).not.toEqual(JOB_STATUS_STYLE.failed);
  });
});

describe('RunnerJob dispatch target search', () => {
  it('dispatches a searched task even when the Runs snapshot contains no tasks', async () => {
    const task = {
      id: 'task_1', key: 'RUN-508', title: 'Find me remotely', status: 'todo', priority: 1, type: 'bug',
      projectId: 'project_1', projectKey: 'RUN', boardId: null, updatedAt: '2026-08-13T00:00:00.000Z',
    };
    vi.spyOn(api, 'searchTasks').mockImplementation(async (input) => ({
      tasks: input.status === 'todo' ? [task] : [], matched: input.status === 'todo' ? 1 : 0, returned: input.status === 'todo' ? 1 : 0,
    }));
    const dispatch = vi.spyOn(api, 'dispatchTaskJob').mockResolvedValue({ job: { id: 'job_1' } as never, delivered: true });
    const onDone = renderDispatchForm();

    const input = container.querySelector<HTMLInputElement>('[aria-label="Task"]')!;
    act(() => input.focus());
    act(() => inputValue(input, 'RUN-508'));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    act(() => container.querySelector<HTMLElement>('[role="option"]')!.click());
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.includes('dispatch task'))!.click();
    });

    expect(dispatch).toHaveBeenCalledWith('project_1', 'task_1', { runnerId: 'runner_1', repoRef: 'repo_1' });
    expect(onDone).toHaveBeenCalledWith('job_1');
  });

  it('dispatches a searched plan even when the Runs snapshot contains no plans', async () => {
    const plan = {
      id: 'plan_1', title: 'Remote plan', description: 'Not in the snapshot', status: 'active',
      projectId: 'project_1', projectKey: 'RUN', createdAt: '2026-08-13T00:00:00.000Z',
    };
    vi.spyOn(api, 'searchPlans').mockResolvedValue({ plans: [plan], matched: 1, returned: 1 });
    const dispatch = vi.spyOn(api, 'dispatchPlanJob').mockResolvedValue({ job: { id: 'job_2' } as never, delivered: true });
    const onDone = renderDispatchForm();

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="source"]')!.click());
    const planKind = [...container.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent?.includes('entire plan'))!;
    act(() => planKind.click());
    const input = container.querySelector<HTMLInputElement>('[aria-label="Plan"]')!;
    act(() => input.focus());
    act(() => inputValue(input, 'Remote'));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    act(() => container.querySelector<HTMLElement>('[role="option"]')!.click());
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.includes('dispatch plan'))!.click();
    });

    expect(dispatch).toHaveBeenCalledWith('project_1', 'plan_1', { runnerId: 'runner_1', repoRef: 'repo_1' });
    expect(onDone).toHaveBeenCalledWith('job_2');
  });
});
