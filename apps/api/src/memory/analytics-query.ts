import type {
  MetricCompleteness,
  ProjectIntelligenceEpisode,
  ProjectQualityEvent,
  IntelligenceDurationMs,
  IntelligenceIntegerMetric,
  IntelligenceNumberMetric,
  IntelligenceRatioMetric,
} from '@noriq-dev/shared';

export const HISTORICAL_ANALYTICS_MAX_ROWS = 5_000;
export const HISTORICAL_ANALYTICS_MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1_000;
export const HISTORICAL_ANALYTICS_DEFAULT_RANGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const HISTORICAL_ANALYTICS_MAX_CASES = 100;
export const HISTORICAL_ANALYTICS_DEFAULT_QUALITY_HORIZON_DAYS = 30;

export type HistoricalAnalyticsDimension =
  | 'project' | 'plan' | 'plan_dispatch' | 'orchestration' | 'task' | 'run' | 'sitting'
  | 'commissioned_workflow' | 'executed_workflow' | 'configuration' | 'stage' | 'role'
  | 'work_source';

export type HistoricalAnalyticsScope =
  | 'all' | 'runner_runs' | 'copilot_claims' | 'runner_job_tasks';

export interface HistoricalAnalyticsQuery {
  from?: string;
  to?: string;
  groupBy?: HistoricalAnalyticsDimension;
  filters?: Array<{ dimension: HistoricalAnalyticsDimension; value: string }>;
  caseCursor?: string;
  caseLimit?: number;
  qualityHorizonDays?: number;
  scope?: HistoricalAnalyticsScope;
}

export interface AnalyticsMetricSummary {
  observedCount: number;
  partialCount: number;
  unavailableCount: number;
  denominator: number;
  min: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  iqr: number | null;
  p90: number | null;
  max: number | null;
  total: number | null;
}

export interface AnalyticsRate {
  numerator: number;
  denominator: number;
  rate: number | null;
}

export interface AnalyticsCaseRef {
  episodeId: string;
  runId: string;
  sitting: number;
  taskId: string | null;
  planId: string | null;
  planDispatchId: string | null;
  orchestrationId: string | null;
  executionId: string | null;
}

export interface AnalyticsCompositionEntry {
  value: string;
  sittingCount: number;
  tokens: { value: number | null; denominator: number; share: number | null; completeness: MetricCompleteness };
  costUSD: { value: number | null; denominator: number; share: number | null; completeness: MetricCompleteness };
}

export interface AnalyticsAggregateGroup {
  dimension: HistoricalAnalyticsDimension | 'all';
  value: string;
  provenance: { source: 'derived_generation'; generationId: string; generationCompletedAt: string };
  sample: { sittings: number; runs: number };
  throughput: { sittings: number; runs: number; firstObservedAt: string | null; lastObservedAt: string | null };
  metrics: Record<string, AnalyticsMetricSummary>;
  outcomes: {
    done: AnalyticsRate;
    failed: AnalyticsRate;
    cancelled: AnalyticsRate;
    landed: AnalyticsRate;
    laterInstability: {
      status: 'unavailable' | 'partial' | 'complete';
      count: number | null;
      eventCount: number;
      denominator: number;
      rate: number | null;
      horizonDays: number;
      observedThrough: string;
      eventTypeCounts: Record<ProjectQualityEvent['type'], number>;
      reason: string | null;
    };
  };
  composition: {
    stages: AnalyticsCompositionEntry[];
    roles: AnalyticsCompositionEntry[];
    reviewRepairTokenShare: { value: number | null; denominator: number; share: number | null; completeness: MetricCompleteness };
  };
  completeness: {
    lineageComplete: number;
    lineagePartial: number;
    lineageUnknown: number;
    metricDenominators: Record<string, number>;
  };
  supportingCaseCount: number;
  supportingCases: AnalyticsCaseRef[];
}

