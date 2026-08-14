// PLNR-113: decodeURIComponent throws URIError on malformed %-encoding (e.g. `/p/%`).
// Called during hook init and on popstate, an unhandled throw blanked the whole app.
// safeDecode must never throw — it falls back to the raw value.
import { describe, expect, it } from 'vitest';
import { buildUrlSearch, buildViewPath, parseUrl, projectUiSurface, safeDecode } from './store';

describe('safeDecode (PLNR-113)', () => {
  it('decodes valid percent-encoding', () => {
    expect(safeDecode('a%20b')).toBe('a b');
    expect(safeDecode('PLNR')).toBe('PLNR');
  });

  it('returns the raw value instead of throwing on malformed encoding', () => {
    expect(() => safeDecode('%')).not.toThrow();
    expect(safeDecode('%')).toBe('%');
    expect(safeDecode('%E0%A4%A')).toBe('%E0%A4%A');
  });
});

describe('global Ask route', () => {
  it('parses /ask without requiring a selected project', () => {
    history.replaceState(null, '', '/ask?task=stale_project_task');
    expect(parseUrl()).toEqual({ pid: null, view: 'ask', task: null });
    history.replaceState(null, '', '/');
  });
});

describe('project Settings route (PLNR-401)', () => {
  it('keeps project settings scoped to the URL project and separate from account settings', () => {
    history.replaceState(null, '', '/p/prj_alpha/settings');
    expect(parseUrl()).toEqual({ pid: 'prj_alpha', view: 'project-settings', task: null });

    history.replaceState(null, '', '/settings');
    expect(parseUrl()).toEqual({ pid: null, view: 'settings', task: null });
    history.replaceState(null, '', '/');
  });

  it('writes the canonical project-scoped path without colliding with account settings', () => {
    expect(buildViewPath('project-settings', 'prj alpha')).toBe('/p/prj%20alpha/settings');
    expect(buildViewPath('settings', 'prj alpha')).toBe('/settings');
  });
});

describe('surface-scoped project loading (PLNR-400)', () => {
  it('maps every project route to an explicit bounded surface', () => {
    expect(projectUiSurface('control')).toBe('control');
    expect(projectUiSurface('plans')).toBe('plans');
    expect(projectUiSurface('memory')).toBe('memory');
    expect(projectUiSurface('project-settings')).toBe('project-settings');
  });

  it('treats the removed Execution route as an unknown project view', () => {
    history.replaceState(null, '', '/p/prj_alpha/executions?orchestration=old');
    expect(parseUrl()).toEqual({ pid: 'prj_alpha', view: 'control', task: null });
    expect(projectUiSurface(parseUrl().view)).toBe('control');
    history.replaceState(null, '', '/');
  });

  it('does not issue project reads for global routes', () => {
    for (const view of ['home', 'ask', 'settings', 'admin'] as const) {
      expect(projectUiSurface(view)).toBeNull();
    }
  });
});

// PLNR-287: the URL<->state sync effect used to build `location.search` from scratch as
// `?task=<id>` or `''`, which silently stripped any param the store doesn't own (the star map's
// q/kind/authority/validity/repo/branch/sel) on every render, including the very first one after
// a reload. buildUrlSearch must MERGE `task` into the existing search string instead.
describe('buildUrlSearch (PLNR-287 — merges, never replaces, location.search)', () => {
  it('preserves params this store does not own, e.g. the star map\'s q/kind/sel', () => {
    const next = buildUrlSearch('?q=race+condition&kind=decision&sel=noriq%3A%2F%2Fmemory%2Fm1', null);
    expect(next).toContain('q=race');
    expect(next).toContain('kind=decision');
    expect(next).toContain('sel=');
  });

  it('still writes/updates its own task param alongside foreign params', () => {
    const next = buildUrlSearch('?q=payments', 'task_123');
    expect(next).toContain('q=payments');
    expect(next).toContain('task=task_123');
  });

  it('removes task when deselected, leaving foreign params untouched', () => {
    const next = buildUrlSearch('?q=payments&task=task_123', null);
    expect(next).toContain('q=payments');
    expect(next).not.toContain('task=');
  });

  it('round-trips a bare task selection with no other params, same as before this fix', () => {
    expect(buildUrlSearch('', 'task_1')).toBe('?task=task_1');
    expect(buildUrlSearch('', null)).toBe('');
  });

  it('a reload with the star map mounted keeps its params across the effect (the exact regression PLNR-286 flagged)', () => {
    // Simulates: user reloads on /p/prj_1/memory?q=x&kind=decision&sel=noriq://memory/m1 — the
    // URL<->state effect fires on mount with this as `location.search` and no selectedTaskId.
    const reloadedSearch = '?q=x&kind=decision&sel=noriq%3A%2F%2Fmemory%2Fm1';
    expect(buildUrlSearch(reloadedSearch, null)).toBe(reloadedSearch);
  });
});
