import type { Env } from '../env';
import { search, type SearchKind } from '../search';
import { taskSearchFilters, type TaskSearchFilters } from './search';
import { USER_PROJECT_WHERE, taskWireStatus, tokenProjectWhere } from './visibility';
import { readExecutionSpec } from './execution-spec';
import { assembleContextPack } from '../memory/context-pack';
import type { ProjectMemoryStub } from './project-memory';

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

export type WorkspaceReferenceKind = 'project' | 'task' | 'run' | 'signal' | 'doc' | 'plan' | 'memory' | 'episode' | 'comment';

export interface WorkspaceReference {
  kind: WorkspaceReferenceKind;
  id: string;
  key?: string;
  title: string;
  projectId: string;
  projectKey: string;
  projectName: string;
  status?: string;
  updatedAt?: string;
  citation: string;
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

const boundedLimit = (value: unknown, fallback: number, ceiling: number): number => {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(parsed, 1), ceiling);
};

const projectSet = async (env: Pick<Env, 'DB'>, scope: WorkspaceScope, projectId?: string | null) => {
  let projects = await listWorkspaceProjects(env, scope);
  if (projectId) projects = projects.filter((project) => project.id === projectId);
  return { projects, byId: new Map(projects.map((project) => [project.id, project])) };
};

const inClause = (ids: string[]): string => ids.map(() => '?').join(',');

const page = <T extends { matched?: number | string }>(rows: T[]) => ({
  items: rows.map(({ matched: _matched, ...row }) => row),
  matched: Number(rows[0]?.matched ?? 0),
  returned: rows.length,
  capped: Number(rows[0]?.matched ?? 0) > rows.length,
});

const reference = (
  kind: WorkspaceReferenceKind,
  entity: Record<string, unknown>,
  project: WorkspaceProject,
): WorkspaceReference => {
  const id = String(entity.id);
  const key = entity.key ? String(entity.key) : undefined;
  return {
    kind,
    id,
    ...(key ? { key } : {}),
    title: String(entity.title ?? entity.name ?? entity.id),
    projectId: project.id,
    projectKey: project.key,
    projectName: project.name,
    ...(entity.status ? { status: String(entity.status) } : {}),
    ...(entity.updatedAt ? { updatedAt: String(entity.updatedAt) } : {}),
    citation: `${project.key} / ${key ?? `${kind}:${id}`}`,
  };
};

