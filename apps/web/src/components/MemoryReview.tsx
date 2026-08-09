import { useCallback, useEffect, useState } from 'react';
import { api, type ApiMemoryReviewQueue, type ApiMemoryReviewQueueItem, type ApiMemoryReviewReason } from '../api';
import type { AppStore } from '../store';
import { MonoTag, SectionLabel } from './bits';
import { Button, TextArea } from './ui';

const REASONS: Array<{ id: ApiMemoryReviewReason; label: string; detail: string; color: string }> = [
  { id: 'proposed_decision', label: 'Proposed decisions', detail: 'Awaiting a manager decision', color: 'var(--purple)' },
  { id: 'contradiction', label: 'Contradictions', detail: 'Claims disagree and need resolution', color: 'var(--red-soft)' },
  { id: 'stale_invalid', label: 'Stale or invalid', detail: 'Known not to represent current truth', color: 'var(--amber)' },
  { id: 'recent_negative_feedback', label: 'Flagged recently', detail: 'Downvoted in the last 30 days', color: 'var(--red-soft)' },
  { id: 'low_authority', label: 'Low authority', detail: 'Still provisional agent evidence', color: 'var(--blue)' },
];

const EMPTY_COUNTS = Object.fromEntries(REASONS.map(({ id }) => [id, 0])) as Record<ApiMemoryReviewReason, number>;
const emptyQueue = (): ApiMemoryReviewQueue => ({ items: [], counts: EMPTY_COUNTS, overallTotal: 0, total: 0, offset: 0, nextOffset: null });

export function MemoryReview({ pid, store, onOpenInspector, onQueueChange }: {
  pid: string;
  store: AppStore;
  onOpenInspector: (uri: string) => void;
  onQueueChange?: (total: number) => void;
}) {
  const [reason, setReason] = useState<ApiMemoryReviewReason | undefined>();
  const [queue, setQueue] = useState<ApiMemoryReviewQueue>(emptyQueue);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [acting, setActing] = useState<string | null>(null);
  const [decision, setDecision] = useState<{ id: string; action: 'approve' | 'reject'; note: string } | null>(null);

  const load = useCallback(async (append = false) => {
    setLoading(true);
    setError('');
    try {
      const offset = append ? queue.nextOffset ?? 0 : 0;
      const next = await api.memoryReviewQueue(pid, { reason, limit: 50, offset });
      setQueue((current) => append ? { ...next, items: [...current.items, ...next.items] } : next);
      onQueueChange?.(next.overallTotal);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [onQueueChange, pid, queue.nextOffset, reason]);

  useEffect(() => { void load(false); }, [pid, reason]); // eslint-disable-line react-hooks/exhaustive-deps

  const settleDecision = async () => {
    if (!decision) return;
    setActing(decision.id);
    setError('');
    try {
      if (decision.action === 'approve') await api.memoryApproveDecision(pid, decision.id, decision.note || undefined);
      else await api.memoryRejectDecision(pid, decision.id, decision.note || undefined);
      setDecision(null);
      await load(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActing(null);
    }
  };

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '20px clamp(18px, 4vw, 54px) 48px' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20, marginBottom: 20 }}>
          <div style={{ flex: 1 }}>
            <SectionLabel>Human governance</SectionLabel>
            <h2 style={{ fontSize: 22, margin: '5px 0 7px' }}>Memory review queue</h2>
            <div style={{ color: 'var(--text-dim)', fontSize: 12.5, lineHeight: 1.55 }}>
              Resolve proposed decisions and inspect memories whose authority, validity, feedback, or contradictions need human judgement.
            </div>
          </div>
          {!store.permissions.canManage && (
            <MonoTag color="var(--text-dim)" bg="var(--w-05)" size={9}>READ-ONLY REVIEW</MonoTag>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))', gap: 8, marginBottom: 22 }}>
          {REASONS.map((item) => (
            <button key={item.id} onClick={() => setReason(reason === item.id ? undefined : item.id)} style={{
              cursor: 'pointer', textAlign: 'left', padding: '12px 13px', borderRadius: 10,
              background: reason === item.id ? 'var(--w-1)' : 'var(--w-04)',
              border: `1px solid ${reason === item.id ? item.color : 'var(--w-08)'}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 650 }}>{item.label}</span>
                <span style={{ color: item.color, fontFamily: 'var(--mono)', fontSize: 16 }}>{queue.counts[item.id] ?? 0}</span>
              </div>
              <div style={{ color: 'var(--text-faint)', fontSize: 10.5, marginTop: 4 }}>{item.detail}</div>
            </button>
          ))}
        </div>

        {error && <div style={{ color: 'var(--red-soft)', fontSize: 12, marginBottom: 14 }}>{error}</div>}
        {!loading && queue.items.length === 0 && (
          <div style={{ padding: 40, border: '1px dashed var(--w-12)', borderRadius: 12, textAlign: 'center', color: 'var(--text-dim)' }}>
            No memories currently need review{reason ? ' for this reason' : ''}.
          </div>
        )}
        <div style={{ display: 'grid', gap: 10 }}>
          {queue.items.map((item) => (
            <ReviewCard
              key={item.id}
              item={item}
              canManage={store.permissions.canManage}
              acting={acting === item.id}
              decision={decision?.id === item.id ? decision : null}
              onDecision={(action) => setDecision({ id: item.id, action, note: '' })}
              onNote={(note) => setDecision((current) => current?.id === item.id ? { ...current, note } : current)}
              onCancel={() => setDecision(null)}
              onConfirm={() => void settleDecision()}
              onInspect={() => onOpenInspector(`noriq://memory/${item.id}`)}
            />
          ))}
        </div>
        {loading && <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 11 }}>Loading review queue…</div>}
        {!loading && queue.nextOffset != null && <div style={{ textAlign: 'center', marginTop: 16 }}><Button variant="ghost" onClick={() => void load(true)}>Load more</Button></div>}
      </div>
    </div>
  );
}

