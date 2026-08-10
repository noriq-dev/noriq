import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { exportSnapshot } from '../src/backup';
import type { Actor } from '../src/do/ProjectRoom';
import {
  getSimilarityCalibration, type ObserveSimilarEffortInput, type OccurrenceCase,
  type RecordSimilarityFeedbackInput,
} from '../src/memory/similarity-feedback';
import {
  priorEffortCase, type DuplicateWarning, type EffortCandidate, type PriorEffortCase,
} from '../src/memory/similar-effort';
import { createAgent, mcpCall } from './helpers';

const appEnv = env as unknown as Env;
const human: Actor = { kind: 'human', id: 'usr_similarity_feedback', name: 'Similarity Feedback' };

interface MemoryRpc {
  health(projectId: string): Promise<{ memoryRevision: number; tableCounts: Record<string, number> }>;
  runProjector(projectId: string): Promise<{ applied: number }>;
  recordMemory(projectId: string, input: {
    kind: string; statement: string; actor: { kind: string; id: string | null };
  }): Promise<{ memoryId: string }>;
  getMemoryItem(projectId: string, memoryId: string): Promise<Record<string, unknown> | null>;
  recordEpisode(projectId: string, input: Record<string, unknown>): Promise<{ episodeId: string }>;
}
interface RoomRpc {
  deleteProject(projectId: string, actor: Actor): Promise<{ ok: true }>;
  observeSimilarEffortCases(projectId: string, input: ObserveSimilarEffortInput): Promise<OccurrenceCase[]>;
  recordSimilarityFeedback(projectId: string, actor: Actor, input: RecordSimilarityFeedbackInput): Promise<{
    feedbackId: string; operationKey: string; deduped: boolean; supersedesFeedbackId: string | null;
  }>;
}
const memory = (projectId: string) => appEnv.PROJECT_MEMORY.get(
  appEnv.PROJECT_MEMORY.idFromName(projectId),
) as unknown as MemoryRpc;
const room = (projectId: string) => appEnv.PROJECT_ROOM.get(
  appEnv.PROJECT_ROOM.idFromName(projectId),
) as unknown as RoomRpc;

let agent: { id: string; apiKey: string };
beforeAll(async () => { agent = await createAgent('similarity-feedback-agent'); }, 60_000);

async function newProject(key: string): Promise<string> {
  const result = await mcpCall(agent.apiKey, 'create_project', { key, name: `${key} similarity feedback` });
  if (result.isError) throw new Error(result.text);
  return result.body.id as string;
}

function historicalCase(episodeId: string, runId: string, supportKinds = ['shared-file', 'shared-failure-signature']): PriorEffortCase {
  const candidate: EffortCandidate = {
    episodeId, runId, taskId: null, taskKey: null, runKind: 'build', outcome: 'done',
    landingOutcome: 'landed', filesTouched: ['apps/api/src/cache.ts'], failures: [], findings: [],
    approachSummary: 'bounded cache repair', unresolvedQuestions: [], reviewRounds: 0, costUSD: 0,
    tokenUsage: {}, startedAt: null, finishedAt: null, stage: 'lexical', score: 1, sitting: 1,
  };
  const warning: DuplicateWarning = {
    episodeId, runId, taskId: null, taskKey: null, runKind: 'build', outcome: 'done',
    landingOutcome: 'landed', whatWasAttempted: 'bounded cache repair', whatFailed: [],
    whatRemainsUncertain: [], score: 1,
    support: supportKinds.map((kind, index) => ({
      kind: kind as DuplicateWarning['support'][number]['kind'], detail: `support-${index}`,
    })),
  };
  return priorEffortCase(candidate, warning);
}

async function observe(
  projectId: string,
  taskId: string,
  cases: PriorEffortCase[],
  observedAt = '2026-08-09T00:00:00.000Z',
) {
  return room(projectId).observeSimilarEffortCases(projectId, {
    task: { id: taskId, title: 'Repair bounded cache invalidation', body: 'Avoid stale cache reuse.', executionSpec: null },
    policy: { repositoryKey: 'repo-a', branch: 'main', preferBranch: 'main', baseId: 'base-a' },
    pageOffset: 0, cases, observedAt,
  });
}

const record = (projectId: string, input: RecordSimilarityFeedbackInput) =>
  room(projectId).recordSimilarityFeedback(projectId, human, input);

