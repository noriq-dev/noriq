// Board — kanban with a two-row filter bar (milestones / tags) and breathing room.
import { useState } from 'react';
import { api } from '../api';
import type { AppStore } from '../store';
import type { TaskStatus } from '../types';
import { statusMeta } from '../design';
import { AvatarChip, MonoTag } from './bits';
import { confirm, prompt } from './Dialog';

const COLUMNS: Array<[TaskStatus, string]> = [
  ['todo', 'Todo'],
  ['in_progress', 'In progress'],
  // A gate-failed task (PLNR-178) gets its own column BEFORE review — the whole point is that
  // it is NOT "awaiting review". Underneath it is a re-armable todo; here it reads as needing a
  // human. Not a drop target (store.moveTask rejects a drag into 'failed').
  ['failed', 'Failed'],
  ['review', 'Review'],
  ['done', 'Done'],
];

const TYPE_ICON: Record<string, string> = { bug: '✕', chore: '⟳', research: '?', feature: '' };

export function Board({ store }: { store: AppStore }) {
  const { currentPid, helpers, actions, draggedId, snapshot, showArchived, boardId } = store;
  const tasks = helpers.tasksOf(currentPid);
  // Milestone progress counts the *whole* milestone, archived work included — otherwise
  // finishing a milestone makes it read 0/0 as its done tasks auto-archive (PLNR-150).
  const allTasks = helpers.allTasksOf(currentPid);
  const milestones = snapshot?.milestones ?? [];
  const tags = snapshot?.tags ?? [];
  const boards = snapshot?.boards ?? [];
  const firstBoardId = boards[0]?.id ?? null;
  const [msFilter, setMsFilter] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // Attribute filters (PLNR-161): the triage axes the milestone/tag/text bar didn't cover.
  const [prioFilter, setPrioFilter] = useState(0); // minimum priority; 0 = any
  const [typeFilter, setTypeFilter] = useState('');
  const [stateFilter, setStateFilter] = useState<'' | 'unblocked' | 'grabbable' | 'overdue'>('');
  // Multi-select for bulk triage (PLNR-125): shift/cmd-click gathers cards; a plain
  // click still opens the drawer, so the two gestures never fight.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const tagById = new Map(tags.map((c) => [c.id, c]));
  const msById = new Map(milestones.map((m) => [m.id, m]));

  // A task shows on the selected board; tasks with no board (shouldn't happen post-
  // migration) fall onto the default board so nothing ever disappears.
  const onBoard = (tBoardId: string | null) =>
    boardId === null || tBoardId === boardId || (tBoardId == null && boardId === firstBoardId);

  const q = query.trim().toLowerCase();
  const stateOk = (t: (typeof tasks)[number]): boolean => {
    if (!stateFilter) return true;
    const openish = t.status !== 'done' && t.status !== 'cancelled';
    if (stateFilter === 'overdue') return openish && !!t.dueAt && new Date(t.dueAt).getTime() < Date.now();
    const unblocked = helpers.effStatus(currentPid, t) !== 'blocked';
    if (stateFilter === 'unblocked') return openish && unblocked;
    // grabbable = what an agent could claim right now.
    return t.status === 'todo' && unblocked && !t.claimedBy;
  };
  const visible = tasks.filter(
    (t) =>
      onBoard(t.boardId) &&
      (msFilter === null || t.milestoneId === msFilter) &&
      (tagFilter === null || t.tagIds.includes(tagFilter)) &&
      (prioFilter === 0 || t.priority >= prioFilter) &&
      (typeFilter === '' || t.type === typeFilter) &&
      stateOk(t) &&
      (q === '' ||
        t.title.toLowerCase().includes(q) ||
        t.key.toLowerCase().includes(q) ||
        (t.body ?? '').toLowerCase().includes(q) ||
        t.tagIds.some((id) => tagById.get(id)?.name.toLowerCase().includes(q))),
  );

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* board switcher (PLNR-80) */}
      <BoardTabs
        boards={boards}
        current={boardId}
        onSelect={(id) => actions.setBoard(id)}
        onCreate={async () => {
          const name = (await prompt('New board name:'))?.trim();
          if (name) void actions.createBoard(name);
        }}
        onRename={async (id, cur) => {
          const name = (await prompt('Rename board:', cur))?.trim();
          if (name && name !== cur) void actions.renameBoard(id, name);
        }}
        onDelete={async (id, name) => {
          if (await confirm(`Delete board "${name}"? Its tasks move to another board.`)) void actions.deleteBoard(id);
        }}
      />

      {/* filter bar — row 1: milestones (scroll) + pinned search */}
      <div
        style={{
          flex: 'none', display: 'flex', alignItems: 'center', gap: 8,
          padding: '12px 22px 8px',
        }}
      >
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, overflowX: 'auto' }}>
        <FilterChip label="All" active={msFilter === null} onClick={() => setMsFilter(null)} />
        <button
          onClick={() => actions.openModal('milestone')}
          title="New milestone"
          className="rail-add"
          style={{
            cursor: 'pointer', flex: 'none', fontFamily: 'var(--mono)', fontSize: 10.5,
            color: 'var(--text-dim)', border: '1px dashed var(--w-15)',
            padding: '4px 10px', borderRadius: 8, background: 'transparent',
          }}
        >
          + milestone
        </button>
        {milestones.map((m) => {
          const total = allTasks.filter((t) => t.milestoneId === m.id).length;
          const done = allTasks.filter((t) => t.milestoneId === m.id && t.status === 'done').length;
          // Completed milestones stay out of the way unless actively selected.
          if (total > 0 && done === total && msFilter !== m.id) return null;
          return (
            <FilterChip
              key={m.id}
              label={m.title}
              meta={`${done}/${total}`}
              pct={total ? done / total : 0}
              active={msFilter === m.id}
              onClick={() => setMsFilter(msFilter === m.id ? null : m.id)}
            />
          );
        })}
        {msFilter !== null && (
          <button
            onClick={() => {
              const m = msById.get(msFilter);
              if (m) actions.openMilestoneEditor({ id: m.id, title: m.title, dueAt: m.dueAt });
            }}
            title="Edit this milestone"
            style={{
              cursor: 'pointer', flex: 'none', fontFamily: 'var(--mono)', fontSize: 10.5,
              color: 'var(--accent-ink)', border: '1px solid rgba(198,242,78,.3)',
              padding: '4px 10px', borderRadius: 8, background: 'rgba(198,242,78,.06)',
            }}
          >
            ✎ edit
          </button>
        )}
        </div>
        <button
          onClick={() => actions.toggleArchived()}
          title={showArchived ? 'Hide archived tasks' : 'Show archived tasks'}
          style={{
            cursor: 'pointer', flex: 'none', fontFamily: 'var(--mono)', fontSize: 10.5,
            padding: '4px 10px', borderRadius: 8, whiteSpace: 'nowrap',
            color: showArchived ? 'var(--accent-ink)' : 'var(--text-dim)',
            background: showArchived ? 'rgba(198,242,78,.1)' : 'transparent',
            border: `1px solid ${showArchived ? 'rgba(198,242,78,.35)' : 'var(--w-1)'}`,
          }}
        >
          🗄 archive
        </button>
        <SearchBox value={query} onChange={setQuery} />
      </div>

      {/* filter bar — row 2: tags */}
      {(
        <div
          style={{
            flex: 'none', display: 'flex', alignItems: 'center', gap: 6,
            padding: '0 22px 10px', overflowX: 'auto',
            borderBottom: '1px solid var(--w-05)',
          }}
        >
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-faint)', flex: 'none', marginRight: 2 }}>
            tags
          </span>
          <button
            onClick={() => actions.openModal('tag')}
            title="New tag"
            className="rail-add"
            style={{
              cursor: 'pointer', flex: 'none', fontFamily: 'var(--mono)', fontSize: 10,
              color: 'var(--text-dim)', border: '1px dashed var(--w-15)',
              padding: '3px 9px', borderRadius: 8, background: 'transparent',
            }}
          >
            + tag
          </button>
          {tags.map((c) => (
            <FilterChip
              key={c.id}
              label={c.name}
              dot={c.color}
              small
              active={tagFilter === c.id}
              onClick={() => setTagFilter(tagFilter === c.id ? null : c.id)}
              onDelete={async () => {
                if (await confirm(`Delete tag "${c.name}"? It's removed from all tasks.`)) {
                  if (tagFilter === c.id) setTagFilter(null);
                  void actions.deleteTag(c.id);
                }
              }}
            />
          ))}
          <div style={{ flex: 1 }} />
          {/* Attribute filters (PLNR-161) — compose with milestone/tag/text and with
              multi-select: filter down, then shift-click + bulk act. */}
          <FilterSelect value={String(prioFilter)} onChange={(v) => setPrioFilter(Number(v))} active={prioFilter > 0}>
            <option value="0">priority: any</option>
            <option value="4">P4 only</option>
            <option value="3">P3 +</option>
            <option value="2">P2 +</option>
          </FilterSelect>
          <FilterSelect value={typeFilter} onChange={setTypeFilter} active={typeFilter !== ''}>
            <option value="">type: any</option>
            <option value="feature">feature</option>
            <option value="bug">bug</option>
            <option value="chore">chore</option>
            <option value="research">research</option>
          </FilterSelect>
          <FilterSelect value={stateFilter} onChange={(v) => setStateFilter(v as typeof stateFilter)} active={stateFilter !== ''}>
            <option value="">state: any</option>
            <option value="unblocked">unblocked</option>
            <option value="grabbable">up for grabs</option>
            <option value="overdue">overdue</option>
          </FilterSelect>
        </div>
      )}

      {/* columns */}
      <div style={{ flex: 1, minHeight: 0, overflowX: 'auto', overflowY: 'hidden', padding: '16px 22px 18px' }}>
        <div style={{ display: 'flex', gap: 18, height: '100%', minWidth: 'min-content' }}>
          {COLUMNS.map(([st, label]) => {
            const m = statusMeta(st);
            // Urgent first; the stable sort keeps board order within a priority band (PLNR-119).
            const list = visible.filter((t) => t.status === st).sort((a, b) => b.priority - a.priority);
            return (
              <div
                key={st}
                onDragOver={(e) => {
                  e.preventDefault();
                  // 'failed' is system-set (PLNR-178) — not a drop target; show the no-drop cursor.
                  e.dataTransfer.dropEffect = st === 'failed' ? 'none' : 'move';
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (draggedId != null && st !== 'failed') actions.moveTask(draggedId, st);
                }}
                className="board-col"
                style={{ width: 282, flex: 'none', display: 'flex', flexDirection: 'column', minHeight: 0 }}
              >
                <div style={{ padding: '2px 4px 12px', display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: m.dot }} />
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-soft)' }}>{label}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-faint)' }}>{list.length}</span>
                  <div style={{ flex: 1, height: 1, background: 'var(--w-05)' }} />
                </div>
                <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 2 }}>
                  {list.map((t) => {
                    const ag = t.claimedBy ? helpers.agentById(currentPid, t.claimedBy) : null;
                    const eff = helpers.effStatus(currentPid, t);
                    const blocked = eff === 'blocked';
                    const taskTags = t.tagIds.map((id) => tagById.get(id)).filter(Boolean) as Array<{ id: string; name: string; color: string }>;
                    const ms = t.milestoneId ? msById.get(t.milestoneId) : null;
                    const depKey = t.deps.map((d) => tasks.find((x) => x.id === d)?.key ?? '')[0] ?? '';
                    const typeIcon = TYPE_ICON[t.type] ?? '';
                    return (
                      <div
                        key={t.id}
                        draggable
                        onDragStart={(e) => {
                          actions.setDraggedId(t.id);
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        onDragEnd={() => actions.setDraggedId(null)}
                        onClick={(e) => {
                          if (e.shiftKey || e.metaKey || e.ctrlKey) toggleSelect(t.id);
                          else actions.openTask(t.id);
                        }}
                        className="hover-border"
                        style={{
                          background: selected.has(t.id) ? 'var(--w-06)' : 'var(--card)',
                          border: `1px solid ${selected.has(t.id) ? 'var(--accent)' : 'var(--w-06)'}`,
                          borderLeft: `3px solid ${selected.has(t.id) ? 'var(--accent)' : taskTags[0]?.color ?? 'var(--w-08)'}`,
                          borderRadius: 10,
                          padding: '12px 13px',
                          cursor: 'grab',
                          opacity: draggedId === t.id ? 0.4 : t.archivedAt ? 0.5 : 1,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 }}>
                          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: statusMeta(eff).color }}>{t.key}</span>
                          {t.archivedAt && (
                            <span style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)', border: '1px solid var(--w-1)', padding: '0 4px', borderRadius: 4 }}>🗄</span>
                          )}
                          {typeIcon && (
                            <span title={t.type} style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: t.type === 'bug' ? 'var(--red-soft)' : 'var(--text-dim)' }}>
                              {typeIcon} {t.type}
                            </span>
                          )}
                          <div style={{ flex: 1 }} />
                          {/* Default (P2) stays quiet — a badge on every card says nothing (PLNR-119). */}
                          {t.priority !== 2 && (
                            <span
                              title={`priority ${t.priority}`}
                              style={{
                                fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700,
                                color: t.priority >= 4 ? 'var(--red-soft)' : t.priority === 3 ? 'var(--amber)' : 'var(--text-faint)',
                                border: `1px solid ${t.priority >= 4 ? 'rgba(255,92,92,.4)' : t.priority === 3 ? 'rgba(245,166,35,.35)' : 'var(--w-1)'}`,
                                padding: '0 5px', borderRadius: 4,
                              }}
                            >
                              P{t.priority}
                            </span>
                          )}
                          {t.estimate !== null && (
                            <span
                              title="estimate"
                              style={{
                                fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)',
                                border: '1px solid var(--w-1)', padding: '0 5px', borderRadius: 4,
                              }}
                            >
                              {t.estimate}pt
                            </span>
                          )}
                          {t.dueAt && t.status !== 'done' && t.status !== 'cancelled' && (() => {
                            const overdue = new Date(t.dueAt).getTime() < Date.now();
                            return (
                              <span
                                title={`due ${new Date(t.dueAt).toLocaleString()}`}
                                style={{
                                  fontFamily: 'var(--mono)', fontSize: 9, fontWeight: overdue ? 700 : 400,
                                  color: overdue ? 'var(--red-soft)' : 'var(--text-faint)',
                                  border: `1px solid ${overdue ? 'rgba(255,92,92,.4)' : 'var(--w-1)'}`,
                                  padding: '0 5px', borderRadius: 4, whiteSpace: 'nowrap',
                                }}
                              >
                                {overdue ? '⚠ ' : ''}{new Date(t.dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                              </span>
                            );
                          })()}
                          {t.openComments > 0 && (
                            <MonoTag color="var(--amber)" bg="rgba(245,166,35,.12)" size={9.5}>{t.openComments} ?</MonoTag>
                          )}
                        </div>
                        <div style={{ fontSize: 12.5, lineHeight: 1.45, color: 'var(--text)' }}>{t.title}</div>
                        {(taskTags.length > 0 || ag || blocked || (ms && msFilter === null)) && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 9, flexWrap: 'wrap' }}>
                            {taskTags.map((tg) => (
                              <span
                                key={tg.id}
                                style={{
                                  display: 'inline-flex', alignItems: 'center', gap: 4,
                                  fontFamily: 'var(--mono)', fontSize: 9, color: tg.color,
                                  border: `1px solid ${tg.color}44`, padding: '1px 6px', borderRadius: 5,
                                }}
                              >
                                <span style={{ width: 5, height: 5, borderRadius: '50%', background: tg.color }} />
                                {tg.name}
                              </span>
                            ))}
                            {ag && (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                <AvatarChip name={ag.name} color={ag.color} size={16} radius={4} fontSize={7.5} />
                                <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-mid)' }}>{ag.name}</span>
                              </span>
                            )}
                            <span style={{ flex: 1 }} />
                            {blocked && (
                              <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--red-soft)' }}>⟂ {depKey}</span>
                            )}
                            {ms && msFilter === null && !blocked && (
                              <span
                                style={{
                                  fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)',
                                  border: '1px solid var(--w-08)', padding: '1px 6px', borderRadius: 4,
                                  whiteSpace: 'nowrap', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis',
                                }}
                              >
                                {ms.title}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Bulk-action bar (PLNR-125): floats only while a selection exists. */}
      {selected.size > 0 && (
        <BulkBar
          count={selected.size}
          milestones={milestones}
          boards={boards}
          onStatus={async (st) => {
            for (const id of selected) await api.updateTask(currentPid, id, { status: st });
            setSelected(new Set());
          }}
          onMilestone={async (mid) => {
            for (const id of selected) await api.updateTask(currentPid, id, { milestoneId: mid });
            setSelected(new Set());
          }}
          onBoard={async (bid) => {
            for (const id of selected) await api.updateTask(currentPid, id, { boardId: bid });
            setSelected(new Set());
          }}
          onAddTag={async () => {
            const name = (await prompt('Add tag to selected tasks:'))?.trim();
            if (!name) return;
            // addTags keeps existing tags (PLNR-135) — bulk labelling can't clobber.
            for (const id of selected) await api.updateTask(currentPid, id, { addTags: [name] });
            setSelected(new Set());
          }}
          onArchive={async () => {
            if (!(await confirm(`Archive ${selected.size} task(s)?`))) return;
            for (const id of selected) await api.archiveTask(currentPid, id).catch(() => {});
            setSelected(new Set());
          }}
          onClear={() => setSelected(new Set())}
        />
      )}
    </div>
  );
}

