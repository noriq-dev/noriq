import {
  AnalyticsGenerationDescriptor,
  BackendChangeStats,
  EvidenceMaturity,
  EffortEpisode,
  IntelligenceDurationMs,
  ProjectIntelligenceEpisode,
} from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';

const at = '2026-08-10T00:00:00.000Z';

const unavailable = {
  status: 'unavailable' as const,
  value: null,
  provenance: 'unavailable' as const,
  source: 'runner' as const,
  reason: 'old runner did not report this field',
};

const notApplicable = {
  status: 'not_applicable' as const,
  value: null,
  provenance: 'server_observed' as const,
  source: 'd1_coordination' as const,
  reason: 'this run had no verifier',
};

const completeZero = {
  status: 'complete' as const,
  value: 0,
  provenance: 'server_observed' as const,
  source: 'd1_coordination' as const,
};

const episodeFacts = (sitting: number) => ({
  schemaVersion: 1 as const,
  identity: {
    episodeId: `epi_${sitting}`,
    projectId: 'prj_plnr',
    runId: 'run_1',
    sitting,
    lineage: { status: 'partial' as const, missing: ['legacy' as const], reason: 'old runner' },
  },
  sources: { memoryRevision: 4, coordinationEventSequence: 12, capturedAt: at },
  versions: { extraction: 'v1' },
  preExecution: {
    task: { taskType: 'feature', tags: ['memory'], executionSpecFingerprint: 'sha256:commissioned', capturedAt: at },
    requestedStrategy: { tool: 'codex', model: 'gpt-5' },
    commissionedStrategy: { tool: 'codex', model: 'gpt-5' },
    commissionedSpec: { requirementIds: ['REQ-1'] },
  },
  execution: {
    executedStrategy: { tool: 'codex', model: 'gpt-5.1' },
    executedSpec: { requirementIds: ['REQ-1'], acceptance: { observableTruths: ['contract parses'] } },
    observedModelUsage: unavailable,
    clocks: {
      queueDurationMs: completeZero,
      dispatchToStartMs: completeZero,
      elapsedExecutionMs: unavailable,
      humanBlockedMs: completeZero,
      verifyDurationMs: notApplicable,
    },
    changes: {
      backend: 'diversion',
      changedFiles: unavailable,
      additions: unavailable,
      deletions: unavailable,
      churn: unavailable,
    },
  },
  outcome: {
    runOutcome: 'done' as const,
    landingOutcome: 'landed' as const,
    reviewRounds: completeZero,
    acceptanceCoverage: unavailable,
  },
});

describe('Project Intelligence shared contract (PLNR-290)', () => {
  it('keeps old effort episodes valid when analytics facts are absent', () => {
    const parsed = EffortEpisode.parse({
      id: 'epi_old', projectId: 'prj_plnr', runId: 'run_old', createdAt: at,
    });
    expect(parsed.intelligence).toBeUndefined();
  });

  it('distinguishes a complete zero from unavailable and not-applicable', () => {
    expect(IntelligenceDurationMs.parse(completeZero)).toMatchObject({ status: 'complete', value: 0 });
    expect(IntelligenceDurationMs.parse(unavailable)).toMatchObject({ status: 'unavailable', value: null });
    expect(IntelligenceDurationMs.parse(notApplicable)).toMatchObject({ status: 'not_applicable', value: null });
    expect(() => IntelligenceDurationMs.parse({ ...unavailable, value: 0 })).toThrow();
  });

  it('keeps commissioned and executed strategy/spec facts structurally separate', () => {
    const parsed = ProjectIntelligenceEpisode.parse(episodeFacts(1));
    expect(parsed.preExecution.commissionedStrategy?.model).toBe('gpt-5');
    expect(parsed.execution.executedStrategy?.model).toBe('gpt-5.1');
    expect(parsed.preExecution.commissionedSpec?.acceptance.observableTruths).toEqual([]);
    expect(parsed.execution.executedSpec?.acceptance.observableTruths).toEqual(['contract parses']);
  });

  it('identifies continued sittings independently and preserves partial legacy lineage', () => {
    const first = ProjectIntelligenceEpisode.parse(episodeFacts(1));
    const second = ProjectIntelligenceEpisode.parse(episodeFacts(2));
    expect(first.identity.runId).toBe(second.identity.runId);
    expect(first.identity.sitting).toBe(1);
    expect(second.identity.sitting).toBe(2);
    expect(second.identity.lineage).toEqual({ status: 'partial', missing: ['legacy'], reason: 'old runner' });
  });

  it('uses the fixed evidence vocabulary and cannot express equality or a winner', () => {
    expect(EvidenceMaturity.options).toEqual([
      'insufficient_evidence', 'cannot_yet_distinguish', 'directional_signal', 'distinguishable',
    ]);
    expect(EvidenceMaturity.safeParse('equal').success).toBe(false);
    expect(EvidenceMaturity.safeParse('winner').success).toBe(false);
  });

  it('represents unsupported VCS change statistics without fabricated zeroes', () => {
    const parsed = BackendChangeStats.parse(episodeFacts(1).execution.changes);
    expect(parsed.changedFiles.status).toBe('unavailable');
    expect(parsed.changedFiles.value).toBeNull();
  });

  it('carries the source watermarks needed to identify a rebuild generation', () => {
    const parsed = AnalyticsGenerationDescriptor.parse({
      id: 'agen_1', projectId: 'prj_plnr', state: 'complete',
      versions: { extraction: 'v1', retrieval: 'r2' },
      sources: { memoryRevision: 4, coordinationEventSequence: 12, orchestrationAcceptedAt: at, capturedAt: at },
      createdAt: at, completedAt: at,
    });
    expect(parsed.sources).toMatchObject({ memoryRevision: 4, coordinationEventSequence: 12, orchestrationAcceptedAt: at });
  });

  it('strips raw transcript-like extras rather than carrying them into analytics facts', () => {
    const parsed = ProjectIntelligenceEpisode.parse({ ...episodeFacts(1), transcript: 'do not retain me' });
    expect('transcript' in parsed).toBe(false);
  });
});
