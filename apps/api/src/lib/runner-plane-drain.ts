import type { Env } from '../env';
import type { Actor } from '../do/ProjectRoom';
import { RUNNER_PLANE_DRAIN_REASON } from './runner-disabled';

export interface RunnerPlaneDrainSummary {
  projects: number;
  cancelledJobs: number;
  cancelledRuns: number;
  cancelledDispatches: number;
  reason: string;
}

const SYSTEM_ACTOR: Actor = { kind: 'system', id: 'system', name: 'runner-plane-drain' };

/** Cancel every live runner job, legacy run, and plan-dispatch pump in the database. */
export async function drainRunnerPlane(
  env: Env,
  reason: string = RUNNER_PLANE_DRAIN_REASON,
): Promise<RunnerPlaneDrainSummary> {
  const { results: projectRows } = await env.DB.prepare(
    `SELECT DISTINCT project_id AS projectId FROM (
       SELECT project_id FROM runner_jobs
        WHERE status IN ('queued','assigned','running','waiting')
       UNION
       SELECT project_id FROM runs
        WHERE status IN ('queued','dispatched','running','blocked','waiting')
       UNION
       SELECT project_id FROM plan_dispatches
        WHERE status IN ('active','stalled')
     )`,
  ).all<{ projectId: string }>();

  let cancelledJobs = 0;
  let cancelledRuns = 0;
  let cancelledDispatches = 0;
  for (const { projectId } of projectRows) {
    const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(projectId));
    const partial = await stub.drainRunnerPlane(projectId, SYSTEM_ACTOR, reason);
    cancelledJobs += partial.cancelledJobs;
    cancelledRuns += partial.cancelledRuns;
    cancelledDispatches += partial.cancelledDispatches;
  }
  return {
    projects: projectRows.length,
    cancelledJobs,
    cancelledRuns,
    cancelledDispatches,
    reason,
  };
}
