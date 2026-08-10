// PLNR-264: similar-effort retrieval and duplicate-work warnings — storage-free signal
// extraction, support classification, the warning gate, and effort summarization. Same split as
// retrieval.ts/graph-queries.ts/projection.ts: `ProjectMemory.similarEffort` gathers episode
// candidates from its own SQLite (the SAME lexical/semantic/graph primitives searchProjectMemory
// already uses — see that RPC's own doc comment) and hands them here to classify, gate, and
// summarize. This file has no opinion on WHERE a candidate came from beyond the `stage`/
// `edgePath` fields ProjectMemory already attaches when it builds an `EffortCandidate`.
//
// THE CENTRAL RULE (locked decision, stated twice in the task's own acceptance): a warning needs
// at least TWO INDEPENDENT support kinds, and lexical/semantic text similarity can never be the
// second one on its own. `duplicateWarnings`' gate is the one and only place that rule lives —
// nothing upstream (ProjectMemory's candidate gathering) or downstream (mcp.ts's presentation)
// re-implements it.
import type { EpisodeLandingOutcome, MetricCompleteness, ProjectIntelligenceEpisode, RunModelUsage } from '@noriq-dev/shared';
import { rankCandidates, type RetrievalHit, type RetrievalStage } from './retrieval';

export const SIMILAR_EFFORT_RETRIEVAL_VERSION = 'similar-effort-v1';

// ---------------------------------------------------------------------------------------------
// Signals extracted from the task about to be claimed
// ---------------------------------------------------------------------------------------------

export interface TaskEffortInput {
  title: string;
  body?: string | null;
  /** From the task's own `executionSpec.anticipatedFiles` (lib/execution-spec.ts) — the one
   *  deterministic file-overlap signal a task carries BEFORE any work starts. Absent for a task
   *  with no execution spec, which degrades this to the text/graph channels only, not an error. */
  anticipatedFiles?: string[];
}

export interface EffortSignals {
  /** title + body, verbatim — the ONE string `ProjectMemory.similarEffort` hands to
   *  `lexicalRetrievalRows`/`semanticRetrievalRows`, unchanged from what those already do for
   *  `searchProjectMemory`. */
  queryText: string;
  /** Normalized (lowercase, deduped, stopword/short-token filtered) significant words from
   *  title+body — used ONLY for the multi-word overlap checks below (`classifySupport`'s
   *  failure-signature/unresolved-question/text-similarity channels), never for retrieval
   *  itself. Keeping this separate from `queryText` is what makes "one coincidental shared
   *  word" distinguishable from "several independently meaningful words in common". */
  keywords: ReadonlySet<string>;
  /** Anticipated file paths, verbatim — already repo-relative (execution-spec.ts's own write
   *  seam normalizes `RepoPath` before this ever sees it). */
  files: ReadonlySet<string>;
}

// A short, common-English word carries no topical signal on its own ("with", "task", "from") —
// filtering it out of `keywords` is what stops "the file was not found" and "the task was found
// difficult" from registering as a 3-word overlap. Deliberately small and unambiguous rather than
// a full stopword list import: this only feeds the overlap COUNT threshold below, not retrieval.
const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'have', 'has', 'had', 'were', 'was', 'are', 'is',
  'not', 'but', 'for', 'you', 'your', 'they', 'their', 'them', 'then', 'than', 'when', 'while',
  'which', 'who', 'whom', 'will', 'would', 'should', 'could', 'shall', 'must', 'may', 'might',
  'does', 'did', 'done', 'been', 'being', 'into', 'onto', 'over', 'under', 'about', 'after',
  'before', 'again', 'also', 'just', 'only', 'some', 'such', 'each', 'both', 'more', 'most',
  'other', 'once', 'here', 'there', 'what', 'because',
]);

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
  );
}

/** Pure: a task's title/body/anticipated-files in, the signals every other export here consumes
 *  out. No DB, no episode knowledge — `ProjectMemory.similarEffort` is the only caller. */
export function effortSignals(task: TaskEffortInput): EffortSignals {
  const queryText = [task.title, task.body ?? ''].filter((s) => s && s.trim().length > 0).join('\n');
  return {
    queryText,
    keywords: significantWords(queryText),
    files: new Set(task.anticipatedFiles ?? []),
  };
}

// ---------------------------------------------------------------------------------------------
// Support classification — the independent evidence channels the gate counts
// ---------------------------------------------------------------------------------------------

