import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createUser, loginSession } from './helpers';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const BASE = 'https://noriq.test';

let cookie: string;

beforeAll(async () => {
  cookie = await loginSession('device-user@example.com', 'longenough1').catch(async () => {
    await createUser('device-user@example.com', 'Device User', 'longenough1', 'admin');
    return loginSession('device-user@example.com', 'longenough1');
  });
});

const form = (o: Record<string, string>) =>
  ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() }) as RequestInit;

/** Register a client the way the Runner does: loopback redirect for the browser path,
 *  plus the device grant for headless boxes. */
async function registerRunnerClient(name = 'noriq-runner-test') {
  const res = await SELF.fetch(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: ['http://127.0.0.1/callback'],
      grant_types: ['authorization_code', DEVICE_GRANT],
    }),
  });
  return (await res.json()) as { client_id: string; grant_types: string[] };
}

async function startDevice(clientId: string) {
  const res = await SELF.fetch(`${BASE}/oauth/device/code`, form({ client_id: clientId, scope: 'mcp' }));
  return { status: res.status, body: (await res.json()) as Record<string, string | number> };
}

const poll = async (clientId: string, deviceCode: string) => {
  const res = await SELF.fetch(`${BASE}/oauth/token`, form({ grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: clientId }));
  return { status: res.status, body: (await res.json()) as Record<string, string> };
};

const approve = (userCode: string, decision: 'approve' | 'deny' = 'approve') =>
  SELF.fetch(`${BASE}/oauth/device`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_code: userCode, decision }).toString(),
  });

