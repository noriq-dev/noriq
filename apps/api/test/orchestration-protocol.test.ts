import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, mcpCall } from './helpers';

describe('orchestration MCP protocol (PLNR-366)', () => {
  let apiKey: string;
  let projectId: string;

  beforeAll(async () => {
    const actor = await createAgent('orchestration-protocol');
    apiKey = actor.apiKey;
    projectId = (await mcpCall(apiKey, 'create_project', {
      key: 'ORCPROTO', name: 'Orchestration protocol',
    })).body.id;
  });

  it('creates, declares, reports, and reads the same canonical execution tree', async () => {
    const made = await mcpCall(apiKey, 'create_orchestration', {
      projectId, anchor: { type: 'none' },
    });
    expect(made.isError).toBe(false);
    const orchestrationId = made.body.id as string;
    const observedAt = new Date().toISOString();

    const rootInput = {
      projectId, orchestrationId, parentExecutionId: null,
      localNodeKey: 'root', producerScope: 'mcp-test', kind: 'copilot_session', role: 'orchestrator',
      observedAt,
    };
    const root = await mcpCall(apiKey, 'declare_execution', rootInput);
    expect(root.isError).toBe(false);
    expect(root.body.created).toBe(true);

    const replay = await mcpCall(apiKey, 'declare_execution', rootInput);
    expect(replay.isError).toBe(false);
    expect(replay.body).toMatchObject({ id: root.body.id, created: false });

    const reported = await mcpCall(apiKey, 'report_execution', {
      projectId, orchestrationId, executionId: root.body.id,
      eventId: 'root-started', revision: 1, type: 'started', observedAt,
    });
    expect(reported.isError).toBe(false);
    expect(reported.body).toMatchObject({ status: 'running', expectedRevision: 2 });

    const tree = await mcpCall(apiKey, 'get_orchestration', { projectId, orchestrationId });
    expect(tree.isError).toBe(false);
    expect(tree.body.orchestration).toMatchObject({ id: orchestrationId, projectId, status: 'running' });
    expect(tree.body.nodes).toContainEqual(expect.objectContaining({ id: root.body.id, status: 'running' }));
  });
});
