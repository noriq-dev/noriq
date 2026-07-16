// Theme preference: explicit choice in localStorage, else the system scheme.
import { useEffect, useState } from 'react';
import { migratedGet } from './prefs';

const KEY = 'noriq.theme';

export type Theme = 'dark' | 'light';

export function resolveTheme(): Theme {
  const stored = migratedGet(KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

export function initTheme() {
  applyTheme(resolveTheme());
  // Follow system changes only while the user hasn't chosen explicitly.
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (!migratedGet(KEY)) applyTheme(resolveTheme());
  });
}

export function toggleTheme(): Theme {
  const next: Theme = resolveTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem(KEY, next);
  applyTheme(next);
  window.dispatchEvent(new CustomEvent('noriq-theme', { detail: next }));
  return next;
}

/** Shared theme state so every toggle button (rail, mobile bar) stays in sync. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState(resolveTheme());
  useEffect(() => {
    const onChange = () => setTheme(resolveTheme());
    window.addEventListener('noriq-theme', onChange);
    return () => window.removeEventListener('noriq-theme', onChange);
  }, []);
  return [theme, () => { toggleTheme(); }];
}
