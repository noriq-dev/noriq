// PLNR-166: write-freeze / maintenance mode. Runs in its own vitest project with
// MAINTENANCE_MODE baked ON (env vars don't propagate to the SELF worker isolate at
// runtime — same reason the demo suite is its own project). Because every HTTP write is
// frozen here, fixtures are seeded by DIRECT D1 inserts (bypassing the frozen surface),
// then we assert that writes are refused while reads stay live.
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { mcpCall } from './helpers';

const DB = () => (env as unknown as { DB: D1Database }).DB;
const asJson = { 'Content-Type': 'application/json' };
const FUTURE = '2999-01-01T00:00:00.000Z';
const now = '2026-07-20T00:00:00.000Z';
async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const SESSION_VALUE = 'maint-session-cookie-value';
const cookie = `noriq_session=${SESSION_VALUE}`;
const AGENT_TOKEN = 'maint-agent-bearer-token';

beforeAll(async () => {
  const db = DB();
  // A user reachable via a direct session cookie (login is a frozen write).
  await db.prepare("INSERT OR IGNORE INTO users (id, email, name, role, created_at) VALUES ('usr_maint', 'maint@example.com', 'Maint', 'admin', ?)").bind(now).run();
  await db.prepare('INSERT OR IGNORE INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').bind(await sha256Hex(SESSION_VALUE), 'usr_maint', FUTURE).run();

  // A bound MCP connection (the OAuth mint flow is a frozen write). agent_id on the token
  // makes agentAuth act AS this agent — no session resolution needed. A copilot (not a
  // runner 'agent') so it needs no runner_id/project_id (the 0026 CHECK).
  await db.prepare("INSERT OR IGNORE INTO oauth_clients (id, name, redirect_uris, created_at) VALUES ('cli_maint', 'maint client', '[]', ?)").bind(now).run();
  await db.prepare("INSERT OR IGNORE INTO agents (id, name, role, status, user_id, kind, created_at) VALUES ('agt_maint', 'maint-seed-agent', 'worker', 'idle', 'usr_maint', 'copilot', ?)").bind(now).run();
  await db.prepare("INSERT OR IGNORE INTO oauth_tokens (id, token_hash, client_id, user_id, agent_id, scope, expires_at) VALUES ('tok_maint', ?, 'cli_maint', 'usr_maint', 'agt_maint', 'mcp', ?)").bind(await sha256Hex(AGENT_TOKEN), FUTURE).run();
});

describe('write-freeze (PLNR-166)', () => {
  it('freezes REST writes with a retryable 503 but keeps reads live', async () => {
    // Read: still served.
    expect((await SELF.fetch('https://noriq.test/api/projects', { headers: { Cookie: cookie } })).status).toBe(200);

    // Write: refused, retryable, with a clear reason.
    const write = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: cookie, ...asJson }, body: JSON.stringify({ key: 'MNTON', name: 'during freeze' }),
    });
    expect(write.status).toBe(503);
    expect(write.headers.get('Retry-After')).toBeTruthy();
    expect((await write.json() as { error: string }).error).toMatch(/maintenance/i);
  });

  it('advertises the freeze on /api/health and keeps auth live for operators', async () => {
    const health = await (await SELF.fetch('https://noriq.test/api/health')).json() as { maintenance: boolean };
    expect(health.maintenance).toBe(true);
    // Auth is exempt so an operator can still sign in/out to observe during the window.
    expect((await SELF.fetch('https://noriq.test/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } })).status).toBe(200);
  });

  it('MCP write tools return a retryable error while read tools stay live', async () => {
    // Read tool: works.
    const read = await mcpCall(AGENT_TOKEN, 'get_briefing', {});
    expect(read.isError).toBe(false);

    // Write tool: refused with the maintenance reason, so the agent parks instead of
    // believing a phantom ack.
    const write = await mcpCall(AGENT_TOKEN, 'create_project', { key: 'MCPMNT', name: 'frozen' });
    expect(write.isError).toBe(true);
    expect(write.text).toMatch(/maintenance/i);
  });
});
