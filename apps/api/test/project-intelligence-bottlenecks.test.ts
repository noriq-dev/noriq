import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { taskClaimability } from '../src/lib/claimability';
import { assessProjectBottlenecks } from '../src/memory/bottlenecks';
import { createAgent, mcpCall } from './helpers';
import { RUNNER_JOB_CAPABILITY, RUNNER_PROTOCOL_CAPABILITIES } from '@noriq-dev/shared';

const appEnv = env as unknown as Env;
const observedAt = '2026-08-09T12:00:00.000Z';
const future = '2026-08-09T13:00:00.000Z';
const stale = '2026-08-01T12:00:00.000Z';

let owner: { id: string; apiKey: string };
beforeAll(async () => { owner = await createAgent('project-intelligence-bottlenecks'); }, 60_000);

async function project(key: string, name: string): Promise<string> {
  return (await mcpCall(owner.apiKey, 'create_project', { key, name })).body.id as string;
}

async function task(
  projectId: string,
  title: string,
  anticipatedFiles: string[] = [],
): Promise<{ id: string; key: string }> {
  const response = await mcpCall(owner.apiKey, 'create_task', {
    projectId,
    title,
    tags: ['analytics-test'],
    executionSpec: anticipatedFiles.length ? {
      anticipatedFiles: anticipatedFiles.map((path) => ({ path, change: 'modify', why: 'test scope' })),
    } : undefined,
  });
  return { id: response.body.id as string, key: response.body.key as string };
}

async function runner(
  projectId: string,
  id: string,
  heartbeat = observedAt,
  maxConcurrency = 2,
  advertised: { kinds?: string[]; protocolCapabilities?: string[] } = {},
) {
  const capabilities = {
    tools: ['codex'],
    kinds: advertised.kinds ?? ['build'],
    maxConcurrency,
    agents: [],
    ...(advertised.protocolCapabilities === undefined
      ? {}
      : { protocolCapabilities: advertised.protocolCapabilities }),
  };
  await appEnv.DB.prepare(
    `INSERT INTO runners
      (id, project_id, label, status, capabilities, repos, free_slots, last_heartbeat_at, created_at)
     VALUES (?, ?, ?, 'online', ?, ?, ?, ?, ?)`,
  ).bind(
    id, projectId, id,
    JSON.stringify(capabilities),
    JSON.stringify([{ id: `repo_${id}`, projectId, repositoryKey: 'noriq', defaultBranch: 'main' }]),
    maxConcurrency, heartbeat, heartbeat,
  ).run();
}

