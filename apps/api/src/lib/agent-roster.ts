import type { Env } from '../env';
import { agentLifecycleSweepConfig } from './agent-lifecycle-sweep';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;
const DAY_MS = 86_400_000;

export const AGENT_LIFECYCLES = ['live', 'recent', 'dormant', 'retired', 'archived', 'revoked'] as const;
export type AgentRosterLifecycle = typeof AGENT_LIFECYCLES[number];

export type AgentRosterOptions = {
  projectId?: string;
  ownerUserId?: string;
  projectScopedOnly?: boolean;
  scopeAll?: boolean;
  kind?: 'agent' | 'copilot';
  runnerId?: string;
  lifecycle?: AgentRosterLifecycle;
  includeHistory?: boolean;
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

/**
 * One bounded roster read shared by MCP and the human API. Compatibility status remains on every
 * row, but lifecycle and `live` come from fresh presence evidence; a stale `status='active'` row
 * is never presented as live. The legacy `agents` array is preserved while `page` and `counts`
 * let newer callers walk history without pulling an unbounded identity table.
 */
export async function listAgentRoster(env: Env, options: AgentRosterOptions) {
  const config = agentLifecycleSweepConfig(env);
  const now = Date.now();
  const liveCutoff = new Date(now - config.onlineSeconds * 1_000).toISOString();
  const recentCutoff = new Date(now - config.copilotRetireDays * DAY_MS).toISOString();
  const activeAfter = isoDate(options.activeAfter, 'activeAfter');
  const activeBefore = isoDate(options.activeBefore, 'activeBefore');
  const cursor = decodeCursor(options.cursor);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(options.limit ?? DEFAULT_PAGE_SIZE)));

  const scope: string[] = [];
  const scopeBinds: unknown[] = [];
  if (options.projectId) {
    scope.push('a.project_id = ?');
    scopeBinds.push(options.projectId);
  }
  if (options.ownerUserId) {
    scope.push('a.user_id = ?');
    scopeBinds.push(options.ownerUserId);
  }
  if (options.projectScopedOnly) scope.push('a.project_id IS NOT NULL');
  if (options.scopeAll) scope.push('1 = 1');
  if (options.kind) {
    scope.push('a.kind = ?');
    scopeBinds.push(options.kind);
  }
  if (options.runnerId) {
    scope.push('a.runner_id = ?');
    scopeBinds.push(options.runnerId);
  }
  if (!scope.length) throw new Error('an agent roster must have a project or owner scope');

  const cte = `WITH facts AS (
    SELECT a.id, COALESCE(a.label, a.name) AS name, a.role, a.kind, a.status,
           a.runner_id AS runnerId, a.project_id AS projectId,
           a.parent_agent_id AS parentAgentId, a.last_seen_at AS lastSeenAt,
           a.created_at AS createdAt, a.actor_class AS actorClass,
           a.retired_at AS retiredAt, a.retire_reason AS retireReason,
           a.archived_at AS archivedAt, a.lineage_status AS lineageStatus,
           a.lineage_reason AS lineageReason, u.name AS ownerName, u.id AS ownerUserId,
           COALESCE((SELECT MAX(ap.last_seen_at) FROM agent_presences ap
                      WHERE ap.actor_id = a.id), a.last_seen_at, a.created_at) AS activityAt,
           EXISTS(SELECT 1 FROM agent_presences ap
                   WHERE ap.actor_id = a.id AND ap.archived_at IS NULL
                     AND ap.state IN ('online','working') AND ap.last_seen_at >= ?) AS hasLivePresence,
           (SELECT COUNT(*) FROM tasks t WHERE t.claimed_by = a.id) AS heldTasks,
           (SELECT COUNT(*) FROM claims cl WHERE cl.agent_id = a.id) AS totalClaims,
           (SELECT COALESCE(oc.name, 'MCP client') FROM oauth_tokens ot
              LEFT JOIN oauth_clients oc ON oc.id = ot.client_id
             WHERE ot.copilot_id = a.id ORDER BY ot.expires_at DESC LIMIT 1) AS clientName
      FROM agents a LEFT JOIN users u ON u.id = a.user_id
     WHERE ${scope.join(' AND ')}
  ), roster AS (
    SELECT facts.*,
           CASE
             WHEN status = 'revoked' THEN 'revoked'
             WHEN archivedAt IS NOT NULL THEN 'archived'
             WHEN retiredAt IS NOT NULL THEN 'retired'
             WHEN hasLivePresence = 1 THEN 'live'
             WHEN activityAt >= ? THEN 'recent'
             ELSE 'dormant'
           END AS lifecycle
      FROM facts
  )`;
  const baseBinds = [liveCutoff, ...scopeBinds, recentCutoff];
  const filters: string[] = [];
  const filterBinds: unknown[] = [];
  if (activeAfter) { filters.push('activityAt >= ?'); filterBinds.push(activeAfter); }
  if (activeBefore) { filters.push('activityAt < ?'); filterBinds.push(activeBefore); }
  const filterSql = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';

  const countRows = await env.DB.prepare(
    `${cte} SELECT lifecycle, COUNT(*) AS count FROM roster${filterSql} GROUP BY lifecycle`,
  ).bind(...baseBinds, ...filterBinds).all<{ lifecycle: AgentRosterLifecycle; count: number }>();
  const byLifecycle = Object.fromEntries(AGENT_LIFECYCLES.map((state) => [state, 0])) as Record<AgentRosterLifecycle, number>;
  for (const row of countRows.results) byLifecycle[row.lifecycle] = Number(row.count);

  const pageFilters = [...filters];
  const pageBinds = [...filterBinds];
  if (options.lifecycle) {
    pageFilters.push('lifecycle = ?');
    pageBinds.push(options.lifecycle);
  } else if (!options.includeHistory) {
    pageFilters.push("lifecycle IN ('live','recent')");
  }
  if (cursor) {
    pageFilters.push('(activityAt < ? OR (activityAt = ? AND id < ?))');
    pageBinds.push(cursor.activityAt, cursor.activityAt, cursor.id);
  }
  const pageWhere = pageFilters.length ? ` WHERE ${pageFilters.join(' AND ')}` : '';
  const rows = await env.DB.prepare(
    `${cte} SELECT * FROM roster${pageWhere} ORDER BY activityAt DESC, id DESC LIMIT ?`,
  ).bind(...baseBinds, ...pageBinds, limit + 1).all<Record<string, unknown> & {
    id: string;
    activityAt: string;
    lifecycle: AgentRosterLifecycle;
    heldTasks: number;
  }>();
  const hasMore = rows.results.length > limit;
  const agents = rows.results.slice(0, limit).map((row) => ({
    ...row,
    live: row.lifecycle === 'live',
  }));
  const last = agents.at(-1);
  const historical = byLifecycle.dormant + byLifecycle.retired + byLifecycle.archived + byLifecycle.revoked;
  return {
    agents,
    counts: {
      live: byLifecycle.live,
      recent: byLifecycle.recent,
      historical,
      total: Object.values(byLifecycle).reduce((sum, value) => sum + value, 0),
      byLifecycle,
    },
    page: {
      limit,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor({ activityAt: String(last.activityAt), id: last.id }) : null,
    },
    policy: { onlineSeconds: config.onlineSeconds, recentDays: config.copilotRetireDays },
  };
}
