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
import { authorizeForAllProjects, createAgent, createUser, loginSession, mcpCall } from './helpers';

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
