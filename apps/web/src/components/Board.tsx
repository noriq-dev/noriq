// Board — kanban columns with drag & drop between statuses.
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
  const { currentPid, helpers, actions, draggedId } = store;
  const tasks = helpers.tasksOf(currentPid);

  return (
    <div style={{ position: 'absolute', inset: 0, overflowX: 'auto', overflowY: 'hidden', padding: 18 }}>
      <div style={{ display: 'flex', gap: 14, height: '100%', minWidth: 'min-content' }}>
        {COLUMNS.map(([st, label]) => {
          const m = statusMeta(st);
          const list = tasks.filter((t) => t.status === st);
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
              style={{
                width: 266,
                flex: 'none',
                display: 'flex',
                flexDirection: 'column',
                background: 'rgba(255,255,255,.02)',
                border: '1px solid rgba(255,255,255,.06)',
                borderRadius: 13,
                minHeight: 0,
              }}
            >
              <div style={{ padding: '13px 14px 11px', display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: m.dot }} />
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)' }}>{list.length}</span>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '0 10px 12px', display: 'flex', flexDirection: 'column', gap: 9 }}>
                {list.map((t) => {
                  const ag = t.claimedBy ? helpers.agentById(currentPid, t.claimedBy) : null;
                  const eff = helpers.effStatus(currentPid, t);
                  const blocked = eff === 'blocked';
                  const openC = t.comments.filter((c) => c.status === 'open').length;
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
                        border: '1px solid rgba(255,255,255,.08)',
                        borderRadius: 10,
                        padding: '11px 12px',
                        cursor: 'grab',
                        opacity: draggedId === t.id ? 0.4 : 1,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 }}>
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: statusMeta(eff).color }}>{t.key}</span>
                        <div style={{ flex: 1 }} />
                        {openC > 0 && <MonoTag color="var(--amber)" bg="rgba(245,166,35,.12)" size={9.5}>{openC} ?</MonoTag>}
                      </div>
                      <div style={{ fontSize: 12.5, lineHeight: 1.4, color: '#e0e2e6', marginBottom: 9 }}>{t.title}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        {ag ? (
                          <>
                            <AvatarChip name={ag.name} color={ag.color} size={19} radius={5} fontSize={8.5} />
                            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-mid)' }}>{ag.name}</span>
                          </>
                        ) : (
                          !blocked && <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)' }}>unclaimed</span>
                        )}
                        <div style={{ flex: 1 }} />
                        {blocked && (
                          <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--red-soft)' }}>⟂ {depKey}</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
