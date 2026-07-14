// OAuth 2.1 authorization server for MCP clients (PLNR-30).
// Authorization-code + PKCE (S256, required), dynamic client registration
// (public clients only), refresh tokens. Access tokens are opaque and map to
// an AGENT identity: on consent the user names (or reuses) the agent this
// client will act as — so OAuth agents flow through the exact same
// coordination paths as key-based ones.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from './auth';
import type { Env } from './env';
import { getCookie } from './auth';
import { newId, nowIso, sha256Hex } from './lib/util';
import { isCimdId, resolveCimdClient } from './lib/cimd';

const ACCESS_TTL_S = 7 * 24 * 3600; // 7 days
const REFRESH_TTL_S = 90 * 24 * 3600; // 90 days
const CODE_TTL_S = 300;

export const oauth = new Hono<AppContext>();

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const randToken = (prefix: string) => `${prefix}${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;

// --- discovery -----------------------------------------------------------------
// Discovery must be reachable by clients that follow the MCP 2025-11-25 spec to
// the letter (e.g. OpenAI/ChatGPT): AS metadata is probed at BOTH the RFC 8414
// path and the OpenID Connect discovery path, and Protected Resource Metadata at
// both the root and the resource-path-scoped well-known. Missing any of these
// makes a strict client conclude "CIMD not supported" (PLNR-82). Responses are
// no-store + CORS-open so an edge cache can never serve a stale (pre-CIMD) copy
// and browser-based clients can read them.
export function metadataRoutes(app: Hono<AppContext>) {
  const authServerMeta = (issuer: string) => ({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
    subject_types_supported: ['public'],
    // CIMD: clients MAY use an HTTPS-URL client_id pointing at a metadata
    // document; DCR (registration_endpoint) remains as a fallback.
    client_id_metadata_document_supported: true,
  });
  const resourceMeta = (issuer: string) => ({
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
  });
  const send = (c: Context<AppContext>, body: unknown) => {
    c.header('Cache-Control', 'no-store');
    c.header('Access-Control-Allow-Origin', '*');
    return c.json(body as never);
  };

  // AS metadata — RFC 8414 path and the OIDC-discovery path (both spec-required).
  const asHandler = (c: Context<AppContext>) => send(c, authServerMeta(new URL(c.req.url).origin));
  app.get('/.well-known/oauth-authorization-server', asHandler);
  app.get('/.well-known/openid-configuration', asHandler);

  // Protected Resource metadata — root and resource-path-scoped (RFC 9728).
  const rsHandler = (c: Context<AppContext>) => send(c, resourceMeta(new URL(c.req.url).origin));
  app.get('/.well-known/oauth-protected-resource', rsHandler);
  app.get('/.well-known/oauth-protected-resource/mcp', rsHandler);
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

type ClientCheck = { ok: true; name: string; redirectUris: string[]; cimd: boolean } | { ok: false; err: string };

async function validateClient(env: Env, p: AuthzParams): Promise<ClientCheck> {
  if (p.response_type !== 'code') return { ok: false, err: 'response_type must be code' };
  if (p.code_challenge_method !== 'S256' || !p.code_challenge) return { ok: false, err: 'PKCE S256 required' };

  // CIMD (PLNR-82): an HTTPS-URL client_id resolves to a fetched metadata document.
  if (isCimdId(p.client_id)) {
    let client;
    try {
      client = await resolveCimdClient(env, p.client_id);
    } catch (e) {
      return { ok: false, err: `client metadata: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!client.redirectUris.includes(p.redirect_uri)) return { ok: false, err: 'redirect_uri not in client metadata document' };
    return { ok: true, name: client.name, redirectUris: client.redirectUris, cimd: true };
  }

  // Pre-registered / dynamically-registered clients live in the DB.
  const client = await env.DB.prepare('SELECT name, redirect_uris FROM oauth_clients WHERE id = ?')
    .bind(p.client_id).first<{ name: string; redirect_uris: string }>();
  if (!client) return { ok: false, err: 'unknown client_id' };
  const uris = JSON.parse(client.redirect_uris) as string[];
  if (!uris.includes(p.redirect_uri)) return { ok: false, err: 'redirect_uri not registered' };
  return { ok: true, name: client.name, redirectUris: uris, cimd: false };
}

/** CIMD clients must exist as an oauth_clients row (FK target for codes/tokens). */
async function ensureCimdClientRow(db: D1Database, clientId: string, name: string, redirectUris: string[]) {
  await db.prepare(
    `INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, redirect_uris = excluded.redirect_uris`,
  ).bind(clientId, name, JSON.stringify(redirectUris), nowIso()).run();
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function consentPage(clientName: string, agentDefault: string, params: AuthzParams, user: { name: string } | null, error?: string): string {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
  // Show where approval will send the code — the key phishing defense when the
  // client_id is a CIMD URL and the client name can't be fully trusted (PLNR-82).
  let redirectHost = params.redirect_uri;
  try { redirectHost = new URL(params.redirect_uri).host; } catch { /* keep raw */ }
  const inner = user
    ? `
    <p class="sub">Signed in as <b>${esc(user.name)}</b>. <b>${esc(clientName)}</b> is requesting access to the Noriq MCP <b>on your behalf</b>.</p>
    <p class="hint">On approval you'll be returned to <b>${esc(redirectHost)}</b> — only continue if you recognize it.</p>
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
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Noriq · authorize</title><style>
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
  </style></head><body><div class="card"><span class="logo"><div></div></span><h1>Noriq</h1>${inner}${error ? `<div class="err">${esc(error)}</div>` : ''}</div></body></html>`;
}

oauth.get('/authorize', async (c) => {
  const p = readParams(new URL(c.req.url).searchParams);
  const v = await validateClient(c.env, p);
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
  const v = await validateClient(c.env, p);
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

  // Connection default agent: one per grant/connection (project_id NULL, so it never
  // shows in a project). Real work happens under per-session agents created at MCP
  // initialize and named via set_agent_identity. `name` is a unique internal handle;
  // `label` is the friendly display.
  const display = `${(user.name.split(' ')[0] ?? 'user').toLowerCase()}-${v.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'client'}`;
  const agentId = newId('agt');
  // api_key_hash is a vestigial NOT NULL column (no static keys); a random hash fills it.
  await c.env.DB.prepare(
    `INSERT INTO agents (id, name, label, role, status, user_id, api_key_hash, created_at) VALUES (?, ?, ?, 'worker', 'idle', ?, ?, ?)`,
  ).bind(agentId, `${display}-${agentId.slice(-6)}`, display, user.id, await sha256Hex(randToken('unused_')), nowIso()).run();
  const agent = { id: agentId };

  // A CIMD client has no persistent registration; materialize it now so the
  // oauth_codes / oauth_tokens FK to oauth_clients resolves.
  if (v.cimd) await ensureCimdClientRow(c.env.DB, p.client_id, v.name, v.redirectUris);

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
