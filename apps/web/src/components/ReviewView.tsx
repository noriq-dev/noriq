// Review queue (PLNR-124) — the human's backlog: everything agents released to
// `review`, as a focused list with one-click accept / send-back instead of drag
// or per-task drawer digging. Send-back requires a note: an agent bounced with
// no reason just re-does the same thing.
//
// PLNR-580 / PLNR-583: also hosts the validity / decay inbox (tasks + plans + docs).
// Group by cause (default) or entity type; Validate, dismiss cause, Supersede…
// via existing REST. No auto-close.
//
// PLNR-588 / P1-I: Memory review embeds under the same Review chrome (shared tabs +
// filter chips). Memory authority / approve-reject stay on the memory APIs — no
// schema merge with entity validation.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type ApiEntityReviewGroupBy,
  type ApiEntityReviewInbox,
  type ApiEntityReviewInboxItem,
  type ApiProjectDoc,
  type ApiReviewCause,
  type ApiTaskDetail,
  type ApiValidationSubjectType,
} from '../api';
import type { ExecutionSpec } from '@noriq-dev/shared';
import { SpecView } from './ExecutionSpec';
import type { AppStore } from '../store';
import type { TaskVM } from '../types';
import { MonoTag, SectionLabel } from './bits';
import { MemoryReview } from './MemoryReview';
import { PlanSearchSelect } from './PlanSearchSelect';
import {
  clearReviewShellTabHint,
  InboxEmptyState,
  InboxFilterChips,
  InboxLoading,
  readReviewShellTab,
  ReviewTabButton,
  type ReviewShellTab,
} from './ReviewInboxChrome';
import { TaskSearchSelect } from './TaskSearchSelect';
import { Button } from './ui';
import { Markdown } from './Markdown';
import { causeMeta, VALIDITY_CAUSES } from './ValidityStrip';

type Tab = ReviewShellTab;

/** Inbox filter chips — omits never_validated / impact_unknown (flood policy). */
const CAUSES = VALIDITY_CAUSES.filter((c) => c.id !== 'never_validated' && c.id !== 'impact_unknown');

const ENTITY_TYPES: Array<{ id: ApiValidationSubjectType; label: string; detail: string; color: string }> = [
  { id: 'task', label: 'Tasks', detail: 'Task fingerprints and pins', color: 'var(--blue)' },
  { id: 'plan', label: 'Plans', detail: 'Plan body / phase drift', color: 'var(--amber)' },
  { id: 'doc', label: 'Docs', detail: 'Settled project docs', color: 'var(--text-mid)' },
];

const emptyInbox = (groupBy: ApiEntityReviewGroupBy = 'cause'): ApiEntityReviewInbox => ({
  items: [], counts: {}, overallTotal: 0, total: 0, offset: 0, nextOffset: null, groupBy,
});

