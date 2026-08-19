// Shared claim-gate logic (PLNR-177) so claim_task (the mutating arbiter in ProjectRoom)
// and can_claim (the read-only probe the runner backstop calls, RUN-81) can't drift.
//
// Phase order gates directly off phase membership since PLNR-163 (plans mint no dependency
// rows); the 'landed' exception mirrors the plan-dispatch pump (PLNR-170/176).

// Only a fresh `todo` surfaces as claimable to the read-only probe (PLNR-116 dropped the
// vestigial `claimed` status that nothing ever set). The mutating arbiter in claim_task
// additionally accepts an `in_progress` task whose claim has lapsed in the expiry→alarm
// window; the probe stays conservative there — it never offered in_progress work anyway.
const CLAIMABLE_STATUSES = ['todo'];

export type ClaimabilityReason = 'claimable' | 'status' | 'spin_off_approval' | 'plan_approval' | 'dependency';
export type ClaimBlocker = {
  taskId: string;
  key: string;
  status: string;
  source: 'dependency' | 'phase';
  landedRun: boolean;
};

type ClaimTaskFacts = {
  id: string;
  key: string;
  status: string;
  proposedAt: string | null;
};

/** D1 caps the number of bound SQL variables per statement. Pass bounded task ids through
 * json_each as one parameter so project-wide claimability does not multiply that count across
 * the dependency and phase arms of the blocker query. */
const requestedTasksCte = `requested_tasks(id) AS (
  SELECT CAST(value AS TEXT) FROM json_each(?1)
)`;

async function claimGates(db: D1Database, taskIds: string[]): Promise<Map<string, 'strict' | 'landed'>> {
  if (!taskIds.length) return new Map();
  const { results } = await db.prepare(
    `WITH ${requestedTasksCte}
     SELECT pt.task_id AS taskId, pd.gate, pd.created_at AS createdAt
       FROM requested_tasks requested JOIN phase_tasks pt ON pt.task_id = requested.id
       JOIN phases ph ON ph.id = pt.phase_id
       JOIN plan_dispatches pd ON pd.plan_id = ph.plan_id
      WHERE pd.status = 'active'
      ORDER BY pd.created_at DESC, pd.id DESC`,
  ).bind(JSON.stringify(taskIds)).all<{ taskId: string; gate: string; createdAt: string }>();
  const gates = new Map<string, 'strict' | 'landed'>();
  for (const row of results) if (!gates.has(row.taskId)) gates.set(row.taskId, row.gate === 'landed' ? 'landed' : 'strict');
  return gates;
}

async function proposedPlanTasks(db: D1Database, taskIds: string[]): Promise<Set<string>> {
  if (!taskIds.length) return new Set();
  const { results } = await db.prepare(
    `WITH ${requestedTasksCte}
     SELECT DISTINCT pt.task_id AS taskId
       FROM requested_tasks requested JOIN phase_tasks pt ON pt.task_id = requested.id
       JOIN phases ph ON ph.id = pt.phase_id JOIN plans pl ON pl.id = ph.plan_id
      WHERE pl.status = 'proposed'`,
  ).bind(JSON.stringify(taskIds)).all<{ taskId: string }>();
  return new Set(results.map((row) => row.taskId));
}