export interface HistoricalAnalyticsResult {
  observedAt: string;
  generation: {
    id: string;
    extractionVersion: string;
    completedAt: string;
    memoryRevision: number;
    coordinationEventSequence: number | null;
    orchestrationWatermark: string | null;
    completeness: unknown;
  };
  filter: {
    from: string; to: string; scope: HistoricalAnalyticsScope;
    groupBy: HistoricalAnalyticsDimension | null;
    filters: Array<{ dimension: HistoricalAnalyticsDimension; value: string }>;
  };
  coverage: {
    complete: boolean; scannedRows: number; matchedSittings: number; reasons: string[];
    qualityEventsScanned: number; unassociatedQualityEvents: number;
  };
  groups: AnalyticsAggregateGroup[];
  cases: { items: AnalyticsCaseRef[]; nextCursor: string | null; total: number };
}

type MetricEnvelope = IntelligenceDurationMs | IntelligenceIntegerMetric | IntelligenceNumberMetric | IntelligenceRatioMetric;
type MetricAccumulator = { complete: number[]; partial: number; unavailable: number };

const emptyAccumulator = (): MetricAccumulator => ({ complete: [], partial: 0, unavailable: 0 });

function addMetric(acc: MetricAccumulator, metric: MetricEnvelope | null): void {
  if (!metric || metric.status === 'unavailable' || metric.status === 'not_applicable' || metric.value == null) {
    acc.unavailable++;
  } else if (metric.status === 'partial') {
    acc.partial++;
  } else {
    acc.complete.push(metric.value as number);
  }
}

function addValue(acc: MetricAccumulator, value: number | null, partial = false): void {
  if (value == null || !Number.isFinite(value)) acc.unavailable++;
  else if (partial) acc.partial++;
  else acc.complete.push(value);
}

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function summarize(acc: MetricAccumulator): AnalyticsMetricSummary {
  const values = [...acc.complete].sort((a, b) => a - b);
  const p25 = quantile(values, 0.25);
  const p75 = quantile(values, 0.75);
  return {
    observedCount: values.length,
    partialCount: acc.partial,
    unavailableCount: acc.unavailable,
    denominator: values.length,
    min: values[0] ?? null,
    p25,
    median: quantile(values, 0.5),
    p75,
    iqr: p25 == null || p75 == null ? null : p75 - p25,
    p90: quantile(values, 0.9),
    max: values.at(-1) ?? null,
    total: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
  };
}

function rate(numerator: number, denominator: number): AnalyticsRate {
  return { numerator, denominator, rate: denominator ? numerator / denominator : null };
}

function caseRef(episode: ProjectIntelligenceEpisode): AnalyticsCaseRef {
  return {
    episodeId: episode.identity.episodeId,
    runId: episode.identity.runId,
    sitting: episode.identity.sitting,
    taskId: episode.identity.taskId,
    planId: episode.identity.planId,
    planDispatchId: episode.identity.planDispatchId,
    orchestrationId: episode.identity.orchestrationId,
    executionId: episode.identity.executionId,
  };
}

function dimensionValues(episode: ProjectIntelligenceEpisode, dimension: HistoricalAnalyticsDimension): string[] {
  const id = episode.identity;
  switch (dimension) {
    case 'project': return [id.projectId];
    case 'plan': return id.planId ? [id.planId] : [];
    case 'plan_dispatch': return id.planDispatchId ? [id.planDispatchId] : [];
    case 'orchestration': return id.orchestrationId ? [id.orchestrationId] : [];
    case 'task': return id.taskId ? [id.taskId] : [];
    case 'run': return [id.runId];
    case 'sitting': return [`${id.runId}/${id.sitting}`];
    case 'commissioned_workflow': return episode.preExecution.commissionedStrategy?.workflow
      ? [episode.preExecution.commissionedStrategy.workflow] : [];
    case 'executed_workflow': return episode.execution.executedStrategy?.workflow
      ? [episode.execution.executedStrategy.workflow] : [];
    case 'configuration': return episode.preExecution.configuration.map((item) =>
      `${item.kind}:${item.name ?? '(unnamed)'}@${item.version ?? item.fingerprint}`);
    case 'stage': return [...new Set(episode.execution.stages.map((stage) => stage.stage ?? '(unnamed)'))];
    case 'role': return [...new Set(episode.execution.stages.map((stage) => stage.role))];
    case 'work_source': return [episode.identity.workSource?.kind ?? 'runner_run'];
  }
}

