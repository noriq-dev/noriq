// Session cookie lifecycle: login sets noriq_session, it authenticates, logout expires it.
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createUser, loginSession } from './helpers';

const me = (cookie: string) =>
  SELF.fetch('https://noriq.test/api/auth/me', { headers: { Cookie: cookie } });

describe('session cookie', () => {
  it('login sets noriq_session, it authenticates, and logout expires it', async () => {
    await createUser('session-cookie@example.com', 'Cookie', 'longenough1');
    const cookie = await loginSession('session-cookie@example.com', 'longenough1');
    expect(cookie.startsWith('noriq_session=')).toBe(true);
    expect((await me(cookie)).status).toBe(200);

    const out = await SELF.fetch('https://noriq.test/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie().some((c) => c.startsWith('noriq_session=;'))).toBe(true);
    // PLNR-640: server deletes the session row — replaying the old cookie must fail.
    expect((await me(cookie)).status).toBe(401);
  });

  it('PATCH /api/auth/me updates display name for the signed-in user', async () => {
    await createUser('profile-me@example.com', 'Before', 'longenough1');
    const cookie = await loginSession('profile-me@example.com', 'longenough1');
    const res = await SELF.fetch('https://noriq.test/api/auth/me', {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'After Name' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { user: { name: string; email: string } };
    expect(body.user.name).toBe('After Name');
    expect(body.user.email).toBe('profile-me@example.com');
    expect((await (await me(cookie)).json() as { user: { name: string } }).user.name).toBe('After Name');

    const bad = await SELF.fetch('https://noriq.test/api/auth/me', {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    expect(bad.status).toBe(400);
  });
});
