import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_ONLY_VIEWS, DesktopOnly, projectViewLink } from './DesktopOnly';

let container: HTMLDivElement;

afterEach(() => { container?.remove(); vi.restoreAllMocks(); });

describe('DesktopOnly mobile handoff', () => {
  it('defines every wide project tool and copies its canonical project link', async () => {
    expect(Object.keys(DESKTOP_ONLY_VIEWS)).toEqual(['graph', 'plans', 'roadmap', 'docs', 'memory', 'runs', 'agents']);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    container = document.createElement('div'); document.body.appendChild(container);
    act(() => createRoot(container).render(<DesktopOnly projectId="project one" view="graph" />));

    expect(container.textContent).toContain('Coordination graph works best on desktop');
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(writeText).toHaveBeenCalledWith(projectViewLink('project one', 'graph'));
    expect(writeText.mock.calls[0]![0]).toContain('/p/project%20one/graph');
  });
});
