import { useEffect, useState } from 'react';
import {
  api, type ApiAnalyticsGroup, type ApiComparisonMetric, type ApiIntelligenceCase,
  type ApiIntelligenceDimension, type ApiProjectIntelligence, type ApiStrategyDimension,
} from '../api';
import type { AppStore } from '../store';
import { MonoTag, SectionLabel } from './bits';
import { Button, Select } from './ui';
import { MIN_TOUCH_TARGET, useViewport } from '../viewport';

const card: React.CSSProperties = {
  background: 'var(--w-025)', border: '1px solid var(--w-08)', borderRadius: 12, padding: 15, minWidth: 0,
};
const mono: React.CSSProperties = { fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)' };
const fmtDate = (value: string | null) => value ? new Date(value).toLocaleString() : 'unavailable';
const fmtDuration = (value: number | null) => value == null ? 'unavailable'
  : value < 60_000 ? `${Math.round(value / 1_000)}s`
    : value < 3_600_000 ? `${Math.round(value / 60_000)}m` : `${(value / 3_600_000).toFixed(1)}h`;
const fmtNumber = (value: number | null, digits = 0) => value == null ? 'unavailable' : value.toLocaleString(undefined, { maximumFractionDigits: digits });
const fmtRate = (value: number | null) => value == null ? 'unavailable' : `${Math.round(value * 100)}%`;
const metricLabel: Record<string, string> = {
  elapsedExecutionMs: 'Elapsed', parkedMs: 'Parked', verifyDurationMs: 'Verify', tokens: 'Tokens', costUSD: 'Cost',
};

