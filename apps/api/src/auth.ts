import type { Context, Next } from 'hono';
import type { Env } from './env';
import { newId, nowIso, sha256Hex } from './lib/util';

export interface AgentIdentity {
  id: string;
  name: string;
  role: 'orchestrator' | 'worker';
}

/** An authorized OAuth credential (one `claude mcp add`). Many agents (sessions) share one. */
export interface Connection {
  tokenId: string;
  userId: string;
  clientId: string;
  clientName: string;
  /** The token's legacy default agent — used only when a client sends no MCP session id. */
  defaultAgent: AgentIdentity;
}

export interface UserIdentity {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
}

export type Vars = {
  agent?: AgentIdentity;
  user?: UserIdentity;
  /** Set when the agent authenticated with an OAuth access token (enables set_agent_identity). */
  oauthTokenId?: string;
  /** The OAuth connection behind an agent request (agents are resolved per MCP session). */
  connection?: Connection;
};

export type AppContext = { Bindings: Env; Variables: Vars };

/**
 * Bearer auth for agents (MCP): OAuth 2.1 access tokens only (static API keys
 * were retired — PLNR-52). 401s advertise the OAuth resource metadata so MCP
 * clients can discover the authorization server.
 */
export async function agentAuth(c: Context<AppContext>, next: Next) {
  const unauthorized = (msg: string) => {
    c.header(
      'WWW-Authenticate',
      `Bearer resource_metadata="${new URL(c.req.url).origin}/.well-known/oauth-protected-resource"`,
    );
    return c.json({ error: msg }, 401);
  };
  const header = c.req.header('Authorization') ?? '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!key) return unauthorized('missing bearer token');
  const hash = await sha256Hex(key);

  const t = await c.env.DB.prepare(
    `SELECT t.id AS tokenId, t.user_id AS userId, t.client_id AS clientId,
            a.id AS agentId, COALESCE(a.label, a.name) AS agentName, a.role AS agentRole,
            COALESCE(cl.name, 'MCP client') AS clientName
     FROM oauth_tokens t
     JOIN agents a ON a.id = t.agent_id
     LEFT JOIN oauth_clients cl ON cl.id = t.client_id
     WHERE t.token_hash = ? AND t.revoked_at IS NULL
       AND t.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND a.status != 'revoked'`,
  ).bind(hash).first<{
    tokenId: string; userId: string; clientId: string; clientName: string;
    agentId: string; agentName: string; agentRole: 'orchestrator' | 'worker';
  }>();
  if (!t) return unauthorized('invalid, expired, or revoked token — connect via OAuth');

  const defaultAgent: AgentIdentity = { id: t.agentId, name: t.agentName, role: t.agentRole };
  c.set('oauthTokenId', t.tokenId);
  c.set('connection', { tokenId: t.tokenId, userId: t.userId, clientId: t.clientId, clientName: t.clientName, defaultAgent });
  // Legacy fallback identity; the /mcp route resolves the real per-session agent.
  c.set('agent', defaultAgent);
  await next();
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 16) || 'agent';

/**
 * Resolve the agent for one MCP session (a chat, or a sub-agent) on a connection.
 * Each MCP client `initialize` gets its own session id, so this is one agent per
 * session. Created unscoped (project_id NULL) and unnamed-ish; set_agent_identity or
 * the first claim gives it a real name + project.
 */
export async function resolveSessionAgent(env: Env, conn: Connection, sessionId: string): Promise<AgentIdentity> {
  const existing = await env.DB.prepare(
    `SELECT id, COALESCE(label, name) AS name, role FROM agents WHERE session_id = ? AND status != 'revoked'`,
  ).bind(sessionId).first<AgentIdentity>();
  if (existing) return existing;
  const id = newId('agt');
  // `name` is a stable, globally-unique internal handle (label is the friendly display,
  // set via set_agent_identity). The id suffix guarantees uniqueness.
  const name = `${slug(conn.clientName)}-${id.slice(-6)}`;
  // api_key_hash is a vestigial NOT NULL column (no static keys); a random unusable hash fills it.
  await env.DB.prepare(
    `INSERT INTO agents (id, name, role, status, user_id, oauth_token_id, session_id, api_key_hash, created_at)
     VALUES (?, ?, 'worker', 'idle', ?, ?, ?, ?, ?)`,
  ).bind(id, name, conn.userId, conn.tokenId, sessionId, await sha256Hex(crypto.randomUUID()), nowIso()).run();
  return { id, name, role: 'worker' };
}

/** Admin-token auth for bootstrap/ops endpoints (agent key issuance, user creation). */
export async function adminAuth(c: Context<AppContext>, next: Next) {
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!c.env.ADMIN_TOKEN || token !== c.env.ADMIN_TOKEN) {
    return c.json({ error: 'admin token required' }, 401);
  }
  await next();
}

/** Session-cookie auth for humans. Sets c.var.user. */
export async function userAuth(c: Context<AppContext>, next: Next) {
  const sid = getCookie(c.req.header('Cookie') ?? '', 'planar_session');
  if (!sid) return c.json({ error: 'not signed in' }, 401);
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND u.disabled = 0`,
  )
    .bind(await sha256Hex(sid))
    .first<UserIdentity>();
  if (!row) return c.json({ error: 'session expired' }, 401);
  c.set('user', row);
  await next();
}

export function getCookie(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
