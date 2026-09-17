import type { D1Database } from '@cloudflare/workers-types';
import { nowIso } from '../../lib/util';

/** Tables that intentionally survive project deletion (see CLAUDE.md). */
export const DELETE_PROJECT_EXEMPT_TABLES = new Set([
  'projects',
  'memory_erasure_tombstones',
  'event_seq',
  'templates',
  'authorization_audit',
]);

const TASKS_SUBQUERY = 'SELECT id FROM tasks WHERE project_id = ?';

/** Raw SQL templates (order is load-bearing). */
export const DELETE_PROJECT_BATCH_SQL: readonly string[] = [
  'DELETE FROM runner_coordination_waits WHERE project_id = ?',
  'DELETE FROM runner_coordination_leases WHERE project_id = ?',
  'DELETE FROM runner_coordination_fences WHERE project_id = ?',
  'DELETE FROM runner_job_questions WHERE job_id IN (SELECT id FROM runner_jobs WHERE project_id = ?)',
  'DELETE FROM runner_job_observations WHERE job_id IN (SELECT id FROM runner_jobs WHERE project_id = ?)',
  'DELETE FROM runner_job_routes WHERE job_id IN (SELECT id FROM runner_jobs WHERE project_id = ?)',
  'DELETE FROM runner_job_events WHERE job_id IN (SELECT id FROM runner_jobs WHERE project_id = ?)',
  'DELETE FROM runner_job_intelligence_tasks WHERE project_id = ?',
  'DELETE FROM runner_job_intelligence_jobs WHERE project_id = ?',
  'DELETE FROM runner_job_episode_jobs WHERE project_id = ?',
  'DELETE FROM runner_job_items WHERE job_id IN (SELECT id FROM runner_jobs WHERE project_id = ?)',
  'DELETE FROM runner_jobs WHERE project_id = ?',
  'DELETE FROM similar_effort_feedback WHERE project_id = ?',
  'DELETE FROM similar_effort_occurrences WHERE project_id = ?',
  'DELETE FROM project_quality_events WHERE project_id = ?',
  'DELETE FROM ask_actions WHERE project_id = ?',
  `DELETE FROM phase_tasks WHERE task_id IN (${TASKS_SUBQUERY}) OR phase_id IN (SELECT id FROM phases WHERE plan_id IN (SELECT id FROM plans WHERE project_id = ?))`,
  `DELETE FROM dependencies WHERE task_id IN (${TASKS_SUBQUERY}) OR depends_on_task_id IN (${TASKS_SUBQUERY})`,
  `DELETE FROM claims WHERE task_id IN (${TASKS_SUBQUERY})`,
  'DELETE FROM file_locks WHERE project_id = ?',
  `DELETE FROM task_refs WHERE task_id IN (${TASKS_SUBQUERY})`,
  `DELETE FROM task_tags WHERE task_id IN (${TASKS_SUBQUERY}) OR tag_id IN (SELECT id FROM tags WHERE project_id = ?)`,
  `DELETE FROM task_docs WHERE task_id IN (${TASKS_SUBQUERY}) OR doc_id IN (SELECT id FROM docs WHERE project_id = ?)`,
  'DELETE FROM doc_tags WHERE doc_id IN (SELECT id FROM docs WHERE project_id = ?)',
  'DELETE FROM doc_versions WHERE doc_id IN (SELECT id FROM docs WHERE project_id = ?)',
  `DELETE FROM comments WHERE task_id IN (${TASKS_SUBQUERY})`,
  `DELETE FROM attachments WHERE task_id IN (${TASKS_SUBQUERY})`,
  'DELETE FROM signals WHERE project_id = ?',
  'DELETE FROM messages WHERE project_id = ?',
  'DELETE FROM events WHERE project_id = ?',
  'DELETE FROM run_log_segments WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)',
  'DELETE FROM runtime_deliveries WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)',
  'DELETE FROM steers WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)',
  'DELETE FROM execution_profile_leases WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)',
  'DELETE FROM memory_episode_jobs WHERE project_id = ?',
  'DELETE FROM memory_analytics_jobs WHERE project_id = ?',
  'DELETE FROM orchestration_rejections WHERE project_id = ?',
  'DELETE FROM orchestrations WHERE project_id = ?',
  'DELETE FROM runs WHERE project_id = ?',
  'DELETE FROM plan_dispatches WHERE project_id = ?',
  'DELETE FROM plan_landings WHERE project_id = ?',
  'UPDATE runners SET project_id = NULL WHERE project_id = ?',
  'DELETE FROM phase_gates WHERE phase_id IN (SELECT id FROM phases WHERE plan_id IN (SELECT id FROM plans WHERE project_id = ?))',
  'DELETE FROM phases WHERE plan_id IN (SELECT id FROM plans WHERE project_id = ?)',
  'DELETE FROM plan_docs WHERE project_id = ?',
  'DELETE FROM plans WHERE project_id = ?',
  'DELETE FROM docs WHERE project_id = ?',
  "UPDATE agents SET project_id = NULL, status = 'offline' WHERE project_id = ?",
  'UPDATE tasks SET parent_task_id = NULL WHERE project_id = ?',
  'DELETE FROM tasks WHERE project_id = ?',
  'DELETE FROM tags WHERE project_id = ?',
  'DELETE FROM milestones WHERE project_id = ?',
  'DELETE FROM boards WHERE project_id = ?',
  'DELETE FROM repository_checkouts WHERE project_repository_id IN (SELECT id FROM project_repositories WHERE project_id = ?)',
  'DELETE FROM project_repositories WHERE project_id = ?',
  'DELETE FROM project_memory_registry WHERE project_id = ?',
  'DELETE FROM memory_event_dedup WHERE project_id = ?',
  'DELETE FROM project_grants WHERE project_id = ?',
  `INSERT INTO memory_erasure_tombstones (project_id, requested_at) VALUES (?, ?)
   ON CONFLICT (project_id) DO NOTHING`,
  'DELETE FROM projects WHERE id = ?',
];

