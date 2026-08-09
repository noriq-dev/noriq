// PLNR-263: deterministic episode-skeleton assembly and the env-level recorder that wires it to
// D1. Same split as backup.ts/restore.ts/lifecycle.ts/projection.ts: `buildEpisodeSkeleton` is
// pure (no `env`, no storage) so it is trivially unit-testable; `recordEpisodeForRun` is the one
// D1-reading adapter used by the durable terminal-transition job processor.
//
// WHY THE SKELETON IS BUILT HERE, SERVER-SIDE, FROM D1 — NOT SUPPLIED BY THE DAEMON (§14, locked
// decision): the server already holds every field the deterministic skeleton needs
// (runs.status/exit/started_at/created_at/tokens_used/usd_spent/model_usage/kind/anchor,
// task_refs, steers, run_log_segments' `round` column). A skeleton the daemon POSTs is a
// skeleton a compromised daemon can forge, and would be absent for a run whose daemon died
// before it could upload one. The richer optional half (commands/testsRun/failures/findings/
// filesTouched/selfSummary) genuinely can only come from the daemon — that is exactly what the
// episode-upload path (`ingest.ts`'s `beginEpisodeIngest`/.../`completeEpisodeIngest`, deferred
// to the Runner-side work this task does not build) enriches on top of the same row, via the
// SAME `ProjectMemory.recordEpisode` writer this module also calls.
//
// CORRECTION (migration 0075/0007): episode identity is (run_id, sitting), not run_id alone.
// `ProjectRoom.reopenRun` (RUN-182, "continue a failed run") reuses the SAME run id for a second
// sitting rather than minting a new run — its own comment calls this "a new sitting" — so a
// skeleton keyed by run_id alone would have the reopened sitting's terminal transition overwrite
// the failed sitting's episode, destroying evidence §14 says must remain retrievable. `sitting`
// is read straight off the `runs` row below, exactly like every other identity field here.
import type { Env } from '../env';
import { EpisodeLandingOutcome, RunModelUsage } from '@noriq-dev/shared';

/** The subset of a `runs` row the skeleton needs — D1 column names, matching the shape
 *  `env.DB.prepare(...).first()` hands back. */
export interface RunRowForEpisode {
  id: string;
  agent_id: string | null;
  kind: string; // 'scope' | 'build' | 'verify'
  runner_id: string | null;
  repo_ref: string;
  anchor_type: string | null;
  anchor_id: string | null;
  exit: string | null; // JSON RunExit — set by the terminal transition that triggers this
  created_at: string;
  dispatched_at: string | null;
  started_at: string | null;
  usd_spent: number | null;
  model_usage: string | null; // JSON RunModelUsage
  /** This run's current sitting (migration 0075) — 1 unless `reopenRun` has bumped it. Part of
   *  the episode's identity (run_id, sitting), never just display metadata. */
  sitting: number;
}

export interface TaskRefRowForEpisode {
  kind: string; // 'branch' | 'pr' | 'commit'
  ref: string;
  state: string | null;
}

export interface SteerRowForEpisode {
  id: string;
  mode: string;
  delivered_via: string | null;
}

export interface EpisodeSkeletonInput {
  run: RunRowForEpisode;
  taskTitle: string | null;
  /** Resolved via `repository_checkouts`/`project_repositories` (PLNR-259) from
   *  `run.runner_id`/`run.repo_ref` — null when the run's checkout was never associated with a
   *  canonical repository (indexing is opt-in, §7). */
  repositoryKey: string | null;
  taskRefs: TaskRefRowForEpisode[];
  steers: SteerRowForEpisode[];
  /** `MAX(run_log_segments.round)` for this run's `role = 'reviewer'` rows — the ROUND NUMBER
   *  only, never `.text` (that column is the transcript itself, and §18/the task's locked
   *  decisions forbid copying it into any retrieval row). */
  reviewRounds: number;
}

/** The deterministic fields `ProjectMemory.recordEpisode` needs, MINUS `selfSummary` (never
 *  produced server-side, §14) and MINUS `actor` (the caller's own provenance, not derived from
 *  the run). Field names match `RecordEpisodeInput` in `do/ProjectMemory.ts` exactly — this is
 *  that RPC's server-derived half. */
