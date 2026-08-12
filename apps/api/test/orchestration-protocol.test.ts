import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, mcpCall } from './helpers';
import { RunnerClientMessage, RunnerServerMessage } from '@noriq-dev/shared';

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

describe('mission task wire contract (PLNR-485)', () => {
  it('parses begin, settle, and acknowledgement frames without changing execution telemetry', () => {
    const now = new Date().toISOString();
    const lease = { sitting: 1, executionId: 'exe_root', epoch: 1 };
    expect(RunnerClientMessage.parse({
      type: 'mission.task.begin', runId: 'run_root',
      lease,
      begin: { reportId: 'report-begin', attemptId: 'attempt-1', taskId: 'task-1', childKey: 'child-1', observedAt: now },
    }).type).toBe('mission.task.begin');
    expect(RunnerClientMessage.parse({
      type: 'mission.task.settle', runId: 'run_root',
      lease,
      settle: { reportId: 'report-settle', attemptId: 'attempt-1', claimId: 'clm_1', outcome: 'done', observedAt: now },
    }).type).toBe('mission.task.settle');
    expect(RunnerServerMessage.parse({
      type: 'mission.task.ack',
      ack: {
        reportId: 'report-begin', attemptId: 'attempt-1', phase: 'begin', accepted: true,
        taskId: 'task-1', claimId: 'clm_1', executionId: 'exe_1', taskStatus: 'in_progress', error: null,
      },
    }).type).toBe('mission.task.ack');
  });

  it('parses restart inventory and server adoption decisions with monotonic lease epochs', () => {
    const now = new Date().toISOString();
    const inventory = [{
      runId: 'run_root',
      lease: { sitting: 1, executionId: 'exe_root', epoch: 3 },
      attempts: [{ attemptId: 'attempt-1', executionId: 'exe_child', epoch: 3 }],
    }];
    expect(RunnerClientMessage.parse({ type: 'mission.reconcile', inventory, observedAt: now }).type)
      .toBe('mission.reconcile');
    expect(RunnerServerMessage.parse({
      type: 'mission.reconcile.request', deadline: now, items: inventory,
    }).type).toBe('mission.reconcile.request');
    expect(RunnerServerMessage.parse({
      type: 'mission.reconcile.result',
      results: [{
        runId: 'run_root', decision: 'adopt',
        lease: { sitting: 1, executionId: 'exe_root', epoch: 4 }, reason: null,
      }],
    }).type).toBe('mission.reconcile.result');
  });
});