describe('similar-effort occurrence feedback (PLNR-299)', () => {
  it('records not_similar separately while leaving the episode and memory byte-identical', async () => {
    const projectId = await newProject('SEF1');
    const task = await mcpCall(agent.apiKey, 'create_task', {
      projectId, title: 'Repair bounded cache invalidation', tags: ['similarity-feedback-test'],
    });
    const recorded = await memory(projectId).recordMemory(projectId, {
      kind: 'failed_approach', statement: 'Cache invalidation reused a stale generation.',
      actor: { kind: 'agent', id: agent.id },
    });
    const episode = await memory(projectId).recordEpisode(projectId, {
      runId: 'run_sef_1', sitting: 1, agentId: agent.id, runKind: 'build', outcome: 'done',
      startedAt: null, finishedAt: null, taskId: task.body.id, repositoryKey: 'repo-a', baseId: 'base-a',
      timeline: [], filesTouched: ['apps/api/src/cache.ts'], commands: [], testsRun: [], failures: [],
      findings: [{ summary: 'Repair bounded cache invalidation' }], reviewRounds: 0, tokenUsage: {},
      costUSD: 0, acceptanceCoverage: null, steeringEvents: [], landingOutcome: 'landed',
      remainingWork: [], actor: { kind: 'agent', id: agent.id },
    });
    await memory(projectId).runProjector(projectId);
    const beforeHealth = await memory(projectId).health(projectId);
    const beforeMemory = await memory(projectId).getMemoryItem(projectId, recorded.memoryId);
    const [surfaced] = await observe(projectId, task.body.id as string, [historicalCase(episode.episodeId, 'run_sef_1')]);
    expect(surfaced!.occurrence).toMatchObject({
      queryContextFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      queryContextClass: 'repository_scoped|branch_exact|base_scoped|active_evidence',
      retrievalVersion: 'similar-effort-v1', rank: 1,
    });
    await record(projectId, {
      operationKey: 'judge-sef-1', occurrenceId: surfaced!.occurrence.id,
      judgment: 'not_similar', reasonCode: 'different_task_shape', reason: 'Same file, different operation.',
    });
    expect(await memory(projectId).health(projectId)).toEqual(beforeHealth);
    expect(await memory(projectId).getMemoryItem(projectId, recorded.memoryId)).toEqual(beforeMemory);
    const occurrence = await appEnv.DB.prepare(
      'SELECT candidate_episode_id AS episodeId FROM similar_effort_occurrences WHERE id = ?',
    ).bind(surfaced!.occurrence.id).first<{ episodeId: string }>();
    expect(occurrence?.episodeId).toBe(episode.episodeId);
  });

  it('deduplicates operation replay and appends only explicit superseding judgments', async () => {
    const projectId = await newProject('SEF2');
    const task = await mcpCall(agent.apiKey, 'create_task', {
      projectId, title: 'Repair bounded cache invalidation', tags: ['similarity-feedback-test'],
    });
    const [surfaced] = await observe(projectId, task.body.id as string, [historicalCase('epi_sef_2', 'run_sef_2')]);
    const first = await record(projectId, {
      operationKey: 'judge-sef-2', occurrenceId: surfaced!.occurrence.id,
      judgment: 'not_similar', reasonCode: 'branch_revision_mismatch',
    });
    const replay = await record(projectId, {
      operationKey: 'judge-sef-2', occurrenceId: surfaced!.occurrence.id,
      judgment: 'not_similar', reasonCode: 'branch_revision_mismatch',
    });
    expect(replay).toMatchObject({ feedbackId: first.feedbackId, deduped: true });
    await expect(record(projectId, {
      operationKey: 'judge-sef-2-conflict', occurrenceId: surfaced!.occurrence.id, judgment: 'relevant',
    })).rejects.toThrow('explicitly supersede');
    const later = await record(projectId, {
      operationKey: 'judge-sef-2-later', occurrenceId: surfaced!.occurrence.id,
      judgment: 'partially_relevant', supersedesFeedbackId: first.feedbackId,
    });
    expect(later.supersedesFeedbackId).toBe(first.feedbackId);
    const rows = await appEnv.DB.prepare(
      'SELECT judgment, supersedes_feedback_id AS supersedes FROM similar_effort_feedback WHERE project_id = ? ORDER BY created_at, id',
    ).bind(projectId).all<{ judgment: string; supersedes: string | null }>();
    expect(rows.results).toEqual(expect.arrayContaining([
      { judgment: 'not_similar', supersedes: null },
      { judgment: 'partially_relevant', supersedes: first.feedbackId },
    ]));
  });

  it('calibrates judged precision without treating unjudged cases as negative', async () => {
    const projectId = await newProject('SEF3');
    const task = await mcpCall(agent.apiKey, 'create_task', {
      projectId, title: 'Repair bounded cache invalidation', tags: ['similarity-feedback-test'],
    });
    const surfaced = await observe(projectId, task.body.id as string, [
      historicalCase('epi_sef_3a', 'run_sef_3a'), historicalCase('epi_sef_3b', 'run_sef_3b'),
      historicalCase('epi_sef_3c', 'run_sef_3c'),
    ]);
    await record(projectId, {
      operationKey: 'judge-sef-3a', occurrenceId: surfaced[0]!.occurrence.id,
      judgment: 'relevant', reasonCode: 'other',
    });
    await record(projectId, {
      operationKey: 'judge-sef-3b', occurrenceId: surfaced[1]!.occurrence.id,
      judgment: 'not_similar', reasonCode: 'branch_revision_mismatch',
    });
    // Simulate the next deployed retriever over the same visible context without mutating an
    // earlier occurrence; version is occurrence evidence, so direct seeding is intentional.
    await appEnv.DB.prepare(
      `INSERT INTO similar_effort_occurrences
       SELECT 'seo_sef_v2', project_id, task_id, query_context_fingerprint, query_context_class,
              'similar-effort-v2', support_combination, repository_key, branch_filter,
              preferred_branch, base_id, 'epi_sef_v2', 'run_sef_v2', 1, 1, observed_at
         FROM similar_effort_occurrences WHERE id = ?`,
    ).bind(surfaced[0]!.occurrence.id).run();
    await record(projectId, {
      operationKey: 'judge-sef-v2', occurrenceId: 'seo_sef_v2',
      judgment: 'partially_relevant', reasonCode: 'different_task_shape',
    });
    const calibration = await getSimilarityCalibration(appEnv, projectId, { topK: 10 });
    const v1 = calibration.groups.find((group) => group.retrievalVersion === 'similar-effort-v1')!;
    expect(v1).toMatchObject({
      surfaced: 3, judged: 2, unjudged: 1, responseRate: 2 / 3,
      judgedPrecision: { numerator: 1, denominator: 2, rate: 0.5 },
      reasons: { other: 1, branch_revision_mismatch: 1 },
    });
    expect(calibration.groups.find((group) => group.retrievalVersion === 'similar-effort-v2')).toMatchObject({
      judgedPrecision: { numerator: 0.5, denominator: 1, rate: 0.5 },
      reasons: { different_task_shape: 1 },
    });
    expect(calibration.versionChanges).toEqual([expect.objectContaining({
      fromVersion: 'similar-effort-v1', toVersion: 'similar-effort-v2', judgedPrecisionDelta: 0,
    })]);
  });

  it('rides the D1 logical snapshot and is erased with its owning project', async () => {
    const projectId = await newProject('SEF4');
    const task = await mcpCall(agent.apiKey, 'create_task', {
      projectId, title: 'Repair bounded cache invalidation', tags: ['similarity-feedback-test'],
    });
    const [surfaced] = await observe(projectId, task.body.id as string, [historicalCase('epi_sef_4', 'run_sef_4')]);
    await record(projectId, {
      operationKey: 'judge-sef-4', occurrenceId: surfaced!.occurrence.id, judgment: 'relevant',
    });
    const snapshot = await exportSnapshot(appEnv, '2026-08-09T01:00:00.000Z');
    expect(snapshot.tables.similar_effort_occurrences).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: surfaced!.occurrence.id, project_id: projectId }),
    ]));
    expect(snapshot.tables.similar_effort_feedback).toEqual(expect.arrayContaining([
      expect.objectContaining({ occurrence_id: surfaced!.occurrence.id, project_id: projectId }),
    ]));
    await room(projectId).deleteProject(projectId, human);
    expect((await appEnv.DB.prepare(
      'SELECT COUNT(*) AS n FROM similar_effort_occurrences WHERE project_id = ?',
    ).bind(projectId).first<{ n: number }>())?.n).toBe(0);
    expect((await appEnv.DB.prepare(
      'SELECT COUNT(*) AS n FROM similar_effort_feedback WHERE project_id = ?',
    ).bind(projectId).first<{ n: number }>())?.n).toBe(0);
  });
});
