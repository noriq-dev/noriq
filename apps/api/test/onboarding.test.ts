import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createUser, loginSession } from './helpers';

let adminCookie: string;

beforeAll(async () => {
  adminCookie = await loginSession('onboard-admin@example.com', 'longenough1').catch(async () => {
    await createUser('onboard-admin@example.com', 'Onboard Admin', 'longenough1', 'admin');
    return loginSession('onboard-admin@example.com', 'longenough1');
  });
});

describe('invites', () => {
  let inviteUrl: string;

  it('admin invites a user; without email configured the link comes back', async () => {
    const res = await SELF.fetch('https://planar.test/api/users/invite', {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'newbie@example.com', name: 'Newbie', role: 'member' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { emailed: boolean; inviteUrl?: string };
    expect(body.emailed).toBe(false); // no EMAIL binding in tests → link fallback
    expect(body.inviteUrl).toContain('/invite/plnri_');
    inviteUrl = body.inviteUrl!;
  });

  it('duplicate email is rejected', async () => {
    const res = await SELF.fetch('https://planar.test/api/users/invite', {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'newbie@example.com', name: 'Again' }),
    });
    expect(res.status).toBe(409);
  });

  it('invite info is readable, accept sets password + signs in, reuse is refused', async () => {
    const token = inviteUrl.split('/invite/')[1]!;
    const info = await SELF.fetch(`https://planar.test/api/invites/${token}`);
    expect(info.status).toBe(200);
    expect(((await info.json()) as { email: string }).email).toBe('newbie@example.com');

    const accept = await SELF.fetch(`https://planar.test/api/invites/${token}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'newbiepass123' }),
    });
    expect(accept.status).toBe(200);
    expect(accept.headers.get('Set-Cookie')).toContain('planar_session=');

    // token is single-use
    const again = await SELF.fetch(`https://planar.test/api/invites/${token}/accept`, { method: 'POST' });
    expect(again.status).toBe(410);

    // the password works for normal login
    const cookie = await loginSession('newbie@example.com', 'newbiepass123');
    expect(cookie).toContain('planar_session=');
  });

  it('non-admins cannot invite', async () => {
    const cookie = await loginSession('newbie@example.com', 'newbiepass123');
    const res = await SELF.fetch('https://planar.test/api/users/invite', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.com', name: 'X' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('webauthn', () => {
  it('login options are public and carry a challenge', async () => {
    const res = await SELF.fetch('https://planar.test/api/webauthn/login/options', { method: 'POST' });
    expect(res.status).toBe(200);
    const opts = (await res.json()) as { challenge: string; rpId?: string };
    expect(opts.challenge.length).toBeGreaterThan(10);
  });

  it('registration options require a session and exclude nothing for a fresh user', async () => {
    const anon = await SELF.fetch('https://planar.test/api/webauthn/register/options', { method: 'POST' });
    expect(anon.status).toBe(401);
    const res = await SELF.fetch('https://planar.test/api/webauthn/register/options', {
      method: 'POST',
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    const opts = (await res.json()) as { challenge: string; rp: { id: string }; user: { name: string } };
    expect(opts.rp.id).toBe('planar.test');
    expect(opts.user.name).toBe('onboard-admin@example.com');
  });
});

describe('user groups', () => {
  it('membership can be set and shows up in the users list', async () => {
    const g = await SELF.fetch('https://planar.test/api/groups', {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Onboard Group' }),
    });
    const { id: groupId } = (await g.json()) as { id: string };
    const users = (await (await SELF.fetch('https://planar.test/api/users', { headers: { Cookie: adminCookie } })).json()) as {
      users: Array<{ id: string; email: string }>;
    };
    const newbie = users.users.find((u) => u.email === 'newbie@example.com')!;
    const put = await SELF.fetch(`https://planar.test/api/users/${newbie.id}/groups`, {
      method: 'PUT',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupIds: [groupId] }),
    });
    expect(put.status).toBe(200);
    const after = (await (await SELF.fetch('https://planar.test/api/users', { headers: { Cookie: adminCookie } })).json()) as {
      users: Array<{ id: string; groupIds: string | null }>;
    };
    expect(after.users.find((u) => u.id === newbie.id)?.groupIds).toContain(groupId);
  });
});
