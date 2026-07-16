// Invites + WebAuthn passkeys (PLNR-41). rpID/origin are derived from the
// request so any self-hosted deployment works unchanged (PLNR-42).
import { Hono } from 'hono';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { AppContext } from './auth';
import type { Env } from './env';
import { sessionSetCookie, userAuth } from './auth';
import { hashPassword, newApiKey, newId, nowIso, sha256Hex } from './lib/util';
import { sendInviteEmail, sendPasswordResetEmail } from './email';

export const onboarding = new Hono<AppContext>();

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

function rp(c: { req: { url: string } }) {
  const url = new URL(c.req.url);
  return { rpID: url.hostname, origin: url.origin, rpName: `Noriq · ${url.hostname}` };
}

async function createSession(db: D1Database, userId: string): Promise<{ cookie: string }> {
  const sid = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  await db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(sid), userId, expires.toISOString()).run();
  return { cookie: sessionSetCookie(sid, expires) };
}

async function saveChallenge(db: D1Database, challenge: string, kind: 'register' | 'login', userId?: string) {
  await db.prepare('INSERT OR REPLACE INTO webauthn_challenges (challenge, user_id, kind, expires_at) VALUES (?, ?, ?, ?)')
    .bind(challenge, userId ?? null, kind, new Date(Date.now() + CHALLENGE_TTL_MS).toISOString()).run();
}

async function consumeChallenge(db: D1Database, challenge: string, kind: 'register' | 'login') {
  const row = await db.prepare('SELECT challenge, user_id AS userId, expires_at AS exp FROM webauthn_challenges WHERE challenge = ? AND kind = ?')
    .bind(challenge, kind).first<{ challenge: string; userId: string | null; exp: string }>();
  if (row) await db.prepare('DELETE FROM webauthn_challenges WHERE challenge = ?').bind(challenge).run();
  if (!row || row.exp < nowIso()) return null;
  return row;
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

onboarding.post('/api/users/invite', userAuth, async (c) => {
  if (c.var.user!.role !== 'admin') return c.json({ error: 'admin role required' }, 403);
  const body = await c.req.json<{ email: string; name: string; role?: 'admin' | 'member'; groupIds?: string[] }>();
  if (!body.email || !/\S+@\S+/.test(body.email) || !body.name) return c.json({ error: 'valid email and name required' }, 400);

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(body.email.toLowerCase()).first();
  if (existing) return c.json({ error: 'a user with that email already exists' }, 409);

  const userId = newId('usr');
  await c.env.DB.prepare(
    'INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
  ).bind(userId, body.email.toLowerCase(), body.name, body.role ?? 'member', nowIso()).run();
  for (const gid of body.groupIds ?? []) {
    await c.env.DB.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)').bind(userId, gid).run();
  }

  const token = newApiKey().replace('plnr_', 'plnri_');
  await c.env.DB.prepare('INSERT INTO invites (id, token_hash, user_id, expires_at) VALUES (?, ?, ?, ?)')
    .bind(newId('inv'), await sha256Hex(token), userId, new Date(Date.now() + INVITE_TTL_MS).toISOString()).run();

  const origin = new URL(c.req.url).origin;
  const inviteUrl = `${origin}/invite/${token}`;
  const emailed = await sendInviteEmail(c.env, {
    to: body.email,
    toName: body.name,
    inviterName: c.var.user!.name,
    inviteUrl,
    origin,
  });
  // If email is unconfigured (self-host without a sending domain), the admin
  // gets the link to deliver out-of-band.
  return c.json({ userId, emailed, inviteUrl: emailed ? undefined : inviteUrl });
});

