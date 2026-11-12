import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type ApiProjectHealth } from '../api';
import type { AppStore } from '../store';
import { MonoTag, SectionLabel } from './bits';
import { Button } from './ui';
import { IntelligenceHistoryView } from './IntelligenceHistoryView';
import { openReviewValidityTab } from './ReviewInboxChrome';

type HealthTask = ApiProjectHealth['items'][number];

function hasEvidenceGap(task: HealthTask): boolean {
  if (task.readiness !== 'passed') return true;
  if (task.blockingCauses.some((cause) => /readiness|freshness|evidence|validation|stale|never_validated|doc_baseline/i.test(cause))) {
    return true;
  }
  return task.causes.some((cause) => cause.severity === 'critical');
}

/** Split one health page into human action buckets. Claimable wins over evidence. */
export function partitionHealthTasks(items: HealthTask[]) {
  const claimable: HealthTask[] = [];
  const evidenceGaps: HealthTask[] = [];
  const heldBack: HealthTask[] = [];
  for (const task of items) {
    if (task.claimability.claimable) claimable.push(task);
    else if (hasEvidenceGap(task)) evidenceGaps.push(task);
    else heldBack.push(task);
  }
  return { claimable, evidenceGaps, heldBack };
}

function readinessTone(state: string): { color: string; bg: string; label: string } {
  if (state === 'passed') return { color: 'var(--green)', bg: 'rgba(63,217,139,.12)', label: 'readiness passed' };
  if (state === 'failed') return { color: 'var(--red)', bg: 'rgba(255,138,138,.12)', label: 'readiness failed' };
  if (state === 'inconclusive') return { color: 'var(--amber)', bg: 'rgba(245,166,35,.12)', label: 'readiness inconclusive' };
  return { color: 'var(--amber)', bg: 'rgba(245,166,35,.12)', label: `readiness ${state || 'missing'}` };
}

function PriorityTag({ priority }: { priority: number }) {
  const color = priority <= 1 ? 'var(--red)' : priority === 2 ? 'var(--text-mid)' : 'var(--text-faint)';
  const bg = priority <= 1 ? 'rgba(255,138,138,.12)' : 'var(--w-05)';
  return <MonoTag color={color} bg={bg}>P{priority}</MonoTag>;
}

