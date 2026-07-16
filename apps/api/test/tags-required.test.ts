// PLNR-171: agent-created tasks must carry descriptive tags — tags[0] is the primary
// tag, and status/type/priority stand-ins are rejected with an instructive error.
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, mcpCall, authorizeForAllProjects } from './helpers';

describe('mandatory descriptive tags (PLNR-171)', () => {
  let agent: { id: string; apiKey: string };
  let pid: string;

  beforeAll(async () => {
    agent = await createAgent('tagger');
    pid = (await mcpCall(agent.apiKey, 'create_project', { key: 'TGR', name: 'tags-project' })).body.id;
    await authorizeForAllProjects(agent.apiKey);
  });

  it('rejects an untagged create_task with guidance', async () => {
    const res = await mcpCall(agent.apiKey, 'create_task', { projectId: pid, title: 'no tags' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('tags');
    expect(res.text).toContain('primary');
  });

  it('rejects status/type/priority stand-ins, normalized', async () => {
    for (const bad of ['bug', 'In Progress', 'P1', 'in_progress']) {
      const res = await mcpCall(agent.apiKey, 'create_task', { projectId: pid, title: `tagged ${bad}`, tags: [bad] });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('not a descriptive tag');
    }
  });

  it('accepts descriptive tags; a bad batch item fails alone', async () => {
    const ok = await mcpCall(agent.apiKey, 'create_task', {
      projectId: pid, title: 'good tags', tags: ['oauth', 'token-refresh'],
    });
    expect(ok.isError).toBe(false);

    const batch = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId: pid,
      tasks: [
        { ref: 'good', title: 'tagged fine', tags: ['board-filters'] },
        { ref: 'bad', title: 'untagged' },
      ],
    });
    expect(batch.isError).toBe(false);
    const byRef = Object.fromEntries(batch.body.created.map((i: { ref: string }) => [i.ref, i]));
    expect(byRef.good.id).toBeTruthy();
    expect(byRef.bad.error).toContain('tags are required');
    expect(batch.body.failed).toBe(1);
  });
});
