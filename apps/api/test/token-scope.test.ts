// RUN-38: a token reaches the projects a human ticked, and no others.
//
// The mechanism this replaces LOOKED present but was inert: oauth_tokens.scope was stored,
// echoed in the token response and threaded through issueTokens — and agentAuth never read it.
// Every token was issued 'mcp' and every valid token passed. These tests exist because
// half-built security reads as working, and the only way to tell the difference is to try it.
import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createUser, loginSession, mcpCall } from './helpers';

let cookie: string;
let clientId: string;
let allowedPid: string;
let forbiddenPid: string;

const s256 = async (v: string) => {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  return btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const REDIRECT = 'http://localhost:39997/cb';

/** Run the real consent flow, ticking exactly `projectIds`. Returns the token pair. */
async function mintPair(projectIds: string[], verifierSeed = 'a'): Promise<{ access: string; refresh: string }> {
  const verifier = `scope-verifier-${verifierSeed}-`.padEnd(48, 'x');
  const form = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT,
    code_challenge: await s256(verifier), code_challenge_method: 'S256', scope: 'mcp', state: 's',
    decision: 'approve',
  });
  for (const id of projectIds) form.append('project_ids', id);
  const approve = await SELF.fetch('https://planar.test/oauth/authorize', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(), redirect: 'manual',
  });
  const loc = approve.headers.get('Location');
  if (!loc) throw new Error(`consent refused: ${approve.status}`);
  const code = new URL(loc).searchParams.get('code')!;
  const tok = await SELF.fetch('https://planar.test/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier,
    }).toString(),
  });
  const body = (await tok.json()) as { access_token: string; refresh_token: string };
  return { access: body.access_token, refresh: body.refresh_token };
}

const mint = async (projectIds: string[], seed = 'a') => (await mintPair(projectIds, seed)).access;

beforeAll(async () => {
  await createUser('scope-owner@example.com', 'Scope Owner', 'longenough1', 'member').catch(() => {});
  cookie = await loginSession('scope-owner@example.com', 'longenough1');
  const reg = await SELF.fetch('https://planar.test/oauth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'scope-test', redirect_uris: [REDIRECT] }),
  });
  clientId = ((await reg.json()) as { client_id: string }).client_id;
  const mk = async (key: string, name: string) => {
    const r = await SELF.fetch('https://planar.test/api/projects', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, name }),
    });
    return ((await r.json()) as { id: string }).id;
  };
  allowedPid = await mk('SCPA', 'scope-allowed');
  forbiddenPid = await mk('SCPB', 'scope-forbidden');
}, 60000);

describe('token project scope (RUN-38)', () => {
  it('the consent page refuses to mint a token with no scope when projects exist', async () => {
    // The decision is required server-side, not merely `required` in the HTML. A grant with no
    // projects would otherwise be indistinguishable from a legacy token — which reaches
    // EVERYTHING. Failing to choose and declining scope must never collapse into "all".
    const form = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: REDIRECT,
      code_challenge: await s256('x'.repeat(48)), code_challenge_method: 'S256', scope: 'mcp', decision: 'approve',
    });
    const res = await SELF.fetch('https://planar.test/oauth/authorize', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(), redirect: 'manual',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('pick at least one project');
  });

  it('reaches a ticked project and is refused an unticked one', async () => {
    const token = await mint([allowedPid], 'reach');
    expect((await mcpCall(token, 'get_project', { projectId: allowedPid })).isError).toBe(false);
    const denied = await mcpCall(token, 'get_project', { projectId: forbiddenPid });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/outside this connection/);
  });

  it('cannot be handed unticked work by the pull-loop', async () => {
    // The sharp one. next_claimable takes no projectId, so the CENTRAL guard never fires —
    // the loop picks the project itself. Without the scope clause in its own query, a scoped
    // token would simply be handed work it was never authorized for.
    const owner = await mint([allowedPid, forbiddenPid], 'owner');
    const t = await mcpCall(owner, 'create_task', { projectId: forbiddenPid, title: 'off-limits work' });
    expect(t.isError).toBe(false);

    const scoped = await mint([allowedPid], 'pull');
    const got = await mcpCall(scoped, 'next_claimable', {});
    if (got.body.task) expect(got.body.task.projectId).toBe(allowedPid);
  });

  it('is not even TOLD the unticked project exists', async () => {
    // Narrow the offer, not just the action: a briefing that advertises projects the
    // credential cannot touch invites the agent to try, and be refused, forever.
    const token = await mint([allowedPid], 'briefing');
    const ids = (await mcpCall(token, 'get_briefing', {})).body.projects.map((p: { id: string }) => p.id);
    expect(ids).toContain(allowedPid);
    expect(ids).not.toContain(forbiddenPid);
    const listed = (await mcpCall(token, 'list_projects', {})).body.projects.map((p: { id: string }) => p.id);
    expect(listed).not.toContain(forbiddenPid);
  });

  it('a refresh cannot widen the scope', async () => {
    // Rotation must CARRY the scope. Without it the rotated token has no rows — which, but for
    // scoped_at, would read as "legacy, reaches everything": refreshing would silently promote
    // a one-project laptop to the whole account. Driven through the real grant, because a test
    // that only inspects rows would pass while the grant itself was broken.
    const { refresh } = await mintPair([allowedPid], 'refresh');
    const res = await SELF.fetch('https://planar.test/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }).toString(),
    });
    expect(res.status).toBe(200);
    const rotated = ((await res.json()) as { access_token: string }).access_token;

    expect((await mcpCall(rotated, 'get_project', { projectId: allowedPid })).isError).toBe(false);
    const denied = await mcpCall(rotated, 'get_project', { projectId: forbiddenPid });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/outside this connection/);
  });

  it('a legacy (pre-scoping) token still reaches everything — grandfathered, deliberately', async () => {
    // 0027 keeps these working on purpose: invalidating them would sign every human out and
    // kill every live runner mid-run. scoped_at IS NULL is what marks one, which is why
    // row-absence alone cannot carry the meaning.
    const token = await mint([allowedPid], 'legacy');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))]
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare('UPDATE oauth_tokens SET scoped_at = NULL WHERE token_hash = ?').bind(hash).run();
    await env.DB.prepare(
      'DELETE FROM oauth_token_projects WHERE token_id = (SELECT id FROM oauth_tokens WHERE token_hash = ?)',
    ).bind(hash).run();
    expect((await mcpCall(token, 'get_project', { projectId: forbiddenPid })).isError).toBe(false);
  });

  it('a token scoped to NOTHING is not a token scoped to everything', async () => {
    // The distinction scoped_at exists for. A brand-new user has no projects to tick, so this
    // state is real — and collapsing it into "unscoped" would read the most locked-down token
    // on the system as the most privileged one.
    await createUser('scope-fresh@example.com', 'Fresh', 'longenough1', 'member').catch(() => {});
    const freshCookie = await loginSession('scope-fresh@example.com', 'longenough1');
    const saved = cookie;
    cookie = freshCookie;
    const token = await mint([], 'fresh'); // no projects to tick — consent allows it
    cookie = saved;
    const denied = await mcpCall(token, 'get_project', { projectId: allowedPid });
    expect(denied.isError).toBe(true);

    // …and it can still bootstrap: the project it creates joins its own scope, or
    // create_project would be a trap that hands back an id you are then refused.
    const made = await mcpCall(token, 'create_project', { key: 'FRSH', name: 'fresh-project' });
    expect(made.isError).toBe(false);
    expect((await mcpCall(token, 'get_project', { projectId: made.body.id })).isError).toBe(false);
  });
});