export function IntelligenceView({ store }: { store: AppStore }) {
  const { phone } = useViewport();
  const pid = store.currentPid;
  const [days, setDays] = useState(30);
  const [groupBy, setGroupBy] = useState<ApiIntelligenceDimension>('executed_workflow');
  const [dimension, setDimension] = useState<ApiStrategyDimension>('workflow');
  const [metric, setMetric] = useState<ApiComparisonMetric>('run_success');
  const [packet, setPacket] = useState<ApiProjectIntelligence | null>(null);
  const [cases, setCases] = useState<ApiIntelligenceCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [casesOpen, setCasesOpen] = useState(false);

  const load = async (cursor?: string) => {
    if (!pid) return;
    cursor ? setLoadingMore(true) : setLoading(true);
    setError(null);
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    try {
      const next = await api.projectIntelligence(pid, {
        from: from.toISOString(), to: to.toISOString(), groupBy, caseCursor: cursor, caseLimit: 24,
        comparison: { dimension, metric },
      });
      setPacket(next);
      const page = next.analytics.historical.state === 'available' ? next.analytics.historical.result.cases.items : [];
      setCases((current) => cursor ? [...current, ...page] : page);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false); setLoadingMore(false);
    }
  };
  useEffect(() => { setPacket(null); setCases([]); void load(); }, [pid, days, groupBy, dimension, metric]); // eslint-disable-line react-hooks/exhaustive-deps

  const navigate = (view: 'executions' | 'memory', params: Record<string, string | null>) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
    history.pushState(null, '', `/p/${encodeURIComponent(pid)}/${view}${query.size ? `?${query}` : ''}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  if (loading && !packet) return <State title="Loading Project Intelligence" detail="Reading current coordination and the latest complete analytics generation…" />;
  if (error && !packet) return <State title="Project Intelligence unavailable" detail={error} action={<Button onClick={() => void load()}>Retry</Button>} />;
  if (!packet) return null;
  const historical = packet.analytics.historical;
  const groups = historical.state === 'available' ? historical.result.groups : [];
  const nextCursor = historical.state === 'available' ? historical.result.cases.nextCursor : null;

  return <main className="intelligence-view" style={{ position: 'absolute', inset: 0, overflowY: 'auto', padding: phone ? 14 : 22 }}>
    <div style={{ maxWidth: 1320, margin: '0 auto' }}>
      <header style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ flex: 1, minWidth: phone ? '100%' : 260 }}>
          <SectionLabel>Project Intelligence</SectionLabel>
          <h1 style={{ fontSize: 22, margin: '5px 0 4px' }}>Execution evidence, live flow, and capacity</h1>
          <div style={{ ...mono, lineHeight: 1.5 }}>Live coordination and historical evidence are shown on separate clocks. Values marked unavailable are never inferred as zero.</div>
        </div>
        <label style={{ ...mono, flex: phone ? 1 : undefined }}>Range
          <Select variant={phone ? 'micro' : undefined} aria-label="Analytics range" value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ marginTop: 5, minWidth: phone ? 0 : 110, width: phone ? '100%' : undefined }}>
            <option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={366}>366 days</option>
          </Select>
        </label>
        <label style={{ ...mono, flex: phone ? 1.5 : undefined }}>Composition
          <Select variant={phone ? 'micro' : undefined} aria-label="Analytics grouping" value={groupBy} onChange={(e) => setGroupBy(e.target.value as ApiIntelligenceDimension)} style={{ marginTop: 5, minWidth: phone ? 0 : 170, width: phone ? '100%' : undefined }}>
            <option value="executed_workflow">Executed workflow</option><option value="commissioned_workflow">Commissioned workflow</option>
            <option value="configuration">Configuration</option><option value="stage">Stage</option><option value="role">Role</option>
          </Select>
        </label>
      </header>

      {error && <div role="alert" style={{ ...card, borderColor: 'var(--red-soft)', marginBottom: 14 }}>{error}</div>}
      <section aria-labelledby="live-intelligence" style={{ marginBottom: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <h2 id="live-intelligence" style={{ fontSize: 14, margin: 0 }}>Live coordination</h2>
          <MonoTag color="var(--green)" bg="rgba(63,217,139,.1)" size={8}>CURRENT D1</MonoTag>
          <span style={mono}>observed {fmtDate(packet.live.observedAt)}</span>
        </div>
        <div className="intelligence-grid">
          <EvidenceCard title="Task readiness" primary={`${packet.live.readiness.readyTasks} ready`} details={`${packet.live.readiness.inProgressTasks} active · ${packet.live.readiness.blockedTasks} blocked · ${packet.live.readiness.reviewTasks} review`} />
          <EvidenceCard title="Execution flow" primary={`${packet.live.execution.activeNodes} live nodes`} details={`${packet.live.execution.parkedNodes} parked · ${sum(packet.live.execution.runStatuses)} runs`} action={<Button variant="ghost" onClick={() => navigate('executions', {})}>Open execution tree</Button>} />
          <EvidenceCard title="Coordination" primary={`${packet.live.coordination.activeClaims} claims`} details={`${packet.live.coordination.activeLocks} active file locks`} />
          <EvidenceCard title="Runner capacity" primary={packet.live.runners.capacity.freeSlots == null ? 'unavailable' : `${packet.live.runners.capacity.freeSlots} free slots`} details={packet.live.runners.capacity.maxConcurrency == null ? `${packet.live.runners.capacity.reportedRunners} reporting runners` : `${packet.live.runners.capacity.busySlots} busy of ${packet.live.runners.capacity.maxConcurrency} · ${packet.live.runners.capacity.completeness}`} />
          <EvidenceCard title="Plan gates" primary={`${packet.live.plans.phaseGateStatuses.pending ?? 0} pending`} details={`${packet.live.plans.phasesWithoutGate} phases without gate · ${packet.live.plans.landings.owed} landings owed`} />
          <EvidenceCard title="Analytics freshness" primary={packet.analytics.freshness.state.replace('_', ' ')} details={`${packet.analytics.freshness.label}. Generation: ${fmtDate(packet.analytics.freshness.generationCompletedAt)}`} />
        </div>
      </section>

      <section aria-labelledby="history-intelligence" style={{ marginBottom: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <h2 id="history-intelligence" style={{ fontSize: 14, margin: 0 }}>Historical execution</h2>
          <MonoTag color="var(--amber)" bg="rgba(245,166,35,.1)" size={8}>FROZEN GENERATION</MonoTag>
          <span style={mono}>{historical.state === 'available' ? `completed ${fmtDate(historical.result.generation.completedAt)}` : `state: ${packet.analytics.health.state}`}</span>
        </div>
        {historical.state === 'unavailable'
          ? <State inline title="No complete analytics generation" detail={`${historical.reason}. Live coordination above remains available.`} />
          : <>
            {!historical.result.coverage.complete && <Coverage reasons={historical.result.coverage.reasons} />}
            {!groups.length ? <State inline title="No historical cases in this range" detail="The dashboard remains useful for live readiness and capacity while execution evidence accumulates." />
              : <div className="intelligence-groups">{groups.map((group) => <GroupCard key={`${group.dimension}:${group.value}`} group={group} onOpen={(item) => navigate('executions', { orchestration: item.orchestrationId, execution: item.executionId })} />)}</div>}
          </>}
      </section>

      {(!phone || comparisonOpen) && <section aria-labelledby="comparison-intelligence" style={{ marginBottom: 22 }}>
        <div style={{ display: 'flex', alignItems: 'end', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
          <div style={{ flex: 1, minWidth: 220 }}><h2 id="comparison-intelligence" style={{ fontSize: 14, margin: 0 }}>Evidence-gated comparison</h2><div style={mono}>Server-authored cohorts and intervals only; no winner or recommendation.</div></div>
          <Select aria-label="Comparison dimension" value={dimension} onChange={(e) => setDimension(e.target.value as ApiStrategyDimension)} style={{ width: 170 }}>
            <option value="workflow">Workflow</option><option value="model_vendor_effort">Model/vendor/effort</option><option value="reviewer_verifier">Reviewer/verifier</option><option value="context">Context</option><option value="concurrency">Concurrency</option><option value="configuration">Configuration</option>
          </Select>
          <Select aria-label="Comparison metric" value={metric} onChange={(e) => setMetric(e.target.value as ApiComparisonMetric)} style={{ width: 170 }}>
            <option value="run_success">Run success</option><option value="landing">Landing</option><option value="elapsed_ms">Elapsed</option><option value="files_changed">Files changed</option><option value="churn">Churn</option><option value="review_rounds">Review rounds</option><option value="later_quality_event">Later quality event</option>
          </Select>
        </div>
        {!packet.comparison ? <State inline title="Comparison unavailable" detail="No comparison result was requested." />
          : packet.comparison.rows.length === 0
            ? <State inline title={packet.comparison.interpretation} detail={packet.comparison.eligibility.reasons.join(' · ') || 'The evidence gates did not expose comparable rows.'} />
            : <div className="intelligence-grid">{packet.comparison.rows.map((row) => <EvidenceCard key={row.strategy} title={row.strategy} primary={`median ${fmtNumber(row.distribution.median, 2)}`} details={`${row.observations} cases · ${row.independentClusters} independent clusters · ${(row.interval.confidence * 100).toFixed(0)}% interval ${fmtNumber(row.interval.low, 2)}–${fmtNumber(row.interval.high, 2)}`} />)}</div>}
      </section>}

      {(!phone || casesOpen) && <section aria-labelledby="case-intelligence">
        <h2 id="case-intelligence" style={{ fontSize: 14, margin: '0 0 8px' }}>Canonical case drill-down</h2>
        <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
          {!cases.length ? <div style={{ padding: 18, color: 'var(--text-dim)' }}>No cases in this bounded page.</div> : cases.map((item) => <div key={item.episodeId} className="intelligence-case">
            <div style={{ minWidth: 0, flex: 1 }}><b style={{ fontSize: 12 }}>Run {item.runId} · sitting {item.sitting}</b><div style={{ ...mono, overflow: 'hidden', textOverflow: 'ellipsis' }}>episode {item.episodeId}{item.taskId ? ` · task ${item.taskId}` : ''}{item.planId ? ` · plan ${item.planId}` : ''}</div></div>
            {item.orchestrationId && <Button variant="ghost" onClick={() => navigate('executions', { orchestration: item.orchestrationId, execution: item.executionId })}>Execution</Button>}
            <Button variant="ghost" onClick={() => navigate('memory', { q: item.episodeId })}>Evidence</Button>
          </div>)}
          {nextCursor && <div style={{ padding: 12, borderTop: '1px solid var(--w-07)', textAlign: 'center' }}><Button variant="ghost" disabled={loadingMore} onClick={() => void load(nextCursor)}>{loadingMore ? 'Loading…' : 'Load more cases'}</Button></div>}
        </div>
      </section>}
      {phone && <nav aria-label="Additional intelligence" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 16 }}>
        <button type="button" aria-expanded={comparisonOpen} onClick={() => setComparisonOpen((open) => !open)} style={{ minHeight: MIN_TOUCH_TARGET, borderRadius: 10, cursor: 'pointer', background: comparisonOpen ? 'rgba(198,242,78,.1)' : 'var(--w-03)', border: `1px solid ${comparisonOpen ? 'rgba(198,242,78,.35)' : 'var(--w-09)'}`, color: comparisonOpen ? 'var(--accent)' : 'var(--text-mid)', fontSize: 12.5 }}>{comparisonOpen ? 'Hide compare' : 'Compare'}</button>
        <button type="button" aria-expanded={casesOpen} onClick={() => setCasesOpen((open) => !open)} style={{ minHeight: MIN_TOUCH_TARGET, borderRadius: 10, cursor: 'pointer', background: casesOpen ? 'rgba(198,242,78,.1)' : 'var(--w-03)', border: `1px solid ${casesOpen ? 'rgba(198,242,78,.35)' : 'var(--w-09)'}`, color: casesOpen ? 'var(--accent)' : 'var(--text-mid)', fontSize: 12.5 }}>{casesOpen ? 'Hide cases' : 'Cases'}</button>
      </nav>}
    </div>
  </main>;
}

function EvidenceCard({ title, primary, details, action }: { title: string; primary: string; details: string; action?: React.ReactNode }) {
  return <article style={card}><div style={mono}>{title.toUpperCase()}</div><div style={{ fontSize: 20, fontWeight: 700, margin: '6px 0 3px' }}>{primary}</div><div style={{ fontSize: 11, color: 'var(--text-mid)', lineHeight: 1.5 }}>{details}</div>{action && <div style={{ marginTop: 10 }}>{action}</div>}</article>;
}
function GroupCard({ group, onOpen }: { group: ApiAnalyticsGroup; onOpen: (item: ApiIntelligenceCase) => void }) {
  const metrics = ['elapsedExecutionMs', 'parkedMs', 'verifyDurationMs', 'tokens', 'costUSD'];
  return <article style={card}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}><b style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{group.value}</b><MonoTag color="var(--text-mid)" bg="var(--w-06)" size={8}>{group.sample.sittings} SITTINGS</MonoTag></div>
    <div className="intelligence-metrics">{metrics.map((key) => { const value = group.metrics[key]; const rendered = key.endsWith('Ms') ? fmtDuration(value?.median ?? null) : key === 'costUSD' ? value?.median == null ? 'unavailable' : `$${value.median.toFixed(2)}` : fmtNumber(value?.median ?? null); return <div key={key}><span style={mono}>{metricLabel[key]}</span><b>{rendered}</b><small>{value?.denominator ?? 0}/{group.sample.sittings} observed</small></div>; })}</div>
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 12, ...mono }}><span>done {fmtRate(group.outcomes.done.rate)} ({group.outcomes.done.numerator}/{group.outcomes.done.denominator})</span><span>landed {fmtRate(group.outcomes.landed.rate)} ({group.outcomes.landed.numerator}/{group.outcomes.landed.denominator})</span><span>later quality {fmtRate(group.outcomes.laterInstability.rate)} · {group.outcomes.laterInstability.status}</span></div>
    {(group.composition.roles.length > 0 || group.composition.stages.length > 0) && <div style={{ marginTop: 12 }}><div style={mono}>WITHIN-STRATEGY COMPOSITION</div>{[...group.composition.roles, ...group.composition.stages].slice(0, 8).map((entry) => <div key={`${entry.value}:${entry.sittingCount}`} style={{ display: 'flex', gap: 8, fontSize: 11, marginTop: 5 }}><span style={{ flex: 1 }}>{entry.value}</span><span>{entry.tokens.share == null ? `tokens ${entry.tokens.completeness}` : `${Math.round(entry.tokens.share * 100)}% tokens`}</span><span>{entry.costUSD.share == null ? `cost ${entry.costUSD.completeness}` : `${Math.round(entry.costUSD.share * 100)}% cost`}</span></div>)}</div>}
    <div style={{ marginTop: 12, ...mono }}>{group.completeness.lineageComplete} complete · {group.completeness.lineagePartial} partial · {group.completeness.lineageUnknown} unknown lineage</div>
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>{group.supportingCases.slice(0, 4).map((item) => <Button key={item.episodeId} variant="ghost" disabled={!item.orchestrationId} onClick={() => onOpen(item)}>Run {item.runId.slice(-6)} / {item.sitting}</Button>)}</div>
  </article>;
}
function Coverage({ reasons }: { reasons: string[] }) { return <div role="status" style={{ ...card, borderColor: 'var(--amber)', marginBottom: 10 }}><b>Partial analytics coverage</b><div style={{ ...mono, marginTop: 4 }}>{reasons.join(' · ') || 'Some evidence is incomplete.'}</div></div>; }
function State({ title, detail, action, inline = false }: { title: string; detail: string; action?: React.ReactNode; inline?: boolean }) { return <div style={{ position: inline ? undefined : 'absolute', inset: inline ? undefined : 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}><div style={{ ...card, maxWidth: 620, width: inline ? '100%' : undefined }}><b>{title}</b><div style={{ ...mono, marginTop: 6, lineHeight: 1.5 }}>{detail}</div>{action && <div style={{ marginTop: 12 }}>{action}</div>}</div></div>; }
const sum = (counts: Record<string, number>) => Object.values(counts).reduce((total, value) => total + value, 0);
