import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal } from './ui';

let container: HTMLDivElement;
let root: Root;

function phoneMatchMedia() {
  window.matchMedia = vi.fn((query: string) => ({
    matches: query.includes('767px') || query.includes('1023px'), media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  } as MediaQueryList));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.style.overflow = '';
  vi.restoreAllMocks();
});

function mount(onClose: () => void) {
  phoneMatchMedia();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Modal title="Phone modal" onClose={onClose}>Body</Modal>));
}

describe('phone Modal sheet delegation', () => {
  it('bottom-anchors, locks scrolling, and closes on Escape', () => {
    const onClose = vi.fn();
    mount(onClose);
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.style.borderRadius).toBe('22px 22px 0 0');
    expect(dialog.style.paddingBottom).toContain('safe-area-inset-bottom');
    expect(document.body.style.overflow).toBe('hidden');
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes only when the backdrop itself is pressed', () => {
    const onClose = vi.fn();
    mount(onClose);
    const backdrop = container.querySelector<HTMLElement>('[data-sheet-backdrop]')!;
    act(() => backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
