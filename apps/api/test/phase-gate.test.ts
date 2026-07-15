// RUN-21: phase-boundary verify gating + bounded retries.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/do/ProjectRoom';
import type { Env } from '../src/env';
import { DEFAULT_MAX_VERIFY_ATTEMPTS, phaseGateDecision } from '../src/lib/phase-gate';
import { createAgent, loginSession, mcpCall } from './helpers';

const actor: Actor = { kind: 'human', id: 'usr_pg', name: 'Gate Tester' };

interface RoomRpc {
  recordPhaseVerify(
    projectId: string,
    actor: Actor,
    phaseId: string,
    passed: boolean,
    opts?: { maxAttempts?: number },
  ): Promise<{ action: string; attempts: number }>;
}
const appEnv = env as unknown as Env;
const room = (pid: string) => appEnv.PROJECT_ROOM.get(appEnv.PROJECT_ROOM.idFromName(pid)) as unknown as RoomRpc;

describe('phaseGateDecision', () => {
  it('passes → advance; fails under K → retry; at/over K → escalate', () => {
    expect(phaseGateDecision(0, true)).toBe('advance');
    expect(phaseGateDecision(1, false)).toBe('retry');
    expect(phaseGateDecision(2, false)).toBe('escalate'); // K=2 default
    expect(phaseGateDecision(1, false, 3)).toBe('retry'); // custom K
    expect(DEFAULT_MAX_VERIFY_ATTEMPTS).toBe(2);
  });
});

describe('recordPhaseVerify (phase gate)', () => {
  let pid: string;
  let phaseId: string;
  let taskId: string;
  let apiKey: string;

  beforeAll(async () => {
    const agent = await createAgent('pg-agent');
    apiKey = agent.apiKey;
    await loginSession('agent-mint@example.com', 'longenough1');
    pid = (await mcpCall(apiKey, 'create_project', { key: 'PG', name: 'pg' })).body.id;
    await mcpCall(apiKey, 'create_plan', { projectId: pid, title: 'Plan', phases: [{ title: 'P1', newTasks: [{ title: 'phase task' }] }] });
    const ph = await env.DB.prepare('SELECT id FROM phases WHERE plan_id IN (SELECT id FROM plans WHERE project_id = ?) LIMIT 1').bind(pid).first<{ id: string }>();
    phaseId = ph!.id;
    const t = await env.DB.prepare('SELECT task_id AS id FROM phase_tasks WHERE phase_id = ?').bind(phaseId).first<{ id: string }>();
    taskId = t!.id;
  }, 60000);

  const setReview = () => env.DB.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").bind(taskId).run();
  const taskStatus = async () => (await env.DB.prepare('SELECT status FROM tasks WHERE id = ?').bind(taskId).first<{ status: string }>())!.status;
  const resetGate = () => env.DB.prepare('DELETE FROM phase_gates WHERE phase_id = ?').bind(phaseId).run();

  it('verify PASS → advance: review tasks go done (unblocks the next phase)', async () => {
    await resetGate();
    await setReview();
    const r = await room(pid).recordPhaseVerify(pid, actor, phaseId, true);
    expect(r).toEqual({ action: 'advance', attempts: 0 });
    expect(await taskStatus()).toBe('done');
  });

  it('verify FAIL under K → retry: tasks bounce back to todo, attempts increment', async () => {
    await resetGate();
    await setReview();
    const r = await room(pid).recordPhaseVerify(pid, actor, phaseId, false);
    expect(r).toEqual({ action: 'retry', attempts: 1 });
    expect(await taskStatus()).toBe('todo'); // bounced for a fix
  });

  it('after K failed cycles → escalate: stops auto-retry, raises an alert', async () => {
    await resetGate();
    await setReview();
    const first = await room(pid).recordPhaseVerify(pid, actor, phaseId, false);
    expect(first.action).toBe('retry'); // attempt 1
    await setReview(); // a fix build put it back to review; it fails verify again
    const second = await room(pid).recordPhaseVerify(pid, actor, phaseId, false);
    expect(second).toEqual({ action: 'escalate', attempts: 2 });
    const alert = await env.DB.prepare("SELECT title FROM signals WHERE project_id = ? AND type = 'alert' AND status = 'open' ORDER BY created_at DESC LIMIT 1").bind(pid).first<{ title: string }>();
    expect(alert?.title).toMatch(/human review needed/);
  });
});