/** Current structured work, waiting, and review state. Semantic search is intentionally absent. */
export async function workspaceStatus(
  env: Pick<Env, 'DB'>,
  scope: WorkspaceScope,
  input: { projectId?: string | null; limit?: number } = {},
) {
  const { projects, byId } = await projectSet(env, scope, input.projectId);
  const ids = projects.map((project) => project.id);
  const limit = boundedLimit(input.limit, 40, 80);
  const asOf = new Date().toISOString();
  if (!ids.length) return {
    asOf, projects, executing: page([]), runs: page([]), waiting: page([]), review: page([]), references: [] as WorkspaceReference[],
  };
  const inside = inClause(ids);
  const [executingRows, runRows, waitingRows, reviewRows] = await Promise.all([
    env.DB.prepare(
      `SELECT t.id, t.key, t.title, ${taskWireStatus('t')} AS status, t.priority, t.claimed_by AS claimedBy,
              a.name AS claimedByName, t.claim_expires_at AS claimExpiresAt, t.project_id AS projectId,
              t.open_comments AS openComments, t.updated_at AS updatedAt, COUNT(*) OVER() AS matched
       FROM tasks t LEFT JOIN agents a ON a.id = t.claimed_by
       WHERE t.project_id IN (${inside}) AND t.archived_at IS NULL
         AND (t.status = 'in_progress' OR (t.claimed_by IS NOT NULL AND t.status NOT IN ('blocked','review','done','cancelled')))
       ORDER BY t.priority ASC, t.updated_at DESC LIMIT ${limit}`,
    ).bind(...ids).all<Record<string, unknown> & { matched: number }>(),
    env.DB.prepare(
      `SELECT r.id, r.kind, r.status, r.phase, r.anchor_type AS anchorType, r.anchor_id AS anchorId,
              COALESCE(t.key, r.plan_key) AS anchorKey, COALESCE(t.title, pl.title, r.brief) AS title,
              r.project_id AS projectId, r.model, r.effort, r.started_at AS startedAt, r.updated_at AS updatedAt,
              COUNT(*) OVER() AS matched
       FROM runs r LEFT JOIN tasks t ON r.anchor_type = 'task' AND t.id = r.anchor_id
       LEFT JOIN plans pl ON r.anchor_type = 'plan' AND pl.id = r.anchor_id
       WHERE r.project_id IN (${inside}) AND r.status IN ('queued','dispatched','running','blocked')
       ORDER BY CASE r.status WHEN 'running' THEN 0 WHEN 'blocked' THEN 1 WHEN 'dispatched' THEN 2 ELSE 3 END,
                r.updated_at DESC LIMIT ${limit}`,
    ).bind(...ids).all<Record<string, unknown> & { matched: number }>(),
    env.DB.prepare(
      `SELECT x.*, COUNT(*) OVER() AS matched FROM (
         SELECT 'task' AS kind, t.id, t.key, t.title, ${taskWireStatus('t')} AS status,
                NULL AS type, NULL AS severity, NULL AS body, 1 AS blocking, t.id AS taskId,
                t.project_id AS projectId, t.updated_at AS createdAt
         FROM tasks t WHERE t.project_id IN (${inside}) AND t.archived_at IS NULL AND t.status = 'blocked'
         UNION ALL
         SELECT 'signal' AS kind, s.id, t.key, s.title, s.status, s.type, s.severity, s.body, s.blocking,
                s.task_id AS taskId, s.project_id AS projectId, s.created_at AS createdAt
         FROM signals s LEFT JOIN tasks t ON t.id = s.task_id
         WHERE s.project_id IN (${inside}) AND s.status = 'open'
           AND (s.type = 'input_request' OR s.severity IN ('warning','critical'))
       ) x ORDER BY CASE WHEN x.kind = 'task' THEN 0 WHEN x.type = 'input_request' AND x.blocking = 1 THEN 1
                         WHEN x.severity = 'critical' THEN 2 ELSE 3 END,
                    x.createdAt ASC LIMIT ${limit}`,
    ).bind(...ids, ...ids).all<Record<string, unknown> & { matched: number }>(),
    env.DB.prepare(
      `SELECT x.*, COUNT(*) OVER() AS matched FROM (
         SELECT 'task' AS kind, t.id, t.key, t.title, ${taskWireStatus('t')} AS status, t.project_id AS projectId,
                t.open_comments AS openComments, t.updated_at AS updatedAt
         FROM tasks t WHERE t.project_id IN (${inside}) AND t.archived_at IS NULL
           AND (t.status = 'review' OR t.proposed_at IS NOT NULL)
         UNION ALL
         SELECT 'plan' AS kind, pl.id, NULL AS key, pl.title, pl.status, pl.project_id AS projectId,
                0 AS openComments, pl.created_at AS updatedAt
         FROM plans pl WHERE pl.project_id IN (${inside}) AND pl.archived_at IS NULL AND pl.status = 'proposed'
       ) x ORDER BY x.updatedAt ASC LIMIT ${limit}`,
    ).bind(...ids, ...ids).all<Record<string, unknown> & { matched: number }>(),
  ]);
  const executing = page(executingRows.results);
  const runs = page(runRows.results);
  const waiting = page(waitingRows.results);
  const review = page(reviewRows.results);
  const refs: WorkspaceReference[] = [];
  for (const item of executing.items) refs.push(reference('task', item, byId.get(String(item.projectId))!));
  for (const item of runs.items) refs.push(reference('run', item, byId.get(String(item.projectId))!));
  for (const item of waiting.items) refs.push(reference(String(item.kind) === 'task' ? 'task' : 'signal', item, byId.get(String(item.projectId))!));
  for (const item of review.items) refs.push(reference(String(item.kind) === 'plan' ? 'plan' : 'task', item, byId.get(String(item.projectId))!));
  return { asOf, projects, executing, runs, waiting, review, references: refs };
}

