// update_tasks promises "one failure does not stop the rest" — and that was quietly false for
// DO-level failures. A rejection that crosses blockConcurrencyWhile terminates the ProjectRoom
// instance, and the stub the bulk loop held replayed the FIRST task's error to every later task
// (found while testing PLNR-226: an unclaimed task's result echoed the claimed task's refusal,
// a message updateTask could not have produced for it). The loop now takes a fresh stub after a
// failure; this file pins that recovery with a failure UNRELATED to the claimed-status guard,
// so the fix is proven general rather than an artifact of one refusal.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { authorizeForAllProjects, createAgent, mcpCall } from './helpers';

describe('update_tasks survives a DO-level failure mid-list', () => {
  let orch: { id: string; apiKey: string };
  let projectId: string;
  let a: { id: string; key: string };
  let b: { id: string; key: string };

  beforeAll(async () => {
    orch = await createAgent('bulk-recovery-orch', 'orchestrator');
    const proj = await mcpCall(orch.apiKey, 'create_project', { key: 'PSN', name: 'bulk-recovery' });
    projectId = proj.body.id;
    await authorizeForAllProjects(orch.apiKey);
    a = (await mcpCall(orch.apiKey, 'create_task', { projectId, title: 'first — will refuse', tags: ['bulk-recovery'], allowNewTags: true })).body;
    b = (await mcpCall(orch.apiKey, 'create_task', { projectId, title: 'second — must still land', tags: ['bulk-recovery'] })).body;
  });

  it('a task after a DO throw still gets ITS OWN result, not a replay of the first error', async () => {
    // Re-parenting A under itself throws inside the DO (cycle guard); the same patch applied
    // to B is legal. Before the fix, B's result was A's error verbatim.
    const res = await mcpCall(orch.apiKey, 'update_tasks', {
      projectId, taskIds: [a.id, b.id], set: { parentTaskId: a.id },
    });
    expect(res.isError).toBeFalsy();
    const results = res.body.results as Array<{ taskId: string; ok: boolean; error?: string }>;
    const forA = results.find((r) => r.taskId === a.id)!;
    const forB = results.find((r) => r.taskId === b.id)!;
    expect(forA.ok).toBe(false);
    expect(forA.error).toMatch(/cycle/);
    expect(forB.ok).toBe(true);
    const row = await env.DB.prepare('SELECT parent_task_id AS p FROM tasks WHERE id = ?')
      .bind(b.id).first<{ p: string | null }>();
    expect(row!.p).toBe(a.id);
    expect(res.body.count).toBe(1);
    expect(res.body.failed).toBe(1);
  });
});
