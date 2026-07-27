// RUN-135: a task carries an execution spec — what a builder is told before it is allowed to
// spend anything. Column (migration 0061), model, persistence through the DO, and the two DETAIL
// read paths. The create_task/update_task MCP surface is RUN-136; this drives the same DO through
// REST, which is the other write seam and needs no new tool schema.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall, authorizeForAllProjects } from './helpers';

const SPEC = {
  requirementIds: ['RUN-135'],
  anticipatedFiles: [{ path: 'apps/api/src/do/ProjectRoom.ts', change: 'modify', why: 'the write seam' }],
  requiredReading: ['doc_arch', 'packages/shared/src/execution-spec.ts'],
  lockedDecisions: [{ decision: 'one JSON column, not six tables', because: 'the spec is read whole' }],
  discretion: ['column name'],
  deferred: ['the dashboard editor'],
  acceptance: {
    observableTruths: ['a task created without a spec reads back null'],
    artifacts: [{ path: 'apps/api/migrations/0061_task_execution_spec.sql', provides: 'the column' }],
    links: [{ from: 'ProjectRoom.createTask', to: 'tasks.execution_spec', via: 'writeExecutionSpec' }],
  },
};

describe('a task carries an execution spec (RUN-135)', () => {
  let agent: { id: string; apiKey: string };
  let cookie: string;
  let projectId: string;

  const createTask = async (body: Record<string, unknown>) => {
    const res = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as { id: string; key: string; error?: string } };
  };
  const patchTask = async (taskId: string, patch: Record<string, unknown>) => {
    const res = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(patch),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const readTask = async (taskId: string) => {
    const res = await SELF.fetch(`https://noriq.test/api/tasks/${taskId}`, { headers: { Cookie: cookie } });
    return ((await res.json()) as { task: Record<string, any> }).task;
  };
  const snapshotTasks = async (): Promise<Array<Record<string, unknown>>> => {
    const res = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/snapshot`, {
      headers: { Cookie: cookie },
    });
    const snap = (await res.json()) as { tasks: Array<Record<string, unknown>> };
    return snap.tasks;
  };
  /** Every task title in the project — how "nothing was left behind" is asserted. */
  const titles = async (): Promise<string[]> => (await snapshotTasks()).map((t) => String(t.title));

  beforeAll(async () => {
    agent = await createAgent('spec-writer', 'orchestrator');
    cookie = await loginSession('founder@example.com', 'longenough1').catch(async () => {
      await createUser('founder@example.com', 'Founder', 'longenough1', 'admin');
      return loginSession('founder@example.com', 'longenough1');
    });
    const proj = await mcpCall(agent.apiKey, 'create_project', { key: 'XSP', name: 'exec-spec-project' });
    projectId = proj.body.id;
    await authorizeForAllProjects(agent.apiKey);
  });

  // The deprecation window (RUN-124's pattern): every caller that predates this keeps working,
  // and the task it creates is honestly "no spec" rather than an empty one nobody wrote.
  it('a task created without one reads back null, not the empty spec', async () => {
    const { body: created } = await createTask({ title: 'no spec here' });
    const task = await readTask(created.id);
    expect(task.executionSpec).toBeNull();
    expect(task).not.toHaveProperty('execution_spec');
  });

  it('round-trips a full spec through create and the detail read', async () => {
    const { body: created } = await createTask({ title: 'with a spec', executionSpec: SPEC });
    const task = await readTask(created.id);
    expect(task.executionSpec.requirementIds).toEqual(['RUN-135']);
    expect(task.executionSpec.anticipatedFiles).toEqual([
      { path: 'apps/api/src/do/ProjectRoom.ts', change: 'modify', why: 'the write seam' },
    ]);
    // Normalised on the way IN, so a read never has to reason about which shape an old row holds.
    expect(task.executionSpec.lockedDecisions[0]).toEqual({
      decision: 'one JSON column, not six tables',
      because: 'the spec is read whole',
      source: '',
    });
    expect(task.executionSpec.acceptance.links[0].via).toBe('writeExecutionSpec');
  });

  it('the MCP detail read returns it too, so an agent sees what a human sees', async () => {
    const { body: created } = await createTask({ title: 'mcp read', executionSpec: SPEC });
    const got = await mcpCall(agent.apiKey, 'get_task', { taskId: created.id });
    expect(got.body.task.executionSpec.acceptance.observableTruths).toEqual([
      'a task created without a spec reads back null',
    ]);
    expect(got.body.task).not.toHaveProperty('execution_spec');
  });

  it('replaces the spec on update, and an explicit null clears it', async () => {
    const { body: created } = await createTask({ title: 'editable', executionSpec: SPEC });
    await patchTask(created.id, { executionSpec: { discretion: ['everything'] } });
    const after = await readTask(created.id);
    // A replace, not a merge — the old requirementIds are gone, not retained.
    expect(after.executionSpec).toEqual({
      requirementIds: [],
      anticipatedFiles: [],
      requiredReading: [],
      lockedDecisions: [],
      discretion: ['everything'],
      deferred: [],
      acceptance: { observableTruths: [], artifacts: [], links: [] },
      steps: [],
    });

    await patchTask(created.id, { executionSpec: null });
    expect((await readTask(created.id)).executionSpec).toBeNull();
  });

  // Omitting the key must leave the spec alone, exactly like every other field in a patch —
  // otherwise every unrelated edit (a title fix, a status drag) would silently drop the plan.
  it('an update that does not mention the spec leaves it untouched', async () => {
    const { body: created } = await createTask({ title: 'unrelated edits', executionSpec: SPEC });
    await patchTask(created.id, { title: 'renamed' });
    await patchTask(created.id, { priority: 4 });
    const after = await readTask(created.id);
    expect(after.title).toBe('renamed');
    expect(after.executionSpec.requirementIds).toEqual(['RUN-135']);
  });

  // The write seam is where a bad spec must fail, at the caller that sent it — not later, on a
  // read, as a task that quietly lost its plan. `blockConcurrencyWhile` serializes a mutation but
  // is NOT a transaction, so "it threw" is not the same as "nothing happened": the spec has to be
  // validated before anything durable, and these assert the nothing-happened half.
  it('rejects a malformed spec at the write, leaving no task and no minted tag behind', async () => {
    const bad = await createTask({
      title: 'escapes the repo',
      // A tag nobody has used, so its existence afterwards is unambiguous evidence that the
      // create got as far as minting before the spec was checked.
      tags: ['spec-rejection-witness'],
      allowNewTags: true,
      executionSpec: { anticipatedFiles: [{ path: '../../etc/passwd' }] },
    });
    expect(bad.status).not.toBe(200);
    expect(await titles()).not.toContain('escapes the repo');
    const project = await mcpCall(agent.apiKey, 'get_project', { projectId });
    expect(JSON.stringify(project.body.tags ?? [])).not.toContain('spec-rejection-witness');
  });

  it('rejects a malformed spec on update without applying the rest of the patch', async () => {
    const { body: ok } = await createTask({ title: 'patch target', tags: ['keepme'], allowNewTags: true });
    const badPatch = await patchTask(ok.id, {
      title: 'renamed by a doomed patch',
      tags: ['clobbered'],
      executionSpec: { acceptance: { artifacts: [{ path: '/abs' }] } },
    });
    expect(badPatch.status).not.toBe(200);
    const after = await readTask(ok.id);
    expect(after.title).toBe('patch target');
    expect(after.executionSpec).toBeNull();
    // The tag block writes and can return early — a spec parsed at its own `sets.push` would
    // have replaced the tags before discovering the patch was bad.
    const got = await mcpCall(agent.apiKey, 'get_task', { taskId: ok.id });
    expect(got.body.task.tags ?? '').toContain('keepme');
  });

  // The tool schema catches a bad spec before the DO is reached, which is the fast path and the
  // one every agent takes.
  it('rejects a plan whose LAST task has a bad spec, leaving no plan and no earlier tasks', async () => {
    const planTitles = async (): Promise<string[]> =>
      ((await mcpCall(agent.apiKey, 'get_plans', { projectId })).body.plans as Array<{ title: string }>)
        .map((p) => p.title);
    expect(await planTitles()).not.toContain('doomed plan');
    const plan = await mcpCall(agent.apiKey, 'create_plan', {
      projectId,
      title: 'doomed plan',
      body: '# Goals\n\nThis must not half-exist.',
      phases: [
        {
          title: 'One',
          newTasks: [
            { title: 'plan-partial-first' },
            { title: 'plan-partial-second', executionSpec: { anticipatedFiles: [{ path: '/etc/passwd' }] } },
          ],
        },
      ],
    });
    expect(plan.isError).toBe(true);
    expect(await planTitles()).not.toContain('doomed plan');
    expect(await titles()).not.toContain('plan-partial-first');
  });

  // Per task, not per phase and not in taskDefaults: a spec names the files, decisions and
  // acceptance criteria of ONE piece of work.
  it('a plan phase carries one spec per task', async () => {
    const plan = await mcpCall(agent.apiKey, 'create_plan', {
      projectId,
      title: 'spec-carrying plan',
      body: '# Goals\n\nEach task arrives knowing its own scope.',
      phases: [
        {
          title: 'Phase one',
          newTasks: [
            { title: 'planned', executionSpec: { requirementIds: ['RUN-135'], discretion: ['naming'] } },
            { title: 'unplanned' },
          ],
        },
      ],
    });
    expect(plan.isError).toBeFalsy();
    const [planned, unplanned] = plan.body.phases[0].taskIds as string[];
    expect((await readTask(planned!)).executionSpec.requirementIds).toEqual(['RUN-135']);
    expect((await readTask(unplanned!)).executionSpec).toBeNull();
  });

  // A hand-edited row or a restored backup is the only way to get here — the write seam validates.
  // Throwing would make the task unreadable through every surface, to protect a field that is
  // orientation and never safety. But reporting plain `null` would be worse than either: a
  // planner reads null as "nobody planned this" and writes over it, so the flag is what stops a
  // corrupt value from being silently replaced.
  it.each([
    ['invalid JSON', '{not json'],
    ['an empty string, which the writer never stores', ''],
    ['valid JSON of the wrong shape', '{"anticipatedFiles":"not an array"}'],
  ])('flags %s as unreadable rather than reporting no spec', async (_why, stored) => {
    const { body: created } = await createTask({ title: 'corrupted', executionSpec: SPEC });
    // Corrupt it behind the write seam's back, the way a bad restore would.
    const { env } = await import('cloudflare:test');
    await (env as unknown as { DB: D1Database }).DB.prepare(
      'UPDATE tasks SET execution_spec = ? WHERE id = ?',
    ).bind(stored, created.id).run();

    const task = await readTask(created.id);
    expect(task.executionSpec).toBeNull();
    expect(task.executionSpecUnreadable).toBe(true);
    expect(task.title).toBe('corrupted'); // …and the rest of the task still reads

    const got = await mcpCall(agent.apiKey, 'get_task', { taskId: created.id });
    expect(got.body.task.executionSpecUnreadable).toBe(true);
  });

  // The inverse: a healthy task must NOT carry the flag, or it means nothing.
  it('does not flag a task that genuinely has no spec', async () => {
    const { body: created } = await createTask({ title: 'plainly unplanned' });
    const task = await readTask(created.id);
    expect(task.executionSpec).toBeNull();
    expect(task.executionSpecUnreadable).toBeUndefined();
  });

  // A template is a plan skeleton, and the spec is part of a task's SHAPE rather than one of its
  // per-project ids — so it has to survive the round trip, or saving a planned plan quietly saves
  // an unplanned one.
  it('carries the spec through save_template → create_plan_from_template', async () => {
    const saved = await mcpCall(agent.apiKey, 'save_template', {
      name: 'planned-skeleton',
      spec: {
        title: 'from a template',
        phases: [
          {
            title: 'One',
            newTasks: [{ title: 'templated task', executionSpec: { requirementIds: ['RUN-135'] } }],
          },
        ],
      },
    });
    expect(saved.isError).toBeFalsy();
    const stamped = await mcpCall(agent.apiKey, 'create_plan_from_template', {
      projectId,
      templateId: saved.body.id,
    });
    expect(stamped.isError).toBeFalsy();
    const taskId = stamped.body.phases[0].taskIds[0];
    expect((await readTask(taskId)).executionSpec.requirementIds).toEqual(['RUN-135']);
  });

  // …and the DO's own pre-validation is the backstop for a caller that did NOT come through a
  // tool schema. `create_plan_from_template` JSON.parses a stored row and hands it straight to
  // createPlan, so a template written before this shipped — or edited in the database — is the
  // one way a malformed spec reaches the write path. It must not half-create the plan.
  it('a stored template with a bad spec cannot half-create a plan', async () => {
    const saved = await mcpCall(agent.apiKey, 'save_template', {
      name: 'corruptible',
      spec: { title: 'from a bad template', phases: [{ title: 'One', newTasks: [{ title: 'placeholder' }] }] },
    });
    const { env } = await import('cloudflare:test');
    await (env as unknown as { DB: D1Database }).DB.prepare('UPDATE templates SET spec = ? WHERE id = ?')
      .bind(
        JSON.stringify({
          title: 'from a bad template',
          phases: [
            {
              title: 'One',
              newTasks: [
                { title: 'tpl-partial-first' },
                { title: 'tpl-partial-second', executionSpec: { anticipatedFiles: [{ path: '/etc/passwd' }] } },
              ],
            },
          ],
        }),
        saved.body.id,
      )
      .run();

    const stamped = await mcpCall(agent.apiKey, 'create_plan_from_template', {
      projectId,
      templateId: saved.body.id,
    });
    expect(stamped.isError).toBe(true);
    const plans = ((await mcpCall(agent.apiKey, 'get_plans', { projectId })).body.plans as Array<{ title: string }>)
      .map((p) => p.title);
    expect(plans).not.toContain('from a bad template');
    expect(await titles()).not.toContain('tpl-partial-first');
  });

  // Only the detail surfaces carry it — a board snapshot ships every task in the project, and
  // shipping every spec through it would be the whole feature's payload paid on every poll.
  // (The event log in the same response DOES name the field, which is the point of the test
  // below; this is about the task ROWS.)
  it('keeps the spec off the snapshot task rows, in both spellings', async () => {
    await createTask({ title: 'snapshot check', executionSpec: SPEC });
    const rows = await snapshotTasks();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).not.toHaveProperty('executionSpec');
      expect(row).not.toHaveProperty('execution_spec');
    }
  });

  // RUN-162. "Somebody edited this task" and "somebody moved the goalposts" are different facts,
  // and a reviewer asking the second should not have to read every edit to find out.
  it('emits a spec change as its OWN event, with a before and an after', async () => {
    const { body: created } = await createTask({ title: 'contract watcher', executionSpec: SPEC });
    await patchTask(created.id, { executionSpec: { discretion: ['everything'] } });
    const res = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/snapshot`, {
      headers: { Cookie: cookie },
    });
    const snap = (await res.json()) as {
      events: Array<{ verb: string; payload: { from?: string; to?: string } }>;
    };
    const changed = snap.events.find((e) => e.verb === 'task.spec_changed');
    expect(changed).toBeDefined();
    expect(changed?.payload.from).toMatch(/1 file\(s\), 1 decision\(s\)/);
    expect(changed?.payload.to).toMatch(/0 file\(s\), 0 decision\(s\), 0 acceptance/);
  });

  // A combined patch emits only `task.status_changed`, so without its own event the spec change
  // would have had none at all.
  it('emits it even when the same patch changed the status', async () => {
    const { body: created } = await createTask({ title: 'combined patch' });
    await patchTask(created.id, { status: 'review', executionSpec: { requirementIds: ['R'] } });
    const res = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/snapshot`, {
      headers: { Cookie: cookie },
    });
    const snap = (await res.json()) as { events: Array<{ verb: string; subjectId?: string }> };
    expect(snap.events.some((e) => e.verb === 'task.spec_changed')).toBe(true);
  });

  it('records a CLEARED spec as a change to none, not as silence', async () => {
    const { body: created } = await createTask({ title: 'cleared', executionSpec: SPEC });
    await patchTask(created.id, { executionSpec: null });
    const res = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/snapshot`, {
      headers: { Cookie: cookie },
    });
    const snap = (await res.json()) as { events: Array<{ verb: string; payload: { to?: string } }> };
    expect(snap.events.some((e) => e.verb === 'task.spec_changed' && e.payload.to === 'none')).toBe(true);
  });

  it('names the spec in the update event, so a watcher has something to key on', async () => {
    const { body: created } = await createTask({ title: 'event watcher' });
    await patchTask(created.id, { executionSpec: { discretion: ['anything'] } });
    const res = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/snapshot`, {
      headers: { Cookie: cookie },
    });
    const snap = (await res.json()) as { events: Array<{ verb: string; payload: { fields?: string[] } }> };
    const updated = snap.events.find((e) => e.verb === 'task.updated' && e.payload.fields?.includes('executionSpec'));
    expect(updated).toBeDefined();
  });
});