describe('collision and bottleneck evidence (PLNR-296)', () => {
  it('recognizes explicit RunnerJob v2 and legacy build capacity without inventing zero capacity', async () => {
    expect(RUNNER_PROTOCOL_CAPABILITIES).not.toContain(RUNNER_JOB_CAPABILITY);

    const runnerJobProject = await project('BTJOBV2', 'RunnerJob v2 capacity');
    await runner(runnerJobProject, 'rnr_bt_job_v2', observedAt, 2, {
      kinds: [], protocolCapabilities: [RUNNER_JOB_CAPABILITY],
    });
    const runnerJob = await assessProjectBottlenecks(appEnv, runnerJobProject, {
      repositoryKey: 'noriq', observedAt,
    });
    expect(runnerJob.capacity).toMatchObject({
      status: 'observed', availableSlots: 2, activeCapableRunners: 1,
      runners: [{ buildCapable: true, maxConcurrency: 2, busyRuns: 0, derivedFreeSlots: 2 }],
    });

    const legacyProject = await project('BTLEGACY', 'Legacy build capacity');
    await runner(legacyProject, 'rnr_bt_legacy', observedAt, 2);
    const legacy = await assessProjectBottlenecks(appEnv, legacyProject, {
      repositoryKey: 'noriq', observedAt,
    });
    expect(legacy.capacity).toMatchObject({
      status: 'observed', availableSlots: 2, activeCapableRunners: 1,
      runners: [{ buildCapable: true, derivedFreeSlots: 2 }],
    });

    const incapableProject = await project('BTINCAP', 'No advertised execution protocol');
    await runner(incapableProject, 'rnr_bt_incapable', observedAt, 2, {
      kinds: [], protocolCapabilities: [],
    });
    const incapable = await assessProjectBottlenecks(appEnv, incapableProject, {
      repositoryKey: 'noriq', observedAt,
    });
    expect(incapable.capacity).toMatchObject({
      status: 'unanswerable', availableSlots: null, activeCapableRunners: 0,
      runners: [{ buildCapable: false, completeness: 'complete', derivedFreeSlots: null }],
    });

    const unknownProject = await project('BTUNKN', 'Unknown RunnerJob capability');
    await runner(unknownProject, 'rnr_bt_unknown', observedAt, 2, { kinds: [] });
    const unknown = await assessProjectBottlenecks(appEnv, unknownProject, {
      repositoryKey: 'noriq', observedAt,
    });
    expect(unknown.capacity).toMatchObject({
      status: 'unanswerable', availableSlots: null, activeCapableRunners: 0,
      runners: [{ buildCapable: null, completeness: 'partial', derivedFreeSlots: null }],
    });
  });

  it('does not load an explicit focus task from another project', async () => {
    const projectId = await project('BTISO', 'Bottleneck focus isolation');
    const otherProjectId = await project('BTOTHER', 'Other bottleneck project');
    const foreign = await task(otherProjectId, 'foreign focus task');

    await expect(assessProjectBottlenecks(appEnv, projectId, {
      taskId: foreign.id, taskLimit: 1, observedAt,
    })).rejects.toThrow(`task ${foreign.id} not found in project ${projectId}`);
  });

  it('uses the shared landed-gate rule and never blames idle Runner capacity for gated work', async () => {
    const projectId = await project('BTLAND', 'Bottleneck landed gate');
    const blocker = await task(projectId, 'prior phase', ['apps/api/src/prior.ts']);
    const dependent = await task(projectId, 'later phase', ['apps/api/src/later.ts']);
    await runner(projectId, 'rnr_bt_landed');
    await appEnv.DB.batch([
      appEnv.DB.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").bind(blocker.id),
      appEnv.DB.prepare(
        "INSERT INTO plans (id, project_id, title, status) VALUES ('pln_bt_landed', ?, 'landed plan', 'active')",
      ).bind(projectId),
      appEnv.DB.prepare(
        "INSERT INTO phases (id, plan_id, title, \"order\") VALUES ('ph_bt_first', 'pln_bt_landed', 'first', 0)",
      ),
      appEnv.DB.prepare(
        "INSERT INTO phases (id, plan_id, title, \"order\") VALUES ('ph_bt_later', 'pln_bt_landed', 'later', 1)",
      ),
      appEnv.DB.prepare("INSERT INTO phase_tasks (phase_id, task_id) VALUES ('ph_bt_first', ?)").bind(blocker.id),
      appEnv.DB.prepare("INSERT INTO phase_tasks (phase_id, task_id) VALUES ('ph_bt_later', ?)").bind(dependent.id),
      appEnv.DB.prepare(
        `INSERT INTO plan_dispatches
          (id, project_id, plan_id, runner_id, repo_ref, agent_tool, gate, status, created_by, created_at, updated_at)
         VALUES ('pd_bt_landed', ?, 'pln_bt_landed', 'rnr_bt_landed', 'repo_rnr_bt_landed', 'codex',
                 'landed', 'active', 'test', ?, ?)`,
      ).bind(projectId, observedAt, observedAt),
    ]);

    const waiting = await assessProjectBottlenecks(appEnv, projectId, {
      taskId: dependent.id, repositoryKey: 'noriq', branch: 'main', baseId: 'base-current', observedAt,
    });
    const canonicalWaiting = await taskClaimability(appEnv.DB, dependent.id);
    expect(waiting.capacity).toMatchObject({ status: 'observed', availableSlots: 2, activeCapableRunners: 1 });
    expect(waiting.readiness.tasks.find((item) => item.taskId === dependent.id)).toMatchObject({
      primary: 'landing',
      claimability: {
        claimable: false, reasonCode: 'dependency', gate: 'landed',
        blockers: [{ taskId: blocker.id, key: blocker.key, status: 'review', landedRun: false }],
      },
    });
    expect(waiting.readiness.counts.runner_capacity).toBe(0);
    expect(waiting.readiness.tasks.find((item) => item.taskId === dependent.id)?.claimability)
      .toEqual(canonicalWaiting);

    await appEnv.DB.prepare(
      `INSERT INTO runs
        (id, project_id, runner_id, kind, anchor_type, anchor_id, repo_ref, agent_tool, status, created_by)
       VALUES ('run_bt_landed', ?, 'rnr_bt_landed', 'build', 'task', ?, 'repo_rnr_bt_landed', 'codex', 'done', 'test')`,
    ).bind(projectId, blocker.id).run();
    const landed = await assessProjectBottlenecks(appEnv, projectId, {
      taskId: dependent.id, repositoryKey: 'noriq', branch: 'main', observedAt,
    });
    expect(landed.readiness.tasks.find((item) => item.taskId === dependent.id)).toMatchObject({
      primary: 'ready', claimability: { claimable: true, gate: 'landed', blockers: [] },
    });
    expect(landed.readiness.tasks.find((item) => item.taskId === dependent.id)?.claimability)
      .toEqual(await taskClaimability(appEnv.DB, dependent.id));
  });

  it('marks disabled locking and stale durable Runner capacity unanswerable', async () => {
    const projectId = await project('BTSTALE', 'Bottleneck stale evidence');
    const review = await task(projectId, 'review is not an input request');
    await appEnv.DB.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").bind(review.id).run();
    await runner(projectId, 'rnr_bt_stale', stale, 8);

    const result = await assessProjectBottlenecks(appEnv, projectId, { observedAt });
    expect(result.collisions.locking).toEqual({ status: 'unanswerable', enabled: false, current: [] });
    expect(result.capacity).toMatchObject({ status: 'unanswerable', availableSlots: null, activeCapableRunners: 0 });
    expect(result.capacity.runners[0]).toMatchObject({ lifecycle: 'stale', heartbeatFresh: false, derivedFreeSlots: null });
    expect(result.readiness.tasks.find((item) => item.taskId === review.id)?.primary).toBe('approval');
    expect(result.humanBlocks).toEqual([]);
    expect(result.coverage.reasons).toEqual(expect.arrayContaining(['locking_disabled', 'runner_capacity_unknown']));
  });

  it('names live lock and anticipated-path collisions separately from historical support', async () => {
    const projectId = await project('BTLOCK', 'Bottleneck current collisions');
    const focus = await task(projectId, 'edit shared service', ['apps/api/src/shared/service.ts']);
    const other = await task(projectId, 'also edit shared service', ['apps/api/src/shared/service.ts']);
    await appEnv.DB.batch([
      appEnv.DB.prepare('UPDATE projects SET file_locking_enabled = 1 WHERE id = ?').bind(projectId),
      appEnv.DB.prepare("UPDATE tasks SET status = 'in_progress', claimed_by = ? WHERE id = ?").bind(owner.id, other.id),
      appEnv.DB.prepare(
        `INSERT INTO file_locks
          (id, project_id, agent_id, task_id, kind, raw_pattern, canon_pattern, branch, all_branches, acquired_at, expires_at)
         VALUES ('lck_bt_current', ?, ?, ?, 'file', 'apps/api/src/shared/service.ts',
                 'apps/api/src/shared/service.ts', 'main', 0, ?, ?)`,
      ).bind(projectId, owner.id, other.id, observedAt, future),
    ]);

    const result = await assessProjectBottlenecks(appEnv, projectId, {
      taskId: focus.id, repositoryKey: 'noriq', branch: 'main', baseId: 'base-lock', observedAt,
    });
    expect(result.targetContext).toEqual({
      taskId: focus.id, repositoryKey: 'noriq', branch: 'main', baseId: 'base-lock', executorMode: 'runner',
    });
    expect(result.collisions.locking.status).toBe('observed');
    expect(result.collisions.locking.current).toContainEqual(expect.objectContaining({
      taskId: focus.id, taskKey: focus.key, requestedPath: 'apps/api/src/shared/service.ts',
      lockId: 'lck_bt_current', lockedPath: 'apps/api/src/shared/service.ts',
      lockTaskId: other.id, lockTaskKey: other.key, holderAgentId: owner.id, branchOverlap: true,
    }));
    expect(result.collisions.anticipatedPaths.overlaps).toContainEqual(expect.objectContaining({
      taskId: other.id, taskKey: other.key,
      focusPath: 'apps/api/src/shared/service.ts', otherPath: 'apps/api/src/shared/service.ts',
      currentClaimOrExecution: true,
    }));
    expect(result.readiness.tasks.find((item) => item.taskId === focus.id)).toMatchObject({
      primary: 'lock', lockCollisionIds: ['lck_bt_current'],
    });
    expect(result.historicalSupport).toHaveProperty('cases');
    expect(result.collisions.locking).not.toHaveProperty('historical');
  });

  it('does not gate an IDE Copilot on missing Runner capacity', async () => {
    const projectId = await project('BTCOP', 'Copilot executor readiness');
    const focus = await task(projectId, 'implement from an IDE', ['apps/api/src/copilot.ts']);

    const result = await assessProjectBottlenecks(appEnv, projectId, {
      taskId: focus.id, executorMode: 'copilot', observedAt,
    });

    expect(result.capacity).toMatchObject({ status: 'unanswerable', availableSlots: null });
    expect(result.targetContext.executorMode).toBe('copilot');
    expect(result.readiness.tasks.find((item) => item.taskId === focus.id)).toMatchObject({
      primary: 'ready',
      reason: expect.stringMatching(/Copilot executor.*Runner capacity is not applicable/),
    });
    expect(result.coverage.reasons).not.toContain('runner_capacity_unknown');
  });

  it('reports canonical wire statuses while keeping failed work ready for retry (PLNR-514)', async () => {
    const projectId = await project('BTWIRE', 'Bottleneck wire status');
    const failed = await task(projectId, 'retry failed work');
    const todo = await task(projectId, 'fresh todo work');
    const proposed = await task(projectId, 'proposed work');
    const review = await task(projectId, 'review work');
    const done = await task(projectId, 'done work');
    await appEnv.DB.batch([
      appEnv.DB.prepare("UPDATE tasks SET failed_at = ? WHERE id = ? AND status = 'todo'").bind(observedAt, failed.id),
      appEnv.DB.prepare("UPDATE tasks SET proposed_at = ? WHERE id = ? AND status = 'todo'").bind(observedAt, proposed.id),
      appEnv.DB.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").bind(review.id),
      appEnv.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").bind(done.id),
    ]);

    const result = await assessProjectBottlenecks(appEnv, projectId, {
      taskId: done.id, executorMode: 'copilot', observedAt,
    });
    const readiness = new Map(result.readiness.tasks.map((item) => [item.taskId, item]));
    expect(readiness.get(failed.id)).toMatchObject({
      status: 'failed', primary: 'ready', claimability: { claimable: true, reasonCode: 'claimable' },
      reason: expect.stringMatching(/failed work is ready for retry/),
    });
    expect(readiness.get(todo.id)).toMatchObject({ status: 'todo', primary: 'ready' });
    expect(readiness.get(todo.id)?.reason).not.toMatch(/retry/);
    expect(readiness.get(proposed.id)).toMatchObject({ status: 'proposed', primary: 'approval' });
    expect(readiness.get(review.id)).toMatchObject({ status: 'review', primary: 'approval' });
    expect(readiness.get(done.id)).toMatchObject({ status: 'done', primary: 'unknown' });
    expect(await appEnv.DB.prepare('SELECT status, failed_at AS failedAt FROM tasks WHERE id = ?')
      .bind(failed.id).first()).toEqual({ status: 'todo', failedAt: observedAt });
  });

  it('counts a continued run once while identifying only blocking input requests as human blocks', async () => {
    const projectId = await project('BTLINE', 'Bottleneck execution lineage');
    const parkedTask = await task(projectId, 'waiting for explicit input');
    const runningTask = await task(projectId, 'continued execution');
    await appEnv.DB.batch([
      appEnv.DB.prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").bind(parkedTask.id),
      appEnv.DB.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").bind(runningTask.id),
      appEnv.DB.prepare(
        `INSERT INTO signals
          (id, project_id, task_id, agent_id, agent_name, type, severity, title, status, blocking, created_at)
         VALUES ('sig_bt_input', ?, ?, ?, 'worker', 'input_request', 'info', 'Choose an API shape', 'open', 1, ?)`,
      ).bind(projectId, parkedTask.id, owner.id, observedAt),
      appEnv.DB.prepare(
        `INSERT INTO runs
          (id, project_id, kind, anchor_type, anchor_id, repo_ref, agent_tool, status, sitting, phase, created_by, created_at, updated_at)
         VALUES ('run_bt_continued', ?, 'build', 'task', ?, 'repo_bt', 'codex', 'running', 2, 'agent',
                 'test', ?, ?)`,
      ).bind(projectId, runningTask.id, observedAt, observedAt),
      appEnv.DB.prepare(
        `INSERT INTO orchestrations
          (id, project_id, anchor_type, anchor_id, status, completeness_status, created_by_kind, created_by_id, created_at, updated_at)
         VALUES ('orc_bt_continued', ?, 'task', ?, 'running', 'complete', 'system', 'test', ?, ?)`,
      ).bind(projectId, runningTask.id, observedAt, observedAt),
      appEnv.DB.prepare(
        `INSERT INTO execution_nodes
          (id, orchestration_id, project_id, kind, role, task_id, run_id, sitting, status, completeness_status, created_at, updated_at)
         VALUES ('exe_bt_sitting', 'orc_bt_continued', ?, 'sitting', 'worker', ?, 'run_bt_continued', 2,
                 'running', 'complete', ?, ?)`,
      ).bind(projectId, runningTask.id, observedAt, observedAt),
      appEnv.DB.prepare(
        `INSERT INTO execution_nodes
          (id, orchestration_id, project_id, parent_execution_id, kind, role, task_id, run_id, sitting, stage,
           status, completeness_status, created_at, updated_at)
         VALUES ('exe_bt_stage', 'orc_bt_continued', ?, 'exe_bt_sitting', 'stage', 'reviewer', ?,
                 'run_bt_continued', 2, 'review', 'running', 'complete', ?, ?)`,
      ).bind(projectId, runningTask.id, observedAt, observedAt),
      appEnv.DB.prepare(
        `INSERT INTO execution_nodes
          (id, orchestration_id, project_id, parent_execution_id, kind, role, task_id, run_id, sitting, step,
           status, completeness_status, created_at, updated_at)
         VALUES ('exe_bt_step', 'orc_bt_continued', ?, 'exe_bt_stage', 'step', 'repair', ?,
                 'run_bt_continued', 2, 'repair-1', 'pending', 'complete', ?, ?)`,
      ).bind(projectId, runningTask.id, observedAt, observedAt),
    ]);

    const result = await assessProjectBottlenecks(appEnv, projectId, { observedAt });
    expect(result.execution.liveWorkerCount).toBe(1);
    expect(result.execution.liveRuns).toHaveLength(1);
    expect(result.execution.liveRuns[0]).toMatchObject({ id: 'run_bt_continued', sitting: 2 });
    // The run insert also projects its canonical run node; neither it nor these nested nodes
    // represents another supervised worker process.
    expect(result.execution.nodeCounts.reduce((sum, row) => sum + row.count, 0)).toBeGreaterThanOrEqual(4);
    expect(result.humanBlocks).toEqual([expect.objectContaining({
      signalId: 'sig_bt_input', taskId: parkedTask.id, kind: 'blocking_input_request',
    })]);
    expect(result.readiness.tasks.find((item) => item.taskId === parkedTask.id)?.primary).toBe('human');
    expect(result.readiness.tasks.find((item) => item.taskId === runningTask.id)?.primary).toBe('execution');
  });
});
