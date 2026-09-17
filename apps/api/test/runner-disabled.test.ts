// Drop-runner Phase 1: RUNNER_DISABLED kill-switch. Runs in its own vitest project with the
// flag baked ON (env vars do not reach the SELF worker isolate at runtime).
import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createUser, loginSession } from './helpers';

const DB = () => (env as unknown as { DB: D1Database }).DB;
const asJson = { 'Content-Type': 'application/json' };
const FUTURE = '2999-01-01T00:00:00.000Z';
const now = '2026-09-17T00:00:00.000Z';

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const AGENT_TOKEN = 'runner-disabled-agent-token';
const bearer = { Authorization: `Bearer ${AGENT_TOKEN}` };
let sessionCookie: string;
let sessionProjectId: string;

beforeAll(async () => {
  const db = DB();
  await db.prepare(
    "INSERT OR IGNORE INTO users (id, email, name, role, created_at) VALUES ('usr_rd', 'rd@example.com', 'RD', 'admin', ?)",
  ).bind(now).run();
  await db.prepare(
    "INSERT OR IGNORE INTO oauth_clients (id, name, redirect_uris, created_at) VALUES ('cli_rd', 'rd client', '[]', ?)",
  ).bind(now).run();
  await db.prepare(
    "INSERT OR IGNORE INTO agents (id, name, role, status, user_id, kind, created_at) VALUES ('agt_rd', 'rd-agent', 'worker', 'idle', 'usr_rd', 'copilot', ?)",
  ).bind(now).run();
  // Connection copilot credential (agent_id NULL) — runner-bound tokens are refused post slice 5.
  await db.prepare(
    `INSERT OR IGNORE INTO oauth_tokens (id, token_hash, client_id, user_id, agent_id, copilot_id, scope, expires_at)
     VALUES ('tok_rd', ?, 'cli_rd', 'usr_rd', NULL, 'agt_rd', 'mcp', ?)`,
  ).bind(await sha256Hex(AGENT_TOKEN), FUTURE).run();

  await createUser('rd-session@example.com', 'RD Session', 'longenough1', 'admin').catch(() => {});
  sessionCookie = await loginSession('rd-session@example.com', 'longenough1');
  const projectRes = await SELF.fetch('https://noriq.test/api/projects', {
    method: 'POST',
    headers: { Cookie: sessionCookie, ...asJson },
    body: JSON.stringify({ key: `RD${crypto.randomUUID().slice(0, 4).toUpperCase()}`, name: 'runner disabled gate' }),
  });
  sessionProjectId = ((await projectRes.json()) as { id: string }).id;
});

describe('RUNNER_DISABLED kill-switch', () => {
  it('surfaces on /api/health', async () => {
    const health = await (await SELF.fetch('https://noriq.test/api/health')).json() as { runnerDisabled: boolean };
    expect(health.runnerDisabled).toBe(true);
  });

  it('returns 404 for removed runner-plane REST routes', async () => {
    for (const [path, headers, body] of [
      ['/api/runners', { ...bearer, ...asJson }, { label: 'x', maxConcurrency: 1 }],
      ['/api/runners/rnr_test/heartbeat', { ...bearer, ...asJson }, { freeSlots: 1, status: 'online' }],
      ['/api/runner-ingest/capability', { ...bearer, ...asJson }, { runnerId: 'rnr_test', projectId: 'prj_any', repositoryKey: 'repo', purpose: 'index', scopeId: 'gen' }],
      ['/api/runner-spinoffs', { ...bearer, ...asJson }, { runnerId: 'rnr_test', projectId: 'prj_any', sourceRunId: 'run_x', sourceTaskId: 'tsk_x', title: 'nope' }],
    ] as const) {
      const res = await SELF.fetch(`https://noriq.test${path}`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      expect(res.status, path).toBe(404);
    }

    const listRunners = await SELF.fetch('https://noriq.test/api/runners', { headers: { Cookie: sessionCookie } });
    expect(listRunners.status).toBe(404);

    const dispatch = await SELF.fetch(
      `https://noriq.test/api/projects/${sessionProjectId}/tasks/tsk_any/runner-jobs`,
      {
        method: 'POST',
        headers: { Cookie: sessionCookie, ...asJson },
        body: JSON.stringify({ runnerId: 'rnr_test', repoRef: 'main' }),
      },
    );
    expect(dispatch.status).toBe(404);
  });

  it('returns 404 for removed runner daemon WebSocket route', async () => {
    const ws = await SELF.fetch('https://noriq.test/ws/runner/rnr_test', {
      headers: { ...bearer, Upgrade: 'websocket' },
    });
    expect(ws.status).toBe(404);
  });

  it('keeps MCP reachable (coordination-only)', async () => {
    const res = await SELF.fetch('https://noriq.test/mcp', {
      method: 'POST',
      headers: { ...bearer, ...asJson },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(200);
  });
});
