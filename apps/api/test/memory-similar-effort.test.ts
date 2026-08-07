// PLNR-264: similar-effort retrieval and duplicate-work warnings.
//
// Three layers, cheapest-first (same split memory-episodes.test.ts uses):
//   - memory/similar-effort.ts's PURE exports, driven directly with hand-built candidates — the
//     precise place to pin down the two-support-kind gate and the failed-effort rank bonus
//     without any DO or retrieval noise.
//   - ProjectMemory.similarEffort end to end, episodes seeded via the SAME recordEpisode() stub
//     call memory-episodes.test.ts already uses (no real Run row needed to seed an episode).
//   - can_claim / claim_task's `priorEffort` block via the real MCP surface.
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import type { Env } from '../src/env';
import { createAgent, mcpCall } from './helpers';
import {
  classifySupport, duplicateWarnings, effortSignals, summarizeEffort,
  type EffortCandidate, type EffortSignals,
} from '../src/memory/similar-effort';
import { loadPriorEffort } from '../src/lib/project-memory';

const appEnv = env as unknown as Env;

interface RecordEpisodeInput {
  runId: string; sitting: number; agentId: string | null; runKind: string; outcome: string; startedAt: string | null; finishedAt: string | null;
  taskId: string | null; taskTitle?: string | null; repositoryKey: string | null; baseId: string | null;
  timeline: Array<{ at: string; label: string }>; filesTouched: string[]; commands: string[]; testsRun: string[]; failures: string[];
  findings: Array<{ summary: string; severity?: string }>; reviewRounds: number; tokenUsage: Record<string, unknown>; costUSD: number;
  acceptanceCoverage: number | null; steeringEvents: string[]; landingOutcome: string; remainingWork: string[]; selfSummary?: unknown;
  actor: { kind: string; id: string | null };
}
interface SimilarEffortRpcResult {
  warnings: Array<{
    episodeId: string; runId: string; taskId: string | null; taskKey: string | null; runKind: string; outcome: string;
    landingOutcome: string; whatWasAttempted: string; whatFailed: string[]; whatRemainsUncertain: string[];
    support: Array<{ kind: string; detail: string }>; score: number;
  }>;
  summary: { episodesConsidered: number; totalCostUSD: number; totalTokens: number; averageReviewRounds: number; averageDurationMs: number | null; landingOutcomes: Record<string, number> };
  consideredCount: number;
}
interface MemRpc {
  health(pid: string): Promise<{ schemaVersion: number; memoryRevision: number; tableCounts: Record<string, number> }>;
  recordEpisode(pid: string, input: RecordEpisodeInput): Promise<{ episodeId: string; runId: string; created: boolean }>;
  similarEffort(
    pid: string,
    input: { taskId: string; title: string; body?: string | null; anticipatedFiles?: string[]; limit?: number },
  ): Promise<SimilarEffortRpcResult>;
}
const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as MemRpc;

function baseEpisodeInput(runId: string, overrides: Partial<RecordEpisodeInput> = {}): RecordEpisodeInput {
  return {
    runId, sitting: 1, agentId: null, runKind: 'build', outcome: 'done', startedAt: null, finishedAt: null,
    taskId: null, repositoryKey: null, baseId: null, timeline: [], filesTouched: [], commands: [],
    testsRun: [], failures: [], findings: [], reviewRounds: 0, tokenUsage: {}, costUSD: 0,
    acceptanceCoverage: null, steeringEvents: [], landingOutcome: 'pending', remainingWork: [],
    actor: { kind: 'system', id: null },
    ...overrides,
  };
}

let agent: { id: string; apiKey: string };
async function newProject(key: string): Promise<string> {
  const r = await mcpCall(agent.apiKey, 'create_project', { key, name: `${key} project` });
  if (r.isError) throw new Error(`create_project(${key}) failed: ${r.text}`);
  return r.body.id as string;
}

beforeAll(async () => {
  agent = await createAgent('memory-similar-effort-agent');
}, 60000);

