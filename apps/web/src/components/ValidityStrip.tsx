import { AssessmentHistory } from './AssessmentHistory';
import { ReadinessOverrideForm } from './ReadinessOverrideForm';
import { AssessmentForm } from './AssessmentForm';
// Compact Validity strip for subject inspectors (P2-B).
// Same REST actions as Review → Validity — not a second inbox.
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type ApiProjectDoc,
  type ApiReviewCause,
  type ApiSubjectFreshness,
  type ApiValidationSubjectType,
} from '../api';
import { MonoTag } from './bits';
import { PlanSearchSelect } from './PlanSearchSelect';
import { TaskSearchSelect } from './TaskSearchSelect';
import { Button } from './ui';
import { openReviewValidityTab } from './ReviewInboxChrome';

export const VALIDITY_CAUSES: Array<{ id: ApiReviewCause; label: string; detail: string; color: string }> = [
  { id: 'direction_changed', label: 'Recheck before reclaiming', detail: 'Reconcile explicit direction changes with current task intent', color: 'var(--red-soft)' },
  { id: 'readiness_required', label: 'Readiness evidence required', detail: 'Recheck this task against its current phase and repository context', color: 'var(--red-soft)' },
  { id: 'assessment_failed', label: 'Readiness check failed', detail: 'Resolve the failed assessment or record an explicit exception', color: 'var(--red-soft)' },
  { id: 'content_changed', label: 'Content changed', detail: 'Fingerprint moved past last validation', color: 'var(--red-soft)' },
  { id: 'doc_baseline_moved', label: 'Doc pin drifted', detail: 'Linked settled doc advanced past pin', color: 'var(--red-soft)' },
  { id: 'superseded', label: 'Superseded', detail: 'Replaced by another entity', color: 'var(--amber)' },
  { id: 'human_flagged', label: 'Human flagged', detail: 'Marked for check', color: 'var(--amber)' },
  { id: 'code_assessment_stale', label: 'Code assessment stale', detail: 'Agent-declared base drift (P1)', color: 'var(--blue)' },
  { id: 'dormant', label: 'Dormant', detail: 'Opt-in quiet period (P1)', color: 'var(--text-dim)' },
  { id: 'never_validated', label: 'Never validated', detail: 'No matching validation record yet', color: 'var(--text-dim)' },
  { id: 'impact_unknown', label: 'Impact unknown', detail: 'No code assessment attached', color: 'var(--text-faint)' },
];

export function causeMeta(code: ApiReviewCause) {
  return VALIDITY_CAUSES.find((c) => c.id === code);
}

/** Timed-snooze presets (P2-C) — duration → until; does not invent validity. */
const SNOOZE_PRESETS: Array<{ label: string; seconds: number }> = [
  { label: '1h', seconds: 3600 },
  { label: '1d', seconds: 86400 },
  { label: '1w', seconds: 7 * 86400 },
];

export interface ValidityStripProps {
  projectId: string;
  subjectType: ApiValidationSubjectType;
  subjectId: string;
  /** When provided (e.g. from taskDetail), skip the freshness fetch until refresh. */
  initialFreshness?: ApiSubjectFreshness | null;
  canAct?: boolean;
  setView: (view: 'review') => void;
  compact?: boolean;
}

