// PLNR-143: the session cookie renamed planar_session → noriq_session. Writes emit
// only the new name; reads accept both so pre-rename sessions survive; logout kills both.
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createUser, loginSession } from './helpers';

const me = (cookie: string) =>
  SELF.fetch('https://planar.test/api/auth/me', { headers: { Cookie: cookie } });

describe('session cookie rename (PLNR-143)', () => {
  it('login sets noriq_session and a legacy planar_session cookie still authenticates', async () => {
    await createUser('cookie-rename@example.com', 'Cookie', 'longenough1');
    const cookie = await loginSession('cookie-rename@example.com', 'longenough1');
    expect(cookie.startsWith('noriq_session=')).toBe(true);

    // New name authenticates.
    expect((await me(cookie)).status).toBe(200);

    // The same session id presented under the pre-rename cookie name still works.
    const sid = cookie.split('=')[1]!;
    expect((await me(`planar_session=${sid}`)).status).toBe(200);

    // Logout expires BOTH names, so a legacy cookie can't outlive the session.
    const out = await SELF.fetch('https://planar.test/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(out.status).toBe(200);
    const setCookies = out.headers.getSetCookie();
    expect(setCookies.some((c) => c.startsWith('noriq_session=;'))).toBe(true);
    expect(setCookies.some((c) => c.startsWith('planar_session=;'))).toBe(true);
  });
});
