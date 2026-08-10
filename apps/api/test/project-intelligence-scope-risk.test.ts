import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProjectIntelligenceEpisode } from '@noriq-dev/shared';
import type { Env } from '../src/env';
import { assessPreDispatchRisk } from '../src/memory/scope-risk';
import {
  duplicateWarnings, effortSignals, priorEffortCase, type DuplicateWarning, type EffortCandidate,
} from '../src/memory/similar-effort';
import { createAgent, mcpCall } from './helpers';

const appEnv = env as unknown as Env;
const at = '2026-08-09T12:00:00.000Z';
const metric = (value: number) => ({
  status: 'complete' as const, value, provenance: 'runner_observed' as const,
  source: 'runner' as const, sourceId: null, observedAt: at, acceptedAt: at, reason: null,
});
const unavailable = {
  status: 'unavailable' as const, value: null, provenance: 'unavailable' as const,
  source: 'runner' as const, sourceId: null, observedAt: null, acceptedAt: null, reason: 'not reported',
};

interface MemoryRpc {
  recordEpisode(projectId: string, input: Record<string, unknown>): Promise<{ episodeId: string }>;
  approveDecision(projectId: string, input: { memoryItemId: string; actorUserId: string }): Promise<{ approvedMemoryId: string }>;
  reconcile(projectId: string): Promise<unknown>;
}
const memory = (projectId: string) => appEnv.PROJECT_MEMORY.get(
  appEnv.PROJECT_MEMORY.idFromName(projectId),
) as unknown as MemoryRpc;

let owner: { id: string; apiKey: string };
beforeAll(async () => { owner = await createAgent('project-intelligence-scope-risk'); }, 60_000);