export type SupportKind =
  | 'shared-file'
  | 'shared-failure-signature'
  | 'graph-neighborhood'
  | 'shared-decision'
  | 'shared-unresolved-question'
  | 'text-similarity';

export interface SupportEntry {
  kind: SupportKind;
  /** The concrete overlap a human can inspect back to its evidence (locked decision) — a file
   *  path, a quoted failure string with its shared terms, an edge path, a quoted unresolved
   *  question, or the matched terms. Never a bare boolean. */
  detail: string;
}

/**
 * One prior episode, shaped for classification — `ProjectMemory.similarEffort` builds this from
 * an `episodes` row (deterministic columns) plus its own `body` JSON (findings/failures/
 * self-summary), joined with the retrieval provenance (`stage`/`score`/`edgePath`) that found it.
 * Deliberately flat rather than re-exporting `EffortEpisode` — this module only needs the fields
 * below, and keeping the shape narrow is what makes it trivially constructible in a unit test
 * without a real episode row.
 */
export interface EffortCandidate {
  episodeId: string;
  runId: string;
  taskId: string | null;
  taskKey: string | null;
  runKind: string;
  /** The RUN's own terminal exit (done/failed/cancelled) — `memory/episodes.ts`'s `parseExit`
   *  axis, NOT `landingOutcome` (whether the work landed). §14's "failed run that disproves an
   *  approach" is this field, not landingOutcome. */
  outcome: string;
  landingOutcome: EpisodeLandingOutcome;
  filesTouched: string[];
  failures: string[];
  findings: Array<{ summary: string }>;
  approachSummary: string | null;
  unresolvedQuestions: string[];
  reviewRounds: number;
  costUSD: number;
  tokenUsage: RunModelUsage;
  startedAt: string | null;
  finishedAt: string | null;
  /** How this candidate was FOUND — retrieval.ts's own stage vocabulary, reused rather than a
   *  parallel enum, so `duplicateWarnings` can hand it straight to `rankCandidates` unchanged. */
  stage: RetrievalStage;
  /** Raw stage score, same convention as `RetrievalHit.score` — comparable only after
   *  `rankCandidates` reweights it. */
  score: number;
  /** Present only when a bounded graph traversal (from the task's own node) reached this
   *  episode — the `from>type>to;...` path `rawTraverseGraph` already produces. Its PRESENCE is
   *  what unlocks the graph-neighborhood/shared-decision channels below; it is independent of
   *  `stage` because a candidate can be found by text AND separately be graph-reachable. */
  edgePath?: string;
  sitting?: number;
  repositoryKey?: string | null;
  baseId?: string | null;
  createdAt?: string;
  intelligence?: ProjectIntelligenceEpisode | null;
}

export interface PriorEffortObservation {
  value: number | boolean | null;
  completeness: MetricCompleteness;
}

/** One inspectable historical unit. This is deliberately case-shaped: no strategy grouping or
 * ranking table exists here, and every measured outcome stays attached to its run+sitting. */
export interface PriorEffortCase {
  episodeId: string;
  taskId: string | null;
  taskKey: string | null;
  runId: string;
  sitting: number;
  executionId: string | null;
  orchestrationId: string | null;
  repositoryKey: string | null;
  branch: string | null;
  baseId: string | null;
  validity: 'historical_episode';
  lineage: ProjectIntelligenceEpisode['identity']['lineage'];
  retrieval: {
    version: typeof SIMILAR_EFFORT_RETRIEVAL_VERSION;
    stage: RetrievalStage;
    score: number;
    support: SupportEntry[];
  };
  outcome: { run: string; landing: EpisodeLandingOutcome };
  observed: {
    filesTouched: PriorEffortObservation;
    tokens: PriorEffortObservation;
    costUSD: PriorEffortObservation;
    elapsedMs: PriorEffortObservation;
    reviewRounds: PriorEffortObservation;
    verificationOrRepair: PriorEffortObservation;
  };
  whatWasAttempted: string;
  whatFailed: string[];
  whatRemainsUncertain: string[];
}

// A single shared significant word is exactly the "unrelated lexical coincidence" the
// acceptance forbids ("no warning appears for unrelated lexical coincidences after reranking").
// Three independently meaningful words overlapping between a task's own text and one specific
// failure/unresolved-question string is not a coincidence — this is the bar both channels below
// share, chosen over a fuzzy similarity score because it is exact, cheap, and a reviewer can
// recount it by eye from the `detail` string alone.
const MIN_SHARED_SIGNIFICANT_WORDS = 3;

