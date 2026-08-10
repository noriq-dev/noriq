import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileTabBar } from './MobileTabBar';

let container: HTMLDivElement;
afterEach(() => container?.remove());

describe('MobileTabBar', () => {
  it('renders the five fixed destinations and the exact unresolved signal count', () => {
    const onNavigate = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => createRoot(container).render(<MobileTabBar view="board" signalCount={7} onNavigate={onNavigate} />));
    expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      '◉Feed7', '▦Board', '✦Ask', '◇Insight', '•••More',
    ]);
    expect(container.querySelector('[data-signal-badge]')?.textContent).toBe('7');
    expect(container.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe('Board');
  });
});