describe('pre-dispatch scope and budget evidence (PLNR-295)', () => {
  it('keeps one prior sitting inspectable and excludes unknown Codex cost from evidence', () => {
    const intelligence = ProjectIntelligenceEpisode.parse({
      schemaVersion: 1,
      identity: {
        episodeId: 'epi_prior', projectId: 'prj_risk', taskId: 'task_prior', runId: 'run_prior', sitting: 2,
        orchestrationId: 'orc_prior', executionId: 'exe_prior', repositoryKey: 'noriq', branch: 'feature/prior', baseId: 'abc123',
        lineage: { status: 'complete', missing: [], reason: null },
      },
      sources: { memoryRevision: 2, coordinationEventSequence: 4, capturedAt: at },
      versions: { extraction: 'test-v1' },
      preExecution: {
        task: { taskType: 'feature', tags: ['memory'], executionSpecFingerprint: 'fp-prior', capturedAt: at },
        requestedStrategy: { tool: 'codex' }, commissionedStrategy: { tool: 'codex' },
      },
      execution: {
        executedStrategy: { tool: 'codex' },
        observedModelUsage: {
          status: 'complete', value: { '(unattributed)': {
            inputTokens: 80, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0,
          } },
          provenance: 'runner_observed', source: 'runner', sourceId: null, observedAt: at, acceptedAt: at, reason: null,
        },
        clocks: {
          queueDurationMs: metric(0), dispatchToStartMs: metric(0), elapsedExecutionMs: metric(120_000),
          humanBlockedMs: metric(0), verifyDurationMs: metric(30_000),
        },
        stages: [{
          executionId: 'exe_verify', kind: 'stage', role: 'verifier', stage: 'verify',
          elapsedMs: metric(30_000), tokens: unavailable, costUSD: unavailable,
        }],
        changes: { backend: 'git', changedFiles: metric(9), additions: metric(10), deletions: metric(2), churn: metric(12) },
      },
      outcome: { runOutcome: 'done', landingOutcome: 'landed', reviewRounds: metric(2), acceptanceCoverage: metric(1) },
    });
    const candidate: EffortCandidate = {
      episodeId: 'epi_prior', runId: 'run_prior', sitting: 2, taskId: 'task_prior', taskKey: 'RISK-1',
      runKind: 'build', outcome: 'done', landingOutcome: 'landed', filesTouched: [], failures: [], findings: [],
      approachSummary: 'prior attempt', unresolvedQuestions: [], reviewRounds: 2, costUSD: 0, tokenUsage: {},
      startedAt: at, finishedAt: at, stage: 'graph', score: 1, intelligence,
    };
    const warning: DuplicateWarning = {
      episodeId: 'epi_prior', runId: 'run_prior', taskId: 'task_prior', taskKey: 'RISK-1', runKind: 'build',
      outcome: 'done', landingOutcome: 'landed', whatWasAttempted: 'prior attempt', whatFailed: [],
      whatRemainsUncertain: [], support: [{ kind: 'graph-neighborhood', detail: 'task>related_to>episode' }], score: 2,
    };
    const item = priorEffortCase(candidate, warning);
    expect(item).toMatchObject({
      episodeId: 'epi_prior', runId: 'run_prior', sitting: 2,
      executionId: 'exe_prior', orchestrationId: 'orc_prior',
      repositoryKey: 'noriq', branch: 'feature/prior', baseId: 'abc123', validity: 'historical_episode',
      retrieval: { version: 'similar-effort-v1', support: warning.support },
      observed: {
        filesTouched: { value: 9, completeness: 'complete' },
        tokens: { value: 100, completeness: 'complete' },
        costUSD: { value: null, completeness: 'unavailable' },
        elapsedMs: { value: 120_000, completeness: 'complete' },
        reviewRounds: { value: 2, completeness: 'complete' },
        verificationOrRepair: { value: true, completeness: 'complete' },
      },
    });

    const supported = {
      ...candidate, filesTouched: ['apps/api/src/prior.ts'], approachSummary: 'prior attempt',
    };
    const otherBranch: EffortCandidate = {
      ...supported, episodeId: 'epi_other', runId: 'run_other',
      intelligence: ProjectIntelligenceEpisode.parse({
        ...intelligence,
        identity: { ...intelligence.identity, episodeId: 'epi_other', runId: 'run_other', branch: 'feature/other' },
      }),
    };
    const mainBranch: EffortCandidate = {
      ...supported, episodeId: 'epi_main', runId: 'run_main',
      intelligence: ProjectIntelligenceEpisode.parse({
        ...intelligence,
        identity: { ...intelligence.identity, episodeId: 'epi_main', runId: 'run_main', branch: 'main' },
      }),
    };
    const signals = effortSignals({ title: 'prior attempt', anticipatedFiles: ['apps/api/src/prior.ts'] });
    expect(duplicateWarnings([otherBranch, mainBranch], signals, { preferBranch: 'main' }).map((item) => item.episodeId))
      .toEqual(['epi_main', 'epi_other']);
  });

  it('returns explicit unanswerable reasons and deterministic content when pre-execution context is absent', async () => {
    const projectId = (await mcpCall(owner.apiKey, 'create_project', {
      key: 'RISKNO', name: 'Risk missing context',
    })).body.id as string;
    const taskId = (await mcpCall(owner.apiKey, 'create_task', {
      projectId, title: 'Unspecified work', tags: ['analytics-test'],
    })).body.id as string;
    const first = await assessPreDispatchRisk(appEnv, projectId, taskId, { observedAt: at });
    const second = await assessPreDispatchRisk(appEnv, projectId, taskId, { observedAt: at });
    expect(second).toEqual(first);
    expect(first.advisory).toBe(true);
    expect(first.coverage.status).toBe('unanswerable');
    expect(first.coverage.reasons).toEqual(expect.arrayContaining([
      'execution_spec_absent', 'anticipated_files_absent', 'canonical_repository_not_supplied',
      'branch_context_absent', 'base_id_context_absent', 'adequate_prior_retrieval_support_absent',
    ]));
    expect(first.scope).toMatchObject({ status: 'unanswerable', anticipatedFiles: [] });
    expect(first.budget.maxTokens.observation).toContain('was not proposed');
  });

  it('uses gated prior cases and keeps current authority structurally separate from historical observations', async () => {
    const projectId = (await mcpCall(owner.apiKey, 'create_project', {
      key: 'RISKYES', name: 'Risk supported context',
    })).body.id as string;
    const taskId = (await mcpCall(owner.apiKey, 'create_task', {
      projectId,
      title: 'Migrate database connection pooling logic',
      body: 'Prevent pooling deadlocks under load.',
      tags: ['analytics-test'],
      executionSpec: {
        requirementIds: ['REQ-POOL'],
        anticipatedFiles: [{ path: 'apps/api/src/db/pool.ts', change: 'modify', why: 'replace pooling logic' }],
        acceptance: { observableTruths: ['pooling does not deadlock under load'], artifacts: [], links: [] },
      },
    })).body.id as string;
    await appEnv.DB.prepare(
      `INSERT INTO project_repositories (id, project_id, repository_key, created_at)
       VALUES ('prp_risk_supported', ?, 'noriq', ?)`,
    ).bind(projectId, at).run();
    await memory(projectId).recordEpisode(projectId, {
      runId: 'run_risk_prior', sitting: 2, agentId: null, runKind: 'build', outcome: 'failed',
      startedAt: at, finishedAt: '2026-08-09T12:02:00.000Z', taskId,
      taskTitle: 'Earlier pooling attempt', repositoryKey: 'noriq', baseId: 'base-prior',
      timeline: [], filesTouched: ['apps/api/src/db/pool.ts'], commands: [], testsRun: [],
      failures: ['database connection pooling logic deadlocked under load'],
      findings: [{ summary: 'database connection pooling logic needs per-worker ownership' }],
      reviewRounds: 2, tokenUsage: {}, costUSD: 0, acceptanceCoverage: null, steeringEvents: [],
      landingOutcome: 'failed', remainingWork: [],
      selfSummary: {
        approachSummary: 'migrate database connection pooling logic with a shared pool',
        rejectedHypotheses: [], durableLearnings: [], unresolvedQuestions: ['does per-worker pooling avoid deadlocks'],
      },
      actor: { kind: 'system', id: null },
    });
    const decision = await mcpCall(owner.apiKey, 'record_memory', {
      projectId, kind: 'decision', authority: 5,
      statement: 'Migrate database connection pooling logic. Prevent pooling deadlocks under load with per-worker ownership.',
    });
    await memory(projectId).approveDecision(projectId, {
      memoryItemId: decision.body.memoryId as string, actorUserId: 'usr_scope_risk_approver',
    });
    await memory(projectId).reconcile(projectId);

    const result = await assessPreDispatchRisk(appEnv, projectId, taskId, {
      repositoryKey: 'noriq', branch: 'main', baseId: 'base-current',
      budget: { maxTokens: 1_000, maxUsd: 1, maxDurationSeconds: 60, maxRounds: 1 },
      observedAt: at,
    });
    expect(result.target.repository).toEqual({ requestedKey: 'noriq', canonical: true, branch: 'main', baseId: 'base-current' });
    expect(result.priorEvidence.kind).toBe('historical_case_observation');
    expect(result.priorEvidence.cases).toHaveLength(1);
    expect(result.priorEvidence.cases[0]).toMatchObject({
      taskId, runId: 'run_risk_prior', sitting: 2, episodeId: expect.any(String),
      baseId: 'base-prior', validity: 'historical_episode',
      retrieval: { support: expect.arrayContaining([{ kind: 'shared-file', detail: 'apps/api/src/db/pool.ts' }]) },
      lineage: { status: 'partial' },
    });
    expect(result.scope.observation).toContain('1 relevant prior cases touched 1-1 files');
    expect(result.scope).toMatchObject({
      status: 'partial',
      priorFileCounts: { observedCount: 1, partialCount: 1, unavailableCount: 0 },
    });
    expect(result.currentAuthority.kind).toBe('current_project_authority');
    expect(result.currentAuthority.decisions[0]).toMatchObject({ authority: 5, validity: 'active' });
    expect(result.budget.maxTokens).toMatchObject({ proposed: 1_000, observedCount: 0, completeness: 'unavailable' });
  });
});
