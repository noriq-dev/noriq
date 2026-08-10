// PLNR-292: bounded D1 -> ProjectMemory replay for disposable analytics generations. D1 remains
// canonical for orchestration; ProjectMemory remains canonical for episodes. This adapter only
// copies bounded structural facts into a building generation, then asks the memory authority to
// validate and atomically publish derived rows.
import type { Env } from '../env';
import {
  AnalyticsGenerationDescriptor,
  ProjectAnalyticsHealth,
  type AnalyticsGenerationDescriptor as AnalyticsGenerationDescriptorData,
  type ProjectAnalyticsHealth as ProjectAnalyticsHealthData,
} from '@noriq-dev/shared';

export const ANALYTICS_EXTRACTION_VERSION = 'project-intelligence-v2';
const SNAPSHOT_PAGE_SIZE = 200;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 24 * 60 * 60 * 1_000;

export interface CurrentProjectFlowSummary {
  observedAt: string;
  source: 'd1_current_state';
  watermarks: { coordinationEventSequence: number | null; orchestrationAcceptedAt: string | null };
  readiness: { totalTasks: number; readyTasks: number; blockedTasks: number; inProgressTasks: number; reviewTasks: number };
  plans: {
    statuses: Record<string, number>;
    dispatchStatuses: Record<string, number>;
    phaseGateStatuses: Record<string, number>;
    phasesWithoutGate: number;
    landings: { recorded: number; owed: number; succeeded: number; failed: number };
  };
  execution: {
    runStatuses: Record<string, number>;
    orchestrationStatuses: Record<string, number>;
    nodeStatuses: Record<string, number>;
    activeNodes: number;
    parkedNodes: number;
  };
  coordination: { activeClaims: number; activeLocks: number };
  runners: { statuses: Record<string, number>; presenceStates: Record<string, number> };
}

const countRows = <T extends { status: string; count: number }>(rows: T[]): Record<string, number> =>
  Object.fromEntries(rows.map((row) => [row.status, row.count]));

/** Canonical analytics adjuncts live for the project lifetime and ride the authoritative
 * store's existing backup. Derived generations are deliberately excluded and rebuilt. The
 * future writer tasks named here must follow this policy instead of inventing per-feature
 * retention or treating a disposable read model as history. */
export const PROJECT_INTELLIGENCE_RECORD_LIFECYCLE = {
  commissioningFacts: { authority: 'd1', retention: 'project_lifetime', backup: 'd1_logical_snapshot' },
  qualityEvents: { authority: 'd1', retention: 'project_lifetime', backup: 'd1_logical_snapshot' },
  similarityFeedback: { authority: 'd1', retention: 'project_lifetime', backup: 'd1_logical_snapshot' },
  shadowSnapshots: { authority: 'd1', retention: 'project_lifetime', backup: 'd1_logical_snapshot' },
  analyticsGenerations: { authority: 'derived', retention: 'bounded_replaceable', backup: 'rebuild' },
} as const;