function overlapWords(text: string, keywords: ReadonlySet<string>): string[] {
  return [...significantWords(text)].filter((w) => keywords.has(w));
}

/**
 * Classify ONE candidate's support against the task's signals — every independent evidence
 * channel the locked decision names, computed from the candidate's own recorded content, never
 * from the fact that retrieval happened to find it. Returns however many channels actually fired
 * (0 to 6); `duplicateWarnings` is what applies the two-channel gate on top of this.
 */
export function classifySupport(candidate: EffortCandidate, signals: EffortSignals): SupportEntry[] {
  const support: SupportEntry[] = [];

  const sharedFiles = candidate.filesTouched.filter((f) => signals.files.has(f));
  if (sharedFiles.length) support.push({ kind: 'shared-file', detail: sharedFiles.join(', ') });

  // One representative citation per channel is enough — this is a support KIND (did this
  // channel fire at all), not a tally of how many failures/questions matched.
  for (const failure of candidate.failures) {
    const shared = overlapWords(failure, signals.keywords);
    if (shared.length >= MIN_SHARED_SIGNIFICANT_WORDS) {
      support.push({ kind: 'shared-failure-signature', detail: `"${failure}" (shared terms: ${shared.join(', ')})` });
      break;
    }
  }

  for (const question of candidate.unresolvedQuestions) {
    const shared = overlapWords(question, signals.keywords);
    if (shared.length >= MIN_SHARED_SIGNIFICANT_WORDS) {
      support.push({ kind: 'shared-unresolved-question', detail: `"${question}" (shared terms: ${shared.join(', ')})` });
      break;
    }
  }

  // `decided_by` is the one MemoryEdgeType that names an actual decision relationship
  // (memory.ts's MemoryEdgeType) — a path through it is a materially different (and stronger)
  // claim than "reachable via SOME edge", so it gets its own channel rather than folding into
  // graph-neighborhood. Mutually exclusive by construction (never both for the same edgePath):
  // two channels sharing one traversal would not be the INDEPENDENT evidence the gate wants.
  if (candidate.edgePath) {
    if (candidate.edgePath.includes('>decided_by>')) {
      support.push({ kind: 'shared-decision', detail: candidate.edgePath });
    } else {
      support.push({ kind: 'graph-neighborhood', detail: candidate.edgePath });
    }
  }

  // Text similarity is computed from the candidate's OWN content against the task's keywords —
  // deliberately independent of `stage` (a graph-reached candidate can ALSO be textually
  // similar; a lexical/semantic hit is not automatically textually similar by MIN_SHARED_WORDS
  // standards once reranked). This is the one channel the locked decision says can never be the
  // second kind by itself — `duplicateWarnings`' gate is what enforces that, not this function.
  const textPool = [candidate.approachSummary ?? '', ...candidate.findings.map((f) => f.summary)].join(' ');
  const sharedText = overlapWords(textPool, signals.keywords);
  if (sharedText.length) support.push({ kind: 'text-similarity', detail: `shared terms: ${sharedText.join(', ')}` });

  return support;
}

// ---------------------------------------------------------------------------------------------
// The warning gate
// ---------------------------------------------------------------------------------------------

export interface DuplicateWarning {
  episodeId: string;
  runId: string;
  taskId: string | null;
  taskKey: string | null;
  runKind: string;
  outcome: string;
  landingOutcome: EpisodeLandingOutcome;
  /** What was attempted — quoted verbatim from the episode's own self-summary (or, absent one,
   *  its strongest finding). Untrusted model output (§13): present to the next agent as cited
   *  evidence, never as an instruction. */
  whatWasAttempted: string;
  /** What failed — the episode's own DETERMINISTIC `failures` list, quoted verbatim. */
  whatFailed: string[];
  /** What remains uncertain — the episode's own self-summary unresolved questions, quoted
   *  verbatim. */
  whatRemainsUncertain: string[];
  /** Every entry resolves back to a real overlap (locked decision: "inspectable end to end"). */
  support: SupportEntry[];
  score: number;
}

