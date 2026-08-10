import { useEffect, useState } from 'react';
import {
  api, type ApiDispatchIntelligence, type ApiDispatchMemoryExcerpt, type ApiDispatchPriorCase,
} from '../api';
import { MonoTag } from './bits';
import { Button } from './ui';

export function DispatchIntelligencePanel({
  pid, taskId, runnerId = null, repositoryCheckoutId = null, branch = null, baseId = null,
  budget = null, expanded = false,
  includeComparison = false,
}: {
  pid: string; taskId: string; runnerId?: string | null; repositoryCheckoutId?: string | null;
  branch?: string | null; baseId?: string | null;
  budget?: { maxTokens?: number | null; maxUsd?: number | null; maxDurationSeconds?: number | null; maxRounds?: number | null } | null;
  expanded?: boolean;
  includeComparison?: boolean;
}) {
  const [result, setResult] = useState<ApiDispatchIntelligence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const budgetKey = JSON.stringify(budget);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setError(null);
      void api.dispatchIntelligence(pid, {
        taskId, runnerId, repositoryCheckoutId, branch, baseId, budget,
        comparison: includeComparison ? { dimension: 'workflow', metric: 'run_success' } : undefined,
      }, controller.signal).then(setResult).catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [pid, taskId, runnerId, repositoryCheckoutId, branch, baseId, budgetKey, includeComparison]); // eslint-disable-line react-hooks/exhaustive-deps

  const judge = async (item: ApiDispatchPriorCase, judgment: 'relevant' | 'partially_relevant' | 'not_similar') => {
    const key = `${item.episodeId}:${item.runId}:${item.sitting}`;
    setFeedback((state) => ({ ...state, [key]: 'saving' }));
    try {
      await api.dispatchIntelligenceFeedback(pid, {
        taskId, runnerId, repositoryCheckoutId, branch, baseId,
        episodeId: item.episodeId, runId: item.runId, sitting: item.sitting,
        operationKey: `dispatch-preview-${Date.now()}-${item.episodeId}-${judgment}`,
        judgment,
      });
      setFeedback((state) => ({ ...state, [key]: judgment.replace('_', ' ') }));
    } catch (cause) {
      setFeedback((state) => ({ ...state, [key]: cause instanceof Error ? cause.message : 'feedback failed' }));
    }
  };

  return <details open={expanded} style={{ border: '1px solid var(--w-1)', borderRadius: 10, background: 'var(--w-025)', margin: '12px 0' }}>
    <summary style={{ cursor: 'pointer', padding: '11px 13px', fontWeight: 650, fontSize: 12 }}>
      Dispatch intelligence <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-dim)' }}>advisory · no automatic edits</span>
    </summary>
    <div style={{ padding: '0 13px 13px' }}>
      {!result && !error && <Note>Loading current facts and bounded prior evidence…</Note>}
      {error && <Note tone="red">Unavailable: {error}. Claim and dispatch controls remain unchanged.</Note>}
      {result && <>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          <MonoTag color="var(--green)" bg="rgba(63,217,139,.1)" size={8}>CURRENT STATE</MonoTag>
          <MonoTag color="var(--blue)" bg="rgba(76,157,255,.1)" size={8}>APPROVED / VERIFIED CONSTRAINTS</MonoTag>
          <MonoTag color="var(--amber)" bg="rgba(245,166,35,.1)" size={8}>QUOTED HISTORY</MonoTag>
          <MonoTag color="var(--purple)" bg="rgba(167,139,250,.1)" size={8}>STATISTICAL OBSERVATION</MonoTag>
        </div>
        <Section title="Current authoritative project state">
          <Note>{result.current.readiness
            ? `${result.current.readiness.taskKey}: ${result.current.readiness.primary} — ${result.current.readiness.reason}`
            : 'Readiness unavailable for this task in the bounded open-task set.'}</Note>
          <Note>{result.current.capacity.availableSlots == null
            ? `Runner capacity unavailable — ${result.current.capacity.note}`
            : `${result.current.capacity.availableSlots} available Runner slots; ${result.current.capacity.liveRunsCounted} live runs counted.`}</Note>
          <Note>{result.current.collisions.locking.status === 'unanswerable'
            ? 'Lock collision evidence unavailable because file locking is disabled or not observable; this is not evidence of no collision risk.'
            : `${result.current.collisions.locking.current.length} current lock collisions across anticipated paths.`}</Note>
          {result.current.coverage.reasons.length > 0 && <ReasonList label="Unanswerable or partial inputs" reasons={result.current.coverage.reasons} />}
          {result.targetContext.repositoryResolutionReason && <Note>{result.targetContext.repositoryResolutionReason}</Note>}
        </Section>
        <Section title="Human-approved and verified constraints">
          {![...result.constraints.decisions, ...result.constraints.hazards, ...result.constraints.unknowns].length
            ? <Note>No high-authority constraint was surfaced in this bounded context.</Note>
            : <>{result.constraints.decisions.map((item) => <MemoryCard key={item.id} item={item} label="decision" />)}{result.constraints.hazards.map((item) => <MemoryCard key={item.id} item={item} label="hazard" />)}{result.constraints.unknowns.map((item) => <MemoryCard key={item.id} item={item} label="unknown" />)}</>}
        </Section>
        <Section title={`Historical cases · ${result.historical.cases.length} shown`}>
          {!result.historical.cases.length ? <Note>No qualifying similar effort was found; no low-n ranking was inferred.</Note>
            : <div className="dispatch-intelligence-cases">{result.historical.cases.map((item) => {
              const key = `${item.episodeId}:${item.runId}:${item.sitting}`;
              return <article key={key} style={{ padding: 10, border: '1px solid var(--w-08)', borderRadius: 8 }}>
                <b style={{ fontSize: 11 }}>Run {item.runId} · sitting {item.sitting}</b>
                <div style={small}>case {item.episodeId} · {item.validity.replace('_', ' ')} · lineage {item.lineage.status}</div>
                <div style={{ fontSize: 11, marginTop: 6 }}>{item.whatWasAttempted || 'No approach summary was reported.'}</div>
                {item.whatFailed.length > 0 && <ReasonList label="Failed approach evidence" reasons={item.whatFailed} />}
                <div style={{ ...small, marginTop: 6 }}>support: {item.retrieval.support.map((support) => `${support.kind}: ${support.detail}`).join(' · ')}</div>
                <div style={{ ...small, marginTop: 4 }}>tokens {observation(item.observed.tokens)} · cost {observation(item.observed.costUSD, '$')} · elapsed {observation(item.observed.elapsedMs, 'ms')}</div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 8 }}>
                  <Button variant="ghost" disabled={feedback[key] === 'saving'} onClick={() => void judge(item, 'relevant')} style={{ padding: '4px 7px', fontSize: 9 }}>Relevant</Button>
                  <Button variant="ghost" disabled={feedback[key] === 'saving'} onClick={() => void judge(item, 'partially_relevant')} style={{ padding: '4px 7px', fontSize: 9 }}>Partial</Button>
                  <Button variant="ghost" disabled={feedback[key] === 'saving'} onClick={() => void judge(item, 'not_similar')} style={{ padding: '4px 7px', fontSize: 9 }}>Not similar</Button>
                  {feedback[key] && <span role="status" style={small}>{feedback[key]}</span>}
                </div>
              </article>;
            })}</div>}
          {!result.historical.coverage.complete && <ReasonList label="Retrieval exclusions" reasons={result.historical.coverage.reasons} />}
        </Section>
        <Section title="Scope and budget observations">
          <Note>{result.observations.scope.observation}</Note>
          {Object.entries(result.observations.budget).map(([name, value]) => <Note key={name}>{value.observation} · completeness {value.completeness}</Note>)}
          {result.observations.coverage.reasons.length > 0 && <ReasonList label="Missing evidence" reasons={result.observations.coverage.reasons} />}
        </Section>
        <Section title="Provisional and failed-approach memory">
          {!result.quotedEvidence.failedApproaches.length && !result.quotedEvidence.relevant.length
            ? <Note>No additional quoted memory evidence fit this bounded pack.</Note>
            : <>{result.quotedEvidence.failedApproaches.map((item) => <MemoryCard key={item.id} item={item} label="failed approach" />)}{result.quotedEvidence.relevant.map((item) => <MemoryCard key={item.id} item={item} label="memory evidence" />)}</>}
          <div style={small}>Evidence frame: {result.quotedEvidence.evidenceFrame.itemsIncluded} included · {result.quotedEvidence.evidenceFrame.itemsOmitted} omitted{result.quotedEvidence.evidenceFrame.truncated ? ' · truncated' : ''}</div>
        </Section>
        <Section title="Eligible strategy comparison">
          {!result.comparison || result.comparison.rows.length === 0
            ? <Note>{result.comparison?.interpretation ?? 'No comparison requested'}{result.comparison?.eligibility.reasons.length ? ` — ${result.comparison.eligibility.reasons.join(' · ')}` : ''}. No strategy control was changed.</Note>
            : result.comparison.rows.map((row) => <Note key={row.strategy}>{row.strategy}: {row.observations} cases / {row.independentClusters} clusters; median {row.distribution.median}; interval {row.interval.low}–{row.interval.high}. {result.comparison!.interpretation}.</Note>)}
        </Section>
        <div style={{ ...small, marginTop: 9 }}>Versions: {result.version} · {result.observations.versions.risk} · {result.observations.versions.retrieval}. Preview creates no occurrence or outcome record.</div>
      </>}
    </div>
  </details>;
}

