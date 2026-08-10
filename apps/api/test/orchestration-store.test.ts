import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addExecutionRelation,
  applyExecutionEvent,
  createOrchestration,
  declareExecution,
  getOrchestrationTree,
  listOrchestrations,
} from '../src/lib/orchestration-store';
import { createAgent, mcpCall } from './helpers';

const appEnv = env as unknown as import('../src/env').Env;
let actor: { id: string; apiKey: string };
let projectId: string;
let otherProjectId: string;
let taskId: string;

beforeAll(async () => {
  actor = await createAgent('orchestration-store');
  projectId = (await mcpCall(actor.apiKey, 'create_project', { key: 'ORCSTORE', name: 'Orchestration storage' })).body.id;
  otherProjectId = (await mcpCall(actor.apiKey, 'create_project', { key: 'ORCOTHER', name: 'Other orchestration scope' })).body.id;
  taskId = (await mcpCall(actor.apiKey, 'create_task', {
    projectId, title: 'Orchestration anchor', tags: ['test-fixture'],
  })).body.id;
}, 60_000);

const at = (offset: number) => new Date(Date.parse('2026-08-09T12:00:00.000Z') + offset * 1_000).toISOString();

describe('canonical orchestration and execution storage (PLNR-365)', () => {
  it('creates a three-level immutable tree with scoped roles and completeness', async () => {
    const orchestration = await createOrchestration(appEnv, {
      projectId,
      anchor: { type: 'task', id: taskId },
      createdBy: { kind: 'copilot', id: actor.id },
      createdAt: at(0),
    });
    const root = await declareExecution(appEnv, {
      projectId, orchestrationId: orchestration.id, producerScope: 'copilot/session-a', localNodeKey: 'root',
      kind: 'copilot_session', role: 'orchestrator', actor: { kind: 'copilot', id: actor.id },
      subject: { taskId }, completeness: { status: 'complete' }, observedAt: at(1),
    });
    const stage = await declareExecution(appEnv, {
      projectId, orchestrationId: orchestration.id, parentExecutionId: root.id,
      producerScope: 'copilot/session-a', localNodeKey: 'stage', kind: 'stage', role: 'worker',
      subject: { taskId, stage: 'build' }, completeness: { status: 'partial', missing: ['actor'], reason: 'not_bound_yet' },
      observedAt: at(2),
    });
    const step = await declareExecution(appEnv, {
      projectId, orchestrationId: orchestration.id, parentExecutionId: stage.id,
      producerScope: 'copilot/session-a', localNodeKey: 'step', kind: 'step', role: 'verifier',
      subject: { taskId, step: 'tests' }, observedAt: at(3),
    });

    const rows = await env.DB.prepare(
      `SELECT id, parent_execution_id AS parentId, role, completeness_status AS completeness
         FROM execution_nodes WHERE orchestration_id = ? ORDER BY created_at`,
    ).bind(orchestration.id).all<{ id: string; parentId: string | null; role: string; completeness: string }>();
    expect(rows.results).toEqual([
      { id: root.id, parentId: null, role: 'orchestrator', completeness: 'complete' },
      { id: stage.id, parentId: root.id, role: 'worker', completeness: 'partial' },
      { id: step.id, parentId: stage.id, role: 'verifier', completeness: 'complete' },
    ]);
    expect(await env.DB.prepare('SELECT root_execution_id AS rootId FROM orchestrations WHERE id = ?')
      .bind(orchestration.id).first()).toMatchObject({ rootId: root.id });

    await expect(env.DB.prepare('UPDATE execution_nodes SET parent_execution_id = NULL WHERE id = ?')
      .bind(step.id).run()).rejects.toThrow(/execution structure is immutable/);
  });

  it('resolves repeated declarations idempotently and conflicts changed content', async () => {
    const orchestration = await createOrchestration(appEnv, {
      projectId, anchor: { type: 'none' }, createdBy: { kind: 'copilot', id: actor.id },
    });
    const declaration = {
      projectId, orchestrationId: orchestration.id, producerScope: 'runner/run-1/1', localNodeKey: 'builder',
      kind: 'stage' as const, role: 'worker' as const, subject: { stage: 'build' }, observedAt: at(5),
    };
    const first = await declareExecution(appEnv, declaration);
    const replay = await declareExecution(appEnv, declaration);
    expect(replay).toEqual({ id: first.id, created: false });
    await expect(declareExecution(appEnv, { ...declaration, role: 'verifier' }))
      .rejects.toThrow(/local execution key conflicts/);
  });

  it('rejects cross-project parentage, self relations, and relation cycles', async () => {
    const orchestration = await createOrchestration(appEnv, {
      projectId, anchor: { type: 'none' }, createdBy: { kind: 'copilot', id: actor.id },
    });
    const other = await createOrchestration(appEnv, {
      projectId: otherProjectId, anchor: { type: 'none' }, createdBy: { kind: 'copilot', id: actor.id },
    });
    const root = await declareExecution(appEnv, {
      projectId, orchestrationId: orchestration.id, producerScope: 'cycle', localNodeKey: 'a',
      kind: 'step', role: 'worker', observedAt: at(10),
    });
    const child = await declareExecution(appEnv, {
      projectId, orchestrationId: orchestration.id, parentExecutionId: root.id,
      producerScope: 'cycle', localNodeKey: 'b', kind: 'step', role: 'worker', observedAt: at(11),
    });
    await expect(declareExecution(appEnv, {
      projectId: otherProjectId, orchestrationId: other.id, parentExecutionId: root.id,
      producerScope: 'other', localNodeKey: 'bad-parent', kind: 'step', role: 'worker', observedAt: at(12),
    })).rejects.toThrow(/parent is outside/);
    await expect(addExecutionRelation(appEnv, {
      projectId, orchestrationId: orchestration.id, fromExecutionId: root.id, toExecutionId: root.id,
      type: 'depends_on',
    })).rejects.toThrow(/cannot reference itself/);
    await addExecutionRelation(appEnv, {
      projectId, orchestrationId: orchestration.id, fromExecutionId: root.id, toExecutionId: child.id,
      type: 'depends_on', metadata: { reason: 'ordered' },
    });
    expect(await addExecutionRelation(appEnv, {
      projectId, orchestrationId: orchestration.id, fromExecutionId: root.id, toExecutionId: child.id,
      type: 'depends_on', metadata: { reason: 'ordered' },
    })).toMatchObject({ created: false });
    await expect(addExecutionRelation(appEnv, {
      projectId, orchestrationId: orchestration.id, fromExecutionId: root.id, toExecutionId: child.id,
      type: 'depends_on', metadata: { reason: 'changed' },
    })).rejects.toThrow(/canonical metadata/);
    await expect(addExecutionRelation(appEnv, {
      projectId, orchestrationId: orchestration.id, fromExecutionId: child.id, toExecutionId: root.id,
      type: 'depends_on',
    })).rejects.toThrow(/would create a cycle/);
  });

  it('applies revisioned lifecycle events idempotently and never resurrects terminal nodes', async () => {
    const orchestration = await createOrchestration(appEnv, {
      projectId, anchor: { type: 'none' }, createdBy: { kind: 'copilot', id: actor.id },
    });
    const node = await declareExecution(appEnv, {
      projectId, orchestrationId: orchestration.id, producerScope: 'events', localNodeKey: 'node',
      kind: 'sitting', role: 'worker', observedAt: at(20),
    });
    const started = {
      projectId, orchestrationId: orchestration.id, executionId: node.id,
      eventId: 'evt_store_started', revision: 1, type: 'started' as const, observedAt: at(21),
    };
    expect(await applyExecutionEvent(appEnv, started)).toMatchObject({ applied: true, status: 'running', expectedRevision: 2 });
    expect(await applyExecutionEvent(appEnv, started)).toMatchObject({ applied: false, status: 'running', expectedRevision: 2 });
    expect(await applyExecutionEvent(appEnv, { ...started, eventId: 'evt_store_started_replay' }))
      .toMatchObject({ applied: false, status: 'running', expectedRevision: 2 });
    await expect(applyExecutionEvent(appEnv, {
      ...started, eventId: 'evt_store_started_conflict', type: 'parked',
    })).rejects.toThrow(/revision conflicts/);
    await expect(applyExecutionEvent(appEnv, { ...started, type: 'parked' }))
      .rejects.toThrow(/eventId conflicts/);
    await expect(applyExecutionEvent(appEnv, { ...started, eventId: 'evt_store_gap', revision: 3 }))
      .rejects.toThrow(/expected 2/);
    await applyExecutionEvent(appEnv, {
      ...started, eventId: 'evt_store_park', revision: 2, type: 'parked', observedAt: at(22),
    });
    await applyExecutionEvent(appEnv, {
      ...started, eventId: 'evt_store_resume', revision: 3, type: 'resumed', observedAt: at(23),
    });
    expect(await applyExecutionEvent(appEnv, {
      ...started, eventId: 'evt_store_done', revision: 4, type: 'succeeded', observedAt: at(24),
    })).toMatchObject({ status: 'succeeded', expectedRevision: 5 });
    await expect(applyExecutionEvent(appEnv, {
      ...started, eventId: 'evt_store_resurrect', revision: 5, type: 'started', observedAt: at(25),
    })).rejects.toThrow(/illegal execution lifecycle transition/);
  });

  it('continues terminal work as a new node without rewriting the predecessor', async () => {
    const orchestration = await createOrchestration(appEnv, {
      projectId, anchor: { type: 'none' }, createdBy: { kind: 'copilot', id: actor.id },
    });
    const failed = await declareExecution(appEnv, {
      projectId, orchestrationId: orchestration.id, producerScope: 'continue', localNodeKey: 'sitting-1',
      kind: 'sitting', role: 'worker', observedAt: at(30),
    });
    await applyExecutionEvent(appEnv, {
      projectId, orchestrationId: orchestration.id, executionId: failed.id,
      eventId: 'evt_continue_start', revision: 1, type: 'started', observedAt: at(31),
    });
    await applyExecutionEvent(appEnv, {
      projectId, orchestrationId: orchestration.id, executionId: failed.id,
      eventId: 'evt_continue_fail', revision: 2, type: 'failed', observedAt: at(32), reason: 'tests',
    });
    const next = await declareExecution(appEnv, {
      projectId, orchestrationId: orchestration.id, producerScope: 'continue', localNodeKey: 'sitting-2',
      kind: 'sitting', role: 'repair', continuesExecutionId: failed.id, observedAt: at(33),
    });
    expect(await env.DB.prepare('SELECT status FROM execution_nodes WHERE id = ?').bind(failed.id).first())
      .toMatchObject({ status: 'failed' });
    expect(await env.DB.prepare(
      "SELECT 1 AS ok FROM execution_relations WHERE from_execution_id = ? AND to_execution_id = ? AND type = 'continues'",
    ).bind(next.id, failed.id).first()).toMatchObject({ ok: 1 });
    expect(await env.DB.prepare('SELECT status FROM orchestrations WHERE id = ?').bind(orchestration.id).first())
      .toMatchObject({ status: 'pending' });
  });

  it('bounds metadata before it reaches durable storage', async () => {
    const orchestration = await createOrchestration(appEnv, {
      projectId, anchor: { type: 'none' }, createdBy: { kind: 'copilot', id: actor.id },
    });
    const node = await declareExecution(appEnv, {
      projectId, orchestrationId: orchestration.id, producerScope: 'metadata', localNodeKey: 'node',
      kind: 'step', role: 'worker', observedAt: at(40),
    });
    await expect(applyExecutionEvent(appEnv, {
      projectId, orchestrationId: orchestration.id, executionId: node.id,
      eventId: 'evt_metadata_large', revision: 1, type: 'started', observedAt: at(41),
      metadata: { value: 'x'.repeat(9_000) },
    })).rejects.toThrow(/metadata exceeds/);
  });

  it('serves a bounded human inventory and paginated canonical audit timeline', async () => {
    const orchestration = await createOrchestration(appEnv, {
      projectId, anchor: { type: 'task', id: taskId }, createdBy: { kind: 'copilot', id: actor.id },
      completeness: { status: 'partial', missing: ['legacy_parent'], reason: 'legacy session' },
      createdAt: at(50),
    });
    const root = await declareExecution(appEnv, {
      projectId, orchestrationId: orchestration.id, producerScope: 'human-read', localNodeKey: 'root',
      kind: 'copilot_session', role: 'orchestrator', actor: { kind: 'copilot', id: actor.id },
      subject: { taskId }, observedAt: at(51),
    });
    const handoff = await declareExecution(appEnv, {
      projectId, orchestrationId: orchestration.id, parentExecutionId: root.id,
      producerScope: 'human-read', localNodeKey: 'handoff', kind: 'step', role: 'worker',
      subject: { taskId, step: 'handoff target' }, observedAt: at(51),
    });
    const relation = await addExecutionRelation(appEnv, {
      projectId, orchestrationId: orchestration.id, fromExecutionId: root.id, toExecutionId: handoff.id,
      type: 'hands_off_to', createdAt: at(51),
    });
    await applyExecutionEvent(appEnv, {
      projectId, orchestrationId: orchestration.id, executionId: root.id,
      eventId: 'evt_human_started', revision: 1, type: 'started', observedAt: at(52),
    });
    await applyExecutionEvent(appEnv, {
      projectId, orchestrationId: orchestration.id, executionId: root.id,
      eventId: 'evt_human_parked', revision: 2, type: 'parked', observedAt: at(53), reason: 'human gate',
    });

    const inventory = await listOrchestrations(env.DB, projectId, { view: 'active', limit: 1 });
    expect(inventory.orchestrations).toHaveLength(1);
    expect(inventory.page).toMatchObject({ limit: 1, hasMore: true, nextCursor: expect.any(String) });
    expect(inventory.orchestrations[0]).toMatchObject({
      id: orchestration.id, anchorLabel: 'ORCSTORE-1 · Orchestration anchor',
      createdByName: 'orchestration-store', completenessMissing: ['legacy_parent'], nodeCount: 2, liveNodeCount: 2,
    });

    const first = await getOrchestrationTree(env.DB, projectId, orchestration.id, { timelineLimit: 1 });
    expect(first.orchestration).toMatchObject({
      anchorLabel: 'ORCSTORE-1 · Orchestration anchor', createdByName: 'orchestration-store',
      nodeCount: 2, liveNodeCount: 2, incompleteNodeCount: 0,
    });
    expect(first.rootExecutionIds).toEqual([root.id]);
    expect(first.nodes.find((node) => node.id === root.id)).toMatchObject({
      actorName: 'orchestration-store', taskKey: 'ORCSTORE-1', taskTitle: 'Orchestration anchor', parentExecutionId: null,
    });
    expect(first.timeline.map((event) => event.eventId)).toEqual(['evt_human_parked']);
    expect(first.timelinePage).toMatchObject({ hasMore: true, nextCursor: expect.any(String) });
    const second = await getOrchestrationTree(env.DB, projectId, orchestration.id, {
      timelineLimit: 1, timelineCursor: first.timelinePage.nextCursor!,
    });
    expect(second.timeline.map((event) => event.eventId)).toEqual(['evt_human_started']);
    const completeTimeline = await getOrchestrationTree(env.DB, projectId, orchestration.id);
    expect(completeTimeline.timeline).toContainEqual(expect.objectContaining({
      eventId: relation.id, eventType: 'hands_off_to', executionId: root.id, targetExecutionId: handoff.id,
    }));
  });
});
