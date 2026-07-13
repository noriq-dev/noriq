// Board — kanban with milestone/category filters and breathing room.
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

export function Board({ store }: { store: AppStore }) {
  const { currentPid, helpers, actions, draggedId, snapshot } = store;
  const tasks = helpers.tasksOf(currentPid);
  const milestones = snapshot?.milestones ?? [];
  const categories = snapshot?.categories ?? [];
  const [msFilter, setMsFilter] = useState<string | null>(null);
  const [catFilter, setCatFilter] = useState<string | null>(null);
  const catById = new Map(categories.map((c) => [c.id, c]));
  const msById = new Map(milestones.map((m) => [m.id, m]));

  const visible = tasks.filter(
    (t) => (msFilter === null || t.milestoneId === msFilter) && (catFilter === null || t.categoryId === catFilter),
  );

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* filter bar */}
      <div
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '12px 22px 10px',
          overflowX: 'auto',
          borderBottom: '1px solid rgba(255,255,255,.05)',
        }}
      >
        <FilterChip label="All" active={msFilter === null} onClick={() => setMsFilter(null)} />
        {milestones.map((m) => {
          const total = tasks.filter((t) => t.milestoneId === m.id).length;
          const done = tasks.filter((t) => t.milestoneId === m.id && t.status === 'done').length;
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
        <button
          onClick={() => actions.openModal('milestone')}
          title="New milestone"
          style={{
            cursor: 'pointer', flex: 'none', fontFamily: 'var(--mono)', fontSize: 10.5,
            color: 'var(--text-dim)', border: '1px dashed rgba(255,255,255,.15)',
            padding: '4px 10px', borderRadius: 8, background: 'transparent',
          }}
          className="rail-add"
        >
          + milestone
        </button>
        {msFilter !== null && (
          <button
            onClick={() => {
              const m = msById.get(msFilter);
              if (m) actions.openMilestoneEditor({ id: m.id, title: m.title, dueAt: m.dueAt });
            }}
            title="Edit this milestone"
            style={{
              cursor: 'pointer', flex: 'none', fontFamily: 'var(--mono)', fontSize: 10.5,
              color: 'var(--accent)', border: '1px solid rgba(198,242,78,.3)',
              padding: '4px 10px', borderRadius: 8, background: 'rgba(198,242,78,.06)',
            }}
          >
            ✎ edit
          </button>
        )}
        {categories.length > 0 && <span style={{ width: 1, height: 18, background: 'rgba(255,255,255,.1)', flex: 'none', margin: '0 4px' }} />}
        {categories.map((c) => (
          <FilterChip
            key={c.id}
            label={c.name}
            dot={c.color}
            active={catFilter === c.id}
            onClick={() => setCatFilter(catFilter === c.id ? null : c.id)}
          />
        ))}
      </div>

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
                  <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,.05)' }} />
                </div>
                <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 2 }}>
                  {list.map((t) => {
                    const ag = t.claimedBy ? helpers.agentById(currentPid, t.claimedBy) : null;
                    const eff = helpers.effStatus(currentPid, t);
                    const blocked = eff === 'blocked';
                    const cat = t.categoryId ? catById.get(t.categoryId) : null;
                    const ms = t.milestoneId ? msById.get(t.milestoneId) : null;
                    const depKey = t.deps.map((d) => tasks.find((x) => x.id === d)?.key ?? '')[0] ?? '';
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
                          border: '1px solid rgba(255,255,255,.06)',
                          borderLeft: `3px solid ${cat ? cat.color : 'rgba(255,255,255,.08)'}`,
                          borderRadius: 10,
                          padding: '12px 13px',
                          cursor: 'grab',
                          opacity: draggedId === t.id ? 0.4 : 1,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 }}>
                          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: statusMeta(eff).color }}>{t.key}</span>
                          {cat && (
                            <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: cat.color, opacity: 0.9 }}>{cat.name}</span>
                          )}
                          <div style={{ flex: 1 }} />
                          {t.openComments > 0 && (
                            <MonoTag color="var(--amber)" bg="rgba(245,166,35,.12)" size={9.5}>{t.openComments} ?</MonoTag>
                          )}
                        </div>
                        <div style={{ fontSize: 12.5, lineHeight: 1.45, color: '#e0e2e6' }}>{t.title}</div>
                        {(ag || blocked || (ms && msFilter === null)) && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 9 }}>
                            {ag && (
                              <>
                                <AvatarChip name={ag.name} color={ag.color} size={18} radius={5} fontSize={8} />
                                <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-mid)' }}>{ag.name}</span>
                              </>
                            )}
                            <div style={{ flex: 1 }} />
                            {blocked && (
                              <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--red-soft)' }}>⟂ {depKey}</span>
                            )}
                            {ms && msFilter === null && !blocked && (
                              <span
                                style={{
                                  fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)',
                                  border: '1px solid rgba(255,255,255,.08)', padding: '1px 6px', borderRadius: 4,
                                  whiteSpace: 'nowrap', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis',
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

function FilterChip({ label, meta, pct, dot, active, onClick }: {
  label: string;
  meta?: string;
  pct?: number;
  dot?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        cursor: 'pointer',
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '5px 11px',
        borderRadius: 8,
        fontSize: 11.5,
        fontWeight: 500,
        background: active ? 'rgba(198,242,78,.1)' : 'rgba(255,255,255,.03)',
        color: active ? 'var(--accent)' : 'var(--text-mid)',
        border: `1px solid ${active ? 'rgba(198,242,78,.35)' : 'rgba(255,255,255,.07)'}`,
        whiteSpace: 'nowrap',
      }}
    >
      {dot && <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot }} />}
      {label}
      {meta && (
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: active ? 'var(--accent)' : 'var(--text-faint)' }}>{meta}</span>
      )}
      {pct !== undefined && (
        <span style={{ width: 30, height: 3, borderRadius: 2, background: 'rgba(255,255,255,.1)', overflow: 'hidden' }}>
          <span style={{ display: 'block', height: '100%', width: `${pct * 100}%`, background: pct === 1 ? 'var(--green)' : 'var(--blue)' }} />
        </span>
      )}
    </button>
  );
}
