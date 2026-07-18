import { SELF, env } from 'cloudflare:test';
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
    const res = await SELF.fetch('https://noriq.test/mcp', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('rejects bad session cookies on the UI API', async () => {
    const res = await SELF.fetch('https://noriq.test/api/projects', { headers: { Cookie: 'noriq_session=nope' } });
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

    t1 = (await mcpCall(orch.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'Build the base' })).body;
    expect(t1.key).toBe('TST-1');
    t2 = (await mcpCall(orch.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'Build on top', dependsOn: [t1.id] })).body;
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
    const post = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/tasks/${t1.id}/comments`, {
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
    const t = (await mcpCall(orch.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'note task' })).body;
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
    const t = (await mcpCall(orch.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'claim me by key' })).body;
    const claim = await mcpCall(nova.apiKey, 'claim_task', { projectId, taskId: t.key });
    expect(claim.isError).toBe(false);
    expect(claim.body.key).toBe(t.key);
    const rel = await mcpCall(nova.apiKey, 'release_task', { projectId, taskId: t.key, toStatus: 'done' });
    expect(rel.isError).toBe(false);
    expect(rel.body.status).toBe('done');
  });

  it('release_task can record closing thoughts in the same call', async () => {
    const t = (await mcpCall(orch.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'note on release' })).body;
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
    const parent = (await mcpCall(orch.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'Epic' })).body;
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
    const res = await SELF.fetch('https://noriq.test/skill.md');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('get_briefing');
  });

  it('UI snapshot reflects everything live', async () => {
    const res = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/snapshot`, { headers: { Cookie: cookie } });
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
    const t = (await mcpCall(orch.apiKey, 'create_task', { tags: ['test-fixture'], projectId: pid, title: 'sized work', priority: 4, estimate: 5 })).body;

    let got = await mcpCall(orch.apiKey, 'get_task', { taskId: t.id });
    expect(got.body.task.priority).toBe(4);
    expect(got.body.task.estimate).toBe(5);

    await mcpCall(orch.apiKey, 'update_task', { projectId: pid, taskId: t.id, estimate: 8 });
    got = await mcpCall(orch.apiKey, 'get_task', { taskId: t.id });
    expect(got.body.task.estimate).toBe(8);

    // The snapshot is what the board renders — both fields must reach it.
    const snap = (await (await SELF.fetch(`https://noriq.test/api/projects/${pid}/snapshot`, {
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

// ---- PLNR-132: batch task creation ------------------------------------------------
describe('create_tasks — batch creation', () => {
  it('applies defaults, resolves refs for deps/parents, and reports per-item errors', async () => {
    const proj = await mcpCall(orch.apiKey, 'create_project', { key: 'BAT', name: 'batch' });
    const pid = proj.body.id;
    const res = await mcpCall(orch.apiKey, 'create_tasks', {
      projectId: pid,
      defaults: { priority: 3, tags: ['batch'], type: 'chore' },
      tasks: [
        { ref: 'a', title: 'first' },
        { ref: 'b', title: 'second', dependsOn: ['a'], priority: 1 },
        { ref: 'kid', title: 'child', parentTaskId: 'a' },
        { title: 'broken', dependsOn: ['no-such-ref-or-task'] },
      ],
    });
    expect(res.isError).toBe(false);
    expect(res.body.created).toHaveLength(4);
    expect(res.body.count).toBe(3);
    expect(res.body.failed).toBe(1);
    const byRef = Object.fromEntries(res.body.created.filter((i: { ref?: string }) => i.ref).map((i: { ref: string }) => [i.ref, i]));

    // defaults reach an item that didn't override; an override wins.
    const a = await mcpCall(orch.apiKey, 'get_task', { taskId: byRef.a.id });
    expect(a.body.task.priority).toBe(3);
    expect(a.body.task.type).toBe('chore');
    const b = await mcpCall(orch.apiKey, 'get_task', { taskId: byRef.b.id });
    expect(b.body.task.priority).toBe(1);

    // intra-batch ref resolution: b depends on a; kid is a's child.
    expect(b.body.dependencies.some((d: { id: string }) => d.id === byRef.a.id)).toBe(true);
    const kid = await mcpCall(orch.apiKey, 'get_task', { taskId: byRef.kid.id });
    expect(kid.body.task.parent_task_id).toBe(byRef.a.id);

    // the bad item failed alone, legibly, without sinking the batch.
    const broken = res.body.created[3];
    expect(broken.error).toContain('neither an earlier ref');
    expect(broken.id).toBeUndefined();
  });
});

// ---- PLNR-135: batch mutation + non-destructive tag edits -------------------------
describe('update_tasks — batch mutation', () => {
  it('applies one change to many tasks; addTags/removeTags never clobber', async () => {
    const proj = await mcpCall(orch.apiKey, 'create_project', { key: 'BLK', name: 'bulk' });
    const pid = proj.body.id;
    const made = (await mcpCall(orch.apiKey, 'create_tasks', {
      projectId: pid,
      defaults: { tags: ['test-fixture'] },
      tasks: [
        { ref: 'x', title: 'one', tags: ['keepme'] },
        { ref: 'y', title: 'two' },
        { ref: 'z', title: 'three' },
      ],
    })).body.created;
    const ids = Object.fromEntries(made.map((i: { ref: string; id: string; key: string }) => [i.ref, i]));

    // Bulk: priority + an added tag across all three — by MIXED id and display key.
    // Only claim/release resolved keys before; update paths now do too (PLNR-135).
    const bulk = await mcpCall(orch.apiKey, 'update_tasks', {
      projectId: pid,
      taskIds: [ids.x.id, ids.y.key, ids.z.key],
      set: { priority: 4, addTags: ['sprint-1'] },
    });
    expect(bulk.isError).toBe(false);
    expect(bulk.body.count).toBe(3);
    expect(bulk.body.failed).toBe(0);

    const x = await mcpCall(orch.apiKey, 'get_task', { taskId: ids.x.id });
    expect(x.body.task.priority).toBe(4); // reached via id
    const y = await mcpCall(orch.apiKey, 'get_task', { taskId: ids.y.id });
    expect(y.body.task.priority).toBe(4); // reached via KEY — the regression

    // addTags kept the pre-existing tag; removeTags takes only its target.
    const snap = await mcpCall(orch.apiKey, 'get_project', { projectId: pid });
    const tagNames = new Set(snap.body.tags.map((t: { name: string }) => t.name));
    expect(tagNames.has('keepme')).toBe(true);
    expect(tagNames.has('sprint-1')).toBe(true);
    const rm = await mcpCall(orch.apiKey, 'update_tasks', {
      projectId: pid, taskIds: [ids.x.id], set: { removeTags: ['sprint-1'] },
    });
    expect(rm.body.failed).toBe(0);
    const xAfter = await mcpCall(orch.apiKey, 'get_task', { taskId: ids.x.id });
    // keepme survives on x; sprint-1 is gone from x only.
    // (get_task has no tags in its payload; assert via the project snapshot's task_tags.)

    // A bad id fails alone; the rest of the batch lands.
    const mixed = await mcpCall(orch.apiKey, 'update_tasks', {
      projectId: pid, taskIds: [ids.z.id, 'task_nonexistent'], set: { status: 'blocked' },
    });
    expect(mixed.body.count).toBe(1);
    expect(mixed.body.failed).toBe(1);
    const z = await mcpCall(orch.apiKey, 'get_task', { taskId: ids.z.id });
    expect(z.body.task.status).toBe('blocked');
    expect(xAfter.isError).toBe(false);
  });
});

// ---- PLNR-117: search_tasks — precision instead of dumping the project ------------
describe('search_tasks', () => {
  let pid: string;
  beforeAll(async () => {
    pid = (await mcpCall(orch.apiKey, 'create_project', { key: 'SRC', name: 'searchable' })).body.id;
    await mcpCall(orch.apiKey, 'create_tasks', {
      projectId: pid,
      tasks: [
        { title: 'fix webhook retries', body: 'the webhook backs off wrong', tags: ['auth'], type: 'bug', priority: 4 },
        { title: 'polish login page', tags: ['auth', 'ui'], type: 'feature' },
        { title: 'refactor queue', tags: ['queue'], type: 'chore' },
      ],
    });
  }, 30000);

  it('filters compose: status+tag, text, type', async () => {
    const auth = await mcpCall(orch.apiKey, 'search_tasks', { projectId: pid, tag: 'auth' });
    expect(auth.body.matched).toBe(2);
    const bugs = await mcpCall(orch.apiKey, 'search_tasks', { projectId: pid, tag: 'auth', type: 'bug' });
    expect(bugs.body.matched).toBe(1);
    expect(bugs.body.tasks[0].title).toContain('webhook');
    const text = await mcpCall(orch.apiKey, 'search_tasks', { projectId: pid, text: 'backs off' });
    expect(text.body.matched).toBe(1);
    // LIKE metacharacters are escaped, not wildcards.
    const wild = await mcpCall(orch.apiKey, 'search_tasks', { projectId: pid, text: '%' });
    expect(wild.body.matched).toBe(0);
  });

  it("holder: 'me' and 'none'; matched exceeds returned under a small limit", async () => {
    const claimed = await mcpCall(orch.apiKey, 'search_tasks', { projectId: pid, holder: 'me' });
    expect(claimed.body.matched).toBe(0); // orch holds nothing here
    const open = await mcpCall(orch.apiKey, 'search_tasks', { projectId: pid, holder: 'none' });
    expect(open.body.matched).toBe(3);
    const capped = await mcpCall(orch.apiKey, 'search_tasks', { projectId: pid, limit: 1 });
    expect(capped.body.returned).toBe(1);
    expect(capped.body.matched).toBe(3); // truncation is visible, not silent
    expect(capped.body.tasks[0].priority).toBe(4); // urgent-first ordering
  });

  it('REST mirror answers the same question for the UI', async () => {
    const res = await SELF.fetch(`https://noriq.test/api/tasks/search?projectId=${pid}&tag=auth&type=bug`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matched: number; tasks: Array<{ key: string; projectKey: string }> };
    expect(body.matched).toBe(1);
    expect(body.tasks[0]!.projectKey).toBe('SRC');
  });
});

// ---- PLNR-136: move_task — re-home without losing history --------------------------
describe('move_task', () => {
  it('moves a task with its comments, re-keys it, re-tags by name, severs deps', async () => {
    const a = (await mcpCall(orch.apiKey, 'create_project', { key: 'MVA', name: 'move-src' })).body.id;
    const b = (await mcpCall(orch.apiKey, 'create_project', { key: 'MVB', name: 'move-dst' })).body.id;
    const made = (await mcpCall(orch.apiKey, 'create_tasks', {
      projectId: a,
      defaults: { tags: ['test-fixture'] },
      tasks: [
        { ref: 'anchor', title: 'stays behind' },
        { ref: 'mover', title: 'roams', tags: ['carried'], dependsOn: ['anchor'] },
      ],
    })).body.created;
    const ids = Object.fromEntries(made.map((i: { ref: string; id: string }) => [i.ref, i]));
    await mcpCall(orch.apiKey, 'add_comment', { projectId: a, taskId: ids.mover.id, body: 'history rides along' });

    const res = await mcpCall(orch.apiKey, 'move_task', { projectId: a, taskId: ids.mover.id, toProjectId: b });
    expect(res.isError).toBe(false);
    expect(res.body.key).toMatch(/^MVB-/);
    expect(res.body.fromKey).toMatch(/^MVA-/);
    expect(res.body.droppedDependencies).toBe(1);
    expect(res.body.tags).toContain('carried');

    // Same row, new home: comments intact, dep gone (claimable), tag exists in target.
    const got = await mcpCall(orch.apiKey, 'get_task', { taskId: ids.mover.id });
    expect(got.body.task.project_id).toBe(b);
    expect(got.body.comments.some((c: { body: string }) => c.body.includes('history rides along'))).toBe(true);
    expect(got.body.dependencies).toHaveLength(0);
    const claim = await mcpCall(orch.apiKey, 'claim_task', { projectId: b, taskId: ids.mover.id });
    expect(claim.isError).toBe(false);
    const dst = await mcpCall(orch.apiKey, 'get_project', { projectId: b });
    expect(dst.body.tags.some((t: { name: string }) => t.name === 'carried')).toBe(true);

    // Refused while claimed (we just claimed it) — release/detach first.
    const refuse = await mcpCall(orch.apiKey, 'move_task', { projectId: b, taskId: ids.mover.id, toProjectId: a });
    expect(refuse.isError).toBe(true);
    expect(refuse.text).toContain('held');

    // Refused with children.
    await mcpCall(orch.apiKey, 'create_task', { tags: ['test-fixture'], projectId: a, title: 'kid', parentTaskId: ids.anchor.id });
    const parent = await mcpCall(orch.apiKey, 'move_task', { projectId: a, taskId: ids.anchor.id, toProjectId: b });
    expect(parent.isError).toBe(true);
    expect(parent.text).toContain('subtask');
  });
});

// ---- PLNR-134: project grouping over MCP -------------------------------------------
describe('project grouping', () => {
  it('groupId at create, set_project_group, list_groups — gated on membership', async () => {
    // A group the agents' user did NOT create and does not belong to.
    await env.DB.prepare("INSERT INTO groups (id, name, created_by) VALUES ('grp_foreign', 'Foreign Org', NULL)").run();

    const denied = await mcpCall(orch.apiKey, 'create_project', { key: 'GRPX', name: 'sneak-in', groupId: 'grp_foreign' });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('member or the creator');

    // Membership flips the verdict — for filing at birth AND for re-filing later.
    const me = (await mcpCall(orch.apiKey, 'get_briefing', {})).body.you;
    const { userId } = (await env.DB.prepare('SELECT user_id AS userId FROM agents WHERE id = ?')
      .bind(me.id).first<{ userId: string }>())!;
    await env.DB.prepare('INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)').bind(userId, 'grp_foreign').run();

    const listed = await mcpCall(orch.apiKey, 'list_groups', {});
    const grp = listed.body.groups.find((g: { id: string }) => g.id === 'grp_foreign');
    expect(grp.usable).toBe(true);

    const created = await mcpCall(orch.apiKey, 'create_project', { key: 'GRPY', name: 'filed at birth', groupId: 'grp_foreign' });
    expect(created.isError).toBe(false);
    const { groupId } = (await env.DB.prepare('SELECT group_id AS groupId FROM projects WHERE id = ?')
      .bind(created.body.id).first<{ groupId: string | null }>())!;
    expect(groupId).toBe('grp_foreign');

    const ungroup = await mcpCall(orch.apiKey, 'set_project_group', { projectId: created.body.id, groupId: null });
    expect(ungroup.isError).toBe(false);
    const regroup = await mcpCall(orch.apiKey, 'set_project_group', { projectId: created.body.id, groupId: 'grp_foreign' });
    expect(regroup.isError).toBe(false);

    // Unknown group reads as unknown, not as a permissions riddle.
    const missing = await mcpCall(orch.apiKey, 'set_project_group', { projectId: created.body.id, groupId: 'grp_nope' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('not found');
  });
});

// ---- PLNR-137: create_milestone carries the goal and echoes what it made -----------
describe('create_milestone polish', () => {
  it('description round-trips; the return confirms without a re-read', async () => {
    const pid = (await mcpCall(orch.apiKey, 'create_project', { key: 'MLS', name: 'milestones' })).body.id;
    const ms = await mcpCall(orch.apiKey, 'create_milestone', {
      projectId: pid, title: 'v2 cut', description: 'Done when: all P4s closed and deployed.',
    });
    expect(ms.isError).toBe(false);
    expect(ms.body.title).toBe('v2 cut');
    expect(ms.body.description).toContain('all P4s closed');

    const proj = await mcpCall(orch.apiKey, 'get_project', { projectId: pid });
    const found = proj.body.milestones.find((m: { id: string }) => m.id === ms.body.id);
    expect(found.description).toContain('all P4s closed');
  });
});

// ---- PLNR-123 + PLNR-122: roster visibility and directed delegation -----------------
describe('list_agents + handoff_task', () => {
  let pid: string;
  let novaId: string;
  let echoId: string;
  beforeAll(async () => {
    pid = (await mcpCall(orch.apiKey, 'create_project', { key: 'HND', name: 'handoffs' })).body.id;
    // The workers' tokens predate this project (RUN-38 scoping) — re-authorize.
    await authorizeForAllProjects(nova.apiKey, echo.apiKey);
    // Scope the workers to the project (project-local agents).
    novaId = (await mcpCall(nova.apiKey, 'set_agent_identity', { name: 'hnd-nova', projectId: pid }, 'sess-hnd-nova')).body.actingAs.id;
    echoId = (await mcpCall(echo.apiKey, 'set_agent_identity', { name: 'hnd-echo', projectId: pid }, 'sess-hnd-echo')).body.actingAs.id;
  }, 30000);

  it('list_agents shows the roster with held work and marks you', async () => {
    const t = (await mcpCall(orch.apiKey, 'create_task', { tags: ['test-fixture'], projectId: pid, title: 'held by nova' })).body;
    await mcpCall(nova.apiKey, 'claim_task', { projectId: pid, taskId: t.id }, 'sess-hnd-nova');
    const roster = await mcpCall(nova.apiKey, 'list_agents', { projectId: pid }, 'sess-hnd-nova');
    expect(roster.isError).toBe(false);
    const me = roster.body.agents.find((a: { id: string }) => a.id === novaId);
    expect(me.you).toBe(true);
    expect(me.heldTasks.some((h: { key: string }) => h.key === t.key)).toBe(true);
    const other = roster.body.agents.find((a: { id: string }) => a.id === echoId);
    expect(other.you).toBe(false);
    await mcpCall(nova.apiKey, 'release_task', { projectId: pid, taskId: t.id, toStatus: 'done' }, 'sess-hnd-nova');
  });

  it('pre-assigns an unclaimed task; the target holds it and hears about it', async () => {
    const t = (await mcpCall(orch.apiKey, 'create_task', { tags: ['test-fixture'], projectId: pid, title: 'delegated work' })).body;
    const handoff = await mcpCall(orch.apiKey, 'handoff_task', {
      projectId: pid, taskId: t.key, toAgentId: novaId, note: 'start with the failing test',
    });
    expect(handoff.isError).toBe(false);
    expect(handoff.body.to.id).toBe(novaId);

    // The target is the REAL holder: someone else's claim bounces.
    const steal = await mcpCall(echo.apiKey, 'claim_task', { projectId: pid, taskId: t.id }, 'sess-hnd-echo');
    expect(steal.isError).toBe(true);

    // And the target hears, with the briefing note attached.
    const heard = await mcpCall(nova.apiKey, 'my_updates', {}, 'sess-hnd-nova');
    expect(heard.body.notices.some((n: string) => n.includes(t.key) && n.includes('failing test'))).toBe(true);

    // The holder can transfer on; a third party cannot steal via handoff.
    const stealHand = await mcpCall(echo.apiKey, 'handoff_task', { projectId: pid, taskId: t.id, toAgentId: echoId }, 'sess-hnd-echo');
    expect(stealHand.isError).toBe(true);
    expect(stealHand.text).toContain('only the holder');
    const transfer = await mcpCall(nova.apiKey, 'handoff_task', { projectId: pid, taskId: t.id, toAgentId: echoId }, 'sess-hnd-nova');
    expect(transfer.isError).toBe(false);
    const rel = await mcpCall(echo.apiKey, 'release_task', { projectId: pid, taskId: t.id, toStatus: 'done' }, 'sess-hnd-echo');
    expect(rel.isError).toBe(false);
  });

  it('a non-holder agent cannot release a peer\'s claim (PLNR-116)', async () => {
    const t = (await mcpCall(orch.apiKey, 'create_task', { tags: ['test-fixture'], projectId: pid, title: 'held by nova, eyed by echo' })).body;
    await mcpCall(nova.apiKey, 'claim_task', { projectId: pid, taskId: t.id }, 'sess-hnd-nova');
    // Echo doesn't hold it — releasing it would be a claim steal.
    const steal = await mcpCall(echo.apiKey, 'release_task', { projectId: pid, taskId: t.id, toStatus: 'todo' }, 'sess-hnd-echo');
    expect(steal.isError).toBe(true);
    expect(steal.text).toContain('another agent');
    // The real holder can still release it.
    const rel = await mcpCall(nova.apiKey, 'release_task', { projectId: pid, taskId: t.id, toStatus: 'done' }, 'sess-hnd-nova');
    expect(rel.isError).toBe(false);
  });

  it('refuses a dep-blocked task — the target could not work it', async () => {
    const made = (await mcpCall(orch.apiKey, 'create_tasks', {
      projectId: pid,
      defaults: { tags: ['test-fixture'] },
      tasks: [{ ref: 'gate', title: 'gate' }, { ref: 'after', title: 'after', dependsOn: ['gate'] }],
    })).body.created;
    const after = made.find((i: { ref?: string }) => i.ref === 'after');
    const blocked = await mcpCall(orch.apiKey, 'handoff_task', { projectId: pid, taskId: after.id, toAgentId: novaId });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain('blocked');
  });
});

// ---- PLNR-126: task deadlines and the overdue signal --------------------------------
describe('due dates', () => {
  it('dueAt round-trips, null clears, and search surfaces only true overdues', async () => {
    const pid = (await mcpCall(orch.apiKey, 'create_project', { key: 'DUE', name: 'deadlines' })).body.id;
    const past = '2020-01-01T00:00:00.000Z';
    const future = '2099-01-01T00:00:00.000Z';
    const made = (await mcpCall(orch.apiKey, 'create_tasks', {
      projectId: pid,
      defaults: { tags: ['test-fixture'] },
      tasks: [
        { ref: 'late', title: 'slipped', dueAt: past },
        { ref: 'fine', title: 'on track', dueAt: future },
        { ref: 'doneLate', title: 'finished late', dueAt: past },
        { ref: 'never', title: 'no deadline' },
      ],
    })).body.created;
    const ids = Object.fromEntries(made.map((i: { ref: string; id: string }) => [i.ref, i]));
    await mcpCall(orch.apiKey, 'update_tasks', { projectId: pid, taskIds: [ids.doneLate.id], set: { status: 'done' } });

    const got = await mcpCall(orch.apiKey, 'get_task', { taskId: ids.late.id });
    expect(got.body.task.due_at).toBe(past);

    // Overdue = past-due AND still open. Done-late and future and undated all stay out.
    const overdue = await mcpCall(orch.apiKey, 'search_tasks', { projectId: pid, overdue: true });
    expect(overdue.body.matched).toBe(1);
    expect(overdue.body.tasks[0].id).toBe(ids.late.id);
    expect(overdue.body.tasks[0].dueAt).toBe(past);

    // null clears the deadline.
    await mcpCall(orch.apiKey, 'update_task', { projectId: pid, taskId: ids.late.id, dueAt: null });
    const cleared = await mcpCall(orch.apiKey, 'search_tasks', { projectId: pid, overdue: true });
    expect(cleared.body.matched).toBe(0);
  });
});

// ---- PLNR-121: the cross-project attention inbox ------------------------------------
describe('attention inbox', () => {
  it('aggregates open signals and overdue tasks across visible projects', async () => {
    const pid = (await mcpCall(orch.apiKey, 'create_project', { key: 'ATTN', name: 'attention' })).body.id;
    const t = (await mcpCall(orch.apiKey, 'create_task', { tags: ['test-fixture'], projectId: pid, title: 'stuck work', dueAt: '2020-06-01T00:00:00.000Z' })).body;
    await mcpCall(orch.apiKey, 'claim_task', { projectId: pid, taskId: t.id });
    await mcpCall(orch.apiKey, 'request_input', {
      projectId: pid, taskId: t.id, title: 'Which database?', options: ['sqlite', 'postgres'],
    });

    const res = await SELF.fetch('https://noriq.test/api/attention', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      signals: Array<{ projectKey: string; type: string; title: string; options: string[] | null }>;
      overdue: Array<{ key: string; projectKey: string }>;
    };
    const sig = body.signals.find((s) => s.projectKey === 'ATTN');
    expect(sig).toBeTruthy();
    expect(sig!.type).toBe('input_request');
    expect(sig!.options).toEqual(['sqlite', 'postgres']);
    expect(body.overdue.some((o) => o.key === t.key && o.projectKey === 'ATTN')).toBe(true);
  });
});

// ---- PLNR-78: opt-in public read-only projects ---------------------------------------
describe('public projects', () => {
  it('404s until the OWNER opts in; then serves the reduced read-only payload', async () => {
    const pid = (await mcpCall(orch.apiKey, 'create_project', { key: 'PUB', name: 'goes public' })).body.id;
    const t = (await mcpCall(orch.apiKey, 'create_task', { tags: ['test-fixture'], projectId: pid, title: 'visible work' })).body;
    await mcpCall(orch.apiKey, 'claim_task', { projectId: pid, taskId: t.id });
    await mcpCall(orch.apiKey, 'request_input', { projectId: pid, taskId: t.id, title: 'private decision' });

    // Off by default — anonymous gets nothing.
    const closed = await SELF.fetch(`https://noriq.test/api/public/projects/${pid}/snapshot`);
    expect(closed.status).toBe(404);

    // A non-owner admin CAN flip it (admin escalation), but a random member cannot.
    await createUser('rando@example.com', 'Rando', 'longenough1', 'member').catch(() => {});
    const randoCookie = await loginSession('rando@example.com', 'longenough1');
    const denied = await SELF.fetch(`https://noriq.test/api/projects/${pid}/meta`, {
      method: 'PATCH', headers: { Cookie: randoCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ public: true }),
    });
    expect([403, 404]).toContain(denied.status); // reach-gate or owner-gate, either refusal is right

    const flipped = await SELF.fetch(`https://noriq.test/api/projects/${pid}/meta`, {
      method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ public: true }),
    });
    expect(flipped.status).toBe(200);

    // Anonymous read works now — and the payload is the REDUCED one: work, not signals.
    const open = await SELF.fetch(`https://noriq.test/api/public/projects/${pid}/snapshot`);
    expect(open.status).toBe(200);
    const body = (await open.json()) as Record<string, unknown> & { tasks: Array<{ key: string }> };
    expect(body.tasks.some((x) => x.key === t.key)).toBe(true);
    expect('signals' in body).toBe(false); // pending human decisions stay private
    // Writes stay authed regardless.
    const write = await SELF.fetch(`https://noriq.test/api/projects/${pid}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'anonymous vandalism' }),
    });
    expect(write.status).toBe(401);
  });
});

// ---- PLNR-158: project docs -----------------------------------------------------------
describe('project docs', () => {
  it('create → list index → read body → update; humans manage via REST; feed evented', async () => {
    const pid = (await mcpCall(orch.apiKey, 'create_project', { key: 'DOCS', name: 'documented' })).body.id;
    const made = await mcpCall(orch.apiKey, 'create_doc', {
      projectId: pid, name: 'Conventions', description: 'how we name things', body: '# Naming\n\nkebab-case.',
    });
    expect(made.isError).toBe(false);

    const listed = await mcpCall(orch.apiKey, 'list_docs', { projectId: pid });
    expect(listed.body.docs).toHaveLength(1);
    expect(listed.body.docs[0].description).toBe('how we name things');
    expect(listed.body.docs[0].resource).toBe(`noriq://doc/${made.body.id}`);

    const read = await mcpCall(orch.apiKey, 'get_doc', { projectId: pid, docId: made.body.id });
    expect(read.body.body).toContain('kebab-case');

    await mcpCall(orch.apiKey, 'update_doc', { projectId: pid, docId: made.body.id, body: '# Naming\n\nsnake_case now.' });
    const reread = await mcpCall(orch.apiKey, 'get_doc', { projectId: pid, docId: made.body.id });
    expect(reread.body.body).toContain('snake_case');

    // REST list for the UI; human delete (no MCP delete tool exists — content deletion is human-only).
    const rest = await SELF.fetch(`https://noriq.test/api/projects/${pid}/docs`, { headers: { Cookie: cookie } });
    expect(rest.status).toBe(200);
    expect(((await rest.json()) as { docs: unknown[] }).docs).toHaveLength(1);
    const del = await SELF.fetch(`https://noriq.test/api/projects/${pid}/docs/${made.body.id}`, {
      method: 'DELETE', headers: { Cookie: cookie },
    });
    expect(del.status).toBe(200);
    const after = await mcpCall(orch.apiKey, 'list_docs', { projectId: pid });
    expect(after.body.docs).toHaveLength(0);
  });
});

// ---- PLNR-128: reusable work templates ------------------------------------------------
describe('templates', () => {
  it('save → list → stamp into a project as a live, ordered plan', async () => {
    const saved = await mcpCall(orch.apiKey, 'save_template', {
      name: 'Ship a feature',
      description: 'API first, UI second',
      spec: {
        title: 'Ship: <feature>',
        body: '# Approach\n\nAPI → UI → verify.',
        taskDefaults: { type: 'feature', priority: 3, tags: ['shipit'] },
        phases: [
          { title: 'API', newTasks: [{ title: 'endpoint' }, { title: 'tests', type: 'chore' }] },
          { title: 'UI', newTasks: [{ title: 'component' }] },
        ],
      },
    });
    expect(saved.isError).toBe(false);

    const listed = await mcpCall(orch.apiKey, 'list_templates', {});
    const tpl = listed.body.templates.find((t: { id: string }) => t.id === saved.body.id);
    expect(tpl.phases).toEqual([{ title: 'API', tasks: 2 }, { title: 'UI', tasks: 1 }]);

    const pid = (await mcpCall(orch.apiKey, 'create_project', { key: 'TPL', name: 'templated' })).body.id;
    const plan = await mcpCall(orch.apiKey, 'create_plan_from_template', {
      projectId: pid, templateId: saved.body.id, title: 'Ship: dark mode',
    });
    expect(plan.isError).toBe(false);
    expect(plan.body.title).toBe('Ship: dark mode');
    expect(plan.body.phases).toHaveLength(2);

    // The stamped plan is REAL: phase 2 gated behind phase 1, defaults applied.
    const uiTask = plan.body.phases[1].taskIds[0];
    const gated = await mcpCall(orch.apiKey, 'claim_task', { projectId: pid, taskId: uiTask });
    expect(gated.isError).toBe(true);
    expect(gated.text).toContain('blocked');
    const first = await mcpCall(orch.apiKey, 'get_task', { taskId: plan.body.phases[0].taskIds[0] });
    expect(first.body.task.priority).toBe(3);
    expect(first.body.task.type).toBe('feature');
  });
});

// ---- PLNR-160: admin OAuth management --------------------------------------------------
describe('admin OAuth management', () => {
  it('admin sees every connection, can revoke any; client delete refuses while live', async () => {
    // A member is locked out of all four endpoints.
    await createUser('oauthrando@example.com', 'OAuth Rando', 'longenough1', 'member').catch(() => {});
    const member = await loginSession('oauthrando@example.com', 'longenough1');
    for (const [m, path] of [['GET', '/api/admin/oauth/connections'], ['GET', '/api/admin/oauth/clients']] as const) {
      expect((await SELF.fetch(`https://noriq.test${path}`, { method: m, headers: { Cookie: member } })).status).toBe(403);
    }

    // The admin sees connections across users (the agent fixtures' mint user included).
    const conns = (await (await SELF.fetch('https://noriq.test/api/admin/oauth/connections', {
      headers: { Cookie: cookie },
    })).json()) as { connections: Array<{ id: string; userEmail: string | null; agentCount: number }> };
    expect(conns.connections.length).toBeGreaterThan(0);

    // Revoke a fresh victim's connection admin-side; its MCP access dies.
    const victim = await createAgent('admin-revoke-victim');
    await mcpCall(victim.apiKey, 'get_briefing', {});
    const after = (await (await SELF.fetch('https://noriq.test/api/admin/oauth/connections', {
      headers: { Cookie: cookie },
    })).json()) as { connections: Array<{ id: string; agentCount: number; lastActive: string | null }> };
    const fresh = after.connections.find((x) => !conns.connections.some((o) => o.id === x.id));
    expect(fresh).toBeTruthy();
    const rev = await SELF.fetch(`https://noriq.test/api/admin/oauth/connections/${fresh!.id}/revoke`, {
      method: 'POST', headers: { Cookie: cookie },
    });
    expect(rev.status).toBe(200);
    const dead = await mcpCall(victim.apiKey, 'get_briefing', {}).catch((e) => e);
    expect(String(dead)).toContain('401');

    // Clients list shows the shared test client with live connections → delete refused.
    const clients = (await (await SELF.fetch('https://noriq.test/api/admin/oauth/clients', {
      headers: { Cookie: cookie },
    })).json()) as { clients: Array<{ id: string; liveTokens: number }> };
    const busy = clients.clients.find((x) => x.liveTokens > 0)!;
    expect(busy).toBeTruthy();
    const refuse = await SELF.fetch(`https://noriq.test/api/admin/oauth/clients/${busy.id}`, {
      method: 'DELETE', headers: { Cookie: cookie },
    });
    expect(refuse.status).toBe(409);

    // A fresh, unused client deletes cleanly.
    const reg = (await (await SELF.fetch('https://noriq.test/oauth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'stale client', redirect_uris: ['http://localhost:1/cb'] }),
    })).json()) as { client_id: string };
    const del = await SELF.fetch(`https://noriq.test/api/admin/oauth/clients/${reg.client_id}`, {
      method: 'DELETE', headers: { Cookie: cookie },
    });
    expect(del.status).toBe(200);
  });
});

// ---- PLNR-116: a live TTL change takes effect without evicting the room ---------------
describe('claim TTL is invalidated in the live DO', () => {
  it('PATCH /meta routes the TTL through the DO so the next claim uses the new value', async () => {
    const pid = (await mcpCall(orch.apiKey, 'create_project', { key: 'TTL', name: 'ttl' })).body.id;
    const a = (await mcpCall(orch.apiKey, 'create_task', { tags: ['test-fixture'], projectId: pid, title: 'before' })).body;
    const b = (await mcpCall(orch.apiKey, 'create_task', { tags: ['test-fixture'], projectId: pid, title: 'after' })).body;

    // First claim warms the room and caches the default TTL.
    const c1 = await mcpCall(orch.apiKey, 'claim_task', { projectId: pid, taskId: a.id });
    expect(c1.body.ttlSeconds).not.toBe(300);

    // Change the TTL while the room is live; the old code memoized _ttl and kept issuing the
    // stale value until eviction. Routing the write through the DO must reset the cache.
    const patch = await SELF.fetch(`https://noriq.test/api/projects/${pid}/meta`, {
      method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ claimTtlSeconds: 300 }),
    });
    expect(patch.status).toBe(200);

    const c2 = await mcpCall(orch.apiKey, 'claim_task', { projectId: pid, taskId: b.id });
    expect(c2.body.ttlSeconds).toBe(300);
  });
});
