import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { agentLifecycleSweepConfig, sweepAgentLifecycle } from '../src/lib/agent-lifecycle-sweep';
import { ADMIN, createAgent, mcpCall } from './helpers';

const OLD = '2000-01-01T00:00:00.000Z';
const NOW = '2026-08-09T12:00:00.000Z';
const CURSOR = { actorId: 'zzals_', presenceId: 'zzals_', runnerId: 'zzals_' };
const appEnv = env as unknown as Env;

let ownerId: string;
let projectId: string;

beforeAll(async () => {
  const connection = await createAgent('lifecycle-sweep');
  ownerId = (await env.DB.prepare('SELECT user_id AS userId FROM agents WHERE id = ?')
    .bind(connection.id).first<{ userId: string }>())!.userId;
  projectId = (await mcpCall(connection.apiKey, 'create_project', {
    key: 'ALSWEEP', name: 'Actor lifecycle sweep fixtures',
  })).body.id as string;

  await env.DB.prepare(
    `INSERT INTO agents (
       id, name, status, kind, actor_class, user_id, project_id, session_id,
       last_seen_at, lineage_status, lineage_reason, lifecycle_updated_at, created_at
     ) VALUES
       ('zzals_session', 'zzals-session', 'active', 'copilot', 'session_copilot', ?, ?,
        'zzals-session', ?, 'partial', 'immediate_parent_unknown', ?, ?),
       ('zzals_protected', 'zzals-protected', 'active', 'copilot', 'session_copilot', ?, ?,
        'zzals-protected', ?, 'partial', 'immediate_parent_unknown', ?, ?)`,
  ).bind(ownerId, projectId, OLD, OLD, OLD, ownerId, projectId, OLD, OLD, OLD).run();

  await env.DB.prepare(
    `INSERT INTO file_locks (
       id, project_id, agent_id, kind, raw_pattern, canon_pattern, branch, all_branches,
       acquired_at, expires_at
     ) VALUES ('zzals_lock', ?, 'zzals_protected', 'file', 'safe.ts', 'safe.ts', 'main', 0, ?, ?)`,
  ).bind(projectId, OLD, '2099-01-01T00:00:00.000Z').run();

  await env.DB.prepare(
    `INSERT INTO runners (
       id, owner_user_id, label, status, last_heartbeat_at, created_at
     ) VALUES ('zzals_runner', ?, 'sweep-runner', 'offline', ?, ?)`,
  ).bind(ownerId, OLD, OLD).run();
  await env.DB.prepare(
    `INSERT INTO runs (
       id, project_id, runner_id, kind, repo_ref, agent_tool, status, created_by, updated_at
     ) VALUES ('zzals_run', ?, 'zzals_runner', 'build', 'repo-sweep', 'codex', 'done', ?, ?)`,
  ).bind(projectId, ownerId, OLD).run();
  await env.DB.prepare(
    `INSERT INTO agents (
       id, name, status, kind, actor_class, user_id, project_id, runner_id,
       last_seen_at, lineage_status, lineage_reason, lifecycle_updated_at, created_at
     ) VALUES (
       'zzals_run_agent', 'zzals-run-agent', 'active', 'agent', 'runner_agent', ?, ?,
       'zzals_runner', ?, 'partial', 'execution_contract_pending', ?, ?)`,
  ).bind(ownerId, projectId, OLD, OLD, OLD).run();
  await env.DB.prepare("UPDATE runs SET agent_id = 'zzals_run_agent' WHERE id = 'zzals_run'").run();

  await env.DB.prepare(
    `INSERT INTO agent_presences (
       id, kind, source_key, actor_id, project_id, state, started_at, last_seen_at,
       ended_at, end_reason, created_at, updated_at
     ) VALUES (
       'zzals_presence', 'mcp_session', 'purge-fixture', 'zzals_session', ?, 'ended', ?, ?,
       ?, 'fixture_ended', ?, ?)`,
  ).bind(projectId, OLD, OLD, OLD, OLD, OLD).run();
});

