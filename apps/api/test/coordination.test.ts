import { SELF } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall, mcpList, authorizeForAllProjects } from './helpers';

let orch: { id: string; apiKey: string };
let nova: { id: string; apiKey: string };
let echo: { id: string; apiKey: string };
let cookie: string;

beforeAll(async () => {
  orch = await createAgent('atlas', 'orchestrator');
  nova = await createAgent('nova');
  echo = await createAgent('echo');
  // The supervising human is an admin (like the instance owner) — sees every
  // project, incl. those the agents create (which are now owned by their user).
  await createUser('you@example.com', 'You', 'hunter2!', 'admin');
  cookie = await loginSession('you@example.com', 'hunter2!');
});

describe('auth', () => {
  it('rejects MCP calls without a key', async () => {
    const res = await SELF.fetch('https://planar.test/mcp', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('rejects bad session cookies on the UI API', async () => {
    const res = await SELF.fetch('https://planar.test/api/projects', { headers: { Cookie: 'planar_session=nope' } });
    expect(res.status).toBe(401);
  });

  it('exposes the coordination tools', async () => {
    const tools = await mcpList(orch.apiKey);
    const names = tools.map((t) => t.name);
    for (const required of ['get_briefing', 'my_updates', 'claim_task', 'release_task', 'heartbeat', 'next_claimable', 'resolve_comment', 'decompose_task']) {
      expect(names).toContain(required);
    }
  });
});

describe('coordination core', () => {
  let projectId: string;
  let t1: { id: string; key: string };
  let t2: { id: string; key: string };

  it('orchestrator creates a project and tasks with dependencies', async () => {
    const proj = await mcpCall(orch.apiKey, 'create_project', { key: 'TST', name: 'test-project' });
    expect(proj.body.key).toBe('TST');
    projectId = proj.body.id;
    // Scoping (RUN-38): these agents were minted before this project existed, so their tokens
    // are scoped to nothing and only the CREATOR gains it. A human would authorize the others —
    // say so, rather than let the old implicit "every token sees everything" creep back.
    await authorizeForAllProjects(orch.apiKey, nova.apiKey, echo.apiKey);

    t1 = (await mcpCall(orch.apiKey, 'create_task', { projectId, title: 'Build the base' })).body;
    expect(t1.key).toBe('TST-1');
    t2 = (await mcpCall(orch.apiKey, 'create_task', { projectId, title: 'Build on top', dependsOn: [t1.id] })).body;
    expect(t2.key).toBe('TST-2');
  });

  it('grants exactly one claim — the loser gets a clean error', async () => {
    const a = await mcpCall(nova.apiKey, 'claim_task', { projectId, taskId: t1.id });
    expect(a.body.key).toBe('TST-1');
    expect(a.body.ttlSeconds).toBeGreaterThan(0);

    const b = await mcpCall(echo.apiKey, 'claim_task', { projectId, taskId: t1.id });
    expect(b.isError).toBe(true);
    expect(b.text).toMatch(/already claimed|not claimable/);
  });

  it('dependency-gates claims', async () => {
    const blocked = await mcpCall(echo.apiKey, 'claim_task', { projectId, taskId: t2.id });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain('blocked');
  });

  it('next_claimable skips claimed and blocked tasks', async () => {
    const next = await mcpCall(echo.apiKey, 'next_claimable', { projectId });
    expect(next.body.task).toBeNull(); // t1 claimed, t2 dep-blocked
  });

  it('heartbeat renews the claim', async () => {
    const hb = await mcpCall(nova.apiKey, 'heartbeat', { projectId });
    expect(hb.body.renewed).toContain('TST-1');
  });

  it('human comments flow to the claiming agent as notices; done is gated on resolution', async () => {
    const post = await SELF.fetch(`https://planar.test/api/projects/${projectId}/tasks/${t1.id}/comments`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'question', body: 'Does this handle the crash case?' }),
    });
    expect(post.status).toBe(200);
    const { id: commentId } = (await post.json()) as { id: string };

    // The holder sees it in notices on the next tool call.
    const hb = await mcpCall(nova.apiKey, 'heartbeat', { projectId });
    expect(hb.notices).toContain('Does this handle the crash case?');

    // Finishing with an unresolved comment is refused.
    const refuse = await mcpCall(nova.apiKey, 'release_task', { projectId, taskId: t1.id, toStatus: 'done' });
    expect(refuse.isError).toBe(true);
    expect(refuse.text).toContain('unresolved comment');

    // Resolve with a reply, then done works.
    const resolve = await mcpCall(nova.apiKey, 'resolve_comment', {
      projectId, commentId, resolution: 'addressed', reply: 'Yes — TTL lapse requeues it.',
    });
    expect(resolve.body.ok).toBe(true);
    const done = await mcpCall(nova.apiKey, 'release_task', { projectId, taskId: t1.id, toStatus: 'done' });
    expect(done.body.status).toBe('done');
  });

  it('finishing the dependency unblocks the dependent task', async () => {
    const next = await mcpCall(echo.apiKey, 'next_claimable', { projectId });
    expect(next.body.task?.key).toBe('TST-2');
    const claim = await mcpCall(echo.apiKey, 'claim_task', { projectId, taskId: t2.id });
    expect(claim.body.key).toBe('TST-2');
    const rel = await mcpCall(echo.apiKey, 'release_task', { projectId, taskId: t2.id, toStatus: 'review' });
    expect(rel.body.status).toBe('review');
  });

  it('add_comment leaves a non-blocking note (agent can still finish)', async () => {
    const t = (await mcpCall(orch.apiKey, 'create_task', { projectId, title: 'note task' })).body;
    await mcpCall(nova.apiKey, 'claim_task', { projectId, taskId: t.id });
    const c = await mcpCall(nova.apiKey, 'add_comment', { projectId, taskId: t.id, body: 'note: found a gotcha in retry logic' });
    expect(c.isError).toBe(false);
    // The agent's own note doesn't count as an unresolved comment → done still works.
    const done = await mcpCall(nova.apiKey, 'release_task', { projectId, taskId: t.id, toStatus: 'done' });
    expect(done.isError).toBe(false);
    const gt = await mcpCall(orch.apiKey, 'get_task', { taskId: t.id });
    const note = gt.body.comments.find((x: { body: string }) => x.body.includes('gotcha'));
    expect(note.status).toBe('addressed');
    expect(note.authorKind).toBe('agent');
  });

  it('claim_task and release_task accept the display key, not just the opaque id', async () => {
    const t = (await mcpCall(orch.apiKey, 'create_task', { projectId, title: 'claim me by key' })).body;
    const claim = await mcpCall(nova.apiKey, 'claim_task', { projectId, taskId: t.key });
    expect(claim.isError).toBe(false);
    expect(claim.body.key).toBe(t.key);
    const rel = await mcpCall(nova.apiKey, 'release_task', { projectId, taskId: t.key, toStatus: 'done' });
    expect(rel.isError).toBe(false);
    expect(rel.body.status).toBe('done');
  });

  it('release_task can record closing thoughts in the same call', async () => {
    const t = (await mcpCall(orch.apiKey, 'create_task', { projectId, title: 'note on release' })).body;
    await mcpCall(nova.apiKey, 'claim_task', { projectId, taskId: t.id });
    const rel = await mcpCall(nova.apiKey, 'release_task', {
      projectId, taskId: t.id, toStatus: 'done', comment: 'shipped; watch the retry path under load',
    });
    expect(rel.isError).toBe(false);
    expect(rel.body.status).toBe('done');
    expect(rel.body.commentId).toBeTruthy();
    // The note is recorded as already-resolved (didn't block `done`, doesn't reopen).
    const detail = await mcpCall(orch.apiKey, 'get_task', { taskId: t.id });
    const note = detail.body.comments.find((c: { body: string }) => c.body.includes('watch the retry path'));
    expect(note.status).toBe('addressed');
  });

  it('decompose_task builds an ordered subtree', async () => {
    const parent = (await mcpCall(orch.apiKey, 'create_task', { projectId, title: 'Epic' })).body;
    const dec = await mcpCall(orch.apiKey, 'decompose_task', {
      projectId,
      parentTaskId: parent.id,
      subtasks: [
        { title: 'step one' },
        { title: 'step two', dependsOnIndex: [0] },
      ],
    });
    expect(dec.body.created).toHaveLength(2);
    const blocked = await mcpCall(nova.apiKey, 'claim_task', { projectId, taskId: dec.body.created[1].id });
    expect(blocked.isError).toBe(true);
  });

  it('messages reach the recipient via my_updates', async () => {
    await mcpCall(echo.apiKey, 'send_message', { projectId, toAgentId: nova.id, body: 'ping from echo' });
    const updates = await mcpCall(nova.apiKey, 'my_updates', {});
    expect(JSON.stringify(updates.body)).toContain('ping from echo');
  });

  it('briefing orients an agent', async () => {
    const b = await mcpCall(nova.apiKey, 'get_briefing', {});
    expect(b.body.you.name).toBe('nova');
    expect(b.body.playbook.length).toBeGreaterThan(2);
    expect(Array.isArray(b.body.state.claimable)).toBe(true);
  });

  it('serves the agent skill', async () => {
    const res = await SELF.fetch('https://planar.test/skill.md');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('get_briefing');
  });

  it('UI snapshot reflects everything live', async () => {
    const res = await SELF.fetch(`https://planar.test/api/projects/${projectId}/snapshot`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const snap = (await res.json()) as any;
    expect(snap.tasks.length).toBeGreaterThanOrEqual(5);
    expect(snap.events.length).toBeGreaterThan(5);
    expect(snap.events[0].seq).toBeGreaterThan(snap.events[1].seq);
  });
});

// ---- PLNR-119: priority is visible and estimate actually plumbed -----------------
describe('priority + estimate end-to-end', () => {
  it('estimate survives create → update → get_task → snapshot, and null clears it', async () => {
    const proj = await mcpCall(orch.apiKey, 'create_project', { key: 'EST', name: 'estimates' });
    const pid = proj.body.id;
    const t = (await mcpCall(orch.apiKey, 'create_task', { projectId: pid, title: 'sized work', priority: 4, estimate: 5 })).body;

    let got = await mcpCall(orch.apiKey, 'get_task', { taskId: t.id });
    expect(got.body.task.priority).toBe(4);
    expect(got.body.task.estimate).toBe(5);

    await mcpCall(orch.apiKey, 'update_task', { projectId: pid, taskId: t.id, estimate: 8 });
    got = await mcpCall(orch.apiKey, 'get_task', { taskId: t.id });
    expect(got.body.task.estimate).toBe(8);

    // The snapshot is what the board renders — both fields must reach it.
    const snap = (await (await SELF.fetch(`https://planar.test/api/projects/${pid}/snapshot`, {
      headers: { Cookie: cookie },
    })).json()) as { tasks: Array<{ id: string; priority: number; estimate: number | null }> };
    const row = snap.tasks.find((x) => x.id === t.id)!;
    expect(row.priority).toBe(4);
    expect(row.estimate).toBe(8);

    // Explicit null clears; omitting leaves it alone.
    await mcpCall(orch.apiKey, 'update_task', { projectId: pid, taskId: t.id, estimate: null });
    got = await mcpCall(orch.apiKey, 'get_task', { taskId: t.id });
    expect(got.body.task.estimate).toBeNull();
  });
});
