import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ThemeButton } from './ThemeButton';
import { getThemePreference, setThemePreference } from '../theme';

let container: HTMLDivElement;
let root: Root | null = null;

function render(node: ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  setThemePreference('system');
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  localStorage.clear();
});

describe('ThemeButton', () => {
  it('opens a light / system / dark segmented control and persists the choice', () => {
    render(<ThemeButton />);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
    expect(trigger.getAttribute('aria-label')).toMatch(/Appearance: System/i);

    act(() => trigger.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-label')).toBe('Appearance');
    const radios = [...dialog.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(radios.map((radio) => radio.textContent)).toEqual(
      expect.arrayContaining([expect.stringMatching(/Light/i), expect.stringMatching(/System/i), expect.stringMatching(/Dark/i)]),
    );

    const dark = radios.find((radio) => /Dark/i.test(radio.textContent ?? ''))!;
    act(() => dark.click());
    expect(getThemePreference()).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('selects system and keeps the preference as system', () => {
    setThemePreference('light');
    render(<ThemeButton label />);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
    expect(trigger.textContent).toMatch(/Light/i);
    act(() => trigger.click());
    const system = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((radio) => /System/i.test(radio.textContent ?? ''))!;
    act(() => system.click());
    expect(getThemePreference()).toBe('system');
  });
});