async function blockerRows(db: D1Database, taskIds: string[]): Promise<Map<string, ClaimBlocker[]>> {
  if (!taskIds.length) return new Map();
  const { results } = await db.prepare(
    `WITH ${requestedTasksCte}
     SELECT d.task_id AS taskId, blocker.id AS blockerTaskId, blocker.key, blocker.status,
            'dependency' AS source,
            (EXISTS(SELECT 1 FROM runs r WHERE r.anchor_type = 'task' AND r.anchor_id = blocker.id AND r.status = 'done')
             OR EXISTS(SELECT 1 FROM mission_task_attempts ma
                        JOIN mission_handoffs mh ON mh.root_run_id = ma.root_run_id
                       WHERE ma.task_id = blocker.id AND ma.status = 'review' AND ma.outcome = 'done'
                         AND mh.consumed_at IS NOT NULL)) AS landedRun
       FROM requested_tasks requested JOIN dependencies d ON d.task_id = requested.id
       JOIN tasks blocker ON blocker.id = d.depends_on_task_id
      WHERE blocker.status NOT IN ('done','cancelled')
      UNION ALL
     SELECT pt.task_id AS taskId, blocker.id AS blockerTaskId, blocker.key, blocker.status,
            'phase' AS source,
            (EXISTS(SELECT 1 FROM runs r WHERE r.anchor_type = 'task' AND r.anchor_id = blocker.id AND r.status = 'done')
             OR EXISTS(SELECT 1 FROM mission_task_attempts ma
                        JOIN mission_handoffs mh ON mh.root_run_id = ma.root_run_id
                       WHERE ma.task_id = blocker.id AND ma.status = 'review' AND ma.outcome = 'done'
                         AND mh.consumed_at IS NOT NULL)) AS landedRun
       FROM requested_tasks requested JOIN phase_tasks pt ON pt.task_id = requested.id
       JOIN phases ph ON ph.id = pt.phase_id
       JOIN plans pl ON pl.id = ph.plan_id AND pl.status != 'rejected'
       JOIN phases prev ON prev.plan_id = ph.plan_id AND prev."order" < ph."order"
       JOIN phase_tasks ppt ON ppt.phase_id = prev.id JOIN tasks blocker ON blocker.id = ppt.task_id
      WHERE blocker.status NOT IN ('done','cancelled')`,
  ).bind(JSON.stringify(taskIds)).all<{
    taskId: string; blockerTaskId: string; key: string; status: string;
    source: 'dependency' | 'phase'; landedRun: number;
  }>();
  const byTask = new Map<string, ClaimBlocker[]>();
  const seen = new Set<string>();
  for (const row of results) {
    const dedupe = `${row.taskId}:${row.blockerTaskId}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const list = byTask.get(row.taskId) ?? [];
    list.push({ taskId: row.blockerTaskId, key: row.key, status: row.status, source: row.source, landedRun: !!row.landedRun });
    byTask.set(row.taskId, list);
  }
  for (const list of byTask.values()) list.sort((a, b) => a.key.localeCompare(b.key));
  return byTask;
}

function activeBlockers(blockers: ClaimBlocker[], gate: 'strict' | 'landed'): ClaimBlocker[] {
  return blockers.filter((blocker) => gate !== 'landed' || blocker.status !== 'review' || !blocker.landedRun);
}

/** Everything standing between this task and workability: manual dependency edges plus
 *  unfinished tasks in earlier phases of its plan. Under gate='landed' a blocker in review
 *  whose run has landed does not block. The exception fragments are fixed literals composed
 *  per alias, never input. Returns the blocking task KEYS (for a human-readable reason). */
export async function unfinishedDeps(
  db: D1Database,
  taskId: string,
  gate: 'strict' | 'landed' = 'strict',
): Promise<string[]> {
  const rows = (await blockerRows(db, [taskId])).get(taskId) ?? [];
  return activeBlockers(rows, gate).map((row) => row.key);
}

export interface Claimability {
  claimable: boolean;
  reason?: string;
  taskKey: string;
  reasonCode: ClaimabilityReason;
  gate: 'strict' | 'landed';
  blockers: ClaimBlocker[];
}

function evaluateClaimability(
  task: ClaimTaskFacts,
  gate: 'strict' | 'landed',
  proposedPlan: boolean,
  blockers: ClaimBlocker[],
): Claimability {
  if (!CLAIMABLE_STATUSES.includes(task.status)) {
    return {
      claimable: false, taskKey: task.key, reasonCode: 'status', gate, blockers: [],
      reason: `not claimable yet (status: ${task.status})`,
    };
  }
  if (task.proposedAt) {
    return {
      claimable: false, taskKey: task.key, reasonCode: 'spin_off_approval', gate, blockers: [],
      reason: 'it is a proposed task — awaiting human acceptance',
    };
  }
  if (proposedPlan) {
    return {
      claimable: false, taskKey: task.key, reasonCode: 'plan_approval', gate, blockers: [],
      reason: 'its plan is still proposed — awaiting human approval',
    };
  }
  const active = activeBlockers(blockers, gate);
  if (active.length) {
    return {
      claimable: false, taskKey: task.key, reasonCode: 'dependency', gate, blockers: active,
      reason: `blocked until these finish: ${active.map((item) => item.key).join(', ')}`,
    };
  }
  return { claimable: true, taskKey: task.key, reasonCode: 'claimable', gate, blockers: [] };
}

/** Would a normal (pool, non-anchored) claim of this task succeed right now? The gate is
 *  read from the task's active plan_dispatch — 'approved' (strict, the default) or the
 *  opted-in 'landed' — so the answer equals what claim_task decides for that run, minus the
 *  anchored-agent bypass. This is exactly the gate the backstop must surface. */
export async function taskClaimability(db: D1Database, taskId: string): Promise<Claimability> {
  const task = await db
    .prepare('SELECT id, key, status, proposed_at AS proposedAt FROM tasks WHERE id = ? OR key = ?')
    .bind(taskId, taskId)
    .first<{ id: string; key: string; status: string; proposedAt: string | null }>();
  if (!task) throw new Error(`task ${taskId} not found`);
  const [gates, proposed, blockers] = await Promise.all([
    claimGates(db, [task.id]), proposedPlanTasks(db, [task.id]), blockerRows(db, [task.id]),
  ]);
  return evaluateClaimability(
    task, gates.get(task.id) ?? 'strict', proposed.has(task.id), blockers.get(task.id) ?? [],
  );
}

/** Bounded project read that uses the exact same evaluator and blocker source as can_claim. */
export async function projectTaskClaimability(
  db: D1Database,
  projectId: string,
  limit = 100,
): Promise<{ items: Array<ClaimTaskFacts & { claimability: Claimability }>; truncated: boolean }> {
  const bounded = Math.min(200, Math.max(1, Math.trunc(limit)));
  const { results } = await db.prepare(
    `SELECT id, key, status, proposed_at AS proposedAt FROM tasks
      WHERE project_id = ? AND status NOT IN ('done','cancelled')
      ORDER BY priority ASC, "order" ASC, key ASC LIMIT ?`,
  ).bind(projectId, bounded + 1).all<ClaimTaskFacts>();
  const tasks = results.slice(0, bounded);
  const ids = tasks.map((task) => task.id);
  const [gates, proposed, blockers] = await Promise.all([
    claimGates(db, ids), proposedPlanTasks(db, ids), blockerRows(db, ids),
  ]);
  return {
    items: tasks.map((task) => ({
      ...task,
      claimability: evaluateClaimability(
        task, gates.get(task.id) ?? 'strict', proposed.has(task.id), blockers.get(task.id) ?? [],
      ),
    })),
    truncated: results.length > bounded,
  };
}