// -------------------------------------------------------------------------------------------
// Layer 1 — memory/similar-effort.ts's pure exports
// -------------------------------------------------------------------------------------------

/** A minimal, otherwise-empty candidate — every test below overrides only what it needs, so a
 *  test reads as "what makes THIS channel fire" rather than restating the whole shape. */
function baseCandidate(overrides: Partial<EffortCandidate> = {}): EffortCandidate {
  return {
    episodeId: 'epi_1', runId: 'run_1', taskId: null, taskKey: null, runKind: 'build', outcome: 'done',
    landingOutcome: 'pending', filesTouched: [], failures: [], findings: [], approachSummary: null,
    unresolvedQuestions: [], reviewRounds: 0, costUSD: 0, tokenUsage: {}, startedAt: null, finishedAt: null,
    stage: 'lexical', score: 1,
    ...overrides,
  };
}

describe('effortSignals — pure signal extraction', () => {
  it('joins title+body into queryText and normalizes significant words into keywords', () => {
    const signals = effortSignals({ title: 'Fix the flaky websocket reconnect', body: 'Retries duplicate connections under network flaps.' });
    expect(signals.queryText).toBe('Fix the flaky websocket reconnect\nRetries duplicate connections under network flaps.');
    // Short/stopword tokens ("the", "fix" is 3 chars... wait "fix" is len 3, filtered) are absent.
    expect(signals.keywords.has('the')).toBe(false);
    expect(signals.keywords.has('websocket')).toBe(true);
    expect(signals.keywords.has('reconnect')).toBe(true);
    expect(signals.keywords.has('duplicate')).toBe(true);
  });

  it('anticipatedFiles become the files set verbatim, and an absent title/body degrades cleanly', () => {
    const signals = effortSignals({ title: 'x'.repeat(0) || 'T', anticipatedFiles: ['apps/api/src/a.ts', 'apps/api/src/b.ts'] });
    expect(signals.files).toEqual(new Set(['apps/api/src/a.ts', 'apps/api/src/b.ts']));
  });
});

describe('classifySupport — the independent evidence channels', () => {
  const signals: EffortSignals = effortSignals({
    title: 'Migrate database connection pooling logic',
    body: 'The pool leaks connections under load.',
  });

  it('shared-file fires on an exact anticipated-file overlap', () => {
    const support = classifySupport(baseCandidate({ filesTouched: ['apps/api/src/db/pool.ts', 'apps/api/src/other.ts'] }), {
      ...signals, files: new Set(['apps/api/src/db/pool.ts']),
    });
    expect(support).toContainEqual({ kind: 'shared-file', detail: 'apps/api/src/db/pool.ts' });
  });

  it('shared-failure-signature requires at least three shared significant words, and cites the failure string', () => {
    const strong = classifySupport(baseCandidate({ failures: ['database connection pooling deadlocked under load'] }), signals);
    expect(strong.find((s) => s.kind === 'shared-failure-signature')).toMatchObject({
      detail: expect.stringContaining('database connection pooling deadlocked under load'),
    });

    // Only two shared significant words ("database", "pool") — below the threshold, and this
    // failure text never reaches the text-similarity channel either (that pool only reads
    // approachSummary/findings), so classifySupport must report NOTHING for this candidate.
    const weak = classifySupport(baseCandidate({ failures: ['a database vendor outage, unrelated pool'] }), signals);
    expect(weak).toEqual([]);
  });

  it('shared-unresolved-question requires the same three-word bar and cites the question verbatim', () => {
    const support = classifySupport(
      baseCandidate({ unresolvedQuestions: ['does connection pooling need a database-side timeout'] }),
      signals,
    );
    expect(support).toContainEqual({
      kind: 'shared-unresolved-question',
      detail: expect.stringContaining('does connection pooling need a database-side timeout'),
    });
  });

  it('an edgePath through decided_by is shared-decision; any other edge is graph-neighborhood — mutually exclusive', () => {
    const decision = classifySupport(baseCandidate({ edgePath: 'node_a>decided_by>node_b' }), signals);
    expect(decision.map((s) => s.kind)).toEqual(['shared-decision']);

    const neighborhood = classifySupport(baseCandidate({ edgePath: 'node_a>related_to>node_b' }), signals);
    expect(neighborhood.map((s) => s.kind)).toEqual(['graph-neighborhood']);
  });

  it('text-similarity fires from approachSummary/findings overlap, with no minimum word count', () => {
    const support = classifySupport(baseCandidate({ approachSummary: 'tried a connection pooling rewrite' }), signals);
    expect(support).toContainEqual({ kind: 'text-similarity', detail: expect.stringContaining('shared terms:') });
  });

  it('no channel fires for a candidate with no real overlap at all', () => {
    const support = classifySupport(baseCandidate(), signals);
    expect(support).toEqual([]);
  });
});

