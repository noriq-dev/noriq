// Review queue (PLNR-124) — the human's backlog: everything agents released to
// `review`, as a focused list with one-click accept / send-back instead of drag
// or per-task drawer digging. Send-back requires a note: an agent bounced with
// no reason just re-does the same thing.
//
// PLNR-580: also hosts the validity / decay inbox (tasks + plans + docs) grouped
// by cause — mark validated, dismiss cause, open subject. No auto-close.
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type ApiEntityReviewInbox,
  type ApiEntityReviewInboxItem,
  type ApiReviewCause,
  type ApiTaskDetail,
} from '../api';
import type { ExecutionSpec } from '@noriq-dev/shared';
import { SpecView } from './ExecutionSpec';
import type { AppStore } from '../store';
import type { TaskVM } from '../types';
import { MonoTag, SectionLabel } from './bits';
import { Button } from './ui';
import { Markdown } from './Markdown';

type Tab = 'work' | 'validity';

const CAUSES: Array<{ id: ApiReviewCause; label: string; detail: string; color: string }> = [
  { id: 'content_changed', label: 'Content changed', detail: 'Fingerprint moved past last validation', color: 'var(--red-soft)' },
  { id: 'doc_baseline_moved', label: 'Doc pin drifted', detail: 'Linked settled doc advanced past pin', color: 'var(--red-soft)' },
  { id: 'superseded', label: 'Superseded', detail: 'Replaced by another entity', color: 'var(--amber)' },
  { id: 'human_flagged', label: 'Human flagged', detail: 'Marked for check', color: 'var(--amber)' },
  { id: 'code_assessment_stale', label: 'Code assessment stale', detail: 'Agent-declared base drift (P1)', color: 'var(--blue)' },
  { id: 'dormant', label: 'Dormant', detail: 'Opt-in quiet period (P1)', color: 'var(--text-dim)' },
];

const emptyInbox = (): ApiEntityReviewInbox => ({
  items: [], counts: {}, overallTotal: 0, total: 0, offset: 0, nextOffset: null, groupBy: 'cause',
});

export function ReviewView({ store }: { store: AppStore }) {
  const { currentPid, helpers } = store;
  const [tab, setTab] = useState<Tab>('work');
  const queue = helpers
    .tasksOf(currentPid)
    .filter((t) => t.status === 'review' && !t.archivedAt);

  return (
    <div style={{ position: 'absolute', inset: 0, overflowY: 'auto', padding: '18px 22px' }}>
      <div style={{ maxWidth: 920, margin: '0 auto' }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <TabButton active={tab === 'work'} onClick={() => setTab('work')}>
            Work review · {queue.length}
          </TabButton>
          <TabButton active={tab === 'validity'} onClick={() => setTab('validity')}>
            Validity
          </TabButton>
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
                <div style={{ padding: 48, textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)' }}>
                  queue clear — nothing waiting on you
                </div>
              )}
            </div>
          </>
        )}

        {tab === 'validity' && <ValidityInbox store={store} />}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        cursor: 'pointer', padding: '7px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 600,
        background: active ? 'var(--w-1)' : 'var(--w-04)',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--w-08)'}`,
        color: active ? 'var(--text)' : 'var(--text-dim)',
      }}
    >
      {children}
    </button>
  );
}

function ValidityInbox({ store }: { store: AppStore }) {
  const pid = store.currentPid;
  const [cause, setCause] = useState<ApiReviewCause | undefined>();
  const [inbox, setInbox] = useState<ApiEntityReviewInbox>(emptyInbox);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async (append = false) => {
    setLoading(true);
    setError('');
    try {
      const offset = append ? inbox.nextOffset ?? 0 : 0;
      const next = await api.reviewInbox(pid, { cause, limit: 50, offset });
      setInbox((current) => (append ? { ...next, items: [...current.items, ...next.items] } : next));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [cause, inbox.nextOffset, pid]);

  useEffect(() => { void load(false); }, [pid, cause]); // eslint-disable-line react-hooks/exhaustive-deps

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

  return (
    <>
      <div style={{ marginBottom: 14 }}>
        <SectionLabel>Needs review · tasks + plans + docs</SectionLabel>
        <div style={{ color: 'var(--text-dim)', fontSize: 12.5, lineHeight: 1.55, marginTop: 6 }}>
          Age is not failure. This list is explicit drift, flags, or supersession — mark validated, dismiss a cause, or open the subject. Nothing auto-closes.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginBottom: 18 }}>
        {CAUSES.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setCause(cause === item.id ? undefined : item.id)}
            style={{
              cursor: 'pointer', textAlign: 'left', padding: '11px 12px', borderRadius: 10,
              background: cause === item.id ? 'var(--w-1)' : 'var(--w-04)',
              border: `1px solid ${cause === item.id ? item.color : 'var(--w-08)'}`,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 650 }}>{item.label}</span>
              <span style={{ color: item.color, fontFamily: 'var(--mono)', fontSize: 15 }}>{inbox.counts[item.id] ?? 0}</span>
            </div>
            <div style={{ color: 'var(--text-faint)', fontSize: 10.5, marginTop: 4 }}>{item.detail}</div>
          </button>
        ))}
      </div>

      {error && <div style={{ color: 'var(--red-soft)', fontSize: 12, marginBottom: 12 }}>{error}</div>}
      {!loading && inbox.items.length === 0 && (
        <div style={{ padding: 40, border: '1px dashed var(--w-12)', borderRadius: 12, textAlign: 'center', color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 11 }}>
          nothing needs validity review{cause ? ' for this cause' : ''}
        </div>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        {inbox.items.map((item) => (
          <ValidityRow
            key={`${item.subjectType}:${item.subjectId}`}
            item={item}
            busy={acting === item.subjectId}
            onOpen={() => openSubject(item)}
            onValidate={() => void markValidated(item)}
            onDismiss={(c) => void dismissCause(item, c)}
          />
        ))}
      </div>
      {loading && (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 11 }}>
          Loading validity inbox…
        </div>
      )}
      {!loading && inbox.nextOffset != null && (
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <Button variant="ghost" onClick={() => void load(true)}>Load more</Button>
        </div>
      )}
    </>
  );
}

function ValidityRow({
  item, busy, onOpen, onValidate, onDismiss,
}: {
  item: ApiEntityReviewInboxItem;
  busy: boolean;
  onOpen: () => void;
  onValidate: () => void;
  onDismiss: (cause: ApiReviewCause) => void;
}) {
  const primary = CAUSES.find((c) => c.id === item.primaryCause);
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
          const meta = CAUSES.find((x) => x.id === c);
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
      </div>
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
