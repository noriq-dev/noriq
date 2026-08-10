// PLNR-299: case-retrieval calibration. This is an evidence ledger about a particular
// similar-effort result occurrence, not feedback on the episode or on ProjectMemory content.
import type { Env } from '../env';
import { newId, nowIso, sha256Hex } from '../lib/util';
import type { PriorEffortCase } from './similar-effort';

export const SIMILARITY_JUDGMENTS = ['relevant', 'partially_relevant', 'not_similar'] as const;
export type SimilarityJudgment = typeof SIMILARITY_JUDGMENTS[number];
export const SIMILARITY_REASON_CODES = [
  'wrong_subsystem', 'superficial_wording', 'different_task_shape', 'outdated_implementation',
  'branch_revision_mismatch', 'duplicate_case', 'other',
] as const;
export type SimilarityReasonCode = typeof SIMILARITY_REASON_CODES[number];

export interface SimilarEffortOccurrence {
  id: string;
  observedAt: string;
  queryContextFingerprint: string;
  queryContextClass: string;
  retrievalVersion: string;
  supportCombination: string[];
  repositoryKey: string | null;
  branchFilter: string | null;
  preferredBranch: string | null;
  baseId: string | null;
  rank: number;
}

export interface OccurrenceCase extends PriorEffortCase {
  occurrence: SimilarEffortOccurrence;
}

export interface ObserveSimilarEffortInput {
  task: { id: string; title: string; body: string | null; executionSpec: string | null };
  policy: {
    repositoryKey?: string; branch?: string; preferBranch?: string; baseId?: string;
    includeCrossBranch?: boolean; includeStaleEvidence?: boolean;
  };
  pageOffset: number;
  cases: PriorEffortCase[];
  observedAt?: string;
}

const canonical = (value: unknown): string => JSON.stringify(value);
const contextClass = (policy: ObserveSimilarEffortInput['policy']): string => [
  policy.repositoryKey ? 'repository_scoped' : 'repository_unspecified',
  policy.branch ? (policy.includeCrossBranch ? 'branch_exact_plus_cross' : 'branch_exact')
    : policy.preferBranch ? 'branch_preferred' : 'branch_unspecified',
  policy.baseId ? 'base_scoped' : 'base_unspecified',
  policy.includeStaleEvidence ? 'stale_opt_in' : 'active_evidence',
].join('|');

/** Persist every case shown by the human REST retrieval as its own immutable occurrence. The
 * ProjectMemory/claim path remains read-only; only this explicit human surface produces rows. */
