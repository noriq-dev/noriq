import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall, mcpList } from './helpers';

let connection: { id: string; apiKey: string };
let projectId: string;
let memberCookie: string;
let adminCookie: string;

beforeAll(async () => {
  connection = await createAgent('lifecycle-connection');
  projectId = (await mcpCall(connection.apiKey, 'create_project', {
    key: 'ACTLIFE', name: 'Actor lifecycle fixtures',
  })).body.id;
  await createUser('lifecycle-member@example.com', 'Lifecycle Member', 'longenough1', 'member').catch(() => {});
  await createUser('lifecycle-admin@example.com', 'Lifecycle Admin', 'longenough1', 'admin').catch(() => {});
  memberCookie = await loginSession('lifecycle-member@example.com', 'longenough1');
  adminCookie = await loginSession('lifecycle-admin@example.com', 'longenough1');
}, 60_000);

describe('agent lifecycle and presence storage (PLNR-362)', () => {
  it('classifies connection and session Copilots without treating ownership as immediate lineage', async () => {
    const briefing = await mcpCall(connection.apiKey, 'get_briefing', {}, 'life-session');
    const sessionId = briefing.body.you.id as string;

    const session = await env.DB.prepare(
      `SELECT actor_class AS actorClass, lineage_status AS lineageStatus, lineage_reason AS lineageReason,
              last_seen_at AS lastSeenAt
         FROM agents WHERE id = ?`,
    ).bind(sessionId).first<{
      actorClass: string; lineageStatus: string; lineageReason: string; lastSeenAt: string | null;
    }>();
    expect(session).toMatchObject({
      actorClass: 'session_copilot',
      lineageStatus: 'partial',
      lineageReason: 'immediate_parent_unknown',
    });
    expect(session!.lastSeenAt).not.toBeNull();

    const presence = await env.DB.prepare(
      `SELECT kind, state, actor_id AS actorId, source_key AS sourceKey, ended_at AS endedAt
         FROM agent_presences WHERE actor_id = ?`,
    ).bind(sessionId).first<{
      kind: string; state: string; actorId: string; sourceKey: string; endedAt: string | null;
    }>();
    expect(presence).toMatchObject({
      kind: 'mcp_session', state: 'online', actorId: sessionId, sourceKey: 'life-session', endedAt: null,
    });

    const connectionRoot = await env.DB.prepare(
      `SELECT a.actor_class AS actorClass, a.lineage_status AS lineageStatus
         FROM agents session
         JOIN oauth_tokens t ON t.id = session.oauth_token_id
         JOIN agents a ON a.id = t.copilot_id
        WHERE session.id = ?`,
    ).bind(connection.id).first<{ actorClass: string; lineageStatus: string }>();
    expect(connectionRoot).toEqual({ actorClass: 'connection_copilot', lineageStatus: 'complete' });
  });

  it('refreshes MCP presence on meaningful tool activity', async () => {
    const first = await mcpCall(connection.apiKey, 'get_briefing', {}, 'life-touch');
    const actorId = first.body.you.id as string;
    await env.DB.prepare(
      `UPDATE agents SET last_seen_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`,
    ).bind(actorId).run();
    await env.DB.prepare(
      `UPDATE agent_presences SET state = 'dormant', last_seen_at = '2000-01-01T00:00:00.000Z' WHERE actor_id = ?`,
    ).bind(actorId).run();

    await mcpList(connection.apiKey, 'life-touch');
    expect(await env.DB.prepare(
      `SELECT state, last_seen_at AS lastSeenAt FROM agent_presences WHERE actor_id = ?`,
    ).bind(actorId).first()).toEqual({ state: 'dormant', lastSeenAt: '2000-01-01T00:00:00.000Z' });

    await mcpCall(connection.apiKey, 'get_briefing', {}, 'life-touch');
    const refreshed = await env.DB.prepare(
      `SELECT state, last_seen_at AS lastSeenAt FROM agent_presences WHERE actor_id = ?`,
    ).bind(actorId).first<{ state: string; lastSeenAt: string }>();
    expect(refreshed!.state).toBe('online');
    expect(Date.parse(refreshed!.lastSeenAt)).toBeGreaterThan(Date.parse('2000-01-01T00:00:00.000Z'));
  });

  it('keeps an older Worker INSERT compatible during a rolling migration', async () => {
    const owner = await env.DB.prepare('SELECT user_id AS userId FROM agents WHERE id = ?')
      .bind(connection.id).first<{ userId: string }>();
    // This is deliberately the pre-0081 column shape: no actor_class, lineage or lifecycle fields.
    await env.DB.prepare(
      `INSERT INTO agents (id, name, kind, user_id, project_id, session_id, created_at)
       VALUES ('agt_legacy_writer', 'legacy-writer', 'copilot', ?, ?, 'legacy-writer-session', ?)`,
    ).bind(owner!.userId, projectId, new Date().toISOString()).run();

    expect(await env.DB.prepare(
      `SELECT actor_class AS actorClass, lineage_status AS lineageStatus, lineage_reason AS lineageReason
         FROM agents WHERE id = 'agt_legacy_writer'`,
    ).first()).toMatchObject({
      actorClass: 'session_copilot',
      lineageStatus: 'partial',
      lineageReason: 'immediate_parent_unknown',
    });
    expect(await env.DB.prepare(
      `SELECT kind, state FROM agent_presences WHERE actor_id = 'agt_legacy_writer'`,
    ).first()).toMatchObject({ kind: 'mcp_session', state: 'unknown' });
  });

  it('projects Runner and run-process lifecycle through existing writes', async () => {
    const owner = await env.DB.prepare('SELECT user_id AS userId FROM agents WHERE id = ?')
      .bind(connection.id).first<{ userId: string }>();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO runners (id, owner_user_id, label, status, last_heartbeat_at, created_at)
       VALUES ('rnr_lifecycle', ?, 'lifecycle', 'online', ?, ?)`,
    ).bind(owner!.userId, now, now).run();

    expect(await env.DB.prepare(
      `SELECT state FROM agent_presences WHERE kind = 'runner_daemon' AND runner_id = 'rnr_lifecycle'`,
    ).first()).toMatchObject({ state: 'online' });

    await env.DB.prepare(
      `INSERT INTO runs (id, project_id, runner_id, kind, repo_ref, agent_tool, status, created_by)
       VALUES ('run_lifecycle', ?, 'rnr_lifecycle', 'build', 'repo_lifecycle', 'claude', 'running', ?)`,
    ).bind(projectId, owner!.userId).run();
    await env.DB.prepare(
      `INSERT INTO agents (
         id, name, status, kind, actor_class, user_id, project_id, runner_id,
         last_seen_at, lineage_status, lineage_reason, lifecycle_updated_at
       ) VALUES (
         'agt_lifecycle', 'runner-lifecycle', 'active', 'agent', 'runner_agent', ?, ?, 'rnr_lifecycle',
         ?, 'partial', 'execution_contract_pending', ?
       )`,
    ).bind(owner!.userId, projectId, now, now).run();
    await env.DB.prepare("UPDATE runs SET agent_id = 'agt_lifecycle' WHERE id = 'run_lifecycle'").run();

    const live = await env.DB.prepare(
      `SELECT actor_id AS actorId, runner_id AS runnerId, run_id AS runId, sitting, state
         FROM agent_presences WHERE actor_id = 'agt_lifecycle'`,
    ).first<{ actorId: string; runnerId: string; runId: string; sitting: number; state: string }>();
    expect(live).toMatchObject({
      actorId: 'agt_lifecycle', runnerId: 'rnr_lifecycle', runId: 'run_lifecycle', sitting: 1, state: 'working',
    });

    await env.DB.prepare("UPDATE agents SET status = 'offline' WHERE id = 'agt_lifecycle'").run();
    const ended = await env.DB.prepare(
      `SELECT state, ended_at AS endedAt, end_reason AS endReason
         FROM agent_presences WHERE actor_id = 'agt_lifecycle'`,
    ).first<{ state: string; endedAt: string | null; endReason: string | null }>();
    expect(ended!.state).toBe('ended');
    expect(ended!.endedAt).not.toBeNull();
    expect(ended!.endReason).toBe('run_agent_offline');

    await env.DB.prepare(
      `UPDATE runners SET status = 'offline', offboarded_at = ? WHERE id = 'rnr_lifecycle'`,
    ).bind(now).run();
    expect(await env.DB.prepare(
      `SELECT state, end_reason AS endReason FROM agent_presences
        WHERE kind = 'runner_daemon' AND runner_id = 'rnr_lifecycle'`,
    ).first()).toMatchObject({ state: 'ended', endReason: 'runner_offboarded' });
  });

  it('exposes grouped classification as an admin-only, non-mutating dry run', async () => {
    const denied = await SELF.fetch('https://noriq.test/api/admin/agent-lifecycle/classification', {
      headers: { Cookie: memberCookie },
    });
    expect(denied.status).toBe(403);

    const res = await SELF.fetch('https://noriq.test/api/admin/agent-lifecycle/classification', {
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      dryRun: boolean;
      mutationPerformed: boolean;
      summary: {
        actors: number;
        presences: number;
        durableActorDeleteCandidates: number;
        verifiedPresencePurgeCandidates: number;
      };
      actors: Array<{ actorClass: string; count: number }>;
      presences: Array<{ kind: string; count: number }>;
    };
    expect(body.dryRun).toBe(true);
    expect(body.mutationPerformed).toBe(false);
    expect(body.summary.actors).toBeGreaterThan(0);
    expect(body.summary.presences).toBeGreaterThan(0);
    expect(body.summary.durableActorDeleteCandidates).toBe(0);
    expect(body.summary.verifiedPresencePurgeCandidates).toBe(0);
    expect(body.actors.some((r) => r.actorClass === 'session_copilot')).toBe(true);
    expect(body.presences.some((r) => r.kind === 'mcp_session')).toBe(true);
  });
});
