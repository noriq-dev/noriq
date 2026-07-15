// PLNR-19: hammer the claim arbiter. The exactly-one-claim invariant is the
// foundation everything else stands on — prove it holds under a concurrent
// stampede, and that legitimate parallel work isn't serialized away.
import { describe, expect, it, beforeAll } from 'vitest';
import { createAgent, mcpCall, authorizeForAllProjects } from './helpers';

const RACERS = 12;

let agents: Array<{ id: string; apiKey: string }> = [];
let projectId: string;

beforeAll(async () => {
  // Mint a swarm through the real OAuth flow.
  agents = [];
  for (let i = 0; i < RACERS; i++) {
    agents.push(await createAgent(`racer-${i}`));
  }
  const proj = await mcpCall(agents[0]!.apiKey, 'create_project', { key: 'LOAD', name: 'load-test' });
  projectId = proj.body.id;
  // Scoping (RUN-38): these agents were minted before the project existed, so each token is
  // scoped to nothing and only the CREATOR gains the new project. A human would authorize them
  // for it — say so explicitly rather than let the old implicit "every token sees everything"
  // creep back in.
  await authorizeForAllProjects(...agents.map((a) => a.apiKey));

}, 60000);

describe('claim arbiter under load', () => {
  it(`${RACERS} agents race ONE task → exactly one claim, clean rejections`, async () => {
    const t = await mcpCall(agents[0]!.apiKey, 'create_task', { projectId, title: 'the contested task' });
    const start = Date.now();
    const results = await Promise.all(
      agents.map((a) => mcpCall(a.apiKey, 'claim_task', { projectId, taskId: t.body.id })),
    );
    const elapsed = Date.now() - start;

    const wins = results.filter((r) => !r.isError);
    const losses = results.filter((r) => r.isError);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(RACERS - 1);
    for (const l of losses) {
      expect(l.text).toMatch(/already claimed|not claimable/);
    }
    // Wall-clock sanity: the DO serializes, but a stampede must not take seconds each.
    expect(elapsed).toBeLessThan(10_000);
    // eslint-disable-next-line no-console
    console.info(`[load] 1-task stampede: ${RACERS} racers in ${elapsed}ms (1 win, ${losses.length} clean rejections)`);
  }, 30000);

  it(`${RACERS} agents claim ${RACERS} distinct tasks in parallel → all succeed`, async () => {
    const tasks: string[] = [];
    for (let i = 0; i < RACERS; i++) {
      const t = await mcpCall(agents[0]!.apiKey, 'create_task', { projectId, title: `parallel work ${i}` });
      tasks.push(t.body.id);
    }
    const start = Date.now();
    const results = await Promise.all(
      agents.map((a, i) => mcpCall(a.apiKey, 'claim_task', { projectId, taskId: tasks[i]! })),
    );
    const elapsed = Date.now() - start;
    expect(results.filter((r) => !r.isError)).toHaveLength(RACERS);
    // Every claim is exclusive and attributed to the right agent.
    const proj = await mcpCall(agents[0]!.apiKey, 'get_project', { projectId });
    for (let i = 0; i < RACERS; i++) {
      const row = proj.body.tasks.find((x: { id: string }) => x.id === tasks[i]);
      expect(row.claimedBy).toBe(agents[i]!.id);
    }
    // eslint-disable-next-line no-console
    console.info(`[load] parallel claims: ${RACERS}/${RACERS} in ${elapsed}ms`);
    expect(elapsed).toBeLessThan(10_000);
  }, 30000);

  it('rapid claim/release cycling keeps state consistent', async () => {
    const t = await mcpCall(agents[0]!.apiKey, 'create_task', { projectId, title: 'hot potato' });
    for (let round = 0; round < 5; round++) {
      const holder = agents[round % agents.length]!;
      const claim = await mcpCall(holder.apiKey, 'claim_task', { projectId, taskId: t.body.id });
      expect(claim.isError).toBe(false);
      const rel = await mcpCall(holder.apiKey, 'release_task', { projectId, taskId: t.body.id, toStatus: 'todo' });
      expect(rel.isError).toBe(false);
    }
    const proj = await mcpCall(agents[0]!.apiKey, 'get_project', { projectId });
    const row = proj.body.tasks.find((x: { id: string }) => x.id === t.body.id);
    expect(row.claimedBy).toBeNull();
    expect(row.status).toBe('todo');
  }, 30000);
});