export interface EpisodeSkeleton {
  runId: string;
  sitting: number;
  agentId: string | null;
  runKind: string;
  outcome: 'done' | 'failed' | 'cancelled';
  startedAt: string | null;
  finishedAt: string | null;
  taskId: string | null;
  taskTitle: string | null;
  repositoryKey: string | null;
  baseId: string | null;
  timeline: Array<{ at: string; label: string }>;
  filesTouched: string[];
  commands: string[];
  testsRun: string[];
  failures: string[];
  findings: Array<{ summary: string; severity?: string }>;
  reviewRounds: number;
  tokenUsage: RunModelUsage;
  costUSD: number;
  acceptanceCoverage: number | null;
  steeringEvents: string[];
  landingOutcome: EpisodeLandingOutcome;
  remainingWork: string[];
}

/** Parse `runs.exit`'s JSON — thrown by nothing: a run reaching this function is past a terminal
 *  transition (`transitionRun` always sets `exit` before the fire-and-forget call), but a
 *  malformed or missing value degrades to 'done' rather than throwing — recording an episode
 *  must never fail loudly enough to look like it broke the run it describes. Exported so
 *  `ProjectMemory.completeEpisodeIngest` (the OTHER path that resolves a run's own outcome
 *  before calling `recordEpisode`, PLNR-263) shares this exact degrade rule instead of a second,
 *  possibly-drifting copy. */
export function parseExit(exitJson: string | null): { outcome: 'done' | 'failed' | 'cancelled'; finishedAt: string | null } {
  if (!exitJson) return { outcome: 'done', finishedAt: null };
  try {
    const parsed = JSON.parse(exitJson) as { outcome?: string; finishedAt?: string };
    const outcome = parsed.outcome === 'failed' || parsed.outcome === 'cancelled' ? parsed.outcome : 'done';
    return { outcome, finishedAt: typeof parsed.finishedAt === 'string' ? parsed.finishedAt : null };
  } catch {
    return { outcome: 'done', finishedAt: null };
  }
}

/**
 * Landing outcome (§14) is a DIFFERENT axis from the run's own `outcome` (see the migration's
 * comment): whether the WORK landed, not whether the agent's sitting succeeded. A merged PR
 * (`task_refs` kind 'pr', state 'merged' — real, deterministic, already-recorded git awareness,
 * RUN-required-reading's task_refs) is the strongest signal the server holds and wins outright;
 * short of that, a failed/cancelled run cannot have landed, and a done run whose PR has not
 * merged yet is 'pending' — the ordinary "awaiting human review" state, not a fourth outcome.
 */
function landingOutcomeFor(runOutcome: 'done' | 'failed' | 'cancelled', taskRefs: TaskRefRowForEpisode[]): EpisodeLandingOutcome {
  if (taskRefs.some((r) => r.kind === 'pr' && r.state === 'merged')) return 'landed';
  if (runOutcome === 'failed') return 'failed';
  if (runOutcome === 'cancelled') return 'not_landed';
  return 'pending';
}

/**
 * `baseId` is VCS-neutral and opaque (§6) — the closest deterministic value the server holds
 * without a daemon report is this task's most recently recorded 'commit' task_ref, which for a
 * git repository IS a real (if task-scoped, not run-scoped) revision id. Null when the task has
 * none yet, or there is no anchor task at all (scope/verify runs, or a plain-brief dispatch).
 */
function baseIdFromTaskRefs(taskRefs: TaskRefRowForEpisode[]): string | null {
  const commits = taskRefs.filter((r) => r.kind === 'commit');
  return commits.length ? commits[commits.length - 1]!.ref : null;
}

/** Deterministic timeline entries from the run's own lifecycle timestamps — never a transcript
 *  excerpt, just labeled instants the row already carries. */