export function ValidityStrip({
  projectId,
  subjectType,
  subjectId,
  initialFreshness = null,
  canAct = true,
  setView,
  compact = false,
}: ValidityStripProps) {
  const [freshness, setFreshness] = useState<ApiSubjectFreshness | null>(initialFreshness);
  const [loading, setLoading] = useState(!initialFreshness);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [assessing, setAssessing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [overriding, setOverriding] = useState(false);
  const [superseding, setSuperseding] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  const [replacementId, setReplacementId] = useState('');
  const [docs, setDocs] = useState<ApiProjectDoc[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const next = await api.subjectFreshness(projectId, subjectType, subjectId);
      setFreshness(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectId, subjectId, subjectType]);

  useEffect(() => {
    setFreshness(initialFreshness);
    if (initialFreshness) {
      setLoading(false);
      return;
    }
    void load();
  }, [initialFreshness, load, subjectId]);

  useEffect(() => {
    if (!superseding || subjectType !== 'doc') return;
    let cancelled = false;
    api.docs(projectId).then((r) => {
      if (!cancelled) setDocs(r.docs.filter((d) => d.id !== subjectId));
    }).catch(() => { if (!cancelled) setDocs([]); });
    return () => { cancelled = true; };
  }, [projectId, subjectId, subjectType, superseding]);

  const flag = async () => {
    setBusy(true);
    setError('');
    try {
      await api.setReviewCause(projectId, {
        subjectType,
        subjectId,
        cause: 'human_flagged',
        status: 'open',
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const snoozeCause = async (cause: ApiReviewCause, durationSeconds: number) => {
    setBusy(true);
    setError('');
    try {
      await api.setReviewCause(projectId, {
        subjectType,
        subjectId,
        cause,
        status: 'snoozed',
        durationSeconds,
      });
      setSnoozing(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmSupersede = async () => {
    if (!replacementId || replacementId === subjectId) return;
    setBusy(true);
    setError('');
    try {
      await api.setSupersedes(projectId, {
        subjectType,
        subjectId: replacementId,
        priorId: subjectId,
      });
      setSuperseding(false);
      setReplacementId('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const causes = [...new Set([...(freshness?.causes.map((c) => c.code) ?? []), ...(freshness?.blockingCauses ?? freshness?.criticalCauses ?? [])])];
  const critical = new Set(freshness?.criticalCauses ?? []);
  const lastValidatedAt = freshness?.lastValidatedAt ?? null;
  // Prefer critical, else first non-never/impact cause, else first cause — for snooze target.
  const snoozeTarget =
    freshness?.causes.find((c) => critical.has(c.code))?.code
    ?? freshness?.causes.find((c) => c.code !== 'never_validated' && c.code !== 'impact_unknown')?.code
    ?? freshness?.causes[0]?.code
    ?? null;

  return (
    <section
      data-testid="validity-strip"
      aria-label="Validity"
      style={{
        marginTop: compact ? 8 : 12,
        marginBottom: compact ? 4 : 10,
        padding: compact ? '8px 10px' : '10px 12px',
        borderRadius: 10,
        border: '1px solid var(--w-08)',
        background: 'var(--w-02)',
        opacity: busy ? 0.6 : 1,
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '.06em', textTransform: 'uppercase',
          color: 'var(--text-faint)',
        }}>
          Validity
        </span>
        {loading && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)' }}>loading…</span>
        )}
        {!loading && causes.length === 0 && freshness?.assessment?.readiness.state === 'passed' && (
          <MonoTag color="var(--green)" bg="rgba(63,217,139,.1)" size={8.5}>EVIDENCE CURRENT</MonoTag>
        )}
        {!loading && causes.map((code) => {
          const meta = causeMeta(code);
          return (
            <MonoTag
              key={code}
              color={meta?.color ?? 'var(--text-dim)'}
              bg={critical.has(code) ? 'rgba(255,92,92,.1)' : 'var(--w-05)'}
              size={8.5}
            >
              {(meta?.label ?? code).toUpperCase()}
            </MonoTag>
          );
        })}
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>
          {lastValidatedAt
            ? `last validated ${new Date(lastValidatedAt).toLocaleDateString()}`
            : 'never validated'}
        </span>
      </div>

      {!loading && <div style={{ fontSize: 12, marginBottom: 8 }}>
        <div>Project policy: {freshness?.assessment?.projectPolicy ?? 'legacy'}</div>
        {subjectType === 'task' && freshness?.assessment?.readiness.state === 'missing' && <div>Unverified backlog</div>}
        {freshness?.assessment?.directionMarkers?.map(m=><div key={m.id}>Recheck before reclaiming: {m.reason}</div>)}
        <div>{subjectType === 'task' ? 'Readiness' : 'Document evidence'}: {freshness?.assessment?.readiness.state ?? 'missing'}
          {lastValidatedAt && !freshness?.assessment?.readiness.record ? ' — legacy attestation only' : ''}</div>
        {subjectType === 'task' && <div>Implementation: {freshness?.assessment?.implementation.state ?? 'missing'}</div>}
        {[freshness?.assessment?.readiness.record, freshness?.assessment?.implementation.record].filter(Boolean).map(record => <details key={record!.id}>
          <summary>{record!.purpose} · {record!.actorName} · {new Date(record!.createdAt).toLocaleString()} · actor reported</summary>
          <p>{record!.summary}</p><p>{record!.repositoryKey} {record!.branch} {record!.baseId}</p>
          <ul>{record!.evidence.map((item, i) => <li key={i}>{item.kind}: {item.reference} — {item.result}</li>)}</ul>
        </details>)}
      </div>}
      {freshness?.assessment?.overrides?.map(o => <div key={o.id} role="status" style={{ fontSize: 12, marginBottom: 8 }}>
        {o.scope} exception by {o.actorName} until {new Date(o.expiresAt).toLocaleString()}: {o.reason}
      </div>)}
      {overriding && <ReadinessOverrideForm projectId={projectId} subjectId={subjectId} onCancel={() => setOverriding(false)}
        onSaved={async () => { setOverriding(false); await load(); }} />}
          <Button variant="ghost" onClick={() => setHistoryOpen(v => !v)}>Evidence history</Button>
      {historyOpen && <AssessmentHistory projectId={projectId} subjectType={subjectType} subjectId={subjectId} />}
      {assessing && <AssessmentForm projectId={projectId} subjectType={subjectType} subjectId={subjectId}
        onCancel={() => setAssessing(false)} onSaved={async () => { setAssessing(false); await load(); }} />}
      {error && (
        <div style={{ color: 'var(--red-soft)', fontSize: 11.5, marginBottom: 8 }}>{error}</div>
      )}

      {canAct && !overriding && !assessing && !superseding && !snoozing && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <Button
            variant="primary"
            style={{ padding: '4px 10px', fontSize: 11 }}
            onClick={() => setAssessing(true)}
            disabled={busy || loading}
          >
            Record evidence
          </Button>
          {subjectType === 'task' && <Button variant="ghost" disabled={busy || loading} onClick={() => setOverriding(true)}>Explicit override…</Button>}
          <Button
            variant="ghost"
            style={{ padding: '4px 10px', fontSize: 11 }}
            onClick={() => void flag()}
            disabled={busy || loading}
            title="Open a human_flagged review cause — does not invent validity"
          >
            Flag
          </Button>
          <Button
            variant="ghost"
            style={{ padding: '4px 10px', fontSize: 11 }}
            onClick={() => setSnoozing(true)}
            disabled={busy || loading || !snoozeTarget}
            title="Defer the reminder; claim blockers remain in effect"
          >
            Snooze…
          </Button>
          <Button
            variant="ghost"
            style={{ padding: '4px 10px', fontSize: 11 }}
            onClick={() => { setSuperseding(true); setReplacementId(''); }}
            disabled={busy || loading}
            title="Link a newer subject that supersedes this one — history stays readable; nothing auto-closes"
          >
            Supersede…
          </Button>
          <Button
            variant="ghost"
            style={{ padding: '4px 10px', fontSize: 11 }}
            onClick={() => openReviewValidityTab(setView)}
            disabled={busy}
          >
            Open in Review
          </Button>
        </div>
      )}

      {canAct && snoozing && snoozeTarget && (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ color: 'var(--text-dim)', fontSize: 11.5, lineHeight: 1.45 }}>
            Snooze {causeMeta(snoozeTarget)?.label ?? snoozeTarget} — reminder deferred until expiry; claim blockers remain in effect.
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {SNOOZE_PRESETS.map((preset) => (
              <Button
                key={preset.label}
                variant="primary"
                style={{ padding: '4px 10px', fontSize: 11 }}
                onClick={() => void snoozeCause(snoozeTarget, preset.seconds)}
                disabled={busy}
              >
                {preset.label}
              </Button>
            ))}
            <Button
              variant="ghost"
              style={{ padding: '4px 10px', fontSize: 11 }}
              onClick={() => setSnoozing(false)}
            >
              cancel
            </Button>
          </div>
        </div>
      )}

      {canAct && superseding && (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ color: 'var(--text-dim)', fontSize: 11.5, lineHeight: 1.45 }}>
            Pick the new current {subjectType}. This subject stays readable as prior history — status is not auto-closed.
          </div>
          {subjectType === 'task' && (
            <TaskSearchSelect
              projectId={projectId}
              value={replacementId}
              onChange={setReplacementId}
              label="Replacement task"
              placeholder="Search the newer task…"
            />
          )}
          {subjectType === 'plan' && (
            <PlanSearchSelect
              projectId={projectId}
              value={replacementId}
              onChange={setReplacementId}
              label="Replacement plan"
              placeholder="Search the newer plan…"
            />
          )}
          {subjectType === 'doc' && (
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '.05em',
                textTransform: 'uppercase', color: 'var(--text-faint)',
              }}>
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
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <Button
              variant="primary"
              style={{ padding: '4px 10px', fontSize: 11 }}
              onClick={() => void confirmSupersede()}
              disabled={!replacementId || replacementId === subjectId || busy}
            >
              link supersedes
            </Button>
            <Button
              variant="ghost"
              style={{ padding: '4px 10px', fontSize: 11 }}
              onClick={() => { setSuperseding(false); setReplacementId(''); }}
            >
              cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
