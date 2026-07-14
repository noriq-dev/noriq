// Project visibility helpers (PLNR-48 / PLNR-83).
//
// USER_PROJECT_WHERE is the set of projects a *user* may reach: ones they own
// (private), plus ones in a group they belong to (shared with that group's
// members — NOT with everyone). There is intentionally no "ownerless → everyone"
// escape hatch; every project has an owner (migration 0014 / create_project), so a
// project you don't own and whose group you aren't in is simply not visible.
//
// It deliberately OMITS the admin-sees-all escalation — an agent (even an admin's,
// over MCP) is scoped to what the user can reach, never to admin. The web UI adds
// the admin escalation separately, and only when an admin opts into "admin view".
//
// Bind the user id as ?1 (the caller supplies the rest of the query). Assumes the
// projects table is aliased `p`.
import type { Env } from '../env';

export const USER_PROJECT_WHERE = `(
  p.owner_user_id = ?1
  OR (p.group_id IS NOT NULL AND p.group_id IN (SELECT group_id FROM user_groups WHERE user_id = ?1))
)`;

/** Whether a user may access a specific project (owned / group / ownerless). */
export async function userCanAccessProject(env: Env, userId: string, projectId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM projects p WHERE p.id = ?2 AND ${USER_PROJECT_WHERE}`,
  ).bind(userId, projectId).first();
  return !!row;
}
