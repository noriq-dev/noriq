import { z } from 'zod';
import {
  ConfigurationFingerprint,
  DAEMON_PROVENANCE,
  DAEMON_SOURCES,
  ProjectIntelligenceEpisode,
  UploadedEpisodeIntelligence,
} from '@noriq-dev/shared';

type ProjectIntelligence = z.infer<typeof ProjectIntelligenceEpisode>;
type IntelligenceMetric = {
  provenance: string;
  source: string;
  acceptedAt: string | null;
};

/**
 * PLNR-426: the daemon-assertable CONTRACT — the upload shape, and which provenance/source
 * values a daemon may claim — moved to packages/shared/src/intelligence.ts (DAEMON_PROVENANCE /
 * DAEMON_SOURCES / UploadedEpisodeIntelligence), so the Runner can validate its own payload
 * before uploading. What stays here is server POLICY: how an already-validated assertion is
 * merged into the server's record (mergeUploadedEpisodeIntelligence,
 * preserveAcceptedEpisodeIntelligence) — and this same daemon-membership test, needed again on
 * replay by `wasAcceptedDaemonMetric` to decide whether a previously accepted metric is still one
 * a daemon is allowed to send.
 */
function isDaemonObservation(metric: Pick<IntelligenceMetric, 'provenance' | 'source'>): boolean {
  return DAEMON_PROVENANCE.has(metric.provenance) && DAEMON_SOURCES.has(metric.source);
}

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
    // PLNR-433: a disjoint top-level key from `execution` by construction (see the placement
    // rationale on `ProjectIntelligenceEpisode` in packages/shared/src/intelligence.ts) — so
    // overlaying it here can never touch `execution.stages`/`clocks`/`changes` above, without this
    // function having to work at it.
    contextConsumption: uploaded.contextConsumption === undefined
      ? base.contextConsumption
      : acceptMetric(uploaded.contextConsumption, acceptedAt),
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
  // PLNR-433: `contextConsumption` is `.optional()` on ProjectIntelligenceEpisode (older episodes,
  // and any episode the Runner never reported context facts for, simply lack the key) — the
  // undefined check must come first, same reason `wasAcceptedDaemonMetric` itself already exists:
  // an unset fact was never a daemon assertion to begin with.
  if (existing.contextConsumption !== undefined && wasAcceptedDaemonMetric(existing.contextConsumption)) {
    uploaded.contextConsumption = existing.contextConsumption;
  }
  return mergeUploadedEpisodeIntelligence(server, uploaded, undefined);
}
