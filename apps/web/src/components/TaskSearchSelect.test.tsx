import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { TaskSearchSelect, type TaskSearchOption } from './TaskSearchSelect';

let container: HTMLDivElement;
let root: Root | null = null;

const searchFields = { priority: 1, type: 'feature', projectId: 'project_1', projectKey: 'RUN', updatedAt: '2026-08-10T00:00:00.000Z' };
const alpha = { ...searchFields, id: 'task_a', key: 'RUN-12', title: 'Initial task', status: 'todo', boardId: 'board_1' } satisfies TaskSearchOption & typeof searchFields;
const target = { ...searchFields, id: 'task_target', key: 'RUN-236', title: 'Dispatch this task', status: 'todo', boardId: 'board_1' } satisfies TaskSearchOption & typeof searchFields;

function render(initialTasks: TaskSearchOption[] = []) {
  function Harness() {
    const [value, setValue] = useState('');
    return <TaskSearchSelect projectId="project_1" boardId="board_1" value={value} onChange={setValue} initialTasks={initialTasks} label="Anchor task" />;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<Harness />));
}

function inputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TaskSearchSelect', () => {
  it('performs bounded board-scoped search and preserves the selected result', async () => {
    const search = vi.spyOn(api, 'searchTasks').mockResolvedValue({ tasks: [target], matched: 1, returned: 1 });
    render([alpha]);

    const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!;
    act(() => input.focus());
    act(() => inputValue(input, 'RUN-236'));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });

    expect(search).toHaveBeenCalledWith({ projectId: 'project_1', boardId: 'board_1', text: 'RUN-236', limit: 25 }, expect.any(AbortSignal));
    const option = container.querySelector<HTMLElement>('[role="option"]')!;
    expect(option.textContent).toContain('RUN-236');
    act(() => option.click());
    expect(input.value).toContain('RUN-236 · Dispatch this task');

    act(() => input.click());
    expect(container.querySelector('[role="option"]')?.textContent).toContain('RUN-236');
  });

  it('aborts stale searches when the query changes', async () => {
    const signals: AbortSignal[] = [];
    vi.spyOn(api, 'searchTasks').mockImplementation((_input, signal) => {
      signals.push(signal!);
      return new Promise(() => {});
    });
    render();
    const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!;
    act(() => input.focus());
    act(() => inputValue(input, 'RUN'));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(signals[0]?.aborted).toBe(false);

    act(() => inputValue(input, 'RUN-236'));
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(signals).toHaveLength(2);
  });

  it('supports keyboard selection from the bounded result list', () => {
    vi.spyOn(api, 'searchTasks').mockResolvedValue({ tasks: [alpha, target], matched: 2, returned: 2 });
    render([alpha, target]);
    const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!;
    act(() => input.focus());
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(input.value).toContain('RUN-236');
  });
});