export type AnalyticsExecutionNodeSnapshot = {
  id: string;
  orchestrationId: string;
  parentExecutionId: string | null;
  runId: string | null;
  sitting: number | null;
  kind: string;
  role: string;
  stage: string | null;
  status: string;
  completenessStatus: string;
  completenessMissing: string;
  completenessReason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AnalyticsExecutionEventSnapshot = {
  eventId: string;
  executionId: string;
  runId: string | null;
  sitting: number | null;
  revision: number;
  eventType: string;
  observedAt: string;
  acceptedAt: string;
};

export type AnalyticsSnapshotRow =
  | { sourceKind: 'execution_node'; sourceKey: string; body: AnalyticsExecutionNodeSnapshot }
  | { sourceKind: 'execution_event'; sourceKey: string; body: AnalyticsExecutionEventSnapshot };

type AnalyticsMemoryRpc = {
  beginAnalyticsGeneration(projectId: string, input: {
    extractionVersion: string;
    d1EventWatermark: number | null;
    orchestrationWatermark: string | null;
    force: boolean;
  }): Promise<{ generationId: string; unchanged: boolean }>;
  ingestAnalyticsSnapshot(projectId: string, generationId: string, rows: AnalyticsSnapshotRow[]): Promise<{ accepted: number }>;
  completeAnalyticsGeneration(projectId: string, generationId: string): Promise<{
    generationId: string; rowCount: number; checksum: string; activated: boolean;
  }>;
  failAnalyticsGeneration(projectId: string, generationId: string, error: string): Promise<void>;
  analyticsGenerationHealth(projectId: string): Promise<StoredAnalyticsHealth>;
};

type StoredGeneration = {
  id: string;
  status: 'building' | 'complete' | 'failed';
  extractionVersion: string;
  buildMode: 'incremental' | 'full';
  sourceMemoryRevision: number;
  d1EventWatermark: number | null;
  orchestrationWatermark: string | null;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
};

type StoredAnalyticsHealth = {
  memoryRevision: number;
  active: StoredGeneration | null;
  building: StoredGeneration | null;
  latestFailure: StoredGeneration | null;
  lastSuccessfulIncrementalAt: string | null;
  lastSuccessfulFullRebuildAt: string | null;
  counts: { episodes: number; generations: number; rows: number; snapshotRows: number };
};

const memory = (env: Env, projectId: string): AnalyticsMemoryRpc =>
  env.PROJECT_MEMORY.get(env.PROJECT_MEMORY.idFromName(projectId)) as unknown as AnalyticsMemoryRpc;

export async function analyticsSourceWatermarks(env: Env, projectId: string): Promise<{
  eventWatermark: number | null;
  orchestrationWatermark: string;
}> {
  const eventWatermark = (await env.DB.prepare('SELECT MAX(seq) AS value FROM events WHERE project_id = ?')
    .bind(projectId).first<{ value: number | null }>())?.value ?? null;
  const orchestration = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM execution_nodes WHERE project_id = ?1) AS nodeCount,
       (SELECT MAX(updated_at) FROM execution_nodes WHERE project_id = ?1) AS nodeUpdatedAt,
       (SELECT COUNT(*) FROM execution_lifecycle_events e JOIN execution_nodes n ON n.id = e.execution_id
         WHERE n.project_id = ?1) AS eventCount,
       (SELECT MAX(e.accepted_at) FROM execution_lifecycle_events e JOIN execution_nodes n ON n.id = e.execution_id
         WHERE n.project_id = ?1) AS eventAcceptedAt`,
  ).bind(projectId).first<{
    nodeCount: number; nodeUpdatedAt: string | null; eventCount: number; eventAcceptedAt: string | null;
  }>();
  return {
    eventWatermark,
    orchestrationWatermark: JSON.stringify(orchestration ?? {
      nodeCount: 0, nodeUpdatedAt: null, eventCount: 0, eventAcceptedAt: null,
    }),
  };
}

/** Canonical operational flow, observed directly from D1 at request time. This intentionally
 * does not join or inherit the completed analytics generation's timestamps: it answers "now",
 * while queryHistoricalAnalytics answers only for a frozen historical population. */
export async function getCurrentProjectFlowSummary(
  env: Env,
  projectId: string,
  observedAt = new Date().toISOString(),
): Promise<CurrentProjectFlowSummary> {
  type StatusCount = { status: string; count: number };
  const [
    watermarks, readiness, planStatuses, dispatchStatuses, gateStatuses, phaseCounts, landing,
    runStatuses, orchestrationStatuses, nodeStatuses, claims, locks, runnerStatuses, presenceStates,
  ] = await Promise.all([
    analyticsSourceWatermarks(env, projectId),
    env.DB.prepare(
      `SELECT COUNT(*) AS totalTasks,
              SUM(CASE WHEN t.status = 'todo'
                         AND NOT EXISTS (
                           SELECT 1 FROM dependencies d JOIN tasks dependency ON dependency.id = d.depends_on_task_id
                            WHERE d.task_id = t.id AND dependency.status != 'done'
                         )
                         AND NOT EXISTS (
                           SELECT 1 FROM phase_tasks pt JOIN phases ph ON ph.id = pt.phase_id
                             JOIN plans p ON p.id = ph.plan_id
                            WHERE pt.task_id = t.id AND p.status = 'proposed'
                         ) THEN 1 ELSE 0 END) AS readyTasks,
              SUM(CASE WHEN t.status = 'blocked' THEN 1 ELSE 0 END) AS blockedTasks,
              SUM(CASE WHEN t.status IN ('claimed','in_progress') THEN 1 ELSE 0 END) AS inProgressTasks,
              SUM(CASE WHEN t.status = 'review' THEN 1 ELSE 0 END) AS reviewTasks
         FROM tasks t WHERE t.project_id = ?`,
    ).bind(projectId).first<{
      totalTasks: number; readyTasks: number | null; blockedTasks: number | null;
      inProgressTasks: number | null; reviewTasks: number | null;
    }>(),
    env.DB.prepare('SELECT status, COUNT(*) AS count FROM plans WHERE project_id = ? GROUP BY status')
      .bind(projectId).all<StatusCount>(),
    env.DB.prepare('SELECT status, COUNT(*) AS count FROM plan_dispatches WHERE project_id = ? GROUP BY status')
      .bind(projectId).all<StatusCount>(),
    env.DB.prepare(
      `SELECT pg.status, COUNT(*) AS count FROM phase_gates pg
         JOIN phases ph ON ph.id = pg.phase_id JOIN plans p ON p.id = ph.plan_id
        WHERE p.project_id = ? GROUP BY pg.status`,
    ).bind(projectId).all<StatusCount>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS phases,
              SUM(CASE WHEN pg.phase_id IS NULL THEN 1 ELSE 0 END) AS withoutGate
         FROM phases ph JOIN plans p ON p.id = ph.plan_id LEFT JOIN phase_gates pg ON pg.phase_id = ph.id
        WHERE p.project_id = ?`,
    ).bind(projectId).first<{ phases: number; withoutGate: number | null }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS recorded,
              SUM(CASE WHEN merge_requested_at IS NULL THEN 1 ELSE 0 END) AS owed,
              SUM(CASE WHEN merge_requested_at IS NOT NULL AND failed_detail IS NULL THEN 1 ELSE 0 END) AS succeeded,
              SUM(CASE WHEN failed_detail IS NOT NULL THEN 1 ELSE 0 END) AS failed
         FROM plan_landings WHERE project_id = ?`,
    ).bind(projectId).first<{ recorded: number; owed: number | null; succeeded: number | null; failed: number | null }>(),
    env.DB.prepare('SELECT status, COUNT(*) AS count FROM runs WHERE project_id = ? GROUP BY status')
      .bind(projectId).all<StatusCount>(),
    env.DB.prepare('SELECT status, COUNT(*) AS count FROM orchestrations WHERE project_id = ? GROUP BY status')
      .bind(projectId).all<StatusCount>(),
    env.DB.prepare('SELECT status, COUNT(*) AS count FROM execution_nodes WHERE project_id = ? GROUP BY status')
      .bind(projectId).all<StatusCount>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM claims c JOIN tasks t ON t.id = c.task_id
        WHERE t.project_id = ? AND c.released_at IS NULL AND c.expires_at > ?`,
    ).bind(projectId, observedAt).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM file_locks
        WHERE project_id = ? AND released_at IS NULL AND expires_at > ?`,
    ).bind(projectId, observedAt).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT r.status, COUNT(DISTINCT r.id) AS count FROM runners r
        WHERE r.project_id = ?1 OR EXISTS (SELECT 1 FROM runs run WHERE run.runner_id = r.id AND run.project_id = ?1)
        GROUP BY r.status`,
    ).bind(projectId).all<StatusCount>(),
    env.DB.prepare(
      `SELECT ap.state AS status, COUNT(*) AS count FROM agent_presences ap
        WHERE ap.kind = 'runner_daemon' AND ap.archived_at IS NULL
          AND (ap.project_id = ?1 OR EXISTS (SELECT 1 FROM runs run WHERE run.runner_id = ap.runner_id AND run.project_id = ?1))
        GROUP BY ap.state`,
    ).bind(projectId).all<StatusCount>(),
  ]);
  let orchestrationAcceptedAt: string | null = null;
  try {
    orchestrationAcceptedAt = (JSON.parse(watermarks.orchestrationWatermark) as { eventAcceptedAt?: string | null }).eventAcceptedAt ?? null;
  } catch { /* current-state data remains usable if a legacy watermark is malformed */ }
  const nodes = countRows(nodeStatuses.results);
  return {
    observedAt,
    source: 'd1_current_state',
    watermarks: { coordinationEventSequence: watermarks.eventWatermark, orchestrationAcceptedAt },
    readiness: {
      totalTasks: readiness?.totalTasks ?? 0,
      readyTasks: readiness?.readyTasks ?? 0,
      blockedTasks: readiness?.blockedTasks ?? 0,
      inProgressTasks: readiness?.inProgressTasks ?? 0,
      reviewTasks: readiness?.reviewTasks ?? 0,
    },
    plans: {
      statuses: countRows(planStatuses.results),
      dispatchStatuses: countRows(dispatchStatuses.results),
      phaseGateStatuses: countRows(gateStatuses.results),
      phasesWithoutGate: phaseCounts?.withoutGate ?? 0,
      landings: {
        recorded: landing?.recorded ?? 0,
        owed: landing?.owed ?? 0,
        succeeded: landing?.succeeded ?? 0,
        failed: landing?.failed ?? 0,
      },
    },
    execution: {
      runStatuses: countRows(runStatuses.results),
      orchestrationStatuses: countRows(orchestrationStatuses.results),
      nodeStatuses: nodes,
      activeNodes: (nodes.pending ?? 0) + (nodes.running ?? 0),
      parkedNodes: nodes.parked ?? 0,
    },
    coordination: { activeClaims: claims?.count ?? 0, activeLocks: locks?.count ?? 0 },
    runners: { statuses: countRows(runnerStatuses.results), presenceStates: countRows(presenceStates.results) },
  };
}