/** Bind counts per statement index — mirrors the historical ProjectRoom.batch binds. */
function bindDeleteProjectStatement(db: D1Database, sql: string, projectId: string, tombstoneAt: string) {
  const pid = projectId;
  if (sql.startsWith('INSERT INTO memory_erasure_tombstones')) {
    return db.prepare(sql).bind(pid, tombstoneAt);
  }
  if (sql.includes('phase_tasks WHERE')) return db.prepare(sql).bind(pid, pid);
  if (sql.includes('dependencies WHERE')) return db.prepare(sql).bind(pid, pid);
  if (sql.includes('task_tags WHERE')) return db.prepare(sql).bind(pid, pid);
  if (sql.includes('task_docs WHERE')) return db.prepare(sql).bind(pid, pid);
  if (sql.startsWith('DELETE FROM projects')) return db.prepare(sql).bind(pid);
  return db.prepare(sql).bind(pid);
}

/** FK-ordered D1 statements for {@link ProjectRoom.deleteProject}. */
export function buildDeleteProjectBatch(db: D1Database, projectId: string, tombstoneAt = nowIso()) {
  return DELETE_PROJECT_BATCH_SQL.map((sql) => bindDeleteProjectStatement(db, sql, projectId, tombstoneAt));
}

/** Tables touched by an explicit DELETE or scoped UPDATE in the delete batch. */
export function deleteProjectExplicitTableTargets(): Set<string> {
  const targets = new Set<string>();
  for (const sql of DELETE_PROJECT_BATCH_SQL) {
    const del = sql.match(/^DELETE FROM ([a-z_][a-z0-9_]*)/i);
    if (del) targets.add(del[1]!);
    const upd = sql.match(/^UPDATE ([a-z_][a-z0-9_]*)/i);
    if (upd) targets.add(upd[1]!);
  }
  return targets;
}

type FkRow = { table: string; from: string; on_delete: string };

async function foreignKeys(db: D1Database, table: string): Promise<FkRow[]> {
  const { results } = await db.prepare(`PRAGMA foreign_key_list(${table})`).all<FkRow>();
  return results ?? [];
}

async function hasProjectIdColumn(db: D1Database, table: string): Promise<boolean> {
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return (results ?? []).some((c) => c.name === 'project_id');
}

async function listUserTables(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  ).all<{ name: string }>();
  return (results ?? []).map((r) => r.name);
}

/** Tables deleted when a parent row in the batch disappears (ON DELETE CASCADE). */
const CASCADE_PARENT_TABLES = new Set([
  'runs',
  'tasks',
  'claims',
  'orchestrations',
  'run_sitting_intelligence',
]);

/**
 * Returns human-readable violations when a project-scoped table is not covered by the delete
 * batch, schema ON DELETE CASCADE/SET NULL on projects(project_id), or {@link DELETE_PROJECT_EXEMPT_TABLES}.
 */
export async function findDeleteProjectCoverageGaps(db: D1Database): Promise<string[]> {
  const explicit = deleteProjectExplicitTableTargets();
  const gaps: string[] = [];

  for (const table of await listUserTables(db)) {
    if (!(await hasProjectIdColumn(db, table))) continue;
    if (DELETE_PROJECT_EXEMPT_TABLES.has(table)) continue;
    if (explicit.has(table)) continue;

    const fks = await foreignKeys(db, table);
    const projectFk = fks.find((fk) => fk.from === 'project_id' && fk.table === 'projects');
    if (projectFk) {
      const action = (projectFk.on_delete || 'NO ACTION').toUpperCase();
      if (action === 'CASCADE' || action === 'SET NULL') continue;
    }

    const cascadesViaParent = fks.some((fk) => {
      if (fk.from === 'project_id') return false;
      const action = (fk.on_delete || 'NO ACTION').toUpperCase();
      if (action !== 'CASCADE') return false;
      return explicit.has(fk.table) || CASCADE_PARENT_TABLES.has(fk.table);
    });
    if (cascadesViaParent) continue;

    gaps.push(`${table}: project_id column with no deleteProject batch coverage`);
  }

  return gaps;
}
