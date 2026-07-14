// Board — kanban with a two-row filter bar (milestones / tags) and breathing room.
import { useState } from 'react';
import type { AppStore } from '../store';
import type { TaskStatus } from '../types';
import { statusMeta } from '../design';
import { AvatarChip, MonoTag } from './bits';

const COLUMNS: Array<[TaskStatus, string]> = [
  ['todo', 'Todo'],
  ['in_progress', 'In progress'],
  ['review', 'Review'],
  ['done', 'Done'],
];

const TYPE_ICON: Record<string, string> = { bug: '✕', chore: '⟳', research: '?', feature: '' };

export function Board({ store }: { store: AppStore }) {
  const { currentPid, helpers, actions, draggedId, snapshot, showArchived } = store;
  const tasks = helpers.tasksOf(currentPid);
  const milestones = snapshot?.milestones ?? [];
  const tags = snapshot?.tags ?? [];
  const [msFilter, setMsFilter] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const tagById = new Map(tags.map((c) => [c.id, c]));
  const msById = new Map(milestones.map((m) => [m.id, m]));

  const q = query.trim().toLowerCase();
  const visible = tasks.filter(
    (t) =>
      (msFilter === null || t.milestoneId === msFilter) &&
      (tagFilter === null || t.tagIds.includes(tagFilter)) &&
      (q === '' ||
        t.title.toLowerCase().includes(q) ||
        t.key.toLowerCase().includes(q) ||
        (t.body ?? '').toLowerCase().includes(q) ||
        t.tagIds.some((id) => tagById.get(id)?.name.toLowerCase().includes(q))),
  );

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
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
          const total = tasks.filter((t) => t.milestoneId === m.id).length;
          const done = tasks.filter((t) => t.milestoneId === m.id && t.status === 'done').length;
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
              onDelete={() => {
                if (confirm(`Delete tag "${c.name}"? It's removed from all tasks.`)) {
                  if (tagFilter === c.id) setTagFilter(null);
                  void actions.deleteTag(c.id);
                }
              }}
            />
          ))}
        </div>
      )}

      {/* columns */}
      <div style={{ flex: 1, minHeight: 0, overflowX: 'auto', overflowY: 'hidden', padding: '16px 22px 18px' }}>
        <div style={{ display: 'flex', gap: 18, height: '100%', minWidth: 'min-content' }}>
          {COLUMNS.map(([st, label]) => {
            const m = statusMeta(st);
            const list = visible.filter((t) => t.status === st);
            return (
              <div
                key={st}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (draggedId != null) actions.moveTask(draggedId, st);
                }}
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
                        onClick={() => actions.openTask(t.id)}
                        className="hover-border"
                        style={{
                          background: 'var(--card)',
                          border: '1px solid var(--w-06)',
                          borderLeft: `3px solid ${taskTags[0]?.color ?? 'var(--w-08)'}`,
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
