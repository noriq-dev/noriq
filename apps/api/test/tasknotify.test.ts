// PLNR-90: a newly-created, claimable task nudges AVAILABLE agents (holding
// nothing) so ad-hoc work is picked up dynamically — without distracting a
// heads-down agent, and without pinging the creator about their own task.
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, mcpCall, authorizeForAllProjects } from './helpers';

let worker: { id: string; apiKey: string };
let busy: { id: string; apiKey: string };
let creator: { id: string; apiKey: string };
let projectId: string;

const notices = async (apiKey: string): Promise<string[]> => (await mcpCall(apiKey, 'my_updates', {})).body.notices;

beforeAll(async () => {
  worker = await createAgent('notify-worker');
  busy = await createAgent('notify-busy');
  creator = await createAgent('notify-creator');
  projectId = (await mcpCall(creator.apiKey, 'create_project', { key: 'TN', name: 'task-notify' })).body.id;
  // Scoping (RUN-38): these agents were minted before the project existed, so each token is
  // scoped to nothing and only the CREATOR gains the new project. A human would authorize them
  // for it — say so explicitly rather than let the old implicit "every token sees everything"
  // creep back in.
  await authorizeForAllProjects(worker.apiKey, busy.apiKey, creator.apiKey);

  // Make `busy` heads-down: it claims a seed task.
  const seed = (await mcpCall(creator.apiKey, 'create_task', { projectId, title: 'seed' })).body;
  await mcpCall(busy.apiKey, 'claim_task', { projectId, taskId: seed.id });
  // Advance everyone's cursor past the setup so only tasks created below register as new.
  await notices(worker.apiKey);
  await notices(busy.apiKey);
  await notices(creator.apiKey);
}, 60000);

describe('new-task notify (PLNR-90)', () => {
  it('an available (idle) agent is nudged about a newly claimable task', async () => {
    const t = (await mcpCall(creator.apiKey, 'create_task', { projectId, title: 'dynamic work item' })).body;
    expect((await notices(worker.apiKey)).some((n) => n.includes(t.key) && /up for grabs/.test(n))).toBe(true);
  });

  it('a heads-down agent (holding a task) is NOT nudged', async () => {
    const t = (await mcpCall(creator.apiKey, 'create_task', { projectId, title: 'while youre busy' })).body;
    expect((await notices(busy.apiKey)).some((n) => n.includes(t.key))).toBe(false);
  });

  it('the creator is not nudged about their own new task', async () => {
    const t = (await mcpCall(creator.apiKey, 'create_task', { projectId, title: 'my own task' })).body;
    expect((await notices(creator.apiKey)).some((n) => n.includes(t.key))).toBe(false);
  });

  it('a task blocked by unfinished deps does not nudge (not claimable yet)', async () => {
    const gate = (await mcpCall(creator.apiKey, 'create_task', { projectId, title: 'gate' })).body;
    const blocked = (await mcpCall(creator.apiKey, 'create_task', { projectId, title: 'blocked', dependsOn: [gate.id] })).body;
    const ns = await notices(worker.apiKey);
    expect(ns.some((n) => n.includes(blocked.key))).toBe(false); // blocked → not up for grabs
    expect(ns.some((n) => n.includes(gate.key))).toBe(true);     // the gate itself is claimable
  });
});
