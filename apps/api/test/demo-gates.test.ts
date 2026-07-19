// PLNR-199: the "poor demo" resource lockdown. DEMO_MODE is '1' in the test env, so the
// seeded demo visitor is subject to the gates. These assert the FORBIDDEN surface refuses
// (OAuth connections, new projects/groups, passkeys, project delete/meta) while light
// in-project work stays open — the demo's whole point.
import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

let cookie: string;

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

beforeAll(async () => {
  // One-click demo login → a real member session cookie for demo@noriq.example. This also
  // lazily seeds prj_demo, which the "allowed work" case below writes into.
  const login = await SELF.fetch('https://noriq.test/api/demo/login', { method: 'POST' });
  expect(login.status).toBe(200);
  cookie = login.headers.get('Set-Cookie')!.split(';')[0]!;
});

describe('demo lockdown (PLNR-199)', () => {
  it('refuses to authorize an OAuth connection (no agent tokens for the demo)', async () => {
    const reg = await SELF.fetch('https://noriq.test/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Demo Probe', redirect_uris: ['http://localhost:33418/callback'] }),
    });
    const { client_id } = (await reg.json()) as { client_id: string };

    // GET consent page shows the disabled state, not a working approve button.
    const q = new URLSearchParams({
      response_type: 'code', client_id, redirect_uri: 'http://localhost:33418/callback', state: 's',
      code_challenge: await s256('test-verifier-0123456789-0123456789-0123456789'), code_challenge_method: 'S256', scope: 'mcp',
    });
    const page = await SELF.fetch(`https://noriq.test/oauth/authorize?${q}`, { headers: { Cookie: cookie } });
    expect(page.status).toBe(403);
    expect(await page.text()).toContain('disabled in the demo');

    // And a hand-rolled POST approve is refused before any code is minted (no redirect).
    const form = new URLSearchParams(Object.fromEntries(q.entries()));
    form.set('decision', 'approve');
    form.set('scope_all', '1');
    const approve = await SELF.fetch('https://noriq.test/oauth/authorize', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
    });
    expect(approve.status).toBe(403);
    expect(approve.headers.get('Location')).toBeNull();
  });

  it('refuses new projects, groups, and passkeys, and deleting/re-sharing the demo project', async () => {
    const post = (path: string, body: unknown) =>
      SELF.fetch(`https://noriq.test${path}`, {
        method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });

    expect((await post('/api/projects', { key: 'HACK', name: 'nope' })).status).toBe(403);
    expect((await post('/api/groups', { name: 'nope' })).status).toBe(403);
    expect((await post('/api/webauthn/register/options', {})).status).toBe(403);

    const del = await SELF.fetch('https://noriq.test/api/projects/prj_demo', { method: 'DELETE', headers: { Cookie: cookie } });
    expect(del.status).toBe(403);

    const meta = await SELF.fetch('https://noriq.test/api/projects/prj_demo/meta', {
      method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ public: true }),
    });
    expect(meta.status).toBe(403);
  });

  it('rejects a pre-existing demo-owned agent token at use-time (kill switch)', async () => {
    // The consent flow never mints one, but a token issued before DEMO_MODE was turned on
    // must still be refused. Plant one directly on the demo user and prove /mcp bounces it.
    const demoUser = await env.DB.prepare("SELECT id FROM users WHERE email = 'demo@noriq.example'").first<{ id: string }>();
    const reg = await SELF.fetch('https://noriq.test/oauth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Legacy Demo Client', redirect_uris: ['http://localhost:33418/callback'] }),
    });
    const { client_id } = (await reg.json()) as { client_id: string };

    const access = 'plnrt_legacy-demo-token-fixture';
    const future = new Date(Date.now() + 3600_000).toISOString();
    await env.DB.prepare(
      `INSERT INTO oauth_tokens (id, token_hash, refresh_hash, client_id, user_id, scope, expires_at, refresh_expires_at)
       VALUES (?, ?, ?, ?, ?, 'mcp', ?, ?)`,
    ).bind('oat_demo_fixture', await sha256Hex(access), await sha256Hex('r-' + access), client_id, demoUser!.id, future, future).run();

    const res = await SELF.fetch('https://noriq.test/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toContain('demo account');

    // The runner WebSocket does its own bearer lookup (bypassing agentAuth), so it must
    // reject the demo token independently — not fall through to a runner-ownership 404.
    const ws = await SELF.fetch('https://noriq.test/ws/runner/rnr_anything', {
      headers: { Authorization: `Bearer ${access}`, Upgrade: 'websocket' },
    });
    expect(ws.status).toBe(401);
    expect(await ws.text()).toContain('demo account');
  });

  it('disables first-run setup so a visitor cannot self-install a non-demo admin', async () => {
    const status = (await (await SELF.fetch('https://noriq.test/api/setup/status')).json()) as { needsSetup: boolean };
    expect(status.needsSetup).toBe(false);
    const setup = await SELF.fetch('https://noriq.test/api/setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'attacker@evil.test', name: 'Attacker', password: 'longenough1' }),
    });
    expect(setup.status).toBe(403);
  });

  it('still allows light in-project work — creating a task in the seeded project', async () => {
    const res = await SELF.fetch('https://noriq.test/api/projects/prj_demo/tasks', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'A visitor-created task' }),
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect(id).toBeTruthy();
  });
});
