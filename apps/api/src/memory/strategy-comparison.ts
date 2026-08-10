// PLNR-301: correlation-aware comparison over immutable pre-execution cohorts. The input type
// structurally separates cohort coordinates from realized outcomes, so no API caller can use an
// outcome as a strategy key. Results never contain a winner or recommendation field.
import { EffortEpisode, type ProjectIntelligenceEpisode } from '@noriq-dev/shared';
import type { Env } from '../env';
import type { ProjectMemoryStub } from '../lib/project-memory';
import type { ShadowDispatchSnapshot } from './shadow-dispatch';

export const STRATEGY_COMPARISON_VERSION = 'strategy-comparison-v1';
export const STRATEGY_DIMENSIONS = [
  'model_vendor_effort', 'workflow', 'reviewer_verifier', 'context', 'concurrency', 'configuration',
] as const;
export type StrategyDimension = typeof STRATEGY_DIMENSIONS[number];
export const COMPARISON_METRICS = [
  'run_success', 'landing', 'elapsed_ms', 'files_changed', 'churn', 'review_rounds', 'later_quality_event',
] as const;
export type ComparisonMetric = typeof COMPARISON_METRICS[number];
export type ComparisonState = 'insufficient_evidence' | 'cannot_yet_distinguish' | 'directional_signal' | 'distinguishable';

export interface ComparisonCase {
  caseId: string;
  episodeId: string;
  runId: string;
  sitting: number;
  taskId: string | null;
  preExecution: {
    taskClass: string;
    capturedAt: string;
    modelVendorEffort: string | null;
    workflow: string | null;
    reviewerVerifier: string | null;
    context: string | null;
    concurrency: string | null;
    configuration: string | null;
    clusters: {
      run: string; task: string | null; planDispatch: string | null;
      orchestration: string | null; configurationPeriod: string;
    };
  };
  lineage: ProjectIntelligenceEpisode['identity']['lineage'];
  outcomes: Record<ComparisonMetric, { value: number | null; completeness: string }>;
}

export interface ComparisonPolicy {
  minimumCases: number;
  minimumIndependentClusters: number;
  minimumMetricCompleteness: number;
  bootstrapIterations: number;
  confidence: number;
}

const DEFAULT_POLICY: ComparisonPolicy = {
  minimumCases: 5,
  minimumIndependentClusters: 3,
  minimumMetricCompleteness: 0.8,
  bootstrapIterations: 1_000,
  confidence: 0.95,
};

export interface ComparisonRow {
  strategy: string;
  observations: number;
  independentClusters: number;
  metricCompleteness: { eligible: number; total: number; rate: number };
  distribution: { median: number; q1: number; q3: number; iqr: number; min: number; max: number };
  interval: { low: number; high: number; confidence: number; method: 'seeded_cluster_bootstrap_median' };
  supportingCaseIds: string[];
  clusterAxes: {
    runs: number; tasks: number; planDispatches: number; orchestrations: number; configurationPeriods: number;
  };
}

export interface StrategyComparisonResult {
  version: typeof STRATEGY_COMPARISON_VERSION;
  generationKey: string;
  dimension: StrategyDimension;
  metric: ComparisonMetric;
  state: ComparisonState;
  rows: ComparisonRow[];
  eligibility: {
    policy: ComparisonPolicy;
    totalCases: number;
    eligibleCases: number;
    independentClusters: number;
    reasons: string[];
  };
  caseAudit: {
    eligible: Array<{ caseId: string; episodeId: string; strategy: string; clusterId: string }>;
    excluded: Array<{ caseId: string; episodeId: string; reasons: string[] }>;
  };
  interpretation: 'insufficient evidence' | 'cannot yet distinguish' | 'directional signal' | 'distinguishable';
}

function strategyFor(item: ComparisonCase, dimension: StrategyDimension): string | null {
  switch (dimension) {
    case 'model_vendor_effort': return item.preExecution.modelVendorEffort;
    case 'workflow': return item.preExecution.workflow;
    case 'reviewer_verifier': return item.preExecution.reviewerVerifier;
    case 'context': return item.preExecution.context;
    case 'concurrency': return item.preExecution.concurrency;
    case 'configuration': return item.preExecution.configuration;
  }
}

