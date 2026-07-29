// PLNR-226: a claimed task's status is closed to MCP callers — ALL of them, copilots included.
//
// PLNR-192 closed the status door for run agents (their run's outcome owns the move) and left
// copilots the supervisor-style override. This narrows that carve-out: while a task is CLAIMED,
// no agent actor restatuses it through update_task/update_tasks — the claim protects the
// holder's in-flight work, and release_task/handoff_task cover every legitimate holder move.
// Unclaimed tasks keep the copilot override, and the human REST path keeps it unconditionally
// (supervisor override IS that path's point, claim-clearing on done/cancelled/todo included).
//
// Enforced in ProjectRoom.updateTask, before ANY of the patch is applied — so the bulk tool is
// covered by the same guard (per-task results, one refusal does not stop the rest), and a
// combined {tags, status} patch writes nothing rather than landing the tags and then refusing.
import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  authorizeForAllProjects,
  createAgent,
  createRunAgent,
  createUser,
  loginSession,
  mcpCall,
} from './helpers';

describe('status on a claimed task, via MCP (PLNR-226)', () => {
  let orch: { id: string; apiKey: string }; // copilot, NOT the holder
  let holder: { id: string; apiKey: string }; // copilot holding the claim
  let cookie: string;
  let projectId: string;
  let claimed: { id: string; key: string };
  let unclaimed: { id: string; key: string };

  const taskRow = async (id: string) =>
    (await env.DB.prepare('SELECT status, claimed_by AS claimedBy, priority FROM tasks WHERE id = ?')
      .bind(id).first<{ status: string; claimedBy: string | null; priority: number }>())!;

  /** Live claim rows — a refusal that reports an error but releases the claim anyway would
   *  pass a status-only assertion, so the claim's survival is checked in its own right. */
  const liveClaims = async (id: string) =>
    (await env.DB.prepare('SELECT COUNT(*) AS n FROM claims WHERE task_id = ? AND released_at IS NULL')
      .bind(id).first<{ n: number }>())!.n;

  beforeAll(async () => {
    orch = await createAgent('claimed-status-orch', 'orchestrator');
    holder = await createAgent('claimed-status-holder');
    cookie = await loginSession('supervisor@example.com', 'longenough1').catch(async () => {
      await createUser('supervisor@example.com', 'Supervisor', 'longenough1', 'admin');
      return loginSession('supervisor@example.com', 'longenough1');
    });
    const proj = await mcpCall(orch.apiKey, 'create_project', { key: 'CSG', name: 'claimed-status-guard' });
    projectId = proj.body.id;
    await authorizeForAllProjects(orch.apiKey, holder.apiKey);
    claimed = (await mcpCall(orch.apiKey, 'create_task', {
      projectId, title: 'work in flight', tags: ['claim-guard'], allowNewTags: true,
    })).body;
    unclaimed = (await mcpCall(orch.apiKey, 'create_task', {
      projectId, title: 'nobody is on this', tags: ['claim-guard'],
    })).body;
    // A REAL claim (status in_progress, claim_expires_at set) rather than a hand-written row,
    // so the guard's definition of "claimed" is exercised honestly.
    const c = await mcpCall(holder.apiKey, 'claim_task', { projectId, taskId: claimed.id });
    expect(c.isError).toBeFalsy();
  });

  it('refuses a non-holder copilot, and neither the status nor the claim moves', async () => {
    const res = await mcpCall(orch.apiKey, 'update_task', { projectId, taskId: claimed.id, status: 'done' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/is claimed by another agent/);
    const row = await taskRow(claimed.id);
    expect(row.status).toBe('in_progress');
    expect(row.claimedBy).toBe(holder.id);
    expect(await liveClaims(claimed.id)).toBe(1);
  });

  it('refuses the HOLDER too, steering it to release_task', async () => {
    const res = await mcpCall(holder.apiKey, 'update_task', { projectId, taskId: claimed.id, status: 'review' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/release_task/);
    expect((await taskRow(claimed.id)).status).toBe('in_progress');
  });

  it('a combined patch writes NOTHING — the refusal precedes the tag and field writes', async () => {
    const before = await taskRow(claimed.id);
    const res = await mcpCall(orch.apiKey, 'update_task', {
      projectId, taskId: claimed.id, status: 'done', priority: 4, addTags: ['decoy-area'], allowNewTags: true,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/is claimed/);
    const after = await taskRow(claimed.id);
    expect(after.status).toBe(before.status);
    expect(after.priority).toBe(before.priority);
    // The tag block sits ABOVE the status handling in updateTask and returns early — the exact
    // reason the guard lives at the top. One tag row: the one create_task minted.
    const tags = await env.DB.prepare('SELECT COUNT(*) AS n FROM task_tags WHERE task_id = ?')
      .bind(claimed.id).first<{ n: number }>();
    expect(tags!.n).toBe(1);
  });

  it('leaves the rest of update_task open on a claimed task — only status is closed', async () => {
    const ok = await mcpCall(orch.apiKey, 'update_task', { projectId, taskId: claimed.id, priority: 1 });
    expect(ok.isError).toBeFalsy();
    expect((await taskRow(claimed.id)).priority).toBe(1);
  });

  it('update_tasks refuses per task: the claimed task stands, the unclaimed one moves', async () => {
    const res = await mcpCall(orch.apiKey, 'update_tasks', {
      projectId, taskIds: [claimed.id, unclaimed.id], set: { status: 'blocked' },
    });
    expect(res.isError).toBeFalsy();
    const results = res.body.results as Array<{ taskId: string; ok: boolean; error?: string }>;
    const forClaimed = results.find((r) => r.taskId === claimed.id)!;
    const forUnclaimed = results.find((r) => r.taskId === unclaimed.id)!;
    expect(forClaimed.ok).toBe(false);
    expect(forClaimed.error).toMatch(/is claimed/);
    expect(forUnclaimed.ok).toBe(true);
    expect((await taskRow(claimed.id)).status).toBe('in_progress');
    expect((await taskRow(unclaimed.id)).status).toBe('blocked');
  });

  it('a copilot still restatuses an UNCLAIMED task — the PLNR-192 override survives there', async () => {
    const res = await mcpCall(orch.apiKey, 'update_task', { projectId, taskId: unclaimed.id, status: 'todo' });
    expect(res.isError).toBeFalsy();
    expect((await taskRow(unclaimed.id)).status).toBe('todo');
  });

  it("a run agent still gets the PLNR-192 refusal FIRST — the tool-layer guard outranks this one", async () => {
    const runner = await createRunAgent(projectId, 'build', {});
    const res = await mcpCall(runner.apiKey, 'update_task', { projectId, taskId: claimed.id, status: 'review' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/run agents don't set task status/);
    expect(res.text).not.toMatch(/is claimed/);
    expect((await taskRow(claimed.id)).status).toBe('in_progress');
  });

  // LAST: this one settles the fixture's claim. The human path is the override by design —
  // restatusing a claimed task works AND clears the claim on done/cancelled/todo.
  it('a human REST PATCH keeps the supervisor override, claim-clearing included', async () => {
    const res = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/tasks/${claimed.id}`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    expect(res.status).toBe(200);
    const row = await taskRow(claimed.id);
    expect(row.status).toBe('done');
    expect(row.claimedBy).toBeNull();
    expect(await liveClaims(claimed.id)).toBe(0);
  });
});
