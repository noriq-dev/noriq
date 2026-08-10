import { describe, expect, it } from 'vitest';
import {
  compareStrategies, type ComparisonCase, type ComparisonMetric, type StrategyDimension,
} from '../src/memory/strategy-comparison';

const metrics = (overrides: Partial<Record<ComparisonMetric, number | null>> = {}): ComparisonCase['outcomes'] => ({
  run_success: { value: overrides.run_success ?? 1, completeness: 'complete' },
  landing: { value: overrides.landing ?? 1, completeness: 'complete' },
  elapsed_ms: { value: overrides.elapsed_ms ?? 100, completeness: 'complete' },
  files_changed: { value: overrides.files_changed ?? 2, completeness: 'complete' },
  churn: { value: overrides.churn ?? 20, completeness: 'complete' },
  review_rounds: { value: overrides.review_rounds ?? 1, completeness: 'complete' },
  later_quality_event: { value: overrides.later_quality_event ?? 0, completeness: 'complete' },
});

function comparisonCase(input: {
  id: string; strategy: string; run?: string; task?: string; planDispatch?: string | null;
  orchestration?: string | null; value?: number | null; metric?: ComparisonMetric;
  lineage?: 'complete' | 'partial'; taskClass?: string;
}): ComparisonCase {
  const run = input.run ?? `run_${input.id}`;
  const task = input.task ?? `task_${input.id}`;
  const metric = input.metric ?? 'elapsed_ms';
  return {
    caseId: `case_${input.id}`, episodeId: `epi_${input.id}`, runId: run, sitting: 1, taskId: task,
    preExecution: {
      taskClass: input.taskClass ?? 'feature|repo-a|analytics', capturedAt: '2026-08-01T00:00:00.000Z',
      modelVendorEffort: input.strategy, workflow: input.strategy,
      reviewerVerifier: input.strategy, context: input.strategy,
      concurrency: input.strategy, configuration: input.strategy,
      clusters: {
        run, task, planDispatch: input.planDispatch ?? null,
        orchestration: input.orchestration ?? null, configurationPeriod: '2026-08:cfg-a',
      },
    },
    lineage: input.lineage === 'partial'
      ? { status: 'partial', missing: ['legacy'], reason: 'legacy episode' }
      : { status: 'complete', missing: [], reason: null },
    outcomes: metrics({ [metric]: input.value === undefined ? 100 : input.value }),
  };
}

const compare = (cases: ComparisonCase[], dimension: StrategyDimension = 'workflow', metric: ComparisonMetric = 'elapsed_ms') =>
  compareStrategies({ generationKey: 'generation-fixed', dimension, metric, cases });

describe('evidence-gated strategy comparison (PLNR-301)', () => {
  it('does not let repeated sittings or execution stages fake the independent-cluster floor', () => {
    const cases = Array.from({ length: 12 }, (_, index) => comparisonCase({
      id: String(index), strategy: index < 6 ? 'workflow-a' : 'workflow-b',
      run: 'run_one', task: 'task_one', value: index,
    }));
    const result = compare(cases);
    expect(result.state).toBe('insufficient_evidence');
    expect(result.rows).toEqual([]);
    expect(result.eligibility.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('independent clusters below minimum'),
    ]));
    expect(result.caseAudit.eligible).toHaveLength(12);
  });

  it('returns cannot yet distinguish for overlapping intervals, not equal/equivalent copy', () => {
    const a = [1, 1, 1, 0, 0].map((value, index) => comparisonCase({
      id: `a${index}`, strategy: 'workflow-a', value, metric: 'run_success',
    }));
    const b = [1, 1, 0, 0, 0].map((value, index) => comparisonCase({
      id: `b${index}`, strategy: 'workflow-b', value, metric: 'run_success',
    }));
    const result = compare([...a, ...b], 'workflow', 'run_success');
    expect(result.state).toBe('cannot_yet_distinguish');
    expect(result.interpretation).toBe('cannot yet distinguish');
    expect(result.rows).toHaveLength(2);
    expect(JSON.stringify(result)).not.toMatch(/winner|recommended|equivalent|no difference/i);
    expect(result.rows.every((row) => row.observations === 5 && row.independentClusters === 5)).toBe(true);
  });

  it('is deterministic and drills every aggregate to eligible cases and cluster counts', () => {
    const cases = [
      ...[9, 10, 11, 9, 10, 11].map((value, index) => comparisonCase({ id: `a${index}`, strategy: 'workflow-a', value })),
      ...[90, 100, 110, 90, 100, 110].map((value, index) => comparisonCase({ id: `b${index}`, strategy: 'workflow-b', value })),
    ];
    const first = compare(cases);
    const second = compare(cases);
    expect(second).toEqual(first);
    expect(first.state).toBe('distinguishable');
    expect(first.rows.map((row) => row.strategy)).toEqual(['workflow-a', 'workflow-b']);
    expect(first.rows.every((row) => row.supportingCaseIds.length === 6)).toBe(true);
    expect(first.rows.every((row) => row.clusterAxes.runs === 6)).toBe(true);
  });

  it('keeps legacy cases inspectable but excludes them from role-attribution gates', () => {
    const cases = [
      ...Array.from({ length: 5 }, (_, index) => comparisonCase({
        id: `a${index}`, strategy: 'reviewer-a', lineage: index === 0 ? 'partial' : 'complete',
      })),
      ...Array.from({ length: 5 }, (_, index) => comparisonCase({
        id: `b${index}`, strategy: 'reviewer-b', lineage: 'complete',
      })),
    ];
    const result = compare(cases, 'reviewer_verifier');
    expect(result.state).toBe('insufficient_evidence');
    expect(result.rows).toEqual([]);
    expect(result.caseAudit.excluded).toContainEqual(expect.objectContaining({
      caseId: 'case_a0', reasons: ['complete role/stage lineage required for reviewer/verifier comparison'],
    }));
  });

  it('uses only shared pre-execution comparability classes and reports exclusions', () => {
    const cases = [
      ...Array.from({ length: 5 }, (_, index) => comparisonCase({ id: `a${index}`, strategy: 'workflow-a' })),
      ...Array.from({ length: 5 }, (_, index) => comparisonCase({
        id: `b${index}`, strategy: 'workflow-b', taskClass: 'bug|repo-z|unrelated',
      })),
    ];
    const result = compare(cases);
    expect(result.rows).toEqual([]);
    expect(result.caseAudit.excluded).toHaveLength(10);
    expect(result.caseAudit.excluded[0]!.reasons[0]).toContain('pre-execution comparability class');
  });
});