function timelineFor(run: RunRowForEpisode, finishedAt: string | null, outcome: string): Array<{ at: string; label: string }> {
  const entries: Array<{ at: string; label: string }> = [{ at: run.created_at, label: 'queued' }];
  if (run.dispatched_at) entries.push({ at: run.dispatched_at, label: 'dispatched to runner' });
  if (run.started_at) entries.push({ at: run.started_at, label: 'agent started' });
  if (finishedAt) entries.push({ at: finishedAt, label: `run ${outcome}` });
  return entries;
}

/** Each steer as a metadata summary — `mode`/`delivered_via` only, never `source_id`'s referent
 *  content (steers carries no free text of its own to begin with). */
function steeringEventsFor(steers: SteerRowForEpisode[]): string[] {
  return steers.map((s) => `${s.mode} steer${s.delivered_via ? ` (${s.delivered_via})` : ''}`);
}

/** Pure: D1 rows in, the deterministic half of an `EffortEpisode` out. No storage, no `env` —
 *  see the module comment for why this is split from `recordEpisodeForRun`. */
export function buildEpisodeSkeleton(input: EpisodeSkeletonInput): EpisodeSkeleton {
  const { outcome, finishedAt } = parseExit(input.run.exit);
  let tokenUsage: RunModelUsage = {};
  if (input.run.model_usage) {
    const parsed = RunModelUsage.safeParse(JSON.parse(input.run.model_usage));
    if (parsed.success) tokenUsage = parsed.data;
  }
  return {
    runId: input.run.id,
    sitting: input.run.sitting,
    agentId: input.run.agent_id,
    runKind: input.run.kind,
    outcome,
    startedAt: input.run.started_at,
    finishedAt,
    taskId: input.run.anchor_type === 'task' ? input.run.anchor_id : null,
    taskTitle: input.taskTitle,
    repositoryKey: input.repositoryKey,
    baseId: baseIdFromTaskRefs(input.taskRefs),
    timeline: timelineFor(input.run, finishedAt, outcome),
    filesTouched: [],
    commands: [],
    testsRun: [],
    failures: [],
    findings: [],
    reviewRounds: input.reviewRounds,
    tokenUsage,
    costUSD: input.run.usd_spent ?? 0,
    acceptanceCoverage: null,
    steeringEvents: steeringEventsFor(input.steers),
    landingOutcome: landingOutcomeFor(outcome, input.taskRefs),
    remainingWork: [],
  };
}

/**
 * The D1-reading half: load one run's state and everything the skeleton needs, then call
 * `ProjectMemory.recordEpisode` through the `PROJECT_MEMORY` stub. The terminal transition's
 * durable job processor calls it outside the run's critical path; errors are retained on the D1
 * job for the scheduled sweep rather than changing the already-committed run outcome.
 */
export async function recordEpisodeForRun(env: Env, projectId: string, runId: string): Promise<void> {
  const run = await env.DB.prepare(
    `SELECT id, agent_id, kind, runner_id, repo_ref, anchor_type, anchor_id, exit, created_at,
            dispatched_at, started_at, usd_spent, model_usage, sitting
       FROM runs WHERE id = ? AND project_id = ?`,
  ).bind(runId, projectId).first<RunRowForEpisode>();
  if (!run) throw new Error(`run ${runId} not found in project ${projectId}`);
  if (!run.exit) throw new Error(`run ${runId} has no terminal exit yet — recordEpisodeForRun must only be called after a terminal transition`);

  const taskId = run.anchor_type === 'task' ? run.anchor_id : null;
  const [taskRow, taskRefsResult, steersResult, reviewRoundsRow, repoRow] = await Promise.all([
    taskId ? env.DB.prepare('SELECT title FROM tasks WHERE id = ?').bind(taskId).first<{ title: string }>() : Promise.resolve(null),
    taskId
      ? env.DB.prepare('SELECT kind, ref, state FROM task_refs WHERE task_id = ? ORDER BY created_at ASC').bind(taskId).all<TaskRefRowForEpisode>()
      : Promise.resolve({ results: [] as TaskRefRowForEpisode[] }),
    env.DB.prepare('SELECT id, mode, delivered_via FROM steers WHERE run_id = ? ORDER BY created_at ASC').bind(runId).all<SteerRowForEpisode>(),
    env.DB.prepare(`SELECT COALESCE(MAX(round), 0) AS maxRound FROM run_log_segments WHERE run_id = ? AND role = 'reviewer'`)
      .bind(runId).first<{ maxRound: number }>(),
    run.runner_id
      ? env.DB.prepare(
          `SELECT pr.repository_key AS repositoryKey FROM repository_checkouts rc
             JOIN project_repositories pr ON pr.id = rc.project_repository_id
            WHERE rc.runner_id = ? AND rc.checkout_id = ?`,
        ).bind(run.runner_id, run.repo_ref).first<{ repositoryKey: string }>()
      : Promise.resolve(null),
  ]);

  const skeleton = buildEpisodeSkeleton({
    run,
    taskTitle: taskRow?.title ?? null,
    repositoryKey: repoRow?.repositoryKey ?? null,
    taskRefs: taskRefsResult.results,
    steers: steersResult.results,
    reviewRounds: reviewRoundsRow?.maxRound ?? 0,
  });

  await env.PROJECT_MEMORY.get(env.PROJECT_MEMORY.idFromName(projectId)).recordEpisode(projectId, {
    ...skeleton,
    actor: { kind: 'system', id: null },
  });
}

