// Plans — how agents structure work: plan → ordered phases → tasks.
// Complexity is progressive: plans are cards with phase progress rails;
// expanding a plan reveals task chips per phase.
import { useEffect, useState } from 'react';
import { isSettledTaskStatus } from '@noriq-dev/shared';
import { api } from '../api';
import type { AppStore } from '../store';
import { statusMeta } from '../design';
import { AvatarChip, MonoTag, SectionLabel } from './bits';
import { Button, ErrorNote, Field, Modal, Select, TextArea, TextInput } from './ui';
import { Markdown } from './Markdown';
import { confirm } from './Dialog';

/**
 * The active phase = the first phase still holding unfinished work.
 *
 * "Unfinished" has to mean here exactly what it means in the server's phase-order gate
 * (PLNR-229). It did not: the gate reads `NOT IN ('done','cancelled')` while this view asked
 * `!== 'done'`, so a single CANCELLED task pinned a plan to its phase permanently — the server
 * had long since opened the next one, but the UI showed the plan stuck behind work that was
 * never coming back. Exported (and pure) so the rule is testable on its own rather than only
 * observable through a rendered plan card.
 *
 * Returns -1 when every phase is settled, which `findIndex` gives us and callers read as
 * "no phase is active" — a finished plan highlights nothing.
 */
export function activePhaseIndex(
  phases: { id: string }[],
  phaseTasks: { phaseId: string; taskId: string }[],
  statusOf: (taskId: string) => string | undefined,
): number {
  return phases.findIndex((ph) =>
    phaseTasks.filter((pt) => pt.phaseId === ph.id).some((pt) => !isSettledTaskStatus(statusOf(pt.taskId))),
  );
}

export const PLAN_ARCHIVE_TASK_CANCELLATION_OPTIONS = [
  { value: 'none', label: 'Keep task statuses unchanged' },
  { value: 'open', label: 'Cancel open tasks' },
  { value: 'all', label: 'Cancel every associated task' },
] as const;

export const PLAN_DELETE_TASK_DISPOSITION_OPTIONS = [
  { value: 'orphan', label: 'Keep and orphan tasks' },
  { value: 'cancel', label: 'Cancel and keep tasks' },
  { value: 'delete', label: 'Permanently delete tasks' },
] as const;

type PlanArchiveTaskCancellation = typeof PLAN_ARCHIVE_TASK_CANCELLATION_OPTIONS[number]['value'];
type PlanDeleteTaskDisposition = typeof PLAN_DELETE_TASK_DISPOSITION_OPTIONS[number]['value'];