function episodeScope(episode: ProjectIntelligenceEpisode): Exclude<HistoricalAnalyticsScope, 'all'> {
  const kind = episode.identity.workSource?.kind ?? 'runner_run';
  if (kind === 'runner_job') return 'runner_job_tasks';
  if (kind === 'copilot_claim') return 'copilot_claims';
  return 'runner_runs';
}

function totalModelUsage(episode: ProjectIntelligenceEpisode): { tokens: number | null; costUSD: number | null } {
  const metric = episode.execution.observedModelUsage;
  if (metric.status !== 'complete' || !metric.value) return { tokens: null, costUSD: null };
  let tokens = 0;
  let costUSD = 0;
  for (const usage of Object.values(metric.value)) {
    tokens += usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
    costUSD += usage.costUSD;
  }
  // Codex currently reports token usage without an authoritative price. A numeric wire zero is
  // therefore not an observed zero-cost run and must stay out of cost denominators.
  const tool = episode.execution.executedStrategy?.tool ?? episode.preExecution.commissionedStrategy?.tool;
  return { tokens, costUSD: tool === 'codex' && costUSD === 0 ? null : costUSD };
}

function ratioMetric(value: number | null): IntelligenceNumberMetric | null {
  if (value == null) return null;
  return {
    status: 'complete', value, provenance: 'derived', source: 'derived_generation',
    sourceId: null, observedAt: null, acceptedAt: null, reason: 'observed use divided by immutable commissioned budget',
  };
}

type CompositionAccumulator = {
  sittings: Set<string>;
  tokens: number;
  tokenObserved: number;
  tokenUnavailable: number;
  cost: number;
  costObserved: number;
  costUnavailable: number;
};

function composition(episodes: ProjectIntelligenceEpisode[], pick: (episode: ProjectIntelligenceEpisode) => Array<{ key: string; tokens: MetricEnvelope; cost: MetricEnvelope }>): AnalyticsCompositionEntry[] {
  const entries = new Map<string, CompositionAccumulator>();
  for (const episode of episodes) {
    const sittingKey = `${episode.identity.runId}/${episode.identity.sitting}`;
    for (const item of pick(episode)) {
      const acc = entries.get(item.key) ?? {
        sittings: new Set(), tokens: 0, tokenObserved: 0, tokenUnavailable: 0,
        cost: 0, costObserved: 0, costUnavailable: 0,
      };
      acc.sittings.add(sittingKey);
      if (item.tokens.status === 'complete' && item.tokens.value != null) { acc.tokens += item.tokens.value as number; acc.tokenObserved++; }
      else acc.tokenUnavailable++;
      if (item.cost.status === 'complete' && item.cost.value != null) { acc.cost += item.cost.value as number; acc.costObserved++; }
      else acc.costUnavailable++;
      entries.set(item.key, acc);
    }
  }
  const tokenDenominator = [...entries.values()].reduce((sum, entry) => sum + entry.tokens, 0);
  const costDenominator = [...entries.values()].reduce((sum, entry) => sum + entry.cost, 0);
  const anyTokenUnavailable = [...entries.values()].some((entry) => entry.tokenUnavailable > 0);
  const anyCostUnavailable = [...entries.values()].some((entry) => entry.costUnavailable > 0);
  return [...entries.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([value, entry]) => ({
    value,
    sittingCount: entry.sittings.size,
    tokens: {
      value: entry.tokenObserved ? entry.tokens : null,
      denominator: tokenDenominator,
      share: entry.tokenObserved && tokenDenominator ? entry.tokens / tokenDenominator : null,
      completeness: entry.tokenObserved ? anyTokenUnavailable ? 'partial' : 'complete' : 'unavailable',
    },
    costUSD: {
      value: entry.costObserved ? entry.cost : null,
      denominator: costDenominator,
      share: entry.costObserved && costDenominator ? entry.cost / costDenominator : null,
      completeness: entry.costObserved ? anyCostUnavailable ? 'partial' : 'complete' : 'unavailable',
    },
  }));
}

