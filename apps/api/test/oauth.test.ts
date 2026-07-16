import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall, sessionFor, authorizeForAllProjects } from './helpers';

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

/** Drive the REAL consent form and return the granted token pair.
 *
 *  `scope` is either 'all' (tick "All projects", RUN-58) or a list of ids, appended one
 *  repeated field at a time — exactly what N ticked checkboxes POST, which is the shape
 *  RUN-57 was mangling. An empty list is the bootstrap case: nothing to tick yet. */
async function consentFor(
  cookie: string, clientId: string, redirectUri: string, scope: string[] | 'all',
): Promise<{ access: string; refresh: string }> {
  const { verifier } = pkce();
  const q = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state: 's',
    code_challenge: await s256(verifier), code_challenge_method: 'S256', scope: 'mcp',
  });
  const form = new URLSearchParams(Object.fromEntries(q.entries()));
  form.set('decision', 'approve');
  if (scope === 'all') form.set('scope_all', '1');
  else for (const id of scope) form.append('project_ids', id);
  const approve = await SELF.fetch('https://noriq.test/oauth/authorize', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'manual',
  });
  const code = new URL(approve.headers.get('Location')!).searchParams.get('code')!;
  const tok = await SELF.fetch('https://noriq.test/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier,
    }).toString(),
  });
  const body = (await tok.json()) as { access_token: string; refresh_token: string };
  return { access: body.access_token, refresh: body.refresh_token };
}

