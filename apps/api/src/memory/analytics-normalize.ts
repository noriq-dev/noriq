import {
  ProjectIntelligenceEpisode, type EffortEpisode, type IntelligenceDurationMs,
  type IntelligenceIntegerMetric, type IntelligenceNumberMetric,
} from '@noriq-dev/shared';
import type { AnalyticsExecutionEventSnapshot, AnalyticsExecutionNodeSnapshot } from './analytics';

export interface NormalizeAnalyticsInput {
  episode: EffortEpisode;
  sitting: number;
  runKind: string;
  outcome: 'done' | 'failed' | 'cancelled';
  sourceMemoryRevision: number;
  d1EventWatermark: number | null;
  extractionVersion: string;
  nodes: AnalyticsExecutionNodeSnapshot[];
  events: AnalyticsExecutionEventSnapshot[];
}

const unavailable = (reason: string) => ({
  status: 'unavailable' as const, value: null, provenance: 'unavailable' as const,
  source: 'derived_generation' as const, sourceId: null, observedAt: null, acceptedAt: null, reason,
});

const derivedDuration = (
  value: number,
  sourceId: string | null,
  observedAt: string | null,
  acceptedAt: string | null,
  reason: string,
): IntelligenceDurationMs => ({
  status: 'complete', value: Math.max(0, value), provenance: 'derived', source: 'derived_generation',
  sourceId, observedAt, acceptedAt, reason,
});

function elapsed(node: AnalyticsExecutionNodeSnapshot): IntelligenceDurationMs {
  if (!node.startedAt || !node.finishedAt) return unavailable('execution boundaries unavailable') as IntelligenceDurationMs;
  return derivedDuration(
    Date.parse(node.finishedAt) - Date.parse(node.startedAt), node.id, node.finishedAt, node.updatedAt,
    'derived from execution lifecycle boundaries',
  );
}

function coalescedParkedMs(
  nodeIds: Set<string>,
  events: AnalyticsExecutionEventSnapshot[],
): { value: number; observedAt: string | null; acceptedAt: string | null } | null {
  const byNode = new Map<string, AnalyticsExecutionEventSnapshot[]>();
  for (const event of events) {
    if (!nodeIds.has(event.executionId)) continue;
    const list = byNode.get(event.executionId) ?? [];
    list.push(event);
    byNode.set(event.executionId, list);
  }
  const intervals: Array<[number, number]> = [];
  let lastObserved: string | null = null;
  let lastAccepted: string | null = null;
  for (const list of byNode.values()) {
    list.sort((a, b) => a.revision - b.revision);
    let parkedAt: number | null = null;
    for (const event of list) {
      if (event.eventType === 'parked') parkedAt = Date.parse(event.observedAt);
      else if (parkedAt != null && ['resumed', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(event.eventType)) {
        const end = Date.parse(event.observedAt);
        if (Number.isFinite(parkedAt) && Number.isFinite(end) && end >= parkedAt) intervals.push([parkedAt, end]);
        parkedAt = null;
      }
      if (!lastObserved || event.observedAt > lastObserved) lastObserved = event.observedAt;
      if (!lastAccepted || event.acceptedAt > lastAccepted) lastAccepted = event.acceptedAt;
    }
  }
  if (!intervals.length) return null;
  intervals.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const interval of intervals) {
    const prior = merged.at(-1);
    if (prior && interval[0] <= prior[1]) prior[1] = Math.max(prior[1], interval[1]);
    else merged.push([...interval]);
  }
  return {
    value: merged.reduce((sum, [start, end]) => sum + end - start, 0),
    observedAt: lastObserved,
    acceptedAt: lastAccepted,
  };
}

function sumCompleteDurations(metrics: IntelligenceDurationMs[]): number | null {
  if (!metrics.length || metrics.some((metric) => metric.status !== 'complete')) return null;
  return metrics.reduce((sum, metric) => sum + (metric.value ?? 0), 0);
}

