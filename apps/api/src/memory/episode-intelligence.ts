import { z } from 'zod';
import {
  BackendChangeStats,
  ConfigurationFingerprint,
  EpisodeStageFact,
  IntelligenceDurationMs,
  IntelligenceModelUsageMetric,
  ProjectIntelligenceEpisode,
} from '@noriq-dev/shared';

type ProjectIntelligence = z.infer<typeof ProjectIntelligenceEpisode>;
type IntelligenceMetric = {
  provenance: string;
  source: string;
  acceptedAt: string | null;
};

const DAEMON_PROVENANCE = new Set([
  'runner_observed',
  'driver_reported',
  'backend_observed',
  'derived',
  'unavailable',
]);
const DAEMON_SOURCES = new Set(['runner', 'driver', 'vcs_backend']);

function isDaemonObservation(metric: Pick<IntelligenceMetric, 'provenance' | 'source'>): boolean {
  return DAEMON_PROVENANCE.has(metric.provenance) && DAEMON_SOURCES.has(metric.source);
}

const daemonMetric = <T extends IntelligenceMetric>(schema: z.ZodType<T>) => schema.refine(isDaemonObservation, {
  message: 'daemon intelligence must carry runner, driver, or VCS-backend provenance',
});

const UploadedEpisodeStageFact = EpisodeStageFact.extend({
  elapsedMs: daemonMetric(EpisodeStageFact.shape.elapsedMs),
  tokens: daemonMetric(EpisodeStageFact.shape.tokens),
  costUSD: daemonMetric(EpisodeStageFact.shape.costUSD),
});

const UploadedBackendChangeStats = z.object({
  backend: BackendChangeStats.shape.backend.optional(),
  changedFiles: daemonMetric(BackendChangeStats.shape.changedFiles).optional(),
  additions: daemonMetric(BackendChangeStats.shape.additions).optional(),
  deletions: daemonMetric(BackendChangeStats.shape.deletions).optional(),
  churn: daemonMetric(BackendChangeStats.shape.churn).optional(),
});

/**
 * The only Project Intelligence facts an episode-uploading daemon may assert. Everything else
 * in ProjectIntelligenceEpisode is server-owned and is stripped at this boundary, including
 * identity, source watermarks, algorithm versions, commissioning task/spec/strategy/budget,
 * outcome, executed strategy, and executed spec.
 */
export const UploadedEpisodeIntelligence = z.object({
  preExecution: z.object({
    configuration: z.array(ConfigurationFingerprint).optional(),
  }).optional(),
  execution: z.object({
    observedModelUsage: daemonMetric(IntelligenceModelUsageMetric).optional(),
    clocks: z.object({
      verifyDurationMs: daemonMetric(IntelligenceDurationMs).optional(),
    }).optional(),
    stages: z.array(UploadedEpisodeStageFact).optional(),
    changes: UploadedBackendChangeStats.optional(),
  }).optional(),
});
export type UploadedEpisodeIntelligence = z.infer<typeof UploadedEpisodeIntelligence>;

function acceptMetric<T extends IntelligenceMetric>(metric: T, acceptedAt: string | undefined): T {
  return acceptedAt === undefined ? metric : { ...metric, acceptedAt };
}

function configurationKey(item: z.infer<typeof ConfigurationFingerprint>): string {
  return JSON.stringify([item.kind, item.name, item.version]);
}

/** Server-captured commissioning fingerprints are immutable. Daemon observations can add a
 * previously unseen coordinate, but cannot replace or clear an existing coordinate. */
function mergeConfiguration(
  existing: ProjectIntelligence['preExecution']['configuration'],
  uploaded: Array<z.infer<typeof ConfigurationFingerprint>> | undefined,
): ProjectIntelligence['preExecution']['configuration'] {
  if (uploaded === undefined) return existing;
  const merged = [...existing];
  const seen = new Set(existing.map(configurationKey));
  for (const candidate of uploaded) {
    const key = configurationKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(candidate);
  }
  return merged;
}

/** Overlay only fields present in one validated daemon enrichment. Metric envelopes are merged
 * independently so reporting one change/clock cannot erase its siblings. `acceptedAt` is always
 * server-stamped for a new upload; passing undefined is reserved for replaying already-accepted
 * enrichment over a freshly rebuilt skeleton. */
