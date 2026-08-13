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

describe('mission accepted-revision handoff wire contract (PLNR-488)', () => {
  it('keeps publication, acknowledgement, and consumption backend-neutral and exact', () => {
    const now = new Date().toISOString();
    const lease = { sitting: 1, executionId: 'exe_root', epoch: 1 };
    const handoff = {
      schemaVersion: 1, handoffId: 'handoff-1', backend: 'opaque-vcs',
      repositoryKey: 'noriq', checkpoint: 'checkpoint-1', revision: 'revision-1',
      reference: 'reference-1',
    };
    expect(RunnerClientMessage.parse({
      type: 'mission.handoff.publish', runId: 'run_root', lease,
      publication: { reportId: 'publish-1', handoff },
    }).type).toBe('mission.handoff.publish');
    expect(RunnerServerMessage.parse({
      type: 'mission.handoff.ack',
      ack: {
        reportId: 'publish-1', accepted: true, handoffId: 'handoff-1',
        state: 'preserved_unlanded', preservedAt: now, consumedAt: null,
        consumptionId: null, error: null,
      },
    }).type).toBe('mission.handoff.ack');
    expect(RunnerServerMessage.parse({
      type: 'mission.handoff.consumed',
      consumed: { runId: 'run_root', handoff, consumptionId: 'hca_1', consumedAt: now },
    }).type).toBe('mission.handoff.consumed');
    expect(JSON.stringify(handoff)).not.toMatch(/credential|command|localPath|mcp/i);
  });
});

describe('single-root mission commission wire contract (PLNR-489)', () => {
  it('parses a bounded immutable task graph on assignment and reconciliation', () => {
    const now = new Date().toISOString();
    const snapshot = {
      schemaVersion: 1, commissionId: 'mco_1', runId: 'run_root', sitting: 1,
      planId: 'plan_1', planTitle: 'Plan', planBody: 'Body', planRevision: 'revision-digest',
      commissionedAt: now,
      tasks: [{
        taskId: 'task_1', key: 'T-1', title: 'Task', body: 'Task body',
        phaseId: 'phase_1', phaseTitle: 'Build', phaseOrder: 0, taskOrder: 0,
        priority: 1, type: 'task', estimate: null, dueAt: null, workflow: null,
        executionSpec: null,
      }],
      dependencies: [],
    };
    const missionCommission = { digest: 'commission-digest', snapshot };
    const run = {
      id: 'run_root', projectId: 'project_1', runnerId: 'runner_1', agentId: null,
      execution: null, kind: 'build', anchor: { type: 'plan', planId: 'plan_1' },
      verifiesRunId: null, planKey: 'plan-1', targetBranch: null, brief: '', repoRef: 'repo_1',
      agentTool: 'codex', agent: null, workflow: 'mission-plan', executionProfile: null,
      model: null, effort: null, budget: {}, status: 'dispatched', phase: null, exit: null,
      worktreePath: null, modelUsage: null, createdBy: 'human_1', createdAt: now,
      updatedAt: now, dispatchedAt: now, startedAt: null,
    };
    expect(RunnerServerMessage.parse({
      type: 'run.assigned', run,
      missionLease: { sitting: 1, executionId: 'exe_root', epoch: 1 },
      missionCommission,
    })).toMatchObject({ missionCommission });
    expect(RunnerClientMessage.parse({
      type: 'mission.reconcile', observedAt: now,
      inventory: [{
        runId: 'run_root', lease: { sitting: 1, executionId: 'exe_root', epoch: 1 },
        commissionDigest: missionCommission.digest, attempts: [],
      }],
    })).toMatchObject({ inventory: [{ commissionDigest: missionCommission.digest }] });
  });
});