export function normalizeAnalyticsEpisode(input: NormalizeAnalyticsInput): ProjectIntelligenceEpisode {
  const sittingNodes = input.nodes.filter((node) => node.runId === input.episode.runId && node.sitting === input.sitting);
  const sittingNode = sittingNodes.find((node) => node.kind === 'sitting') ?? null;
  const childIds = new Set(sittingNodes.map((node) => node.parentExecutionId).filter((id): id is string => id !== null));
  // Only leaf stage/step/gate nodes contribute composition totals. Parent and sitting elapsed are
  // retained separately, never summed with their descendants.
  const stageNodes = sittingNodes.filter((node) =>
    ['stage', 'step', 'gate'].includes(node.kind) && !childIds.has(node.id));
  const stageFacts = stageNodes.map((node) => ({
    executionId: node.id,
    kind: node.kind as 'stage' | 'step' | 'gate',
    role: node.role as 'orchestrator' | 'planner' | 'worker' | 'reviewer' | 'verifier' | 'repair' | 'system',
    stage: node.stage,
    elapsedMs: elapsed(node),
    tokens: unavailable('stage token attribution unavailable') as IntelligenceIntegerMetric,
    costUSD: unavailable('stage cost attribution unavailable') as IntelligenceNumberMetric,
  }));
  const verifierDuration = sumCompleteDurations(
    stageFacts.filter((stage) => stage.role === 'verifier').map((stage) => stage.elapsedMs),
  );
  const parked = coalescedParkedMs(new Set(sittingNodes.map((node) => node.id)), input.events);
  const stored = input.episode.intelligence;
  const lineageMissing = new Set(stored?.identity.lineage.missing ?? ['legacy']);
  let lineageStatus = stored?.identity.lineage.status ?? 'partial';
  for (const node of sittingNodes) {
    if (node.completenessStatus !== 'complete') lineageStatus = node.completenessStatus === 'unknown' ? 'unknown' : 'partial';
    try {
      for (const item of JSON.parse(node.completenessMissing || '[]') as string[]) {
        if (['root', 'parent', 'actor', 'presence', 'subject', 'events', 'legacy'].includes(item)) lineageMissing.add(item as never);
      }
    } catch { lineageMissing.add('legacy'); }
  }

  const legacyChangedFiles = input.episode.filesTouched.length
    ? {
        status: 'partial' as const, value: input.episode.filesTouched.length,
        provenance: 'runner_observed' as const, source: 'project_memory_episode' as const,
        sourceId: input.episode.id, observedAt: null, acceptedAt: input.episode.createdAt,
        reason: 'legacy touched-file list is not a backend change stat',
      }
    : unavailable('backend change evidence unavailable');
  const base = stored ?? {
    schemaVersion: 1 as const,
    identity: {
      episodeId: input.episode.id, projectId: input.episode.projectId, runId: input.episode.runId,
      sitting: input.sitting, taskId: input.episode.taskId, planId: null, planDispatchId: null,
      orchestrationId: sittingNode?.orchestrationId ?? null, executionId: sittingNode?.id ?? null,
      repositoryKey: input.episode.repositoryKey, branch: null, baseId: input.episode.baseId,
      lineage: { status: 'partial' as const, missing: ['legacy' as const], reason: 'episode predates analytics commissioning capture' },
    },
    sources: {
      memoryRevision: input.sourceMemoryRevision, coordinationEventSequence: input.d1EventWatermark,
      orchestrationAcceptedAt: sittingNode?.updatedAt ?? null, capturedAt: input.episode.createdAt,
    },
    versions: { extraction: input.extractionVersion, retrieval: null, risk: null, comparison: null },
    preExecution: {
      task: { taskType: null, tags: [], executionSpecFingerprint: null, capturedAt: input.episode.createdAt },
      requestedStrategy: null, commissionedStrategy: null, commissionedSpec: null, configuration: [],
    },
    execution: {
      executedStrategy: null, executedSpec: null,
      observedModelUsage: unavailable('legacy model usage completeness is unknown'),
      clocks: {
        queueDurationMs: unavailable('legacy queue boundary unavailable'),
        dispatchToStartMs: unavailable('legacy dispatch boundary unavailable'),
        elapsedExecutionMs: unavailable('legacy execution boundary unavailable'),
        humanBlockedMs: unavailable('legacy parked intervals unavailable'),
        verifyDurationMs: input.runKind === 'verify'
          ? unavailable('legacy verify boundaries unavailable')
          : { ...unavailable('not a verify run'), status: 'not_applicable' as const },
      },
      stages: [],
      changes: {
        backend: null, changedFiles: legacyChangedFiles,
        additions: unavailable('backend change evidence unavailable'),
        deletions: unavailable('backend change evidence unavailable'),
        churn: unavailable('backend change evidence unavailable'),
      },
    },
    outcome: {
      runOutcome: input.outcome, landingOutcome: input.episode.landingOutcome,
      reviewRounds: {
        status: 'complete' as const, value: input.episode.reviewRounds,
        provenance: 'server_observed' as const, source: 'project_memory_episode' as const,
        sourceId: input.episode.id, observedAt: null, acceptedAt: input.episode.createdAt, reason: null,
      },
      acceptanceCoverage: input.episode.acceptanceCoverage == null
        ? unavailable('acceptance evidence unavailable')
        : {
            status: 'complete' as const, value: input.episode.acceptanceCoverage,
            provenance: 'server_observed' as const, source: 'project_memory_episode' as const,
            sourceId: input.episode.id, observedAt: null, acceptedAt: input.episode.createdAt, reason: null,
          },
    },
  };

  return ProjectIntelligenceEpisode.parse({
    ...base,
    identity: {
      ...base.identity,
      orchestrationId: base.identity.orchestrationId ?? sittingNode?.orchestrationId ?? null,
      executionId: base.identity.executionId ?? sittingNode?.id ?? null,
      lineage: {
        status: lineageStatus,
        missing: [...lineageMissing],
        reason: lineageStatus === 'complete' ? null : (base.identity.lineage.reason ?? 'partial orchestration lineage'),
      },
    },
    sources: {
      ...base.sources,
      memoryRevision: input.sourceMemoryRevision,
      coordinationEventSequence: input.d1EventWatermark,
      orchestrationAcceptedAt: sittingNode?.updatedAt ?? base.sources.orchestrationAcceptedAt,
    },
    versions: { ...base.versions, extraction: input.extractionVersion },
    execution: {
      ...base.execution,
      clocks: {
        ...base.execution.clocks,
        elapsedExecutionMs: sittingNode ? elapsed(sittingNode) : base.execution.clocks.elapsedExecutionMs,
        humanBlockedMs: parked
          ? derivedDuration(parked.value, sittingNode?.id ?? null, parked.observedAt, parked.acceptedAt, 'coalesced overlapping parked intervals')
          : base.execution.clocks.humanBlockedMs,
        verifyDurationMs: verifierDuration != null
          ? derivedDuration(verifierDuration, sittingNode?.id ?? null, sittingNode?.finishedAt ?? null, sittingNode?.updatedAt ?? null, 'sum of leaf verifier execution durations')
          : base.execution.clocks.verifyDurationMs,
      },
      stages: stageFacts,
    },
  });
}
