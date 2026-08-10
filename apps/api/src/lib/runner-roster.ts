import type { Env } from '../env';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;
export const RUNNER_HEARTBEAT_TTL_MS = 90_000;

export const RUNNER_LIFECYCLES = ['active', 'dormant', 'retired', 'archived'] as const;
export type RunnerRosterLifecycle = typeof RUNNER_LIFECYCLES[number];

export type RunnerRosterOptions = {
  ownerUserId?: string;
  scopeAll?: boolean;
  projectId?: string;
  lifecycle?: RunnerRosterLifecycle;
  view?: 'active' | 'dormant' | 'history';
  retireReason?: string;
  activeAfter?: string;
  activeBefore?: string;
  cursor?: string;
  limit?: number;
};

type Cursor = { activityAt: string; id: string };

function encodeCursor(cursor: Cursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const padded = raw.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - raw.length % 4) % 4);
    const parsed = JSON.parse(atob(padded)) as Partial<Cursor>;
    if (typeof parsed.activityAt !== 'string' || !Number.isFinite(Date.parse(parsed.activityAt)) || typeof parsed.id !== 'string' || !parsed.id) {
      throw new Error('invalid cursor');
    }
    return { activityAt: parsed.activityAt, id: parsed.id };
  } catch {
    throw new Error('cursor is invalid or expired');
  }
}

function isoDate(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`${field} must be an ISO date-time`);
  return new Date(time).toISOString();
}

/** A bounded lifecycle read for the human Runner roster. Runner identities are durable
 * attribution; this endpoint paginates and classifies them but never hides or deletes history. */
export async function listRunnerRoster(env: Env, options: RunnerRosterOptions) {
  if (!options.scopeAll && !options.ownerUserId) throw new Error('a Runner roster must have an owner or all scope');
  const activeAfter = isoDate(options.activeAfter, 'activeAfter');
  const activeBefore = isoDate(options.activeBefore, 'activeBefore');
  const cursor = decodeCursor(options.cursor);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(options.limit ?? DEFAULT_PAGE_SIZE)));
  const liveCutoff = new Date(Date.now() - RUNNER_HEARTBEAT_TTL_MS).toISOString();

  const scope: string[] = [];
  const scopeBinds: unknown[] = [];
  if (options.ownerUserId) { scope.push('r.owner_user_id = ?'); scopeBinds.push(options.ownerUserId); }
  if (options.scopeAll) scope.push('1 = 1');
  if (options.projectId) {
    scope.push(`(EXISTS (SELECT 1 FROM json_each(COALESCE(r.repos, '[]')) repo
                         WHERE json_extract(repo.value, '$.projectId') = ?)
                 OR EXISTS (SELECT 1 FROM agents a WHERE a.runner_id = r.id AND a.project_id = ?))`);
    scopeBinds.push(options.projectId, options.projectId);
  }

  const cte = `WITH facts AS (
    SELECT r.*, u.name AS ownerName, u.id AS ownerUserId,
           COALESCE(r.last_heartbeat_at, r.created_at) AS activityAt,
           (SELECT COUNT(*) FROM agents a WHERE a.runner_id = r.id) AS agentCount,
           (SELECT COUNT(*) FROM runs run WHERE run.runner_id = r.id
             AND run.status IN ('queued','dispatched','running','blocked')) AS liveRuns
      FROM runners r LEFT JOIN users u ON u.id = r.owner_user_id
     WHERE ${scope.join(' AND ')}
  ), roster AS (
    SELECT facts.*,
           CASE
             WHEN archived_at IS NOT NULL THEN 'archived'
             WHEN retired_at IS NOT NULL OR offboarded_at IS NOT NULL THEN 'retired'
             WHEN status IN ('online','draining') AND last_heartbeat_at >= ? THEN 'active'
             ELSE 'dormant'
           END AS lifecycle
      FROM facts
  )`;
  const baseBinds = [...scopeBinds, liveCutoff];
  const filters: string[] = [];
  const filterBinds: unknown[] = [];
  if (activeAfter) { filters.push('activityAt >= ?'); filterBinds.push(activeAfter); }
  if (activeBefore) { filters.push('activityAt < ?'); filterBinds.push(activeBefore); }
  if (options.retireReason) { filters.push('retire_reason = ?'); filterBinds.push(options.retireReason); }
  const filterSql = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';

  const countRows = await env.DB.prepare(
    `${cte} SELECT lifecycle, COUNT(*) AS count FROM roster${filterSql} GROUP BY lifecycle`,
  ).bind(...baseBinds, ...filterBinds).all<{ lifecycle: RunnerRosterLifecycle; count: number }>();
  const byLifecycle = Object.fromEntries(RUNNER_LIFECYCLES.map((state) => [state, 0])) as Record<RunnerRosterLifecycle, number>;
  for (const row of countRows.results) byLifecycle[row.lifecycle] = Number(row.count);

  const pageFilters = [...filters];
  const pageBinds = [...filterBinds];
  if (options.lifecycle) { pageFilters.push('lifecycle = ?'); pageBinds.push(options.lifecycle); }
  else if (options.view === 'active') pageFilters.push("lifecycle = 'active'");
  else if (options.view === 'dormant') pageFilters.push("lifecycle = 'dormant'");
  else if (options.view === 'history') pageFilters.push("lifecycle IN ('retired','archived')");
  if (cursor) {
    pageFilters.push('(activityAt < ? OR (activityAt = ? AND id < ?))');
    pageBinds.push(cursor.activityAt, cursor.activityAt, cursor.id);
  }
  const pageWhere = pageFilters.length ? ` WHERE ${pageFilters.join(' AND ')}` : '';
  const rows = await env.DB.prepare(
    `${cte} SELECT * FROM roster${pageWhere} ORDER BY activityAt DESC, id DESC LIMIT ?`,
  ).bind(...baseBinds, ...pageBinds, limit + 1).all<Record<string, unknown> & {
    id: string; activityAt: string; lifecycle: RunnerRosterLifecycle; agentCount: number; liveRuns: number;
  }>();
  const hasMore = rows.results.length > limit;
  const runners = rows.results.slice(0, limit).map((row) => ({
    ...row,
    eligiblePurge: row.lifecycle !== 'active' && Number(row.agentCount) === 0 && Number(row.liveRuns) === 0,
  }));
  const last = runners.at(-1);
  return {
    runners,
    counts: {
      active: byLifecycle.active,
      dormant: byLifecycle.dormant,
      historical: byLifecycle.retired + byLifecycle.archived,
      total: Object.values(byLifecycle).reduce((sum, value) => sum + value, 0),
      byLifecycle,
    },
    page: {
      limit,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor({ activityAt: String(last.activityAt), id: last.id }) : null,
    },
    policy: { heartbeatSeconds: RUNNER_HEARTBEAT_TTL_MS / 1_000 },
  };
}
