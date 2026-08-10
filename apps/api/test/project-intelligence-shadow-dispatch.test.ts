import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import type { Actor, CreateRunInput, RunPatch, RunView } from '../src/do/ProjectRoom';
import type { StoredShadowDispatchSnapshot } from '../src/memory/shadow-dispatch';
import { createAgent, mcpCall } from './helpers';

const appEnv = env as unknown as Env;
const actor: Actor = { kind: 'human', id: 'usr_shadow_dispatch', name: 'Shadow Dispatch' };

interface RoomRpc {
  createRun(projectId: string, actor: Actor, input: CreateRunInput): Promise<RunView>;
  transitionRun(projectId: string, actor: Actor, runId: string, patch: RunPatch): Promise<RunView>;
  reopenRun(projectId: string, actor: Actor, runId: string, rounds: number | null): Promise<RunView>;
  captureShadowDispatchSnapshot(
    projectId: string, runId: string, sitting: number, capturedAt?: string,
  ): Promise<StoredShadowDispatchSnapshot | null>;
  attachShadowOutcomeRef(
    projectId: string, runId: string, sitting: number, refType: 'episode' | 'quality_event',
    refId: string, observedAt?: string,
  ): Promise<{ attached: boolean }>;
}
const room = (projectId: string) => appEnv.PROJECT_ROOM.get(
  appEnv.PROJECT_ROOM.idFromName(projectId),
) as unknown as RoomRpc;

let agent: { id: string; apiKey: string };
beforeAll(async () => { agent = await createAgent('shadow-dispatch-agent'); }, 60_000);

async function newProject(key: string): Promise<string> {
  const result = await mcpCall(agent.apiKey, 'create_project', { key, name: `${key} shadow dispatch` });
  if (result.isError) throw new Error(result.text);
  return result.body.id as string;
}

async function seedRunner(projectId: string, id: string): Promise<void> {
  await appEnv.DB.batch([
    appEnv.DB.prepare(
      `INSERT INTO runners (id, project_id, label, status, capabilities, repos, free_slots, version)
       VALUES (?, ?, ?, 'online', ?, ?, 2, '9.4.0')`,
    ).bind(
      id, projectId, id,
      JSON.stringify({
        tools: ['codex'], kinds: ['build'], maxConcurrency: 2,
        agents: [{ tool: 'codex', models: ['gpt-5.6'], efforts: ['high'] }],
      }),
      JSON.stringify([{ id: 'repo-shadow', workflows: [{ name: 'evidence-build', base: 'build' }] }]),
    ),
    appEnv.DB.prepare(
      `INSERT INTO agents (id, name, kind, runner_id, project_id) VALUES (?, ?, 'agent', ?, ?)`,
    ).bind(`agt_${id}`, `agent-${id}`, id, projectId),
  ]);
}