function BulkBar({ count, milestones, boards, onStatus, onMilestone, onBoard, onAddTag, onArchive, onClear }: {
  count: number;
  milestones: Array<{ id: string; title: string }>;
  boards: Array<{ id: string; name: string }>;
  onStatus: (st: TaskStatus) => void;
  onMilestone: (mid: string) => void;
  onBoard: (bid: string) => void;
  onAddTag: () => void;
  onArchive: () => void;
  onClear: () => void;
}) {
  const sel: React.CSSProperties = {
    background: 'var(--w-06)', border: '1px solid var(--w-1)', borderRadius: 7,
    color: 'var(--text)', fontSize: 11.5, padding: '5px 8px', fontFamily: 'inherit', cursor: 'pointer',
  };
  return (
    <div
      className="bulk-bar"
      style={{
        position: 'absolute', bottom: 18, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', alignItems: 'center', gap: 9, padding: '9px 14px',
        background: 'var(--bg-raised)', border: '1px solid var(--w-18)', borderRadius: 12,
        boxShadow: '0 8px 28px rgba(0,0,0,.45)', zIndex: 40,
      }}
    >
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--accent)', fontWeight: 700, whiteSpace: 'nowrap' }}>
        {count} selected
      </span>
      <select style={sel} defaultValue="" onChange={(e) => e.target.value && onStatus(e.target.value as TaskStatus)}>
        <option value="" disabled>status…</option>
        {(['todo', 'review', 'done', 'cancelled'] as TaskStatus[]).map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      <select style={sel} defaultValue="" onChange={(e) => e.target.value && onMilestone(e.target.value)}>
        <option value="" disabled>milestone…</option>
        {milestones.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
      </select>
      <select style={sel} defaultValue="" onChange={(e) => e.target.value && onBoard(e.target.value)}>
        <option value="" disabled>board…</option>
        {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
      <button style={{ ...sel }} onClick={onAddTag}>+ tag</button>
      <button style={{ ...sel, color: 'var(--red-soft)' }} onClick={onArchive}>archive</button>
      <button style={{ ...sel, color: 'var(--text-dim)', border: 'none', background: 'transparent' }} onClick={onClear}>✕</button>
    </div>
  );
}

function FilterSelect({ value, onChange, active, children }: {
  value: string; onChange: (v: string) => void; active: boolean; children: React.ReactNode;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        flex: 'none', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 10,
        padding: '3px 6px', borderRadius: 8,
        color: active ? 'var(--accent-ink)' : 'var(--text-dim)',
        background: active ? 'rgba(198,242,78,.06)' : 'var(--w-03)',
        border: `1px solid ${active ? 'rgba(198,242,78,.35)' : 'var(--w-08)'}`,
        outline: 'none',
      }}
    >
      {children}
    </select>
  );
}

