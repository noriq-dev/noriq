// Agent re-model: one connection (token) → many agents (MCP sessions), each project-local.
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { createAgent, loginSession, createUser, mcpCall } from './helpers';

let conn: { id: string; apiKey: string }; // one OAuth connection (token)
let projectId: string;
let otherProjectId: string;

beforeAll(async () => {
  conn = await createAgent('remodel-conn');
  const p = await mcpCall(conn.apiKey, 'create_project', { key: 'RMD', name: 'remodel' });
  projectId = p.body.id;
  const p2 = await mcpCall(conn.apiKey, 'create_project', { key: 'RMD2', name: 'remodel-other' });
  otherProjectId = p2.body.id;
}, 60000);

describe('agents are per-session, project-local', () => {
  it('two MCP sessions on ONE connection are two distinct agents', async () => {
    const a = await mcpCall(conn.apiKey, 'set_agent_identity', { name: 'alpha', projectId }, 'sess-A');
    const b = await mcpCall(conn.apiKey, 'set_agent_identity', { name: 'beta', projectId }, 'sess-B');
    expect(a.isError).toBe(false);
    expect(b.isError).toBe(false);
    expect(a.body.actingAs.id).not.toBe(b.body.actingAs.id);
    expect(a.body.actingAs.name).toBe('alpha');
    expect(b.body.actingAs.name).toBe('beta');
  });

  it('the same session id is a stable agent across calls', async () => {
    const first = await mcpCall(conn.apiKey, 'get_briefing', {}, 'sess-A');
    expect(first.body.you.name).toBe('alpha');
  });

  it('project snapshot lists only that project’s agents', async () => {
    // scope one agent to the OTHER project
    await mcpCall(conn.apiKey, 'set_agent_identity', { name: 'gamma', projectId: otherProjectId }, 'sess-C');
    const cookie = await bootAdmin();
    const snap = await (await SELF.fetch(`https://noriq.test/api/projects/${projectId}/snapshot`, { headers: { Cookie: cookie } })).json() as {
      agents: Array<{ name: string; parentAgentId: string | null }>;
    };
    const names = snap.agents.map((a) => a.name);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    expect(names).not.toContain('gamma'); // belongs to the other project
  });

  it('the same friendly name is allowed in different projects (PLNR-65)', async () => {
    const here = await mcpCall(conn.apiKey, 'set_agent_identity', { name: 'builder', projectId }, 'sess-dup1');
    const there = await mcpCall(conn.apiKey, 'set_agent_identity', { name: 'builder', projectId: otherProjectId }, 'sess-dup2');
    expect(here.isError).toBe(false);
    expect(there.isError).toBe(false);
    expect(here.body.actingAs.name).toBe('builder');
    expect(there.body.actingAs.name).toBe('builder');
    expect(here.body.actingAs.id).not.toBe(there.body.actingAs.id);
    // But a second 'builder' in the SAME project is refused.
    const clash = await mcpCall(conn.apiKey, 'set_agent_identity', { name: 'builder', projectId }, 'sess-dup3');
    expect(clash.isError).toBe(true);
    expect(clash.text).toMatch(/already taken in this project/);
  });

  it('the Agents roster is scoped to a project too', async () => {
    await mcpCall(conn.apiKey, 'set_agent_identity', { name: 'roster-here', projectId }, 'sess-r1');
    await mcpCall(conn.apiKey, 'set_agent_identity', { name: 'roster-there', projectId: otherProjectId }, 'sess-r2');
    const cookie = await bootAdmin();
    const roster = await (await SELF.fetch(`https://noriq.test/api/agents?projectId=${projectId}`, { headers: { Cookie: cookie } })).json() as {
      agents: Array<{ name: string }>;
    };
    const names = roster.agents.map((a) => a.name);
    expect(names).toContain('roster-here');
    expect(names).not.toContain('roster-there');
  });

  it('?kind=copilot lists copilots by OWNER, reaching the ones no project can see (PLNR-156)', async () => {
    const cookie = await bootAdmin();
    const get = async (qs: string) =>
      ((await (await SELF.fetch(`https://noriq.test/api/agents?${qs}`, { headers: { Cookie: cookie } })).json()) as {
        agents: Array<{ id: string; kind: string; projectId?: string | null; parentAgentId: string | null; clientName?: string | null }>;
      }).agents;

    // A connection copilot has project_id NULL by design (PLNR-155), so the project-scoped
    // roster CANNOT see it — that is the whole reason this is a separate read and not a filter.
    const inProject = await get(`projectId=${projectId}`);
    const copilots = await get('kind=copilot');

    const connections = copilots.filter((a) => a.clientName);
    expect(connections.length).toBeGreaterThan(0); // present here...
    for (const conn0 of connections) {
      expect(inProject.some((a) => a.id === conn0.id)).toBe(false); // ...and invisible there
      expect(conn0.projectId ?? null).toBeNull();
    }
    // Only copilots come back — a runner's agent is the other tab's business.
    expect(copilots.every((a) => a.kind === 'copilot')).toBe(true);

    // And the tree is intact: some session hangs off a connection in the same list.
    expect(copilots.some((a) => a.parentAgentId && copilots.some((p) => p.id === a.parentAgentId))).toBe(true);
  });

  it('?kind=agent narrows the project roster to runner-spawned agents (PLNR-156)', async () => {
    const cookie = await bootAdmin();
    const agents = ((await (await SELF.fetch(`https://noriq.test/api/agents?projectId=${projectId}&kind=agent`, {
      headers: { Cookie: cookie },
    })).json()) as { agents: Array<{ kind: string }> }).agents;
    expect(agents.every((a) => a.kind === 'agent')).toBe(true);
  });

  it('a sub-agent is attributed to its parent', async () => {
    const parent = await mcpCall(conn.apiKey, 'set_agent_identity', { name: 'lead', projectId }, 'sess-lead');
    const sub = await mcpCall(conn.apiKey, 'set_agent_identity', { name: 'helper', projectId, parentAgentId: parent.body.actingAs.id }, 'sess-sub');
    expect(sub.body.parentAgentId).toBe(parent.body.actingAs.id);

    const cookie = await bootAdmin();
    const snap = await (await SELF.fetch(`https://noriq.test/api/projects/${projectId}/snapshot`, { headers: { Cookie: cookie } })).json() as {
      agents: Array<{ name: string; parentAgentId: string | null }>;
    };
    const helper = snap.agents.find((a) => a.name === 'helper');
    expect(helper?.parentAgentId).toBe(parent.body.actingAs.id);
  });
});

