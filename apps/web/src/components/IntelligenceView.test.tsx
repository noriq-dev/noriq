import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiProjectIntelligence } from '../api';
import type { AppStore } from '../store';
import { IntelligenceView } from './IntelligenceView';

let root: Root | null = null;
let container: HTMLDivElement;
const originalMatchMedia = window.matchMedia;
const mockPhoneViewport = () => {
  window.matchMedia = vi.fn((query: string) => ({
    matches: query.includes('767px') || query.includes('1023px'), media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
};
const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const metric = (median: number | null, denominator = median == null ? 0 : 1) => ({
  observedCount: denominator, partialCount: 0, unavailableCount: denominator ? 0 : 1, denominator,
  min: median, p25: median, median, p75: median, iqr: median == null ? null : 0, p90: median, max: median, total: median,
});

const packet: ApiProjectIntelligence = {
  live: {
    observedAt: '2026-08-10T05:00:00.000Z', source: 'd1_current_state',
    readiness: { totalTasks: 4, readyTasks: 2, blockedTasks: 1, inProgressTasks: 1, reviewTasks: 0 },
    plans: { statuses: { active: 1 }, dispatchStatuses: {}, phaseGateStatuses: { pending: 1 }, phasesWithoutGate: 0, landings: { recorded: 1, owed: 0, succeeded: 1, failed: 0 } },
    execution: { runStatuses: { done: 1 }, orchestrationStatuses: { succeeded: 1 }, nodeStatuses: {}, activeNodes: 1, parkedNodes: 0 },
    coordination: { activeClaims: 1, activeLocks: 2 },
    runners: { statuses: { online: 1 }, presenceStates: { active: 1 }, capacity: { reportedRunners: 1, maxConcurrency: 2, freeSlots: 1, busySlots: 1, completeness: 'complete' } },
  },
  analytics: {
    health: { state: 'complete', staleSources: [], active: { id: 'ang_1', completedAt: '2026-08-10T04:00:00.000Z' }, latestFailure: null },
    freshness: { state: 'current', liveObservedAt: '2026-08-10T05:00:00.000Z', generationCompletedAt: '2026-08-10T04:00:00.000Z', gapMs: 3_600_000, label: 'analytics current with known sources' },
    historical: { state: 'available', result: {
      observedAt: '2026-08-10T05:00:00.000Z', generation: { id: 'ang_1', completedAt: '2026-08-10T04:00:00.000Z', completeness: {} },
      filter: { from: '2026-07-10T00:00:00.000Z', to: '2026-08-10T00:00:00.000Z', scope: 'runner_job_tasks', groupBy: 'executed_workflow', filters: [] },
      coverage: { complete: true, scannedRows: 1, matchedSittings: 1, reasons: [], qualityEventsScanned: 0, unassociatedQualityEvents: 0 },
      groups: [{
        dimension: 'executed_workflow', value: 'build', provenance: { source: 'derived_generation', generationId: 'ang_1', generationCompletedAt: '2026-08-10T04:00:00.000Z' },
        sample: { sittings: 1, runs: 1 }, throughput: { sittings: 1, runs: 1, firstObservedAt: null, lastObservedAt: null },
        metrics: { elapsedExecutionMs: metric(60_000), parkedMs: metric(0), verifyDurationMs: metric(null), tokens: metric(1200), costUSD: metric(null) },
        outcomes: { done: { numerator: 1, denominator: 1, rate: 1 }, failed: { numerator: 0, denominator: 1, rate: 0 }, cancelled: { numerator: 0, denominator: 1, rate: 0 }, landed: { numerator: 1, denominator: 1, rate: 1 }, laterInstability: { status: 'unavailable', count: null, eventCount: 0, denominator: 0, rate: null, horizonDays: 30, observedThrough: '2026-08-10T04:00:00.000Z', eventTypeCounts: {}, reason: 'horizon incomplete' } },
        composition: { stages: [], roles: [], reviewRepairTokenShare: { value: null, denominator: 0, share: null, completeness: 'unavailable' } },
        completeness: { lineageComplete: 1, lineagePartial: 0, lineageUnknown: 0, metricDenominators: { costUSD: 0 } }, supportingCaseCount: 1,
        supportingCases: [{ episodeId: 'epi_1', runId: 'run_1', sitting: 1, taskId: 'task_1', planId: 'plan_1', planDispatchId: null, orchestrationId: 'orc_1', executionId: 'exe_1' }],
      }], cases: { items: [{ episodeId: 'epi_1', runId: 'run_1', sitting: 1, taskId: 'task_1', planId: 'plan_1', planDispatchId: null, orchestrationId: 'orc_1', executionId: 'exe_1' }], nextCursor: null, total: 1 },
    } },
  },
  comparison: { dimension: 'workflow', metric: 'run_success', state: 'insufficient_evidence', interpretation: 'insufficient evidence', rows: [], eligibility: { totalCases: 1, eligibleCases: 0, independentClusters: 0, reasons: ['fewer than two comparable strategy cohorts'], policy: {} }, caseAudit: { eligible: [], excluded: [{ caseId: 'run_1/1', episodeId: 'epi_1', reasons: ['no comparison cohort'] }] } },
  bounds: { from: '2026-07-10T00:00:00.000Z', to: '2026-08-10T00:00:00.000Z', caseLimit: 24, groupBy: 'executed_workflow' },
};

beforeEach(() => {
  vi.spyOn(api, 'runnerJobIntelligenceHistory').mockResolvedValue({
    from: '2026-07-10T00:00:00.000Z', to: '2026-08-10T00:00:00.000Z',
    jobs: [], tasks: [], truncated: false,
  });
});

afterEach(() => { act(() => root?.unmount()); container?.remove(); root = null; window.matchMedia = originalMatchMedia; vi.restoreAllMocks(); history.replaceState(null, '', '/'); });

describe('Project Intelligence surface (PLNR-302)', () => {
  it('keeps the phone first paint compact and defers comparisons and cases', async () => {
    mockPhoneViewport();
    vi.spyOn(api, 'projectIntelligence').mockResolvedValue(packet);
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    act(() => root!.render(<IntelligenceView store={{ currentPid: 'prj_1' } as AppStore} />));
    await tick();

    expect(container.querySelectorAll('.intelligence-grid > article')).toHaveLength(6);
    expect(container.textContent).not.toContain('insufficient evidence');
    expect(container.textContent).not.toContain('Canonical case drill-down');
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Analytics range"]')?.style.fontSize).toBe('9.5px');

    const compare = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Compare')!;
    act(() => compare.click());
    expect(container.textContent).toContain('insufficient evidence');
    const cases = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Cases')!;
    act(() => cases.click());
    expect(container.textContent).toContain('Canonical case drill-down');
  });

  it('renders server-authored completeness and refuses to turn missing spend into zero', async () => {
    vi.spyOn(api, 'projectIntelligence').mockResolvedValue(packet);
    history.replaceState(null, '', '/p/prj_1/intelligence');
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    act(() => root!.render(<IntelligenceView store={{ currentPid: 'prj_1' } as AppStore} />));
    await tick();
    expect(container.textContent).toContain('Costunavailable');
    expect(container.textContent).toContain('insufficient evidence');
    expect(container.textContent).toContain('fewer than two comparable strategy cohorts');
    expect(api.projectIntelligence).toHaveBeenCalledWith('prj_1', expect.objectContaining({
      caseLimit: 24, groupBy: 'executed_workflow', scope: 'runner_job_tasks',
      comparison: { dimension: 'workflow', metric: 'run_success' },
    }));
  });

  it('hands a canonical case to the existing execution view instead of drawing another graph', async () => {
    vi.spyOn(api, 'projectIntelligence').mockResolvedValue(packet);
    history.replaceState(null, '', '/p/prj_1/intelligence');
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    act(() => root!.render(<IntelligenceView store={{ currentPid: 'prj_1' } as AppStore} />));
    await tick();
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent === 'Execution');
    act(() => button!.click());
    expect(location.pathname).toBe('/p/prj_1/executions');
    expect(location.search).toContain('orchestration=orc_1');
    expect(location.search).toContain('execution=exe_1');
  });
});