function ReviewCard({ item, canManage, acting, decision, onDecision, onNote, onCancel, onConfirm, onInspect }: {
  item: ApiMemoryReviewQueueItem;
  canManage: boolean;
  acting: boolean;
  decision: { id: string; action: 'approve' | 'reject'; note: string } | null;
  onDecision: (action: 'approve' | 'reject') => void;
  onNote: (note: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  onInspect: () => void;
}) {
  return (
    <article style={{ padding: '14px 16px', border: '1px solid var(--w-08)', borderRadius: 11, background: 'var(--w-02)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 9 }}>
        <MonoTag color="var(--text-mid)" bg="var(--w-05)" size={8.5}>{item.kind.toUpperCase()}</MonoTag>
        <MonoTag color={item.authority <= 2 ? 'var(--amber)' : 'var(--blue)'} bg="var(--w-05)" size={8.5}>AUTH {item.authority}/5</MonoTag>
        {item.reasons.map((reason) => <MonoTag key={reason} color={REASONS.find((entry) => entry.id === reason)!.color} bg="var(--w-05)" size={8.5}>{REASONS.find((entry) => entry.id === reason)!.label.toUpperCase()}</MonoTag>)}
        <span style={{ flex: 1 }} />
        <span style={{ color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 9.5 }}>{new Date(item.recordedAt).toLocaleDateString()}</span>
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{item.statement}</div>
      {(item.repositoryKey || item.contradictionSetIds.length || item.recentNegativeFeedbackCount) ? (
        <div style={{ color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 9.5, marginTop: 9 }}>
          {item.repositoryKey && <span>{item.repositoryKey}{item.branch ? ` · ${item.branch}` : ''}{item.baseId ? ` @ ${item.baseId.slice(0, 10)}` : ''} </span>}
          {item.contradictionSetIds.length > 0 && <span> · {item.contradictionSetIds.length} unresolved contradiction set{item.contradictionSetIds.length === 1 ? '' : 's'}</span>}
          {item.recentNegativeFeedbackCount > 0 && <span> · {item.recentNegativeFeedbackCount} recent flag{item.recentNegativeFeedbackCount === 1 ? '' : 's'}</span>}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <Button variant="ghost" onClick={onInspect}>Inspect evidence & history</Button>
        {canManage && item.reasons.includes('proposed_decision') && !decision && <>
          <Button onClick={() => onDecision('approve')}>Approve decision</Button>
          <Button variant="danger" onClick={() => onDecision('reject')}>Reject</Button>
        </>}
      </div>
      {decision && <div style={{ borderTop: '1px solid var(--line)', marginTop: 13, paddingTop: 12 }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 7 }}>{decision.action === 'approve' ? 'Approve this as a settled decision' : 'Reject this proposed decision'}</div>
        <TextArea aria-label="Review note" placeholder="Optional review note" value={decision.note} onChange={(event) => onNote(event.target.value)} />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <Button variant={decision.action === 'reject' ? 'danger' : 'primary'} disabled={acting} onClick={onConfirm}>{acting ? 'Saving…' : `Confirm ${decision.action}`}</Button>
          <Button variant="ghost" disabled={acting} onClick={onCancel}>Cancel</Button>
        </div>
      </div>}
    </article>
  );
}
