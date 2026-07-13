import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall } from './helpers';

let cookie: string;

beforeAll(async () => {
  cookie = await loginSession('oauth-user@example.com', 'longenough1').catch(async () => {
    await createUser('oauth-user@example.com', 'OAuth User', 'longenough1', 'admin');
    return loginSession('oauth-user@example.com', 'longenough1');
  });
});

function pkce() {
  const verifier = 'test-verifier-0123456789-0123456789-0123456789';
  return { verifier };
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('oauth 2.1 for MCP', () => {
  const redirectUri = 'http://localhost:33418/callback';
  let clientId: string;
  let accessToken: string;
  let refreshToken: string;

  it('serves discovery metadata', async () => {
    const as = await SELF.fetch('https://planar.test/.well-known/oauth-authorization-server');
    expect(as.status).toBe(200);
    const meta = (await as.json()) as Record<string, unknown>;
    expect(meta.registration_endpoint).toContain('/oauth/register');
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);

    const rs = await SELF.fetch('https://planar.test/.well-known/oauth-protected-resource');
    expect(((await rs.json()) as { resource: string }).resource).toContain('/mcp');
  });

  it('401 on /mcp advertises the resource metadata', async () => {
    const res = await SELF.fetch('https://planar.test/mcp', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('oauth-protected-resource');
  });

  it('registers a client dynamically', async () => {
    const res = await SELF.fetch('https://planar.test/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: [redirectUri] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string };
    clientId = body.client_id;
    expect(clientId).toMatch(/^client_/);
  });

  it('authorize → consent → code → token (PKCE) → MCP access', async () => {
    const { verifier } = pkce();
    const challenge = await s256(verifier);
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state: 'xyz',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'mcp',
    });

    // consent page renders for a signed-in user
    const page = await SELF.fetch(`https://planar.test/oauth/authorize?${q}`, { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('on your behalf');

    // approve
    const form = new URLSearchParams(Object.fromEntries(q.entries()));
    form.set('decision', 'approve');
    form.set('agent_name', 'oauth-test-agent');
    const approve = await SELF.fetch('https://planar.test/oauth/authorize', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
    });
    expect(approve.status).toBe(302);
    const loc = new URL(approve.headers.get('Location')!);
    expect(loc.searchParams.get('state')).toBe('xyz');
    const code = loc.searchParams.get('code')!;
    expect(code).toBeTruthy();

    // exchange
    const token = await SELF.fetch('https://planar.test/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    });
    expect(token.status).toBe(200);
    const t = (await token.json()) as { access_token: string; refresh_token: string };
    accessToken = t.access_token;
    refreshToken = t.refresh_token;
    expect(accessToken).toMatch(/^plnrt_/);

    // the token works on MCP under a default delegated identity (user+client derived)
    const briefing = await mcpCall(accessToken, 'get_briefing', {});
    expect(briefing.body.you.name).toContain('oauth');
  });

  it('set_agent_identity rebinds the token to a named agent', async () => {
    const set = await mcpCall(accessToken, 'set_agent_identity', { name: 'atlas-prime', role: 'orchestrator' });
    expect(set.isError).toBe(false);
    expect(set.body.actingAs.name).toBe('atlas-prime');
    const briefing = await mcpCall(accessToken, 'get_briefing', {});
    expect(briefing.body.you.name).toBe('atlas-prime');
    expect(briefing.body.you.role).toBe('orchestrator');
  });

  it('set_agent_identity refuses a name already taken in the same project', async () => {
    // Two independent connections (kept off `accessToken` so the refresh test's
    // identity is untouched). Names are unique per project now, so the second collides.
    const owner = await createAgent('coll-owner');
    const other = await createAgent('coll-other');
    const proj = await mcpCall(owner.apiKey, 'create_project', { key: 'OWN', name: 'ownership' });
    const mine = await mcpCall(owner.apiKey, 'set_agent_identity', { name: 'shared-name', projectId: proj.body.id });
    expect(mine.isError).toBe(false);
    const steal = await mcpCall(other.apiKey, 'set_agent_identity', { name: 'shared-name', projectId: proj.body.id });
    expect(steal.isError).toBe(true);
    expect(steal.text).toMatch(/already taken in this project/);
  });

  it('rejects a bad PKCE verifier', async () => {
    const challenge = await s256('right-verifier-right-verifier-right-verifier');
    const q = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp', state: '1',
    });
    const form = new URLSearchParams(Object.fromEntries(q.entries()));
    form.set('decision', 'approve');
    form.set('agent_name', 'oauth-test-agent');
    const approve = await SELF.fetch('https://planar.test/oauth/authorize', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
    });
    const code = new URL(approve.headers.get('Location')!).searchParams.get('code')!;
    const token = await SELF.fetch('https://planar.test/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: redirectUri,
        client_id: clientId, code_verifier: 'WRONG-verifier-WRONG-verifier-WRONG',
      }).toString(),
    });
    expect(token.status).toBe(400);
  });

  it('refresh rotates the token pair', async () => {
    const res = await SELF.fetch('https://planar.test/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
    });
    expect(res.status).toBe(200);
    const t = (await res.json()) as { access_token: string; refresh_token: string };
    expect(t.access_token).not.toBe(accessToken);

    // old refresh token is dead (rotation)
    const replay = await SELF.fetch('https://planar.test/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
    });
    expect(replay.status).toBe(400);

    // new access token works and inherits the rebound identity
    const briefing = await mcpCall(t.access_token, 'get_briefing', {});
    expect(briefing.body.you.name).toBe('atlas-prime');
  });
});

describe('tags', () => {
  let agentKey: string;
  let projectId: string;

  beforeAll(async () => {
    const a = await createAgent('tag-agent', 'orchestrator');
    agentKey = a.apiKey;
    const proj = await mcpCall(agentKey, 'create_project', { key: 'TAG', name: 'tags-project' });
    projectId = proj.body.id;
  });

  it('create_task applies multiple tags, auto-creating by name (idempotent)', async () => {
    const t1 = await mcpCall(agentKey, 'create_task', { projectId, title: 'api thing', tags: ['backend', 'auth'], type: 'bug' });
    expect(t1.isError).toBe(false);
    const t2 = await mcpCall(agentKey, 'create_task', { projectId, title: 'another api thing', tags: ['backend'] });
    expect(t2.isError).toBe(false);
    const proj = await mcpCall(agentKey, 'get_project', { projectId });
    expect(proj.body.tags.map((c: { name: string }) => c.name).sort()).toEqual(['auth', 'backend']);
    const task1 = proj.body.tasks.find((x: { id: string }) => x.id === t1.body.id);
    expect(task1.tags.split(',').sort()).toEqual(['auth', 'backend']);
    expect(task1.type).toBe('bug');
  });

  it('update_task replaces and clears the tag set', async () => {
    const t = await mcpCall(agentKey, 'create_task', { projectId, title: 'docs thing' });
    await mcpCall(agentKey, 'update_task', { projectId, taskId: t.body.id, tags: ['docs'], type: 'chore' });
    let proj = await mcpCall(agentKey, 'get_project', { projectId });
    let task = proj.body.tasks.find((x: { id: string }) => x.id === t.body.id);
    expect(task.tags).toBe('docs');
    expect(task.type).toBe('chore');
    await mcpCall(agentKey, 'update_task', { projectId, taskId: t.body.id, tags: [] });
    proj = await mcpCall(agentKey, 'get_project', { projectId });
    task = proj.body.tasks.find((x: { id: string }) => x.id === t.body.id);
    expect(task.tags).toBeNull();
  });
});
