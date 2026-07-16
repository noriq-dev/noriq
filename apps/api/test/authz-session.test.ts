// PLNR-101: the MCP session id is client-supplied (echoed from initialize). It must
// be bound to the authenticated user — a leaked session id replayed with a DIFFERENT
// user's token must not resolve to the original user's agent.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createUser, loginSession, mcpCall } from './helpers';

const REDIRECT = 'http://localhost:39997/cb';

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Full OAuth mint bound to a specific user (helpers.createAgent uses one shared user). */
async function mintTokenForUser(email: string): Promise<string> {
  await createUser(email, email, 'longenough1').catch(() => {});
  const cookie = await loginSession(email, 'longenough1');
  const reg = await SELF.fetch('https://noriq.test/oauth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'hijack-test', redirect_uris: [REDIRECT] }),
  });
  const clientId = (await reg.json() as { client_id: string }).client_id;
  const verifier = `verifier-${email}-`.padEnd(48, 'x');
  const form = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT,
    code_challenge: await s256(verifier), code_challenge_method: 'S256', scope: 'mcp', state: 's', decision: 'approve',
  });
  const approve = await SELF.fetch('https://noriq.test/oauth/authorize', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(), redirect: 'manual',
  });
  const code = new URL(approve.headers.get('Location')!).searchParams.get('code')!;
  const tok = await SELF.fetch('https://noriq.test/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }).toString(),
  });
  return (await tok.json() as { access_token: string }).access_token;
}

/** Initialize an MCP session under a chosen (client-supplied) session id. */
async function initSession(apiKey: string, sessionId: string): Promise<void> {
  await SELF.fetch('https://noriq.test/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
  });
}

let victimToken: string;
let attackerToken: string;
const victimSession = 'hijack-session-victim-0001';

beforeAll(async () => {
  victimToken = await mintTokenForUser('hj-victim@example.com');
  attackerToken = await mintTokenForUser('hj-attacker@example.com');
  await initSession(victimToken, victimSession); // creates the victim's session agent
}, 60000);

describe('MCP session id is bound to the authenticated user (PLNR-101)', () => {
  it('the victim can use their own session', async () => {
    const r = await mcpCall(victimToken, 'get_briefing', {}, victimSession);
    expect(r.isError).toBe(false);
  });

  it("another user's token cannot act on the victim's session id", async () => {
    await expect(mcpCall(attackerToken, 'get_briefing', {}, victimSession)).rejects.toThrow(/does not belong|session/i);
  });
});
