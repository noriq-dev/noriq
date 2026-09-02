// PLNR-250: retention, cleanup, and erasure orchestration for ProjectMemory.
//
// This file, like backup.ts/restore.ts, never opens a DO's SQLite storage directly — it either
// operates on R2 (backup retention, whole-project erasure of backups) or calls RPCs on a
// ProjectMemory stub through `env.PROJECT_MEMORY` (staged-generation pruning, retained-
// generation pruning, the auditable erase sequence). Because `Env.PROJECT_MEMORY` is already
// typed as `DurableObjectNamespace<ProjectMemory>`, every stub call here is fully typed without
// this file importing the DO class itself — keeping the dependency one-way (ProjectMemory.ts
// imports FROM this file for thresholds and the R2 helpers below, never the reverse).
import type { Env } from '../env';
import { projectBackupsPrefix } from './backup';

/** How many backup generations (distinct exportedAt prefixes) to keep per project. */
export const DEFAULT_BACKUP_RETENTION_COUNT = 7;
/** A staged index generation older than this with no activation is abandoned debris — nothing
 *  stages into `index_generations` before Phase 5, so this prunes zero rows until then. */
export const STAGED_GENERATION_MAX_AGE_MS = 24 * 3600 * 1000;
/** PLNR-256: a 'superseded' index generation older than this (by its own `activated_at` — see
 *  `pruneSupersededGenerations`'s doc comment for why there is no separate "superseded_at")
 *  is inert registry debris the sweep discards. This does NOT retire vectors — those are
 *  retired eagerly at activation time (`activateCodeGeneration`'s `deletedUris`); this only
 *  clears the now-inert `index_generations` row. */
export const SUPERSEDED_GENERATION_MAX_AGE_MS = 24 * 3600 * 1000;
/** How long a restore's retained prior generation stays available for rollback before the
 *  sweep discards it. */
export const RETAINED_GENERATION_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
/** A cross-source analytics build older than this is an abandoned resumable job, not a live
 * generation. The sweep fails it, discards its inbox, and leaves canonical sources untouched. */
export const ANALYTICS_BUILD_MAX_AGE_MS = 24 * 3600 * 1000;
/** Visibility thresholds only (§18) — nothing here refuses a write at either line. */
export const DB_SIZE_WARN_BYTES = 500 * 1024 * 1024;
export const DB_SIZE_CRITICAL_BYTES = 1024 * 1024 * 1024;
/** PLNR-254: an authority-1/2 hypothesis with no feedback and no place in any approval/merge/
 *  supersession history is decay-eligible once it is this old. Never touches authority 3+. */
export const MEMORY_HYPOTHESIS_DECAY_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
/** Decay never reaches authority 3 ("repeated successful observation") or above — only bare
 *  hypotheses and single-agent observations are cache-like enough to prune. */
export const MEMORY_HYPOTHESIS_DECAY_AUTHORITY_CEILING = 3;

export function sizeStatus(databaseSize: number): 'ok' | 'warn' | 'critical' {
  if (databaseSize >= DB_SIZE_CRITICAL_BYTES) return 'critical';
  if (databaseSize >= DB_SIZE_WARN_BYTES) return 'warn';
  return 'ok';
}

