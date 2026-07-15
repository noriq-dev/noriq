// OAuth 2.1 authorization server for MCP clients (PLNR-30).
// Authorization-code + PKCE (S256, required), dynamic client registration
// (public clients only), refresh tokens, and the device grant (RFC 8628).
//
// A token authorizes a CONNECTION, not an agent (RUN-43 / migration 0026). Granting
// says "this client may act for this user"; it does not decide *who does the work*.
// That is settled later, and separately: a human's session resolves its own copilot at
// MCP initialize, and a runner mints the agent it owns and gets a token bound to it.
// Tokens here are therefore issued with agent_id NULL — the binding is the exception
// (a runner's per-run token), not the rule.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from './auth';
import type { Env } from './env';
import { getCookie } from './auth';
import { USER_PROJECT_WHERE } from './lib/visibility';
import { newId, nowIso, sha256Hex } from './lib/util';
import { isCimdId, redirectUriAllowed, resolveCimdClient } from './lib/cimd';

const ACCESS_TTL_S = 7 * 24 * 3600; // 7 days
const REFRESH_TTL_S = 90 * 24 * 3600; // 90 days
const CODE_TTL_S = 300;
const DEVICE_TTL_S = 600; // 10 min for a human to walk to a second device and type the code
const DEVICE_INTERVAL_S = 5; // RFC 8628 §3.2 default poll interval
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export const oauth = new Hono<AppContext>();

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const randToken = (prefix: string) => `${prefix}${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;

// user_code charset — RFC 8628 §6.1: no vowels (can't spell anything unfortunate) and
// no 0/1/I/O-style lookalikes, so a human can read it off one screen and type it on
// another without ambiguity. 20 symbols × 8 chars ≈ 2.6e10 combinations.
const USER_CODE_CHARS = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE_LEN = 8;

/** A random user_code, formatted BCDF-GHJK. Rejection-sampled — a bare `% 20` over
 *  256 would bias the first 16 symbols. */
function randUserCode(): string {
  let out = '';
  while (out.length < USER_CODE_LEN) {
    for (const b of crypto.getRandomValues(new Uint8Array(USER_CODE_LEN * 2))) {
      if (b >= 240) continue; // 240 = 12×20; keeps the modulo uniform
      out += USER_CODE_CHARS[b % USER_CODE_CHARS.length];
      if (out.length === USER_CODE_LEN) break;
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Accept what a human actually types: any case, spaces, missing/extra hyphens. */
export function normalizeUserCode(raw: string): string {
  const bare = raw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, USER_CODE_LEN);
  return bare.length > 4 ? `${bare.slice(0, 4)}-${bare.slice(4)}` : bare;
}

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
    // RFC 8628 §4 — headless clients (the Noriq Runner) discover the device flow here.
    device_authorization_endpoint: `${issuer}/oauth/device/code`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token', DEVICE_GRANT],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
    subject_types_supported: ['public'],
    // RFC 9207 — we return `iss` in the authorization response (PLNR-82).
    authorization_response_iss_parameter_supported: true,
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
  const body = await c.req
    .json<{ client_name?: string; redirect_uris?: string[]; grant_types?: string[] }>()
    .catch(() => ({}) as never);
  const uris = (body.redirect_uris ?? []).filter((u) => {
    try {
      const url = new URL(u);
      return url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    } catch {
      return false;
    }
  });
  // Omitting grant_types keeps the historical default (authorization_code + refresh).
  const requested = body.grant_types ?? [];
  const wantsDevice = requested.includes(DEVICE_GRANT);
  const wantsCode = !requested.length || requested.includes('authorization_code');
  // A device-flow client has no redirect_uri by construction (RFC 8628: the code comes
  // back over the poll, never a callback), so redirect_uris is required only when the
  // client actually asks for the authorization_code grant. A client may register for
  // BOTH — the Noriq Runner does, preferring loopback and falling back to device on a
  // headless box.
  if (!uris.length && wantsCode) {
    return c.json({ error: 'invalid_client_metadata', error_description: 'redirect_uris required (https or localhost)' }, 400);
  }
  const id = `client_${newId('').slice(1)}`;
  const name = (body.client_name ?? 'MCP client').slice(0, 80);
  await c.env.DB.prepare('INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, name, JSON.stringify(uris), nowIso()).run();
  return c.json({
    client_id: id,
    client_name: name,
    redirect_uris: uris,
    token_endpoint_auth_method: 'none',
    grant_types: [...(wantsCode ? ['authorization_code'] : []), ...(wantsDevice ? [DEVICE_GRANT] : []), 'refresh_token'],
    response_types: wantsCode ? ['code'] : [],
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
    if (!redirectUriAllowed(p.redirect_uri, client.redirectUris)) return { ok: false, err: 'redirect_uri not in client metadata document' };
    return { ok: true, name: client.name, redirectUris: client.redirectUris, cimd: true };
  }

  // Pre-registered / dynamically-registered clients live in the DB.
  const client = await env.DB.prepare('SELECT name, redirect_uris FROM oauth_clients WHERE id = ?')
    .bind(p.client_id).first<{ name: string; redirect_uris: string }>();
  if (!client) return { ok: false, err: 'unknown client_id' };
  const uris = JSON.parse(client.redirect_uris) as string[];
  if (!redirectUriAllowed(p.redirect_uri, uris)) return { ok: false, err: 'redirect_uri not registered' };
  return { ok: true, name: client.name, redirectUris: uris, cimd: false };
}

// createConnectionAgent is gone (0026). A grant used to mint a "connection agent": an
// agents row, project_id NULL forever, that never did any work and existed only so
// oauth_codes/oauth_tokens had an agent_id to point at. It made every `claude mcp add`
// look like a working identity in the dashboard, and it is half the reason `agents` meant
// two incompatible things. A connection is now just its oauth_tokens row — owned by a
// user, bound to no agent. Working identities are minted per MCP session (copilots) or by
// a runner (agents).

/** CIMD clients must exist as an oauth_clients row (FK target for codes/tokens). */
async function ensureCimdClientRow(db: D1Database, clientId: string, name: string, redirectUris: string[]) {
  await db.prepare(
    `INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, redirect_uris = excluded.redirect_uris`,
  ).bind(clientId, name, JSON.stringify(redirectUris), nowIso()).run();
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Shared chrome for the two human-facing auth pages (consent + device verification).
const AUTH_CSS = `
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
    .projects{max-height:190px;overflow-y:auto;border:1px solid rgba(255,255,255,.1);border-radius:9px;margin-top:8px}
    .proj{display:flex;align-items:center;gap:9px;padding:9px 11px;margin:0;font-family:inherit;font-size:13px;
          text-transform:none;letter-spacing:normal;color:#e6e8ec;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.06)}
    .proj:last-child{border-bottom:none}
    .proj:hover{background:rgba(255,255,255,.04)}
    .proj input{width:auto;margin:0;flex:none}
    /* "All projects" sits above the list and reads as a peer of the whole box, not a member. */
    .scope-all{margin-top:8px;border:1px solid rgba(255,255,255,.1);border-radius:9px;border-bottom:1px solid rgba(255,255,255,.1)}
    .scope-all span{color:#6b7280;font-size:11px}
    .proj span{color:#6b7280;font-size:12px}
    .row{display:flex;gap:10px;margin-top:18px;justify-content:flex-end}
    button{cursor:pointer;font-weight:600;font-size:13px;padding:10px 18px;border-radius:9px;border:none;font-family:inherit}
    .approve{background:#c6f24e;color:#0a0b0d}
    .ghost{background:rgba(255,255,255,.05);color:#e6e8ec;border:1px solid rgba(255,255,255,.12)}
    .err{font-family:ui-monospace,monospace;font-size:11px;color:#ff8a8a;margin-top:10px}
    .code{font-family:ui-monospace,monospace;font-size:26px;letter-spacing:.18em;text-align:center;margin:18px 0;color:#c6f24e}
    .ok{font-size:34px;text-align:center;margin:10px 0}
`;

/** Wrap page-specific markup in the shared Noriq auth card. */
const authShell = (title: string, inner: string, error?: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${AUTH_CSS}</style></head><body><div class="card"><span class="logo"><div></div></span><h1>Noriq</h1>${inner}${error ? `<div class="err">${esc(error)}</div>` : ''}</div></body></html>`;

function consentPage(
  clientName: string,
  projects: Array<{ id: string; key: string; name: string }>,
  params: AuthzParams,
  user: { name: string } | null,
  error?: string,
): string {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
  // Show where approval will send the code — the key phishing defense when the
  // client_id is a CIMD URL and the client name can't be fully trusted (PLNR-82).
  let redirectHost = params.redirect_uri;
  try { redirectHost = new URL(params.redirect_uri).host; } catch { /* keep raw */ }
  // The scope choice, made mandatory (RUN-38). A token used to inherit everything its user
  // could reach, so authorizing a laptop handed it the whole account. `required` on the group
  // is enforced server-side too — a hand-rolled POST must not skip the decision.
  const picker = projects.length
    ? `
    <p class="hint" style="margin-top:14px">Which projects may this connection reach? It will not see the others.</p>
    <label class="proj scope-all"><input type="checkbox" name="scope_all" value="1" id="scope_all">
      <b>All projects</b> <span>including any you create later</span></label>
    <div class="projects" id="project_list">
      ${projects
        .map(
          (p) => `<label class="proj"><input type="checkbox" name="project_ids" value="${esc(p.id)}"> <b>${esc(p.key)}</b> <span>${esc(p.name)}</span></label>`,
        )
        .join('')}
    </div>
    <script>
      // Cosmetic only — "All projects" is decided server-side (readScope), so a browser that
      // never runs this still gets the same grant.
      (function () {
        var all = document.getElementById('scope_all');
        var list = document.getElementById('project_list');
        if (!all || !list) return;
        var boxes = list.querySelectorAll('input[type=checkbox]');
        function sync() {
          list.style.opacity = all.checked ? '.45' : '';
          for (var i = 0; i < boxes.length; i++) {
            boxes[i].disabled = all.checked;
            if (all.checked) boxes[i].checked = true;
          }
        }
        all.addEventListener('change', sync);
        sync();
      })();
    </script>`
    : `<p class="hint" style="margin-top:14px">You have no projects yet. Approving gives this connection
       access to <b>nothing</b> — it can create a project, and reaches only what it creates until you
       authorize it for more.</p>`;
  const inner = user
    ? `
    <p class="sub">Signed in as <b>${esc(user.name)}</b>. <b>${esc(clientName)}</b> is requesting access to the Noriq MCP <b>on your behalf</b>.</p>
    <p class="hint">On approval you'll be returned to <b>${esc(redirectHost)}</b> — only continue if you recognize it.</p>
    <form method="POST" action="/oauth/authorize">${hidden}
      ${picker}
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
  return authShell('Noriq · authorize', inner, error);
}

/** The projects a human may grant this connection — exactly what they can already reach.
 *  A token can never exceed its user, so the picker offers no more than that. */
async function pickableProjects(db: D1Database, userId: string): Promise<Array<{ id: string; key: string; name: string }>> {
  const { results } = await db.prepare(
    `SELECT p.id, p.key, p.name FROM projects p
     WHERE p.status = 'active' AND ${USER_PROJECT_WHERE} ORDER BY p.key`,
  ).bind(userId).all<{ id: string; key: string; name: string }>();
  return results;
}

/** What the human actually chose: every project they can reach (now and future), or an
 *  explicit set (RUN-58).
 *
 *  The ticked ids are validated against what the user can reach — never trust the form, or a
 *  hand-rolled POST could name any project id and scope itself to it. `all` needs no such
 *  check precisely because it grants nothing BY id: it defers to USER_PROJECT_WHERE at read
 *  time, which is exactly what lets a project created tomorrow fall inside it. */
async function readScope(db: D1Database, userId: string, form: Record<string, unknown>): Promise<{ all: boolean; ids: string[] }> {
  // "All projects" beats the individual boxes. The page disables them when it is ticked, but a
  // client that ran no script (or a hand-rolled POST) can send both — and the server has to
  // reach the same verdict either way, so decide it here rather than trusting the browser.
  const rawAll = form.scope_all;
  const picked = Array.isArray(rawAll) ? rawAll[0] : rawAll;
  if (picked != null && String(picked) !== '' && String(picked) !== '0') return { all: true, ids: [] };

  const raw = form.project_ids;
  const wanted = new Set((Array.isArray(raw) ? raw : raw == null ? [] : [raw]).map(String));
  return { all: false, ids: (await pickableProjects(db, userId)).map((p) => p.id).filter((id) => wanted.has(id)) };
}

oauth.get('/authorize', async (c) => {
  const p = readParams(new URL(c.req.url).searchParams);
  const v = await validateClient(c.env, p);
  if (!v.ok) return c.text(`invalid authorization request: ${v.err}`, 400);
  const user = await currentUser(c);
  const projects = user ? await pickableProjects(c.env.DB, user.id) : [];
  return c.html(consentPage(v.name, projects, p, user));
});

oauth.post('/authorize', async (c) => {
  if (!c.env.DISABLE_RATE_LIMIT) {
    const stub = c.env.RATE_LIMITER.get(c.env.RATE_LIMITER.idFromName(`auth:${c.req.header('CF-Connecting-IP') ?? 'local'}`));
    if (!(await stub.hit(20, 60_000)).ok) return c.text('too many attempts — slow down', 429);
  }
  // all:true is load-bearing (RUN-57): the picker renders one checkbox PER project, every one
  // named project_ids, and a plain parseBody() keeps only the LAST — silently scoping every
  // grant to a single project. readParams never reads project_ids, so String()-joining that
  // one array below is inert.
  const form = await c.req.parseBody({ all: true });
  const p = readParams(new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])));
  const v = await validateClient(c.env, p);
  if (!v.ok) return c.text(`invalid authorization request: ${v.err}`, 400);

  const issuer = new URL(c.req.url).origin;
  const redirect = (extra: Record<string, string>) => {
    const url = new URL(p.redirect_uri);
    for (const [k, val] of Object.entries(extra)) url.searchParams.set(k, val);
    if (p.state) url.searchParams.set('state', p.state);
    // RFC 9207: identify the issuer in the authorization response. Strict clients
    // (e.g. OpenAI/ChatGPT) reject the callback without it — mix-up defense (PLNR-82).
    url.searchParams.set('iss', issuer);
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
      return c.html(consentPage(v.name, [], p, null, 'invalid credentials'), 401);
    }
    // Show the consent step now that they're identified.
    return c.html(consentPage(v.name, await pickableProjects(c.env.DB, user.id), { ...p, ...({ _u: '' } as object) } as AuthzParams, user));
  }
  if (!user) return c.html(consentPage(v.name, [], p, null, 'sign in first'), 401);
  if (form.decision !== 'approve') return c.html(consentPage(v.name, await pickableProjects(c.env.DB, user.id), p, user), 400);

  // The scope decision is REQUIRED, and enforced here rather than only by the form (RUN-38).
  // `required` in HTML is a courtesy to a browser; this is the rule. A grant with no projects
  // would mint an unscoped token — indistinguishable, by 0027's "no rows means unscoped" rule,
  // from a legacy token that reaches everything. Refusing is the only safe reading: the human
  // did not decline scope, they failed to choose, and those must not collapse into "all".
  const pickable = await pickableProjects(c.env.DB, user.id);
  const scope = await readScope(c.env.DB, user.id, form);
  // Require a pick only when there is something to pick. A brand-new user has no projects, and
  // refusing them a token would be a deadlock: create_project is an MCP tool, so the first
  // project has to be creatable by a client that has not been granted any yet. They get a
  // token scoped to NOTHING — which is not the same as unscoped, and is why scoped_at exists.
  // "All projects" is a choice, so it satisfies the rule on its own (RUN-58).
  if (pickable.length && !scope.all && !scope.ids.length) {
    return c.html(consentPage(v.name, pickable, p, user, 'pick at least one project'), 400);
  }

  // No agent is minted here (0026). The grant authorizes a *connection* for this user; who
  // does the work is decided later, per MCP session (a copilot) or by a runner (an agent).

  // A CIMD client has no persistent registration; materialize it now so the
  // oauth_codes / oauth_tokens FK to oauth_clients resolves.
  if (v.cimd) await ensureCimdClientRow(c.env.DB, p.client_id, v.name, v.redirectUris);

  const code = randToken('plnrc_');
  await c.env.DB.prepare(
    `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, project_ids, scope_all, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(await sha256Hex(code), p.client_id, user.id, p.redirect_uri, p.code_challenge, p.scope,
    JSON.stringify(scope.ids), scope.all ? 1 : 0, new Date(Date.now() + CODE_TTL_S * 1000).toISOString()).run();
  return redirect({ code });
});

// --- device authorization grant (RFC 8628) --------------------------------------
// For clients that can't host a browser or a loopback callback — the Runner daemon on
// a headless box. The device gets a device_code (secret, polled) + a user_code (short,
// human-typed at /oauth/device on any other device). Approval mints the same agent
// identity the consent page does, so device-authorized clients are indistinguishable
// downstream.

function devicePage(o: {
  user: { name: string } | null;
  userCode: string;
  clientName?: string;
  error?: string;
  state: 'enter' | 'confirm' | 'done' | 'denied';
  /** Offered at the confirm step — the same mandatory choice the browser flow makes (RUN-38).
   *  Without it here, a headless runner (the whole reason the device grant exists) would
   *  quietly receive the wide token the consent page now refuses to issue. Two flows, one
   *  policy: the boxes are ticked on the second device, where the human already is. */
  projects?: Array<{ id: string; key: string; name: string }>;
}): string {
  if (o.state === 'done') {
    return authShell(
      'Noriq · device connected',
      `<div class="ok">✓</div>
       <p class="sub" style="text-align:center">Connected. <b>${esc(o.clientName ?? 'The device')}</b> has its token — return to your terminal.</p>
       <p class="hint" style="text-align:center">You can close this window.</p>`,
    );
  }
  if (o.state === 'denied') {
    return authShell(
      'Noriq · device denied',
      `<p class="sub">Denied — the code is now dead and the device gets nothing.</p>
       <p class="hint">If you didn't start this, there's nothing else to do: no token was ever issued.</p>`,
    );
  }
  if (o.state === 'confirm' && o.user) {
    const projects = o.projects ?? [];
    const picker = projects.length
      ? `<p class="hint" style="margin-top:14px">Which projects may this device reach? It will not see the others.</p>
         <label class="proj scope-all"><input type="checkbox" name="scope_all" value="1" id="scope_all">
           <b>All projects</b> <span>including any you create later</span></label>
         <div class="projects" id="project_list">
           ${projects
             .map((p) => `<label class="proj"><input type="checkbox" name="project_ids" value="${esc(p.id)}"> <b>${esc(p.key)}</b> <span>${esc(p.name)}</span></label>`)
             .join('')}
         </div>
         <script>
           // Cosmetic only — readScope decides this server-side; see the consent page.
           (function () {
             var all = document.getElementById('scope_all');
             var list = document.getElementById('project_list');
             if (!all || !list) return;
             var boxes = list.querySelectorAll('input[type=checkbox]');
             function sync() {
               list.style.opacity = all.checked ? '.45' : '';
               for (var i = 0; i < boxes.length; i++) {
                 boxes[i].disabled = all.checked;
                 if (all.checked) boxes[i].checked = true;
               }
             }
             all.addEventListener('change', sync);
             sync();
           })();
         </script>`
      : `<p class="hint" style="margin-top:14px">You have no projects yet. Approving gives this device access to
         <b>nothing</b> — it reaches only what it creates until you authorize it for more.</p>`;
    return authShell(
      'Noriq · authorize device',
      `<p class="sub">Signed in as <b>${esc(o.user.name)}</b>. <b>${esc(o.clientName ?? 'A device')}</b> is asking to connect <b>on your behalf</b>.</p>
       <div class="code">${esc(o.userCode)}</div>
       <p class="hint">Approve only if this matches the code on the device you started.</p>
       <form method="POST" action="/oauth/device">
         <input type="hidden" name="user_code" value="${esc(o.userCode)}">
         ${picker}
         <div class="row">
           <button name="decision" value="deny" class="ghost">Deny</button>
           <button name="decision" value="approve" class="approve">Approve</button>
         </div>
       </form>`,
      o.error,
    );
  }
  const codeField = `<label>device code<input name="user_code" value="${esc(o.userCode)}" placeholder="BCDF-GHJK" autocomplete="off" autocapitalize="characters" spellcheck="false" required></label>`;
  const inner = o.user
    ? `<p class="sub">Signed in as <b>${esc(o.user.name)}</b>. Enter the code shown on your device.</p>
       <form method="POST" action="/oauth/device">${codeField}
         <div class="row"><button name="decision" value="lookup" class="approve">Continue</button></div>
       </form>`
    : `<p class="sub">Enter the code shown on your device, then sign in to approve it.</p>
       <form method="POST" action="/oauth/device">${codeField}
         <label>email<input name="email" type="email" required></label>
         <label>password<input name="password" type="password" required></label>
         <div class="row"><button name="decision" value="login" class="approve">Sign in &amp; continue</button></div>
       </form>`;
  return authShell('Noriq · authorize device', inner, o.error);
}

type DeviceLookup = { ok: true; clientName: string } | { ok: false; err: string };

/** Resolve a human-entered user_code to a still-pending device authorization. */
async function lookupDeviceCode(db: D1Database, userCode: string): Promise<DeviceLookup> {
  if (!userCode) return { ok: false, err: 'enter the code shown on your device' };
  const row = await db.prepare(
    `SELECT d.approved_at AS approvedAt, d.denied_at AS deniedAt, d.expires_at AS expiresAt,
            COALESCE(cl.name, 'A device') AS clientName
     FROM oauth_device_codes d LEFT JOIN oauth_clients cl ON cl.id = d.client_id
     WHERE d.user_code = ?`,
  ).bind(userCode).first<{ approvedAt: string | null; deniedAt: string | null; expiresAt: string; clientName: string }>();
  if (!row) return { ok: false, err: 'unknown code — check it and try again' };
  if (row.expiresAt < nowIso()) return { ok: false, err: 'that code has expired — start again on the device' };
  if (row.deniedAt) return { ok: false, err: 'that code was already denied' };
  if (row.approvedAt) return { ok: false, err: 'that code was already approved' };
  return { ok: true, clientName: row.clientName };
}

/** RFC 8628 §3.1 — the device asks for a code pair. */
oauth.post('/device/code', async (c) => {
  if (!c.env.DISABLE_RATE_LIMIT) {
    const stub = c.env.RATE_LIMITER.get(c.env.RATE_LIMITER.idFromName(`auth:${c.req.header('CF-Connecting-IP') ?? 'local'}`));
    if (!(await stub.hit(20, 60_000)).ok) return c.json({ error: 'slow_down' }, 429);
  }
  const form = await c.req.parseBody();
  const clientId = String(form.client_id ?? '');
  const scope = String(form.scope || 'mcp');
  const client = await c.env.DB.prepare('SELECT name FROM oauth_clients WHERE id = ?').bind(clientId).first<{ name: string }>();
  if (!client) return c.json({ error: 'invalid_client' }, 400);

  // Reap expired rows first: user_code is UNIQUE, so dead codes would otherwise hold
  // their symbol space forever and drive up collisions.
  await c.env.DB.prepare('DELETE FROM oauth_device_codes WHERE expires_at < ?').bind(nowIso()).run();

  const deviceCode = randToken('plnrd_');
  const deviceHash = await sha256Hex(deviceCode);
  const expiresAt = new Date(Date.now() + DEVICE_TTL_S * 1000).toISOString();
  let userCode = '';
  for (let i = 0; i < 5 && !userCode; i++) {
    const candidate = randUserCode();
    try {
      await c.env.DB.prepare(
        `INSERT INTO oauth_device_codes (device_code_hash, user_code, client_id, scope, interval_s, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(deviceHash, candidate, clientId, scope, DEVICE_INTERVAL_S, expiresAt).run();
      userCode = candidate;
    } catch {
      /* UNIQUE collision on a live user_code — draw another */
    }
  }
  if (!userCode) return c.json({ error: 'server_error', error_description: 'could not allocate a user_code' }, 500);

  const issuer = new URL(c.req.url).origin;
  return c.json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${issuer}/oauth/device`,
    verification_uri_complete: `${issuer}/oauth/device?user_code=${encodeURIComponent(userCode)}`,
    expires_in: DEVICE_TTL_S,
    interval: DEVICE_INTERVAL_S,
  });
});

/** The human-facing verification page (RFC 8628 §3.3). */
oauth.get('/device', async (c) => {
  const userCode = normalizeUserCode(new URL(c.req.url).searchParams.get('user_code') ?? '');
  const user = await currentUser(c);
  if (!user) return c.html(devicePage({ user: null, userCode, state: 'enter' }));
  if (!userCode) return c.html(devicePage({ user, userCode: '', state: 'enter' }));
  const found = await lookupDeviceCode(c.env.DB, userCode);
  if (!found.ok) return c.html(devicePage({ user, userCode, state: 'enter', error: found.err }));
  return c.html(devicePage({
    user, userCode, clientName: found.clientName, state: 'confirm',
    projects: await pickableProjects(c.env.DB, user.id),
  }));
});

oauth.post('/device', async (c) => {
  // user_code is only ~2.6e10 wide and lives for 10 minutes — throttle guessing.
  if (!c.env.DISABLE_RATE_LIMIT) {
    const stub = c.env.RATE_LIMITER.get(c.env.RATE_LIMITER.idFromName(`auth:${c.req.header('CF-Connecting-IP') ?? 'local'}`));
    if (!(await stub.hit(20, 60_000)).ok) return c.text('too many attempts — slow down', 429);
  }
  // all:true for the same reason as the consent picker (RUN-57) — multiple project_ids
  // checkboxes must survive as an array. user_code/decision are single fields, unaffected.
  const form = await c.req.parseBody({ all: true });
  const userCode = normalizeUserCode(String(form.user_code ?? ''));
  const decision = String(form.decision ?? '');

  let user = await currentUser(c);
  if (!user && decision === 'login') {
    // Inline login, mirroring the consent page: no session cookie is set — this is a
    // single-shot approval, not a browser sign-in.
    const { verifyPassword } = await import('./lib/util');
    const row = await c.env.DB.prepare('SELECT id, name, email, password_hash AS hash FROM users WHERE email = ? AND disabled = 0')
      .bind(String(form.email ?? '').toLowerCase()).first<{ id: string; name: string; email: string; hash: string | null }>();
    if (!row?.hash || !(await verifyPassword(String(form.password ?? ''), row.hash))) {
      return c.html(devicePage({ user: null, userCode, state: 'enter', error: 'invalid credentials' }), 401);
    }
    user = row;
  }
  if (!user) return c.html(devicePage({ user: null, userCode, state: 'enter', error: 'sign in first' }), 401);

  const found = await lookupDeviceCode(c.env.DB, userCode);
  if (!found.ok) return c.html(devicePage({ user, userCode, state: 'enter', error: found.err }), 400);

  if (decision === 'deny') {
    await c.env.DB.prepare(
      'UPDATE oauth_device_codes SET denied_at = ? WHERE user_code = ? AND approved_at IS NULL AND denied_at IS NULL',
    ).bind(nowIso(), userCode).run();
    return c.html(devicePage({ user, userCode, state: 'denied' }));
  }
  // 'lookup' / 'login' land on the confirm step now that we have both a user and a live code.
  if (decision !== 'approve') {
    return c.html(devicePage({
      user, userCode, clientName: found.clientName, state: 'confirm',
      projects: await pickableProjects(c.env.DB, user.id),
    }));
  }

  // Same mandatory scope rule as the consent page (RUN-38) — two flows, one policy. A device
  // approved with no projects would mint an unscoped token, which 0027 reads as "reaches
  // everything": exactly the wide grant this task removes, arriving through the back door.
  const pickable = await pickableProjects(c.env.DB, user.id);
  const scope = await readScope(c.env.DB, user.id, form);
  if (pickable.length && !scope.all && !scope.ids.length) {
    return c.html(
      devicePage({
        user, userCode, clientName: found.clientName, state: 'confirm',
        projects: pickable, error: 'pick at least one project',
      }),
      400,
    );
  }

  // Approving binds the code to the human, not to an agent (0026) — same policy as the
  // consent page, so both grants produce identical connections. The scope rides along until
  // the device exchanges the code.
  const res = await c.env.DB.prepare(
    `UPDATE oauth_device_codes SET approved_at = ?, user_id = ?, project_ids = ?, scope_all = ?
     WHERE user_code = ? AND approved_at IS NULL AND denied_at IS NULL`,
  ).bind(nowIso(), user.id, JSON.stringify(scope.ids), scope.all ? 1 : 0, userCode).run();
  if (!res.meta.changes) return c.html(devicePage({ user, userCode, state: 'enter', error: 'that code was already resolved' }), 400);
  return c.html(devicePage({ user, userCode, clientName: found.clientName, state: 'done' }));
});

/** RFC 8628 §3.4/3.5 — the device polls here until a human resolves the user_code. */
async function deviceTokenGrant(c: Context<AppContext>, form: Record<string, unknown>) {
  const deviceCode = String(form.device_code ?? '');
  const hash = await sha256Hex(deviceCode);
  const row = await c.env.DB.prepare('SELECT * FROM oauth_device_codes WHERE device_code_hash = ?')
    .bind(hash).first<Record<string, string | number | null>>();
  if (!row) {
    // Unknown device_code doesn't get the interval's protection, so charge the shared
    // per-IP bucket instead — otherwise this branch is a free brute-force oracle.
    if (!c.env.DISABLE_RATE_LIMIT) {
      const stub = c.env.RATE_LIMITER.get(c.env.RATE_LIMITER.idFromName(`auth:${c.req.header('CF-Connecting-IP') ?? 'local'}`));
      if (!(await stub.hit(20, 60_000)).ok) return c.json({ error: 'slow_down' }, 429);
    }
    return c.json({ error: 'invalid_grant', error_description: 'unknown device_code' }, 400);
  }
  if (String(form.client_id ?? '') !== row.client_id) return c.json({ error: 'invalid_client' }, 400);
  if (row.consumed_at) return c.json({ error: 'invalid_grant', error_description: 'device_code already used' }, 400);
  if (String(row.expires_at) < nowIso()) return c.json({ error: 'expired_token' }, 400);
  if (row.denied_at) return c.json({ error: 'access_denied' }, 400);

  // Too-fast polling: bump this code's interval and tell the client to back off.
  const interval = Number(row.interval_s) || DEVICE_INTERVAL_S;
  const last = row.last_polled_at ? Date.parse(String(row.last_polled_at)) : 0;
  if (last && Date.now() - last < interval * 1000 - 1000) {
    const bumped = interval + DEVICE_INTERVAL_S;
    await c.env.DB.prepare('UPDATE oauth_device_codes SET interval_s = ?, last_polled_at = ? WHERE device_code_hash = ?')
      .bind(bumped, nowIso(), hash).run();
    return c.json({ error: 'slow_down', interval: bumped }, 400);
  }
  await c.env.DB.prepare('UPDATE oauth_device_codes SET last_polled_at = ? WHERE device_code_hash = ?').bind(nowIso(), hash).run();

  if (!row.approved_at) return c.json({ error: 'authorization_pending', interval }, 400);

  // Approved — consume it. The guarded UPDATE is what makes the code single-use even if
  // two polls race.
  const consume = await c.env.DB.prepare(
    'UPDATE oauth_device_codes SET consumed_at = ? WHERE device_code_hash = ? AND consumed_at IS NULL',
  ).bind(nowIso(), hash).run();
  if (!consume.meta.changes) return c.json({ error: 'invalid_grant', error_description: 'device_code already used' }, 400);
  const { tokenId: _dt, ...deviceGrant } = await issueTokens(
    c.env.DB, String(row.client_id), String(row.user_id), null, String(row.scope),
    JSON.parse(String(row.project_ids ?? '[]')) as string[], Number(row.scope_all ?? 0) === 1,
  );
  return c.json(deviceGrant);
}

// --- token ---------------------------------------------------------------------
oauth.post('/token', async (c) => {
  const form = await c.req.parseBody();
  const grant = String(form.grant_type ?? '');

  // Device polling paces itself on the per-device_code `interval` rather than the shared
  // per-IP auth bucket — a conforming 5s poll would otherwise eat 12 of that bucket's
  // 20/min and lock the user out of real sign-ins from the same IP.
  if (grant === DEVICE_GRANT) return deviceTokenGrant(c, form);

  if (!c.env.DISABLE_RATE_LIMIT) {
    const stub = c.env.RATE_LIMITER.get(c.env.RATE_LIMITER.idFromName(`auth:${c.req.header('CF-Connecting-IP') ?? 'local'}`));
    if (!(await stub.hit(20, 60_000)).ok) return c.json({ error: 'slow_down' }, 429);
  }

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
    const { tokenId: _ct, ...codeGrant } = await issueTokens(
      c.env.DB, row.client_id!, row.user_id!, null, row.scope!,
      JSON.parse(row.project_ids ?? '[]') as string[], Number(row.scope_all ?? 0) === 1,
    );
    return c.json(codeGrant);
  }

  if (grant === 'refresh_token') {
    const refresh = String(form.refresh_token ?? '');
    const row = await c.env.DB.prepare(
      'SELECT * FROM oauth_tokens WHERE refresh_hash = ? AND revoked_at IS NULL',
    ).bind(await sha256Hex(refresh)).first<Record<string, string>>();
    if (!row || (row.refresh_expires_at && row.refresh_expires_at < nowIso())) return c.json({ error: 'invalid_grant' }, 400);
    // Rotate: revoke the old pair, issue a new one.
    await c.env.DB.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE id = ?').bind(nowIso(), row.id!).run();
    // Carry the agent binding AND the project scope across rotation — a refresh must never
    // widen a token. Without this the rotated token would have no scope rows, which 0027 reads
    // as unscoped: refreshing would silently promote a one-project laptop to the whole account.
    // Preserve the token's exact scope state — including UNSCOPED. Rotating a legacy token
    // into a scoped-to-zero one would lock it out; rotating it into scoped-to-everything
    // would be a silent widening. Neither is a thing a refresh may decide.
    const inherited = row.scoped_at
      ? (
          await c.env.DB.prepare('SELECT project_id AS id FROM oauth_token_projects WHERE token_id = ?')
            .bind(row.id!).all<{ id: string }>()
        ).results.map((r) => r.id)
      : null;
    // An "All projects" grant carries no project rows, so `inherited` is legitimately empty for
    // one. Dropping the flag here would rotate it into scoped-to-nothing — locking out a live
    // connection on its next refresh. The exact mirror of the widening rule above.
    const inheritedAll = !!row.scoped_at && Number(row.scope_all ?? 0) === 1;
    const { tokenId: _rt, ...refreshed } = await issueTokens(
      c.env.DB, row.client_id!, row.user_id!, row.agent_id ?? null, row.scope!, inherited, inheritedAll,
    );
    return c.json(refreshed);
  }

  return c.json({ error: 'unsupported_grant_type' }, 400);
});

/**
 * Mint an access/refresh pair for a connection.
 *
 * `agentId` is normally null: a connection is not an agent, and the working copilot is
 * resolved per MCP session. It is non-null only for a token bound to one specific agent —
 * a runner's per-run token, which acts as exactly that agent and nothing else. The refresh
 * grant threads the existing binding through so rotation cannot quietly widen a bound
 * token into a general-purpose one.
 */
export async function issueTokens(
  db: D1Database,
  clientId: string,
  userId: string,
  agentId: string | null,
  scope: string,
  /**
   * The projects this token may reach (RUN-38). `null` means UNSCOPED — reaches everything the
   * user can — and is only correct for a legacy path; both grant flows always pass an array,
   * even an empty one. An empty array is a real, different thing: scoped to nothing (yet).
   */
  projectIds: string[] | null = null,
  /**
   * The human ticked "All projects" (RUN-58): this token tracks its user's access rather than
   * a frozen list, so projects created later are included. Still SCOPED (scoped_at is set), so
   * a deliberate wide grant stays distinguishable from a grandfathered legacy one — see 0034.
   */
  scopeAll = false,
) {
  const access = randToken('plnrt_');
  const refresh = randToken('plnrr_');
  const tokenId = newId('oat');
  await db.prepare(
    `INSERT INTO oauth_tokens (id, token_hash, refresh_hash, client_id, user_id, agent_id, scope, expires_at, refresh_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(tokenId, await sha256Hex(access), await sha256Hex(refresh), clientId, userId, agentId, scope,
    new Date(Date.now() + ACCESS_TTL_S * 1000).toISOString(),
    new Date(Date.now() + REFRESH_TTL_S * 1000).toISOString()).run();
  // The scope, made real. Written after the token row so the FKs resolve. scoped_at is what
  // distinguishes "a human chose, and chose nothing yet" from "legacy, reaches everything".
  // scope_all carries no project rows on purpose: the grant is "whatever my user can reach",
  // and freezing today's answer into rows is the very thing it exists not to do.
  if (projectIds || scopeAll) {
    await db.batch([
      db.prepare('UPDATE oauth_tokens SET scoped_at = ?, scope_all = ? WHERE id = ?')
        .bind(nowIso(), scopeAll ? 1 : 0, tokenId),
      ...(scopeAll ? [] : (projectIds ?? [])).map((pid) =>
        db.prepare('INSERT OR IGNORE INTO oauth_token_projects (token_id, project_id) VALUES (?, ?)').bind(tokenId, pid),
      ),
    ]);
  }
  return {
    // Not part of the OAuth response — the grant handlers strip it. It exists so a caller
    // minting a bound token (the run-agent endpoint) can point agents.oauth_token_id back
    // at the credential, which is what makes "revoke this run's token" reachable later.
    tokenId,
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_S,
    refresh_token: refresh,
    scope,
  };
}