/** The primary sampling unit is deliberately conservative: tasks in one plan dispatch or
 * orchestration cluster together; otherwise repeated sittings of one task/run cluster together. */
function primaryCluster(item: ComparisonCase): string {
  return item.preExecution.clusters.planDispatch
    ? `plan-dispatch:${item.preExecution.clusters.planDispatch}`
    : item.preExecution.clusters.orchestration
      ? `orchestration:${item.preExecution.clusters.orchestration}`
      : item.preExecution.clusters.task
        ? `task:${item.preExecution.clusters.task}`
        : `run:${item.preExecution.clusters.run}`;
}

function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return Number.NaN;
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower]! + ((sorted[lower + 1] ?? sorted[lower]!) - sorted[lower]!) * fraction;
}

function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0 || 1;
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function clusteredInterval(
  values: Array<{ cluster: string; value: number }>,
  seedText: string,
  iterations: number,
  confidence: number,
): { low: number; high: number } {
  const clusterMap = new Map<string, number[]>();
  for (const item of values) clusterMap.set(item.cluster, [...(clusterMap.get(item.cluster) ?? []), item.value]);
  const clusters = [...clusterMap.keys()].sort();
  const rng = random(hashSeed(seedText));
  const estimates: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const sample: number[] = [];
    for (let j = 0; j < clusters.length; j++) {
      const selected = clusters[Math.floor(rng() * clusters.length)]!;
      sample.push(...clusterMap.get(selected)!);
    }
    estimates.push(quantile(sample.sort((a, b) => a - b), 0.5));
  }
  estimates.sort((a, b) => a - b);
  const tail = (1 - confidence) / 2;
  return { low: quantile(estimates, tail), high: quantile(estimates, 1 - tail) };
}

const interpretation = (state: ComparisonState): StrategyComparisonResult['interpretation'] => ({
  insufficient_evidence: 'insufficient evidence',
  cannot_yet_distinguish: 'cannot yet distinguish',
  directional_signal: 'directional signal',
  distinguishable: 'distinguishable',
})[state] as StrategyComparisonResult['interpretation'];

/** Pure comparison engine. Eligibility is evaluated before rows are constructed; if any
 * observed strategy fails a floor, rows stays structurally empty so the UI cannot rank it. */
