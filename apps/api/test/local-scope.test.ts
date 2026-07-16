// PLNR-142: my_updates is scoped to the agent's LOCAL project — an agent working one
// project must not see other projects' claimable tasks, even ones the same user owns.
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, mcpCall } from './helpers';

let agent: { id: string; apiKey: string };
let taskAKey: string;
let taskBKey: string;

beforeAll(async () => {
  agent = await createAgent('local-scope-agent');
  const projA = (await mcpCall(agent.apiKey, 'create_project', { key: 'LSA', name: 'A' })).body.id;
  const projB = (await mcpCall(agent.apiKey, 'create_project', { key: 'LSB', name: 'B' })).body.id;
  // Localize the agent to A by claiming a seed task there (claim sets project_id).
  const seedA = (await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId: projA, title: 'seed A', priority: 0 })).body;
  await mcpCall(agent.apiKey, 'claim_task', { projectId: projA, taskId: seedA.id });
  // A claimable task in each project. priority 0 so they sort last and don't crowd
  // other files' shared claimable pool (the suite shares one mint user).
  taskAKey = (await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId: projA, title: 'task in A', priority: 0 })).body.key;
  taskBKey = (await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId: projB, title: 'task in B', priority: 0 })).body.key;
}, 60000);

describe("my_updates is scoped to the agent's local project (PLNR-142)", () => {
  it("claimable includes the local project's task, not another project's", async () => {
    const u = await mcpCall(agent.apiKey, 'my_updates', {});
    const keys = (u.body.claimable as Array<{ key: string }>).map((t) => t.key);
    expect(keys).toContain(taskAKey);      // agent is localized to A
    expect(keys).not.toContain(taskBKey);  // B is the same user's project, but not the agent's
  });
});
