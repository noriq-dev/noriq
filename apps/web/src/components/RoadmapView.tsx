// Roadmap (PLNR-129) — milestone swimlanes: where each milestone stands (progress,
// due date, overdue state) and what's inside it, on one screen. The planning
// counterpart to the board's execution view.
import type { AppStore } from '../store';
import { statusMeta } from '../design';
import { MonoTag, SectionLabel } from './bits';

export function RoadmapView({ store }: { store: AppStore }) {
  const { currentPid, helpers, actions, snapshot } = store;
  // Whole-milestone accounting, archived included (the PLNR-150 lesson).
  const allTasks = helpers.allTasksOf(currentPid);
  const visible = helpers.tasksOf(currentPid);
  const milestones = [...(snapshot?.milestones ?? [])].sort((a, b) => {
    if (a.dueAt && b.dueAt) return a.dueAt < b.dueAt ? -1 : 1;
    if (a.dueAt) return -1;
    if (b.dueAt) return 1;
    return a.order - b.order;
  });

  const lanes: Array<{ id: string | null; title: string; dueAt: string | null; description?: string }> = [
    ...milestones.map((m) => ({ id: m.id as string | null, title: m.title, dueAt: m.dueAt, description: (m as { description?: string }).description })),
    { id: null, title: 'Unscheduled', dueAt: null },
  ];

  return (
    <div style={{ position: 'absolute', inset: 0, overflowY: 'auto', padding: '18px 22px' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <SectionLabel>Roadmap · {milestones.length} milestone{milestones.length === 1 ? '' : 's'}</SectionLabel>
        {lanes.map((lane) => {
          const all = allTasks.filter((t) => t.milestoneId === lane.id);
          const open = visible.filter((t) => t.milestoneId === lane.id && t.status !== 'done' && t.status !== 'cancelled');
          if (lane.id === null && open.length === 0) return null;
          const done = all.filter((t) => t.status === 'done').length;
          const pct = all.length ? done / all.length : 0;
          const overdue = !!lane.dueAt && new Date(lane.dueAt).getTime() < Date.now() && pct < 1;
          return (
            <div key={lane.id ?? 'none'} style={{ border: `1px solid ${overdue ? 'rgba(255,92,92,.35)' : 'var(--w-08)'}`, borderRadius: 13, background: 'var(--w-02)', padding: '13px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 9 }}>
                <span style={{ fontSize: 14, fontWeight: 650 }}>{lane.title}</span>
                {lane.dueAt && (
                  <MonoTag color={overdue ? 'var(--red-soft)' : 'var(--text-dim)'} bg={overdue ? 'rgba(255,92,92,.12)' : 'var(--w-05)'} size={9.5}>
                    {overdue ? '⚠ ' : ''}due {new Date(lane.dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </MonoTag>
                )}
                {lane.description && (
                  <span style={{ fontSize: 11, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                    {lane.description}
                  </span>
                )}
                <div style={{ flex: 1 }} />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: pct === 1 ? 'var(--green)' : 'var(--text-dim)' }}>
                  {done}/{all.length}
                </span>
              </div>
              <div style={{ height: 6, borderRadius: 3, background: 'var(--w-06)', overflow: 'hidden', marginBottom: open.length ? 11 : 0 }}>
                <div style={{ height: '100%', width: `${pct * 100}%`, background: pct === 1 ? 'var(--green)' : overdue ? 'var(--red-soft)' : 'var(--blue)', transition: 'width .3s' }} />
              </div>
              {open.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {open
                    .sort((a, b) => b.priority - a.priority)
                    .map((t) => {
                      const m = statusMeta(helpers.effStatus(currentPid, t));
                      return (
                        <button
                          key={t.id}
                          onClick={() => actions.openTask(t.id)}
                          title={`${t.key} · ${m.label}`}
                          style={{
                            cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
                            fontSize: 11, color: 'var(--text-soft)', background: 'var(--card)',
                            border: '1px solid var(--w-07)', borderRadius: 7, padding: '4px 9px', maxWidth: 260,
                          }}
                        >
                          <span style={{ width: 7, height: 7, borderRadius: '50%', background: m.dot, flex: 'none' }} />
                          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-dim)', flex: 'none' }}>{t.key}</span>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                        </button>
                      );
                    })}
                </div>
              )}
            </div>
          );
        })}
        {milestones.length === 0 && (
          <div style={{ padding: 48, textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)' }}>
            no milestones yet — create one from the board's filter bar to start a roadmap
          </div>
        )}
      </div>
    </div>
  );
}
