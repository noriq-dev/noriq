// PLNR-87: forgot-password / email reset. Real tokens only leave by email, so
// tests mint known tokens directly via the test D1 binding.
import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createUser, loginSession } from './helpers';

let userId: string;

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const insertToken = async (id: string, token: string, userIdArg: string, msFromNow: number) =>
  env.DB.prepare('INSERT INTO password_resets (id, token_hash, user_id, expires_at) VALUES (?, ?, ?, ?)')
    .bind(id, await sha256Hex(token), userIdArg, new Date(Date.now() + msFromNow).toISOString()).run();
const post = (path: string, body: unknown) =>
  SELF.fetch(`https://planar.test${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeAll(async () => {
  userId = (await createUser('reset-me@example.com', 'Reset Me', 'oldpassword1')).id;
});

describe('forgot / reset password (PLNR-87)', () => {
  it('forgot responds uniformly and mints a token only for a real account', async () => {
    const count = async () =>
      ((await env.DB.prepare('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?').bind(userId).first<{ n: number }>())?.n) ?? 0;
    const before = await count();
    expect((await post('/api/auth/forgot', { email: 'reset-me@example.com' })).status).toBe(200);
    expect((await post('/api/auth/forgot', { email: 'ghost@example.com' })).status).toBe(200); // no enumeration
    expect(await count()).toBe(before + 1); // only the real account got a token
  });

  it('a valid token resets the password, kills other sessions, and signs in', async () => {
    const oldCookie = await loginSession('reset-me@example.com', 'oldpassword1');
    await insertToken('pwr_ok', 'good-token-123', userId, 3600_000);

    const info = await (await SELF.fetch('https://planar.test/api/reset/good-token-123')).json() as { email: string };
    expect(info.email).toBe('reset-me@example.com');

    const res = await post('/api/reset/good-token-123', { password: 'brandnewpass1' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toContain('planar_session=');

    // new password works, old fails, token is single-use, old session is dead
    expect(await loginSession('reset-me@example.com', 'brandnewpass1')).toBeTruthy();
    await expect(loginSession('reset-me@example.com', 'oldpassword1')).rejects.toThrow();
    expect((await post('/api/reset/good-token-123', { password: 'evenmorenew1' })).status).toBe(410);
    expect((await SELF.fetch('https://planar.test/api/auth/me', { headers: { Cookie: oldCookie } })).status).toBe(401);
  });

  it('rejects invalid, expired, and short-password requests', async () => {
    expect((await SELF.fetch('https://planar.test/api/reset/nope')).status).toBe(404);
    await insertToken('pwr_exp', 'expired-token', userId, -1000);
    expect((await SELF.fetch('https://planar.test/api/reset/expired-token')).status).toBe(410);
    expect((await post('/api/reset/expired-token', { password: 'longenough1' })).status).toBe(410);

    await insertToken('pwr_short', 'short-pw-token', userId, 3600_000);
    expect((await post('/api/reset/short-pw-token', { password: 'short' })).status).toBe(400);
  });
});
