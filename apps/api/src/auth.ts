import type { Context, Next } from 'hono';
import type { Env } from './env';
import { newId, nowIso, sha256Hex } from './lib/util';

/** What kind of thing is working (RUN-43). See migration 0026 for the full contrast. */
export type AgentKind = 'copilot' | 'agent';

export interface AgentIdentity {
  id: string;
  name: string;
  role: 'orchestrator' | 'worker';
  /** The user this agent acts on behalf of — its MCP access is scoped to them (PLNR-83). */
  userId: string;
  /** copilot = a human's session (self-created, may hop projects, no heartbeat expectation).
   *  agent   = runner-spawned for one run (runner-owned, project-pinned, heartbeat matters). */
  kind: AgentKind;
  /**
   * The daemon-declared tool floor for a runner-spawned agent (RUN-47): the MCP server
   * advertises only these tools, so the catalogue the model sees matches what the daemon's
   * permission profile lets it call. NULL = no floor declared (every copilot; agents minted
   * by a pre-RUN-47 daemon) → the full catalogue, the pre-existing behavior.
   */
  allowedTools?: string[] | null;
}

/** An authorized OAuth credential (one `claude mcp add`). Many copilots (sessions) share one.
 *  A connection is NOT an agent — that conflation died in 0026. */
export interface Connection {
  tokenId: string;
  userId: string;
  clientId: string;
  clientName: string;
  /**
   * Set only when the token is bound to one specific agent — i.e. a runner's per-run token,
   * which acts as exactly that agent regardless of MCP session. NULL for a human's connection,
   * where the working copilot is resolved per session instead.
   */
  boundAgent: AgentIdentity | null;
  /**
   * The connection's own copilot (PLNR-155) — minted when the grant was exchanged, and the
   * PARENT that each session copilot hangs off. Independent of boundAgent, and never both:
   * a human's connection has a copilot, a runner's per-run token has a bound agent.
   * Null only for a token minted before PLNR-155 (its sessions simply have no parent).
   */
  copilotId: string | null;
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
 * agents.allowed_tools is JSON the daemon wrote; a malformed value must degrade to
 * "no floor" (full catalogue), never to a 500 on every request this agent makes.
 */
function parseAllowedTools(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null;
  } catch {
    return null;
  }
}

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

  // The token no longer resolves an agent by itself: a connection is not an agent (0026).
  // agent_id is set ONLY for a runner's per-run token, so the join is LEFT and its absence
  // is the normal case for a human's connection.
  const t = await c.env.DB.prepare(
    `SELECT t.id AS tokenId, t.user_id AS userId, t.client_id AS clientId, t.agent_id AS boundAgentId,
            t.copilot_id AS copilotId,
            a.id AS agentId, COALESCE(a.label, a.name) AS agentName, a.role AS agentRole, a.kind AS agentKind,
            a.allowed_tools AS agentAllowedTools,
            COALESCE(cl.name, 'MCP client') AS clientName
     FROM oauth_tokens t
     LEFT JOIN agents a ON a.id = t.agent_id AND a.status != 'revoked'
     LEFT JOIN oauth_clients cl ON cl.id = t.client_id
     WHERE t.token_hash = ? AND t.revoked_at IS NULL
       AND t.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).bind(hash).first<{
    tokenId: string; userId: string; clientId: string; clientName: string; boundAgentId: string | null;
    copilotId: string | null;
    agentId: string | null; agentName: string | null; agentRole: 'orchestrator' | 'worker' | null;
    agentKind: AgentKind | null; agentAllowedTools: string | null;
  }>();
  if (!t) return unauthorized('invalid, expired, or revoked token — connect via OAuth');

  // A token bound to an agent that is revoked (or gone) must FAIL, not silently degrade to
  // an unbound connection — otherwise revoking a runaway agent would hand its token back the
  // right to resolve a fresh copilot per session, which is the opposite of a kill switch.
  if (t.boundAgentId && !t.agentId) return unauthorized('this token’s agent was revoked');

  const boundAgent: AgentIdentity | null = t.agentId
    ? {
        id: t.agentId, name: t.agentName ?? t.agentId, role: t.agentRole ?? 'worker',
        userId: t.userId, kind: t.agentKind ?? 'agent',
        allowedTools: parseAllowedTools(t.agentAllowedTools),
      }
    : null;
  c.set('oauthTokenId', t.tokenId);
  c.set('connection', {
    tokenId: t.tokenId, userId: t.userId, clientId: t.clientId, clientName: t.clientName,
    boundAgent, copilotId: t.copilotId,
  });
  // No `agent` is set here. Routes that need one either read connection.boundAgent or resolve
  // it per MCP session; the runner's REST endpoints (register/heartbeat/steer-ack) need only
  // the connection's user.
  if (boundAgent) c.set('agent', boundAgent);
  await next();
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 16) || 'agent';

/**
 * Resolve the COPILOT for one MCP session (a chat, or a sub-agent) on a connection.
 * Each MCP client `initialize` gets its own session id, so this is one copilot per
 * session — parented to the connection's own copilot (PLNR-155), which is what keeps a
 * busy day legible: one named connection with its chats beneath it, rather than a flat
 * wall of anonymous rows. Created unscoped (project_id NULL) because a copilot roams.
 *
 * Nothing here needs announcing itself: the parent was registered when the grant was
 * exchanged and the child is named from the client, so an agent never has to invent an
 * identity (PLNR-157). set_agent_identity survives only to RENAME one it already has.
 *
 * This path only ever mints copilots. A runner-spawned agent is created by the runner
 * and reached through a token bound to it (connection.boundAgent) — it never arrives
 * here, and the kind filter below keeps it that way even if one somehow carried a
 * session id: a runner's agent must never be adopted by whoever presents a session.
 */
export async function resolveSessionAgent(env: Env, conn: Connection, sessionId: string): Promise<AgentIdentity> {
  // Deliberately NOT filtered by status: a revoked copilot must be FOUND so it can be
  // refused. Filtering it out here would make the row invisible and send us straight to
  // the INSERT below — silently minting a replacement identity for the same session and
  // handing a revoked agent its access back. Revocation has to bite somewhere, and with a
  // connection no longer being an agent (0026) this is the only place left that it can.
  const existing = await env.DB.prepare(
    `SELECT id, COALESCE(label, name) AS name, role, user_id AS userId, kind, status
       FROM agents WHERE session_id = ? AND kind = 'copilot'`,
  ).bind(sessionId).first<AgentIdentity & { status: string }>();
  if (existing) {
    // The session id is client-supplied (echoed back from initialize). Bind it to
    // the authenticated user so a leaked session id can't be replayed with another
    // user's token to act AS that user's agent (PLNR-101).
    if (existing.userId !== conn.userId) throw new Error('session id does not belong to this connection');
    if (existing.status === 'revoked') throw new Error('this session’s agent was revoked');
    return existing;
  }
  const id = newId('agt');
  // `name` is a stable, globally-unique internal handle (label is the friendly display,
  // set via set_agent_identity). The id suffix guarantees uniqueness. PLNR-65 settled this
  // split deliberately — name is not dead weight, it is the handle label falls back to.
  const name = `${slug(conn.clientName)}-${id.slice(-6)}`;
  // parent_agent_id is the connection's copilot. Null only for a token minted before
  // PLNR-155 — those sessions stay parentless rather than being adopted by a guess.
  await env.DB.prepare(
    `INSERT INTO agents (id, name, role, status, kind, user_id, oauth_token_id, session_id, parent_agent_id, created_at)
     VALUES (?, ?, 'worker', 'idle', 'copilot', ?, ?, ?, ?, ?)`,
  ).bind(id, name, conn.userId, conn.tokenId, sessionId, conn.copilotId, nowIso()).run();
  return { id, name, role: 'worker', userId: conn.userId, kind: 'copilot' };
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
  // Idempotent: the project-subtree access middleware (PLNR-92) resolves the user
  // before the route-level userAuth runs again — don't re-query the session then.
  if (c.get('user')) return next();
  const sid = readSessionId(c.req.header('Cookie') ?? '');
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

export function readSessionId(cookieHeader: string): string | null {
  return getCookie(cookieHeader, 'noriq_session');
}

export function sessionSetCookie(sid: string, expires: Date): string {
  return `noriq_session=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/; Expires=${expires.toUTCString()}`;
}

export const SESSION_CLEAR_COOKIE = 'noriq_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
