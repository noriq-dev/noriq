// PLNR-302: one bounded, deterministic read packet for the Project Intelligence surface.
// Live D1 facts and frozen ProjectMemory analytics deliberately remain sibling sections with
// different observation times. The browser renders these decisions; it does not join sources,
// calculate denominators, or decide whether a comparison is eligible.
import type { Env } from '../env';
import type { HistoricalAnalyticsDimension, HistoricalAnalyticsResult } from './analytics-query';
import { getCurrentProjectFlowSummary, getProjectAnalyticsHealth, type CurrentProjectFlowSummary } from './analytics';
import {
  queryStrategyComparison, type ComparisonMetric, type StrategyComparisonResult, type StrategyDimension,
} from './strategy-comparison';

type HistoricalState =
  | { state: 'available'; result: HistoricalAnalyticsResult }
  | { state: 'unavailable'; reason: string; result: null };

export interface ProjectIntelligenceDashboard {
  live: CurrentProjectFlowSummary;
  analytics: {
    health: Awaited<ReturnType<typeof getProjectAnalyticsHealth>>;
    historical: HistoricalState;
    freshness: {
      state: 'current' | 'lagging' | 'unavailable';
      liveObservedAt: string;
      generationCompletedAt: string | null;
      gapMs: number | null;
      label: string;
    };
  };
  comparison: StrategyComparisonResult | null;
  bounds: { from: string; to: string; caseLimit: number; groupBy: HistoricalAnalyticsDimension | null };
}

type DashboardMemory = {
  queryHistoricalAnalytics(projectId: string, query: {
    from: string; to: string; groupBy?: HistoricalAnalyticsDimension; caseCursor?: string; caseLimit: number;
  }): Promise<HistoricalAnalyticsResult>;
};

export async function getProjectIntelligenceDashboard(env: Env, projectId: string, input: {
  from: string;
  to: string;
  groupBy?: HistoricalAnalyticsDimension;
  caseCursor?: string;
  caseLimit: number;
  comparison?: { dimension: StrategyDimension; metric: ComparisonMetric };
}): Promise<ProjectIntelligenceDashboard> {
  const [live, health] = await Promise.all([
    getCurrentProjectFlowSummary(env, projectId),
    getProjectAnalyticsHealth(env, projectId),
  ]);
  const memory = env.PROJECT_MEMORY.get(env.PROJECT_MEMORY.idFromName(projectId)) as unknown as DashboardMemory;
  let historical: HistoricalState;
  try {
    historical = {
      state: 'available',
      result: await memory.queryHistoricalAnalytics(projectId, {
        from: input.from, to: input.to, groupBy: input.groupBy,
        caseCursor: input.caseCursor, caseLimit: input.caseLimit,
      }),
    };
  } catch (error) {
    historical = {
      state: 'unavailable', result: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const generationCompletedAt = historical.result?.generation.completedAt ?? health.active?.completedAt ?? null;
  const gapMs = generationCompletedAt == null
    ? null
    : Math.max(0, Date.parse(live.observedAt) - Date.parse(generationCompletedAt));
  const freshnessState = generationCompletedAt == null
    ? 'unavailable' as const
    : health.state === 'complete' && health.staleSources.length === 0 ? 'current' as const : 'lagging' as const;
  const freshness = {
    state: freshnessState,
    liveObservedAt: live.observedAt,
    generationCompletedAt,
    gapMs,
    label: freshnessState === 'current' ? 'analytics current with known sources'
      : freshnessState === 'lagging' ? 'live state is newer than the frozen analytics generation'
        : 'no complete analytics generation is available',
  };
  const comparison = input.comparison
    ? await queryStrategyComparison(env, projectId, { ...input.comparison, from: input.from, to: input.to })
    : null;
  return {
    live,
    analytics: { health, historical, freshness },
    comparison,
    bounds: { from: input.from, to: input.to, caseLimit: input.caseLimit, groupBy: input.groupBy ?? null },
  };
}
