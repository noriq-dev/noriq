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

/**
 * Narrow to the projects THIS TOKEN was authorized for (RUN-38). Composes with
 * USER_PROJECT_WHERE — a token can never exceed its user, only be narrower:
 *
 *   WHERE ${USER_PROJECT_WHERE} AND ${tokenProjectWhere('?3')}
 *
 * `param` is the bind placeholder holding the token id (e.g. '?3'), so callers keep control
 * of their own numbering.
 *
 * `scoped_at IS NULL` means UNSCOPED, deliberately (see 0027): tokens minted before scoping
 * existed reach everything their user can, because invalidating them would sign every human
 * out and kill every live runner mid-run.
 *
 * Note it keys off `scoped_at`, NOT off row-absence. A scoped token may legitimately have zero
 * projects — a brand-new user has none to tick — and "scoped to nothing" must never collapse
 * into "reaches everything". They are exact opposites.
 *
 * The rule lives here, in SQL, rather than as a JS set each caller re-derives: a second copy
 * of it is precisely what drifts and silently unlocks a fleet. Assumes projects aliased `p`.
 */
export const tokenProjectWhere = (param: string) => `(
  NOT EXISTS (SELECT 1 FROM oauth_tokens WHERE id = ${param} AND scoped_at IS NOT NULL)
  OR EXISTS (SELECT 1 FROM oauth_tokens WHERE id = ${param} AND scope_all = 1)
  OR p.id IN (SELECT project_id FROM oauth_token_projects WHERE token_id = ${param})
)`;

/** Whether a token may reach one project — the single-project mirror of tokenProjectWhere,
 *  for the central MCP tool guard. Unscoped (legacy) tokens pass; so do "All projects" ones
 *  (RUN-58); a specifically-scoped token must list it. Keep the three cases in lockstep with
 *  tokenProjectWhere above — they are one rule wearing two shapes. */
export async function tokenCanReachProject(env: Env, tokenId: string, projectId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM oauth_tokens WHERE id = ?1 AND scoped_at IS NOT NULL) AS scoped,
       (SELECT COUNT(*) FROM oauth_tokens WHERE id = ?1 AND scope_all = 1) AS scopeAll,
       (SELECT COUNT(*) FROM oauth_token_projects WHERE token_id = ?1 AND project_id = ?2) AS allowed`,
  ).bind(tokenId, projectId).first<{ scoped: number; scopeAll: number; allowed: number }>();
  return !row?.scoped || row.scopeAll > 0 || row.allowed > 0;
}

// Plan-level approval gate (RUN-23): a task belonging to a *proposed* plan (a scope
// agent's un-approved output) is NOT claimable/dispatchable until a human approves
// the plan (proposed → active). Gating is plan-level only for v1 — the task itself
// stays `todo`; this clause hides it from the claimable surface until its plan is
// active. Assumes the tasks table is aliased `t`. Use as: `AND ${TASK_NOT_IN_PROPOSED_PLAN}`.
export const TASK_NOT_IN_PROPOSED_PLAN = `NOT EXISTS (
  SELECT 1 FROM phase_tasks pt
    JOIN phases ph ON ph.id = pt.phase_id
    JOIN plans pl ON pl.id = ph.plan_id
  WHERE pt.task_id = t.id AND pl.status = 'proposed'
)`;

/** Whether a user may access a specific project (owned / group / ownerless). */
export async function userCanAccessProject(env: Env, userId: string, projectId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM projects p WHERE p.id = ?2 AND ${USER_PROJECT_WHERE}`,
  ).bind(userId, projectId).first();
  return !!row;
}
