// Review queue (PLNR-124) — the human's backlog: everything agents released to
// `review`, as a focused list with one-click accept / send-back instead of drag
// or per-task drawer digging. Send-back requires a note: an agent bounced with
// no reason just re-does the same thing.
import { useEffect, useState } from 'react';
import { api, type ApiTaskDetail } from '../api';
import type { ExecutionSpec } from '@noriq-dev/shared';
import { SpecView } from './ExecutionSpec';
import type { AppStore } from '../store';
import type { TaskVM } from '../types';
import { MonoTag, SectionLabel } from './bits';
import { Button } from './ui';
import { Markdown } from './Markdown';

export function ReviewView({ store }: { store: AppStore }) {
  const { currentPid, helpers, actions } = store;
  const queue = helpers
    .tasksOf(currentPid)
    .filter((t) => t.status === 'review' && !t.archivedAt);

  return (
    <div style={{ position: 'absolute', inset: 0, overflowY: 'auto', padding: '18px 22px' }}>
      <div style={{ maxWidth: 860, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
          <SectionLabel>Review queue · {queue.length}</SectionLabel>
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
      </div>
    </div>
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
  const releaseNote = detail?.comments.filter((c) => c.authorKind === 'agent').at(-1) ?? null;
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