async function waitForSnapshot(projectId: string, runId: string, sitting: number) {
  let stored: StoredShadowDispatchSnapshot | null = null;
  for (let i = 0; i < 30 && !stored; i++) {
    stored = await room(projectId).captureShadowDispatchSnapshot(projectId, runId, sitting);
    if (!stored) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return stored;
}

describe('per-sitting shadow dispatch snapshots (PLNR-300)', () => {
  it('captures bounded pre-execution coordinates without storing a recommendation or task body', async () => {
    const projectId = await newProject('SHD1');
    const runnerId = 'rnr_shadow_one';
    await seedRunner(projectId, runnerId);
    const marker = 'DO_NOT_COPY_THIS_TASK_BODY_INTO_SHADOW_EVIDENCE';
    const made = await mcpCall(agent.apiKey, 'create_task', {
      projectId, title: 'Build bounded shadow evidence', body: marker, type: 'feature',
      tags: ['shadow-test'],
      executionSpec: {
        requirementIds: ['SHADOW-1'],
        anticipatedFiles: [{ path: 'apps/api/src/memory/shadow-dispatch.ts', provides: 'capture' }],
      },
    });
    const taskId = made.body.id as string;
    const run = await room(projectId).createRun(projectId, actor, {
      kind: 'build', anchor: { type: 'task', id: taskId }, repoRef: 'repo-shadow',
      agentTool: 'codex', agent: 'codex.gpt-5.6.high', workflow: 'evidence-build',
      model: 'gpt-5.6', effort: 'high', budget: { maxTokens: 40_000 }, runnerId,
    });
    expect(run.status).toBe('dispatched');
    const stored = await waitForSnapshot(projectId, run.id, 1);
    expect(stored).not.toBeNull();
    expect(stored!.snapshot.identity).toMatchObject({
      projectId, runId: run.id, sitting: 1, taskId, previousSitting: null,
      orchestrationId: expect.any(String), executionId: expect.any(String),
    });
    expect(stored!.snapshot.features).toMatchObject({
      taskShape: { taskType: 'feature', tags: ['shadow-test'], executionSpecFingerprint: expect.any(String) },
      availableStrategies: {
        value: {
          workflows: expect.arrayContaining(['build', 'evidence-build']),
          agents: [{ tool: 'codex', models: ['gpt-5.6'], efforts: ['high'] }],
        },
      },
      chosenStrategy: {
        requested: { agent: 'codex.gpt-5.6.high', workflow: 'evidence-build' },
        commissioned: { agent: 'codex.gpt-5.6.high', workflow: 'evidence-build' },
      },
    });
    expect(stored!.snapshot.constraints).toEqual({
      recommendationStored: false, predictedWinnerStored: false, modelScoreStored: false,
    });
    expect(JSON.stringify(stored!.snapshot)).not.toContain(marker);

    const replay = await room(projectId).captureShadowDispatchSnapshot(projectId, run.id, 1);
    expect(replay?.snapshotHash).toBe(stored!.snapshotHash);
    expect((await appEnv.DB.prepare(
      'SELECT COUNT(*) AS n FROM run_sitting_shadow_snapshots WHERE run_id = ? AND sitting = 1',
    ).bind(run.id).first<{ n: number }>())?.n).toBe(1);
  });

  it('creates a distinct continued-sitting snapshot and appends outcomes without changing either hash', async () => {
    const projectId = await newProject('SHD2');
    const runnerId = 'rnr_shadow_two';
    await seedRunner(projectId, runnerId);
    const made = await mcpCall(agent.apiKey, 'create_task', {
      projectId, title: 'Continue shadow evidence', tags: ['shadow-test'],
    });
    const run = await room(projectId).createRun(projectId, actor, {
      kind: 'build', anchor: { type: 'task', id: made.body.id as string }, repoRef: 'repo-shadow',
      agentTool: 'codex', runnerId,
    });
    const first = await waitForSnapshot(projectId, run.id, 1);
    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'running', agentId: `agt_${runnerId}` });
    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'failed' });
    const reopened = await room(projectId).reopenRun(projectId, actor, run.id, null);
    expect(reopened.status).toBe('dispatched');
    const second = await waitForSnapshot(projectId, run.id, 2);
    expect(second?.snapshot.identity).toMatchObject({
      runId: run.id, sitting: 2, previousSitting: 1,
      orchestrationId: first!.snapshot.identity.orchestrationId,
    });
    expect(second?.snapshotHash).not.toBe(first?.snapshotHash);

    await room(projectId).attachShadowOutcomeRef(projectId, run.id, 1, 'episode', 'epi_shadow_one');
    await room(projectId).attachShadowOutcomeRef(projectId, run.id, 1, 'quality_event', 'qev_shadow_one');
    await room(projectId).attachShadowOutcomeRef(projectId, run.id, 1, 'episode', 'epi_shadow_one');
    const after = await appEnv.DB.prepare(
      `SELECT snapshot_hash AS hash FROM run_sitting_shadow_snapshots
        WHERE run_id = ? AND sitting = 1`,
    ).bind(run.id).first<{ hash: string }>();
    expect(after?.hash).toBe(first?.snapshotHash);
    const refs = await appEnv.DB.prepare(
      `SELECT ref_type AS type, ref_id AS id FROM run_sitting_shadow_outcome_refs
        WHERE run_id = ? AND sitting = 1 AND ref_id IN ('epi_shadow_one','qev_shadow_one') ORDER BY ref_type`,
    ).bind(run.id).all<{ type: string; id: string }>();
    expect(refs.results).toEqual([
      { type: 'episode', id: 'epi_shadow_one' },
      { type: 'quality_event', id: 'qev_shadow_one' },
    ]);
  });
});
