// Profile sessions: a user can see & revoke their OAuth connections (agent re-model).
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createAgent, loginSession, mcpCall } from './helpers';

const MINT_USER = 'agent-mint@example.com';

async function sessions(cookie: string) {
  const res = await SELF.fetch('https://planar.test/api/auth/sessions', { headers: { Cookie: cookie } });
  return ((await res.json()) as { sessions: Array<{ id: string; clientName: string; agentCount: number }> }).sessions;
}
async function post(cookie: string, path: string) {
  return SELF.fetch(`https://planar.test${path}`, { method: 'POST', headers: { Cookie: cookie } });
}

describe('OAuth session management', () => {
  it('lists connections and revoke-all kills them', async () => {
    const conn = await createAgent('sess-all');
    const cookie = await loginSession(MINT_USER, 'longenough1');
    expect((await mcpCall(conn.apiKey, 'get_briefing', {})).isError).toBe(false);

    const list = await sessions(cookie);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0]).toHaveProperty('clientName');
    expect(list[0]).toHaveProperty('agentCount');

    expect((await post(cookie, '/api/auth/sessions/revoke-all')).status).toBe(200);
    // token no longer authenticates on /mcp (mcpCall throws on the 401)
    await expect(mcpCall(conn.apiKey, 'get_briefing', {})).rejects.toThrow(/401/);
    expect(await sessions(cookie)).toHaveLength(0);
  });

  it('revokes a single connection by id', async () => {
    // After revoke-all above, a fresh connection is the only live one.
    const conn = await createAgent('sess-one');
    const cookie = await loginSession(MINT_USER, 'longenough1');
    const list = await sessions(cookie);
    expect(list).toHaveLength(1);

    expect((await post(cookie, `/api/auth/sessions/${list[0]!.id}/revoke`)).status).toBe(200);
    await expect(mcpCall(conn.apiKey, 'get_briefing', {})).rejects.toThrow(/401/);
  });

  it('requires a session', async () => {
    const res = await SELF.fetch('https://planar.test/api/auth/sessions');
    expect(res.status).toBe(401);
  });
});
