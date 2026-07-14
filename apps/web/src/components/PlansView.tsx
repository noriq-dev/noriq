// Plans — how agents structure work: plan → ordered phases → tasks.
// Complexity is progressive: plans are cards with phase progress rails;
// expanding a plan reveals task chips per phase.
import { useState } from 'react';
import type { AppStore } from '../store';
import { statusMeta } from '../design';
import { AvatarChip, MonoTag, SectionLabel } from './bits';
import { Markdown } from './Markdown';

export function PlansView({ store }: { store: AppStore }) {
  const { snapshot, currentPid, helpers, actions } = store;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const plans = snapshot?.plans ?? [];
  const phases = snapshot?.phases ?? [];
  const phaseTasks = snapshot?.phaseTasks ?? [];
  const tasks = helpers.tasksOf(currentPid);
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  if (!plans.length) {
    return (
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
        <SectionLabel>No plans yet</SectionLabel>
        <div style={{ fontSize: 12.5, color: 'var(--text-mid)', maxWidth: 420, textAlign: 'center', lineHeight: 1.7 }}>
          Agents write their plans here: <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-soft)' }}>create_plan</span> takes a
          full markdown document (goals, approach, exit gate) plus ordered phases with their own details and tasks.
          Phase order is enforced — a phase-2 task can't be claimed until phase-1 is done.
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: 'absolute', inset: 0, overflowY: 'auto', padding: '18px 22px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 980, margin: '0 auto' }}>
        {plans.map((plan) => {
          const planPhases = phases.filter((ph) => ph.planId === plan.id).sort((a, b) => a.order - b.order);
          const agent = plan.agentId ? helpers.agentById(currentPid, plan.agentId) : null;
          const allTaskIds = planPhases.flatMap((ph) => phaseTasks.filter((pt) => pt.phaseId === ph.id).map((pt) => pt.taskId));
          const doneCount = allTaskIds.filter((tid) => taskById.get(tid)?.status === 'done').length;
          const open = expanded[plan.id] ?? false;
          // The active phase = first phase with unfinished tasks.
          const activeIdx = planPhases.findIndex((ph) =>
            phaseTasks.filter((pt) => pt.phaseId === ph.id).some((pt) => taskById.get(pt.taskId)?.status !== 'done'),
          );

          return (
            <div
              key={plan.id}
              style={{
                border: '1px solid var(--w-08)',
                borderRadius: 14,
                background: 'var(--w-02)',
                overflow: 'hidden',
              }}
            >
              {/* header */}
              <div
                onClick={() => setExpanded((e) => ({ ...e, [plan.id]: !open }))}
                className="hover-border"
                style={{ padding: '15px 18px', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', border: '1px solid transparent' }}
              >
                <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▸</span>
                {agent && <AvatarChip name={agent.name} color={agent.color} size={28} radius={8} fontSize={10.5} />}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 600, letterSpacing: '-.01em' }}>{plan.title}</div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {agent ? `planned by ${agent.name}` : 'planned by a human'} · {planPhases.length} phases · {doneCount}/{allTaskIds.length} tasks done
                    {plan.description ? ` · ${plan.description}` : ''}
                  </div>
                </div>
                {/* phase progress rail */}
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  {planPhases.map((ph, i) => {
                    const ids = phaseTasks.filter((pt) => pt.phaseId === ph.id).map((pt) => pt.taskId);
                    const done = ids.filter((tid) => taskById.get(tid)?.status === 'done').length;
                    const pct = ids.length ? done / ids.length : 0;
                    const isActive = i === activeIdx;
                    return (
                      <div key={ph.id} title={`${ph.title} · ${done}/${ids.length}`} style={{ width: 46 }}>
                        <div style={{ height: 5, borderRadius: 3, background: 'var(--w-08)', overflow: 'hidden', outline: isActive ? '1px solid rgba(198,242,78,.5)' : 'none' }}>
                          <div style={{ height: '100%', width: `${pct * 100}%`, background: pct === 1 ? 'var(--green)' : 'var(--blue)' }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* expanded: the plan document + stacked phases */}
              {open && (
                <div style={{ borderTop: '1px solid var(--w-06)' }}>
                  {plan.body && (
                    <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--w-05)', maxWidth: 780 }}>
                      <Markdown source={plan.body} />
                    </div>
                  )}
                  <div style={{ padding: '14px 18px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {planPhases.map((ph, i) => {
                      const ids = phaseTasks.filter((pt) => pt.phaseId === ph.id).map((pt) => pt.taskId);
                      const phaseDone = ids.filter((tid) => taskById.get(tid)?.status === 'done').length;
                      const isActive = i === activeIdx;
                      const complete = ids.length > 0 && phaseDone === ids.length;
                      return (
                        <div
                          key={ph.id}
                          style={{
                            border: `1px solid ${isActive ? 'rgba(198,242,78,.3)' : 'var(--w-07)'}`,
                            background: isActive ? 'rgba(198,242,78,.03)' : 'var(--w-015)',
                            borderRadius: 11,
                            padding: '13px 15px',
                            opacity: complete ? 0.75 : 1,
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: ph.body || ids.length ? 10 : 0 }}>
                            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: isActive ? 'var(--accent)' : 'var(--text-dim)' }}>
                              {String(i + 1).padStart(2, '0')}
                            </span>
                            <span style={{ fontSize: 13, fontWeight: 600 }}>{ph.title}</span>
                            {isActive && <MonoTag color="var(--accent)" bg="rgba(198,242,78,.12)" size={8.5}>ACTIVE</MonoTag>}
                            {complete && <MonoTag color="var(--green)" bg="rgba(63,217,139,.1)" size={8.5}>✓ DONE</MonoTag>}
                            {i > 0 && !complete && !isActive && (
                              <span title="gated on previous phase" style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>⟂ gated on {String(i).padStart(2, '0')}</span>
                            )}
                            <div style={{ flex: 1 }} />
                            <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-faint)' }}>{phaseDone}/{ids.length}</span>
                          </div>
                          {ph.body && (
                            <div style={{ marginBottom: ids.length ? 12 : 0, maxWidth: 720 }}>
                              <Markdown source={ph.body} compact />
                            </div>
                          )}
                          {ids.length > 0 && (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 6 }}>
                              {ids.map((tid) => {
                                const t = taskById.get(tid);
                                if (!t) return null;
                                const m = statusMeta(helpers.effStatus(currentPid, t));
                                const holder = t.claimedBy ? helpers.agentById(currentPid, t.claimedBy) : null;
                                return (
                                  <div
                                    key={tid}
                                    onClick={() => actions.openTask(tid)}
                                    className="hover-border"
                                    style={{
                                      display: 'flex', alignItems: 'center', gap: 7, padding: '7px 9px',
                                      borderRadius: 8, background: 'var(--card)', border: '1px solid var(--w-07)', cursor: 'pointer',
                                    }}
                                  >
                                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: m.dot, flex: 'none' }} />
                                    <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: m.color, flex: 'none' }}>{t.key}</span>
                                    <span style={{ fontSize: 11.5, color: 'var(--text-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                                    <div style={{ flex: 1 }} />
                                    {holder && <AvatarChip name={holder.name} color={holder.color} size={16} radius={4} fontSize={7.5} />}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
