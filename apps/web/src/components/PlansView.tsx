// Plans — how agents structure work: plan → ordered phases → tasks.
// Complexity is progressive: plans are cards with phase progress rails;
// expanding a plan reveals task chips per phase.
import { useEffect, useState } from 'react';
import { isSettledTaskStatus } from '@noriq-dev/shared';
import {
  advertisedWorkflow, api, type ApiExecutionProfileOffer, type ApiPlanDispatch, type ApiRunner, type RunEffort,
} from '../api';
import type { AppStore } from '../store';
import { statusMeta } from '../design';
import { AvatarChip, LiveDot, MonoTag, SectionLabel } from './bits';
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

export function supportsSingleRootMission(workflow: ReturnType<typeof advertisedWorkflow> | undefined): boolean {
  return workflow?.base === 'build' && workflow.capabilities.includes('mission.v2');
}

export function isMissionExecutionProfile(profile: ApiExecutionProfileOffer): boolean {
  return profile.resolution === 'resolved'
    && profile.health === 'healthy'
    && profile.attestationCapable
    && Boolean(profile.effectiveFingerprint);
}

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
                className="hover-border"
                style={{ padding: '15px 18px', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', border: '1px solid transparent' }}
              >
                <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▸</span>
                {agent && <AvatarChip name={agent.name} color={agent.color} size={28} radius={8} fontSize={10.5} />}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 600, letterSpacing: '-.01em', display: 'flex', alignItems: 'center', gap: 8 }}>
                    {plan.title}
                    {proposed && <MonoTag color="#f5a623" bg="rgba(245,166,35,.14)" size={9}>PROPOSED</MonoTag>}
                    {plan.archivedAt && <MonoTag color="var(--text-faint)" bg="var(--w-05)" size={9}>ARCHIVED</MonoTag>}
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {agent ? `planned by ${agent.name}` : 'planned by a human'} · {planPhases.length} phases · {doneCount}/{allTaskIds.length} tasks settled
                    {plan.description ? ` · ${plan.description}` : ''}
                  </div>
                </div>
                {/* phase progress rail */}
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  {planPhases.map((ph, i) => {
                    const ids = phaseTasks.filter((pt) => pt.phaseId === ph.id).map((pt) => pt.taskId);
                    const done = ids.filter((tid) => isSettledTaskStatus(taskById.get(tid)?.status)).length;
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
                <button
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
                  className="drawer-x"
                  style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: 13, width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, flex: 'none' }}
                >
                  {plan.archivedAt ? '↩' : '🗄'}
                </button>
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    setDeleteDisposition('orphan');
                    setLifecycleError(null);
                    setLifecycle({ kind: 'delete', id: plan.id, title: plan.title, openTasks: openTaskCount, allTasks: allTaskIds.length });
                  }}
                  title="Delete plan"
                  className="drawer-x"
                  style={{ cursor: 'pointer', color: 'var(--red-soft)', fontSize: 13, width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, flex: 'none' }}
                >
                  🗑
                </button>
              </div>

              {/* the mandatory human gate (RUN-23): approve → tasks become claimable */}
              {proposed && (
                <div
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                    padding: '11px 18px', borderTop: '1px solid rgba(245,166,35,.2)',
                    background: 'rgba(245,166,35,.06)',
                  }}
                >
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#f5a623' }}>
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
                  <div style={{ flex: 1 }} />
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

              {/* RunnerJob v2 keeps all dispatch choices in one small Jobs surface. The plan
                  card no longer exposes legacy pump/model/workflow/profile controls. */}
              {!proposed && !plan.archivedAt && currentPid && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '9px 18px', borderTop: '1px solid var(--w-05)' }}>
                  <Button
                    variant="ghost"
                    style={{ padding: '5px 14px', fontSize: 11.5 }}
                    onClick={(event) => {
                      event.stopPropagation();
                      store.actions.setView('runs');
                    }}
                  >
                    dispatch from Jobs →
                  </Button>
                </div>
              )}

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
                      const phaseDone = ids.filter((tid) => isSettledTaskStatus(taskById.get(tid)?.status)).length;
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
                                      opacity: t.archivedAt ? 0.55 : 1,
                                    }}
                                  >
                                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: m.dot, flex: 'none' }} />
                                    <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: m.color, flex: 'none' }}>{t.key}</span>
                                    {t.archivedAt && (
                                      <span title="archived" style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)', flex: 'none' }}>🗄</span>
                                    )}
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
                  <label key={value} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: 12, border: `1px solid ${archiveTaskCancellation === value ? 'rgba(198,242,78,.45)' : 'var(--w-1)'}`, borderRadius: 10 }}>
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
                  <label key={value} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: 12, border: `1px solid ${deleteDisposition === value ? 'rgba(198,242,78,.45)' : 'var(--w-1)'}`, borderRadius: 10 }}>
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
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, marginTop: 20 }}>
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
    <div style={{ borderTop: '1px solid var(--w-06)', padding: '14px 18px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: docs.length ? 10 : 0 }}>
        <SectionLabel>Documents</SectionLabel>
        <span title="Working docs scoped to this plan — not searchable, not project docs" style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>
          plan-local · {docs.length}
        </span>
        <div style={{ flex: 1 }} />
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
                  className="hover-border"
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', cursor: 'pointer', border: '1px solid transparent' }}
                >
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)', transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▸</span>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{d.name}</span>
                  {d.description && <span style={{ fontSize: 11, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.description}</span>}
                  <div style={{ flex: 1 }} />
                  {!readOnly && (
                    <>
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
                    </>
                  )}
                </div>
                {isOpen && (
                  <div style={{ padding: '4px 16px 14px', borderTop: '1px solid var(--w-05)', maxWidth: 760 }}>
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
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Tool-agnostic intent (RUN-33) — mirrors RunsView's list; the daemon maps it per driver. */
const EFFORTS: RunEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The plan's execution strip (PLNR-170). One live dispatch per plan: while it runs, this is
 * the progress readout + kill switch; otherwise it is the "dispatch plan" entry point. The
 * per-task chips come from the dispatch record (each task's latest run), not the task board —
 * a task can be `review` while its run is `done`, and the strip is about the RUNS.
 */
function PlanDispatchStrip({
  pid,
  planId,
  dispatch,
  runners,
  openTasks,
  onChange,
}: {
  pid: string;
  planId: string;
  dispatch: ApiPlanDispatch | null;
  runners: ApiRunner[];
  openTasks: number;
  onChange: () => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const live = dispatch !== null && (dispatch.status === 'active' || dispatch.status === 'stalled');

  if (live) {
    const counts = planDispatchRunCounts(dispatch.tasks);
    const stalled = dispatch.status === 'stalled';
    const runner = runners.find((r) => r.id === dispatch.runnerId);
    const tone = stalled ? '#f5a623' : 'var(--green)';
    return (
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 18px',
          borderTop: `1px solid ${stalled ? 'rgba(245,166,35,.2)' : 'rgba(63,217,139,.15)'}`,
          background: stalled ? 'rgba(245,166,35,.05)' : 'rgba(63,217,139,.04)',
        }}
      >
        <LiveDot color={tone} size={6} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: tone }}>
          {stalled ? 'dispatch stalled' : 'dispatching'} on {runner?.label ?? dispatch.runnerId}
        </span>
        <MonoTag color="var(--blue)" bg="rgba(76,157,255,.1)" size={9}>{dispatch.agentTool}</MonoTag>
        <MonoTag color="var(--text-mid)" bg="var(--w-05)" size={9}>gate {dispatch.gate}</MonoTag>
        {/* The dispatch-level workflow default (PLNR-240); per-task overrides still win. */}
        {dispatch.workflow && <MonoTag color="var(--purple)" bg="rgba(167,139,250,.12)" size={9}>{dispatch.workflow}</MonoTag>}
        {dispatch.executionProfile && <MonoTag color="var(--cyan)" bg="rgba(34,211,238,.10)" size={9}>profile {dispatch.executionProfile.id}</MonoTag>}
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>
          {counts.running} running · {counts.done} done
          {counts.gated ? ` · ${counts.gated} gated` : ''}
          {counts.failed ? ` · ${counts.failed} failed` : ''} · {counts.waiting} waiting
        </span>
        {stalled && dispatch.stallReason && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: '#f5a623', flexBasis: '100%' }}>
            ⏸ {dispatch.stallReason}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {(stalled || counts.failed > 0) && (
          <Button
            variant="ghost"
            disabled={busy}
            style={{ padding: '5px 12px', fontSize: 11 }}
            title="Re-arm tasks whose attempts failed and pump again"
            onClick={async (e) => {
              e.stopPropagation();
              setBusy(true);
              try {
                await api.retryPlanDispatch(dispatch.id);
                onChange();
              } finally {
                setBusy(false);
              }
            }}
          >
            retry
          </Button>
        )}
        <Button
          variant="danger"
          disabled={busy}
          style={{ padding: '5px 12px', fontSize: 11 }}
          onClick={async (e) => {
            e.stopPropagation();
            if (!(await confirm('Stop dispatching this plan? Its live runs are killed; finished work stays on the plan branch.'))) return;
            setBusy(true);
            try {
              await api.cancelPlanDispatch(dispatch.id, 'cancelled from dashboard');
              onChange();
            } finally {
              setBusy(false);
            }
          }}
        >
          stop
        </Button>
      </div>
    );
  }

  return (
    <div style={{ borderTop: '1px solid var(--w-05)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 18px' }}>
        {dispatch && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>
            last dispatch {dispatch.status}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {openTasks > 0 ? (
          <Button
            variant={showForm ? 'ghost' : 'primary'}
            style={{ padding: '5px 14px', fontSize: 11.5 }}
            title="Hand this plan to a runner — the server runs one agent per task, in parallel where dependencies allow"
            onClick={(e) => {
              e.stopPropagation();
              setShowForm(!showForm);
            }}
          >
            {showForm ? 'cancel' : '⚡ dispatch plan'}
          </Button>
        ) : (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-faint)' }}>all tasks closed</span>
        )}
      </div>
      {showForm && (
        <PlanDispatchForm
          pid={pid}
          planId={planId}
          runners={runners}
          onDone={() => {
            setShowForm(false);
            onChange();
          }}
        />
      )}
    </div>
  );
}

/** Keep gated preserved-work stops visible as a decision, not folded into failed execution. */
export function planDispatchRunCounts(tasks: ApiPlanDispatch['tasks']) {
  const counts = { waiting: 0, running: 0, done: 0, gated: 0, failed: 0 };
  for (const task of tasks) {
    if (!task.runStatus) counts.waiting += 1;
    else if (task.runStatus === 'done') counts.done += 1;
    else if (task.runStatus === 'gated') counts.gated += 1;
    else if (task.runStatus === 'failed' || task.runStatus === 'cancelled') counts.failed += 1;
    else counts.running += 1;
  }
  return counts;
}

function PlanDispatchForm({
  pid,
  planId,
  runners,
  onDone,
}: {
  pid: string;
  planId: string;
  runners: ApiRunner[];
  onDone: () => void;
}) {
  // The pump creates BUILD runs, so the runner must advertise the kind and a repo that
  // resolved to this project. Capacity is not gated here — the server throttles to slots.
  const candidates = runners.filter(
    (r) => r.status === 'online' && r.capabilities.kinds.includes('build') && r.repos.some((rp) => rp.projectId === pid),
  );
  const [runnerId, setRunnerId] = useState(candidates[0]?.id ?? '');
  const runner = candidates.find((r) => r.id === runnerId) ?? null;
  const repos = runner ? runner.repos.filter((rp) => rp.projectId === pid) : [];
  const [repoRef, setRepoRef] = useState(repos[0]?.id ?? '');
  const [agentTool, setAgentTool] = useState(runner?.capabilities.tools[0] ?? '');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<RunEffort | ''>('');
  const [gate, setGate] = useState<'landed' | 'approved'>('approved');
  const [strategy, setStrategy] = useState<'per_task' | 'single_root'>('per_task');
  // The dispatch-level workflow default (PLNR-240): every pump-created run selects it unless
  // the task names its own. Only BUILD-based workflows make sense — the pump mints build runs —
  // but bare-name advertisements (older daemons) carry no base, so they stay offered.
  const [workflow, setWorkflow] = useState('');
  const [executionProfileId, setExecutionProfileId] = useState('');
  const repoWorkflows = (repos.find((r) => r.id === repoRef)?.workflows ?? [])
    .map(advertisedWorkflow)
    .filter((w) => w.base === 'build' || w.base === null);
  const executionProfiles = repos.find((r) => r.id === repoRef)?.executionProfiles ?? [];
  const selectedWorkflow = repoWorkflows.find((candidate) => candidate.name === workflow);
  const missionWorkflowEligible = supportsSingleRootMission(selectedWorkflow);
  const selectedProfile = executionProfiles.find((profile) => profile.id === executionProfileId);
  const missionProfileEligible = selectedProfile ? isMissionExecutionProfile(selectedProfile) : false;
  const [maxUsd, setMaxUsd] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [maxMinutes, setMaxMinutes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Switching runner invalidates the repo/tool picks — re-seed them from the new one.
  useEffect(() => {
    const r = candidates.find((x) => x.id === runnerId) ?? null;
    setRepoRef(r?.repos.find((rp) => rp.projectId === pid)?.id ?? '');
    setAgentTool(r?.capabilities.tools[0] ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runnerId]);
  // A workflow belongs to one repo — drop the choice when the repo changes (PLNR-240).
  useEffect(() => { setWorkflow(''); setExecutionProfileId(''); setStrategy('per_task'); }, [repoRef]);
  useEffect(() => {
    if (!missionWorkflowEligible || (executionProfileId && !missionProfileEligible)) setStrategy('per_task');
  }, [executionProfileId, missionProfileEligible, missionWorkflowEligible]);

  const num = (s: string): number | null => {
    const n = Number(s.trim());
    return s.trim() && Number.isFinite(n) && n > 0 ? n : null;
  };

  const submit = async () => {
    setErr(null);
    if (!runnerId) return setErr('no online runner advertises a repo for this project (and the build kind)');
    if (!repoRef) return setErr('pick a repo');
    if (!agentTool) return setErr('this runner advertises no agent tools');
    if (strategy === 'single_root' && !missionWorkflowEligible) return setErr('pick a build workflow advertising mission.v2');
    if (strategy === 'single_root' && !missionProfileEligible) return setErr('pick an exact healthy attested execution profile');
    setBusy(true);
    try {
      await api.dispatchPlan(pid, planId, {
        runnerId,
        repoRef,
        agentTool,
        // Blank = don't override (RUN-33): '' would be a request for a model named "".
        model: model.trim() || null,
        effort: effort || null,
        gate,
        strategy,
        // '' = the built-in build. The server refuses an unadvertised name (PLNR-240).
        workflow: repoWorkflows.some((w) => w.name === workflow) ? workflow : null,
        executionProfileId: executionProfiles.some((profile) => profile.id === executionProfileId)
          ? executionProfileId
          : null,
        // Per-RUN ceilings — each task's agent gets this envelope, not a shared pool.
        budget: { maxUsd: num(maxUsd), maxTokens: num(maxTokens), maxDurationSeconds: maxMinutes.trim() ? (num(maxMinutes) ?? 0) * 60 : null },
      });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'plan dispatch failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ margin: '0 18px 14px', padding: '14px 16px', borderRadius: 11, background: 'var(--w-04)', border: '1px solid var(--w-1)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        <Field label="runner">
          <Select value={runnerId} onChange={(e) => setRunnerId(e.target.value)}>
            {candidates.map((r) => (
              <option key={r.id} value={r.id}>{r.label} · {r.freeSlots}/{r.capabilities.maxConcurrency} slots</option>
            ))}
            {!candidates.length && <option value="">— no eligible runner online —</option>}
          </Select>
        </Field>
        <Field label="repo">
          <Select value={repoRef} onChange={(e) => setRepoRef(e.target.value)}>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>{r.name || r.projectKey}{r.defaultBranch ? ` (${r.defaultBranch})` : ''}</option>
            ))}
          </Select>
        </Field>
        <Field label="agent">
          <Select value={agentTool} onChange={(e) => setAgentTool(e.target.value)}>
            {(runner?.capabilities.tools ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
        </Field>
        <Field label="model (optional)">
          <TextInput
            value={model}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setModel(e.target.value)}
            placeholder="repo default"
          />
        </Field>
        <Field label="effort (optional)">
          <Select value={effort} onChange={(e) => setEffort(e.target.value as RunEffort | '')}>
            <option value="">repo default</option>
            {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
          </Select>
        </Field>
        <Field label="review gate" hint="what unblocks a dependent task">
          {/* The review-latency decision (PLNR-170; default flipped by PLNR-176). 'approved'
              holds dependents until each task is marked done — review is a real lock, and a
              kicked-back task can't have dependents already running on its rejected work.
              'landed' trades that safety for pipeline speed; opt in deliberately. */}
          <Select value={gate} onChange={(e) => setGate(e.target.value as 'landed' | 'approved')}>
            <option value="approved">approved — dependents wait for my sign-off (default)</option>
            <option value="landed">landed — start dependents once code lands, review still pending</option>
          </Select>
        </Field>
        {/* The workflow every pump-created run builds under (PLNR-240) unless a task names its
            own. Only shown when the repo advertises any; the server refuses an unadvertised
            name, so a stale menu fails legibly rather than dispatching under the wrong brief. */}
        {repoWorkflows.length > 0 && (
          <Field label="workflow (optional)" hint="every task builds under it — a task's own choice wins">
            <Select value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
              <option value="">— built-in build —</option>
              {repoWorkflows.map((w) => (
                <option key={w.name} value={w.name} title={w.description ?? undefined}>
                  {w.name}{w.description ? ` — ${w.description.slice(0, 60)}` : ''}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {missionWorkflowEligible && (
          <Field label="execution strategy" hint="mission mode commissions this whole plan to one Runner root">
            <Select value={strategy} onChange={(e) => setStrategy(e.target.value as 'per_task' | 'single_root')}>
              <option value="per_task">per task — one run per ready task (default)</option>
              <option value="single_root">single root — Runner mission harness</option>
            </Select>
          </Field>
        )}
        {executionProfiles.length > 0 && (
          <Field
            label={strategy === 'single_root' ? 'execution profile (required)' : 'execution profile (optional)'}
            hint={strategy === 'single_root' ? 'exact healthy attested environment commissioned for this mission' : 'shared across every task run in this dispatch'}
          >
            <Select value={executionProfileId} onChange={(e) => setExecutionProfileId(e.target.value)}>
              <option value="">{strategy === 'single_root' ? '— select an exact profile —' : '— runner default —'}</option>
              {executionProfiles.map((profile) => (
                <option key={profile.id} value={profile.id} disabled={strategy === 'single_root' && !isMissionExecutionProfile(profile)}>
                  {profile.id} · {profile.resolution}/{profile.health} · {profile.capacity.freeSlots}/{profile.capacity.maxConcurrency} slots
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        <Field label="max $ per task" hint="optional">
          <TextInput value={maxUsd} onChange={(e) => setMaxUsd(e.target.value)} inputMode="decimal" placeholder="—" />
        </Field>
        <Field label="max tokens per task" hint="optional">
          <TextInput value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} inputMode="numeric" placeholder="—" />
        </Field>
        <Field label="max minutes per task" hint="optional">
          <TextInput value={maxMinutes} onChange={(e) => setMaxMinutes(e.target.value)} inputMode="numeric" placeholder="—" />
        </Field>
      </div>

      {err && <ErrorNote>{err}</ErrorNote>}

      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <Button
          variant="primary"
          disabled={busy || !candidates.length || (strategy === 'single_root' && (!missionWorkflowEligible || !missionProfileEligible))}
          onClick={submit}
          style={{ padding: '8px 18px' }}
        >
          {busy ? 'dispatching…' : 'dispatch plan'}
        </Button>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)', alignSelf: 'center' }}>
          one agent per task · parallel where dependencies allow
        </span>
      </div>
    </div>
  );
}
