import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiContextDocumentReference, type ApiDispatchIntelligence, type ApiDispatchPriorCase } from '../api';
import { DispatchIntelligencePanel, openIntelligenceDocument } from './DispatchIntelligence';

let root: Root | null = null;
let container: HTMLDivElement;
const tick = (ms = 0) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const observed = { value: null, completeness: 'unavailable' };
const priorCase = (index: number): ApiDispatchPriorCase => ({
  episodeId: `epi_${index}`, taskId: `old_task_${index}`, taskKey: `OLD-${index}`, runId: `run_${index}`, sitting: index,
  executionId: `exe_${index}`, orchestrationId: `orc_${index}`, repositoryKey: null, branch: null, baseId: null,
  capturedAt: null, validity: 'historical_episode', applicability: { validity: 'historical_episode', branch: 'unspecified', baseId: 'unspecified' },
  lineage: { status: 'partial', missing: ['stage'], reason: 'stage not reported' },
  retrieval: { version: 'similar-effort-v1', stage: 'graph', score: 1, support: [{ kind: 'shared-file', detail: 'src/cache.ts' }] },
  outcome: { run: index === 1 ? 'failed' : 'done', landing: 'pending' },
  observed: { filesTouched: { value: 1, completeness: 'complete' }, tokens: observed, costUSD: observed, elapsedMs: observed, reviewRounds: observed, verificationOrRepair: observed },
  whatWasAttempted: `case approach ${index}`, whatFailed: index === 1 ? ['cache stayed stale'] : [], whatRemainsUncertain: [],
});
const result = {
  advisory: true, version: 'dispatch-intelligence-v2', observedAt: '2026-08-10T00:00:00.000Z',
  targetContext: { taskId: 'task_1', runnerId: null, repositoryCheckoutId: null, repositoryKey: null, repositoryResolutionReason: 'runner checkout context was not supplied', branch: null, baseId: null },
  current: {
    kind: 'current_project_state', readiness: { taskId: 'task_1', taskKey: 'PI-1', primary: 'ready', reason: 'claimable now', claimability: { claimable: true }, anticipatedFiles: ['src/cache.ts'], currentRunIds: [], currentExecutionIds: [], lockCollisionIds: [] },
    capacity: { status: 'unanswerable', availableSlots: null, activeCapableRunners: 0, liveRunsCounted: 0, note: 'runner capacity unknown' },
    collisions: { locking: { status: 'unanswerable', enabled: false, current: [] }, anticipatedPaths: { status: 'observed', overlaps: [] }, graphImpact: { status: 'unanswerable', coverageReasons: ['code-graph-empty'], overlaps: [] } },
    planGates: { dispatches: [], phaseGates: [], owedLandings: [] }, humanBlocks: [], coverage: { status: 'partial', reasons: ['locking_disabled', 'runner_capacity_unknown'] },
  },
  documents: {
    kind: 'metadata_only_document_context', bodiesIncluded: false,
    linkedProjectDocuments: [{
      kind: 'project_doc', id: 'doc_linked', name: 'Settled architecture', description: 'Required design',
      updatedAt: '2026-08-10T00:00:00.000Z', relationship: 'task_link', provisional: false, plan: null,
      retrieval: { mode: 'explicit', score: null, indexFreshness: 'current' },
      readRef: { kind: 'project_doc', docId: 'doc_linked' },
    }],
    planLocalDocuments: [{
      kind: 'plan_doc', id: 'pdoc_1', name: 'Rollout notes', description: 'Working design',
      updatedAt: '2026-08-10T00:00:00.000Z', relationship: 'plan_membership', provisional: true,
      plan: { id: 'plan_1', title: 'Rollout', status: 'active', phaseId: 'phase_1', phaseTitle: 'Build', phaseOrder: 0 },
      retrieval: { mode: 'explicit', score: null, indexFreshness: 'current' },
      readRef: { kind: 'plan_doc', planId: 'plan_1', docId: 'pdoc_1' },
    }],
    semanticDocuments: [{
      kind: 'project_doc', id: 'doc_semantic', name: 'Related cache notes', description: 'Potential match',
      updatedAt: '2026-08-10T00:00:00.000Z', relationship: 'semantic', provisional: false, plan: null,
      retrieval: { mode: 'semantic', score: 0.82, indexFreshness: 'unverified' },
      readRef: { kind: 'project_doc', docId: 'doc_semantic' },
    }],
    coverage: { retrievalMode: 'semantic', empty: false, unavailable: false, truncated: false, notice: null },
  },
  constraints: { kind: 'current_project_authority', decisions: [], hazards: [], unknowns: [] },
  quotedEvidence: { kind: 'quoted_memory_evidence', failedApproaches: [], relevant: [], evidenceFrame: { text: '', itemsIncluded: 0, itemsOmitted: 0, truncated: false } },
  historical: { kind: 'historical_case_observation', retrievalMode: 'keyword', branchPolicy: 'prefer_not_filter', supportRule: 'two_independent_kinds', caseLimit: 20, consideredCount: 3, coverage: { complete: true, candidatesConsidered: 3, eligibleCases: 3, reasons: [] }, cases: [priorCase(1), priorCase(2), priorCase(3)] },
  observations: { kind: 'statistical_observation', scope: { status: 'observed', anticipatedFiles: ['src/cache.ts'], observation: '3 relevant prior cases touched one file each' }, budget: Object.fromEntries(['maxTokens', 'maxUsd', 'maxDurationSeconds', 'maxRounds'].map((key) => [key, { proposed: null, observedCount: 0, unavailableCount: 3, min: null, median: null, max: null, belowObservedCases: 0, completeness: 'unavailable', observation: `${key} was not proposed` }])), coverage: { status: 'partial', reasons: ['canonical_repository_not_supplied'] }, versions: { risk: 'scope-budget-risk-v1', retrieval: 'similar-effort-v1' } },
  comparison: { dimension: 'workflow', metric: 'run_success', state: 'insufficient_evidence', interpretation: 'cannot yet distinguish', rows: [], eligibility: { totalCases: 3, eligibleCases: 0, independentClusters: 0, reasons: ['fewer than two comparable strategy cohorts'], policy: {} }, caseAudit: { eligible: [], excluded: [] } },
  feedback: { endpoint: '/feedback', requiresExplicitHumanAction: true, previewCreatesOccurrence: false },
} as unknown as ApiDispatchIntelligence;

