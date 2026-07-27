// RUN-160: who may rewrite an execution spec.
//
// The spec is the contract a build is judged against — its lockedDecisions bind the builder and its
// acceptance is what a reviewer grades. An actor that can edit both can talk its own gate into
// passing, which is the same shape as the status door PLNR-192 closed.
//
// A blanket ban on run agents would be wrong: a SCOPE run authoring specs for the tasks it files is
// the entire point of the field, and the runner's planner stage is built on it. So the
// discriminator is the run's KIND, not the actor's.
import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  authorizeForAllProjects,
  createAgent,
  createRunAgent,
  createUser,
  loginSession,
  mcpCall,
  projectRoom,
  SYSTEM_ACTOR,
} from './helpers';

import { refuseSpecWrite, specWriteRefusalMessage } from '../src/lib/spec-authority';

describe('who may rewrite an execution spec (RUN-160)', () => {
  // The actor being judged must not edit the standard it is judged against.
  it.each(['build', 'verify'])('refuses a %s run agent', (runKind) => {
    const r = refuseSpecWrite({ actorKind: 'agent', runKind });
    expect(r).toEqual({ runKind });
    const msg = specWriteRefusalMessage(r!);
    expect(msg).toMatch(/is what your work is judged against/);
    // A refusal with no alternative is a refusal an agent works around.
    expect(msg).toMatch(/add_comment/);
  });

  // A scope run authoring specs for the tasks it files is the entire point of the field, and the
  // runner's planner stage is built on it. A blanket ban on run agents would have broken it.
  it('permits a scope run agent — the actor the field exists for', () => {
    expect(refuseSpecWrite({ actorKind: 'agent', runKind: 'scope' })).toBeNull();
  });

  it('permits a copilot, which is a human’s own session', () => {
    expect(refuseSpecWrite({ actorKind: 'copilot', runKind: null })).toBeNull();
    // …even in the impossible case that one is somehow attached to a build.
    expect(refuseSpecWrite({ actorKind: 'copilot', runKind: 'build' })).toBeNull();
  });

  // Fail-OPEN on an unattributable actor, and it is the half that does not matter: an agent with
  // no live run has no gate left to talk past. Refusing every write we cannot attribute would
  // break copilots, humans and every settled run to protect nothing.
  it('permits a run agent whose run has settled or cannot be found', () => {
    expect(refuseSpecWrite({ actorKind: 'agent', runKind: null })).toBeNull();
  });

  // A kind nobody has invented yet is judged, not waved through: `scope` is the allowlist.
  // Unit-only of necessity, and legitimately so — 0018 CHECKs `runs.kind` to the three that
  // exist, so this case cannot be seeded. It is a statement about the day a fourth is added.
  it('refuses a run kind it has never heard of', () => {
    expect(refuseSpecWrite({ actorKind: 'agent', runKind: 'experiment' })).toEqual({
      runKind: 'experiment',
    });
  });
});