describe('duplicateWarnings — the two-independent-support-kind gate (the hardest acceptance line)', () => {
  const signals: EffortSignals = effortSignals({ title: 'Migrate database connection pooling logic' });

  it('a candidate whose ONLY support is text-similarity never produces a warning — the case that would fail without the gate', () => {
    // High raw score, exact keyword overlap in approachSummary — if `duplicateWarnings` graded
    // on retrieval score or text similarity alone, this would rank #1. The task's own acceptance
    // ("similarity alone never marks work duplicate" / "no warning appears for unrelated lexical
    // coincidences after reranking") requires it to produce NOTHING.
    const candidates: EffortCandidate[] = [
      baseCandidate({ episodeId: 'epi_textonly', approachSummary: 'a full database connection pooling logic migration', score: 5, stage: 'semantic' }),
    ];
    expect(duplicateWarnings(candidates, signals)).toEqual([]);
  });

  it('a candidate with zero support channels never produces a warning either', () => {
    expect(duplicateWarnings([baseCandidate({ score: 100 })], signals)).toEqual([]);
  });

  it('two independent kinds clears the gate and produces a fully-cited warning', () => {
    const candidates: EffortCandidate[] = [
      baseCandidate({
        episodeId: 'epi_real', runId: 'run_real', taskId: 'task_prior', taskKey: 'PRIOR-1', outcome: 'failed',
        landingOutcome: 'failed', filesTouched: ['apps/api/src/db/pool.ts'],
        failures: ['database connection pooling logic deadlocked under load'],
        approachSummary: 'tried a shared connection pool across all workers',
        unresolvedQuestions: ['does per-worker pooling avoid the deadlock'],
      }),
    ];
    const withFiles: EffortSignals = { ...signals, files: new Set(['apps/api/src/db/pool.ts']) };
    const warnings = duplicateWarnings(candidates, withFiles);
    expect(warnings).toHaveLength(1);
    const w = warnings[0]!;
    expect(w).toMatchObject({
      episodeId: 'epi_real', runId: 'run_real', taskId: 'task_prior', taskKey: 'PRIOR-1', outcome: 'failed',
      whatWasAttempted: 'tried a shared connection pool across all workers',
      whatFailed: ['database connection pooling logic deadlocked under load'],
      whatRemainsUncertain: ['does per-worker pooling avoid the deadlock'],
    });
    expect(w.support.length).toBeGreaterThanOrEqual(2);
    expect(new Set(w.support.map((s) => s.kind)).size).toBeGreaterThanOrEqual(2);
  });

  it('§14: a failed effort ranks above an equally-matched successful one, via the positive bonus', () => {
    const withFiles: EffortSignals = { ...signals, files: new Set(['apps/api/src/db/pool.ts']) };
    const shared = { filesTouched: ['apps/api/src/db/pool.ts'], approachSummary: 'a database connection pooling rewrite', stage: 'lexical' as const, score: 1 };
    const candidates: EffortCandidate[] = [
      baseCandidate({ episodeId: 'epi_done', outcome: 'done', ...shared }),
      baseCandidate({ episodeId: 'epi_failed', outcome: 'failed', ...shared }),
    ];
    const warnings = duplicateWarnings(candidates, withFiles);
    expect(warnings.map((w) => w.episodeId)).toEqual(['epi_failed', 'epi_done']);
    expect(warnings[0]!.score).toBeGreaterThan(warnings[1]!.score);
  });

  it('respects the limit option', () => {
    const withFiles: EffortSignals = { ...signals, files: new Set(['f1', 'f2', 'f3']) };
    const candidates: EffortCandidate[] = ['a', 'b', 'c'].map((n, i) =>
      baseCandidate({ episodeId: `epi_${n}`, filesTouched: [`f${i + 1}`], approachSummary: 'database connection pooling logic notes' }));
    expect(duplicateWarnings(candidates, withFiles, { limit: 1 })).toHaveLength(1);
  });
});