function HealthSection({
  title,
  hint,
  action,
  children,
  empty,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children?: ReactNode;
  empty?: string;
}) {
  const hasBody = children != null && children !== false && children !== true;
  return (
    <section style={{ border: '1px solid var(--w-07)', borderRadius: 14, background: 'var(--w-015)', padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <SectionLabel>{title}</SectionLabel>
        {hint && <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>{hint}</span>}
        <div style={{ flex: 1 }} />
        {action}
      </div>
      {hasBody ? children : empty ? (
        <p style={{ margin: 0, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-faint)' }}>{empty}</p>
      ) : null}
    </section>
  );
}

function PulseStat({ label, value, tone }: { label: string; value: number | string; tone?: 'ok' | 'warn' | 'neutral' }) {
  const color = tone === 'ok' ? 'var(--green)' : tone === 'warn' ? 'var(--amber)' : 'var(--text)';
  return (
    <div style={{ minWidth: 108, padding: '10px 12px', borderRadius: 10, background: 'var(--w-02)', border: '1px solid var(--w-07)' }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 650, letterSpacing: '-.02em', color, lineHeight: 1.1 }}>{value}</div>
    </div>
  );
}

function TaskHealthRow({
  task,
  onOpen,
  emphasis,
}: {
  task: HealthTask;
  onOpen: () => void;
  emphasis: 'claimable' | 'evidence' | 'held';
}) {
  const readiness = readinessTone(task.readiness);
  return (
    <article
      className="hover-border"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '12px 14px',
        borderRadius: 11,
        background: 'var(--card)',
        border: '1px solid var(--w-07)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={onOpen}
          style={{
            cursor: 'pointer',
            background: 'transparent',
            border: 'none',
            padding: 0,
            textAlign: 'left',
            color: 'var(--text)',
            minWidth: 0,
            flex: '1 1 220px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--blue)' }}>{task.key}</span>
            <PriorityTag priority={task.priority} />
            <MonoTag color="var(--text-mid)" bg="var(--w-05)">{task.status.replace('_', ' ')}</MonoTag>
          </div>
          <div style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: '-.01em' }}>{task.title}</div>
        </button>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-start' }}>
          {emphasis === 'claimable' ? (
            <MonoTag color="var(--green)" bg="rgba(63,217,139,.12)">ready to claim</MonoTag>
          ) : (
            <MonoTag color="var(--amber)" bg="rgba(245,166,35,.12)">{task.claimability.reason || 'not claimable'}</MonoTag>
          )}
          <MonoTag color={readiness.color} bg={readiness.bg}>{readiness.label}</MonoTag>
          <MonoTag color="var(--text-mid)" bg="var(--w-05)">impl {task.implementation}</MonoTag>
          {!task.evidenceRequired && <MonoTag color="var(--text-faint)" bg="var(--w-04)">legacy policy</MonoTag>}
        </div>
      </div>

      {!!task.blockingCauses.length && (
        <p style={{ margin: 0, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--amber)' }}>
          Attention: {task.blockingCauses.join(' · ')}
        </p>
      )}

      {task.checkedRevision && (
        <p style={{ margin: 0, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>
          Assessed revision <code>{task.checkedRevision}</code>
          {task.checkedAt ? ` · ${new Date(task.checkedAt).toLocaleString()}` : ''}
        </p>
      )}

      {task.phases.map((phase) => (
        <p key={phase.id} style={{ margin: 0, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>
          {phase.planTitle} · Phase {phase.phaseNumber}: {phase.title} · plan {phase.planStatus}
        </p>
      ))}

      {task.overrides.map((override) => (
        <p key={override.id} style={{ margin: 0, fontSize: 11.5, color: 'var(--text-soft)' }}>
          Explicit {override.scope} exception by {override.actorName}, expires {new Date(override.expiresAt).toLocaleString()}: {override.reason}
        </p>
      ))}

      <div>
        <Button variant="ghost" style={{ padding: '4px 10px', fontSize: 11.5 }} onClick={onOpen}>Open task</Button>
      </div>
    </article>
  );
}

export function IntelligenceView({ store }: { store: AppStore }) {
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [packet, setPacket] = useState<ApiProjectHealth | null>(null);
  const [error, setError] = useState('');
  const [historyOpen, setHistoryOpen] = useState(new URLSearchParams(location.search).has('lineage'));

  useEffect(() => { setOffset(0); }, [store.currentPid]);
  useEffect(() => {
    let cancelled = false;
    setPacket(null);
    setError('');
    api.projectHealth(store.currentPid, offset).then((value) => { if (!cancelled) setPacket(value); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [store.currentPid, offset, refresh]);

  const groups = useMemo(() => partitionHealthTasks(packet?.items ?? []), [packet]);
  const pageExceptions = useMemo(
    () => (packet?.items ?? []).flatMap((task) => task.overrides.map((override) => ({ task, override }))),
    [packet],
  );

  if (historyOpen) {
    return (
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--w-07)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Button onClick={() => setHistoryOpen(false)}>Back to Project health</Button>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-faint)' }}>Historical evidence and lineage</span>
        </div>
        <div style={{ flex: 1, position: 'relative' }}><IntelligenceHistoryView store={store} /></div>
      </div>
    );
  }

  return (
    <main style={{ position: 'absolute', inset: 0, overflow: 'auto', padding: '18px 22px' }}>
      <div style={{ maxWidth: 980, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <header style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 280px', minWidth: 0 }}>
            <h1 style={{ margin: '0 0 6px', fontSize: 22, letterSpacing: '-.02em' }}>Project health</h1>
            <p style={{ margin: 0, maxWidth: 560, color: 'var(--text-soft)', fontSize: 13.5, lineHeight: 1.45 }}>
              What agents can claim next, what evidence is missing, and what coordination is holding work.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button onClick={() => setRefresh((n) => n + 1)}>Refresh</Button>
            <Button onClick={() => openReviewValidityTab(store.actions.setView)}>Open Review</Button>
            <Button variant="ghost" onClick={() => setHistoryOpen(true)}>Historical evidence and lineage</Button>
          </div>
        </header>

        {error ? (
          <div role="alert" style={{ padding: '12px 14px', borderRadius: 11, border: '1px solid rgba(255,138,138,.35)', background: 'rgba(255,138,138,.08)' }}>
            Unable to load project health: {error}{' '}
            <Button onClick={() => setRefresh((n) => n + 1)}>Retry</Button>
          </div>
        ) : !packet ? (
          <p role="status" style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-faint)' }}>Checking current readiness…</p>
        ) : (
          <>
            <HealthSection
              title="Coordination"
              hint="project-wide pulse · page buckets below"
            >
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                <PulseStat label="Open tasks" value={packet.totalOpenTasks} />
                <PulseStat label="Active claims" value={packet.activeClaims} tone={packet.activeClaims > 0 ? 'ok' : 'neutral'} />
                <PulseStat label="File locks" value={packet.activeLocks} tone={packet.activeLocks > 0 ? 'warn' : 'neutral'} />
                <PulseStat label="Claimable here" value={groups.claimable.length} tone={groups.claimable.length > 0 ? 'ok' : 'neutral'} />
                <PulseStat label="Evidence gaps" value={groups.evidenceGaps.length} tone={groups.evidenceGaps.length > 0 ? 'warn' : 'ok'} />
              </div>
              <p style={{ margin: 0, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-faint)' }}>
                Observed {new Date(packet.observedAt).toLocaleString()}. Showing {packet.items.length ? packet.offset + 1 : 0}–{packet.offset + packet.items.length} of {packet.totalOpenTasks} open tasks, priority order.
                {' '}Page counts are not project-wide coverage.
              </p>
            </HealthSection>

            <HealthSection
              title={`Ready to claim · ${groups.claimable.length}`}
              hint="agents can pick these up now"
              empty="Nothing claimable on this page."
            >
              {groups.claimable.length > 0 && (
                <div style={{ display: 'grid', gap: 10 }}>
                  {groups.claimable.map((task) => (
                    <TaskHealthRow
                      key={task.id}
                      task={task}
                      emphasis="claimable"
                      onOpen={() => store.actions.openTask(task.id)}
                    />
                  ))}
                </div>
              )}
            </HealthSection>

            <HealthSection
              title={`Evidence gaps · ${groups.evidenceGaps.length}`}
              hint="recheck or record readiness before claim"
              action={<Button variant="ghost" style={{ padding: '4px 10px', fontSize: 11.5 }} onClick={() => openReviewValidityTab(store.actions.setView)}>Review validity</Button>}
              empty="No evidence gaps on this page."
            >
              {groups.evidenceGaps.length > 0 && (
                <div style={{ display: 'grid', gap: 10 }}>
                  {groups.evidenceGaps.map((task) => (
                    <TaskHealthRow
                      key={task.id}
                      task={task}
                      emphasis="evidence"
                      onOpen={() => store.actions.openTask(task.id)}
                    />
                  ))}
                </div>
              )}
            </HealthSection>

            <HealthSection
              title={`Held back · ${groups.heldBack.length}`}
              hint="claimed, blocked, or otherwise not claimable"
              empty="Nothing else holding this page."
            >
              {groups.heldBack.length > 0 && (
                <div style={{ display: 'grid', gap: 10 }}>
                  {groups.heldBack.map((task) => (
                    <TaskHealthRow
                      key={task.id}
                      task={task}
                      emphasis="held"
                      onOpen={() => store.actions.openTask(task.id)}
                    />
                  ))}
                </div>
              )}
            </HealthSection>

            {pageExceptions.length > 0 && (
              <HealthSection title={`Active exceptions · ${pageExceptions.length}`} hint="explicit overrides on this page">
                <div style={{ display: 'grid', gap: 8 }}>
                  {pageExceptions.map(({ task, override }) => (
                    <div key={override.id} style={{ padding: '10px 12px', borderRadius: 9, border: '1px solid var(--w-07)', background: 'var(--w-02)' }}>
                      <Button variant="ghost" style={{ padding: 0, fontSize: 12.5 }} onClick={() => store.actions.openTask(task.id)}>
                        {task.key} · {task.title}
                      </Button>
                      <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text-soft)' }}>
                        {override.scope} exception by {override.actorName}, expires {new Date(override.expiresAt).toLocaleString()}: {override.reason}
                      </p>
                    </div>
                  ))}
                </div>
              </HealthSection>
            )}

            {!packet.items.length && (
              <p style={{ margin: 0, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-faint)' }}>No open tasks in this scope.</p>
            )}

            <div style={{ display: 'flex', gap: 8, paddingBottom: 8 }}>
              <Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - packet.pageSize))}>Previous</Button>
              <Button disabled={packet.nextOffset === null} onClick={() => setOffset(packet.nextOffset!)}>Next</Button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
