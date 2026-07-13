import type { Context, Next } from 'hono';
import type { Env } from './env';
import { sha256Hex } from './lib/util';

export interface AgentIdentity {
  id: string;
  name: string;
  role: 'orchestrator' | 'worker';
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
};

export type AppContext = { Bindings: Env; Variables: Vars };

/** Bearer-key auth for agents (MCP + agent REST). Sets c.var.agent. */
export async function agentAuth(c: Context<AppContext>, next: Next) {
  const header = c.req.header('Authorization') ?? '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!key) return c.json({ error: 'missing bearer token' }, 401);
  const hash = await sha256Hex(key);
  const row = await c.env.DB.prepare(
    "SELECT id, name, role FROM agents WHERE api_key_hash = ? AND status != 'revoked'",
  )
    .bind(hash)
    .first<AgentIdentity>();
  if (!row) return c.json({ error: 'invalid or revoked token' }, 401);
  c.set('agent', row);
  await next();
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
     WHERE s.id = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
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
