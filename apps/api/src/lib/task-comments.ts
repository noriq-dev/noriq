// Bounded comment reads shared by MCP get_task / list_comments, REST task detail,
// REST comment pages, and Ask workspaceTaskDetail. History is unbounded in D1;
// every consumer must go through here so caps cannot drift.

export const GET_TASK_RESOLVED_CAP = 5;
export const REST_DETAIL_RESOLVED_CAP = 20;
export const LIST_COMMENTS_DEFAULT_LIMIT = 20;
export const LIST_COMMENTS_MAX_LIMIT = 50;
export const COMMENT_BODY_MAX = 4000;

const COMMENT_COLUMNS =
  `id, author_kind AS authorKind, author_id AS authorId, kind, body, status, parent_comment_id AS parentCommentId, created_at AS createdAt`;

export type TaskCommentRow = {
  id: string;
  authorKind: string;
  authorId: string;
  kind: string;
  body: string;
  status: string;
  parentCommentId: string | null;
  createdAt: string;
};

export type TaskCommentCounts = {
  open: number;
  resolved: number;
  total: number;
};

export type ListTaskCommentsOpts = {
  status?: 'open' | 'resolved' | 'all';
  authorKind?: 'agent' | 'human' | 'system';
  limit?: number;
  before?: string;
};

const OPEN_STATUSES = `status IN ('open','acknowledged')`;
const RESOLVED_STATUSES = `status NOT IN ('open','acknowledged')`;

export function clampCommentLimit(limit: number | undefined, fallback = LIST_COMMENTS_DEFAULT_LIMIT): number {
  const n = limit === undefined ? fallback : Math.trunc(limit);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, LIST_COMMENTS_MAX_LIMIT);
}

export async function loadTaskCommentCounts(db: D1Database, taskId: string): Promise<TaskCommentCounts> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN ${OPEN_STATUSES} THEN 1 ELSE 0 END), 0) AS open,
            COALESCE(SUM(CASE WHEN ${RESOLVED_STATUSES} THEN 1 ELSE 0 END), 0) AS resolved
     FROM comments WHERE task_id = ?`,
  ).bind(taskId).first<{ total: number; open: number; resolved: number }>();
  return {
    open: Number(row?.open ?? 0),
    resolved: Number(row?.resolved ?? 0),
    total: Number(row?.total ?? 0),
  };
}

export async function loadOpenTaskComments(db: D1Database, taskId: string): Promise<TaskCommentRow[]> {
  const { results } = await db.prepare(
    `SELECT ${COMMENT_COLUMNS} FROM comments
     WHERE task_id = ? AND ${OPEN_STATUSES}
     ORDER BY created_at ASC, id ASC`,
  ).bind(taskId).all<TaskCommentRow>();
  return results;
}

export async function loadRecentResolvedTaskComments(
  db: D1Database, taskId: string, cap: number,
): Promise<TaskCommentRow[]> {
  if (cap <= 0) return [];
  const { results } = await db.prepare(
    `SELECT ${COMMENT_COLUMNS} FROM comments
     WHERE task_id = ? AND ${RESOLVED_STATUSES}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
  ).bind(taskId, cap).all<TaskCommentRow>();
  return results;
}

/** Open/acknowledged in full (oldest first), then the newest `resolvedCap` resolved. */
export async function loadTaskCommentsForDetail(
  db: D1Database, taskId: string, resolvedCap: number,
): Promise<{ comments: TaskCommentRow[]; moreResolvedComments: number; commentCounts: TaskCommentCounts }> {
  const [open, resolved, commentCounts] = await Promise.all([
    loadOpenTaskComments(db, taskId),
    loadRecentResolvedTaskComments(db, taskId, resolvedCap),
    loadTaskCommentCounts(db, taskId),
  ]);
  return {
    comments: [...open, ...resolved],
    moreResolvedComments: Math.max(0, commentCounts.resolved - resolved.length),
    commentCounts,
  };
}

export async function listTaskCommentsPaged(
  db: D1Database, taskId: string, opts: ListTaskCommentsOpts = {},
): Promise<{ comments: TaskCommentRow[]; total: number; hasMore: boolean; nextBefore: string | null }> {
  const limit = clampCommentLimit(opts.limit);
  const filter: string[] = ['task_id = ?'];
  const filterBinds: unknown[] = [taskId];
  if (opts.status === 'open') filter.push(OPEN_STATUSES);
  else if (opts.status === 'resolved') filter.push(RESOLVED_STATUSES);
  if (opts.authorKind) {
    filter.push('author_kind = ?');
    filterBinds.push(opts.authorKind);
  }
  const page = [...filter];
  const pageBinds = [...filterBinds];
  if (opts.before) {
    const cursor = await db.prepare(
      'SELECT id, created_at AS createdAt FROM comments WHERE id = ? AND task_id = ?',
    ).bind(opts.before, taskId).first<{ id: string; createdAt: string }>();
    if (!cursor) throw new Error(`comment ${opts.before} not found on this task`);
    page.push('(created_at < ? OR (created_at = ? AND id < ?))');
    pageBinds.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const where = page.join(' AND ');
  const filterWhere = filter.join(' AND ');
  const [rows, totalRow] = await Promise.all([
    db.prepare(
      `SELECT ${COMMENT_COLUMNS} FROM comments WHERE ${where}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).bind(...pageBinds, limit + 1).all<TaskCommentRow>(),
    db.prepare(`SELECT COUNT(*) AS n FROM comments WHERE ${filterWhere}`).bind(...filterBinds).first<{ n: number }>(),
  ]);
  const hasMore = rows.results.length > limit;
  const comments = hasMore ? rows.results.slice(0, limit) : rows.results;
  return {
    comments,
    total: Number(totalRow?.n ?? 0),
    hasMore,
    nextBefore: hasMore ? (comments[comments.length - 1]?.id ?? null) : null,
  };
}
