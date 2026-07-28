// spin_off_task (PLNR-230, server half of RUN-188): a run agent files adjacent work as its
// own task in a PROPOSED, ungated state. The product must be inert to every agent path
// (claim_task, next_claimable, the claimable feed, handoff, the dispatch pump) until a human
// accepts it — and the provenance (run id, source task, finding) must be durable and
// queryable, because the runner's adjudicator verifies "out of scope, tracked THERE"
// pointers against it mechanically.
import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { authorizeForAllProjects, createAgent, createRunAgent, loginSession, mcpCall } from './helpers';

const db = () => (env as unknown as { DB: D1Database }).DB;

describe('spin_off_task (PLNR-230)', () => {
  let copilot: { id: string; apiKey: string };
  let build: { agentId: string; apiKey: string; runId: string };
  let projectId: string;
  let anchorTaskId: string;
  let cookie: string;

  beforeAll(async () => {
    copilot = await createAgent('spinoff-copilot', 'orchestrator');
    const proj = await mcpCall(copilot.apiKey, 'create_project', { key: 'SPN', name: 'spinoff-proj' });
    projectId = proj.body.id;
    await authorizeForAllProjects(copilot.apiKey);
    // The task the run is anchored to — the spin-off's provenance must point back at it.
    const anchor = await mcpCall(copilot.apiKey, 'create_task', {
      projectId, title: 'the run agent works this', tags: ['spinoff-anchor'], allowNewTags: true,
    });
    expect(anchor.isError).toBeFalsy();
    anchorTaskId = anchor.body.id;
    build = await createRunAgent(projectId, 'build');
    // The fixture seeds an anchorless run; anchor it like the dispatch path would.
    await db().prepare("UPDATE runs SET anchor_type = 'task', anchor_id = ? WHERE id = ?")
      .bind(anchorTaskId, build.runId).run();
    // The human who owns the project (createAgent's shared mint user) — accept/reject are
    // dashboard (cookie-auth) actions.
    cookie = await loginSession('agent-mint@example.com', 'longenough1');
  });

  const fileSpinoff = async (title: string) => {
    const res = await mcpCall(build.apiKey, 'spin_off_task', {
      projectId, title,
      body: 'seen while working the anchor — deserves its own task',
      finding: 'refresh tokens are logged in cleartext in oauth.ts — real, but not my task',
      tags: ['spinoff-oauth'], allowNewTags: true,
      priority: 4, // outranks everything, so the claimable surfaces would offer it if ungated
    });
    expect(res.isError).toBeFalsy();
    return res.body as { id: string; key: string; status?: string };
  };

  it('files a PROPOSED task with derived provenance, surfaced by get_task', async () => {
    const made = await fileSpinoff('adjacent: stop logging refresh tokens');
    expect(made.status).toBe('proposed');

    const detail = await mcpCall(build.apiKey, 'get_task', { taskId: made.id });
    const task = detail.body.task;
    expect(task.status).toBe('proposed');
    expect(task.proposedAt).toBeTruthy();
    // Provenance is derived from the live run, never caller-claimed.
    expect(task.spinoff.runId).toBe(build.runId);
    expect(task.spinoff.sourceTaskId).toBe(anchorTaskId);
    expect(task.spinoff.sourceTaskKey).toBe('SPN-1');
    expect(task.spinoff.finding).toContain('refresh tokens are logged');
  });

  it('is inert to every agent path: next_claimable, the claimable feed, claim, handoff', async () => {
    const made = await fileSpinoff('inert to agents');

    // next_claimable must not offer it, even at P4 (top priority in the project).
    const next = await mcpCall(copilot.apiKey, 'next_claimable', { projectId });
    expect(next.body.task?.id).not.toBe(made.id);

    // The claimable feed (my_updates / notices) must not list it either.
    const updates = await mcpCall(copilot.apiKey, 'my_updates', {});
    expect((updates.body.claimable as Array<{ id: string }>).map((t) => t.id)).not.toContain(made.id);

    // The read-only probe says why…
    const probe = await mcpCall(copilot.apiKey, 'can_claim', { taskId: made.id });
    expect(probe.body.claimable).toBe(false);
    expect(probe.body.reason).toContain('spin-off');

    // …and the mutating arbiter refuses (defense in depth).
    const claim = await mcpCall(copilot.apiKey, 'claim_task', { projectId, taskId: made.id });
    expect(claim.isError).toBe(true);
    expect(claim.text).toContain('proposed spin-off');

    // A handoff is a claim by another door — refused too.
    const handoff = await mcpCall(copilot.apiKey, 'handoff_task', {
      projectId, taskId: made.id, toAgentId: build.agentId,
    });
    expect(handoff.isError).toBe(true);
    expect(handoff.text).toContain('proposed spin-off');
  });

  it('accept → a plain claimable todo; provenance survives', async () => {
    const made = await fileSpinoff('accepted spin-off');
    const res = await SELF.fetch(
      `https://noriq.test/api/projects/${projectId}/tasks/${made.id}/spinoff/accept`,
      { method: 'POST', headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('todo');

    const probe = await mcpCall(copilot.apiKey, 'can_claim', { taskId: made.id });
    expect(probe.body.claimable).toBe(true);

    const detail = await mcpCall(copilot.apiKey, 'get_task', { taskId: made.id });
    expect(detail.body.task.status).toBe('todo');
    expect(detail.body.task.proposedAt).toBeNull();
    // The durable record the adjudicator checks — untouched by the decision.
    expect(detail.body.task.spinoff.runId).toBe(build.runId);
    expect(detail.body.task.spinoff.finding).toContain('refresh tokens');

    // Accepted means genuinely claimable now.
    const claim = await mcpCall(copilot.apiKey, 'claim_task', { projectId, taskId: made.id });
    expect(claim.isError).toBeFalsy();
    await mcpCall(copilot.apiKey, 'release_task', { projectId, taskId: made.id, toStatus: 'done' });
  });

  it('reject → cancelled; provenance survives; still unclaimable', async () => {
    const made = await fileSpinoff('rejected spin-off');
    const res = await SELF.fetch(
      `https://noriq.test/api/projects/${projectId}/tasks/${made.id}/spinoff/reject`,
      { method: 'POST', headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('cancelled');

    const detail = await mcpCall(copilot.apiKey, 'get_task', { taskId: made.id });
    expect(detail.body.task.status).toBe('cancelled');
    expect(detail.body.task.spinoff.runId).toBe(build.runId);

    const claim = await mcpCall(copilot.apiKey, 'claim_task', { projectId, taskId: made.id });
    expect(claim.isError).toBe(true);
  });

  it('accept/reject refuse a task that is not a proposed spin-off', async () => {
    const plain = await mcpCall(copilot.apiKey, 'create_task', {
      projectId, title: 'not a spin-off', tags: ['spinoff-anchor'],
    });
    const res = await SELF.fetch(
      `https://noriq.test/api/projects/${projectId}/tasks/${plain.body.id}/spinoff/accept`,
      { method: 'POST', headers: { Cookie: cookie } },
    );
    expect(res.status).not.toBe(200);
  });

  it('the run view carries the spin-off count, decisions included (the volume guard)', async () => {
    const runs = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/runs`, {
      headers: { Cookie: cookie },
    });
    expect(runs.status).toBe(200);
    const { runs: list } = (await runs.json()) as { runs: Array<{ id: string; spinoffs: number }> };
    const mine = list.find((r) => r.id === build.runId)!;
    // Every spin-off this suite filed so far counts — accepted and rejected ones included.
    expect(mine.spinoffs).toBeGreaterThanOrEqual(4);
  });

  it('requires descriptive tags, like every create', async () => {
    const res = await mcpCall(build.apiKey, 'spin_off_task', {
      projectId, title: 'untagged', finding: 'something real',
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('tags are required');
  });

  it('refuses an agent with no live run in the project (copilots file ordinary work)', async () => {
    const res = await mcpCall(copilot.apiKey, 'spin_off_task', {
      projectId, title: 'copilot spin-off', finding: 'x', tags: ['spinoff-oauth'],
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('create_task');
  });

  it('search_tasks speaks the derived status: proposed is findable, todo does not sweep it in', async () => {
    const made = await fileSpinoff('findable by status filter');
    const proposed = await mcpCall(copilot.apiKey, 'search_tasks', { projectId, status: 'proposed' });
    expect((proposed.body.tasks as Array<{ id: string }>).map((t) => t.id)).toContain(made.id);
    const todo = await mcpCall(copilot.apiKey, 'search_tasks', { projectId, status: 'todo' });
    expect((todo.body.tasks as Array<{ id: string }>).map((t) => t.id)).not.toContain(made.id);
  });

  it('the board snapshot renders it as proposed with the provenance fields', async () => {
    const made = await fileSpinoff('visible on the board');
    const snap = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/snapshot`, {
      headers: { Cookie: cookie },
    });
    expect(snap.status).toBe(200);
    const { tasks } = (await snap.json()) as {
      tasks: Array<{ id: string; status: string; proposedAt: string | null; spinoffRunId: string | null; spinoffFinding: string | null }>;
    };
    const t = tasks.find((x) => x.id === made.id)!;
    expect(t.status).toBe('proposed');
    expect(t.proposedAt).toBeTruthy();
    expect(t.spinoffRunId).toBe(build.runId);
    expect(t.spinoffFinding).toContain('refresh tokens');
  });
});
