import { useEffect, useRef, useState } from 'react';
import {
  api, type ApiContextDocumentReference, type ApiDispatchIntelligence, type ApiDispatchMemoryExcerpt,
  type ApiDispatchPriorCase, type ApiPlanDispatchIntelligence,
} from '../api';
import { MonoTag } from './bits';
import { Button } from './ui';

/** Route a metadata-only reference to the existing full-body reader. */
export function openIntelligenceDocument(
  document: ApiContextDocumentReference,
  navigate: (view: 'docs' | 'plans') => void,
  beforeNavigate?: () => void,
) {
  beforeNavigate?.();
  if (document.readRef.kind === 'project_doc') {
    sessionStorage.setItem('noriq.openDoc', document.readRef.docId);
    navigate('docs');
    return;
  }
  sessionStorage.setItem('noriq.openPlan', document.readRef.planId);
  sessionStorage.setItem('noriq.openPlanDoc', document.readRef.docId);
  navigate('plans');
}

export function DispatchIntelligencePanel({
  pid, taskId, runnerId = null, repositoryCheckoutId = null, repositoryKey = null, branch = null, baseId = null,
  budget = null, expanded = false,
  includeComparison = false, onOpenDocument,
}: {
  pid: string; taskId: string; runnerId?: string | null; repositoryCheckoutId?: string | null;
  repositoryKey?: string | null;
  branch?: string | null; baseId?: string | null;
  budget?: { maxTokens?: number | null; maxUsd?: number | null; maxDurationSeconds?: number | null; maxRounds?: number | null } | null;
  expanded?: boolean;
  includeComparison?: boolean;
  onOpenDocument?: (document: ApiContextDocumentReference) => void;
}) {
  const [result, setResult] = useState<ApiDispatchIntelligence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const budgetKey = JSON.stringify(budget);
  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    setError(null);
    const timer = setTimeout(() => {
      setError(null);
      void api.dispatchIntelligence(pid, {
        taskId, runnerId, repositoryCheckoutId, repositoryKey, branch, baseId, budget,
        comparison: includeComparison ? { dimension: 'workflow', metric: 'run_success' } : undefined,
      }, controller.signal).then(setResult).catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [pid, taskId, runnerId, repositoryCheckoutId, repositoryKey, branch, baseId, budgetKey, includeComparison]); // eslint-disable-line react-hooks/exhaustive-deps

  const judge = async (item: ApiDispatchPriorCase, judgment: 'relevant' | 'partially_relevant' | 'not_similar') => {
    const key = `${item.episodeId}:${item.runId}:${item.sitting}`;
    setFeedback((state) => ({ ...state, [key]: 'saving' }));
    try {
      await api.dispatchIntelligenceFeedback(pid, {
        taskId, runnerId, repositoryCheckoutId, repositoryKey, branch, baseId,
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
        {result.documents && <Section title="Document context · metadata only">
          <DocumentGroup
            title="Linked project docs"
            description="Settled and required through an explicit task link."
            documents={result.documents.linkedProjectDocuments}
            tone="settled"
            onOpen={onOpenDocument}
          />
          <DocumentGroup
            title="Plan-local docs"
            description="Provisional working material inherited through actual plan membership."
            documents={result.documents.planLocalDocuments}
            tone="provisional"
            onOpen={onOpenDocument}
          />
          <DocumentGroup
            title="Semantic docs"
            description="Potentially relevant retrieval results; relevance is not authority."
            documents={result.documents.semanticDocuments}
            tone="relevance"
            onOpen={onOpenDocument}
          />
          {result.documents.coverage.unavailable && <Note tone="red">Document retrieval was unavailable; explicit links above remain authoritative.</Note>}
          {result.documents.coverage.truncated && <Note>More semantic document matches were omitted by the context budget.</Note>}
        </Section>}
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

export function PlanDispatchIntelligencePanel({
  pid, planId, runnerId = null, repositoryCheckoutId = null, repositoryKey = null,
  branch = null, baseId = null, expanded = true, onOpenDocument,
}: {
  pid: string; planId: string; runnerId?: string | null; repositoryCheckoutId?: string | null;
  repositoryKey?: string | null; branch?: string | null; baseId?: string | null; expanded?: boolean;
  onOpenDocument?: (document: ApiContextDocumentReference) => void;
}) {
  const [result, setResult] = useState<ApiPlanDispatchIntelligence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [taskDetails, setTaskDetails] = useState<Record<string, ApiDispatchIntelligence | Error>>({});
  const loadingTasks = useRef(new Set<string>());
  const detailControllers = useRef(new Map<string, AbortController>());

  useEffect(() => {
    const controller = new AbortController();
    for (const detail of detailControllers.current.values()) detail.abort();
    detailControllers.current.clear();
    loadingTasks.current.clear();
    setResult(null);
    setError(null);
    setExpandedTask(null);
    setTaskDetails({});
    const timer = setTimeout(() => {
      void api.planDispatchIntelligence(pid, {
        planId, runnerId, repositoryCheckoutId, repositoryKey, branch, baseId,
      }, controller.signal).then(setResult).catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
      for (const detail of detailControllers.current.values()) detail.abort();
    };
  }, [pid, planId, runnerId, repositoryCheckoutId, repositoryKey, branch, baseId]);

  const toggleTask = (taskId: string) => {
    const opening = expandedTask !== taskId;
    setExpandedTask(opening ? taskId : null);
    if (!opening || taskDetails[taskId] || loadingTasks.current.has(taskId)) return;
    const controller = new AbortController();
    detailControllers.current.set(taskId, controller);
    loadingTasks.current.add(taskId);
    void api.dispatchIntelligence(pid, {
      taskId, runnerId, repositoryCheckoutId, repositoryKey, branch, baseId,
    }, controller.signal).then((packet) => {
      if (!controller.signal.aborted) setTaskDetails((current) => ({ ...current, [taskId]: packet }));
    }).catch((cause) => {
      if (!controller.signal.aborted) setTaskDetails((current) => ({
        ...current, [taskId]: cause instanceof Error ? cause : new Error(String(cause)),
      }));
    }).finally(() => {
      if (detailControllers.current.get(taskId) !== controller) return;
      loadingTasks.current.delete(taskId);
      detailControllers.current.delete(taskId);
    });
  };

  return <details open={expanded} style={{ border: '1px solid var(--w-1)', borderRadius: 10, background: 'var(--w-025)', margin: '12px 0' }}>
    <summary style={{ cursor: 'pointer', padding: '11px 13px', fontWeight: 650, fontSize: 12 }}>
      Plan dispatch intelligence <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-dim)' }}>aggregate advisory · lazy task detail</span>
    </summary>
    <div style={{ padding: '0 13px 13px' }}>
      {!result && !error && <Note>Loading bounded plan facts and one aggregate retrieval…</Note>}
      {error && <Note tone="red">Unavailable: {error}. Dispatch controls remain unchanged.</Note>}
      {result && <>
        <Section title={`${result.plan.title} · ${result.plan.status}`}>
          <Note>{result.counts.tasks} tasks across {result.counts.phases} phases · {result.counts.dispatchable} dispatchable · {result.counts.retry} retries · {result.counts.settled} settled</Note>
          <Note>{result.counts.claimed} claimed · {result.counts.reserved} reserved · {result.blockers.totalTasks} blocked or awaiting approval</Note>
          {result.coverage.reasons.length > 0 && <ReasonList label="Partial aggregate coverage" reasons={result.coverage.reasons} />}
          {result.repository.reason && <Note>{result.repository.reason}</Note>}
        </Section>
        <Section title="Plan documents · metadata only">
          <DocumentGroup title="Plan-local docs" description="Provisional working material for this plan." documents={result.documents.planLocal} tone="provisional" onOpen={onOpenDocument} />
          <DocumentGroup title="Linked project docs" description="Settled docs linked by member tasks; task coverage is shown." documents={result.documents.linkedProject} tone="settled" onOpen={onOpenDocument} />
          <DocumentGroup title="Semantic docs" description="Potentially relevant to the whole plan; relevance is not authority." documents={result.documents.semantic} tone="relevance" onOpen={onOpenDocument} />
          <div style={small}>semantic retrieval: {result.documents.coverage.semantic.status} · {result.documents.coverage.semantic.mode ?? 'unavailable'} · {result.documents.coverage.semantic.emitted} shown</div>
        </Section>
        <Section title="Plan memory constraints and evidence">
          {!result.memory.constraints.length
            ? <Note>No active high-authority decision, hazard, requirement, or unknown was surfaced.</Note>
            : result.memory.constraints.map((item) => <blockquote key={item.id} style={{ margin: '6px 0', padding: '7px 9px', borderLeft: '2px solid var(--w-18)', background: 'var(--w-03)' }}>
              <div style={small}>{item.kind ?? 'memory'} · authority {item.authority ?? 'unknown'} · validity {item.validity ?? 'unknown'}{item.isLead ? ` · LEAD: ${item.leadReasons.join(', ')}` : ''}</div>
              <div style={{ fontSize: 10.5, marginTop: 3 }}>“{item.snippet}”</div>
            </blockquote>)}
          <div style={small}>Quoted evidence frame: {result.memory.evidenceFrame.itemsIncluded} included · {result.memory.evidenceFrame.itemsOmitted} omitted{result.memory.evidenceFrame.truncated ? ' · truncated' : ''} · retrieval {result.memory.coverage.mode ?? 'unavailable'}</div>
          {result.memory.coverage.unavailable && <Note tone="red">Project Memory was unavailable; current plan and document facts remain usable.</Note>}
        </Section>
        <Section title={`Member tasks · ${result.taskIndex.length} indexed`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {result.taskIndex.map((task) => {
              const detail = taskDetails[task.taskId];
              const open = expandedTask === task.taskId;
              return <div key={task.taskId} style={{ border: '1px solid var(--w-07)', borderRadius: 8, overflow: 'hidden' }}>
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => toggleTask(task.taskId)}
                  style={{ width: '100%', display: 'flex', gap: 7, alignItems: 'center', textAlign: 'left', cursor: 'pointer', padding: '7px 9px', border: 0, color: 'inherit', background: 'var(--w-015)' }}
                >
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9 }}>{open ? '▾' : '▸'}</span>
                  <b style={{ fontFamily: 'var(--mono)', fontSize: 9.5 }}>{task.taskKey}</b>
                  <span style={{ fontSize: 10.5 }}>{task.title}</span><span style={{ flex: 1 }} />
                  <span style={small}>{task.status} · {task.dispatchable ? 'dispatchable' : `${task.blockerCount} blockers`}</span>
                </button>
                {open && <div style={{ padding: '8px 10px', borderTop: '1px solid var(--w-06)' }}>
                  {!detail && <Note>Loading this task’s intelligence once…</Note>}
                  {detail instanceof Error && <Note tone="red">Task intelligence unavailable: {detail.message}. Dispatch controls remain unchanged.</Note>}
                  {detail && !(detail instanceof Error) && <>
                    <Note>{detail.current.readiness ? `${detail.current.readiness.primary} — ${detail.current.readiness.reason}` : 'Readiness unavailable.'}</Note>
                    {detail.documents && <>
                      <DocumentGroup title="Linked project docs" description="Settled and required." documents={detail.documents.linkedProjectDocuments} tone="settled" onOpen={onOpenDocument} />
                      <DocumentGroup title="Plan-local docs" description="Provisional through membership." documents={detail.documents.planLocalDocuments} tone="provisional" onOpen={onOpenDocument} />
                      <DocumentGroup title="Semantic docs" description="Potentially relevant." documents={detail.documents.semanticDocuments} tone="relevance" onOpen={onOpenDocument} />
                    </>}
                  </>}
                </div>}
              </div>;
            })}
          </div>
        </Section>
        <div style={small}>Version: {result.version}. No member task packet is loaded until its row is expanded.</div>
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

function DocumentGroup({ title, description, documents, tone, onOpen }: {
  title: string; description: string; documents: ApiContextDocumentReference[];
  tone: 'settled' | 'provisional' | 'relevance'; onOpen?: (document: ApiContextDocumentReference) => void;
}) {
  const color = tone === 'settled' ? 'var(--blue)' : tone === 'provisional' ? 'var(--amber)' : 'var(--purple)';
  return <div style={{ margin: '7px 0', padding: '8px 9px', borderLeft: `3px solid ${color}`, background: 'var(--w-02)', borderRadius: 7 }}>
    <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
      <b style={{ fontSize: 10.5 }}>{title}</b><span style={small}>{documents.length}</span>
    </div>
    <div style={small}>{description}</div>
    {documents.map((document) => <div key={`${document.kind}:${document.id}`} style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 6 }}>
      <button
        type="button"
        onClick={() => onOpen?.(document)}
        disabled={!onOpen}
        style={{ cursor: onOpen ? 'pointer' : 'default', padding: 0, border: 0, background: 'transparent', color: 'var(--text)', fontSize: 10.5, fontWeight: 600, textAlign: 'left' }}
      >{document.name}</button>
      <span style={{ ...small, flex: 1 }}>
        {document.description || 'No description'} · {tone === 'settled' ? 'settled / required' : tone === 'provisional'
          ? `provisional${document.plan ? ` · ${document.plan.title}${document.plan.phaseTitle ? ` / ${document.plan.phaseTitle}` : ''}` : ''}`
          : `${document.retrieval.mode} relevance${document.retrieval.score == null ? '' : ` ${document.retrieval.score.toFixed(2)}`}`}
        {'totalTaskLinks' in document && typeof document.totalTaskLinks === 'number'
          ? ` · linked by ${document.totalTaskLinks} task(s)${'exampleTaskKeys' in document && Array.isArray(document.exampleTaskKeys) && document.exampleTaskKeys.length ? ` · ${document.exampleTaskKeys.join(', ')}` : ''}`
          : ''}
      </span>
    </div>)}
    {!documents.length && <div style={{ ...small, marginTop: 4 }}>None surfaced.</div>}
  </div>;
}