/**
 * Deliver one durable `memory_episode_jobs` row. The expected sitting check is the guard that
 * prevents a retry for sitting N from accidentally describing sitting N+1 after `reopenRun`
 * reused the same run id. `reopenRun` flushes the current sitting before incrementing it, while
 * the scheduled sweep handles ordinary transient failures and isolate restarts.
 */
export async function processPendingEpisodeJob(
  env: Env,
  projectId: string,
  runId: string,
  sitting: number,
): Promise<boolean> {
  const job = await env.DB.prepare(
    'SELECT 1 FROM memory_episode_jobs WHERE project_id = ? AND run_id = ? AND sitting = ?',
  ).bind(projectId, runId, sitting).first();
  if (!job) return false;

  try {
    const run = await env.DB.prepare(
      'SELECT sitting, exit FROM runs WHERE id = ? AND project_id = ?',
    ).bind(runId, projectId).first<{ sitting: number; exit: string | null }>();
    if (!run) throw new Error(`run ${runId} no longer exists in project ${projectId}`);
    if (run.sitting !== sitting) {
      throw new Error(`episode job for ${runId} sitting ${sitting} cannot use current sitting ${run.sitting}`);
    }
    if (!run.exit) throw new Error(`run ${runId} sitting ${sitting} is no longer terminal`);

    await recordEpisodeForRun(env, projectId, runId);
    await env.DB.prepare(
      'DELETE FROM memory_episode_jobs WHERE project_id = ? AND run_id = ? AND sitting = ?',
    ).bind(projectId, runId, sitting).run();
    return true;
  } catch (err) {
    await env.DB.prepare(
      `UPDATE memory_episode_jobs
       SET attempts = attempts + 1, last_error = ?, last_attempt_at = ?
       WHERE project_id = ? AND run_id = ? AND sitting = ?`,
    ).bind(String(err), new Date().toISOString(), projectId, runId, sitting).run();
    throw err;
  }
}

/** Retry a bounded oldest-first batch of terminal episode jobs. */
export async function sweepPendingEpisodeJobs(env: Env, limit = 100): Promise<{ completed: number; failed: number }> {
  const { results } = await env.DB.prepare(
    `SELECT project_id, run_id, sitting FROM memory_episode_jobs
     ORDER BY requested_at ASC LIMIT ?`,
  ).bind(limit).all<{ project_id: string; run_id: string; sitting: number }>();
  let completed = 0;
  let failed = 0;
  for (const row of results) {
    try {
      if (await processPendingEpisodeJob(env, row.project_id, row.run_id, row.sitting)) completed++;
    } catch (err) {
      failed++;
      console.warn(`episode job retry for ${row.run_id}/${row.sitting} failed: ${String(err)}`);
    }
  }
  return { completed, failed };
}