describe('oauth 2.1 for MCP', () => {
  const redirectUri = 'http://localhost:33418/callback';
  let clientId: string;
  let accessToken: string;
  let refreshToken: string;

  it('serves discovery metadata', async () => {
    const as = await SELF.fetch('https://noriq.test/.well-known/oauth-authorization-server');
    expect(as.status).toBe(200);
    const meta = (await as.json()) as Record<string, unknown>;
    expect(meta.registration_endpoint).toContain('/oauth/register');
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);

    const rs = await SELF.fetch('https://noriq.test/.well-known/oauth-protected-resource');
    expect(((await rs.json()) as { resource: string }).resource).toContain('/mcp');
  });

  it('401 on /mcp advertises the resource metadata', async () => {
    const res = await SELF.fetch('https://noriq.test/mcp', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('oauth-protected-resource');
  });

  it('registers a client dynamically', async () => {
    const res = await SELF.fetch('https://noriq.test/oauth/register', {
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
    const page = await SELF.fetch(`https://noriq.test/oauth/authorize?${q}`, { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('on your behalf');

    // approve
    const form = new URLSearchParams(Object.fromEntries(q.entries()));
    form.set('decision', 'approve');
    form.set('agent_name', 'oauth-test-agent');
    const approve = await SELF.fetch('https://noriq.test/oauth/authorize', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
    });
    expect(approve.status).toBe(302);
    const loc = new URL(approve.headers.get('Location')!);
    expect(loc.searchParams.get('state')).toBe('xyz');
    expect(loc.searchParams.get('iss')).toBe('https://noriq.test'); // RFC 9207
    const code = loc.searchParams.get('code')!;
    expect(code).toBeTruthy();

    // exchange
    const token = await SELF.fetch('https://noriq.test/oauth/token', {
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

    // The token works on MCP under a per-session COPILOT. A connection is not an agent
    // (0026), so the grant mints no identity at all: the working one appears at initialize
    // and is named after the CLIENT ('Claude Code'). This previously asserted a user-derived
    // name — that was the now-deleted connection agent's `${firstname}-${clientname}` label.
    const briefing = await mcpCall(accessToken, 'get_briefing', {});
    expect(briefing.body.you.name).toContain('claude-code');
    expect(briefing.body.you.kind).toBe('copilot');
  });

  it('set_agent_identity rebinds the token to a named agent', async () => {
    const set = await mcpCall(accessToken, 'set_agent_identity', { name: 'atlas-prime', role: 'orchestrator' });
    expect(set.isError).toBe(false);
    expect(set.body.actingAs.name).toBe('atlas-prime');
    const briefing = await mcpCall(accessToken, 'get_briefing', {});
    expect(briefing.body.you.name).toBe('atlas-prime');
    expect(briefing.body.you.role).toBe('orchestrator');
  });

  it('scopes a token to EVERY ticked project, not just the last (RUN-57)', async () => {
    // The whole bug hid behind having ONE project: N checkboxes all named project_ids POST N
    // fields, and parseBody() without all:true kept only the LAST — so every grant silently
    // scoped to a single project. It fails RESTRICTIVELY, so nothing ever complained; the
    // fixtures just reached for authorizeForAllProjects and the picker itself stayed untested.
    // Its OWN user: several tests below consent without ticking anything, which only works
    // while their user has no projects — so handing the shared oauth-user fixture three
    // would break them from a distance.
    const email = 'multiscope@example.com';
    const own = await loginSession(email, 'longenough1').catch(async () => {
      await createUser(email, 'Multi Scope', 'longenough1');
      return loginSession(email, 'longenough1');
    });
    // Bootstrap: with nothing to tick, consent is allowed unscoped — and that token is what
    // creates the projects the real grant below then ticks.
    const { access: boot } = await consentFor(own, clientId, redirectUri, []);
    const keys = ['MTA', 'MTB', 'MTC'];
    const ids: string[] = [];
    for (const k of keys) {
      const r = await mcpCall(boot, 'create_project', { key: k, name: `multi ${k}` });
      ids.push(r.body.id as string);
    }

    const { access: granted } = await consentFor(own, clientId, redirectUri, ids);

    // Asserted through what the human actually experiences — the projects the connection can
    // reach — rather than by reading the join table, which is the thing under test.
    const listed = await mcpCall(granted, 'list_projects', {});
    const reachable = (listed.body.projects as Array<{ key: string }>).map((p) => p.key);
    for (const k of keys) expect(reachable).toContain(k); // pre-fix: only 'MTC' survived
  });

  it('set_agent_identity refuses a name already taken in the same project', async () => {
    // Two independent connections (kept off `accessToken` so the refresh test's
    // identity is untouched). Names are unique per project now, so the second collides.
    const owner = await createAgent('coll-owner');
    const other = await createAgent('coll-other');
    const proj = await mcpCall(owner.apiKey, 'create_project', { key: 'OWN', name: 'ownership' });
    // `other` was minted before OWN existed, so it is not scoped for it (RUN-38) and would be
    // refused for the wrong reason — this test is about NAME collision, not scope.
    await authorizeForAllProjects(other.apiKey);
    const mine = await mcpCall(owner.apiKey, 'set_agent_identity', { name: 'shared-name', projectId: proj.body.id });
    expect(mine.isError).toBe(false);
    const steal = await mcpCall(other.apiKey, 'set_agent_identity', { name: 'shared-name', projectId: proj.body.id });
    expect(steal.isError).toBe(true);
    expect(steal.text).toMatch(/already taken in this project|owned by another/);
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
    const approve = await SELF.fetch('https://noriq.test/oauth/authorize', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
    });
    const code = new URL(approve.headers.get('Location')!).searchParams.get('code')!;
    const token = await SELF.fetch('https://noriq.test/oauth/token', {
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
    const res = await SELF.fetch('https://noriq.test/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
    });
    expect(res.status).toBe(200);
    const t = (await res.json()) as { access_token: string; refresh_token: string };
    expect(t.access_token).not.toBe(accessToken);

    // old refresh token is dead (rotation)
    const replay = await SELF.fetch('https://noriq.test/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
    });
    expect(replay.status).toBe(400);

    // The new access token works and still acts as the rebound identity — but note WHY it
    // does. Identity used to ride the token (it mapped to a connection agent), so rotation
    // carried it along for free. Since 0026 it rides the MCP SESSION: rotate the credential,
    // keep the session, keep the copilot. So the session id is passed explicitly here, which
    // is what a real client does — it refreshes its token without re-running initialize.
    const briefing = await mcpCall(t.access_token, 'get_briefing', {}, sessionFor(accessToken));
    expect(briefing.body.you.name).toBe('atlas-prime');
    expect(briefing.body.you.kind).toBe('copilot');
  });
});

// --- the connection registers its copilot; sessions hang off it (PLNR-155) -----------------
describe('connection copilot (PLNR-155)', () => {
  const redirectUri = 'http://localhost:33418/callback';
  let clientId: string;
  const db = () => (env as unknown as { DB: D1Database }).DB;

  const sha256Hex = async (s: string) => {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  beforeAll(async () => {
    const res = await SELF.fetch('https://noriq.test/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Copilot Client', redirect_uris: [redirectUri] }),
    });
    clientId = ((await res.json()) as { client_id: string }).client_id;
  });

  async function grant(email: string): Promise<{ access: string; refresh: string }> {
    const cookie = await loginSession(email, 'longenough1').catch(async () => {
      await createUser(email, 'Copilot Human', 'longenough1');
      return loginSession(email, 'longenough1');
    });
    return consentFor(cookie, clientId, redirectUri, []);
  }

  const copilotOf = async (access: string) =>
    (await db().prepare('SELECT copilot_id AS id FROM oauth_tokens WHERE token_hash = ?')
      .bind(await sha256Hex(access)).first<{ id: string | null }>())!.id;

  it('registers the copilot at authorize — before any MCP call', async () => {
    const { access } = await grant('copilot-a@example.com');
    const id = await copilotOf(access);
    expect(id).toMatch(/^agt_/); // exists already: a `claude mcp add` is visible immediately

    const row = await db().prepare(
      'SELECT kind, label, project_id AS projectId, session_id AS sessionId, runner_id AS runnerId FROM agents WHERE id = ?',
    ).bind(id).first<{ kind: string; label: string; projectId: string | null; sessionId: string | null; runnerId: string | null }>();
    expect(row!.kind).toBe('copilot');
    expect(row!.label).toContain('copilot-client'); // reads as "<human>-<client>", not an opaque id
    expect(row!.projectId).toBeNull(); // a copilot roams; it is not project-local
    expect(row!.sessionId).toBeNull(); // it is the CONNECTION's, not any one chat's
    expect(row!.runnerId).toBeNull(); // 0026's CHECK: only kind='agent' is runner-owned
  });

  it('parents each session copilot to it, with nobody self-registering', async () => {
    const { access } = await grant('copilot-b@example.com');
    const parent = await copilotOf(access);

    // No set_agent_identity anywhere — the session simply IS somebody (PLNR-157).
    const briefing = await mcpCall(access, 'get_briefing', {});
    const me = (briefing.body.you as { id: string; kind: string });
    expect(me.kind).toBe('copilot');
    expect(me.id).not.toBe(parent); // the chat is its own actor, not the connection itself

    const child = await db().prepare('SELECT parent_agent_id AS parent FROM agents WHERE id = ?')
      .bind(me.id).first<{ parent: string | null }>();
    expect(child!.parent).toBe(parent); // ← the tree
  });

  it('survives a refresh — rotation must not orphan the copilot', async () => {
    const { access, refresh } = await grant('copilot-c@example.com');
    const before = await copilotOf(access);

    const res = await SELF.fetch('https://noriq.test/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }).toString(),
    });
    const rotated = ((await res.json()) as { access_token: string }).access_token;

    // "A connection is simply its oauth_tokens row" stops being true exactly here — refresh
    // swaps the row. Drop the copilot and its session children lose their parent.
    expect(await copilotOf(rotated)).toBe(before);
  });
});

// --- "All projects": a grant that follows the user instead of freezing a list (RUN-58) -----
describe('all-projects scope (RUN-58)', () => {
  const redirectUri = 'http://localhost:33418/callback';
  let clientId: string;

  /** A signed-in user with a bootstrap token — the one that creates the projects to grant. */
  async function userWithBoot(email: string): Promise<{ cookie: string; boot: string }> {
    const cookie = await loginSession(email, 'longenough1').catch(async () => {
      await createUser(email, email, 'longenough1');
      return loginSession(email, 'longenough1');
    });
    const { access: boot } = await consentFor(cookie, clientId, redirectUri, []);
    return { cookie, boot };
  }

  beforeAll(async () => {
    const res = await SELF.fetch('https://noriq.test/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Scope All Client', redirect_uris: [redirectUri] }),
    });
    clientId = ((await res.json()) as { client_id: string }).client_id;
  });

  it('reaches a project created AFTER the grant, and still never another user’s', async () => {
    const mine = await userWithBoot('scopeall@example.com');
    await mcpCall(mine.boot, 'create_project', { key: 'SAA', name: 'before the grant' });

    // Tick "All projects" — note zero ids are sent, which under RUN-38's rules would otherwise
    // be "scoped to nothing".
    const { access: granted } = await consentFor(mine.cookie, clientId, redirectUri, 'all');

    // The whole point: this did not exist when the grant was made. A frozen list misses it.
    await mcpCall(mine.boot, 'create_project', { key: 'SAB', name: 'after the grant' });

    // Someone else's project, created by their own connection — "all" must not mean theirs.
    const theirs = await userWithBoot('scopeall-other@example.com');
    await mcpCall(theirs.boot, 'create_project', { key: 'OTH', name: 'not yours' });

    const listed = await mcpCall(granted, 'list_projects', {});
    const reachable = (listed.body.projects as Array<{ key: string }>).map((p) => p.key);
    expect(reachable).toContain('SAA');
    expect(reachable).toContain('SAB'); // ← the feature
    // "All" composes with USER_PROJECT_WHERE rather than bypassing it: all of MINE, not all.
    expect(reachable).not.toContain('OTH');
  });

  it('survives a refresh — rotation must not narrow it', async () => {
    const mine = await userWithBoot('scopeall-refresh@example.com');
    await mcpCall(mine.boot, 'create_project', { key: 'SAR', name: 'refresh me' });
    const granted = await consentFor(mine.cookie, clientId, redirectUri, 'all');

    const res = await SELF.fetch('https://noriq.test/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: granted.refresh }).toString(),
    });
    const rotated = ((await res.json()) as { access_token: string }).access_token;

    // An all-projects grant carries NO project rows, so a rotation that dropped the flag would
    // read as scoped-to-nothing and lock the connection out on its next refresh.
    const listed = await mcpCall(rotated, 'list_projects', {});
    expect((listed.body.projects as Array<{ key: string }>).map((p) => p.key)).toContain('SAR');
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
    const t = await mcpCall(agentKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'docs thing' });
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
