import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type PublicSnapshot } from '../api';
import { PublicView } from './PublicView';

let container: HTMLDivElement;
let root: Root | null = null;

const snapshot = {
  project: { id: 'prj_public', key: 'PUB', name: 'Public project', description: '' },
  tasks: [], dependencies: [], agents: [], events: [], milestones: [], boards: [],
  plans: [], phases: [], phaseTasks: [], tags: [], taskTags: [],
} as unknown as PublicSnapshot;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  vi.restoreAllMocks();
});

describe('PublicView (PLNR-475)', () => {
  it('owns a viewport-height vertical scroll container despite the locked app body', async () => {
    vi.spyOn(api, 'publicSnapshot').mockResolvedValue(snapshot);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => { root!.render(<PublicView pid="prj_public" onNotPublic={vi.fn()} />); });

    const scroll = container.querySelector<HTMLElement>('[data-testid="public-project-scroll"]')!;
    expect(scroll.style.height).toBe('100dvh');
    expect(scroll.style.overflowY).toBe('auto');
    expect(scroll.style.overscrollBehavior).toBe('contain');
  });
});
