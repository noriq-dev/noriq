import type { DirectionMarker } from '@noriq-dev/shared';
export async function projectValidationPolicy(db: D1Database, projectId: string) {
  const row = await db.prepare('SELECT validation_policy AS mode, validation_generation AS generation FROM projects WHERE id = ?')
    .bind(projectId).first<{mode:'legacy'|'strict';generation:number}>();
  if (!row) throw new Error('Project not found');
  return row;
}
export async function unresolvedDirections(db: D1Database, projectId: string, taskId: string): Promise<DirectionMarker[]> {
  return (await db.prepare(`SELECT id, task_id AS taskId, source_type AS sourceType, source_id AS sourceId, reason,
    actor_kind AS actorKind, actor_id AS actorId, actor_name AS actorName, created_at AS createdAt
    FROM task_direction_markers WHERE project_id = ? AND task_id = ? AND resolved_at IS NULL ORDER BY created_at,id`)
    .bind(projectId, taskId).all<DirectionMarker>()).results;
}
