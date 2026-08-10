import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppStore } from '../store';
import type { ProjectVM } from '../types';
import { ProjectSheet } from './ProjectSheet';

const project = (id: string, key: string, name: string): ProjectVM => ({
  id, key, name, phase: '', dotColor: '#c6f24e', badge: '', hasLive: false, groupId: null,
  openTasks: 1, totalTasks: 2, doneTasks: 1, effectiveRole: 'owner', accessSource: 'owner',
  canView: true, canContribute: true, canManage: true, canOwn: true, cappedByReadOnly: false,
});

let container: HTMLDivElement;
afterEach(() => {
  container?.remove();
  document.body.style.overflow = '';
});

describe('ProjectSheet', () => {
  it('switches project while explicitly preserving the current tab', () => {
    const selectProject = vi.fn();
    const setView = vi.fn();
    const onClose = vi.fn();
    const store = {
      currentPid: 'p1', groups: [], snapshot: { locks: [] },
      data: { projects: [project('p1', 'ONE', 'One'), project('p2', 'TWO', 'Two')], agents: {} },
      helpers: { tasksOf: () => [] },
      actions: { selectProject, setView },
    } as unknown as AppStore;
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => createRoot(container).render(<ProjectSheet store={store} preserveView="board" onClose={onClose} />));

    const row = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Two'))!;
    act(() => row.click());
    expect(selectProject).toHaveBeenCalledWith('p2');
    expect(setView).toHaveBeenCalledWith('board');
    expect(onClose).toHaveBeenCalledOnce();
  });
});