export function mergeUploadedEpisodeIntelligence(
  base: ProjectIntelligence,
  uploaded: UploadedEpisodeIntelligence,
  acceptedAt: string | undefined,
): ProjectIntelligence {
  const execution = uploaded.execution;
  const changes = execution?.changes;
  return {
    ...base,
    preExecution: {
      ...base.preExecution,
      configuration: mergeConfiguration(base.preExecution.configuration, uploaded.preExecution?.configuration),
    },
    execution: {
      ...base.execution,
      observedModelUsage: execution?.observedModelUsage === undefined
        ? base.execution.observedModelUsage
        : acceptMetric(execution.observedModelUsage, acceptedAt),
      clocks: {
        ...base.execution.clocks,
        verifyDurationMs: execution?.clocks?.verifyDurationMs === undefined
          ? base.execution.clocks.verifyDurationMs
          : acceptMetric(execution.clocks.verifyDurationMs, acceptedAt),
      },
      stages: execution?.stages === undefined
        ? base.execution.stages
        : execution.stages.map((stage) => ({
            ...stage,
            elapsedMs: acceptMetric(stage.elapsedMs, acceptedAt),
            tokens: acceptMetric(stage.tokens, acceptedAt),
            costUSD: acceptMetric(stage.costUSD, acceptedAt),
          })),
      changes: {
        ...base.execution.changes,
        backend: changes?.backend === undefined ? base.execution.changes.backend : changes.backend,
        changedFiles: changes?.changedFiles === undefined
          ? base.execution.changes.changedFiles
          : acceptMetric(changes.changedFiles, acceptedAt),
        additions: changes?.additions === undefined
          ? base.execution.changes.additions
          : acceptMetric(changes.additions, acceptedAt),
        deletions: changes?.deletions === undefined
          ? base.execution.changes.deletions
          : acceptMetric(changes.deletions, acceptedAt),
        churn: changes?.churn === undefined
          ? base.execution.changes.churn
          : acceptMetric(changes.churn, acceptedAt),
      },
    },
  };
}

function wasAcceptedDaemonMetric(metric: IntelligenceMetric): boolean {
  return metric.acceptedAt !== null && isDaemonObservation(metric);
}

/** A terminal-job replay rebuilds current server facts from D1. Carry only previously accepted
 * daemon observations across that replay; fresh server-owned fields always come from `server`.
 */
export function preserveAcceptedEpisodeIntelligence(
  server: ProjectIntelligence,
  existing: ProjectIntelligence,
): ProjectIntelligence {
  const uploaded: UploadedEpisodeIntelligence = {
    preExecution: { configuration: existing.preExecution.configuration },
    execution: {},
  };
  if (wasAcceptedDaemonMetric(existing.execution.observedModelUsage)) {
    uploaded.execution!.observedModelUsage = existing.execution.observedModelUsage;
  }
  if (wasAcceptedDaemonMetric(existing.execution.clocks.verifyDurationMs)) {
    uploaded.execution!.clocks = { verifyDurationMs: existing.execution.clocks.verifyDurationMs };
  }
  if (existing.execution.stages.length > 0 && existing.execution.stages.every((stage) =>
    wasAcceptedDaemonMetric(stage.elapsedMs)
    && wasAcceptedDaemonMetric(stage.tokens)
    && wasAcceptedDaemonMetric(stage.costUSD))) {
    uploaded.execution!.stages = existing.execution.stages;
  }
  const retainedChanges: NonNullable<UploadedEpisodeIntelligence['execution']>['changes'] = {};
  for (const key of ['changedFiles', 'additions', 'deletions', 'churn'] as const) {
    const metric = existing.execution.changes[key];
    if (wasAcceptedDaemonMetric(metric)) retainedChanges[key] = metric;
  }
  if (existing.execution.changes.backend !== null && server.execution.changes.backend === null) {
    retainedChanges.backend = existing.execution.changes.backend;
  }
  if (Object.keys(retainedChanges).length > 0) {
    uploaded.execution!.changes = retainedChanges;
  }
  return mergeUploadedEpisodeIntelligence(server, uploaded, undefined);
}