export function ReviewView({ store }: { store: AppStore }) {
  const { currentPid, helpers } = store;
  // Peek only here — StrictMode double-inits useState; mutating sessionStorage
  // in the initializer drops the Memory cross-link on the second call (Codex P2).
  const [tab, setTab] = useState<Tab>(readReviewShellTab);
  const [memoryCount, setMemoryCount] = useState<number | null>(null);
  const queue = helpers
    .tasksOf(currentPid)
    .filter((t) => t.status === 'review' && !t.archivedAt);

  useEffect(() => {
    clearReviewShellTabHint();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setMemoryCount(null);
    void api.memoryReviewQueue(currentPid, { limit: 1 }).then((q) => {
      if (!cancelled) setMemoryCount(q.overallTotal);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [currentPid]);

  const openMemoryInspector = (uri: string) => {
    const id = uri.startsWith('noriq://memory/') ? uri.slice('noriq://memory/'.length) : uri;
    try { sessionStorage.setItem('noriq.openMemory', id); } catch { /* optional */ }
    store.actions.setView('memory');
  };

  return (
    <div style={{ position: 'absolute', inset: 0, overflowY: 'auto', padding: '18px 22px' }}>
      <div style={{ maxWidth: 920, margin: '0 auto' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }} role="tablist" aria-label="Review queues">
          <ReviewTabButton active={tab === 'work'} onClick={() => setTab('work')}>
            Work review · {queue.length}
          </ReviewTabButton>
          <ReviewTabButton active={tab === 'validity'} onClick={() => setTab('validity')}>
            Validity
          </ReviewTabButton>
          <ReviewTabButton active={tab === 'memory'} onClick={() => setTab('memory')}>
            Memory{memoryCount != null && memoryCount > 0 ? ` · ${memoryCount}` : ''}
          </ReviewTabButton>
        </div>

        {tab === 'work' && (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
              <SectionLabel>Work review queue · {queue.length}</SectionLabel>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>
                accept sends a task to done — and unblocks whatever depends on it
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {queue.map((t) => (
                <ReviewRow key={t.id} task={t} store={store} />
              ))}
              {!queue.length && (
                <InboxEmptyState>queue clear — nothing waiting on you</InboxEmptyState>
              )}
            </div>
          </>
        )}

        {tab === 'validity' && <ValidityInbox store={store} />}
        {tab === 'memory' && (
          <MemoryReview
            pid={currentPid}
            store={store}
            chrome="review"
            onOpenInspector={openMemoryInspector}
            onQueueChange={setMemoryCount}
          />
        )}
      </div>
    </div>
  );
}

function ValidityInbox({ store }: { store: AppStore }) {
  const pid = store.currentPid;
  const [groupBy, setGroupBy] = useState<ApiEntityReviewGroupBy>('cause');
  const [cause, setCause] = useState<ApiReviewCause | undefined>();
  const [subjectType, setSubjectType] = useState<ApiValidationSubjectType | undefined>();
  const [inbox, setInbox] = useState<ApiEntityReviewInbox>(() => emptyInbox('cause'));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async (append = false) => {
    setLoading(true);
    setError('');
    try {
      const offset = append ? inbox.nextOffset ?? 0 : 0;
      const next = await api.reviewInbox(pid, {
        cause: groupBy === 'cause' ? cause : undefined,
        subjectType: groupBy === 'entity' ? subjectType : undefined,
        groupBy,
        limit: 50,
        offset,
      });
      // Server may still echo groupBy:'cause'; prefer the user's toggle for presentation.
      const normalized = { ...next, groupBy };
      setInbox((current) => (append ? { ...normalized, items: [...current.items, ...normalized.items] } : normalized));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [cause, groupBy, inbox.nextOffset, pid, subjectType]);

  useEffect(() => { void load(false); }, [pid, cause, subjectType, groupBy]); // eslint-disable-line react-hooks/exhaustive-deps

  const entityCounts = useMemo(() => {
    const counts: Record<ApiValidationSubjectType, number> = { task: 0, plan: 0, doc: 0 };
    for (const item of inbox.items) counts[item.subjectType] += 1;
    return counts;
  }, [inbox.items]);

  const sections = useMemo(() => {
    if (groupBy === 'entity') {
      const order: ApiValidationSubjectType[] = ['task', 'plan', 'doc'];
      return order
        .filter((type) => !subjectType || subjectType === type)
        .map((type) => ({
          id: type,
          label: ENTITY_TYPES.find((e) => e.id === type)?.label ?? type,
          items: inbox.items.filter((item) => item.subjectType === type),
        }))
        .filter((section) => section.items.length > 0 || !!subjectType);
    }
    // Match any listed cause, not primaryCause alone — a subject with
    // primaryCause=content_changed and causes including doc_baseline_moved must
    // still appear under the Doc-pin filter (and in that cause section unfiltered).
    const order = CAUSES.map((c) => c.id);
    return order
      .filter((id) => !cause || cause === id)
      .map((id) => ({
        id,
        label: CAUSES.find((c) => c.id === id)?.label ?? id,
        items: inbox.items.filter((item) => item.causes.includes(id)),
      }))
      .filter((section) => section.items.length > 0 || !!cause);
  }, [cause, groupBy, inbox.items, subjectType]);

  const openSubject = (item: ApiEntityReviewInboxItem) => {
    if (item.subjectType === 'task') store.actions.openTask(item.subjectId);
    else if (item.subjectType === 'doc') store.actions.setView('docs');
    else store.actions.setView('plans');
  };

  const markValidated = async (item: ApiEntityReviewInboxItem) => {
    setActing(item.subjectId);
    setError('');
    try {
      await api.recordValidation(pid, { subjectType: item.subjectType, subjectId: item.subjectId });
      await load(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(null);
    }
  };

  const dismissCause = async (item: ApiEntityReviewInboxItem, dismiss: ApiReviewCause) => {
    setActing(item.subjectId);
    setError('');
    try {
      await api.setReviewCause(pid, {
        subjectType: item.subjectType,
        subjectId: item.subjectId,
        cause: dismiss,
        status: 'dismissed',
      });
      await load(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(null);
    }
  };

  const supersede = async (item: ApiEntityReviewInboxItem, replacementId: string) => {
    setActing(item.subjectId);
    setError('');
    try {
      // Replacement becomes current; inbox subject is the prior (history preserved, no auto-close).
      await api.setSupersedes(pid, {
        subjectType: item.subjectType,
        subjectId: replacementId,
        priorId: item.subjectId,
      });
      await load(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(null);
    }
  };

  const switchGroupBy = (next: ApiEntityReviewGroupBy) => {
    setGroupBy(next);
    setCause(undefined);
    setSubjectType(undefined);
  };

  return (
    <>
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 12 }}>
          <SectionLabel>Needs review · tasks + plans + docs</SectionLabel>
          <div
            role="group"
            aria-label="Group validity inbox"
            style={{ display: 'inline-flex', gap: 4, marginLeft: 'auto' }}
          >
            <GroupToggle active={groupBy === 'cause'} onClick={() => switchGroupBy('cause')}>
              By cause
            </GroupToggle>
            <GroupToggle active={groupBy === 'entity'} onClick={() => switchGroupBy('entity')}>
              By entity type
            </GroupToggle>
          </div>
        </div>
        <div style={{ color: 'var(--text-dim)', fontSize: 12.5, lineHeight: 1.55, marginTop: 6 }}>
          Age is not failure. This list is explicit drift, flags, or supersession — mark validated, dismiss a cause, supersede with a newer subject, or open it. Nothing auto-closes.
        </div>
      </div>

      {groupBy === 'cause' ? (
        <InboxFilterChips
          options={CAUSES}
          selected={cause}
          counts={inbox.counts}
          onSelect={setCause}
        />
      ) : (
        <InboxFilterChips
          options={ENTITY_TYPES}
          selected={subjectType}
          counts={entityCounts}
          onSelect={setSubjectType}
        />
      )}

      {error && <div style={{ color: 'var(--red-soft)', fontSize: 12, marginBottom: 12 }}>{error}</div>}
      {!loading && inbox.items.length === 0 && (
        <InboxEmptyState>
          nothing needs validity review
          {groupBy === 'cause' && cause ? ' for this cause' : ''}
          {groupBy === 'entity' && subjectType ? ` for ${subjectType}s` : ''}
        </InboxEmptyState>
      )}

      <div style={{ display: 'grid', gap: 16 }}>
        {sections.map((section) => (
          <div key={section.id}>
            {(!cause && !subjectType) && (
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase',
                color: 'var(--text-faint)', marginBottom: 8,
              }}>
                {section.label} · {section.items.length}
              </div>
            )}
            <div style={{ display: 'grid', gap: 10 }}>
              {section.items.map((item) => (
                <ValidityRow
                  key={`${item.subjectType}:${item.subjectId}`}
                  item={item}
                  pid={pid}
                  busy={acting === item.subjectId}
                  onOpen={() => openSubject(item)}
                  onValidate={() => void markValidated(item)}
                  onDismiss={(c) => void dismissCause(item, c)}
                  onSupersede={(replacementId) => void supersede(item, replacementId)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      {loading && <InboxLoading label="Loading validity inbox…" />}
      {!loading && inbox.nextOffset != null && (
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <Button variant="ghost" onClick={() => void load(true)}>Load more</Button>
        </div>
      )}
    </>
  );
}

function GroupToggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        cursor: 'pointer', padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
        background: active ? 'var(--w-1)' : 'transparent',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--w-08)'}`,
        color: active ? 'var(--text)' : 'var(--text-dim)',
      }}
    >
      {children}
    </button>
  );
}

function ValidityRow({
  item, pid, busy, onOpen, onValidate, onDismiss, onSupersede,
}: {
  item: ApiEntityReviewInboxItem;
  pid: string;
  busy: boolean;
  onOpen: () => void;
  onValidate: () => void;
  onDismiss: (cause: ApiReviewCause) => void;
  onSupersede: (replacementId: string) => void;
}) {
  const primary = causeMeta(item.primaryCause);
  const [superseding, setSuperseding] = useState(false);
  const [replacementId, setReplacementId] = useState('');
  const [docs, setDocs] = useState<ApiProjectDoc[]>([]);

  useEffect(() => {
    if (!superseding || item.subjectType !== 'doc') return;
    let cancelled = false;
    api.docs(pid).then((r) => {
      if (!cancelled) setDocs(r.docs.filter((d) => d.id !== item.subjectId));
    }).catch(() => { if (!cancelled) setDocs([]); });
    return () => { cancelled = true; };
  }, [item.subjectId, item.subjectType, pid, superseding]);

  const confirmSupersede = () => {
    if (!replacementId || replacementId === item.subjectId) return;
    onSupersede(replacementId);
    setSuperseding(false);
    setReplacementId('');
  };

  return (
    <article style={{
      padding: '13px 15px', border: '1px solid var(--w-08)', borderRadius: 11,
      background: 'var(--card)', opacity: busy ? 0.55 : 1,
    }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 7, marginBottom: 8 }}>
        <MonoTag color="var(--text-mid)" bg="var(--w-05)" size={8.5}>{item.subjectType.toUpperCase()}</MonoTag>
        {item.key && (
          <span onClick={onOpen} style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--blue)', cursor: 'pointer' }}>
            {item.key}
          </span>
        )}
        <span style={{ fontSize: 13, fontWeight: 600 }}>{item.title}</span>
        <span style={{ flex: 1 }} />
        {item.causes.map((c) => {
          const meta = causeMeta(c);
          return (
            <MonoTag key={c} color={meta?.color ?? 'var(--text-dim)'} bg="var(--w-05)" size={8.5}>
              {(meta?.label ?? c).toUpperCase()}
            </MonoTag>
          );
        })}
      </div>
      <div style={{ color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 10, marginBottom: 10 }}>
        primary {primary?.label ?? item.primaryCause}
        {item.lastValidatedAt
          ? ` · last validated ${new Date(item.lastValidatedAt).toLocaleDateString()}`
          : ' · never validated'}
      </div>
      {!superseding ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <Button variant="primary" style={{ padding: '5px 12px', fontSize: 11.5 }} onClick={onValidate}>
            mark validated
          </Button>
          <Button variant="ghost" style={{ padding: '5px 12px', fontSize: 11.5 }} onClick={onOpen}>
            open
          </Button>
          <Button
            variant="ghost"
            style={{ padding: '5px 12px', fontSize: 11.5 }}
            onClick={() => onDismiss(item.primaryCause)}
            title="Dismiss this cause only — does not invent validity"
          >
            dismiss cause
          </Button>
          <Button
            variant="ghost"
            style={{ padding: '5px 12px', fontSize: 11.5 }}
            onClick={() => { setSuperseding(true); setReplacementId(''); }}
            title="Link a newer subject that supersedes this one — history stays readable; nothing auto-closes"
          >
            Supersede…
          </Button>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8, marginTop: 2 }}>
          <div style={{ color: 'var(--text-dim)', fontSize: 11.5, lineHeight: 1.45 }}>
            Pick the new current {item.subjectType}. This subject stays readable as prior history — status is not auto-closed.
          </div>
          {item.subjectType === 'task' && (
            <TaskSearchSelect
              projectId={pid}
              value={replacementId}
              onChange={setReplacementId}
              label="Replacement task"
              placeholder="Search the newer task…"
            />
          )}
          {item.subjectType === 'plan' && (
            <PlanSearchSelect
              projectId={pid}
              value={replacementId}
              onChange={setReplacementId}
              label="Replacement plan"
              placeholder="Search the newer plan…"
            />
          )}
          {item.subjectType === 'doc' && (
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
                Replacement doc
              </span>
              <select
                value={replacementId}
                onChange={(e) => setReplacementId(e.target.value)}
                style={{
                  background: 'var(--w-04)', border: '1px solid var(--w-1)', borderRadius: 8,
                  padding: '7px 11px', color: 'var(--text)', fontSize: 12.5, fontFamily: 'inherit',
                }}
              >
                <option value="">Select a newer doc…</option>
                {docs.map((doc) => (
                  <option key={doc.id} value={doc.id}>{doc.name}</option>
                ))}
              </select>
            </label>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <Button
              variant="primary"
              style={{ padding: '5px 12px', fontSize: 11.5 }}
              onClick={confirmSupersede}
              disabled={!replacementId || replacementId === item.subjectId}
            >
              link supersedes
            </Button>
            <Button
              variant="ghost"
              style={{ padding: '5px 12px', fontSize: 11.5 }}
              onClick={() => { setSuperseding(false); setReplacementId(''); }}
            >
              cancel
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}

function ReviewRow({ task, store }: { task: TaskVM; store: AppStore }) {
  const { actions, currentPid } = store;
  const [detail, setDetail] = useState<ApiTaskDetail | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [sendingBack, setSendingBack] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // The release note is the review's primary evidence — load it eagerly, not on click.
    api.taskDetail(task.id).then(setDetail).catch(() => {});
  }, [task.id]);

  // The agent's parting words: last agent-authored comment (release_task notes land there).
  const releaseNote = (detail?.comments.filter((c) => c.authorKind === 'agent') ?? [])
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1) ?? null;
  // The acceptance criteria the work was commissioned against (RUN-137). "Accept" is a judgement,
  // and a reviewer who cannot see the contract is judging from memory. READ-ONLY here on purpose:
  // editing at the moment of acceptance is moving the goalposts, and the drawer is where a spec
  // gets corrected — before the work, when it is still cheap.
  const spec = (detail?.task.executionSpec as ExecutionSpec | null) ?? null;
  const hasAcceptance =
    !!spec &&
    (spec.acceptance.observableTruths.length > 0 ||
      spec.acceptance.artifacts.length > 0 ||
      spec.acceptance.links.length > 0);
  const openQuestions = detail?.comments.filter((c) => c.status === 'open' || c.status === 'acknowledged') ?? [];

  const accept = async () => {
    setBusy(true);
    await actions.moveTask(task.id, 'done');
  };
  const sendBack = async () => {
    if (!note.trim()) return;
    setBusy(true);
    await api.postComment(currentPid, task.id, 'instruction', note.trim());
    await actions.moveTask(task.id, 'todo');
  };

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--w-07)', borderRadius: 11, padding: '13px 15px', opacity: busy ? 0.5 : 1 }}>
      <div className="review-row" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          onClick={() => actions.openTask(task.id)}
          style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--blue)', cursor: 'pointer', flex: 'none' }}
        >
          {task.key}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {task.title}
        </span>
        {openQuestions.length > 0 && (
          <MonoTag color="var(--amber)" bg="rgba(245,166,35,.12)" size={9.5}>{openQuestions.length} open</MonoTag>
        )}
        <div style={{ flex: 1 }} />
        {detail?.refs.map((r) => (
          <a
            key={`${r.kind}:${r.ref}`}
            href={r.url ?? undefined}
            target="_blank"
            rel="noreferrer"
            style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)', border: '1px solid var(--w-1)', padding: '1px 6px', borderRadius: 4, textDecoration: 'none', whiteSpace: 'nowrap' }}
          >
            {r.kind}: {r.ref.length > 24 ? `${r.ref.slice(0, 24)}…` : r.ref}
          </a>
        ))}
        {!sendingBack && (
          <>
            <Button variant="primary" style={{ padding: '5px 12px', fontSize: 11.5 }} onClick={() => void accept()}>
              accept
            </Button>
            <Button variant="ghost" style={{ padding: '5px 12px', fontSize: 11.5 }} onClick={() => setSendingBack(true)}>
              send back
            </Button>
          </>
        )}
      </div>

      {hasAcceptance && spec && (
        <div style={{ marginTop: 9 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 4 }}>
            Commissioned against
          </div>
          <SpecView spec={spec} only="acceptance" />
        </div>
      )}

      {releaseNote && (
        <div
          onClick={() => setExpanded(!expanded)}
          style={{
            marginTop: 9, padding: '8px 11px', borderRadius: 8, background: 'var(--w-03)',
            fontSize: 12, lineHeight: 1.55, color: 'var(--text-soft)', cursor: 'pointer',
            ...(expanded ? {} : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden' }),
          }}
          title={expanded ? 'collapse' : 'expand'}
        >
          <Markdown source={releaseNote.body} compact />
        </div>
      )}

      {sendingBack && (
        <div style={{ marginTop: 9, display: 'flex', gap: 8 }}>
          <input
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void sendBack(); if (e.key === 'Escape') setSendingBack(false); }}
            placeholder="what needs to change? (required — the agent reads this)"
            style={{
              flex: 1, background: 'var(--w-04)', border: '1px solid var(--w-1)', borderRadius: 8,
              padding: '7px 11px', color: 'var(--text)', fontSize: 12.5, outline: 'none', fontFamily: 'inherit',
            }}
          />
          <Button variant="danger" style={{ padding: '5px 12px', fontSize: 11.5 }} onClick={() => void sendBack()}>
            send back
          </Button>
          <Button variant="ghost" style={{ padding: '5px 12px', fontSize: 11.5 }} onClick={() => setSendingBack(false)}>
            cancel
          </Button>
        </div>
      )}
    </div>
  );
}
