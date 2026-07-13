// Theme preference: explicit choice in localStorage, else the system scheme.
const KEY = 'planar.theme';

export type Theme = 'dark' | 'light';

export function resolveTheme(): Theme {
  const stored = localStorage.getItem(KEY);
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
    if (!localStorage.getItem(KEY)) applyTheme(resolveTheme());
  });
}

export function toggleTheme(): Theme {
  const next: Theme = resolveTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem(KEY, next);
  applyTheme(next);
  return next;
}
