// Theme preference: light | dark | system (follow OS). Persisted in localStorage.
import { useEffect, useState } from 'react';

const KEY = 'noriq.theme';

export type Theme = 'dark' | 'light';
export type ThemePreference = Theme | 'system';

const THEME_EVENT = 'noriq-theme';

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Stored preference. Missing/unknown → system (same as historic unset behaviour). */
export function getThemePreference(): ThemePreference {
  const stored = localStorage.getItem(KEY);
  if (stored === 'dark' || stored === 'light' || stored === 'system') return stored;
  return 'system';
}

/** Resolved applied scheme (never `'system'`). */
export function resolveTheme(preference: ThemePreference = getThemePreference()): Theme {
  return preference === 'system' ? systemTheme() : preference;
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

function emitThemeChange() {
  window.dispatchEvent(new CustomEvent(THEME_EVENT, {
    detail: { theme: resolveTheme(), preference: getThemePreference() },
  }));
}

export function setThemePreference(preference: ThemePreference) {
  localStorage.setItem(KEY, preference);
  applyTheme(resolveTheme(preference));
  emitThemeChange();
}

/** @deprecated Prefer setThemePreference — kept for any leftover toggle callers. */
export function toggleTheme(): Theme {
  const next: Theme = resolveTheme() === 'dark' ? 'light' : 'dark';
  setThemePreference(next);
  return next;
}

export function initTheme() {
  applyTheme(resolveTheme());
  // Follow OS only while preference is system (including legacy unset → system).
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (getThemePreference() !== 'system') return;
    applyTheme(resolveTheme());
    emitThemeChange();
  });
}

/**
 * Shared theme state so every control (rail, mobile bar, floating) stays in sync.
 * Tuple: [resolved scheme, setPreference, stored preference].
 */
export function useTheme(): [Theme, (preference: ThemePreference) => void, ThemePreference] {
  const [theme, setTheme] = useState(resolveTheme);
  const [preference, setPreferenceState] = useState(getThemePreference);
  useEffect(() => {
    const onChange = () => {
      setTheme(resolveTheme());
      setPreferenceState(getThemePreference());
    };
    window.addEventListener(THEME_EVENT, onChange);
    return () => window.removeEventListener(THEME_EVENT, onChange);
  }, []);
  return [theme, setThemePreference, preference];
}