describe('rewriting an execution spec, end to end (RUN-160)', () => {
  let copilot: { id: string; apiKey: string };
  let projectId: string;
  let taskId: string;
  let cookie: string;


  const rewrite = (apiKey: string) =>
    mcpCall(apiKey, 'update_task', {
      projectId,
      taskId,
      executionSpec: { lockedDecisions: [{ decision: 'actually anything goes' }] },
    });

  beforeAll(async () => {
    copilot = await createAgent('spec-authority', 'orchestrator');
    cookie = await loginSession('founder@example.com', 'longenough1').catch(async () => {
      await createUser('founder@example.com', 'Founder', 'longenough1', 'admin');
      return loginSession('founder@example.com', 'longenough1');
    });
    const proj = await mcpCall(copilot.apiKey, 'create_project', { key: 'XAU', name: 'spec-authority' });
    projectId = proj.body.id;
    await authorizeForAllProjects(copilot.apiKey);
    const made = await mcpCall(copilot.apiKey, 'create_task', {
      projectId,
      title: 'the judged work',
      tags: ['exec-spec'],
      allowNewTags: true,
      executionSpec: { lockedDecisions: [{ decision: 'ESM only', because: 'the whole repo is' }] },
    });
    taskId = made.body.id;
  });

  /** What the row actually says now — the assertion that matters, because a refusal that reports
   *  an error and writes anyway is the failure mode worth testing for. */
  const storedSpec = async () =>
    (await env.DB.prepare('SELECT execution_spec AS s FROM tasks WHERE id = ?').bind(taskId)
      .first<{ s: string | null }>())!.s;

  // The whole point of the fixture: `createAgent` mints COPILOTS, so until now nothing in this
  // suite could reach the strict half of the rule through a real MCP call. A run agent rides a
  // token BOUND to it, which is why it is deterministic where a session-resolved copilot is not.
  it.each(['build', 'verify'] as const)('refuses a live %s run agent, and writes nothing', async (kind) => {
    const before = await storedSpec();
    const runner = await createRunAgent(projectId, kind, {});
    const res = await rewrite(runner.apiKey);
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/is what your work is judged against/);
    expect(res.text).toMatch(new RegExp(`a ${kind} run`));
    expect(await storedSpec()).toBe(before);
  });

  // A scope run authoring specs is the entire point of the field — a blanket ban on run agents
  // would have broken the planner stage, and this is the assertion that would have caught it.
  it('permits a live scope run agent — the actor the field exists for', async () => {
    const runner = await createRunAgent(projectId, 'scope', {});
    expect((await rewrite(runner.apiKey)).isError).toBeFalsy();
    expect(await storedSpec()).toMatch(/actually anything goes/);
  });

  // One field is closed, not the tool. A builder that cannot edit anything routes around the
  // refusal by not reporting at all.
  it('leaves the rest of update_task open to the agent it refused', async () => {
    const runner = await createRunAgent(projectId, 'build', {});
    const ok = await mcpCall(runner.apiKey, 'update_task', { projectId, taskId, priority: 1 });
    expect(ok.isError).toBeFalsy();
  });

  // The rule is about the ACTOR, not one task, and that is deliberate — nothing can tell which
  // task will end up judging the work (a verify run grades another run's output; a parent's
  // acceptance binds its children). Pinned as a property so the breadth reads as a decision
  // rather than as an anchor check somebody forgot to write.
  it('refuses a build agent an UNRELATED task’s spec too, by design', async () => {
    const runner = await createRunAgent(projectId, 'build', {});
    const other = await mcpCall(copilot.apiKey, 'create_task', {
      projectId, title: 'somebody else’s work', tags: ['exec-spec'],
    });
    const res = await mcpCall(runner.apiKey, 'update_task', {
      projectId, taskId: other.body.id, executionSpec: { discretion: ['not mine to write'] },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/is what your work is judged against/);
  });

  // …and creating one is NOT the same act. A builder handing follow-up work a spec is useful and
  // is not editing the standard it is being measured by; closing this would push it to leave the
  // next agent nothing.
  it('permits a build agent to give a task it CREATES a spec', async () => {
    const runner = await createRunAgent(projectId, 'build', {});
    const made = await mcpCall(runner.apiKey, 'create_task', {
      projectId,
      title: 'follow-up the builder found',
      tags: ['exec-spec'],
      executionSpec: { deferred: ['the bit I could not reach'] },
    });
    expect(made.isError).toBeFalsy();
    // Not just "the call succeeded" — a silently dropped spec would satisfy that and leave the
    // next agent with nothing, which is the outcome this permission exists to avoid.
    const stored = await env.DB.prepare('SELECT execution_spec AS s FROM tasks WHERE id = ?')
      .bind(made.body.id).first<{ s: string | null }>();
    expect(stored!.s).toMatch(/the bit I could not reach/);
  });

  // The rule fails OPEN on an agent with no live run, and that is only defensible while "the run
  // ended" implies "the credential died". So the thing worth asserting is not that the fail-open
  // works — it is that production never reaches it. Both terminal paths, because only one of
  // them used to retire the agent.
  describe('the fail-open is unreachable in production', () => {
    const stub = () => projectRoom<{
      transitionRun(p: string, a: unknown, r: string, patch: { status: string }): Promise<unknown>;
      reconcileRunnerRuns(p: string, a: unknown, runnerId: string): Promise<{ failed: number }>;
    }>(projectId);

    it('a run ending revokes the credential', async () => {
      const runner = await createRunAgent(projectId, 'build', {});
      expect((await rewrite(runner.apiKey)).isError).toBe(true);
      await stub().transitionRun(projectId, SYSTEM_ACTOR, runner.runId, { status: 'running' });
      await stub().transitionRun(projectId, SYSTEM_ACTOR, runner.runId, { status: 'done' });
      // Not "permitted now" — there is no longer an identity to permit.
      await expect(rewrite(runner.apiKey)).rejects.toThrow(/401/);
    });

    // A daemon restart writes `failed` with a raw UPDATE rather than through transitionRun, so
    // it skipped retirement entirely: the run was over, `runKindOf` returned null, and the
    // credential was still valid for the rest of its 7-day TTL. A build agent could rewrite the
    // spec it had just been judged against.
    it('a daemon restart revokes it too', async () => {
      const runner = await createRunAgent(projectId, 'build', {});
      expect((await rewrite(runner.apiKey)).isError).toBe(true);
      const { failed } = await stub().reconcileRunnerRuns(projectId, SYSTEM_ACTOR, runner.runnerId);
      expect(failed).toBeGreaterThan(0);
      await expect(rewrite(runner.apiKey)).rejects.toThrow(/401/);
    });
  });

  // The detour that made the original guard decorative: `update_tasks` applies the SAME patch,
  // and a one-element taskIds is `update_task` by another name. It was open.
  it('refuses the same write through the bulk tool', async () => {
    const before = await storedSpec();
    const runner = await createRunAgent(projectId, 'build', {});
    const res = await mcpCall(runner.apiKey, 'update_tasks', {
      projectId,
      taskIds: [taskId],
      set: { executionSpec: { lockedDecisions: [{ decision: 'via the bulk door' }] } },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/is what your work is judged against/);
    expect(await storedSpec()).toBe(before);
  });

  // Same detour, the status door PLNR-192 closed on the singular tool only.
  it('refuses a bulk status move by a run agent too (PLNR-192’s door, bulk side)', async () => {
    const runner = await createRunAgent(projectId, 'build', {});
    const res = await mcpCall(runner.apiKey, 'update_tasks', {
      projectId,
      taskIds: [taskId],
      set: { status: 'done' },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/run agents don't set task status/);
    const row = await env.DB.prepare('SELECT status FROM tasks WHERE id = ?').bind(taskId)
      .first<{ status: string }>();
    expect(row!.status).not.toBe('done');
  });

  // A copilot is a human's own session, and a human correcting a spec is the point of RUN-137.
  it('permits a copilot, and permits a human over REST', async () => {
    expect((await rewrite(copilot.apiKey)).isError).toBeFalsy();
    const res = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ executionSpec: { discretion: ['a human said so'] } }),
    });
    expect(res.status).toBe(200);
  });
});