export async function workspaceTaskDetail(env: Env, scope: WorkspaceScope, taskRef: string) {
  const { projects, byId } = await projectSet(env, scope);
  const ids = projects.map((project) => project.id);
  if (!ids.length) throw new Error(`task ${taskRef} not found`);
  const task = await env.DB.prepare(
    `SELECT t.*, ${taskWireStatus('t')} AS wireStatus, t.claimed_by AS claimedBy,
            t.claim_expires_at AS claimExpiresAt, t.open_comments AS openComments,
            p.key AS projectKey, p.name AS projectName,
            (SELECT GROUP_CONCAT(g.name) FROM task_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.task_id = t.id) AS tags
     FROM tasks t JOIN projects p ON p.id = t.project_id
     WHERE (t.id = ? OR t.key = ?) AND t.project_id IN (${inClause(ids)})`,
  ).bind(taskRef, taskRef, ...ids).first<Record<string, unknown>>();
  if (!task) throw new Error(`task ${taskRef} not found`);
  const id = String(task.id);
  task.status = task.wireStatus;
  delete task.wireStatus;
  task.tags = task.tags ? String(task.tags).split(',') : [];
  const stored = readExecutionSpec(task.execution_spec, id);
  task.executionSpec = stored.spec;
  if (stored.unreadable) task.executionSpecUnreadable = true;
  delete task.execution_spec;
  const [comments, commentTotal, refs, signals, docs, dependencies, runs] = await Promise.all([
    env.DB.prepare(
      `SELECT id, author_kind AS authorKind, author_id AS authorId, kind, body, status,
              parent_comment_id AS parentCommentId, created_at AS createdAt
       FROM comments WHERE task_id = ?
       ORDER BY CASE WHEN status IN ('open','acknowledged') THEN 0 ELSE 1 END, created_at DESC LIMIT 40`,
    ).bind(id).all(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM comments WHERE task_id = ?').bind(id).first<{ n: number }>(),
    env.DB.prepare('SELECT kind, ref, url, state FROM task_refs WHERE task_id = ?').bind(id).all(),
    env.DB.prepare(
      `SELECT id, type, severity, title, body, status, blocking, response, created_at AS createdAt, resolved_at AS resolvedAt
       FROM signals WHERE task_id = ? ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, created_at DESC LIMIT 30`,
    ).bind(id).all(),
    env.DB.prepare('SELECT d.id, d.name, d.description, d.updated_at AS updatedAt FROM task_docs td JOIN docs d ON d.id = td.doc_id WHERE td.task_id = ? ORDER BY d.name').bind(id).all(),
    env.DB.prepare(
      `SELECT dt.id, dt.key, dt.title, ${taskWireStatus('dt')} AS status, dt.project_id AS projectId, p.key AS projectKey
       FROM dependencies d JOIN tasks dt ON dt.id = d.depends_on_task_id JOIN projects p ON p.id = dt.project_id
       WHERE d.task_id = ? AND dt.project_id IN (${inClause(ids)})`,
    ).bind(id, ...ids).all(),
    env.DB.prepare(
      `SELECT id, kind, status, phase, model, effort, started_at AS startedAt, updated_at AS updatedAt
       FROM runs WHERE anchor_type = 'task' AND anchor_id = ? ORDER BY created_at DESC LIMIT 20`,
    ).bind(id).all(),
  ]);
  const project = byId.get(String(task.project_id))!;
  return {
    asOf: new Date().toISOString(), task, comments: comments.results,
    commentsMatched: commentTotal?.n ?? comments.results.length, commentsReturned: comments.results.length,
    refs: refs.results, signals: signals.results, docs: docs.results, dependencies: dependencies.results, runs: runs.results,
    references: [
      reference('task', { ...task, key: task.key, title: task.title, status: task.status, updatedAt: task.updated_at }, project),
      ...comments.results.map((comment) => reference('comment', {
        ...comment, title: `${String(task.key)} ${String(comment.kind)} comment`, updatedAt: comment.createdAt,
      }, project)),
      ...docs.results.map((doc) => reference('doc', doc, project)),
      ...runs.results.map((run) => reference('run', { ...run, title: `${task.key} ${run.kind} run` }, project)),
      ...signals.results.map((signal) => reference('signal', signal, project)),
      ...dependencies.results.flatMap((dependency) => {
        const blockerProject = byId.get(String(dependency.projectId));
        return blockerProject ? [reference('task', dependency, blockerProject)] : [];
      }),
    ],
  };
}

export async function workspaceTaskContext(
  env: Env,
  scope: WorkspaceScope,
  input: { taskId: string; repositoryKey?: string; branch?: string; baseId?: string; budgetTokens?: number },
) {
  const detail = await workspaceTaskDetail(env, scope, input.taskId);
  const projectId = String(detail.task.project_id);
  const pack = await assembleContextPack(env, projectId, String(detail.task.id), {
    repositoryKey: input.repositoryKey,
    branch: input.branch,
    baseId: input.baseId,
    role: 'human',
    tokenBudget: boundedLimit(input.budgetTokens, 3000, 6000),
  });
  return { ...pack, references: detail.references };
}

export async function workspaceDocs(
  env: Pick<Env, 'DB'>,
  scope: WorkspaceScope,
  input: { projectId?: string | null; docId?: string | null; text?: string | null; limit?: number } = {},
) {
  const { projects, byId } = await projectSet(env, scope, input.projectId);
  const ids = projects.map((project) => project.id);
  if (!ids.length) return { docs: [], matched: 0, returned: 0, capped: false, references: [] as WorkspaceReference[] };
  const limit = boundedLimit(input.limit, 20, 40);
  const binds: unknown[] = [...ids];
  let where = `d.project_id IN (${inClause(ids)})`;
  if (input.docId) { where += ' AND d.id = ?'; binds.push(input.docId); }
  if (input.text) {
    where += " AND (d.name LIKE ? ESCAPE '\\' OR d.description LIKE ? ESCAPE '\\' OR d.body LIKE ? ESCAPE '\\')";
    const pattern = `%${input.text.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
    binds.push(pattern, pattern, pattern);
  }
  const { results } = await env.DB.prepare(
    `SELECT d.id, d.name, d.description, d.body, d.folder, d.project_id AS projectId, d.updated_at AS updatedAt,
            COUNT(*) OVER() AS matched
     FROM docs d WHERE ${where} ORDER BY d.updated_at DESC LIMIT ${limit}`,
  ).bind(...binds).all<Record<string, unknown> & { matched: number }>();
  const docs = page(results);
  return {
    docs: docs.items, matched: docs.matched, returned: docs.returned, capped: docs.capped,
    references: docs.items.map((doc) => reference('doc', doc, byId.get(String(doc.projectId))!)),
  };
}

export async function workspacePlans(
  env: Pick<Env, 'DB'>,
  scope: WorkspaceScope,
  input: { projectId?: string | null; planId?: string | null; limit?: number } = {},
) {
  const { projects, byId } = await projectSet(env, scope, input.projectId);
  const ids = projects.map((project) => project.id);
  if (!ids.length) return { plans: [], matched: 0, returned: 0, capped: false, references: [] as WorkspaceReference[] };
  const limit = boundedLimit(input.limit, 20, 30);
  const binds: unknown[] = [...ids];
  let where = `pl.project_id IN (${inClause(ids)}) AND pl.archived_at IS NULL`;
  if (input.planId) { where += ' AND pl.id = ?'; binds.push(input.planId); }
  const { results } = await env.DB.prepare(
    `SELECT pl.id, pl.title, pl.description, pl.body, pl.status, pl.project_id AS projectId,
            pl.created_at AS createdAt, COUNT(*) OVER() AS matched
     FROM plans pl WHERE ${where} ORDER BY pl.created_at DESC LIMIT ${limit}`,
  ).bind(...binds).all<Record<string, unknown> & { matched: number }>();
  const plans = page(results);
  const enriched = await Promise.all(plans.items.map(async (plan) => {
    const { results: phases } = await env.DB.prepare(
      `SELECT ph.id, ph.title, ph.body, ph."order",
              (SELECT COUNT(*) FROM phase_tasks pt WHERE pt.phase_id = ph.id) AS total,
              (SELECT COUNT(*) FROM phase_tasks pt JOIN tasks t ON t.id = pt.task_id WHERE pt.phase_id = ph.id AND t.status = 'done') AS done,
              (SELECT COUNT(*) FROM phase_tasks pt JOIN tasks t ON t.id = pt.task_id WHERE pt.phase_id = ph.id AND t.status IN ('done','cancelled')) AS settled,
              (SELECT GROUP_CONCAT(t.key) FROM phase_tasks pt JOIN tasks t ON t.id = pt.task_id WHERE pt.phase_id = ph.id) AS taskKeys
       FROM phases ph WHERE ph.plan_id = ? ORDER BY ph."order"`,
    ).bind(plan.id).all();
    return { ...plan, phases };
  }));
  return {
    plans: enriched, matched: plans.matched, returned: plans.returned, capped: plans.capped,
    references: plans.items.map((plan) => reference('plan', plan, byId.get(String(plan.projectId))!)),
  };
}

const memoryFor = (env: Env, projectId: string): ProjectMemoryStub =>
  env.PROJECT_MEMORY.get(env.PROJECT_MEMORY.idFromName(projectId)) as unknown as ProjectMemoryStub;

export async function workspaceMemory(
  env: Env,
  scope: WorkspaceScope,
  input: { projectId: string; query: string; kind?: string; minAuthority?: number; validity?: string; limit?: number },
) {
  const { projects } = await projectSet(env, scope, input.projectId);
  const project = projects[0];
  if (!project) throw new Error(`project ${input.projectId} not found`);
  const result = await memoryFor(env, project.id).searchProjectMemory(project.id, {
    query: input.query.trim().slice(0, 4000),
    kind: input.kind,
    minAuthority: input.minAuthority,
    validity: input.validity,
    limit: boundedLimit(input.limit, 10, 20),
  });
  const references: WorkspaceReference[] = result.results.flatMap((hit) => {
    const kind = hit.entityType === 'episode' ? 'episode' : hit.entityType === 'memory' ? 'memory' : null;
    return kind ? [reference(kind, {
      id: hit.id,
      title: hit.title,
      status: hit.entityType === 'memory' ? hit.validity : hit.status,
    }, project)] : [];
  });
  return { asOf: new Date().toISOString(), project, ...result, returned: result.results.length, references };
}

/** Noriq-stored review evidence only: commissioned acceptance, comments, refs, runs, and memory. */
export async function workspaceReview(
  env: Env,
  scope: WorkspaceScope,
  input: { projectId: string; limit?: number },
) {
  const { projects } = await projectSet(env, scope, input.projectId);
  const project = projects[0];
  if (!project) throw new Error(`project ${input.projectId} not found`);
  const limit = boundedLimit(input.limit, 15, 30);
  const [taskRows, taskTotal, memoryQueue] = await Promise.all([
    env.DB.prepare(
      `SELECT t.id, t.key, t.title, ${taskWireStatus('t')} AS status, t.body, t.priority,
              t.execution_spec AS executionSpecJson, t.open_comments AS openComments,
              t.updated_at AS updatedAt
       FROM tasks t WHERE t.project_id = ? AND t.archived_at IS NULL
         AND (t.status = 'review' OR t.proposed_at IS NOT NULL)
       ORDER BY t.updated_at ASC LIMIT ${limit}`,
    ).bind(project.id).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM tasks t WHERE t.project_id = ? AND t.archived_at IS NULL
       AND (t.status = 'review' OR t.proposed_at IS NOT NULL)`,
    ).bind(project.id).first<{ n: number }>(),
    memoryFor(env, project.id).reviewMemoryQueue(project.id, { limit, offset: 0 }),
  ]);
  const taskIds = taskRows.results.map((task) => String(task.id));
  const commentsByTask = new Map<string, unknown[]>();
  const refsByTask = new Map<string, unknown[]>();
  const runsByTask = new Map<string, unknown[]>();
  if (taskIds.length) {
    const inside = inClause(taskIds);
    const [comments, refs, runs] = await Promise.all([
      env.DB.prepare(
        `SELECT task_id AS taskId, id, author_kind AS authorKind, kind, body, status, created_at AS createdAt
         FROM comments WHERE task_id IN (${inside})
         ORDER BY CASE WHEN status IN ('open','acknowledged') THEN 0 ELSE 1 END, created_at DESC LIMIT ${limit * 8}`,
      ).bind(...taskIds).all<Record<string, unknown>>(),
      env.DB.prepare(`SELECT task_id AS taskId, kind, ref, url, state FROM task_refs WHERE task_id IN (${inside})`).bind(...taskIds).all<Record<string, unknown>>(),
      env.DB.prepare(
        `SELECT anchor_id AS taskId, id, kind, status, phase, model, effort, exit, updated_at AS updatedAt
         FROM runs WHERE anchor_type = 'task' AND anchor_id IN (${inside}) ORDER BY created_at DESC`,
      ).bind(...taskIds).all<Record<string, unknown>>(),
    ]);
    for (const [rows, target] of [[comments.results, commentsByTask], [refs.results, refsByTask], [runs.results, runsByTask]] as const) {
      for (const row of rows) {
        const taskId = String(row.taskId);
        const list = target.get(taskId) ?? [];
        list.push(row);
        target.set(taskId, list);
      }
    }
  }
  const tasks = taskRows.results.map((task) => {
    const stored = readExecutionSpec(task.executionSpecJson, String(task.id));
    const { executionSpecJson: _executionSpecJson, ...taskFields } = task;
    const result = {
      ...taskFields,
      executionSpec: stored.spec,
      ...(stored.unreadable ? { executionSpecUnreadable: true } : {}),
      comments: commentsByTask.get(String(task.id)) ?? [],
      refs: refsByTask.get(String(task.id)) ?? [],
      runs: runsByTask.get(String(task.id)) ?? [],
    };
    return result;
  });
  return {
    asOf: new Date().toISOString(), project,
    tasks: { items: tasks, matched: taskTotal?.n ?? tasks.length, returned: tasks.length, capped: (taskTotal?.n ?? 0) > tasks.length },
    memory: memoryQueue,
    scopeNote: 'Review evidence is limited to Noriq requirements, acceptance, comments, refs, runs, and recorded memory; no repository checkout or diff was inspected.',
    references: [
      ...tasks.map((task) => reference('task', task, project)),
      ...tasks.flatMap((task) => (task.comments as Array<Record<string, unknown>>).map((comment) => reference('comment', {
        ...comment, title: `${String((task as Record<string, unknown>).key)} ${String(comment.kind)} comment`, updatedAt: comment.createdAt,
      }, project))),
      ...tasks.flatMap((task) => (task.runs as Array<Record<string, unknown>>).map((run) => reference('run', {
        ...run, title: `${String((task as Record<string, unknown>).key)} ${String(run.kind)} run`,
      }, project))),
      ...memoryQueue.items.map((item) => reference('memory', { id: item.id, title: item.statement, status: item.validity }, project)),
    ],
  };
}