async function deleteR2Prefix(env: Env, prefix: string): Promise<number> {
  if (!env.FILES) return 0;
  const files = env.FILES;
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await files.list({ prefix, cursor, limit: 1000 });
    if (page.objects.length > 0) {
      await files.delete(page.objects.map((o) => o.key));
      deleted += page.objects.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}

/** Delete every R2 object under a project's memory-backups prefix. Idempotent — an
 *  already-empty (or never-created) prefix deletes zero objects without error. */
export async function deleteAllProjectBackups(env: Env, projectId: string): Promise<number> {
  return deleteR2Prefix(env, projectBackupsPrefix(projectId));
}

/** This project's backup generations (the `<exportedAt>` slug segment), newest first. Reads
 *  via `delimiter: '/'` so R2 groups keys by that segment instead of listing every chunk. */
export async function listProjectBackupGenerations(env: Env, projectId: string): Promise<string[]> {
  if (!env.FILES) return [];
  const prefix = projectBackupsPrefix(projectId);
  const page = await env.FILES.list({ prefix, delimiter: '/' });
  // ISO-derived slugs (colons/dots replaced with '-') are fixed-width and sort chronologically
  // as plain strings — no date parsing needed to order them.
  return page.delimitedPrefixes
    .map((p) => p.slice(prefix.length).replace(/\/$/, ''))
    .sort()
    .reverse();
}

/** Prune backup generations beyond `keepLast` (oldest first). Returns how many were pruned.
 *  Idempotent — a project at or under the limit prunes nothing. */
export async function pruneBackupRetention(env: Env, projectId: string, keepLast = DEFAULT_BACKUP_RETENTION_COUNT): Promise<number> {
  const generations = await listProjectBackupGenerations(env, projectId);
  const toPrune = generations.slice(keepLast);
  for (const slug of toPrune) {
    await deleteR2Prefix(env, `${projectBackupsPrefix(projectId)}${slug}/`);
  }
  return toPrune.length;
}

export interface EraseStepResult {
  step: string;
  ok: boolean;
  detail: string;
}
export interface EraseReport {
  ok: boolean;
  steps: EraseStepResult[];
}

export interface TombstoneSweepResult {
  projectId: string;
  cleared: boolean;
  report: EraseReport;
}

/**
 * Retry every pending erasure tombstone (PLNR-250, migration 0072): for each, run the DO's
 * full auditable erase sequence and the R2 backup-prefix delete, then clear the tombstone only
 * if every step succeeded. A tombstone that fails again just accumulates an attempt count —
 * the sweep is safe to run as often as the cron likes; a completed erasure is a no-op the next
 * time (erase() tolerates empty tables, deleteR2Prefix tolerates an empty prefix).
 */
export async function sweepPendingErasures(env: Env): Promise<TombstoneSweepResult[]> {
  const { results } = await env.DB.prepare('SELECT project_id FROM memory_erasure_tombstones').all<{ project_id: string }>();
  const outcomes: TombstoneSweepResult[] = [];
  for (const { project_id: projectId } of results) {
    const report = await env.PROJECT_MEMORY.get(env.PROJECT_MEMORY.idFromName(projectId)).eraseAll(projectId);
    if (report.ok) {
      await env.DB.prepare('DELETE FROM memory_erasure_tombstones WHERE project_id = ?').bind(projectId).run();
    } else {
      await env.DB.prepare(
        `UPDATE memory_erasure_tombstones
         SET attempts = attempts + 1, last_error = ?, last_attempt_at = ?
         WHERE project_id = ?`,
      ).bind(JSON.stringify(report.steps.filter((s) => !s.ok)), new Date().toISOString(), projectId).run();
    }
    outcomes.push({ projectId, cleared: report.ok, report });
  }
  return outcomes;
}

export interface ProjectCleanupResult {
  projectId: string;
  prunedStagedGenerations: number;
  prunedRetainedGeneration: boolean;
  prunedBackupGenerations: number;
  decayedMemories: number;
  /** PLNR-256: superseded index-generation registry rows discarded (no second scheduler — see
   *  SUPERSEDED_GENERATION_MAX_AGE_MS's doc comment for what this does and does not clean up). */
  prunedSupersededGenerations: number;
  prunedAnalyticsGenerations: number;
  abandonedAnalyticsGenerations: number;
  /** PLNR-320: whether this sweep was the one that ran the automatic one-time coordination-graph
   *  backfill for this project (see `ProjectMemory.backfillProjectionOnce`'s own doc comment for
   *  why the daily sweep, not `alarm()`/construction, is the deliberate trigger). `false` on
   *  every sweep after the first — the durable marker, not this field, is the source of truth. */
  backfilled: boolean;
  backfillNodesWritten: number;
  backfillEdgesWritten: number;
  /** A cleanup step that failed is never reported as a successful zero. Other independent
   *  steps still run, and the operator receives the exact failed step and message. */
  errors: Array<{ step: string; message: string }>;
}

/**
 * Projects whose ProjectMemory store should be backed up and debris-swept (PLNR-553).
 *
 * `project_memory_registry` is the operational projection, but it is only written by
 * upsertMemoryHealth / updateMemoryBackupStatus / setMemoryVectorDirty — index ingest used
 * to skip all three, so a project that only indexed never got a row and was silently omitted
 * from cron backup and sweep. UNION in repositories that have actually started ingest
 * (`ingest_status != 'none'`). A repository that is merely registered (`none`) has not
 * touched the DO; including those would instantiate empty stores. A project with neither a
 * registry row nor an ingesting repository is correctly omitted.
 */
export async function listMemoryLifecycleProjectIds(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT project_id FROM project_memory_registry
     UNION
     SELECT DISTINCT project_id FROM project_repositories WHERE ingest_status != 'none'`,
  ).all<{ project_id: string }>();
  return results.map((r) => r.project_id);
}

/** The single-project body of `sweepProjectDebris` below, extracted (PLNR-273) so an operator
 *  can trigger the same idempotent cleanup on demand for ONE project (a REST action) without
 *  waiting for the cron's pass over every registered project. Behavior is identical either
 *  way — this is the only place the actual pruning happens now. */
export async function sweepProjectDebrisForProject(env: Env, projectId: string): Promise<ProjectCleanupResult> {
  const stub = env.PROJECT_MEMORY.get(env.PROJECT_MEMORY.idFromName(projectId));
  const errors: Array<{ step: string; message: string }> = [];
  const capture = async <T>(step: string, fallback: T, promise: Promise<T>): Promise<T> => {
    try {
      return await promise;
    } catch (err) {
      errors.push({ step, message: err instanceof Error ? err.message : String(err) });
      return fallback;
    }
  };
  const [prunedStagedGenerations, prunedRetainedGeneration, prunedBackupGenerations, decayedMemories, prunedSupersededGenerations, analytics, backfill] = await Promise.all([
    capture('staged-generations', 0, stub.pruneAbandonedStagedGenerations(projectId, STAGED_GENERATION_MAX_AGE_MS)),
    capture('retained-generation', false, stub.pruneRetainedGenerationIfExpired(projectId, RETAINED_GENERATION_MAX_AGE_MS)),
    capture('backup-retention', 0, pruneBackupRetention(env, projectId)),
    capture(
      'memory-decay', 0,
      stub
        .decayLowAuthorityMemories(projectId, { maxAgeMs: MEMORY_HYPOTHESIS_DECAY_MAX_AGE_MS, authorityCeiling: MEMORY_HYPOTHESIS_DECAY_AUTHORITY_CEILING })
        .then((r) => r.decayed.length),
    ),
    capture('superseded-generations', 0, stub.pruneSupersededGenerations(projectId, SUPERSEDED_GENERATION_MAX_AGE_MS)),
    capture(
      'analytics-generations', { pruned: 0, abandoned: 0 },
      stub.pruneAnalyticsGenerations(projectId, ANALYTICS_BUILD_MAX_AGE_MS)
        .then((result) => ({ pruned: result.pruned, abandoned: result.abandoned })),
    ),
    // PLNR-320: the automatic one-time coordination-graph backfill — see
    // ProjectMemory.backfillProjectionOnce's own doc comment for why THIS sweep, specifically,
    // is the deliberate trigger (not alarm()/construction). A no-op on every sweep after the
    // first for a given project — the durable `_meta` marker inside the DO is the real gate.
    capture('graph-backfill', { ran: false } as { ran: boolean; nodesWritten?: number; edgesWritten?: number }, stub.backfillProjectionOnce(projectId)),
  ]);
  await capture(
    'health-refresh',
    undefined,
    stub.health(projectId).then((h) =>
      env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(projectId)).upsertMemoryHealth(projectId, {
        schemaVersion: h.schemaVersion,
        memoryRevision: h.memoryRevision,
        sizeBytes: h.databaseSize,
        sizeStatus: h.sizeStatus,
      }),
    ),
  );
  return {
    projectId, prunedStagedGenerations, prunedRetainedGeneration, prunedBackupGenerations, decayedMemories, prunedSupersededGenerations,
    prunedAnalyticsGenerations: analytics.pruned,
    abandonedAnalyticsGenerations: analytics.abandoned,
    backfilled: backfill.ran,
    backfillNodesWritten: backfill.nodesWritten ?? 0,
    backfillEdgesWritten: backfill.edgesWritten ?? 0,
    errors: errors.sort((a, b) => a.step.localeCompare(b.step)),
  };
}

/** Per-project debris cleanup for every project that has a memory registry row OR an ingesting
 *  repository (PLNR-553 — see `listMemoryLifecycleProjectIds`): abandoned staged index
 *  generations, an expired retained restore generation, backups beyond the retention count,
 *  and (PLNR-254) unused low-authority memory hypotheses past their decay age. Also refreshes
 *  the visible size status in the D1 registry (and enrolls a missing registry row via
 *  health-refresh) — this sweep is the natural place for it: a periodic pass over every
 *  project that actually has a store, not an extra write on every health() read. Each project
 *  is independent — one failing never blocks the rest. */
export async function sweepProjectDebris(env: Env): Promise<ProjectCleanupResult[]> {
  const projectIds = await listMemoryLifecycleProjectIds(env);
  const outcomes: ProjectCleanupResult[] = [];
  for (const projectId of projectIds) {
    outcomes.push(await sweepProjectDebrisForProject(env, projectId));
  }
  return outcomes;
}
