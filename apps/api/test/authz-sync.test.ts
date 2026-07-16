// PLNR-96: delta-sync (my_updates / notices) must not leak another tenant's
// unassigned comments or broadcast messages, and send_message must not target an
// agent the caller's tenant can't reach.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall, mintTokenForUser } from './helpers';

let agent: { id: string; apiKey: string };
let foreignAgentId: string;

beforeAll(async () => {
  agent = await createAgent('sync-authz-agent');
  // Bob (REST) — a different user with an unassigned comment + a broadcast message
  // on his own private project, neither of which the agent should ever see.
  await createUser('sx-bob@example.com', 'SX Bob', 'longenough1').catch(() => {});
  const bobCookie = await loginSession('sx-bob@example.com', 'longenough1');
  const bp = await SELF.fetch('https://noriq.test/api/projects', {
    method: 'POST', headers: { Cookie: bobCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'SXBOB', name: "Bob's sync" }),
  });
  const bobPid = (await bp.json() as { id: string }).id;
  const t = await SELF.fetch(`https://noriq.test/api/projects/${bobPid}/tasks`, {
    method: 'POST', headers: { Cookie: bobCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'bob unclaimed task' }),
  });
  const tid = (await t.json() as { id: string }).id;
  await SELF.fetch(`https://noriq.test/api/projects/${bobPid}/tasks/${tid}/comments`, {
    method: 'POST', headers: { Cookie: bobCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'question', body: 'BOB-SECRET-QUESTION' }),
  });
  await SELF.fetch(`https://noriq.test/api/projects/${bobPid}/messages`, {
    method: 'POST', headers: { Cookie: bobCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'BOB-SECRET-BROADCAST' }),
  });

  // A GENUINE agent under a different user — the real target for the cross-tenant
  // send_message rejection (an id that actually exists, unlike agt_does_not_exist,
  // which the old FK-violating code rejected anyway).
  const foreignToken = await mintTokenForUser('sx-foreign@example.com');
  foreignAgentId = (await mcpCall(foreignToken, 'set_agent_identity', { name: 'sx-foreign-agent' })).body.actingAs.id;
}, 60000);

describe('delta-sync is user-scoped (PLNR-96)', () => {
  it("my_updates does not leak another user's unassigned comments", async () => {
    const u = await mcpCall(agent.apiKey, 'my_updates', {});
    expect(JSON.stringify(u.body)).not.toContain('BOB-SECRET-QUESTION');
  });

  it("my_updates does not leak another user's broadcast messages", async () => {
    const u = await mcpCall(agent.apiKey, 'my_updates', {});
    expect(JSON.stringify(u.body)).not.toContain('BOB-SECRET-BROADCAST');
  });

  it('send_message rejects an unknown target agent', async () => {
    const p = await mcpCall(agent.apiKey, 'create_project', { key: 'SXAGT', name: 'mine' });
    const r = await mcpCall(agent.apiKey, 'send_message', { projectId: p.body.id, toAgentId: 'agt_does_not_exist', body: 'x' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/cannot be messaged|not found/);
  });

  it("send_message rejects a REAL agent whose user can't reach the project (the actual injection path)", async () => {
    // Sender can reach `p` (their own project); the target is a real agent owned by a
    // different user who cannot. The OLD code inserted the FK-valid id and succeeded —
    // so this genuinely pins the fix (the agt_does_not_exist case did not).
    const p = await mcpCall(agent.apiKey, 'create_project', { key: 'SXAGT2', name: 'mine2' });
    const r = await mcpCall(agent.apiKey, 'send_message', { projectId: p.body.id, toAgentId: foreignAgentId, body: 'x' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/cannot be messaged/);
  });
});