// --- copilots vs runner-spawned agents (RUN-43 / migration 0026) -------------------
describe('copilot / agent split', () => {
  it('a human session is a copilot, and says so', async () => {
    const b = await mcpCall(conn.apiKey, 'get_briefing', {}, 'sess-kind');
    expect(b.body.you.kind).toBe('copilot');
  });

  it('a connection registers a copilot, but is still not an AGENT (PLNR-155)', async () => {
    // This USED to assert nothing sessionless exists at all, because 0026 had just deleted the
    // "connection agent": project_id NULL, did no work, existed only so oauth_tokens.agent_id
    // had a target — an idle agent nobody created. PLNR-155 deliberately brings a sessionless
    // row back, so the assertion moves to what actually distinguished the phantom: this one is
    // LABELLED, it is OWNED by a connection, and it is the head of a tree.
    const { results } = await env.DB.prepare(
      `SELECT a.id, a.label, a.project_id AS projectId,
              (SELECT COUNT(*) FROM oauth_tokens t WHERE t.copilot_id = a.id) AS owners
         FROM agents a WHERE a.session_id IS NULL AND a.kind = 'copilot'`,
    ).all<{ id: string; label: string | null; projectId: string | null; owners: number }>();
    expect(results.length).toBeGreaterThan(0); // the grant DOES register one now
    for (const r of results) {
      expect(r.label).toBeTruthy(); // a name a human recognises, not an anonymous placeholder
      expect(r.owners).toBeGreaterThan(0); // it belongs to a connection; nothing dangles
      expect(r.projectId).toBeNull(); // a copilot roams — it is not project-local
    }

    // The load-bearing half, unchanged: a human's grant must never BIND an agent. If it did,
    // agentAuth would return connection.boundAgent and /mcp would act AS the connection —
    // collapsing every chat on it into one identity. copilot_id and agent_id are never both.
    const bound = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM oauth_tokens WHERE copilot_id IS NOT NULL AND agent_id IS NOT NULL',
    ).first<{ n: number }>();
    expect(bound!.n).toBe(0);
  });

  it('refuses a sessionless call instead of inventing somebody to be', async () => {
    const res = await SELF.fetch('https://noriq.test/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${conn.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_briefing', arguments: {} } }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('no MCP session');
  });

  it('a revoked copilot cannot respawn itself by reusing its session id', async () => {
    // The regression this guards is silent. resolveSessionAgent used to filter
    // `status != 'revoked'`, so a revoked agent was invisible rather than refused — the
    // lookup fell through to the INSERT and minted a REPLACEMENT identity on the same
    // session, handing the revoked agent its access straight back. Now that a connection is
    // not an agent, this is the only place left where revocation can bite.
    const victim = await createAgent('revoke-respawn');
    const before = await mcpCall(victim.apiKey, 'get_briefing', {}, 'sess-revoked');
    const agentId = before.body.you.id as string;

    const cookie = await bootAdmin();
    const res = await SELF.fetch(`https://noriq.test/api/agents/${agentId}/revoke`, {
      method: 'POST', headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);

    const after = await SELF.fetch('https://noriq.test/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${victim.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Session-Id': 'sess-revoked',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_briefing', arguments: {} } }),
    });
    expect(after.status).toBe(401);

    // And no replacement row was quietly created for that session.
    const { results } = await env.DB.prepare("SELECT id, status FROM agents WHERE session_id = 'sess-revoked'")
      .all<{ id: string; status: string }>();
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('revoked');
  });

  it('the schema itself refuses a malformed agent — this is not a convention', async () => {
    // An agent with no runner, and a copilot that owns one, are both rejected by a CHECK
    // rather than by code remembering to look. That is the point of spending the migration
    // on it instead of a helper function.
    await expect(
      env.DB.prepare("INSERT INTO agents (id, name, kind, project_id) VALUES ('agt_nr', 'agt_nr', 'agent', ?)")
        .bind(projectId).run(),
    ).rejects.toThrow(/CHECK constraint failed/);

    await env.DB.prepare("INSERT OR IGNORE INTO runners (id, label) VALUES ('rnr_split', 'split')").run();
    await expect(
      env.DB.prepare("INSERT INTO agents (id, name, kind, runner_id) VALUES ('agt_cr', 'agt_cr', 'copilot', 'rnr_split')").run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});

let adminCookie: string | null = null;
async function bootAdmin(): Promise<string> {
  if (adminCookie) return adminCookie;
  await createUser('remodel-admin@example.com', 'Remodel Admin', 'longenough1', 'admin').catch(() => {});
  adminCookie = await loginSession('remodel-admin@example.com', 'longenough1');
  return adminCookie;
}