describe('device authorization grant (RFC 8628)', () => {
  it('advertises the device endpoint and grant in AS metadata', async () => {
    const meta = (await (await SELF.fetch(`${BASE}/.well-known/oauth-authorization-server`)).json()) as Record<string, string[] | string>;
    expect(meta.device_authorization_endpoint).toBe(`${BASE}/oauth/device/code`);
    expect(meta.grant_types_supported).toContain(DEVICE_GRANT);
    // The browser path stays the default — device is the fallback, not a replacement.
    expect(meta.grant_types_supported).toContain('authorization_code');
  });

  it('registers a client for both the loopback and device grants', async () => {
    const client = await registerRunnerClient();
    expect(client.client_id).toMatch(/^client_/);
    expect(client.grant_types).toEqual(['authorization_code', DEVICE_GRANT, 'refresh_token']);
  });

  it('registers a device-only client with no redirect_uris', async () => {
    const res = await SELF.fetch(`${BASE}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'headless-only', grant_types: [DEVICE_GRANT] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { grant_types: string[]; redirect_uris: string[] };
    expect(body.grant_types).toEqual([DEVICE_GRANT, 'refresh_token']);
    expect(body.redirect_uris).toEqual([]);
  });

  it('still requires redirect_uris for an authorization_code client', async () => {
    const res = await SELF.fetch(`${BASE}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'browser-client' }),
    });
    expect(res.status).toBe(400);
  });

  it('issues a code pair with a typeable user_code', async () => {
    const { client_id } = await registerRunnerClient();
    const { status, body } = await startDevice(client_id);
    expect(status).toBe(200);
    expect(String(body.device_code)).toMatch(/^plnrd_/);
    // Unambiguous charset: no vowels, no 0/1/I/O lookalikes.
    expect(String(body.user_code)).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(body.verification_uri).toBe(`${BASE}/oauth/device`);
    expect(body.verification_uri_complete).toBe(`${BASE}/oauth/device?user_code=${body.user_code}`);
    expect(body.interval).toBe(5);
    expect(body.expires_in).toBe(600);
  });

  it('rejects a device request from an unknown client', async () => {
    const { status, body } = await startDevice('client_nope');
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_client');
  });

  it('reports authorization_pending until a human approves', async () => {
    const { client_id } = await registerRunnerClient();
    const { body: dev } = await startDevice(client_id);
    const res = await poll(client_id, String(dev.device_code));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('authorization_pending');
  });

  it('mints a working token once approved, and the code is single-use', async () => {
    const { client_id } = await registerRunnerClient();
    const { body: dev } = await startDevice(client_id);

    const page = await approve(String(dev.user_code));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Connected');

    const ok = await poll(client_id, String(dev.device_code));
    expect(ok.status).toBe(200);
    expect(ok.body.access_token).toMatch(/^plnrt_/);
    expect(ok.body.refresh_token).toMatch(/^plnrr_/);
    expect(ok.body.token_type).toBe('Bearer');

    // The whole point: the token authenticates a runner against the control plane.
    const reg = await SELF.fetch(`${BASE}/api/runners`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ok.body.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'device-authed-runner', tools: ['claude'], kinds: ['build'], maxConcurrency: 1, repos: [] }),
    });
    expect(reg.status).toBe(200);

    // Replaying the device_code must not mint a second token.
    const replay = await poll(client_id, String(dev.device_code));
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
  });

  it('accepts a messily-typed user_code', async () => {
    const { client_id } = await registerRunnerClient();
    const { body: dev } = await startDevice(client_id);
    // Lowercased, hyphen dropped, padded with spaces — what a human actually types.
    const messy = ` ${String(dev.user_code).replace('-', '').toLowerCase()} `;
    expect((await approve(messy)).status).toBe(200);
    expect((await poll(client_id, String(dev.device_code))).body.access_token).toMatch(/^plnrt_/);
  });

  it('returns access_denied when the human denies', async () => {
    const { client_id } = await registerRunnerClient();
    const { body: dev } = await startDevice(client_id);
    expect((await approve(String(dev.user_code), 'deny')).status).toBe(200);
    const res = await poll(client_id, String(dev.device_code));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('access_denied');
  });

  it('rejects an unknown device_code and a mismatched client', async () => {
    const { client_id } = await registerRunnerClient();
    const { body: dev } = await startDevice(client_id);

    const unknown = await poll(client_id, 'plnrd_not-a-real-code');
    expect(unknown.body.error).toBe('invalid_grant');

    const other = await registerRunnerClient('someone-else');
    const wrong = await poll(other.client_id, String(dev.device_code));
    expect(wrong.body.error).toBe('invalid_client');
  });

  it('slows down a device that polls faster than the interval', async () => {
    const { client_id } = await registerRunnerClient();
    const { body: dev } = await startDevice(client_id);
    const first = await poll(client_id, String(dev.device_code));
    expect(first.body.error).toBe('authorization_pending');

    // Immediately again — inside the 5s interval.
    const second = await poll(client_id, String(dev.device_code));
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('slow_down');
    // RFC 8628 §3.5: the interval grows, and the client is expected to honour it.
    expect(Number(second.body.interval)).toBe(10);
  });

  it('reports expired_token once the code lapses', async () => {
    const { client_id } = await registerRunnerClient();
    const { body: dev } = await startDevice(client_id);
    await env.DB.prepare('UPDATE oauth_device_codes SET expires_at = ? WHERE user_code = ?')
      .bind(new Date(Date.now() - 1000).toISOString(), String(dev.user_code)).run();

    const res = await poll(client_id, String(dev.device_code));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('expired_token');
  });

  it('refuses to approve an expired code from the page', async () => {
    const { client_id } = await registerRunnerClient();
    const { body: dev } = await startDevice(client_id);
    await env.DB.prepare('UPDATE oauth_device_codes SET expires_at = ? WHERE user_code = ?')
      .bind(new Date(Date.now() - 1000).toISOString(), String(dev.user_code)).run();

    const page = await approve(String(dev.user_code));
    expect(page.status).toBe(400);
    expect(await page.text()).toContain('expired');
  });

  it('requires a signed-in human to approve', async () => {
    const { client_id } = await registerRunnerClient();
    const { body: dev } = await startDevice(client_id);
    // No cookie — an anonymous POST must not be able to approve a code.
    const res = await SELF.fetch(`${BASE}/oauth/device`, form({ user_code: String(dev.user_code), decision: 'approve' }));
    expect(res.status).toBe(401);
    expect((await poll(client_id, String(dev.device_code))).body.error).toBe('authorization_pending');
  });

  it('serves the verification page, prefilled from verification_uri_complete', async () => {
    const { client_id } = await registerRunnerClient('prefill-client');
    const { body: dev } = await startDevice(client_id);
    const res = await SELF.fetch(`${BASE}/oauth/device?user_code=${dev.user_code}`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(String(dev.user_code));
    expect(html).toContain('prefill-client'); // the human sees WHAT they're authorizing
  });
});
