import { subjectFreshness } from './entity-validation-store';
import { taskClaimability } from './claimability';
import { nowIso } from './util';

/** Bounded live facts. Page counts never masquerade as project-wide coverage. */
export async function projectHealth(db: D1Database, projectId: string, offset = 0) {
  const limit = 10;
  const pageOffset = Math.max(0, Math.trunc(offset));
  const [totals, claims, locks, tasks] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS openTasks FROM tasks WHERE project_id = ? AND archived_at IS NULL AND status NOT IN ('done','cancelled')`).bind(projectId).first<{openTasks:number}>(),
    db.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE project_id = ? AND claimed_by IS NOT NULL AND claim_expires_at > ?`).bind(projectId, nowIso()).first<{count:number}>(),
    db.prepare(`SELECT COUNT(*) AS count FROM file_locks WHERE project_id = ? AND released_at IS NULL AND expires_at > ?`).bind(projectId, nowIso()).first<{count:number}>(),
    db.prepare(`SELECT id, key, title, status, priority FROM tasks WHERE project_id = ? AND archived_at IS NULL AND status NOT IN ('done','cancelled')
      ORDER BY priority, "order", id LIMIT ? OFFSET ?`).bind(projectId, limit + 1, pageOffset).all<{id:string;key:string;title:string;status:string;priority:number}>(),
  ]);
  const items = [];
  for (const task of tasks.results.slice(0, limit)) {
    const freshness = await subjectFreshness(db, projectId, 'task', task.id);
    const claimability = await taskClaimability(db, task.id, freshness.criticalCauses);
    const phases = await db.prepare(`SELECT p.id AS planId, p.title AS planTitle, ph.id, ph.title, ph."order" + 1 AS phaseNumber,
      p.status AS planStatus, p.readiness_required AS evidenceRequired FROM phase_tasks pt JOIN phases ph ON ph.id = pt.phase_id
      JOIN plans p ON p.id = ph.plan_id WHERE pt.task_id = ? AND p.archived_at IS NULL ORDER BY p.id, ph."order"`).bind(task.id).all();
    items.push({ ...task, claimability, phases: phases.results,
      readiness: freshness.assessment?.readiness.state ?? 'missing',
      implementation: freshness.assessment?.implementation.state ?? 'missing',
      evidenceRequired: freshness.assessment?.required ?? false,
      projectPolicy: freshness.assessment?.projectPolicy ?? 'legacy',
      directionMarkers: freshness.assessment?.directionMarkers ?? [],
      checkedAt: freshness.assessment?.readiness.record?.createdAt ?? null,
      checkedRevision: freshness.assessment?.readiness.record?.baseId ?? null,
      causes: freshness.causes, blockingCauses: freshness.blockingCauses ?? freshness.criticalCauses,
      overrides: freshness.assessment?.overrides ?? [],
    });
  }
  return { observedAt: nowIso(), totalOpenTasks: totals?.openTasks ?? 0, activeClaims: claims?.count ?? 0, activeLocks: locks?.count ?? 0,
    items, offset: pageOffset, nextOffset: tasks.results.length > limit ? pageOffset + limit : null, pageSize: limit };
}
