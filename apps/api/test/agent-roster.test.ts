import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, loginSession, mcpCall } from './helpers';

let apiKey: string;
let projectId: string;
let ownerId: string;
let cookie: string;

const now = new Date().toISOString();
const yesterday = new Date(Date.now() - 86_400_000).toISOString();
const old = '2020-01-01T00:00:00.000Z';

beforeAll(async () => {
  const connection = await createAgent('roster-fixture');
  apiKey = connection.apiKey;
  projectId = (await mcpCall(apiKey, 'create_project', { key: 'ROSTER', name: 'Roster scale' })).body.id;
  ownerId = (await env.DB.prepare("SELECT id FROM users WHERE email = 'agent-mint@example.com'").first<{ id: string }>())!.id;
  cookie = await loginSession('agent-mint@example.com', 'longenough1');

  await env.DB.prepare(
    `INSERT INTO runners (id, label, owner_user_id, status, last_heartbeat_at, created_at)
     VALUES ('rnr_roster', 'roster', ?, 'online', ?, ?)`,
  ).bind(ownerId, now, now).run();

  const statements: D1PreparedStatement[] = [];
  const addActor = (id: string, activityAt: string, lifecycle: 'live' | 'recent' | 'dormant' | 'archived', lineage: 'complete' | 'partial') => {
    statements.push(env.DB.prepare(
      `INSERT INTO agents (
         id, name, status, kind, actor_class, user_id, project_id, runner_id, last_seen_at,
         archived_at, lineage_status, lineage_reason, lifecycle_updated_at, created_at
       ) VALUES (?, ?, 'active', 'agent', 'runner_agent', ?, ?, 'rnr_roster', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, id, ownerId, projectId, activityAt, lifecycle === 'archived' ? activityAt : null,
      lineage, lineage === 'partial' ? 'execution_contract_pending' : null, activityAt, activityAt,
    ));
  };
  addActor('agt_roster_live', now, 'live', 'complete');
  addActor('agt_roster_recent', yesterday, 'recent', 'partial');
  addActor('agt_roster_dormant', old, 'dormant', 'partial');
  for (let index = 0; index < 225; index++) {
    addActor(`agt_roster_archived_${String(index).padStart(3, '0')}`, old, 'archived', 'partial');
  }
  for (let offset = 0; offset < statements.length; offset += 50) {
    await env.DB.batch(statements.slice(offset, offset + 50));
  }
  await env.DB.prepare(
    `UPDATE agent_presences SET state = 'working', last_seen_at = ?, archived_at = NULL
      WHERE actor_id = 'agt_roster_live'`,
  ).bind(now).run();
  await env.DB.prepare(
    `UPDATE agents SET lineage_status = 'complete', lineage_reason = NULL
      WHERE id = 'agt_roster_live'`,
  ).run();
  await env.DB.prepare(
    `UPDATE agent_presences SET state = 'dormant', last_seen_at = ?
      WHERE actor_id = 'agt_roster_recent'`,
  ).bind(yesterday).run();
  await env.DB.prepare(
    `UPDATE agent_presences SET state = 'dormant', last_seen_at = ?
      WHERE actor_id = 'agt_roster_dormant'`,
  ).bind(old).run();
}, 60_000);

type RosterResponse = {
  agents: Array<{
    id: string;
    lifecycle: string;
    live: boolean;
    actorClass: string;
    lineageStatus: string;
    lineageReason: string | null;
    runnerId: string | null;
    activityAt: string;
  }>;
  counts: { live: number; recent: number; historical: number; total: number };
  page: { limit: number; hasMore: boolean; nextCursor: string | null };
};

async function roster(query = ''): Promise<RosterResponse> {
  const res = await SELF.fetch(`https://noriq.test/api/agents?projectId=${projectId}${query}`, {
    headers: { Cookie: cookie },
  });
  expect(res.status).toBe(200);
  return res.json<RosterResponse>();
}

describe('live-first paginated agent rosters (PLNR-364)', () => {
  it('defaults to live/recent presence instead of compatibility status', async () => {
    const body = await roster('&kind=agent');
    expect(body.agents.map((actor) => actor.id)).toEqual(['agt_roster_live', 'agt_roster_recent']);
    expect(body.agents[0]).toMatchObject({
      lifecycle: 'live', live: true, actorClass: 'runner_agent', lineageStatus: 'complete', runnerId: 'rnr_roster',
    });
    expect(body.agents[1]).toMatchObject({
      lifecycle: 'recent', live: false, lineageStatus: 'partial', lineageReason: 'execution_contract_pending',
    });
    expect(body.counts).toMatchObject({ live: 1, recent: 1, historical: 226, total: 228 });
  });

  it('walks a large historical roster with stable bounded cursors and no duplicates', async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const body = await roster(`&kind=agent&includeHistory=true&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(body.agents.length).toBeLessThanOrEqual(100);
      for (const actor of body.agents) {
        expect(seen.has(actor.id)).toBe(false);
        seen.add(actor.id);
      }
      cursor = body.page.nextCursor;
      pages++;
      if (!body.page.hasMore) expect(cursor).toBeNull();
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen.size).toBe(228);
  });

  it('supports explicit lifecycle, runner, and activity-date filters', async () => {
    const archived = await roster('&kind=agent&lifecycle=archived&runnerId=rnr_roster&limit=25');
    expect(archived.agents).toHaveLength(25);
    expect(archived.agents.every((actor) => actor.lifecycle === 'archived')).toBe(true);
    expect(archived.page.hasMore).toBe(true);

    const after = await roster(`&kind=agent&includeHistory=true&activeAfter=${encodeURIComponent(yesterday)}`);
    expect(after.agents.map((actor) => actor.id)).toEqual(['agt_roster_live', 'agt_roster_recent']);

    const dormant = await roster('&kind=agent&view=dormant');
    expect(dormant.agents.map((actor) => actor.id)).toEqual(['agt_roster_dormant']);
    const history = await roster('&kind=agent&view=history&limit=25');
    expect(history.agents).toHaveLength(25);
    expect(history.agents.every((actor) => ['retired', 'archived', 'revoked'].includes(actor.lifecycle))).toBe(true);
    expect(history.page.hasMore).toBe(true);
  });

  it('keeps MCP agents compatibility while exposing lifecycle counts and pagination', async () => {
    const response = await mcpCall(apiKey, 'list_agents', { projectId, kind: 'agent', limit: 1 });
    expect(response.isError).toBe(false);
    expect(response.body.agents).toHaveLength(1);
    expect(response.body.agents[0]).toMatchObject({ id: 'agt_roster_live', lifecycle: 'live', live: true });
    expect(response.body.counts).toMatchObject({ live: 1, recent: 1, historical: 226, total: 228 });
    expect(response.body.page).toMatchObject({ limit: 1, hasMore: true });
  });

  it('reports only presence-live actors in project agentCount', async () => {
    const response = await SELF.fetch('https://noriq.test/api/projects', { headers: { Cookie: cookie } });
    expect(response.status).toBe(200);
    const body = await response.json<{ projects: Array<{
      id: string; agentCount: number; liveAgentCount: number; historicalAgentCount: number;
    }> }>();
    expect(body.projects.find((project) => project.id === projectId)).toMatchObject({
      agentCount: 1,
      liveAgentCount: 1,
      historicalAgentCount: 227,
    });
  });

  it('rejects malformed cursors and lifecycle values without scanning', async () => {
    const badCursor = await SELF.fetch(`https://noriq.test/api/agents?projectId=${projectId}&cursor=not-a-cursor`, {
      headers: { Cookie: cookie },
    });
    expect(badCursor.status).toBe(400);
    const badLifecycle = await SELF.fetch(`https://noriq.test/api/agents?projectId=${projectId}&lifecycle=active`, {
      headers: { Cookie: cookie },
    });
    expect(badLifecycle.status).toBe(400);
    const badView = await SELF.fetch(`https://noriq.test/api/agents?projectId=${projectId}&view=everything`, {
      headers: { Cookie: cookie },
    });
    expect(badView.status).toBe(400);
  });

  it('archives and restores visibility without reviving a retired actor', async () => {
    await env.DB.prepare(
      `INSERT INTO agents (id, name, status, kind, actor_class, user_id, project_id, runner_id,
                           last_seen_at, retired_at, retire_reason, created_at)
       VALUES ('agt_manual_archive', 'manual archive', 'offline', 'agent', 'runner_agent', ?, ?,
               'rnr_roster', ?, ?, 'run_terminal', ?)`,
    ).bind(ownerId, projectId, old, old, old).run();
    const archived = await SELF.fetch('https://noriq.test/api/agents/agt_manual_archive/archive', {
      method: 'POST', headers: { Cookie: cookie },
    });
    expect(archived.status).toBe(200);
    expect(await env.DB.prepare('SELECT archived_at AS archivedAt FROM agents WHERE id = ?')
      .bind('agt_manual_archive').first<{ archivedAt: string | null }>()).toMatchObject({ archivedAt: expect.any(String) });

    const restored = await SELF.fetch('https://noriq.test/api/agents/agt_manual_archive/restore-visibility', {
      method: 'POST', headers: { Cookie: cookie },
    });
    expect(restored.status).toBe(200);
    expect(await env.DB.prepare(
      'SELECT status, retired_at AS retiredAt, archived_at AS archivedAt FROM agents WHERE id = ?',
    ).bind('agt_manual_archive').first()).toMatchObject({ status: 'offline', retiredAt: old, archivedAt: null });
  });
});
