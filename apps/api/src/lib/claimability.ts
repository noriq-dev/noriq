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

/** Everything standing between this task and workability: manual dependency edges plus
 *  unfinished tasks in earlier phases of its plan. Under gate='landed' a blocker in review
 *  whose run has landed does not block. The exception fragments are fixed literals composed
 *  per alias, never input. Returns the blocking task KEYS (for a human-readable reason). */
export async function unfinishedDeps(
  db: D1Database,
  taskId: string,
  gate: 'strict' | 'landed' = 'strict',
): Promise<string[]> {
  const landedOk = (alias: string) =>
    gate === 'landed'
      ? `AND NOT (${alias}.status = 'review' AND EXISTS (
           SELECT 1 FROM runs dr WHERE dr.anchor_type = 'task' AND dr.anchor_id = ${alias}.id AND dr.status = 'done'))`
      : '';
  const { results } = await db
    .prepare(
      `SELECT t.key FROM dependencies d JOIN tasks t ON t.id = d.depends_on_task_id
       WHERE d.task_id = ?1 AND t.status NOT IN ('done','cancelled') ${landedOk('t')}
       UNION
       SELECT pdt.key FROM phase_tasks pt
         JOIN phases ph   ON ph.id = pt.phase_id
         JOIN plans  pl   ON pl.id = ph.plan_id AND pl.status != 'rejected'
         JOIN phases prev ON prev.plan_id = ph.plan_id AND prev."order" < ph."order"
         JOIN phase_tasks ppt ON ppt.phase_id = prev.id
         JOIN tasks pdt   ON pdt.id = ppt.task_id
       WHERE pt.task_id = ?1 AND pdt.status NOT IN ('done','cancelled') ${landedOk('pdt')}`,
    )
    .bind(taskId)
    .all<{ key: string }>();
  return results.map((r) => r.key);
}

export interface Claimability {
  claimable: boolean;
  reason?: string;
  taskKey: string;
}

/** Would a normal (pool, non-anchored) claim of this task succeed right now? The gate is
 *  read from the task's active plan_dispatch — 'approved' (strict, the default) or the
 *  opted-in 'landed' — so the answer equals what claim_task decides for that run, minus the
 *  anchored-agent bypass. This is exactly the gate the backstop must surface. */
export async function taskClaimability(db: D1Database, taskId: string): Promise<Claimability> {
  const task = await db
    .prepare('SELECT id, key, status FROM tasks WHERE id = ? OR key = ?')
    .bind(taskId, taskId)
    .first<{ id: string; key: string; status: string }>();
  if (!task) throw new Error(`task ${taskId} not found`);

  if (!CLAIMABLE_STATUSES.includes(task.status)) {
    return { claimable: false, taskKey: task.key, reason: `not claimable yet (status: ${task.status})` };
  }
  const proposed = await db
    .prepare(
      `SELECT 1 FROM phase_tasks pt JOIN phases ph ON ph.id = pt.phase_id JOIN plans pl ON pl.id = ph.plan_id
       WHERE pt.task_id = ? AND pl.status = 'proposed'`,
    )
    .bind(task.id)
    .first();
  if (proposed) {
    return { claimable: false, taskKey: task.key, reason: 'its plan is still proposed — awaiting human approval' };
  }
  const disp = await db
    .prepare(
      `SELECT pd.gate FROM plan_dispatches pd
         JOIN phases ph ON ph.plan_id = pd.plan_id
         JOIN phase_tasks pt ON pt.phase_id = ph.id
       WHERE pt.task_id = ? AND pd.status = 'active' ORDER BY pd.created_at DESC LIMIT 1`,
    )
    .bind(task.id)
    .first<{ gate: string }>();
  const gate = disp?.gate === 'landed' ? 'landed' : 'strict';
  const blockers = await unfinishedDeps(db, task.id, gate);
  if (blockers.length) {
    return { claimable: false, taskKey: task.key, reason: `blocked until these finish: ${blockers.join(', ')}` };
  }
  return { claimable: true, taskKey: task.key };
}