export function compareStrategies(input: {
  generationKey: string;
  dimension: StrategyDimension;
  metric: ComparisonMetric;
  cases: ComparisonCase[];
  policy?: Partial<ComparisonPolicy>;
}): StrategyComparisonResult {
  const policy: ComparisonPolicy = {
    minimumCases: Math.max(2, Math.trunc(input.policy?.minimumCases ?? DEFAULT_POLICY.minimumCases)),
    minimumIndependentClusters: Math.max(2, Math.trunc(input.policy?.minimumIndependentClusters ?? DEFAULT_POLICY.minimumIndependentClusters)),
    minimumMetricCompleteness: Math.min(1, Math.max(0, input.policy?.minimumMetricCompleteness ?? DEFAULT_POLICY.minimumMetricCompleteness)),
    bootstrapIterations: Math.min(5_000, Math.max(200, Math.trunc(input.policy?.bootstrapIterations ?? DEFAULT_POLICY.bootstrapIterations))),
    confidence: Math.min(0.99, Math.max(0.8, input.policy?.confidence ?? DEFAULT_POLICY.confidence)),
  };
  const audit: StrategyComparisonResult['caseAudit'] = { eligible: [], excluded: [] };
  const candidates: Array<{ item: ComparisonCase; strategy: string; cluster: string; value: number }> = [];
  for (const item of input.cases) {
    const reasons: string[] = [];
    const strategy = strategyFor(item, input.dimension);
    if (!strategy) reasons.push(`pre-execution ${input.dimension} coordinate unavailable`);
    const metric = item.outcomes[input.metric];
    if (metric.value == null || !['complete', 'partial'].includes(metric.completeness)) reasons.push(`${input.metric} outcome unavailable`);
    if (input.dimension === 'reviewer_verifier' && item.lineage.status !== 'complete') {
      reasons.push('complete role/stage lineage required for reviewer/verifier comparison');
    }
    if (!item.preExecution.taskClass) reasons.push('pre-execution comparability class unavailable');
    if (reasons.length) {
      audit.excluded.push({ caseId: item.caseId, episodeId: item.episodeId, reasons });
    } else {
      candidates.push({ item, strategy: strategy!, cluster: primaryCluster(item), value: metric.value! });
    }
  }

  // Only task classes represented in two or more strategy cohorts are comparable. Realized
  // outcomes never participate in this key.
  const strategiesByClass = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const set = strategiesByClass.get(candidate.item.preExecution.taskClass) ?? new Set<string>();
    set.add(candidate.strategy); strategiesByClass.set(candidate.item.preExecution.taskClass, set);
  }
  const comparableClasses = new Set([...strategiesByClass].filter(([, strategies]) => strategies.size >= 2).map(([key]) => key));
  const eligible = candidates.filter((candidate) => {
    if (comparableClasses.has(candidate.item.preExecution.taskClass)) return true;
    audit.excluded.push({
      caseId: candidate.item.caseId, episodeId: candidate.item.episodeId,
      reasons: ['no other strategy is represented in this pre-execution comparability class'],
    });
    return false;
  });
  for (const candidate of eligible) audit.eligible.push({
    caseId: candidate.item.caseId, episodeId: candidate.item.episodeId,
    strategy: candidate.strategy, clusterId: candidate.cluster,
  });

  const grouped = new Map<string, typeof eligible>();
  for (const candidate of eligible) grouped.set(candidate.strategy, [...(grouped.get(candidate.strategy) ?? []), candidate]);
  const totalByStrategy = new Map<string, number>();
  for (const item of input.cases) {
    const strategy = strategyFor(item, input.dimension);
    if (strategy) totalByStrategy.set(strategy, (totalByStrategy.get(strategy) ?? 0) + 1);
  }
  const reasons: string[] = [];
  if (grouped.size < 2) reasons.push('fewer than two comparable strategy cohorts');
  for (const [strategy, items] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    const clusters = new Set(items.map((item) => item.cluster)).size;
    const total = totalByStrategy.get(strategy) ?? items.length;
    const completeness = items.length / total;
    if (items.length < policy.minimumCases) reasons.push(`${strategy}: ${items.length} eligible cases below minimum ${policy.minimumCases}`);
    if (clusters < policy.minimumIndependentClusters) reasons.push(`${strategy}: ${clusters} independent clusters below minimum ${policy.minimumIndependentClusters}`);
    if (completeness < policy.minimumMetricCompleteness) reasons.push(`${strategy}: metric completeness ${completeness.toFixed(3)} below minimum ${policy.minimumMetricCompleteness}`);
  }
  const independentClusters = new Set(eligible.map((item) => item.cluster)).size;
  if (reasons.length) return {
    version: STRATEGY_COMPARISON_VERSION, generationKey: input.generationKey,
    dimension: input.dimension, metric: input.metric, state: 'insufficient_evidence', rows: [],
    eligibility: {
      policy, totalCases: input.cases.length, eligibleCases: eligible.length, independentClusters,
      reasons: [...new Set(reasons)],
    },
    caseAudit: audit, interpretation: 'insufficient evidence',
  };

  const rows: ComparisonRow[] = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([strategy, items]) => {
    const sorted = items.map((item) => item.value).sort((a, b) => a - b);
    const q1 = quantile(sorted, 0.25); const median = quantile(sorted, 0.5); const q3 = quantile(sorted, 0.75);
    const interval = clusteredInterval(
      items.map((item) => ({ cluster: item.cluster, value: item.value })),
      `${input.generationKey}|${input.dimension}|${input.metric}|${strategy}`,
      policy.bootstrapIterations, policy.confidence,
    );
    const total = totalByStrategy.get(strategy) ?? items.length;
    return {
      strategy, observations: items.length, independentClusters: new Set(items.map((item) => item.cluster)).size,
      metricCompleteness: { eligible: items.length, total, rate: items.length / total },
      distribution: { median, q1, q3, iqr: q3 - q1, min: sorted[0]!, max: sorted.at(-1)! },
      interval: { ...interval, confidence: policy.confidence, method: 'seeded_cluster_bootstrap_median' },
      supportingCaseIds: items.map((item) => item.item.caseId).sort(),
      clusterAxes: {
        runs: new Set(items.map((item) => item.item.preExecution.clusters.run)).size,
        tasks: new Set(items.map((item) => item.item.preExecution.clusters.task).filter(Boolean)).size,
        planDispatches: new Set(items.map((item) => item.item.preExecution.clusters.planDispatch).filter(Boolean)).size,
        orchestrations: new Set(items.map((item) => item.item.preExecution.clusters.orchestration).filter(Boolean)).size,
        configurationPeriods: new Set(items.map((item) => item.item.preExecution.clusters.configurationPeriod)).size,
      },
    };
  });
  const overlaps = rows.some((row, index) => rows.slice(index + 1).some((other) => (
    row.interval.low <= other.interval.high && other.interval.low <= row.interval.high
  )));
  const strongClusterFloor = Math.max(5, policy.minimumIndependentClusters * 2);
  const state: ComparisonState = overlaps ? 'cannot_yet_distinguish'
    : rows.every((row) => row.independentClusters >= strongClusterFloor) ? 'distinguishable' : 'directional_signal';
  return {
    version: STRATEGY_COMPARISON_VERSION, generationKey: input.generationKey,
    dimension: input.dimension, metric: input.metric, state, rows,
    eligibility: {
      policy, totalCases: input.cases.length, eligibleCases: eligible.length,
      independentClusters, reasons: [],
    },
    caseAudit: audit, interpretation: interpretation(state),
  };
}