describe('summarizeEffort — deterministic-skeleton-only statistics', () => {
  it('aggregates cost, tokens, review rounds, duration, and landing outcomes across candidates', () => {
    const candidates: EffortCandidate[] = [
      baseCandidate({
        episodeId: 'e1', costUSD: 1.5, reviewRounds: 2, landingOutcome: 'failed',
        tokenUsage: { 'claude-x': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 1.5 } },
        startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T01:00:00.000Z',
      }),
      baseCandidate({
        episodeId: 'e2', costUSD: 0.5, reviewRounds: 0, landingOutcome: 'landed',
        tokenUsage: { 'claude-x': { inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.5 } },
      }),
    ];
    const summary = summarizeEffort(candidates);
    expect(summary.episodesConsidered).toBe(2);
    expect(summary.totalCostUSD).toBeCloseTo(2.0);
    expect(summary.totalTokens).toBe(170);
    expect(summary.averageReviewRounds).toBe(1);
    // Only e1 carries both timestamps — averageDurationMs is computed over just that one.
    expect(summary.averageDurationMs).toBe(60 * 60 * 1000);
    expect(summary.landingOutcomes).toMatchObject({ failed: 1, landed: 1, not_landed: 0, pending: 0 });
  });

  it('an empty candidate list summarizes to all-zero / null, not an error', () => {
    const summary = summarizeEffort([]);
    expect(summary).toMatchObject({ episodesConsidered: 0, totalCostUSD: 0, totalTokens: 0, averageReviewRounds: 0, averageDurationMs: null });
  });
});

// -------------------------------------------------------------------------------------------
// Layer 2 — ProjectMemory.similarEffort end to end (real DO, real retrieval, real graph)
// -------------------------------------------------------------------------------------------

