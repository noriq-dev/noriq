import { z } from 'zod';
import { ExecutionSpec } from './execution-spec';
import { ExecutionKind, ExecutionRole, LineageCompleteness } from './orchestration';
import { RunModelUsage } from './runner';

// PLNR-290: runtime-neutral Project Intelligence vocabulary shared by Noriq and Runner. This
// file defines facts and evidence states only. Storage, extraction, queries, risk, comparison,
// and presentation deliberately live in later tasks.

export const PROJECT_INTELLIGENCE_CONTRACT_VERSION = 1 as const;

export const MetricCompleteness = z.enum(['unavailable', 'partial', 'not_applicable', 'complete']);
export type MetricCompleteness = z.infer<typeof MetricCompleteness>;

export const MetricProvenance = z.enum([
  'server_observed',
  'runner_observed',
  'driver_reported',
  'backend_observed',
  'derived',
  'inferred',
  'unavailable',
]);
export type MetricProvenance = z.infer<typeof MetricProvenance>;

export const IntelligenceSource = z.enum([
  'd1_coordination',
  'd1_orchestration',
  'project_memory_episode',
  'runner',
  'driver',
  'vcs_backend',
  'derived_generation',
]);
export type IntelligenceSource = z.infer<typeof IntelligenceSource>;

const metricObservation = {
  provenance: MetricProvenance,
  source: IntelligenceSource,
  sourceId: z.string().nullable().default(null),
  observedAt: z.string().datetime().nullable().default(null),
  acceptedAt: z.string().datetime().nullable().default(null),
  reason: z.string().nullable().default(null),
};

/**
 * A metric can never use a numeric zero to mean "unknown". Available states carry a value;
 * unavailable/not-applicable states are forced to null by construction.
 */
const metricEnvelope = <T extends z.ZodType>(value: T) => z.discriminatedUnion('status', [
  z.object({ status: z.literal('complete'), value, ...metricObservation }),
  z.object({ status: z.literal('partial'), value, ...metricObservation }),
  z.object({ status: z.literal('unavailable'), value: z.null(), ...metricObservation }),
  z.object({ status: z.literal('not_applicable'), value: z.null(), ...metricObservation }),
]);

export const IntelligenceNumberMetric = metricEnvelope(z.number().finite().nonnegative());
export const IntelligenceIntegerMetric = metricEnvelope(z.number().int().nonnegative());
export const IntelligenceDurationMs = metricEnvelope(z.number().finite().nonnegative());
export const IntelligenceRatioMetric = metricEnvelope(z.number().finite().min(0).max(1));
export const IntelligenceModelUsageMetric = metricEnvelope(RunModelUsage);
export type IntelligenceNumberMetric = z.infer<typeof IntelligenceNumberMetric>;
export type IntelligenceIntegerMetric = z.infer<typeof IntelligenceIntegerMetric>;
export type IntelligenceDurationMs = z.infer<typeof IntelligenceDurationMs>;
export type IntelligenceRatioMetric = z.infer<typeof IntelligenceRatioMetric>;

export const EvidenceMaturity = z.enum([
  'insufficient_evidence',
  'cannot_yet_distinguish',
  'directional_signal',
  'distinguishable',
]);
export type EvidenceMaturity = z.infer<typeof EvidenceMaturity>;

export const StrategyCoordinate = z.object({
  tool: z.string().nullable().default(null),
  vendor: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  effort: z.string().nullable().default(null),
  workflow: z.string().nullable().default(null),
  reviewer: z.string().nullable().default(null),
  verifier: z.string().nullable().default(null),
  contextStrategy: z.string().nullable().default(null),
  concurrencyStrategy: z.string().nullable().default(null),
});
export type StrategyCoordinate = z.infer<typeof StrategyCoordinate>;

export const ConfigurationFingerprintKind = z.enum([
  'runner',
  'workflow',
  'reviewer',
  'verifier',
  'manifest',
  'context',
]);

export const ConfigurationFingerprint = z.object({
  kind: ConfigurationFingerprintKind,
  name: z.string().nullable().default(null),
  version: z.string().nullable().default(null),
  fingerprint: z.string().min(1),
});
export type ConfigurationFingerprint = z.infer<typeof ConfigurationFingerprint>;

/** Late Runner evidence about the configuration that actually executed. It is deliberately
 * distinct from the server's commissioning snapshot and optional on telemetry for old Runners. */
export const ExecutedConfigurationEvidence = z.object({
  strategy: StrategyCoordinate.nullable().default(null),
  configuration: z.array(ConfigurationFingerprint).default([]),
});
export type ExecutedConfigurationEvidence = z.infer<typeof ExecutedConfigurationEvidence>;