type ComparisonEpisodeRow = { episodeId: string; runId: string; sitting: number; body: string };

function observation(value: unknown, completeness: unknown): { value: number | null; completeness: string } {
  return { value: typeof value === 'number' && Number.isFinite(value) ? value : null, completeness: String(completeness ?? 'unavailable') };
}

/** Cross-store adapter: D1 supplies frozen cohort coordinates, ProjectMemory supplies terminal
 * episode outcomes. Both scans are bounded; stages are never rows in this join. */
export async function queryStrategyComparison(env: Env, projectId: string, input: {
  dimension: StrategyDimension; metric: ComparisonMetric; from?: string; to?: string;
  limit?: number; policy?: Partial<ComparisonPolicy>;
}): Promise<StrategyComparisonResult & { coverage: { complete: boolean; reasons: string[]; snapshotsScanned: number } }> {
  const limit = Math.min(2_000, Math.max(1, Math.trunc(input.limit ?? 1_000)));
  const clauses = ['project_id = ?']; const binds: Array<string | number> = [projectId];
  if (input.from) { clauses.push('captured_at >= ?'); binds.push(input.from); }
  if (input.to) { clauses.push('captured_at < ?'); binds.push(input.to); }
  const snapshotRows = await env.DB.prepare(
    `SELECT run_id AS runId, sitting, snapshot, snapshot_hash AS snapshotHash, captured_at AS capturedAt
       FROM run_sitting_shadow_snapshots WHERE ${clauses.join(' AND ')} AND capture_status != 'failed'
       ORDER BY captured_at, run_id, sitting LIMIT ${limit + 1}`,
  ).bind(...binds).all<{ runId: string; sitting: number; snapshot: string; snapshotHash: string; capturedAt: string }>();
  const truncated = snapshotRows.results.length > limit;
  const snapshots = snapshotRows.results.slice(0, limit);
  const stub = env.PROJECT_MEMORY.get(env.PROJECT_MEMORY.idFromName(projectId)) as unknown as ProjectMemoryStub;
  const episodeResult = await stub.comparisonEpisodes(projectId, {
    cases: snapshots.map((row) => ({ runId: row.runId, sitting: row.sitting })), limit,
  });
  const episodes = new Map(episodeResult.episodes.map((row: ComparisonEpisodeRow) => [`${row.runId}:${row.sitting}`, row]));
  const quality = await env.DB.prepare(
    `SELECT run_id AS runId, sitting FROM project_quality_events
      WHERE project_id = ? AND run_id IS NOT NULL AND sitting IS NOT NULL`,
  ).bind(projectId).all<{ runId: string; sitting: number }>();
  const qualityKeys = new Set(quality.results.map((row) => `${row.runId}:${row.sitting}`));
  const cases: ComparisonCase[] = [];
  for (const row of snapshots) {
    const episodeRow = episodes.get(`${row.runId}:${row.sitting}`);
    if (!episodeRow) continue;
    const parsed = EffortEpisode.safeParse(JSON.parse(episodeRow.body));
    if (!parsed.success || !parsed.data.intelligence) continue;
    const episode = parsed.data.intelligence;
    const snapshot = JSON.parse(row.snapshot) as ShadowDispatchSnapshot;
    const configuration = snapshot.features.chosenStrategy.commissionedConfiguration ?? [];
    const configKey = configuration.map((item) => `${item.kind}:${item.fingerprint}`).sort().join('|') || null;
    const reviewerVerifier = configuration.filter((item) => item.kind === 'reviewer' || item.kind === 'verifier')
      .map((item) => `${item.kind}:${item.name ?? item.fingerprint}`).sort().join('|') || null;
    const context = configuration.filter((item) => item.kind === 'context')
      .map((item) => item.fingerprint).sort().join('|') || null;
    const changed = episode.execution.changes;
    cases.push({
      caseId: `${episode.identity.episodeId}:${row.snapshotHash}`,
      episodeId: episode.identity.episodeId, runId: row.runId, sitting: row.sitting,
      taskId: snapshot.identity.taskId,
      preExecution: {
        taskClass: [
          snapshot.features.taskShape.taskType ?? 'unknown', snapshot.identity.repositoryKey ?? 'unknown',
          [...snapshot.features.taskShape.tags].sort().join(','),
        ].join('|'),
        capturedAt: snapshot.source.capturedAt,
        modelVendorEffort: [
          snapshot.features.chosenStrategy.commissioned.tool,
          snapshot.features.chosenStrategy.commissioned.model,
          snapshot.features.chosenStrategy.commissioned.effort,
        ].map((value) => value ?? 'default').join(':'),
        workflow: snapshot.features.chosenStrategy.commissioned.workflow,
        reviewerVerifier, context,
        concurrency: snapshot.features.runnerCapabilityClass.value
          ? `max:${snapshot.features.runnerCapabilityClass.value.maxConcurrency}` : null,
        configuration: configKey,
        clusters: {
          run: row.runId, task: snapshot.identity.taskId,
          planDispatch: snapshot.identity.planDispatchId, orchestration: snapshot.identity.orchestrationId,
          configurationPeriod: `${snapshot.source.capturedAt.slice(0, 7)}:${configKey ?? 'default'}`,
        },
      },
      lineage: episode.identity.lineage,
      outcomes: {
        run_success: { value: episode.outcome.runOutcome === 'done' ? 1 : 0, completeness: 'complete' },
        landing: { value: episode.outcome.landingOutcome === 'landed' ? 1 : 0, completeness: 'complete' },
        elapsed_ms: observation(episode.execution.clocks.elapsedExecutionMs.value, episode.execution.clocks.elapsedExecutionMs.status),
        files_changed: observation(changed.changedFiles.value, changed.changedFiles.status),
        churn: observation(changed.churn.value, changed.churn.status),
        review_rounds: observation(episode.outcome.reviewRounds.value, episode.outcome.reviewRounds.status),
        later_quality_event: { value: qualityKeys.has(`${row.runId}:${row.sitting}`) ? 1 : 0, completeness: 'complete' },
      },
    });
  }
  const generationKey = [
    STRATEGY_COMPARISON_VERSION, input.dimension, input.metric,
    input.from ?? '', input.to ?? '', ...snapshots.map((row) => row.snapshotHash),
  ].join('|');
  const result = compareStrategies({ generationKey, dimension: input.dimension, metric: input.metric, cases, policy: input.policy });
  const reasons = [
    ...(truncated ? [`shadow snapshot scan exceeded ${limit} rows`] : []),
    ...(episodeResult.coverage.complete ? [] : episodeResult.coverage.reasons),
    ...(cases.length < snapshots.length ? [`${snapshots.length - cases.length} snapshots lacked a usable terminal episode`] : []),
  ];
  return { ...result, coverage: { complete: reasons.length === 0, reasons, snapshotsScanned: snapshots.length } };
}