describe('ProjectMemory.similarEffort — end-to-end retrieval, gate, and non-mutation', () => {
  it('a failed effort graph-linked to the SAME task (shared-file + graph-neighborhood) produces a fully-cited warning', async () => {
    const projectId = await newProject('MSE1');
    const made = await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'Rework the settings sync throttle', tags: ['similar-effort-test'] });
    const taskId = made.body.id as string;
    const taskKey = made.body.key as string;

    // Seeding an episode whose OWN taskId is this SAME task models the realistic case (§14): the
    // task was already attempted once, failed, and is being (re)claimed — the failed episode is
    // reachable from the task's own graph node via recordEpisode's `related_to` edge.
    await memory(projectId).recordEpisode(projectId, baseEpisodeInput('run_settings_throttle', {
      taskId, outcome: 'failed', filesTouched: ['apps/api/src/sync/throttle.ts'],
      failures: ['throttle timer leaked interval handles under rapid resync'],
      selfSummary: {
        approachSummary: 'tried a single shared timer for all throttle windows',
        rejectedHypotheses: [], durableLearnings: [],
        unresolvedQuestions: ['does a per-key timer avoid the leak without extra memory'],
      },
    }));

    const result = await memory(projectId).similarEffort(projectId, {
      taskId, title: 'Rework the settings sync throttle', anticipatedFiles: ['apps/api/src/sync/throttle.ts'],
    });

    expect(result.warnings).toHaveLength(1);
    const w = result.warnings[0]!;
    expect(w.taskKey).toBe(taskKey);
    expect(w.runId).toBe('run_settings_throttle');
    expect(w.outcome).toBe('failed');
    expect(w.whatWasAttempted).toBe('tried a single shared timer for all throttle windows');
    expect(w.whatFailed).toEqual(['throttle timer leaked interval handles under rapid resync']);
    expect(w.whatRemainsUncertain).toEqual(['does a per-key timer avoid the leak without extra memory']);
    // Inspectable end to end: every support entry names a real, checkable overlap.
    const kinds = new Set(w.support.map((s) => s.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(2);
    expect(w.support.some((s) => s.kind === 'shared-file' && s.detail.includes('throttle.ts'))).toBe(true);
    expect(w.support.some((s) => s.kind === 'graph-neighborhood' || s.kind === 'shared-decision')).toBe(true);
  });

  it('a coincidental single shared word never produces a warning, even though the real lexical stage finds the episode', async () => {
    const projectId = await newProject('MSE2');
    const made = await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'Overhaul', tags: ['similar-effort-test'] });
    const taskId = made.body.id as string;
    const otherTask = await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'unrelated card theming task', tags: ['similar-effort-test'] });

    // Unrelated work: shares exactly the word "Overhaul" with the new task's title and nothing
    // else — no shared file, no failure/question overlap, no graph link to THIS task.
    await memory(projectId).recordEpisode(projectId, baseEpisodeInput('run_theming', {
      taskId: otherTask.body.id as string, outcome: 'done',
      findings: [{ summary: 'Overhaul the theming variables for cards' }],
    }));

    const result = await memory(projectId).similarEffort(projectId, { taskId, title: 'Overhaul' });
    expect(result.warnings).toEqual([]);
    // It WAS considered (the lexical stage really found it) — just correctly gated out, which is
    // the whole point: the gate, not an accident of retrieval never finding it.
    expect(result.consideredCount).toBeGreaterThanOrEqual(1);
  });

  it('a failed effort ranks above an equally-matched successful one for the same query', async () => {
    const projectId = await newProject('MSE3');
    const made = await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'Migrate database connection pooling logic', tags: ['similar-effort-test'] });
    const taskId = made.body.id as string;

    await memory(projectId).recordEpisode(projectId, baseEpisodeInput('run_pool_done', {
      outcome: 'done', filesTouched: ['apps/api/src/db/pool.ts'],
      findings: [{ summary: 'Migrate database connection pooling logic to a new library' }],
    }));
    await memory(projectId).recordEpisode(projectId, baseEpisodeInput('run_pool_failed', {
      outcome: 'failed', filesTouched: ['apps/api/src/db/pool.ts'],
      findings: [{ summary: 'Migrate database connection pooling logic to a new library' }],
    }));

    const result = await memory(projectId).similarEffort(projectId, {
      taskId, title: 'Migrate database connection pooling logic', anticipatedFiles: ['apps/api/src/db/pool.ts'],
    });
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
    expect(result.warnings[0]!.outcome).toBe('failed');
    expect(result.warnings[0]!.runId).toBe('run_pool_failed');
  });

  it('is read-only: no memory row, node, edge, or revision changes as a result of a similarEffort call', async () => {
    const projectId = await newProject('MSE4');
    const made = await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'Read-only probe task', tags: ['similar-effort-test'] });
    await memory(projectId).recordEpisode(projectId, baseEpisodeInput('run_readonly', {
      taskId: made.body.id as string, outcome: 'failed', filesTouched: ['apps/api/src/x.ts'],
      failures: ['read-only probe task exploded unexpectedly'],
    }));

    const before = await memory(projectId).health(projectId);
    await memory(projectId).similarEffort(projectId, { taskId: made.body.id as string, title: 'Read-only probe task', anticipatedFiles: ['apps/api/src/x.ts'] });
    await memory(projectId).similarEffort(projectId, { taskId: made.body.id as string, title: 'Read-only probe task', anticipatedFiles: ['apps/api/src/x.ts'] });
    const after = await memory(projectId).health(projectId);

    expect(after).toEqual(before);
  });
});