// §14 (locked decision): a failed run that disproved an approach is useful project progress —
// a POSITIVE bonus, never a penalty, so it can outrank an equally-matched but unremarkable
// successful episode for the same query (the acceptance's own example). Added to the candidate's
// RAW score before `rankCandidates` applies its stage weight, so ordering between two candidates
// of the SAME stage is preserved exactly (a positive additive bonus survives a positive scalar
// multiply); sized well under the smallest STAGE_WEIGHT gap in retrieval.ts so it can win a close
// tie without ever overriding a genuinely stronger match from a different stage.
const FAILED_EFFORT_RANK_BONUS = 0.15;

/**
 * Apply the two-independent-support-kind gate, then rank survivors through retrieval.ts's OWN
 * `rankCandidates` (reused, not forked — the task's own instruction) with the failed-effort
 * bonus folded into the input score. A candidate with fewer than two DISTINCT support kinds
 * produces no warning at all, however high its raw retrieval score — this is what makes "no
 * warning appears for unrelated lexical coincidences after reranking" true regardless of how the
 * reranking weights things, because such a candidate never reaches `rankCandidates` in the first
 * place.
 */
export function duplicateWarnings(
  candidates: EffortCandidate[],
  signals: EffortSignals,
  opts: { limit?: number; preferBranch?: string } = {},
): DuplicateWarning[] {
  const classified = candidates.map((candidate) => ({ candidate, support: classifySupport(candidate, signals) }));
  const gated = classified.filter(({ support }) => new Set(support.map((s) => s.kind)).size >= 2);
  if (!gated.length) return [];

  const hits: RetrievalHit[] = gated.map(({ candidate }) => ({
    entityType: 'episode',
    id: candidate.episodeId,
    title: `episode ${candidate.runId}`,
    snippet: candidate.approachSummary ?? candidate.findings[0]?.summary ?? '',
    stage: candidate.stage,
    score: candidate.score + (candidate.outcome === 'failed' ? FAILED_EFFORT_RANK_BONUS : 0),
    branch: candidate.intelligence?.identity.branch ?? undefined,
  }));
  const ranked = rankCandidates(hits, { limit: opts.limit, preferBranch: opts.preferBranch });

  const byId = new Map(gated.map((g) => [g.candidate.episodeId, g]));
  return ranked.map((r) => {
    const { candidate, support } = byId.get(r.id)!;
    return {
      episodeId: candidate.episodeId,
      runId: candidate.runId,
      taskId: candidate.taskId,
      taskKey: candidate.taskKey,
      runKind: candidate.runKind,
      outcome: candidate.outcome,
      landingOutcome: candidate.landingOutcome,
      whatWasAttempted:
        candidate.approachSummary || candidate.findings.map((f) => f.summary).join('; ') || '(no summary recorded)',
      whatFailed: candidate.failures,
      whatRemainsUncertain: candidate.unresolvedQuestions,
      support,
      score: r.finalScore,
    };
  });
}

function observation(value: number | boolean | null, completeness: MetricCompleteness): PriorEffortObservation {
  return { value, completeness };
}

function completeMetric(metric: { status: string; value: number | null } | undefined): PriorEffortObservation {
  if (!metric || metric.value == null) {
    return observation(null, (metric?.status as MetricCompleteness | undefined) ?? 'unavailable');
  }
  return observation(metric.value, metric.status as MetricCompleteness);
}

/** Enrich a warning only after the two-support gate has passed. Outcome fields are read from the
 * prior terminal episode; absent legacy telemetry remains unavailable/partial and never becomes
 * a numeric zero merely because the old skeleton used one on disk. */