onboarding.get('/api/invites/:token', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT i.expires_at AS exp, i.accepted_at AS accepted, u.name, u.email
     FROM invites i JOIN users u ON u.id = i.user_id WHERE i.token_hash = ?`,
  ).bind(await sha256Hex(c.req.param('token')!)).first<{ exp: string; accepted: string | null; name: string; email: string }>();
  if (!row) return c.json({ error: 'invalid invite' }, 404);
  if (row.accepted) return c.json({ error: 'invite already used' }, 410);
  if (row.exp < nowIso()) return c.json({ error: 'invite expired' }, 410);
  return c.json({ name: row.name, email: row.email });
});

/** Accept: the token proves identity; optionally sets a password; signs in.
 *  The invite page then offers passkey enrollment on the fresh session. */
onboarding.post('/api/invites/:token/accept', async (c) => {
  if (!c.env.DISABLE_RATE_LIMIT) {
    const stub = c.env.RATE_LIMITER.get(c.env.RATE_LIMITER.idFromName(`auth:${c.req.header('CF-Connecting-IP') ?? 'local'}`));
    if (!(await stub.hit(20, 60_000)).ok) return c.json({ error: 'too many attempts — slow down' }, 429);
  }
  const tokenHash = await sha256Hex(c.req.param('token')!);
  const row = await c.env.DB.prepare(
    'SELECT i.id, i.user_id AS userId, i.expires_at AS exp, i.accepted_at AS accepted FROM invites i WHERE i.token_hash = ?',
  ).bind(tokenHash).first<{ id: string; userId: string; exp: string; accepted: string | null }>();
  if (!row || row.accepted || row.exp < nowIso()) return c.json({ error: 'invalid or expired invite' }, 410);

  const { password } = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }));
  if (password !== undefined && password.length < 8) return c.json({ error: 'password must be 8+ chars' }, 400);
  if (password) {
    await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .bind(await hashPassword(password), row.userId).run();
  }
  await c.env.DB.prepare('UPDATE invites SET accepted_at = ? WHERE id = ?').bind(nowIso(), row.id).run();
  const { cookie } = await createSession(c.env.DB, row.userId);
  c.header('Set-Cookie', cookie);
  const user = await c.env.DB.prepare('SELECT id, email, name, role FROM users WHERE id = ?').bind(row.userId).first();
  return c.json({ user });
});

// --- forgot / reset password (PLNR-87) -----------------------------------------------
const rateLimitAuth = async (c: { env: Env; req: { header: (n: string) => string | undefined } }) => {
  if (c.env.DISABLE_RATE_LIMIT) return true;
  const stub = c.env.RATE_LIMITER.get(c.env.RATE_LIMITER.idFromName(`auth:${c.req.header('CF-Connecting-IP') ?? 'local'}`));
  return (await stub.hit(20, 60_000)).ok;
};

/** Request a reset link. Always returns ok — never reveals whether the email exists. */
onboarding.post('/api/auth/forgot', async (c) => {
  if (!(await rateLimitAuth(c))) return c.json({ error: 'too many attempts — slow down' }, 429);
  const { email } = await c.req.json<{ email?: string }>().catch(() => ({ email: undefined }));
  const user = email
    ? await c.env.DB.prepare('SELECT id, email, name FROM users WHERE email = ? AND disabled = 0')
        .bind(email.toLowerCase()).first<{ id: string; email: string; name: string }>()
    : null;
  if (user) {
    const token = newApiKey().replace('plnr_', 'plnrpw_');
    await c.env.DB.prepare('INSERT INTO password_resets (id, token_hash, user_id, expires_at) VALUES (?, ?, ?, ?)')
      .bind(newId('pwr'), await sha256Hex(token), user.id, new Date(Date.now() + RESET_TTL_MS).toISOString()).run();
    const origin = new URL(c.req.url).origin;
    await sendPasswordResetEmail(c.env, { to: user.email, toName: user.name, resetUrl: `${origin}/reset/${token}`, origin });
  }
  // Uniform response regardless of whether the account exists (no enumeration).
  return c.json({ ok: true });
});

/** Show who a reset token is for (so the reset page can confirm the account). */
onboarding.get('/api/reset/:token', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT r.expires_at AS exp, r.used_at AS used, u.email, u.name
     FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ?`,
  ).bind(await sha256Hex(c.req.param('token')!)).first<{ exp: string; used: string | null; email: string; name: string }>();
  if (!row) return c.json({ error: 'invalid reset link' }, 404);
  if (row.used) return c.json({ error: 'this reset link was already used' }, 410);
  if (row.exp < nowIso()) return c.json({ error: 'this reset link has expired' }, 410);
  return c.json({ email: row.email, name: row.name });
});

/** Consume the token, set the new password, kill other sessions, sign in. */
onboarding.post('/api/reset/:token', async (c) => {
  if (!(await rateLimitAuth(c))) return c.json({ error: 'too many attempts — slow down' }, 429);
  const row = await c.env.DB.prepare(
    'SELECT id, user_id AS userId, expires_at AS exp, used_at AS used FROM password_resets WHERE token_hash = ?',
  ).bind(await sha256Hex(c.req.param('token')!)).first<{ id: string; userId: string; exp: string; used: string | null }>();
  if (!row || row.used || row.exp < nowIso()) return c.json({ error: 'invalid or expired reset link' }, 410);
  const { password } = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }));
  if (!password || password.length < 8) return c.json({ error: 'password must be 8+ chars' }, 400);

  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(password), row.userId),
    c.env.DB.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').bind(nowIso(), row.id),
    // Security: a reset invalidates every existing session for the account.
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.userId),
  ]);
  const { cookie } = await createSession(c.env.DB, row.userId);
  c.header('Set-Cookie', cookie);
  const user = await c.env.DB.prepare('SELECT id, email, name, role FROM users WHERE id = ?').bind(row.userId).first();
  return c.json({ user });
});

// ---------------------------------------------------------------------------
// Passkeys — registration (authed) and login (public, discoverable)
// ---------------------------------------------------------------------------

