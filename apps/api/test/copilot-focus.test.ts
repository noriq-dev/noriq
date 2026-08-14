// PLNR-354: a Copilot may roam between projects, but its briefing/update/memory scope must follow
// the work it is doing now. Runner agents remain pinned to the project chosen by their run.
import { describe, expect, it } from 'vitest';
import { createAgent, createRunAgent, mcpCall } from './helpers';

describe('roaming Copilot project focus', () => {
  it('follows successful cross-project claims and supports explicit read-only focus', async () => {
    const copilot = await createAgent('copilot-focus');
    const a = (await mcpCall(copilot.apiKey, 'create_project', { key: 'FOCUSA', name: 'Focus A' })).body.id as string;
    const b = (await mcpCall(copilot.apiKey, 'create_project', { key: 'FOCUSB', name: 'Focus B' })).body.id as string;
    const taskA = (await mcpCall(copilot.apiKey, 'create_task', { projectId: a, title: 'Work in A', tags: ['copilot'] })).body;
    const taskB = (await mcpCall(copilot.apiKey, 'create_task', { projectId: b, title: 'Work in B', tags: ['copilot'] })).body;

    await mcpCall(copilot.apiKey, 'claim_task', { projectId: a, taskId: taskA.id });
    expect((await mcpCall(copilot.apiKey, 'get_briefing', {})).body.state.agentProjectId).toBe(a);
    await mcpCall(copilot.apiKey, 'release_task', { projectId: a, taskId: taskA.id, toStatus: 'done' });

    await mcpCall(copilot.apiKey, 'claim_task', { projectId: b, taskId: taskB.id });
    expect((await mcpCall(copilot.apiKey, 'get_briefing', {})).body.state.agentProjectId).toBe(b);
    await mcpCall(copilot.apiKey, 'release_task', { projectId: b, taskId: taskB.id, toStatus: 'done' });

    const focused = await mcpCall(copilot.apiKey, 'configure_agent', { projectId: a });
    expect(focused.body).toMatchObject({ previousProjectId: b, projectId: a });
    expect(focused.body.nextAction).toMatch(/get_briefing/);
    expect((await mcpCall(copilot.apiKey, 'get_briefing', {})).body.state.agentProjectId).toBe(a);
  });

  it('does not expose roaming focus to a runner-owned agent or let rename move it', async () => {
    const owner = await createAgent('runner-focus-owner');
    const a = (await mcpCall(owner.apiKey, 'create_project', { key: 'FOCRUNA', name: 'Runner A' })).body.id as string;
    const b = (await mcpCall(owner.apiKey, 'create_project', { key: 'FOCRUNB', name: 'Runner B' })).body.id as string;
    const runner = await createRunAgent(a, 'build', {
      allowedTools: ['get_briefing', 'configure_agent'],
    });

    const focus = await mcpCall(runner.apiKey, 'configure_agent', { projectId: b });
    expect(focus.isError).toBe(true);
    expect(focus.text).toMatch(/pinned|cannot change project focus/i);

    const rename = await mcpCall(runner.apiKey, 'configure_agent', { name: 'still-pinned', projectId: b });
    expect(rename.isError).toBe(true);
    expect(rename.text).toMatch(/pinned|cannot change project focus/i);
    expect((await mcpCall(runner.apiKey, 'get_briefing', {})).body.state.agentProjectId).toBe(a);
  });
});