describe('agent lifecycle sweep policy and configuration (PLNR-363)', () => {
  it('validates deployment overrides and keeps scheduled mutation opt-in', () => {
    expect(agentLifecycleSweepConfig({
      AGENT_LIFECYCLE_ONLINE_SECONDS: '-1',
      AGENT_COPILOT_RETIRE_DAYS: '999999',
      AGENT_LIFECYCLE_SWEEP_BATCH: '0',
      AGENT_LIFECYCLE_SWEEP_APPLY: 'true',
    } as Partial<Env>)).toMatchObject({
      onlineSeconds: 0,
      copilotRetireDays: 3650,
      batchSize: 1,
      scheduledApply: true,
    });
    expect(agentLifecycleSweepConfig({})).toMatchObject({
      onlineSeconds: 300,
      copilotRetireDays: 7,
      historyArchiveDays: 30,
      presencePurgeDays: 90,
      runnerOfflineArchiveDays: 30,
      batchSize: 100,
      scheduledApply: false,
    });
  });

  it('dry-runs without mutation and reports both transitions and protected work', async () => {
    const eventCountBefore = (await env.DB.prepare('SELECT COUNT(*) AS count FROM agent_lifecycle_events')
      .first<{ count: number }>())!.count;
    const result = await sweepAgentLifecycle(appEnv, { dryRun: true, at: NOW, cursor: CURSOR });
    expect(result.referenceCheck).toEqual({ complete: true, blockers: [] });
    expect(result.transitions['actor:active->retired:session_inactive']).toBe(1);
    expect(result.transitions['actor:active->retired:run_terminal']).toBe(1);
    expect(result.transitions['presence:ended->purged:presence_retention_elapsed']).toBe(1);
    expect(result.transitions['runner:dormant->retired:runner_offline_retention']).toBe(1);
    expect(result.protections.live_lock).toBe(1);

    expect(await env.DB.prepare(
      "SELECT retired_at FROM agents WHERE id = 'zzals_session'",
    ).first()).toEqual({ retired_at: null });
    expect(await env.DB.prepare(
      "SELECT 1 AS present FROM agent_presences WHERE id = 'zzals_presence'",
    ).first()).toEqual({ present: 1 });
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM agent_lifecycle_events')
      .first<{ count: number }>())!.count).toBe(eventCountBefore);
  });

  it('applies once, converges through archival, and never retires protected sessions', async () => {
    const first = await sweepAgentLifecycle(appEnv, { dryRun: false, at: NOW, cursor: CURSOR });
    expect(first.transitions['actor:active->retired:session_inactive']).toBe(1);
    expect(first.transitions['actor:active->retired:run_terminal']).toBe(1);
    expect(first.transitions['presence:ended->purged:presence_retention_elapsed']).toBe(1);

    expect(await env.DB.prepare(
      `SELECT retired_at AS retiredAt, retire_reason AS reason, status
         FROM agents WHERE id = 'zzals_session'`,
    ).first()).toMatchObject({ retiredAt: OLD, reason: 'session_inactive', status: 'offline' });
    expect(await env.DB.prepare(
      "SELECT retired_at AS retiredAt FROM agents WHERE id = 'zzals_protected'",
    ).first()).toEqual({ retiredAt: null });
    expect(await env.DB.prepare(
      "SELECT 1 AS present FROM agent_presences WHERE id = 'zzals_presence'",
    ).first()).toBeNull();

    const second = await sweepAgentLifecycle(appEnv, { dryRun: false, at: NOW, cursor: CURSOR });
    expect(second.transitions['actor:retired->archived:history_retention_elapsed']).toBe(2);
    expect(second.transitions['runner:retired->archived:runner_history_retention_elapsed']).toBe(1);

    const before = (await env.DB.prepare('SELECT COUNT(*) AS count FROM agent_lifecycle_events')
      .first<{ count: number }>())!.count;
    const third = await sweepAgentLifecycle(appEnv, { dryRun: false, at: NOW, cursor: CURSOR });
    expect(third.transitions).toEqual({});
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM agent_lifecycle_events')
      .first<{ count: number }>())!.count).toBe(before);
  });

  it('keeps the operator endpoint admin-only and dry-run by default', async () => {
    const denied = await SELF.fetch('https://noriq.test/api/admin/agent-lifecycle-sweep', { method: 'POST' });
    expect(denied.status).toBeGreaterThanOrEqual(401);

    const allowed = await SELF.fetch('https://noriq.test/api/admin/agent-lifecycle-sweep', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor: CURSOR }),
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ dryRun: true });
  });
});
