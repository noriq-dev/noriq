// OAuth 2.1 authorization server for MCP clients (PLNR-30).
// Authorization-code + PKCE (S256, required), dynamic client registration
// (public clients only), refresh tokens. Access tokens are opaque and map to
// an AGENT identity: on consent the user names (or reuses) the agent this
// client will act as — so OAuth agents flow through the exact same
// coordination paths as key-based ones.
import { Hono } from 'hono';
import type { AppContext } from './auth';
import { getCookie } from './auth';
import { newId, nowIso, sha256Hex } from './lib/util';

const ACCESS_TTL_S = 7 * 24 * 3600; // 7 days
const REFRESH_TTL_S = 90 * 24 * 3600; // 90 days
const CODE_TTL_S = 300;

export const oauth = new Hono<AppContext>();

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const randToken = (prefix: string) => `${prefix}${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;

// --- discovery -----------------------------------------------------------------
export function metadataRoutes(app: Hono<AppContext>) {
  app.get('/.well-known/oauth-authorization-server', (c) => {
    const issuer = new URL(c.req.url).origin;
    return c.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    });
  });
  app.get('/.well-known/oauth-protected-resource', (c) => {
    const issuer = new URL(c.req.url).origin;
    return c.json({
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
    });
  });
}

// --- dynamic client registration (RFC 7591) ---------------------------------------
oauth.post('/register', async (c) => {
  const body = await c.req.json<{ client_name?: string; redirect_uris?: string[] }>().catch(() => ({}) as never);
  const uris = (body.redirect_uris ?? []).filter((u) => {
    try {
      const url = new URL(u);
      return url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    } catch {
      return false;
    }
  });
  if (!uris.length) return c.json({ error: 'invalid_client_metadata', error_description: 'redirect_uris required (https or localhost)' }, 400);
  const id = `client_${newId('').slice(1)}`;
  const name = (body.client_name ?? 'MCP client').slice(0, 80);
  await c.env.DB.prepare('INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, name, JSON.stringify(uris), nowIso()).run();
  return c.json({
    client_id: id,
    client_name: name,
    redirect_uris: uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  }, 201);
});

// --- authorize + consent ------------------------------------------------------------
async function currentUser(c: { env: { DB: D1Database }; req: { header: (n: string) => string | undefined } }) {
  const sid = getCookie(c.req.header('Cookie') ?? '', 'planar_session');
  if (!sid) return null;
  return await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND u.disabled = 0`,
  ).bind(await sha256Hex(sid)).first<{ id: string; name: string; email: string }>();
}

interface AuthzParams {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  response_type: string;
  scope: string;
}

function readParams(q: URLSearchParams): AuthzParams {
  return {
    client_id: q.get('client_id') ?? '',
    redirect_uri: q.get('redirect_uri') ?? '',
    state: q.get('state') ?? '',
    code_challenge: q.get('code_challenge') ?? '',
    code_challenge_method: q.get('code_challenge_method') ?? '',
    response_type: q.get('response_type') ?? '',
    scope: q.get('scope') || 'mcp',
  };
}