export function PlansView({ store }: { store: AppStore }) {
  const { snapshot, currentPid, helpers, actions } = store;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Archived plans hide by default (PLNR-148) — a display concern, nothing else changes.
  const [showArchived, setShowArchived] = useState(false);
  const [lifecycle, setLifecycle] = useState<{
    kind: 'archive' | 'delete'; id: string; title: string; openTasks: number; allTasks: number;
  } | null>(null);
  const [archiveTaskCancellation, setArchiveTaskCancellation] = useState<PlanArchiveTaskCancellation>('none');
  const [deleteDisposition, setDeleteDisposition] = useState<PlanDeleteTaskDisposition>('orphan');
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const allPlans = snapshot?.plans ?? [];
  const archivedCount = allPlans.filter((p) => p.archivedAt).length;
  const plans = showArchived ? allPlans : allPlans.filter((p) => !p.archivedAt);
  const phases = snapshot?.phases ?? [];
  const phaseTasks = snapshot?.phaseTasks ?? [];
  const planDocs = snapshot?.planDocs ?? [];
  // Every task, archived included (PLNR-150). Phase membership comes from phase_tasks,
  // which never dropped archived rows — so resolving through a filtered list counted an
  // archived task in the denominator but never as done, decaying a finished plan toward
  // 0/N and pinning "active" on phase 1 forever.
  const tasks = helpers.allTasksOf(currentPid);
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  useEffect(() => {
    const planId = sessionStorage.getItem('noriq.openPlan');
    if (!planId || !allPlans.some((plan) => plan.id === planId)) return;
    setExpanded((current) => ({ ...current, [planId]: true }));
    sessionStorage.removeItem('noriq.openPlan');
  }, [allPlans]);

  if (!allPlans.length) {
    return (
      <div className="plans-empty">
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
    <div className="plans-view" data-testid="plans-view">
      <div className="plans-stack">
        {archivedCount > 0 && (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              onClick={() => setShowArchived(!showArchived)}
              style={{
                cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 10, padding: '4px 10px', borderRadius: 8,
                color: showArchived ? 'var(--accent-ink)' : 'var(--text-dim)',
                background: showArchived ? 'rgba(198,242,78,.06)' : 'transparent',
                border: `1px solid ${showArchived ? 'rgba(198,242,78,.35)' : 'var(--w-1)'}`,
              }}
            >
              {showArchived ? 'hide' : 'show'} archived · {archivedCount}
            </button>
          </div>
        )}
        {plans.map((plan) => {
          const planPhases = phases.filter((ph) => ph.planId === plan.id).sort((a, b) => a.order - b.order);
          const agent = plan.agentId ? helpers.agentById(currentPid, plan.agentId) : null;
          const allTaskIds = planPhases.flatMap((ph) => phaseTasks.filter((pt) => pt.phaseId === ph.id).map((pt) => pt.taskId));
          const doneCount = allTaskIds.filter((tid) => isSettledTaskStatus(taskById.get(tid)?.status)).length;
          const openTaskCount = allTaskIds.length - doneCount;
          const open = expanded[plan.id] ?? false;
          const proposed = plan.status === 'proposed';
          // Approving a plan approves what its tasks say (RUN-162). `specPlanned` rides on the
          // snapshot as a BOOLEAN — the spec itself is a detail read, and shipping every one of
          // them through the board's poll to draw a count would be the whole feature's payload for
          // a number.
          const unplanned = proposed
            ? allTaskIds.filter((id) => !taskById.get(id)?.specPlanned).length
            : 0;
          const activeIdx = activePhaseIndex(planPhases, phaseTasks, (tid) => taskById.get(tid)?.status);

          return (
            <div
              key={plan.id}
              className="plan-card"
              style={{
                border: `1px solid ${proposed ? 'rgba(245,166,35,.45)' : 'var(--w-08)'}`,
                borderRadius: 14,
                background: proposed ? 'rgba(245,166,35,.05)' : 'var(--w-02)',
                overflow: 'hidden',
                opacity: plan.archivedAt ? 0.55 : 1,
              }}
            >
              {/* header */}
              <div
                onClick={() => setExpanded((e) => ({ ...e, [plan.id]: !open }))}
                className="plan-card-header hover-border"
              >
                <span className="plan-card-chevron" style={{ transform: open ? 'rotate(90deg)' : 'none' }}>▸</span>
                {agent && <AvatarChip name={agent.name} color={agent.color} size={28} radius={8} fontSize={10.5} />}
                <div className="plan-card-summary">
                  <div className="plan-card-title">
                    {plan.title}
                    {proposed && <MonoTag color="#f5a623" bg="rgba(245,166,35,.14)" size={9}>PROPOSED</MonoTag>}
                    {plan.archivedAt && <MonoTag color="var(--text-faint)" bg="var(--w-05)" size={9}>ARCHIVED</MonoTag>}
                  </div>
                  <div className="plan-card-meta">
                    {agent ? `planned by ${agent.name}` : 'planned by a human'} · {planPhases.length} phases · {doneCount}/{allTaskIds.length} tasks settled
                    {plan.description ? ` · ${plan.description}` : ''}
                  </div>
                </div>
                {/* phase progress rail */}
                <div className="plan-phase-rail" aria-label={`${doneCount} of ${allTaskIds.length} plan tasks settled`}>
                  {planPhases.map((ph, i) => {
                    const ids = phaseTasks.filter((pt) => pt.phaseId === ph.id).map((pt) => pt.taskId);
                    const done = ids.filter((tid) => isSettledTaskStatus(taskById.get(tid)?.status)).length;
                    const pct = ids.length ? done / ids.length : 0;
                    const isActive = i === activeIdx;
                    return (
                      <div className="plan-phase-segment" key={ph.id} title={`${ph.title} · ${done}/${ids.length}`}>
                        <div style={{ height: 5, borderRadius: 3, background: 'var(--w-08)', overflow: 'hidden', outline: isActive ? '1px solid rgba(198,242,78,.5)' : 'none' }}>
                          <div style={{ height: '100%', width: `${pct * 100}%`, background: pct === 1 ? 'var(--green)' : 'var(--blue)' }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="plan-card-lifecycle-actions">
                  <button
                    type="button"
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (plan.archivedAt) await api.restorePlan(currentPid, plan.id);
                      else {
                        setArchiveTaskCancellation('none');
                        setLifecycleError(null);
                        setLifecycle({ kind: 'archive', id: plan.id, title: plan.title, openTasks: openTaskCount, allTasks: allTaskIds.length });
                        return;
                      }
                      actions.refreshNow();
                    }}
                    title={plan.archivedAt ? 'Restore plan' : 'Archive plan (hides it; everything stays in force)'}
                    className="plan-lifecycle-button drawer-x"
                  >
                    {plan.archivedAt ? '↩' : '🗄'}
                  </button>
                  <button
                    type="button"
                    onClick={async (e) => {
                      e.stopPropagation();
                      setDeleteDisposition('orphan');
                      setLifecycleError(null);
                      setLifecycle({ kind: 'delete', id: plan.id, title: plan.title, openTasks: openTaskCount, allTasks: allTaskIds.length });
                    }}
                    title="Delete plan"
                    className="plan-lifecycle-button plan-delete-button drawer-x"
                  >
                    🗑
                  </button>
                </div>
              </div>

              {/* the mandatory human gate (RUN-23): approve → tasks become claimable */}
              {proposed && (
                <div
                  className="plan-proposal-gate"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                    padding: '11px 18px', borderTop: '1px solid rgba(245,166,35,.2)',
                    background: 'rgba(245,166,35,.06)',
                  }}
                >
                  <span className="plan-proposal-copy" style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#f5a623' }}>
                    ⏳ awaiting your approval — its {allTaskIds.length} task{allTaskIds.length === 1 ? '' : 's'} can't be claimed or dispatched until you approve
                    {/* What is actually being approved (RUN-162). Approving a plan approves what
                        its tasks SAY, and a task with no execution spec is one whose scope and
                        definition of done its builder will decide for itself — which is a thing to
                        know before clicking, not after. Counted from the snapshot, so it costs no
                        request; the spec itself lives on the detail read and is read in the
                        drawer. */}
                    {unplanned > 0 && (
                      <>
                        {' · '}
                        <span style={{ color: 'var(--text-mid)' }}>
                          {unplanned} of them {unplanned === 1 ? 'has' : 'have'} no execution spec — whoever picks {unplanned === 1 ? 'it' : 'them'} up decides the scope
                        </span>
                      </>
                    )}
                  </span>
                  <div className="plan-flex-spacer" style={{ flex: 1 }} />
                  <Button
                    variant="primary"
                    style={{ padding: '6px 16px', fontSize: 12 }}
                    onClick={async (e) => {
                      e.stopPropagation();
                      await store.actions.approvePlan(plan.id);
                    }}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="danger"
                    style={{ padding: '6px 14px', fontSize: 12 }}
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (await confirm(`Reject "${plan.title}"? Its un-started tasks are cancelled and the plan is discarded.`)) {
                        await store.actions.rejectPlan(plan.id);
                      }
                    }}
                  >
                    Reject
                  </Button>
                </div>
              )}

              {/* expanded: the plan document + stacked phases */}
              {open && (
                <div className="plan-expanded">
                  {plan.body && (
                    <div className="plan-body">
                      <Markdown source={plan.body} />
                    </div>
                  )}
                  <div className="plan-phases">
                    {planPhases.map((ph, i) => {
                      const ids = phaseTasks.filter((pt) => pt.phaseId === ph.id).map((pt) => pt.taskId);
                      const phaseDone = ids.filter((tid) => isSettledTaskStatus(taskById.get(tid)?.status)).length;
                      const isActive = i === activeIdx;
                      const complete = ids.length > 0 && phaseDone === ids.length;
                      return (
                        <div
                          key={ph.id}
                          className="plan-phase"
                          style={{
                            border: `1px solid ${isActive ? 'rgba(198,242,78,.3)' : 'var(--w-07)'}`,
                            background: isActive ? 'rgba(198,242,78,.03)' : 'var(--w-015)',
                            borderRadius: 11,
                            padding: '13px 15px',
                            opacity: complete ? 0.75 : 1,
                          }}
                        >
                          <div className="plan-phase-header" style={{ marginBottom: ph.body || ids.length ? 10 : 0 }}>
                            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: isActive ? 'var(--accent)' : 'var(--text-dim)' }}>
                              {String(i + 1).padStart(2, '0')}
                            </span>
                            <span className="plan-phase-title">{ph.title}</span>
                            {isActive && <MonoTag color="var(--accent)" bg="rgba(198,242,78,.12)" size={8.5}>ACTIVE</MonoTag>}
                            {complete && <MonoTag color="var(--green)" bg="rgba(63,217,139,.1)" size={8.5}>✓ DONE</MonoTag>}
                            {i > 0 && !complete && !isActive && (
                              <span title="gated on previous phase" style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>⟂ gated on {String(i).padStart(2, '0')}</span>
                            )}
                            <div className="plan-flex-spacer" style={{ flex: 1 }} />
                            <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-faint)' }}>{phaseDone}/{ids.length}</span>
                          </div>
                          {ph.body && (
                            <div className="plan-phase-body" style={{ marginBottom: ids.length ? 12 : 0 }}>
                              <Markdown source={ph.body} compact />
                            </div>
                          )}
                          {ids.length > 0 && (
                            <div className="plan-task-grid">
                              {ids.map((tid) => {
                                const t = taskById.get(tid);
                                if (!t) return null;
                                const m = statusMeta(helpers.effStatus(currentPid, t));
                                const holder = t.claimedBy ? helpers.agentById(currentPid, t.claimedBy) : null;
                                return (
                                  <div
                                    key={tid}
                                    onClick={() => actions.openTask(tid)}
                                    className="plan-task-row hover-border"
                                    style={{
                                      display: 'flex', alignItems: 'center', gap: 7, padding: '7px 9px',
                                      borderRadius: 8, background: 'var(--card)', border: '1px solid var(--w-07)', cursor: 'pointer',
                                      opacity: t.archivedAt ? 0.55 : 1,
                                    }}
                                  >
                                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: m.dot, flex: 'none' }} />
                                    <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: m.color, flex: 'none' }}>{t.key}</span>
                                    {t.archivedAt && (
                                      <span title="archived" style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)', flex: 'none' }}>🗄</span>
                                    )}
                                    <span className="plan-task-title">{t.title}</span>
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
                  <PlanDocsPanel planId={plan.id} docs={planDocs.filter((d) => d.planId === plan.id)} store={store} readOnly={!!plan.archivedAt} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {lifecycle && (
        <Modal
          title={lifecycle.kind === 'archive' ? `Archive “${lifecycle.title}”` : `Delete “${lifecycle.title}”`}
          subtitle={`${lifecycle.allTasks} associated task${lifecycle.allTasks === 1 ? '' : 's'} · ${lifecycle.openTasks} open`}
          onClose={() => !lifecycleBusy && setLifecycle(null)}
          width={500}
        >
          {lifecycle.kind === 'archive' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-soft)' }}>
                Archiving hides the plan from the default view. Its phases and task associations remain available if the plan is restored.
              </div>
              {PLAN_ARCHIVE_TASK_CANCELLATION_OPTIONS.map(({ value, label }) => {
                const description = value === 'none'
                  ? 'Archive only; no task status or claim changes.'
                  : value === 'open'
                    ? lifecycle.openTasks
                      ? `${lifecycle.openTasks} unfinished task${lifecycle.openTasks === 1 ? '' : 's'} will be cancelled and any active claims released.`
                      : 'This plan has no open tasks to cancel.'
                    : `${lifecycle.allTasks} associated task${lifecycle.allTasks === 1 ? '' : 's'} will be cancelled, including tasks in done or review, and any active claims released.`;
                return (
                  <label className="plan-lifecycle-choice" key={value} style={{ borderColor: archiveTaskCancellation === value ? 'rgba(198,242,78,.45)' : 'var(--w-1)' }}>
                    <input
                      type="radio"
                      name="plan-archive-task-cancellation"
                      value={value}
                      checked={archiveTaskCancellation === value}
                      onChange={() => setArchiveTaskCancellation(value)}
                      style={{ marginTop: 2 }}
                    />
                    <span>
                      <span style={{ display: 'block', fontSize: 12.5, fontWeight: 650 }}>{label}</span>
                      <span style={{ display: 'block', marginTop: 3, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>{description}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-soft)', marginBottom: 2 }}>
                Deleting the plan permanently removes its phases and plan-local documents. Choose what happens to its associated tasks.
              </div>
              {PLAN_DELETE_TASK_DISPOSITION_OPTIONS.map(({ value, label }) => {
                const description = value === 'orphan'
                  ? 'Remove the plan association while keeping every task and its history.'
                  : value === 'cancel'
                    ? `Mark all ${lifecycle.allTasks} associated tasks cancelled, including done or review, while keeping their history.`
                    : `Delete all ${lifecycle.allTasks} associated tasks and their comments, attachments, claims, and references.`;
                return (
                  <label className="plan-lifecycle-choice" key={value} style={{ borderColor: deleteDisposition === value ? 'rgba(198,242,78,.45)' : 'var(--w-1)' }}>
                    <input type="radio" name="plan-task-disposition" value={value} checked={deleteDisposition === value} onChange={() => setDeleteDisposition(value)} style={{ marginTop: 2 }} />
                    <span>
                      <span style={{ display: 'block', fontSize: 12.5, fontWeight: 650 }}>{label}</span>
                      <span style={{ display: 'block', marginTop: 3, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>{description}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          {lifecycleError && <div style={{ marginTop: 14 }}><ErrorNote>{lifecycleError}</ErrorNote></div>}
          <div className="plan-modal-actions" style={{ marginTop: 20 }}>
            <Button variant="ghost" disabled={lifecycleBusy} onClick={() => setLifecycle(null)}>Cancel</Button>
            <Button
              variant={lifecycle.kind === 'delete' ? 'danger' : 'primary'}
              disabled={lifecycleBusy}
              onClick={async () => {
                setLifecycleBusy(true); setLifecycleError(null);
                try {
                  if (lifecycle.kind === 'archive') {
                    await api.archivePlan(currentPid, lifecycle.id, { taskCancellation: archiveTaskCancellation });
                    actions.refreshNow();
                  } else {
                    await store.actions.deletePlan(lifecycle.id, deleteDisposition);
                  }
                  setLifecycle(null);
                } catch (error) {
                  setLifecycleError(error instanceof Error ? error.message : 'Could not update plan.');
                } finally {
                  setLifecycleBusy(false);
                }
              }}
            >
              {lifecycleBusy ? 'Working…' : lifecycle.kind === 'archive' ? 'Archive plan' : 'Delete plan'}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// Plan-local docs (PLNR-200): working documents that belong to this plan — NOT project docs.
// They aren't searchable/indexed and carry no "settled decisions only" rule, so a plan can
// keep design notes and supporting material that evolve as it does, without touching the
// project knowledge base.
type PlanDoc = { id: string; planId: string; name: string; description: string; body: string; authorKind: string; authorName: string; updatedAt: string };
function PlanDocsPanel({ planId, docs, store, readOnly }: { planId: string; docs: PlanDoc[]; store: AppStore; readOnly: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null);
  // editing: null = closed, {} = new doc, {id...} = editing existing
  const [editing, setEditing] = useState<{ id?: string; name: string; description: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const docId = sessionStorage.getItem('noriq.openPlanDoc');
    if (!docId || !docs.some((doc) => doc.id === docId)) return;
    setOpenId(docId);
    sessionStorage.removeItem('noriq.openPlanDoc');
  }, [docs]);

  const save = async () => {
    if (!editing || !editing.name.trim()) { setErr('name required'); return; }
    setBusy(true); setErr(null);
    try {
      if (editing.id) await store.actions.updatePlanDoc(planId, editing.id, { name: editing.name, description: editing.description, body: editing.body });
      else await store.actions.createPlanDoc(planId, { name: editing.name, description: editing.description, body: editing.body });
      setEditing(null);
    } catch (e) { setErr(e instanceof Error ? e.message : 'save failed'); }
    finally { setBusy(false); }
  };

  return (
    <div className="plan-docs">
      <div className="plan-docs-header" style={{ marginBottom: docs.length ? 10 : 0 }}>
        <SectionLabel>Documents</SectionLabel>
        <span title="Working docs scoped to this plan — not searchable, not project docs" style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>
          plan-local · {docs.length}
        </span>
        <div className="plan-flex-spacer" style={{ flex: 1 }} />
        {!readOnly && (
          <button
            onClick={() => { setEditing({ name: '', description: '', body: '' }); setErr(null); }}
            className="hover-border"
            style={{ cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 10, padding: '4px 10px', borderRadius: 8, color: 'var(--text-soft)', background: 'var(--w-02)', border: '1px solid var(--w-1)' }}
          >
            + document
          </button>
        )}
      </div>

      {!docs.length && (
        <div style={{ fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.6, maxWidth: 640 }}>
          None yet. Plan docs are working notes and supporting material scoped to this plan — unlike project docs they aren't indexed for search and can hold open questions that change as the design firms up.
        </div>
      )}

      {docs.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {docs.map((d) => {
            const isOpen = openId === d.id;
            return (
              <div key={d.id} style={{ border: '1px solid var(--w-07)', borderRadius: 10, background: 'var(--w-015)', overflow: 'hidden' }}>
                <div
                  onClick={() => setOpenId(isOpen ? null : d.id)}
                  className="plan-doc-header hover-border"
                >
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)', transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▸</span>
                  <span className="plan-doc-name">{d.name}</span>
                  {d.description && <span className="plan-doc-description">{d.description}</span>}
                  <div className="plan-flex-spacer" style={{ flex: 1 }} />
                  {!readOnly && (
                    <div className="plan-doc-actions">
                      <button
                        onClick={(e) => { e.stopPropagation(); setEditing({ id: d.id, name: d.name, description: d.description, body: d.body }); setErr(null); }}
                        style={{ cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)', background: 'transparent', border: 'none', padding: '2px 6px' }}
                      >edit</button>
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (await confirm(`Delete plan doc "${d.name}"?`)) await store.actions.deletePlanDoc(planId, d.id);
                        }}
                        className="drawer-x"
                        style={{ cursor: 'pointer', color: 'var(--red-soft)', fontSize: 12, padding: '2px 6px', background: 'transparent', border: 'none' }}
                      >🗑</button>
                    </div>
                  )}
                </div>
                {isOpen && (
                  <div className="plan-doc-body">
                    {d.body ? <Markdown source={d.body} compact /> : <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>empty</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <Modal title={editing.id ? 'Edit plan doc' : 'New plan doc'} subtitle="Working doc scoped to this plan — not indexed, may hold open questions" width={560} onClose={() => setEditing(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Field label="Name">
              <TextInput autoFocus value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="e.g. Payment gateway design notes" />
            </Field>
            <Field label="Description" hint="one line, optional">
              <TextInput value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} placeholder="what a reader finds inside" />
            </Field>
            <Field label="Body" hint="markdown — provisional is fine">
              <TextArea rows={12} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} style={{ fontFamily: 'var(--mono)', fontSize: 12 }} />
            </Field>
            {err && <ErrorNote>{err}</ErrorNote>}
            <div className="plan-modal-actions">
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