function BoardTabs({ boards, current, onSelect, onCreate, onRename, onDelete }: {
  boards: Array<{ id: string; name: string }>;
  current: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string, name: string) => void;
}) {
  return (
    <div
      style={{
        flex: 'none', display: 'flex', alignItems: 'center', gap: 6,
        padding: '10px 22px 0', overflowX: 'auto',
      }}
    >
      {boards.map((b) => {
        const active = b.id === current;
        return (
          <div
            key={b.id}
            onClick={() => onSelect(b.id)}
            className="hover-border"
            style={{
              cursor: 'pointer', flex: 'none', display: 'flex', alignItems: 'center', gap: 7,
              padding: '6px 11px', borderRadius: '9px 9px 0 0',
              fontSize: 12.5, fontWeight: 600,
              color: active ? 'var(--text)' : 'var(--text-dim)',
              background: active ? 'var(--card)' : 'transparent',
              borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
            }}
          >
            {b.name}
            {active && (
              <>
                <span
                  role="button"
                  title="Rename board"
                  onClick={(e) => { e.stopPropagation(); onRename(b.id, b.name); }}
                  className="hover-bright"
                  style={{ color: 'var(--text-faint)', fontSize: 10.5, lineHeight: 1, cursor: 'pointer' }}
                >
                  ✎
                </span>
                {boards.length > 1 && (
                  <span
                    role="button"
                    title="Delete board"
                    onClick={(e) => { e.stopPropagation(); onDelete(b.id, b.name); }}
                    className="hover-bright"
                    style={{ color: 'var(--text-faint)', fontSize: 11, lineHeight: 1, cursor: 'pointer' }}
                  >
                    🗑
                  </span>
                )}
              </>
            )}
          </div>
        );
      })}
      <button
        onClick={onCreate}
        title="New board"
        className="rail-add"
        style={{
          cursor: 'pointer', flex: 'none', fontFamily: 'var(--mono)', fontSize: 11,
          color: 'var(--text-dim)', border: '1px dashed var(--w-15)',
          padding: '5px 11px', borderRadius: 8, background: 'transparent', marginBottom: 2,
        }}
      >
        + board
      </button>
    </div>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div
      style={{
        flex: 'none', display: 'flex', alignItems: 'center', gap: 6,
        background: 'var(--w-03)', border: '1px solid var(--w-08)',
        borderRadius: 8, padding: '0 8px', height: 28, width: 210, maxWidth: '32vw',
      }}
    >
      <span style={{ color: 'var(--text-faint)', fontSize: 12, flex: 'none' }}>⌕</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search tasks…"
        style={{
          flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none',
          color: 'var(--text-soft)', fontSize: 12, fontFamily: 'inherit',
        }}
      />
      {value && (
        <button
          onClick={() => onChange('')}
          title="Clear search"
          style={{ cursor: 'pointer', flex: 'none', color: 'var(--text-faint)', fontSize: 13, background: 'transparent', border: 'none', padding: 0, lineHeight: 1 }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

function FilterChip({ label, meta, pct, dot, active, small, onClick, onDelete }: {
  label: string;
  meta?: string;
  pct?: number;
  dot?: string;
  active: boolean;
  small?: boolean;
  onClick: () => void;
  onDelete?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        cursor: 'pointer', flex: 'none', display: 'flex', alignItems: 'center', gap: 7,
        padding: small ? '3px 9px' : '5px 11px',
        borderRadius: 8,
        fontSize: small ? 10.5 : 11.5,
        fontWeight: 500,
        background: active ? 'rgba(198,242,78,.1)' : 'var(--w-03)',
        color: active ? 'var(--accent)' : 'var(--text-mid)',
        border: `1px solid ${active ? 'rgba(198,242,78,.35)' : 'var(--w-07)'}`,
        whiteSpace: 'nowrap',
      }}
    >
      {dot && <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot }} />}
      {label}
      {meta && (
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: active ? 'var(--accent)' : 'var(--text-faint)' }}>{meta}</span>
      )}
      {pct !== undefined && (
        <span style={{ width: 30, height: 3, borderRadius: 2, background: 'var(--w-1)', overflow: 'hidden' }}>
          <span style={{ display: 'block', height: '100%', width: `${pct * 100}%`, background: pct === 1 ? 'var(--green)' : 'var(--blue)' }} />
        </span>
      )}
      {onDelete && (
        <span
          role="button"
          title="Delete tag"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          style={{ marginLeft: 1, color: 'var(--text-faint)', fontSize: 11, lineHeight: 1, cursor: 'pointer' }}
          className="hover-bright"
        >
          ✕
        </span>
      )}
    </button>
  );
}