async function validateClient(db: D1Database, p: AuthzParams): Promise<{ ok: true; name: string } | { ok: false; err: string }> {
  if (p.response_type !== 'code') return { ok: false, err: 'response_type must be code' };
  if (p.code_challenge_method !== 'S256' || !p.code_challenge) return { ok: false, err: 'PKCE S256 required' };
  const client = await db.prepare('SELECT name, redirect_uris FROM oauth_clients WHERE id = ?')
    .bind(p.client_id).first<{ name: string; redirect_uris: string }>();
  if (!client) return { ok: false, err: 'unknown client_id' };
  if (!(JSON.parse(client.redirect_uris) as string[]).includes(p.redirect_uri)) return { ok: false, err: 'redirect_uri not registered' };
  return { ok: true, name: client.name };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function consentPage(clientName: string, agentDefault: string, params: AuthzParams, user: { name: string } | null, error?: string): string {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
  const inner = user
    ? `
    <p class="sub">Signed in as <b>${esc(user.name)}</b>. <b>${esc(clientName)}</b> is requesting access to the planar MCP <b>on your behalf</b>.</p>
    <p class="hint">It starts as the agent <b>${esc(agentDefault)}</b> (delegated by you). The agent itself can take a
    different identity later with the <code>set_agent_identity</code> tool — no need to decide here.</p>
    <form method="POST" action="/oauth/authorize">${hidden}
      <div class="row">
        <button name="decision" value="deny" class="ghost">Deny</button>
        <button name="decision" value="approve" class="approve">Approve</button>
      </div>
    </form>`
    : `
    <p class="sub"><b>${esc(clientName)}</b> is requesting access, but you're not signed in.</p>
    <form method="POST" action="/oauth/authorize">${hidden}
      <label>email<input name="email" type="email" required></label>
      <label>password<input name="password" type="password" required></label>
      <div class="row"><button name="decision" value="login" class="approve">Sign in &amp; continue</button></div>
    </form>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>planar · authorize</title><style>
    body{background:#0a0b0d;color:#e6e8ec;font-family:'Space Grotesk',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .card{width:380px;background:#0c0d10;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:28px}
    .logo{width:34px;height:34px;border-radius:9px;background:#c6f24e;display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;margin-right:10px}
    .logo div{width:14px;height:14px;background:#0a0b0d;transform:rotate(45deg)}
    h1{font-size:17px;display:inline;vertical-align:middle}
    .sub{font-size:13px;color:#8a8f98;line-height:1.6;margin:16px 0}
    .sub b{color:#e6e8ec}
    label{display:block;font-family:ui-monospace,monospace;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:#6b7280;margin:12px 0 0}
    input{box-sizing:border-box;width:100%;margin-top:6px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:9px;padding:9px 12px;color:#e6e8ec;font-size:13px;outline:none;font-family:inherit}
    .hint{font-size:11px;color:#6b7280;line-height:1.5}
    .row{display:flex;gap:10px;margin-top:18px;justify-content:flex-end}
    button{cursor:pointer;font-weight:600;font-size:13px;padding:10px 18px;border-radius:9px;border:none;font-family:inherit}
    .approve{background:#c6f24e;color:#0a0b0d}
    .ghost{background:rgba(255,255,255,.05);color:#e6e8ec;border:1px solid rgba(255,255,255,.12)}
    .err{font-family:ui-monospace,monospace;font-size:11px;color:#ff8a8a;margin-top:10px}
  </style></head><body><div class="card"><span class="logo"><div></div></span><h1>planar</h1>${inner}${error ? `<div class="err">${esc(error)}</div>` : ''}</div></body></html>`;
}

oauth.get('/authorize', async (c) => {
  const p = readParams(new URL(c.req.url).searchParams);
  const v = await validateClient(c.env.DB, p);
  if (!v.ok) return c.text(`invalid authorization request: ${v.err}`, 400);
  const user = await currentUser(c);
  const agentDefault = user ? `${user.name.split(' ')[0]?.toLowerCase() ?? 'me'}-${v.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20)}` : '';
  return c.html(consentPage(v.name, agentDefault, p, user));
});

oauth.post('/authorize', async (c) => {
  if (!c.env.DISABLE_RATE_LIMIT) {
    const stub = c.env.RATE_LIMITER.get(c.env.RATE_LIMITER.idFromName(`auth:${c.req.header('CF-Connecting-IP') ?? 'local'}`));
    if (!(await stub.hit(20, 60_000)).ok) return c.text('too many attempts — slow down', 429);
  }
  const form = await c.req.parseBody();
  const p = readParams(new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])));
  const v = await validateClient(c.env.DB, p);
  if (!v.ok) return c.text(`invalid authorization request: ${v.err}`, 400);

  const redirect = (extra: Record<string, string>) => {
    const url = new URL(p.redirect_uri);
    for (const [k, val] of Object.entries(extra)) url.searchParams.set(k, val);
    if (p.state) url.searchParams.set('state', p.state);
    return c.redirect(url.toString(), 302);
  };

  if (form.decision === 'deny') return redirect({ error: 'access_denied' });

  let user = await currentUser(c);
  if (!user && form.decision === 'login') {
    // Inline login on the consent page (sets no session cookie; single-shot consent).
    const { verifyPassword } = await import('./lib/util');
    const row = await c.env.DB.prepare('SELECT id, name, email, password_hash AS hash FROM users WHERE email = ? AND disabled = 0')
      .bind(String(form.email ?? '').toLowerCase()).first<{ id: string; name: string; email: string; hash: string | null }>();
    if (row?.hash && (await verifyPassword(String(form.password ?? ''), row.hash))) {
      user = row;
    } else {
      return c.html(consentPage(v.name, '', p, null, 'invalid credentials'), 401);
    }
    // Show the consent step now that they're identified.
    const agentDefault = `${user.name.split(' ')[0]?.toLowerCase() ?? 'me'}-${v.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20)}`;
    return c.html(consentPage(v.name, agentDefault, { ...p, ...({ _u: '' } as object) } as AuthzParams, user));
  }
  if (!user) return c.html(consentPage(v.name, '', p, null, 'sign in first'), 401);
  if (form.decision !== 'approve') return c.html(consentPage(v.name, '', p, user), 400);

  // Connection default agent: a placeholder for this grant (project_id NULL, so it never
  // shows in a project). Real work happens under per-session agents created at MCP
  // initialize and named via set_agent_identity. Reused across grants of the same client.
  const agentName = `${(user.name.split(' ')[0] ?? 'user').toLowerCase()}-${v.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'client'}`;
  let agent = await c.env.DB.prepare("SELECT id FROM agents WHERE name = ? AND user_id = ? AND project_id IS NULL AND status != 'revoked'")
    .bind(agentName, user.id).first<{ id: string }>();
  if (!agent) {
    const agentId = newId('agt');
    await c.env.DB.prepare(
      `INSERT INTO agents (id, name, role, status, user_id, created_at) VALUES (?, ?, 'worker', 'idle', ?, ?)`,
    ).bind(agentId, agentName, user.id, nowIso()).run();
    agent = { id: agentId };
  }

  const code = randToken('plnrc_');
  await c.env.DB.prepare(
    `INSERT INTO oauth_codes (code_hash, client_id, user_id, agent_id, redirect_uri, code_challenge, scope, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(await sha256Hex(code), p.client_id, user.id, agent.id, p.redirect_uri, p.code_challenge, p.scope,
    new Date(Date.now() + CODE_TTL_S * 1000).toISOString()).run();
  return redirect({ code });
});

// --- token ---------------------------------------------------------------------
oauth.post('/token', async (c) => {
  if (!c.env.DISABLE_RATE_LIMIT) {
    const stub = c.env.RATE_LIMITER.get(c.env.RATE_LIMITER.idFromName(`auth:${c.req.header('CF-Connecting-IP') ?? 'local'}`));
    if (!(await stub.hit(20, 60_000)).ok) return c.json({ error: 'slow_down' }, 429);
  }
  const form = await c.req.parseBody();
  const grant = String(form.grant_type ?? '');

  if (grant === 'authorization_code') {
    const code = String(form.code ?? '');
    const verifier = String(form.code_verifier ?? '');
    const row = await c.env.DB.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?')
      .bind(await sha256Hex(code)).first<Record<string, string>>();
    if (!row) return c.json({ error: 'invalid_grant' }, 400);
    await c.env.DB.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').bind(row.code_hash!).run(); // single use
    if (row.expires_at! < nowIso()) return c.json({ error: 'invalid_grant', error_description: 'code expired' }, 400);
    if (String(form.redirect_uri ?? '') !== row.redirect_uri) return c.json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);
    if (String(form.client_id ?? '') !== row.client_id) return c.json({ error: 'invalid_client' }, 400);
    // PKCE S256
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    if (b64url(new Uint8Array(digest)) !== row.code_challenge) return c.json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
    return c.json(await issueTokens(c.env.DB, row.client_id!, row.user_id!, row.agent_id!, row.scope!));
  }

  if (grant === 'refresh_token') {
    const refresh = String(form.refresh_token ?? '');
    const row = await c.env.DB.prepare(
      'SELECT * FROM oauth_tokens WHERE refresh_hash = ? AND revoked_at IS NULL',
    ).bind(await sha256Hex(refresh)).first<Record<string, string>>();
    if (!row || (row.refresh_expires_at && row.refresh_expires_at < nowIso())) return c.json({ error: 'invalid_grant' }, 400);
    // Rotate: revoke the old pair, issue a new one.
    await c.env.DB.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE id = ?').bind(nowIso(), row.id!).run();
    return c.json(await issueTokens(c.env.DB, row.client_id!, row.user_id!, row.agent_id!, row.scope!));
  }

  return c.json({ error: 'unsupported_grant_type' }, 400);
});

async function issueTokens(db: D1Database, clientId: string, userId: string, agentId: string, scope: string) {
  const access = randToken('plnrt_');
  const refresh = randToken('plnrr_');
  await db.prepare(
    `INSERT INTO oauth_tokens (id, token_hash, refresh_hash, client_id, user_id, agent_id, scope, expires_at, refresh_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(newId('oat'), await sha256Hex(access), await sha256Hex(refresh), clientId, userId, agentId, scope,
    new Date(Date.now() + ACCESS_TTL_S * 1000).toISOString(),
    new Date(Date.now() + REFRESH_TTL_S * 1000).toISOString()).run();
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_S,
    refresh_token: refresh,
    scope,
  };
}