export async function requestProjectAnalyticsRebuild(
  env: Env,
  projectId: string,
  requestedAt = new Date().toISOString(),
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO memory_analytics_jobs (project_id, requested_at, attempts, last_error, last_attempt_at, next_retry_at)
     VALUES (?, ?, 0, NULL, NULL, NULL)
     ON CONFLICT (project_id) DO UPDATE SET
       requested_at = excluded.requested_at, attempts = 0, last_error = NULL,
       last_attempt_at = NULL, next_retry_at = NULL`,
  ).bind(projectId, requestedAt).run();
}

function retryAt(attempts: number, now: Date): string {
  const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.max(0, attempts - 1)));
  return new Date(now.getTime() + delay).toISOString();
}

function descriptor(projectId: string, row: StoredGeneration | null): AnalyticsGenerationDescriptorData | null {
  if (!row) return null;
  let orchestrationAcceptedAt: string | null = null;
  try {
    orchestrationAcceptedAt = (JSON.parse(row.orchestrationWatermark ?? '{}') as { eventAcceptedAt?: string | null }).eventAcceptedAt ?? null;
  } catch { /* malformed legacy watermark remains unavailable */ }
  return AnalyticsGenerationDescriptor.parse({
    id: row.id,
    projectId,
    state: row.status,
    versions: { extraction: row.extractionVersion, retrieval: null, risk: null, comparison: null },
    sources: {
      memoryRevision: row.sourceMemoryRevision,
      coordinationEventSequence: row.d1EventWatermark,
      orchestrationAcceptedAt,
      capturedAt: row.createdAt,
    },
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    error: row.error,
  });
}

/** Cross-store operational truth. The DO reports what a generation consumed; this adapter reads
 * current D1/orchestration cursors and the durable retry job, then classifies staleness without
 * mutating either authority. */
export async function getProjectAnalyticsHealth(env: Env, projectId: string): Promise<ProjectAnalyticsHealthData> {
  const [stored, current, job, commissioning] = await Promise.all([
    memory(env, projectId).analyticsGenerationHealth(projectId),
    analyticsSourceWatermarks(env, projectId),
    env.DB.prepare(
      `SELECT requested_at AS requestedAt, attempts, last_error AS lastError,
              last_attempt_at AS lastAttemptAt, next_retry_at AS nextRetryAt
         FROM memory_analytics_jobs WHERE project_id = ?`,
    ).bind(projectId).first<{
      requestedAt: string; attempts: number; lastError: string | null;
      lastAttemptAt: string | null; nextRetryAt: string | null;
    }>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM run_sitting_intelligence WHERE project_id = ?')
      .bind(projectId).first<{ n: number }>(),
  ]);
  const capturedAt = new Date().toISOString();
  let currentOrchestrationAcceptedAt: string | null = null;
  try {
    currentOrchestrationAcceptedAt = (JSON.parse(current.orchestrationWatermark) as { eventAcceptedAt?: string | null }).eventAcceptedAt ?? null;
  } catch { /* sourceWatermarks always emits JSON; keep degradation explicit if that ever changes */ }

  const staleSources: Array<'extraction_version' | 'project_memory' | 'coordination' | 'orchestration'> = [];
  const active = stored.active;
  if (active) {
    if (active.extractionVersion !== ANALYTICS_EXTRACTION_VERSION) staleSources.push('extraction_version');
    if (active.sourceMemoryRevision !== stored.memoryRevision) staleSources.push('project_memory');
    if (active.d1EventWatermark !== current.eventWatermark) staleSources.push('coordination');
    if (active.orchestrationWatermark !== current.orchestrationWatermark) staleSources.push('orchestration');
  }
  const activeCompleted = active?.completedAt ? Date.parse(active.completedAt) : -Infinity;
  const failureCompleted = stored.latestFailure?.completedAt ? Date.parse(stored.latestFailure.completedAt) : -Infinity;
  const state = stored.building
    ? 'building'
    : stored.latestFailure && failureCompleted > activeCompleted
      ? 'failed'
      : !active
        ? stored.latestFailure ? 'failed' : 'not_started'
        : staleSources.length ? 'stale' : 'complete';

  return ProjectAnalyticsHealth.parse({
    projectId,
    state,
    extractionVersion: ANALYTICS_EXTRACTION_VERSION,
    active: descriptor(projectId, stored.active),
    building: descriptor(projectId, stored.building),
    latestFailure: descriptor(projectId, stored.latestFailure),
    staleSources,
    lag: {
      memoryRevisions: active ? Math.max(0, stored.memoryRevision - active.sourceMemoryRevision) : null,
      coordinationEvents: active && active.d1EventWatermark != null && current.eventWatermark != null
        ? Math.max(0, current.eventWatermark - active.d1EventWatermark) : null,
      orchestrationChanged: !!active && active.orchestrationWatermark !== current.orchestrationWatermark,
    },
    currentSources: {
      memoryRevision: stored.memoryRevision,
      coordinationEventSequence: current.eventWatermark,
      orchestrationAcceptedAt: currentOrchestrationAcceptedAt,
      capturedAt,
    },
    lastSuccessfulIncrementalAt: stored.lastSuccessfulIncrementalAt,
    lastSuccessfulFullRebuildAt: stored.lastSuccessfulFullRebuildAt,
    retry: {
      pending: !!job,
      attempts: job?.attempts ?? 0,
      requestedAt: job?.requestedAt ?? null,
      lastAttemptAt: job?.lastAttemptAt ?? null,
      nextRetryAt: job?.nextRetryAt ?? null,
      lastError: job?.lastError ?? null,
    },
    storage: {
      canonicalRetainedRows: stored.counts.episodes + (commissioning?.n ?? 0),
      disposableDerivedRows: stored.counts.generations + stored.counts.rows + stored.counts.snapshotRows,
      byKind: {
        episodes: stored.counts.episodes,
        commissioningFacts: commissioning?.n ?? 0,
        analyticsGenerations: stored.counts.generations,
        analyticsRows: stored.counts.rows,
        analyticsSnapshotRows: stored.counts.snapshotRows,
      },
    },
  });
}

export async function rebuildProjectAnalytics(
  env: Env,
  projectId: string,
  opts: { force?: boolean; pageSize?: number } = {},
): Promise<{ generationId: string; rowCount: number; checksum: string; activated: boolean; unchanged: boolean }> {
  const { eventWatermark, orchestrationWatermark } = await analyticsSourceWatermarks(env, projectId);
  const stub = memory(env, projectId);
  const begun = await stub.beginAnalyticsGeneration(projectId, {
    extractionVersion: ANALYTICS_EXTRACTION_VERSION,
    d1EventWatermark: eventWatermark,
    orchestrationWatermark,
    force: opts.force === true,
  });
  if (begun.unchanged) {
    const current = await stub.completeAnalyticsGeneration(projectId, begun.generationId);
    return { ...current, unchanged: true };
  }

  const limit = Math.max(1, Math.min(opts.pageSize ?? SNAPSHOT_PAGE_SIZE, 500));
  try {
    let offset = 0;
    for (;;) {
      const { results } = await env.DB.prepare(
        `SELECT id, orchestration_id AS orchestrationId, parent_execution_id AS parentExecutionId,
                run_id AS runId, sitting, kind, role, stage, status,
                completeness_status AS completenessStatus, completeness_missing AS completenessMissing,
                completeness_reason AS completenessReason, started_at AS startedAt,
                finished_at AS finishedAt, created_at AS createdAt, updated_at AS updatedAt
           FROM execution_nodes WHERE project_id = ? ORDER BY id LIMIT ? OFFSET ?`,
      ).bind(projectId, limit, offset).all<AnalyticsExecutionNodeSnapshot>();
      if (!results.length) break;
      await stub.ingestAnalyticsSnapshot(projectId, begun.generationId, results.map((body) => ({
        sourceKind: 'execution_node' as const, sourceKey: body.id, body,
      })));
      offset += results.length;
      if (results.length < limit) break;
    }

    offset = 0;
    for (;;) {
      const { results } = await env.DB.prepare(
        `SELECT e.event_id AS eventId, e.execution_id AS executionId, n.run_id AS runId,
                n.sitting, e.revision,
                e.event_type AS eventType, e.observed_at AS observedAt, e.accepted_at AS acceptedAt
           FROM execution_lifecycle_events e JOIN execution_nodes n ON n.id = e.execution_id
          WHERE n.project_id = ?
          ORDER BY e.event_id LIMIT ? OFFSET ?`,
      ).bind(projectId, limit, offset)
        .all<AnalyticsExecutionEventSnapshot>();
      if (!results.length) break;
      await stub.ingestAnalyticsSnapshot(projectId, begun.generationId, results.map((body) => ({
        sourceKind: 'execution_event' as const, sourceKey: body.eventId, body,
      })));
      offset += results.length;
      if (results.length < limit) break;
    }

    const after = await analyticsSourceWatermarks(env, projectId);
    if (after.eventWatermark !== eventWatermark || after.orchestrationWatermark !== orchestrationWatermark) {
      throw new Error('analytics D1 snapshot changed during replay; retrying from new watermarks');
    }
    const complete = await stub.completeAnalyticsGeneration(projectId, begun.generationId);
    return { ...complete, unchanged: false };
  } catch (error) {
    await stub.failAnalyticsGeneration(projectId, begun.generationId, String(error)).catch(() => {});
    throw error;
  }
}

export async function processAnalyticsJob(env: Env, projectId: string): Promise<boolean> {
  const job = await env.DB.prepare(
    `SELECT requested_at AS requestedAt, attempts, next_retry_at AS nextRetryAt
       FROM memory_analytics_jobs WHERE project_id = ?`,
  ).bind(projectId).first<{ requestedAt: string; attempts: number; nextRetryAt: string | null }>();
  if (!job) return false;
  if (job.nextRetryAt && Date.parse(job.nextRetryAt) > Date.now()) return false;
  try {
    await rebuildProjectAnalytics(env, projectId);
    await env.DB.prepare('DELETE FROM memory_analytics_jobs WHERE project_id = ? AND requested_at = ?')
      .bind(projectId, job.requestedAt).run();
    return true;
  } catch (error) {
    const attemptedAt = new Date();
    const attempts = job.attempts + 1;
    await env.DB.prepare(
      `UPDATE memory_analytics_jobs SET attempts = ?, last_error = ?, last_attempt_at = ?, next_retry_at = ?
        WHERE project_id = ?`,
    ).bind(attempts, String(error).slice(0, 4_000), attemptedAt.toISOString(), retryAt(attempts, attemptedAt), projectId).run();
    throw error;
  }
}

export async function sweepPendingAnalyticsJobs(
  env: Env,
  limit = 10,
): Promise<{ completed: number; failed: number }> {
  const { results } = await env.DB.prepare(
    `SELECT project_id AS projectId FROM memory_analytics_jobs
      WHERE next_retry_at IS NULL OR next_retry_at <= ? ORDER BY requested_at LIMIT ?`,
  ).bind(new Date().toISOString(), limit).all<{ projectId: string }>();
  let completed = 0;
  let failed = 0;
  for (const row of results) {
    try { if (await processAnalyticsJob(env, row.projectId)) completed++; }
    catch (error) {
      failed++;
      console.warn(`analytics rebuild for ${row.projectId} failed: ${String(error)}`);
    }
  }
  return { completed, failed };
}