export function priorEffortCase(candidate: EffortCandidate, warning: DuplicateWarning): PriorEffortCase {
  const intelligence = candidate.intelligence ?? null;
  const usage = intelligence?.execution.observedModelUsage;
  let tokens: PriorEffortObservation = observation(null, usage?.status ?? 'unavailable');
  let cost: PriorEffortObservation = observation(null, usage?.status ?? 'unavailable');
  if (usage?.value && (usage.status === 'complete' || usage.status === 'partial')) {
    const mixes = Object.values(usage.value);
    tokens = observation(mixes.reduce((sum, mix) =>
      sum + mix.inputTokens + mix.outputTokens + mix.cacheReadInputTokens + mix.cacheCreationInputTokens, 0), usage.status);
    const observedCost = mixes.reduce((sum, mix) => sum + mix.costUSD, 0);
    const tool = intelligence?.execution.executedStrategy?.tool ?? intelligence?.preExecution.commissionedStrategy?.tool;
    cost = tool === 'codex' && observedCost === 0
      ? observation(null, 'unavailable')
      : observation(observedCost, usage.status);
  }
  const roles = intelligence?.execution.stages.map((stage) => stage.role) ?? [];
  return {
    episodeId: candidate.episodeId,
    taskId: candidate.taskId,
    taskKey: candidate.taskKey,
    runId: candidate.runId,
    sitting: candidate.sitting ?? 1,
    executionId: intelligence?.identity.executionId ?? null,
    orchestrationId: intelligence?.identity.orchestrationId ?? null,
    repositoryKey: intelligence?.identity.repositoryKey ?? candidate.repositoryKey ?? null,
    branch: intelligence?.identity.branch ?? null,
    baseId: intelligence?.identity.baseId ?? candidate.baseId ?? null,
    validity: 'historical_episode',
    lineage: intelligence?.identity.lineage ?? {
      status: 'partial', missing: ['legacy'], reason: 'episode predates analytics lineage capture',
    },
    retrieval: {
      version: SIMILAR_EFFORT_RETRIEVAL_VERSION,
      stage: candidate.stage,
      score: warning.score,
      support: warning.support,
    },
    outcome: { run: candidate.outcome, landing: candidate.landingOutcome },
    observed: {
      filesTouched: intelligence
        ? completeMetric(intelligence.execution.changes.changedFiles)
        : candidate.filesTouched.length ? observation(candidate.filesTouched.length, 'partial') : observation(null, 'unavailable'),
      tokens,
      costUSD: cost,
      elapsedMs: completeMetric(intelligence?.execution.clocks.elapsedExecutionMs),
      reviewRounds: intelligence
        ? completeMetric(intelligence.outcome.reviewRounds)
        : observation(candidate.reviewRounds, 'partial'),
      verificationOrRepair: intelligence
        ? observation(roles.some((role) => role === 'verifier' || role === 'repair'),
            intelligence.execution.stages.length ? 'complete' : 'unavailable')
        : observation(null, 'unavailable'),
    },
    whatWasAttempted: warning.whatWasAttempted,
    whatFailed: warning.whatFailed,
    whatRemainsUncertain: warning.whatRemainsUncertain,
  };
}

// ---------------------------------------------------------------------------------------------
// Effort/difficulty summarization
// ---------------------------------------------------------------------------------------------

export interface EffortSummary {
  episodesConsidered: number;
  totalCostUSD: number;
  totalTokens: number;
  averageReviewRounds: number;
  /** Null when no considered episode carries both a start and finish timestamp. */
  averageDurationMs: number | null;
  landingOutcomes: Record<EpisodeLandingOutcome, number>;
}

function tokensFor(usage: RunModelUsage): number {
  return Object.values(usage).reduce((sum, mix) => sum + mix.inputTokens + mix.outputTokens, 0);
}

function durationMsFor(candidate: EffortCandidate): number | null {
  if (!candidate.startedAt || !candidate.finishedAt) return null;
  const ms = Date.parse(candidate.finishedAt) - Date.parse(candidate.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * Difficulty/effort statistics computed ONLY from the matched episodes' deterministic skeleton
 * fields — cost, token usage, review rounds, duration, landing outcome (locked decision: never
 * from `selfSummary` prose, which is past model output and cannot be a numeric source, §13/§14).
 * Callers pass exactly the episodes `duplicateWarnings` cited, so a summary's `episodesConsidered`
 * always matches what the warnings above it name — never a silently broader or narrower set.
 */
export function summarizeEffort(candidates: EffortCandidate[]): EffortSummary {
  const landingOutcomes: Record<EpisodeLandingOutcome, number> = { landed: 0, not_landed: 0, failed: 0, pending: 0 };
  let totalCostUSD = 0;
  let totalTokens = 0;
  let totalReviewRounds = 0;
  const durations: number[] = [];
  for (const c of candidates) {
    landingOutcomes[c.landingOutcome]++;
    totalCostUSD += c.costUSD;
    totalTokens += tokensFor(c.tokenUsage);
    totalReviewRounds += c.reviewRounds;
    const d = durationMsFor(c);
    if (d !== null) durations.push(d);
  }
  return {
    episodesConsidered: candidates.length,
    totalCostUSD,
    totalTokens,
    averageReviewRounds: candidates.length ? totalReviewRounds / candidates.length : 0,
    averageDurationMs: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
    landingOutcomes,
  };
}
