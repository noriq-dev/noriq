import { subjectFreshness } from './entity-validation-store';

/** SQL has already applied status, approval and dependency gates. Fast-path untouched legacy tasks. */
export async function filterFreshTasks<T extends { id: string; projectId: string }>(db: D1Database, tasks: T[]): Promise<T[]> {
  if (!tasks.length) return [];
  const { results } = await db.prepare(`SELECT t.id FROM tasks t WHERE t.id IN (SELECT value FROM json_each(?)) AND (
    EXISTS (SELECT 1 FROM entity_validations v WHERE v.subject_id = t.id AND v.subject_type = 'task') OR
    EXISTS (SELECT 1 FROM entity_assessments a WHERE a.subject_id = t.id AND a.subject_type = 'task') OR
    EXISTS (SELECT 1 FROM phase_tasks pt JOIN phases ph ON ph.id = pt.phase_id JOIN plans p ON p.id = ph.plan_id
      WHERE pt.task_id = t.id AND p.readiness_required = 1 AND p.status != 'rejected') OR
    EXISTS (SELECT 1 FROM task_docs td JOIN docs d ON d.id = td.doc_id WHERE td.task_id = t.id AND td.pinned_version != d.current_version)
  )`).bind(JSON.stringify(tasks.map(t => t.id))).all<{id:string}>();
  const needsCheck = new Set(results.map(r => r.id));
  const eligible: T[] = [];
  for (const t of tasks) {
    if (!needsCheck.has(t.id) || !(await subjectFreshness(db, t.projectId, 'task', t.id)).criticalCauses.length) eligible.push(t);
  }
  return eligible;
}
