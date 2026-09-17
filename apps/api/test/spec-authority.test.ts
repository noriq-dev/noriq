// RUN-160: who may rewrite an execution spec (library rule). MCP is copilot-only after the
// runner execution plane was removed; bound-agent credentials are refused at agentAuth.
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

import { refuseSpecWrite, specWriteRefusalMessage } from '../src/lib/spec-authority';

describe('who may rewrite an execution spec (RUN-160)', () => {
  it.each(['build', 'verify'])('refuses a %s run agent', (runKind) => {
    const r = refuseSpecWrite({ actorKind: 'agent', runKind });
    expect(r).toEqual({ runKind });
    const msg = specWriteRefusalMessage(r!);
    expect(msg).toMatch(/is what your work is judged against/);
    expect(msg).toMatch(/post_comment/);
  });

  it('permits a scope run agent — the actor the field exists for', () => {
    expect(refuseSpecWrite({ actorKind: 'agent', runKind: 'scope' })).toBeNull();
  });

  it('permits a copilot, which is a human’s own session', () => {
    expect(refuseSpecWrite({ actorKind: 'copilot', runKind: null })).toBeNull();
    expect(refuseSpecWrite({ actorKind: 'copilot', runKind: 'build' })).toBeNull();
  });

  it('permits a run agent whose run has settled or cannot be found', () => {
    expect(refuseSpecWrite({ actorKind: 'agent', runKind: null })).toBeNull();
  });

  it('refuses a run kind it has never heard of', () => {
    expect(refuseSpecWrite({ actorKind: 'agent', runKind: 'experiment' })).toEqual({
      runKind: 'experiment',
    });
  });
});

describe('rewriting an execution spec over MCP (copilot-only)', () => {
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

  it('rejects legacy runner-bound credentials before any tool runs', async () => {
    const runner = await createRunAgent(projectId, 'build', {});
    await expect(mcpCall(runner.apiKey, 'get_briefing', {})).rejects.toThrow(/401/);
  });

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
