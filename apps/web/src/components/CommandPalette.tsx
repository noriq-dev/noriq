// Command palette (PLNR-127) — ⌘F / Ctrl+F: jump to a task, switch view or project,
// or fire a quick action without touching the mouse. Arrow keys + Enter; Esc closes.
// PLNR-186: queries also hit the server search (semantic when the instance has an
// embeddings backend, keyword otherwise) so docs, plans and task BODIES are findable —
// the local list only knows task titles/keys.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ApiSearchHit } from '../api';
import { PROJECT_NAV_ITEMS } from '../project-navigation';
import type { AppStore } from '../store';
import type { ViewId } from '../types';
import { MonoTag } from './bits';

interface Cmd {
  id: string;
  kind: 'task' | 'view' | 'project' | 'action' | 'doc' | 'plan';
  label: string;
  hint?: string;
  run: () => void;
}

const VIEW_LABELS: Array<[ViewId, string]> = [
  ...PROJECT_NAV_ITEMS.map((item): [ViewId, string] => [item.id, item.label]),
  ['ask', 'Ask'], ['home', 'Home'],
];

export function CommandPalette({ store }: { store: AppStore }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const [serverHits, setServerHits] = useState<ApiSearchHit[]>([]);
  const [searchMode, setSearchMode] = useState<'semantic' | 'keyword' | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { actions, helpers, currentPid, data } = store;

  // Debounced server search alongside the instant local matches.
  useEffect(() => {
    if (!open || q.trim().length < 3 || !currentPid) { setServerHits([]); setSearchMode(null); return; }
    const needle = q.trim();
    const t = setTimeout(() => {
      api.search(currentPid, needle, undefined, 8)
        .then((r) => { setServerHits(r.results); setSearchMode(r.mode); })
        .catch(() => { setServerHits([]); setSearchMode(null); });
    }, 220);
    return () => clearTimeout(t);
  }, [open, q, currentPid]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setOpen((o) => !o);
        setQ('');
        setIdx(0);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const commands = useMemo<Cmd[]>(() => {
    if (!open) return [];
    const close = (fn: () => void) => () => { setOpen(false); fn(); };
    const cmds: Cmd[] = [];
    for (const [view, label] of VIEW_LABELS) {
      cmds.push({ id: `view:${view}`, kind: 'view', label: `Go to ${label}`, run: close(() => actions.setView(view)) });
    }
    if (currentPid) cmds.push({ id: 'view:project-settings', kind: 'view', label: 'Go to Project Settings', run: close(() => actions.setView('project-settings')) });
    for (const p of data.projects) {
      cmds.push({ id: `proj:${p.id}`, kind: 'project', label: `Open ${p.name}`, hint: p.key, run: close(() => actions.selectProject(p.id)) });
    }
    if (store.permissions.canContribute) cmds.push({ id: 'act:new-task', kind: 'action', label: 'New task', run: close(() => actions.createTask()) });
    if (store.permissions.canCreateProjects) cmds.push({ id: 'act:new-project', kind: 'action', label: 'New project', run: close(() => actions.createProject()) });
    cmds.push({ id: 'act:toggle-archived', kind: 'action', label: 'Toggle archived tasks', run: close(() => actions.toggleArchived()) });
    for (const t of helpers.tasksOf(currentPid)) {
      cmds.push({
        id: `task:${t.id}`, kind: 'task', label: t.title, hint: t.key,
        run: close(() => actions.openTask(t.id)),
      });
    }
    return cmds;
  }, [open, data.projects, currentPid, helpers, actions, store.permissions.canContribute, store.permissions.canCreateProjects]);

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) {
      // Empty query: views + actions first — the "navigate fast" case.
      return commands.filter((c) => c.kind !== 'task').slice(0, 12);
    }
    const scored = commands
      .map((c) => {
        const hay = `${c.hint ?? ''} ${c.label}`.toLowerCase();
        let score = -1;
        if (hay.includes(needle)) score = hay.indexOf(needle) === 0 ? 2 : 1;
        else if (c.hint?.toLowerCase() === needle) score = 3;
        return { c, score };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, 12).map((x) => x.c);
  }, [q, commands]);

  // Server hits appended below the instant local matches, deduped against them.
  const allMatches = useMemo<Cmd[]>(() => {
    if (!q.trim() || !serverHits.length) return matches;
    const close = (fn: () => void) => () => { setOpen(false); fn(); };
    const seen = new Set(matches.map((c) => c.id));
    const extra: Cmd[] = [];
    for (const h of serverHits) {
      // The palette only knows how to jump to task/doc/plan; memory/episode hits (PLNR-255)
      // are for the memory explorer UI (Phase 8), not quick-open here.
      if (h.kind !== 'task' && h.kind !== 'doc' && h.kind !== 'plan') continue;
      const id = `${h.kind}:${h.id}`;
      if (seen.has(id) || seen.has(`task:${h.id}`)) continue;
      extra.push({
        id, kind: h.kind, label: h.title, hint: h.key ?? (h.kind === 'doc' ? 'doc' : 'plan'),
        run: close(() => {
          if (h.kind === 'task') actions.openTask(h.id);
          else if (h.kind === 'doc') { sessionStorage.setItem('noriq.openDoc', h.id); actions.setView('docs'); }
          else actions.setView('plans');
        }),
      });
    }
    return [...matches, ...extra].slice(0, 16);
  }, [matches, serverHits, q, actions]);

  useEffect(() => setIdx(0), [q]);

  if (!open) return null;

  const KIND_COLOR: Record<Cmd['kind'], string> = {
    task: 'var(--blue)', view: 'var(--accent-ink)', project: 'var(--amber)', action: 'var(--text-mid)',
    doc: 'var(--green, var(--accent-ink))', plan: 'var(--amber)',
  };

  return (
    <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 90, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '14vh' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 560, maxWidth: 'calc(100vw - 28px)', background: 'var(--bg-raised)', border: '1px solid var(--w-18)', borderRadius: 14, boxShadow: '0 24px 70px rgba(0,0,0,.55)', overflow: 'hidden' }}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, allMatches.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
            if (e.key === 'Enter' && allMatches[idx]) allMatches[idx]!.run();
          }}
          placeholder="Jump to a task, view, project… or search tasks, docs & plans"
          style={{ width: '100%', boxSizing: 'border-box', background: 'transparent', border: 'none', borderBottom: '1px solid var(--w-08)', padding: '14px 18px', color: 'var(--text)', fontSize: 14.5, outline: 'none', fontFamily: 'inherit' }}
        />
        <div style={{ maxHeight: 380, overflowY: 'auto', padding: 6 }}>
          {allMatches.map((c, i) => (
            <div
              key={c.id}
              onClick={() => c.run()}
              onMouseEnter={() => setIdx(i)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 9,
                cursor: 'pointer', background: i === idx ? 'var(--w-06)' : 'transparent',
              }}
            >
              <MonoTag color={KIND_COLOR[c.kind]} bg="var(--w-04)" size={8.5}>{c.kind.toUpperCase()}</MonoTag>
              {c.hint && <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)', flex: 'none' }}>{c.hint}</span>}
              <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
            </div>
          ))}
          {!allMatches.length && (
            <div style={{ padding: 22, textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>nothing matches</div>
          )}
        </div>
        <div style={{ borderTop: '1px solid var(--w-05)', padding: '7px 14px', display: 'flex', gap: 14, fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>
          <span>↑↓ navigate</span><span>↵ open</span><span>esc close</span>
          {searchMode && <span style={{ marginLeft: 'auto' }}>{searchMode} search</span>}
        </div>
      </div>
    </div>
  );
}
