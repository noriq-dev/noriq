import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppStore } from '../store';
import { CommandPalette } from './CommandPalette';

let container: HTMLDivElement;
let root: Root | null = null;

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<CommandPalette store={{
    currentPid: 'prj_1',
    data: { projects: [] },
    permissions: { canContribute: false, canCreateProjects: false },
    helpers: { tasksOf: () => [] },
    actions: {
      setView: vi.fn(),
      selectProject: vi.fn(),
      createTask: vi.fn(),
      createProject: vi.fn(),
      toggleArchived: vi.fn(),
      openTask: vi.fn(),
    },
  } as unknown as AppStore} />));
}

function shortcut(key: string) {
  const event = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true });
  act(() => window.dispatchEvent(event));
  return event;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
});

describe('CommandPalette keyboard shortcut', () => {
  it('takes over Ctrl+F and opens search', () => {
    mount();

    const event = shortcut('f');

    expect(event.defaultPrevented).toBe(true);
    expect(container.querySelector('input')?.placeholder).toContain('search tasks, docs & plans');
  });

  it('leaves Ctrl+K available to the browser', () => {
    mount();

    const event = shortcut('k');

    expect(event.defaultPrevented).toBe(false);
    expect(container.querySelector('input')).toBeNull();
  });
});
