// Command palette (PLNR-127) — ⌘K / Ctrl+K: jump to a task, switch view or project,
// or fire a quick action without touching the mouse. Arrow keys + Enter; Esc closes.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppStore } from '../store';
import type { ViewId } from '../types';
import { MonoTag } from './bits';

interface Cmd {
  id: string;
  kind: 'task' | 'view' | 'project' | 'action';
  label: string;
  hint?: string;
  run: () => void;
}

const VIEW_LABELS: Array<[ViewId, string]> = [
  ['control', 'Mission Control'], ['graph', 'Orchestration'], ['board', 'Board'],
  ['plans', 'Plans'], ['roadmap', 'Roadmap'], ['review', 'Review queue'], ['docs', 'Docs'],
  ['runs', 'Runs'], ['agents', 'Agents'], ['home', 'Home'],
];

export function CommandPalette({ store }: { store: AppStore }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { actions, helpers, currentPid, data } = store;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
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
    for (const p of data.projects) {
      cmds.push({ id: `proj:${p.id}`, kind: 'project', label: `Open ${p.name}`, hint: p.key, run: close(() => actions.selectProject(p.id)) });
    }
    cmds.push({ id: 'act:new-task', kind: 'action', label: 'New task', run: close(() => actions.createTask()) });
    cmds.push({ id: 'act:new-project', kind: 'action', label: 'New project', run: close(() => actions.createProject()) });
    cmds.push({ id: 'act:toggle-archived', kind: 'action', label: 'Toggle archived tasks', run: close(() => actions.toggleArchived()) });
    for (const t of helpers.tasksOf(currentPid)) {
      cmds.push({
        id: `task:${t.id}`, kind: 'task', label: t.title, hint: t.key,
        run: close(() => actions.openTask(t.id)),
      });
    }
    return cmds;
  }, [open, data.projects, currentPid, helpers, actions]);

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

  useEffect(() => setIdx(0), [q]);

  if (!open) return null;

  const KIND_COLOR: Record<Cmd['kind'], string> = {
    task: 'var(--blue)', view: 'var(--accent-ink)', project: 'var(--amber)', action: 'var(--text-mid)',
  };

  return (
    <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 90, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '14vh' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 560, maxWidth: 'calc(100vw - 28px)', background: 'var(--bg-raised)', border: '1px solid var(--w-18)', borderRadius: 14, boxShadow: '0 24px 70px rgba(0,0,0,.55)', overflow: 'hidden' }}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, matches.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
            if (e.key === 'Enter' && matches[idx]) matches[idx]!.run();
          }}
          placeholder="Jump to a task, view, project… or run an action"
          style={{ width: '100%', boxSizing: 'border-box', background: 'transparent', border: 'none', borderBottom: '1px solid var(--w-08)', padding: '14px 18px', color: 'var(--text)', fontSize: 14.5, outline: 'none', fontFamily: 'inherit' }}
        />
        <div style={{ maxHeight: 380, overflowY: 'auto', padding: 6 }}>
          {matches.map((c, i) => (
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
          {!matches.length && (
            <div style={{ padding: 22, textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>nothing matches</div>
          )}
        </div>
        <div style={{ borderTop: '1px solid var(--w-05)', padding: '7px 14px', display: 'flex', gap: 14, fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>
          <span>↑↓ navigate</span><span>↵ open</span><span>esc close</span>
        </div>
      </div>
    </div>
  );
}