function aggregateGroup(
  dimension: HistoricalAnalyticsDimension | 'all',
  value: string,
  episodes: ProjectIntelligenceEpisode[],
  generation: HistoricalAnalyticsResult['generation'],
  qualityEvents: ProjectQualityEvent[],
  qualityHorizonDays: number,
  qualityEventsTruncated: boolean,
): AnalyticsAggregateGroup {
  const accumulators = Object.fromEntries([
    'queueDurationMs', 'dispatchToStartMs', 'elapsedExecutionMs', 'parkedMs', 'verifyDurationMs',
    'tokens', 'costUSD', 'reviewRounds', 'acceptanceCoverage', 'changedFiles', 'additions', 'deletions',
    'churn', 'budgetTokenUse', 'budgetCostUse', 'budgetDurationUse', 'budgetReviewRoundUse',
  ].map((key) => [key, emptyAccumulator()])) as Record<string, MetricAccumulator>;
  for (const episode of episodes) {
    const clocks = episode.execution.clocks;
    addMetric(accumulators.queueDurationMs!, clocks.queueDurationMs);
    addMetric(accumulators.dispatchToStartMs!, clocks.dispatchToStartMs);
    addMetric(accumulators.elapsedExecutionMs!, clocks.elapsedExecutionMs);
    addMetric(accumulators.parkedMs!, clocks.humanBlockedMs);
    addMetric(accumulators.verifyDurationMs!, clocks.verifyDurationMs);
    const usage = totalModelUsage(episode);
    addValue(accumulators.tokens!, usage.tokens);
    addValue(accumulators.costUSD!, usage.costUSD);
    addMetric(accumulators.reviewRounds!, episode.outcome.reviewRounds);
    addMetric(accumulators.acceptanceCoverage!, episode.outcome.acceptanceCoverage);
    addMetric(accumulators.changedFiles!, episode.execution.changes.changedFiles);
    addMetric(accumulators.additions!, episode.execution.changes.additions);
    addMetric(accumulators.deletions!, episode.execution.changes.deletions);
    addMetric(accumulators.churn!, episode.execution.changes.churn);
    const budget = episode.preExecution.budget;
    addMetric(accumulators.budgetTokenUse!, ratioMetric(usage.tokens != null && budget?.maxTokens ? usage.tokens / budget.maxTokens : null));
    addMetric(accumulators.budgetCostUse!, ratioMetric(usage.costUSD != null && budget?.maxUsd ? usage.costUSD / budget.maxUsd : null));
    const elapsed = clocks.elapsedExecutionMs.status === 'complete' ? clocks.elapsedExecutionMs.value : null;
    addMetric(accumulators.budgetDurationUse!, ratioMetric(elapsed != null && budget?.maxDurationSeconds ? elapsed / (budget.maxDurationSeconds * 1_000) : null));
    const rounds = episode.outcome.reviewRounds.status === 'complete' ? episode.outcome.reviewRounds.value : null;
    addMetric(accumulators.budgetReviewRoundUse!, ratioMetric(rounds != null && budget?.maxRounds ? rounds / budget.maxRounds : null));
  }
  const stages = composition(episodes, (episode) => episode.execution.stages.map((stage) => ({
    key: stage.stage ?? '(unnamed)', tokens: stage.tokens, cost: stage.costUSD,
  })));
  const roles = composition(episodes, (episode) => episode.execution.stages.map((stage) => ({
    key: stage.role, tokens: stage.tokens, cost: stage.costUSD,
  })));
  const tokenDenominator = roles.reduce((sum, entry) => sum + (entry.tokens.value ?? 0), 0);
  const reviewRepairTokens = roles.filter((entry) => entry.value === 'reviewer' || entry.value === 'repair')
    .reduce((sum, entry) => sum + (entry.tokens.value ?? 0), 0);
  const tokenCompositionPartial = roles.some((entry) => entry.tokens.completeness === 'partial');
  const refs = episodes.map(caseRef);
  const first = episodes.map((episode) => episode.sources.capturedAt).sort()[0] ?? null;
  const last = episodes.map((episode) => episode.sources.capturedAt).sort().at(-1) ?? null;
  const horizonMs = qualityHorizonDays * 24 * 60 * 60 * 1_000;
  const observedThroughMs = Date.parse(generation.completedAt);
  const mature = episodes.filter((episode) => Date.parse(episode.sources.capturedAt) + horizonMs <= observedThroughMs);
  const matureKeys = new Map(mature.map((episode) => [
    `${episode.identity.runId}/${episode.identity.sitting}`, episode,
  ]));
  const relevantQuality = qualityEvents.filter((event) => {
    if (!event.runId || !event.sitting) return false;
    const episode = matureKeys.get(`${event.runId}/${event.sitting}`);
    if (!episode) return false;
    const observed = Date.parse(event.observedAt);
    const captured = Date.parse(episode.sources.capturedAt);
    return observed >= captured && observed <= captured + horizonMs && observed <= observedThroughMs;
  });
  const affectedSittings = new Set(relevantQuality.map((event) => `${event.runId}/${event.sitting}`)).size;
  const qualityReasons: string[] = [];
  if (qualityEventsTruncated) qualityReasons.push('quality-event scan budget exceeded');
  if (mature.length < episodes.length) qualityReasons.push(`${episodes.length - mature.length} sitting(s) have not completed the quality horizon`);
  const qualityStatus = mature.length === 0
    ? 'unavailable' as const
    : qualityReasons.length ? 'partial' as const : 'complete' as const;
  const eventTypeCounts: Record<ProjectQualityEvent['type'], number> = {
    task_reopened: 0, work_reverted: 0, regression_task_linked: 0,
  };
  for (const event of relevantQuality) eventTypeCounts[event.type]++;
  return {
    dimension,
    value,
    provenance: {
      source: 'derived_generation', generationId: generation.id, generationCompletedAt: generation.completedAt,
    },
    sample: { sittings: episodes.length, runs: new Set(episodes.map((episode) => episode.identity.runId)).size },
    throughput: { sittings: episodes.length, runs: new Set(episodes.map((episode) => episode.identity.runId)).size, firstObservedAt: first, lastObservedAt: last },
    metrics: Object.fromEntries(Object.entries(accumulators).map(([key, acc]) => [key, summarize(acc)])),
    outcomes: {
      done: rate(episodes.filter((episode) => episode.outcome.runOutcome === 'done').length, episodes.length),
      failed: rate(episodes.filter((episode) => episode.outcome.runOutcome === 'failed').length, episodes.length),
      cancelled: rate(episodes.filter((episode) => episode.outcome.runOutcome === 'cancelled').length, episodes.length),
      landed: rate(episodes.filter((episode) => episode.outcome.landingOutcome === 'landed').length, episodes.length),
      laterInstability: {
        status: qualityStatus,
        count: mature.length ? affectedSittings : null,
        eventCount: relevantQuality.length,
        denominator: mature.length,
        rate: mature.length ? affectedSittings / mature.length : null,
        horizonDays: qualityHorizonDays,
        observedThrough: generation.completedAt,
        eventTypeCounts,
        reason: qualityStatus === 'complete' ? null
          : qualityReasons.join('; ') || 'no sitting has completed the configured quality horizon',
      },
    },
    composition: {
      stages,
      roles,
      reviewRepairTokenShare: {
        value: tokenDenominator ? reviewRepairTokens : null,
        denominator: tokenDenominator,
        share: tokenDenominator ? reviewRepairTokens / tokenDenominator : null,
        completeness: tokenDenominator ? tokenCompositionPartial ? 'partial' : 'complete' : 'unavailable',
      },
    },
    completeness: {
      lineageComplete: episodes.filter((episode) => episode.identity.lineage.status === 'complete').length,
      lineagePartial: episodes.filter((episode) => episode.identity.lineage.status === 'partial').length,
      lineageUnknown: episodes.filter((episode) => episode.identity.lineage.status === 'unknown').length,
      metricDenominators: Object.fromEntries(Object.entries(accumulators).map(([key, acc]) => [key, acc.complete.length])),
    },
    supportingCaseCount: refs.length,
    supportingCases: refs.slice(0, 20),
  };
}

