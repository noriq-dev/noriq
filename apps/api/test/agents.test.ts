// Agent re-model: one connection (token) → many agents (MCP sessions), each project-local.
import { SELF } from 'cloudflare:test';
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
    const snap = await (await SELF.fetch(`https://planar.test/api/projects/${projectId}/snapshot`, { headers: { Cookie: cookie } })).json() as {
      agents: Array<{ name: string; parentAgentId: string | null }>;
    };
    const names = snap.agents.map((a) => a.name);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    expect(names).not.toContain('gamma'); // belongs to the other project
  });

  it('a sub-agent is attributed to its parent', async () => {
    const parent = await mcpCall(conn.apiKey, 'set_agent_identity', { name: 'lead', projectId }, 'sess-lead');
    const sub = await mcpCall(conn.apiKey, 'set_agent_identity', { name: 'helper', projectId, parentAgentId: parent.body.actingAs.id }, 'sess-sub');
    expect(sub.body.parentAgentId).toBe(parent.body.actingAs.id);

    const cookie = await bootAdmin();
    const snap = await (await SELF.fetch(`https://planar.test/api/projects/${projectId}/snapshot`, { headers: { Cookie: cookie } })).json() as {
      agents: Array<{ name: string; parentAgentId: string | null }>;
    };
    const helper = snap.agents.find((a) => a.name === 'helper');
    expect(helper?.parentAgentId).toBe(parent.body.actingAs.id);
  });
});

let adminCookie: string | null = null;
async function bootAdmin(): Promise<string> {
  if (adminCookie) return adminCookie;
  await createUser('remodel-admin@example.com', 'Remodel Admin', 'longenough1', 'admin').catch(() => {});
  adminCookie = await loginSession('remodel-admin@example.com', 'longenough1');
  return adminCookie;
}
