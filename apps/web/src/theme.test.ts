import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyTheme,
  getThemePreference,
  initTheme,
  resolveTheme,
  setThemePreference,
} from './theme';

type MediaListener = (event: MediaQueryListEvent) => void;

function mockMatchMedia(matchesLight: boolean) {
  const listeners = new Set<MediaListener>();
  const mql = {
    matches: matchesLight,
    media: '(prefers-color-scheme: light)',
    onchange: null as MediaListener | null,
    addListener: (listener: MediaListener) => { listeners.add(listener); },
    removeListener: (listener: MediaListener) => { listeners.delete(listener); },
    addEventListener: (_type: string, listener: MediaListener) => { listeners.add(listener); },
    removeEventListener: (_type: string, listener: MediaListener) => { listeners.delete(listener); },
    dispatchEvent: () => false,
  };
  window.matchMedia = ((query: string) => {
    if (query.includes('prefers-color-scheme: light')) return mql as MediaQueryList;
    return {
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {},
      dispatchEvent: () => false,
    } as MediaQueryList;
  }) as typeof window.matchMedia;
  return {
    setLight(next: boolean) {
      mql.matches = next;
      const event = { matches: next } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
  };
}

describe('theme preference', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    mockMatchMedia(false);
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('defaults to system and resolves from the OS scheme', () => {
    expect(getThemePreference()).toBe('system');
    expect(resolveTheme()).toBe('dark');
    mockMatchMedia(true);
    expect(resolveTheme()).toBe('light');
  });

  it('persists explicit light and dark preferences', () => {
    setThemePreference('light');
    expect(localStorage.getItem('noriq.theme')).toBe('light');
    expect(getThemePreference()).toBe('light');
    expect(resolveTheme()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');

    setThemePreference('dark');
    expect(localStorage.getItem('noriq.theme')).toBe('dark');
    expect(resolveTheme()).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('stores system explicitly and follows OS changes after initTheme', () => {
    const media = mockMatchMedia(false);
    initTheme();
    expect(document.documentElement.dataset.theme).toBe('dark');

    setThemePreference('system');
    expect(localStorage.getItem('noriq.theme')).toBe('system');
    expect(resolveTheme()).toBe('dark');

    media.setLight(true);
    expect(document.documentElement.dataset.theme).toBe('light');

    setThemePreference('dark');
    media.setLight(false);
    // Explicit preference must ignore OS flips.
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('emits noriq-theme when preference changes', () => {
    const handler = vi.fn();
    window.addEventListener('noriq-theme', handler);
    setThemePreference('light');
    expect(handler).toHaveBeenCalled();
    window.removeEventListener('noriq-theme', handler);
  });

  it('applyTheme writes data-theme', () => {
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