export function validateHistoricalAnalyticsQuery(input: HistoricalAnalyticsQuery, now = new Date()): Required<Pick<HistoricalAnalyticsQuery, 'from' | 'to'>> & HistoricalAnalyticsQuery {
  const to = input.to ?? now.toISOString();
  const from = input.from ?? new Date(Date.parse(to) - HISTORICAL_ANALYTICS_DEFAULT_RANGE_MS).toISOString();
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) throw new Error('analytics time range is invalid');
  if (toMs - fromMs > HISTORICAL_ANALYTICS_MAX_RANGE_MS) throw new Error('analytics time range exceeds 366 days');
  if ((input.filters?.length ?? 0) > 8) throw new Error('analytics query supports at most 8 filters');
  if (input.qualityHorizonDays != null
    && (!Number.isInteger(input.qualityHorizonDays) || input.qualityHorizonDays < 1 || input.qualityHorizonDays > 3650)) {
    throw new Error('analytics quality horizon must be an integer from 1 to 3650 days');
  }
  return { ...input, from, to };
}

export function aggregateHistoricalAnalytics(input: {
  episodes: ProjectIntelligenceEpisode[];
  qualityEvents?: ProjectQualityEvent[];
  scannedRows: number;
  truncated: boolean;
  qualityEventsTruncated?: boolean;
  query: HistoricalAnalyticsQuery;
  generation: HistoricalAnalyticsResult['generation'];
  observedAt?: string;
}): HistoricalAnalyticsResult {
  const query = validateHistoricalAnalyticsQuery(input.query, new Date(input.observedAt ?? Date.now()));
  const fromMs = Date.parse(query.from);
  const toMs = Date.parse(query.to);
  const filters = query.filters ?? [];
  const scope = query.scope ?? 'all';
  const qualityHorizonDays = query.qualityHorizonDays ?? HISTORICAL_ANALYTICS_DEFAULT_QUALITY_HORIZON_DAYS;
  const qualityEvents = input.qualityEvents ?? [];
  const matched = input.episodes.filter((episode) => {
    const captured = Date.parse(episode.sources.capturedAt);
    return captured >= fromMs && captured <= toMs
      && (scope === 'all' || episodeScope(episode) === scope)
      && filters.every((filter) => dimensionValues(episode, filter.dimension).includes(filter.value));
  }).sort((a, b) => a.identity.runId.localeCompare(b.identity.runId) || a.identity.sitting - b.identity.sitting);
  const groups = new Map<string, ProjectIntelligenceEpisode[]>();
  if (query.groupBy) {
    for (const episode of matched) {
      for (const value of dimensionValues(episode, query.groupBy)) {
        const rows = groups.get(value) ?? [];
        rows.push(episode);
        groups.set(value, rows);
      }
    }
  } else groups.set('all', matched);
  const refs = matched.map(caseRef);
  const cursorIndex = query.caseCursor ? refs.findIndex((ref) => ref.episodeId === query.caseCursor) : -1;
  if (query.caseCursor && cursorIndex < 0) throw new Error('analytics case cursor is not present in the filtered result');
  const start = cursorIndex >= 0 ? cursorIndex + 1 : 0;
  const limit = Math.max(1, Math.min(query.caseLimit ?? 50, HISTORICAL_ANALYTICS_MAX_CASES));
  const items = refs.slice(start, start + limit);
  const unassociatedQualityEvents = qualityEvents.filter((event) => !event.runId || !event.sitting).length;
  const reasons = input.truncated ? [`active generation exceeds the ${HISTORICAL_ANALYTICS_MAX_ROWS}-row query scan budget`] : [];
  if (input.qualityEventsTruncated) reasons.push(`active generation quality events exceed the ${HISTORICAL_ANALYTICS_MAX_ROWS}-row query scan budget`);
  if (unassociatedQualityEvents) reasons.push(`${unassociatedQualityEvents} quality event(s) lack run/sitting lineage and are excluded from episode rates`);
  return {
    observedAt: input.observedAt ?? new Date().toISOString(),
    generation: input.generation,
    filter: { from: query.from, to: query.to, scope, groupBy: query.groupBy ?? null, filters },
    coverage: {
      complete: !input.truncated && !input.qualityEventsTruncated && unassociatedQualityEvents === 0,
      scannedRows: input.scannedRows, matchedSittings: matched.length, reasons,
      qualityEventsScanned: qualityEvents.length, unassociatedQualityEvents,
    },
    groups: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([value, episodes]) =>
      aggregateGroup(
        query.groupBy ?? 'all', value, episodes, input.generation, qualityEvents,
        qualityHorizonDays, input.qualityEventsTruncated === true,
      )),
    cases: { items, nextCursor: start + items.length < refs.length ? items.at(-1)?.episodeId ?? null : null, total: refs.length },
  };
}
