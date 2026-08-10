import type { Env } from '../env';
import { search, type SearchKind } from '../search';
import { taskSearchFilters, type TaskSearchFilters } from './search';
import { USER_PROJECT_WHERE, taskWireStatus, tokenProjectWhere } from './visibility';

/**
 * The caller's already-authenticated workspace boundary.
 *
 * Transports remain responsible for authenticating a human or agent and deciding whether
 * human-only admin elevation is appropriate. Workspace operations never infer either choice.
 */
export interface WorkspaceScope {
  userId: string;
  allowAdminOverride?: boolean;
  oauthTokenId?: string | null;
}

export interface WorkspaceProject {
  id: string;
  key: string;
  name: string;
}

export interface WorkspaceTaskSearchInput extends TaskSearchFilters {
  projectId?: string | null;
  limit?: number;
}

export interface WorkspaceSemanticSearchInput {
  query: string;
  projectId?: string | null;
  kinds?: SearchKind[];
  limit?: number;
}

const visibility = (scope: WorkspaceScope, nextParam: number) => {
  const binds: unknown[] = [];
  const userWhere = scope.allowAdminOverride ? '1 = 1' : USER_PROJECT_WHERE;
  if (!scope.allowAdminOverride) binds.push(scope.userId);
  const tokenParam = `?${nextParam + binds.length}`;
  binds.push(scope.oauthTokenId ?? null);
  return { sql: `${userWhere} AND ${tokenProjectWhere(tokenParam)}`, binds };
};

/** List active projects reachable inside an explicit human/agent/token scope. */
export async function listWorkspaceProjects(env: Pick<Env, 'DB'>, scope: WorkspaceScope): Promise<WorkspaceProject[]> {
  const visible = visibility(scope, 1);
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.key, p.name FROM projects p
     WHERE p.status = 'active' AND ${visible.sql}
     ORDER BY p.created_at`,
  ).bind(...visible.binds).all<WorkspaceProject>();
  return results;
}

/** Attribute search shared by REST, MCP, and Ask without transport-specific response shaping. */
export async function searchWorkspaceTasks(env: Pick<Env, 'DB'>, scope: WorkspaceScope, input: WorkspaceTaskSearchInput) {
  const { projectId, limit, ...filters } = input;
  const { sql: filterSql, binds: filterBinds } = taskSearchFilters(filters);
  const visible = visibility(scope, 1);
  const projectParam = `?${visible.binds.length + 1}`;
  const base = `FROM tasks t JOIN projects p ON p.id = t.project_id AND p.status = 'active'
    WHERE ${visible.sql} AND (${projectParam} IS NULL OR t.project_id = ${projectParam})${filterSql}`;
  const allBinds = [...visible.binds, projectId ?? null, ...filterBinds];
  const max = Math.min(Math.max(limit ?? 50, 1), 200);
  const [rows, total] = await Promise.all([
    env.DB.prepare(
      `SELECT t.id, t.key, t.title, ${taskWireStatus('t')} AS status, t.failed_at AS failedAt, t.priority, t.estimate, t.due_at AS dueAt, t.type,
              t.project_id AS projectId, p.key AS projectKey, t.claimed_by AS claimedBy,
              t.milestone_id AS milestoneId, t.open_comments AS openComments, t.updated_at AS updatedAt
       ${base} ORDER BY t.priority ASC, t.updated_at DESC LIMIT ${max}`,
    ).bind(...allBinds).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n ${base}`).bind(...allBinds).first<{ n: number }>(),
  ]);
  return { tasks: rows.results, matched: total?.n ?? rows.results.length, returned: rows.results.length };
}

/** Meaning search whose project set is always derived from the caller scope. */
export async function searchWorkspaceEvidence(env: Env, scope: WorkspaceScope, input: WorkspaceSemanticSearchInput) {
  let projectIds = (await listWorkspaceProjects(env, scope)).map((project) => project.id);
  if (input.projectId) projectIds = projectIds.filter((id) => id === input.projectId);
  return search(env, {
    q: input.query,
    projectIds,
    kinds: input.kinds,
    limit: input.limit,
  });
}