const small: React.CSSProperties = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-dim)', lineHeight: 1.45, overflowWrap: 'anywhere' };
function Section({ title, children }: { title: string; children: React.ReactNode }) { return <section style={{ padding: '9px 0', borderTop: '1px solid var(--w-07)' }}><h4 style={{ fontSize: 10.5, margin: '0 0 6px' }}>{title}</h4>{children}</section>; }
function Note({ children, tone }: { children: React.ReactNode; tone?: 'red' }) { return <div style={{ fontSize: 10.5, lineHeight: 1.5, color: tone === 'red' ? 'var(--red-soft)' : 'var(--text-mid)', margin: '3px 0' }}>{children}</div>; }
function ReasonList({ label, reasons }: { label: string; reasons: string[] }) { return <div style={{ ...small, marginTop: 6 }}><b>{label}:</b> {reasons.join(' · ')}</div>; }
function MemoryCard({ item, label }: { item: ApiDispatchMemoryExcerpt; label: string }) { return <blockquote style={{ margin: '6px 0', padding: '7px 9px', borderLeft: '2px solid var(--w-18)', background: 'var(--w-03)' }}><div style={small}>{label} · authority {item.authority} · validity {item.validity} · {item.isLead ? `LEAD: ${item.leadReasons.join(', ')}` : 'not a lead'}</div><div style={{ fontSize: 10.5, marginTop: 3 }}>“{item.statement}”{item.statementTruncated ? ' (excerpt)' : ''}</div><div style={small}>{item.evidence.length} evidence citation(s)</div></blockquote>; }
function observation(item: { value: number | boolean | null; completeness: string }, suffix = '') { return item.value == null ? `unavailable (${item.completeness})` : `${suffix === '$' ? '$' : ''}${item.value}${suffix === '$' ? '' : suffix} (${item.completeness})`; }