afterEach(() => { act(() => root?.unmount()); container?.remove(); root = null; sessionStorage.clear(); vi.restoreAllMocks(); });

describe('dispatch-time Intelligence panel (PLNR-303)', () => {
  it('renders three low-n cases, explicit unavailable locks, and does not write on preview', async () => {
    vi.spyOn(api, 'dispatchIntelligence').mockResolvedValue(result);
    const feedback = vi.spyOn(api, 'dispatchIntelligenceFeedback').mockResolvedValue({ feedbackId: 'sef_1', operationKey: 'op', occurrenceId: 'seo_1', deduped: false });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    act(() => root!.render(<DispatchIntelligencePanel expanded pid="prj_1" taskId="task_1" />));
    await tick(300); await tick();
    expect(container.querySelectorAll('.dispatch-intelligence-cases article')).toHaveLength(3);
    expect(container.textContent).toContain('Lock collision evidence unavailable');
    expect(container.textContent).toContain('cannot yet distinguish');
    expect(container.textContent).not.toContain('recommended');
    expect(feedback).not.toHaveBeenCalled();
  });

  it('records feedback only after an explicit judgment with the exact surfaced case identity', async () => {
    vi.spyOn(api, 'dispatchIntelligence').mockResolvedValue(result);
    const feedback = vi.spyOn(api, 'dispatchIntelligenceFeedback').mockResolvedValue({ feedbackId: 'sef_1', operationKey: 'op', occurrenceId: 'seo_1', deduped: false });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    act(() => root!.render(<DispatchIntelligencePanel expanded pid="prj_1" taskId="task_1" />));
    await tick(300); await tick();
    const relevant = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Relevant');
    await act(async () => { relevant!.click(); await Promise.resolve(); });
    expect(feedback).toHaveBeenCalledWith('prj_1', expect.objectContaining({
      taskId: 'task_1', episodeId: 'epi_1', runId: 'run_1', sitting: 1, judgment: 'relevant',
    }));
  });

  it('labels the three document categories and opens full readers only through the supplied action', async () => {
    vi.spyOn(api, 'dispatchIntelligence').mockResolvedValue(result);
    const open = vi.fn<(document: ApiContextDocumentReference) => void>();
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    act(() => root!.render(<DispatchIntelligencePanel expanded pid="prj_1" taskId="task_1" onOpenDocument={open} />));
    await tick(300); await tick();

    expect(container.textContent).toContain('Linked project docs');
    expect(container.textContent).toContain('settled / required');
    expect(container.textContent).toContain('Plan-local docs');
    expect(container.textContent).toContain('provisional · Rollout / Build');
    expect(container.textContent).toContain('Semantic docs');
    expect(container.textContent).toContain('semantic relevance 0.82');
    act(() => [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Rollout notes')!.click());
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      id: 'pdoc_1', readRef: { kind: 'plan_doc', planId: 'plan_1', docId: 'pdoc_1' },
    }));
    expect(container.textContent).not.toContain('Full settled content');
  });

  it('aborts a stale preview when the task target changes', async () => {
    const signals: AbortSignal[] = [];
    vi.spyOn(api, 'dispatchIntelligence').mockImplementation((_pid, _input, signal) => {
      signals.push(signal!);
      return new Promise<ApiDispatchIntelligence>(() => undefined);
    });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    act(() => root!.render(<DispatchIntelligencePanel expanded pid="prj_1" taskId="task_1" />));
    await tick(300);
    act(() => root!.render(<DispatchIntelligencePanel expanded pid="prj_1" taskId="task_2" />));
    expect(signals[0]?.aborted).toBe(true);
    await tick(300);
    expect(signals).toHaveLength(2);
  });

  it('routes project and plan references to the existing full-document readers', () => {
    const navigate = vi.fn();
    const close = vi.fn();
    openIntelligenceDocument(result.documents.linkedProjectDocuments[0]!, navigate, close);
    expect(close).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('noriq.openDoc')).toBe('doc_linked');
    expect(navigate).toHaveBeenCalledWith('docs');

    openIntelligenceDocument(result.documents.planLocalDocuments[0]!, navigate);
    expect(sessionStorage.getItem('noriq.openPlan')).toBe('plan_1');
    expect(sessionStorage.getItem('noriq.openPlanDoc')).toBe('pdoc_1');
    expect(navigate).toHaveBeenCalledWith('plans');
  });
});
