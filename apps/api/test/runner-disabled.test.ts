// Drop-runner Phase 1: RUNNER_DISABLED kill-switch. Runs in its own vitest project with the
// flag baked ON (env vars do not reach the SELF worker isolate at runtime).
import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { RUNNER_DISABLED_CODE } from '../src/lib/runner-disabled';
import type { Actor } from '../src/do/ProjectRoom';
import { createUser, loginSession, projectRoom, SYSTEM_ACTOR } from './helpers';

const DB = () => (env as unknown as { DB: D1Database }).DB;
const asJson = { 'Content-Type': 'application/json' };
const FUTURE = '2999-01-01T00:00:00.000Z';
const now = '2026-09-17T00:00:00.000Z';
const ADMIN = 'test-admin-token';

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
  await db.prepare(
    `INSERT OR IGNORE INTO oauth_tokens (id, token_hash, client_id, user_id, agent_id, scope, expires_at)
     VALUES ('tok_rd', ?, 'cli_rd', 'usr_rd', 'agt_rd', 'mcp', ?)`,
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

  it('refuses runner registration, heartbeat, dispatch, and WS upgrade with 410', async () => {
    for (const [path, headers, body] of [
      ['/api/runners', { ...bearer, ...asJson }, { label: 'x', maxConcurrency: 1 }],
      ['/api/runners/rnr_test/heartbeat', { ...bearer, ...asJson }, { freeSlots: 1, status: 'online' }],
      ['/api/runner-ingest/capability', { ...bearer, ...asJson }, { runnerId: 'rnr_test', projectId: 'prj_any', repositoryKey: 'repo', purpose: 'index', scopeId: 'gen' }],
      ['/api/runner-spinoffs', { ...bearer, ...asJson }, { runnerId: 'rnr_test', projectId: 'prj_any', sourceRunId: 'run_x', sourceTaskId: 'tsk_x', title: 'nope' }],
    ] as const) {
      const res = await SELF.fetch(`https://noriq.test${path}`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      expect(res.status, path).toBe(410);
      expect(await res.json()).toMatchObject({ code: RUNNER_DISABLED_CODE });
    }

    const dispatch = await SELF.fetch(
      `https://noriq.test/api/projects/${sessionProjectId}/tasks/tsk_any/runner-jobs`,
      {
        method: 'POST',
        headers: { Cookie: sessionCookie, ...asJson },
        body: JSON.stringify({ runnerId: 'rnr_test', repoRef: 'main' }),
      },
    );
    expect(dispatch.status).toBe(410);
    expect(await dispatch.json()).toMatchObject({ code: RUNNER_DISABLED_CODE });

    const ws = await SELF.fetch('https://noriq.test/ws/runner/rnr_test', {
      headers: { ...bearer, Upgrade: 'websocket' },
    });
    expect(ws.status).toBe(410);
    expect(await ws.text()).toMatch(/runner execution is disabled/i);
  });

  it('keeps MCP reachable (coordination-only)', async () => {
    const res = await SELF.fetch('https://noriq.test/mcp', {
      method: 'POST',
      headers: { ...bearer, ...asJson },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(200);
  });

  it('drains live runner work via admin endpoint', async () => {
    const db = DB();
    const pid = 'prj_rd_drain';
    const runnerId = 'rnr_rd_drain';
    await db.prepare(
      "INSERT OR IGNORE INTO projects (id, key, name, status, claim_ttl_seconds, owner_user_id, created_at) VALUES (?, 'RDD', 'Drain', 'active', 1800, 'usr_rd', ?)",
    ).bind(pid, now).run();
    await db.prepare(
      "INSERT OR IGNORE INTO runners (id, owner_user_id, label, status, repos, created_at) VALUES (?, 'usr_rd', 'drain-runner', 'online', '[]', ?)",
    ).bind(runnerId, now).run();

    const room = projectRoom<{ createTask(p: string, a: Actor, i: { title: string }): Promise<{ id: string }>; createRunnerJob(p: string, a: Actor, i: unknown): Promise<{ id: string }>; assignRunnerJob(p: string, jobId: string, r: string): Promise<unknown> }>(pid);
    const task = await room.createTask(pid, SYSTEM_ACTOR as Actor, { title: 'drain fixture' });
    const job = await room.createRunnerJob(pid, SYSTEM_ACTOR as Actor, {
      source: { kind: 'task', id: task.id },
      runnerId,
      repoRef: 'main',
      expectedBaseRevision: 'a'.repeat(40),
    });
    await room.assignRunnerJob(pid, job.id, runnerId);

    const drain = await SELF.fetch('https://noriq.test/api/admin/runner-plane/drain', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    expect(drain.status).toBe(200);
    const body = await drain.json() as { cancelledJobs: number };
    expect(body.cancelledJobs).toBeGreaterThanOrEqual(1);

    const row = await db.prepare('SELECT status FROM runner_jobs WHERE id = ?').bind(job.id).first<{ status: string }>();
    expect(row?.status).toBe('cancelled');
  });
});