onboarding.post('/api/webauthn/register/options', userAuth, async (c) => {
  const { rpID, rpName } = rp(c);
  const existing = await c.env.DB.prepare('SELECT id, transports FROM passkeys WHERE user_id = ?')
    .bind(c.var.user!.id).all<{ id: string; transports: string }>();
  const options = await generateRegistrationOptions({
    rpID,
    rpName,
    userName: c.var.user!.email,
    userDisplayName: c.var.user!.name,
    attestationType: 'none',
    excludeCredentials: existing.results.map((p) => ({ id: p.id, transports: JSON.parse(p.transports) })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  await saveChallenge(c.env.DB, options.challenge, 'register', c.var.user!.id);
  return c.json(options);
});

onboarding.post('/api/webauthn/register/verify', userAuth, async (c) => {
  const { rpID, origin } = rp(c);
  const body = await c.req.json<{ response: RegistrationResponseJSON; name?: string }>();
  const clientData = JSON.parse(atob(body.response.response.clientDataJSON.replace(/-/g, '+').replace(/_/g, '/')));
  const stored = await consumeChallenge(c.env.DB, clientData.challenge, 'register');
  if (!stored || stored.userId !== c.var.user!.id) return c.json({ error: 'challenge invalid or expired' }, 400);

  const verification = await verifyRegistrationResponse({
    response: body.response,
    expectedChallenge: clientData.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
  });
  if (!verification.verified || !verification.registrationInfo) return c.json({ error: 'verification failed' }, 400);
  const { credential } = verification.registrationInfo;
  await c.env.DB.prepare(
    'INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    credential.id,
    c.var.user!.id,
    btoa(String.fromCharCode(...credential.publicKey)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    credential.counter,
    JSON.stringify(credential.transports ?? []),
    (body.name ?? 'passkey').slice(0, 40),
    nowIso(),
  ).run();
  return c.json({ ok: true });
});

onboarding.get('/api/webauthn/passkeys', userAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, name, created_at AS createdAt FROM passkeys WHERE user_id = ?',
  ).bind(c.var.user!.id).all();
  return c.json({ passkeys: results });
});

onboarding.delete('/api/webauthn/passkeys/:id', userAuth, async (c) => {
  await c.env.DB.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id')!, c.var.user!.id).run();
  return c.json({ ok: true });
});

onboarding.post('/api/webauthn/login/options', async (c) => {
  const { rpID } = rp(c);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
    allowCredentials: [], // discoverable credentials — the authenticator picks the account
  });
  await saveChallenge(c.env.DB, options.challenge, 'login');
  return c.json(options);
});

onboarding.post('/api/webauthn/login/verify', async (c) => {
  if (!c.env.DISABLE_RATE_LIMIT) {
    const stub = c.env.RATE_LIMITER.get(c.env.RATE_LIMITER.idFromName(`auth:${c.req.header('CF-Connecting-IP') ?? 'local'}`));
    if (!(await stub.hit(20, 60_000)).ok) return c.json({ error: 'too many attempts — slow down' }, 429);
  }
  const { rpID, origin } = rp(c);
  const body = await c.req.json<{ response: AuthenticationResponseJSON }>();
  const clientData = JSON.parse(atob(body.response.response.clientDataJSON.replace(/-/g, '+').replace(/_/g, '/')));
  const stored = await consumeChallenge(c.env.DB, clientData.challenge, 'login');
  if (!stored) return c.json({ error: 'challenge invalid or expired' }, 400);

  const passkey = await c.env.DB.prepare(
    `SELECT p.id, p.public_key AS publicKey, p.counter, p.transports, u.id AS userId, u.email, u.name, u.role, u.disabled
     FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.id = ?`,
  ).bind(body.response.id).first<{
    id: string; publicKey: string; counter: number; transports: string;
    userId: string; email: string; name: string; role: string; disabled: number;
  }>();
  if (!passkey || passkey.disabled) return c.json({ error: 'unknown credential' }, 401);

  const publicKey = Uint8Array.from(atob(passkey.publicKey.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
  const verification = await verifyAuthenticationResponse({
    response: body.response,
    expectedChallenge: clientData.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: { id: passkey.id, publicKey, counter: passkey.counter, transports: JSON.parse(passkey.transports) },
  });
  if (!verification.verified) return c.json({ error: 'verification failed' }, 401);
  await c.env.DB.prepare('UPDATE passkeys SET counter = ? WHERE id = ?')
    .bind(verification.authenticationInfo.newCounter, passkey.id).run();
  const { cookie } = await createSession(c.env.DB, passkey.userId);
  c.header('Set-Cookie', cookie);
  return c.json({ user: { id: passkey.userId, email: passkey.email, name: passkey.name, role: passkey.role } });
});

// ---------------------------------------------------------------------------
// User ↔ group membership
// ---------------------------------------------------------------------------

onboarding.put('/api/users/:uid/groups', userAuth, async (c) => {
  if (c.var.user!.role !== 'admin') return c.json({ error: 'admin role required' }, 403);
  const { groupIds } = await c.req.json<{ groupIds: string[] }>();
  const uid = c.req.param('uid')!;
  const stmts = [c.env.DB.prepare('DELETE FROM user_groups WHERE user_id = ?').bind(uid)];
  for (const gid of groupIds ?? []) {
    stmts.push(c.env.DB.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)').bind(uid, gid));
  }
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});
