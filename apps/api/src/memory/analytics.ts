// PLNR-292: bounded D1 -> ProjectMemory replay for disposable analytics generations. D1 remains
// canonical for orchestration; ProjectMemory remains canonical for episodes. This adapter only
// copies bounded structural facts into a building generation, then asks the memory authority to
// validate and atomically publish derived rows.
import type { Env } from '../env';

export const ANALYTICS_EXTRACTION_VERSION = 'project-intelligence-v1';
const SNAPSHOT_PAGE_SIZE = 200;

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
};

const memory = (env: Env, projectId: string): AnalyticsMemoryRpc =>
  env.PROJECT_MEMORY.get(env.PROJECT_MEMORY.idFromName(projectId)) as unknown as AnalyticsMemoryRpc;

async function sourceWatermarks(env: Env, projectId: string): Promise<{
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

export async function rebuildProjectAnalytics(
  env: Env,
  projectId: string,
  opts: { force?: boolean; pageSize?: number } = {},
): Promise<{ generationId: string; rowCount: number; checksum: string; activated: boolean; unchanged: boolean }> {
  const { eventWatermark, orchestrationWatermark } = await sourceWatermarks(env, projectId);
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

    const after = await sourceWatermarks(env, projectId);
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
  const job = await env.DB.prepare('SELECT requested_at AS requestedAt FROM memory_analytics_jobs WHERE project_id = ?')
    .bind(projectId).first<{ requestedAt: string }>();
  if (!job) return false;
  try {
    await rebuildProjectAnalytics(env, projectId);
    await env.DB.prepare('DELETE FROM memory_analytics_jobs WHERE project_id = ? AND requested_at = ?')
      .bind(projectId, job.requestedAt).run();
    return true;
  } catch (error) {
    await env.DB.prepare(
      `UPDATE memory_analytics_jobs SET attempts = attempts + 1, last_error = ?, last_attempt_at = ?
        WHERE project_id = ?`,
    ).bind(String(error), new Date().toISOString(), projectId).run();
    throw error;
  }
}

export async function sweepPendingAnalyticsJobs(
  env: Env,
  limit = 10,
): Promise<{ completed: number; failed: number }> {
  const { results } = await env.DB.prepare(
    'SELECT project_id AS projectId FROM memory_analytics_jobs ORDER BY requested_at LIMIT ?',
  ).bind(limit).all<{ projectId: string }>();
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