export async function observeSimilarEffortCases(
  env: Env,
  projectId: string,
  input: ObserveSimilarEffortInput,
): Promise<OccurrenceCase[]> {
  if (!input.cases.length) return [];
  const observedAt = input.observedAt ?? nowIso();
  const queryContextFingerprint = await sha256Hex(canonical({
    task: input.task,
    policy: {
      repositoryKey: input.policy.repositoryKey ?? null,
      branch: input.policy.branch ?? null,
      preferBranch: input.policy.preferBranch ?? null,
      baseId: input.policy.baseId ?? null,
      includeCrossBranch: input.policy.includeCrossBranch === true,
      includeStaleEvidence: input.policy.includeStaleEvidence === true,
    },
  }));
  const queryContextClass = contextClass(input.policy);
  const rows = input.cases.map((item, index): OccurrenceCase => {
    const supportCombination = [...new Set(item.retrieval.support.map((support) => support.kind))].sort();
    const occurrence: SimilarEffortOccurrence = {
      id: newId('seo'), observedAt, queryContextFingerprint, queryContextClass,
      retrievalVersion: item.retrieval.version, supportCombination,
      repositoryKey: input.policy.repositoryKey ?? null,
      branchFilter: input.policy.branch ?? null,
      preferredBranch: input.policy.preferBranch ?? null,
      baseId: input.policy.baseId ?? null,
      rank: input.pageOffset + index + 1,
    };
    return { ...item, occurrence };
  });
  await env.DB.batch(rows.map((item) => env.DB.prepare(
    `INSERT INTO similar_effort_occurrences
       (id, project_id, task_id, query_context_fingerprint, query_context_class,
        retrieval_version, support_combination, repository_key, branch_filter, preferred_branch,
        base_id, candidate_episode_id, candidate_run_id, candidate_sitting, rank, observed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    item.occurrence.id, projectId, input.task.id, item.occurrence.queryContextFingerprint,
    item.occurrence.queryContextClass, item.occurrence.retrievalVersion,
    canonical(item.occurrence.supportCombination), item.occurrence.repositoryKey,
    item.occurrence.branchFilter, item.occurrence.preferredBranch, item.occurrence.baseId,
    item.episodeId, item.runId, item.sitting, item.occurrence.rank, observedAt,
  )));
  return rows;
}

export class SimilarityFeedbackError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) { super(message); }
}

export interface RecordSimilarityFeedbackInput {
  operationKey: string;
  occurrenceId: string;
  judgment: SimilarityJudgment;
  reasonCode?: SimilarityReasonCode | null;
  reason?: string | null;
  supersedesFeedbackId?: string | null;
}

export async function recordSimilarityFeedback(
  env: Env,
  projectId: string,
  actorUserId: string,
  input: RecordSimilarityFeedbackInput,
): Promise<{ feedbackId: string; operationKey: string; deduped: boolean; supersedesFeedbackId: string | null }> {
  const operationKey = input.operationKey.trim();
  if (!operationKey || operationKey.length > 200) throw new SimilarityFeedbackError('operationKey must be 1-200 characters');
  if (!SIMILARITY_JUDGMENTS.includes(input.judgment)) throw new SimilarityFeedbackError('invalid judgment');
  if (input.reasonCode && !SIMILARITY_REASON_CODES.includes(input.reasonCode)) throw new SimilarityFeedbackError('invalid reasonCode');
  if ((input.reason?.length ?? 0) > 2_000) throw new SimilarityFeedbackError('reason must be at most 2000 characters');

  const occurrence = await env.DB.prepare(
    'SELECT id FROM similar_effort_occurrences WHERE id = ? AND project_id = ?',
  ).bind(input.occurrenceId, projectId).first<{ id: string }>();
  if (!occurrence) throw new SimilarityFeedbackError('retrieval occurrence not found', 404);
  const canonicalInput = {
    occurrenceId: input.occurrenceId, judgment: input.judgment,
    reasonCode: input.reasonCode ?? null, reason: input.reason?.trim() || null,
    supersedesFeedbackId: input.supersedesFeedbackId ?? null, actorUserId,
  };
  const operationFingerprint = await sha256Hex(canonical(canonicalInput));
  const existing = await env.DB.prepare(
    `SELECT id, operation_fingerprint AS fingerprint, supersedes_feedback_id AS supersedesFeedbackId
       FROM similar_effort_feedback WHERE project_id = ? AND operation_key = ?`,
  ).bind(projectId, operationKey).first<{ id: string; fingerprint: string; supersedesFeedbackId: string | null }>();
  if (existing) {
    if (existing.fingerprint !== operationFingerprint) {
      throw new SimilarityFeedbackError('operationKey already used with different feedback', 409);
    }
    return { feedbackId: existing.id, operationKey, deduped: true, supersedesFeedbackId: existing.supersedesFeedbackId };
  }

  if (input.supersedesFeedbackId) {
    const superseded = await env.DB.prepare(
      `SELECT f.id FROM similar_effort_feedback f
        WHERE f.id = ? AND f.project_id = ? AND f.occurrence_id = ?
          AND NOT EXISTS (SELECT 1 FROM similar_effort_feedback later WHERE later.supersedes_feedback_id = f.id)`,
    ).bind(input.supersedesFeedbackId, projectId, input.occurrenceId).first<{ id: string }>();
    if (!superseded) throw new SimilarityFeedbackError('supersedesFeedbackId is not the current judgment for this occurrence', 409);
  } else {
    const prior = await env.DB.prepare(
      'SELECT id FROM similar_effort_feedback WHERE project_id = ? AND occurrence_id = ? LIMIT 1',
    ).bind(projectId, input.occurrenceId).first<{ id: string }>();
    if (prior) throw new SimilarityFeedbackError('a later judgment must explicitly supersede the current feedback', 409);
  }

  const feedbackId = newId('sef');
  await env.DB.prepare(
    `INSERT INTO similar_effort_feedback
       (id, project_id, operation_key, operation_fingerprint, occurrence_id, judgment,
        reason_code, reason, actor_user_id, supersedes_feedback_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    feedbackId, projectId, operationKey, operationFingerprint, input.occurrenceId, input.judgment,
    input.reasonCode ?? null, input.reason?.trim() || null, actorUserId,
    input.supersedesFeedbackId ?? null, nowIso(),
  ).run();
  return { feedbackId, operationKey, deduped: false, supersedesFeedbackId: input.supersedesFeedbackId ?? null };
}

type OccurrenceRow = {
  id: string; queryContextClass: string; retrievalVersion: string; supportCombination: string;
  rank: number; observedAt: string;
};
type FeedbackRow = {
  id: string; occurrenceId: string; judgment: SimilarityJudgment; reasonCode: SimilarityReasonCode | null;
  supersedesFeedbackId: string | null; createdAt: string;
};

export interface SimilarityCalibrationGroup {
  retrievalVersion: string;
  supportCombination: string[];
  queryContextClass: string;
  surfaced: number;
  judged: number;
  unjudged: number;
  responseRate: number;
  judgedPrecision: { numerator: number; denominator: number; rate: number | null; partialWeight: 0.5 };
  judgments: Record<SimilarityJudgment, number>;
  reasons: Record<string, number>;
}

/** Bounded calibration over retrieval occurrences. Only leaf judgments count; absence remains
 * unjudged and is excluded from the precision denominator while remaining visible in response. */
export async function getSimilarityCalibration(
  env: Env,
  projectId: string,
  input: { topK?: number; from?: string; to?: string; limit?: number } = {},
): Promise<{
  observedAt: string; topK: number; groups: SimilarityCalibrationGroup[];
  versionChanges: Array<{ fromVersion: string; toVersion: string; judgedPrecisionDelta: number | null; responseRateDelta: number }>;
  coverage: { complete: boolean; occurrencesScanned: number; limit: number; reasons: string[] };
}> {
  const topK = Math.min(Math.max(Math.trunc(input.topK ?? 10), 1), 50);
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 2_000), 1), 5_000);
  const clauses = ['project_id = ?', 'rank <= ?'];
  const binds: Array<string | number> = [projectId, topK];
  if (input.from) { clauses.push('observed_at >= ?'); binds.push(input.from); }
  if (input.to) { clauses.push('observed_at < ?'); binds.push(input.to); }
  const occurrenceResult = await env.DB.prepare(
    `SELECT id, query_context_class AS queryContextClass, retrieval_version AS retrievalVersion,
            support_combination AS supportCombination, rank, observed_at AS observedAt
       FROM similar_effort_occurrences WHERE ${clauses.join(' AND ')}
       ORDER BY observed_at, id LIMIT ${limit + 1}`,
  ).bind(...binds).all<OccurrenceRow>();
  const truncated = occurrenceResult.results.length > limit;
  const occurrences = occurrenceResult.results.slice(0, limit);
  const occurrenceIds = new Set(occurrences.map((row) => row.id));
  const feedbackResult = await env.DB.prepare(
    `SELECT f.id, f.occurrence_id AS occurrenceId, f.judgment, f.reason_code AS reasonCode,
            f.supersedes_feedback_id AS supersedesFeedbackId, f.created_at AS createdAt
       FROM similar_effort_feedback f JOIN similar_effort_occurrences o ON o.id = f.occurrence_id
      WHERE o.project_id = ? ORDER BY f.created_at, f.id LIMIT 10001`,
  ).bind(projectId).all<FeedbackRow>();
  const feedbackTruncated = feedbackResult.results.length > 10_000;
  const feedback = feedbackResult.results.slice(0, 10_000).filter((row) => occurrenceIds.has(row.occurrenceId));
  const supersededIds = new Set(feedback.map((row) => row.supersedesFeedbackId).filter((id): id is string => !!id));
  const latestByOccurrence = new Map(feedback.filter((row) => !supersededIds.has(row.id)).map((row) => [row.occurrenceId, row]));
  const groups = new Map<string, SimilarityCalibrationGroup>();
  for (const row of occurrences) {
    const support = JSON.parse(row.supportCombination) as string[];
    const key = canonical([row.retrievalVersion, support, row.queryContextClass]);
    let group = groups.get(key);
    if (!group) {
      group = {
        retrievalVersion: row.retrievalVersion, supportCombination: support,
        queryContextClass: row.queryContextClass, surfaced: 0, judged: 0, unjudged: 0,
        responseRate: 0, judgedPrecision: { numerator: 0, denominator: 0, rate: null, partialWeight: 0.5 },
        judgments: { relevant: 0, partially_relevant: 0, not_similar: 0 }, reasons: {},
      };
      groups.set(key, group);
    }
    group.surfaced++;
    const judgment = latestByOccurrence.get(row.id);
    if (!judgment) { group.unjudged++; continue; }
    group.judged++;
    group.judgments[judgment.judgment]++;
    group.judgedPrecision.denominator++;
    if (judgment.judgment === 'relevant') group.judgedPrecision.numerator += 1;
    else if (judgment.judgment === 'partially_relevant') group.judgedPrecision.numerator += 0.5;
    if (judgment.reasonCode) group.reasons[judgment.reasonCode] = (group.reasons[judgment.reasonCode] ?? 0) + 1;
  }
  const groupList = [...groups.values()].sort((a, b) => (
    a.retrievalVersion.localeCompare(b.retrievalVersion)
    || a.queryContextClass.localeCompare(b.queryContextClass)
    || canonical(a.supportCombination).localeCompare(canonical(b.supportCombination))
  ));
  for (const group of groupList) {
    group.responseRate = group.surfaced ? group.judged / group.surfaced : 0;
    group.judgedPrecision.rate = group.judgedPrecision.denominator
      ? group.judgedPrecision.numerator / group.judgedPrecision.denominator : null;
  }
  const versions = new Map<string, { surfaced: number; judged: number; numerator: number }>();
  for (const group of groupList) {
    const total = versions.get(group.retrievalVersion) ?? { surfaced: 0, judged: 0, numerator: 0 };
    total.surfaced += group.surfaced; total.judged += group.judged; total.numerator += group.judgedPrecision.numerator;
    versions.set(group.retrievalVersion, total);
  }
  const versionList = [...versions.entries()].sort(([a], [b]) => a.localeCompare(b));
  const versionChanges = versionList.slice(1).map(([toVersion, to], index) => {
    const [fromVersion, from] = versionList[index]!;
    const fromPrecision = from.judged ? from.numerator / from.judged : null;
    const toPrecision = to.judged ? to.numerator / to.judged : null;
    return {
      fromVersion, toVersion,
      judgedPrecisionDelta: fromPrecision == null || toPrecision == null ? null : toPrecision - fromPrecision,
      responseRateDelta: (to.surfaced ? to.judged / to.surfaced : 0) - (from.surfaced ? from.judged / from.surfaced : 0),
    };
  });
  const reasons = [
    ...(truncated ? [`occurrence scan exceeded ${limit} rows`] : []),
    ...(feedbackTruncated ? ['feedback scan exceeded 10000 rows'] : []),
  ];
  return {
    observedAt: nowIso(), topK, groups: groupList, versionChanges,
    coverage: { complete: reasons.length === 0, occurrencesScanned: occurrences.length, limit, reasons },
  };
}