// -------------------------------------------------------------------------------------------
// Layer 3 — can_claim / claim_task's `priorEffort` block (the real MCP surface)
// -------------------------------------------------------------------------------------------

describe('can_claim / claim_task — priorEffort is advisory and never touches claim outcome', () => {
  it('surfaces a fully-cited priorEffort block, and claimable/success are unaffected', async () => {
    const projectId = await newProject('MSE5');
    const made = await mcpCall(agent.apiKey, 'create_task', {
      projectId, title: 'Rework the ingest retry backoff', tags: ['similar-effort-test'],
      executionSpec: { anticipatedFiles: [{ path: 'apps/api/src/memory/ingest.ts', change: 'modify', why: 'retry backoff' }] },
    });
    const taskId = made.body.id as string;
    const taskKey = made.body.key as string;

    await memory(projectId).recordEpisode(projectId, baseEpisodeInput('run_ingest_backoff', {
      taskId, outcome: 'failed', filesTouched: ['apps/api/src/memory/ingest.ts'],
      failures: ['ingest retry backoff thundered on batch retry'],
      selfSummary: {
        approachSummary: 'tried fixed-delay retry for ingest batches',
        rejectedHypotheses: [], durableLearnings: [],
        unresolvedQuestions: ['is exponential backoff enough without jitter'],
      },
    }));

    const probe = await mcpCall(agent.apiKey, 'can_claim', { taskId });
    expect(probe.isError).toBe(false);
    expect(probe.body.claimable).toBe(true);
    expect(probe.body.priorEffort).toBeTruthy();
    expect(probe.body.priorEffort.warnings).toHaveLength(1);
    expect(probe.body.priorEffort.warnings[0]).toMatchObject({ taskKey, outcome: 'failed' });

    const claimed = await mcpCall(agent.apiKey, 'claim_task', { projectId, taskId });
    expect(claimed.isError).toBe(false);
    // The claim itself succeeded exactly as it would with no prior effort at all.
    expect(claimed.body.claimId).toBeTruthy();
    expect(claimed.body.priorEffort.warnings[0]).toMatchObject({
      taskKey, outcome: 'failed',
      whatWasAttempted: 'tried fixed-delay retry for ingest batches',
      whatFailed: ['ingest retry backoff thundered on batch retry'],
      whatRemainsUncertain: ['is exponential backoff enough without jitter'],
    });
  });

  it('carries no priorEffort block at all when nothing similar exists — absent, not empty', async () => {
    const projectId = await newProject('MSE6');
    const made = await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'A brand new task with no history whatsoever', tags: ['similar-effort-test'] });
    const taskId = made.body.id as string;

    const probe = await mcpCall(agent.apiKey, 'can_claim', { taskId });
    expect(probe.body.claimable).toBe(true);
    expect(probe.body.priorEffort).toBeUndefined();

    const claimed = await mcpCall(agent.apiKey, 'claim_task', { projectId, taskId });
    expect(claimed.isError).toBe(false);
    expect(claimed.body.priorEffort).toBeUndefined();
  });
});

describe('loadPriorEffort — degrades to null (never throws) when ProjectMemory is unreachable (§19)', () => {
  it('swallows a thrown error from the DO stub and returns null', async () => {
    const throwingEnv = {
      PROJECT_MEMORY: {
        idFromName: () => 'fake',
        get: () => ({ similarEffort: async () => { throw new Error('ProjectMemory unreachable (test)'); } }),
      },
    } as unknown as Env;
    const result = await loadPriorEffort(throwingEnv, 'prj_fake', { id: 'task_fake', title: 'x', body: null, executionSpec: null });
    expect(result).toBeNull();
  });
});
