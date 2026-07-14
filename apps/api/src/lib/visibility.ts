// Project visibility helpers (PLNR-48 / PLNR-83).
//
// USER_PROJECT_WHERE is the set of projects a *user* may reach: ones they own,
// ANY project that belongs to a group (grouped projects are shared/visible to all
// users — PLNR-83), or legacy/agent-created projects with no owner. Only an
// ungrouped project owned by someone else is private.
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
  OR p.group_id IS NOT NULL
  OR (p.group_id IS NULL AND p.owner_user_id IS NULL)
)`;

/** Whether a user may access a specific project (owned / group / ownerless). */
export async function userCanAccessProject(env: Env, userId: string, projectId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM projects p WHERE p.id = ?2 AND ${USER_PROJECT_WHERE}`,
  ).bind(userId, projectId).first();
  return !!row;
}
