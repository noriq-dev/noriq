import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useViewport } from './viewport';

type Listener = () => void;

function installMatchMedia(width: number) {
  let currentWidth = width;
  const listeners = new Set<Listener>();
  window.matchMedia = vi.fn((query: string) => ({
    get matches() {
      const max = Number(query.match(/max-width: (\d+)px/)?.[1] ?? Number.POSITIVE_INFINITY);
      return currentWidth <= max;
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: Listener) => { listeners.add(listener); },
    removeEventListener: (_type: string, listener: Listener) => { listeners.delete(listener); },
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList));
  return (nextWidth: number) => {
    currentWidth = nextWidth;
    for (const listener of listeners) listener();
  };
}

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

function Probe() {
  const viewport = useViewport();
  return <output>{viewport.kind}</output>;
}

describe('useViewport', () => {
  it('tracks phone, tablet and desktop changes without a remount', () => {
    const rotate = installMatchMedia(390);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Probe />));
    expect(container.textContent).toBe('phone');

    act(() => rotate(768));
    expect(container.textContent).toBe('tablet');

    act(() => rotate(1024));
    expect(container.textContent).toBe('desktop');
  });
});