export const ProjectIntelligenceIdentity = z.object({
  episodeId: z.string().min(1),
  projectId: z.string().min(1),
  runId: z.string().min(1),
  sitting: z.number().int().positive(),
  taskId: z.string().nullable().default(null),
  planId: z.string().nullable().default(null),
  planDispatchId: z.string().nullable().default(null),
  orchestrationId: z.string().nullable().default(null),
  executionId: z.string().nullable().default(null),
  repositoryKey: z.string().min(1).nullable().default(null),
  branch: z.string().min(1).nullable().default(null),
  baseId: z.string().min(1).nullable().default(null),
  lineage: LineageCompleteness,
});
export type ProjectIntelligenceIdentity = z.infer<typeof ProjectIntelligenceIdentity>;

export const TaskCommissioningSnapshot = z.object({
  taskType: z.string().nullable().default(null),
  tags: z.array(z.string().min(1)).default([]),
  executionSpecFingerprint: z.string().nullable().default(null),
  capturedAt: z.string().datetime(),
});

export const EpisodePreExecutionFacts = z.object({
  task: TaskCommissioningSnapshot,
  requestedStrategy: StrategyCoordinate.nullable().default(null),
  commissionedStrategy: StrategyCoordinate.nullable().default(null),
  commissionedSpec: ExecutionSpec.nullable().default(null),
  configuration: z.array(ConfigurationFingerprint).default([]),
});
export type EpisodePreExecutionFacts = z.infer<typeof EpisodePreExecutionFacts>;

export const EpisodeClockFacts = z.object({
  queueDurationMs: IntelligenceDurationMs,
  dispatchToStartMs: IntelligenceDurationMs,
  elapsedExecutionMs: IntelligenceDurationMs,
  humanBlockedMs: IntelligenceDurationMs,
  verifyDurationMs: IntelligenceDurationMs,
});

export const EpisodeStageFact = z.object({
  executionId: z.string().nullable().default(null),
  kind: ExecutionKind,
  role: ExecutionRole,
  stage: z.string().nullable().default(null),
  elapsedMs: IntelligenceDurationMs,
  tokens: IntelligenceIntegerMetric,
  costUSD: IntelligenceNumberMetric,
});
export type EpisodeStageFact = z.infer<typeof EpisodeStageFact>;

export const BackendChangeStats = z.object({
  backend: z.string().nullable().default(null),
  changedFiles: IntelligenceIntegerMetric,
  additions: IntelligenceIntegerMetric,
  deletions: IntelligenceIntegerMetric,
  churn: IntelligenceIntegerMetric,
});
export type BackendChangeStats = z.infer<typeof BackendChangeStats>;

export const EpisodeExecutionFacts = z.object({
  executedStrategy: StrategyCoordinate.nullable().default(null),
  executedSpec: ExecutionSpec.nullable().default(null),
  observedModelUsage: IntelligenceModelUsageMetric,
  clocks: EpisodeClockFacts,
  stages: z.array(EpisodeStageFact).default([]),
  changes: BackendChangeStats,
});
export type EpisodeExecutionFacts = z.infer<typeof EpisodeExecutionFacts>;

export const EpisodeOutcomeFacts = z.object({
  runOutcome: z.enum(['done', 'failed', 'cancelled']),
  landingOutcome: z.enum(['landed', 'not_landed', 'failed', 'pending']),
  reviewRounds: IntelligenceIntegerMetric,
  acceptanceCoverage: IntelligenceRatioMetric,
});
export type EpisodeOutcomeFacts = z.infer<typeof EpisodeOutcomeFacts>;

export const IntelligenceSourceWatermarks = z.object({
  memoryRevision: z.number().int().nonnegative().nullable().default(null),
  coordinationEventSequence: z.number().int().nonnegative().nullable().default(null),
  orchestrationAcceptedAt: z.string().datetime().nullable().default(null),
  capturedAt: z.string().datetime(),
});
export type IntelligenceSourceWatermarks = z.infer<typeof IntelligenceSourceWatermarks>;

export const IntelligenceAlgorithmVersions = z.object({
  extraction: z.string().min(1),
  retrieval: z.string().min(1).nullable().default(null),
  risk: z.string().min(1).nullable().default(null),
  comparison: z.string().min(1).nullable().default(null),
});

export const ProjectIntelligenceEpisode = z.object({
  schemaVersion: z.literal(PROJECT_INTELLIGENCE_CONTRACT_VERSION),
  identity: ProjectIntelligenceIdentity,
  sources: IntelligenceSourceWatermarks,
  versions: IntelligenceAlgorithmVersions,
  preExecution: EpisodePreExecutionFacts,
  execution: EpisodeExecutionFacts,
  outcome: EpisodeOutcomeFacts,
});
export type ProjectIntelligenceEpisode = z.infer<typeof ProjectIntelligenceEpisode>;

export const AnalyticsGenerationState = z.enum(['not_started', 'stale', 'building', 'complete', 'failed']);
export const AnalyticsGenerationDescriptor = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  state: AnalyticsGenerationState,
  versions: IntelligenceAlgorithmVersions,
  sources: IntelligenceSourceWatermarks,
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable().default(null),
  error: z.string().nullable().default(null),
});
export type AnalyticsGenerationDescriptor = z.infer<typeof AnalyticsGenerationDescriptor>;
