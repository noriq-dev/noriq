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
  });
});
