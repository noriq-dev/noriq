// PLNR-247: the ProjectMemory outbox <-> ProjectRoom event bridge, and the reverse D1 event
// projector. Drives both DOs' RPCs directly (same technique as file-locks.test.ts /
// memory-registry.test.ts) — no HTTP surface exists for any of this yet.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { buildEntityUri } from '@noriq-dev/shared';
import { createUser, mintTokenForUser, mcpCall, projectRoom } from './helpers';

const appEnv = env as unknown as Env;

interface MemoryRpc {
  health(pid: string): Promise<{ schemaVersion: number; memoryRevision: number; tableCounts: Record<string, number> }>;
  recordMemory(
    pid: string,
    input: { operationId?: string; kind: string; statement: string; actor: { kind: string; id: string | null } },
  ): Promise<{ memoryId: string; operationId: string; deduped: boolean }>;
  drainOutbox(pid: string): Promise<{ delivered: number; failed: number }>;
  runProjector(pid: string): Promise<{ applied: number; cursor: number }>;
  reconcile(pid: string): Promise<{ delivered: number; failed: number; applied: number; cursor: number }>;
  _setForceDeliveryFailure(pid: string, fail: boolean): Promise<void>;
  _countNodes(pid: string): Promise<number>;
  dependencyNeighborhood(
    pid: string,
    input: { entityUri: string; edgeTypes?: string[]; maxDepth?: number; maxResults?: number },
  ): Promise<{ coverage: { complete: boolean; reasons: string[] }; upstream: unknown[]; downstream: unknown[] }>;
}
const SYSTEM = { kind: 'system', id: null };
interface RoomRpc {
  receiveMemoryEvent(
    pid: string,
    delivery: { operationId: string; verb: string; subjectType: string; subjectId: string; payload?: Record<string, unknown> },
  ): Promise<{ ok: true; deduped: boolean }>;
}

const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as MemoryRpc;
const room = (pid: string) => projectRoom<RoomRpc>(pid);

async function newOwnedProject(email: string, key: string) {
  const user = await createUser(email, 'Owner', 'longenough1');
  const token = await mintTokenForUser(email);
  const proj = await mcpCall(token, 'create_project', { key, name: `${key} project` });
  if (proj.isError) throw new Error(`create_project(${key}) failed: ${proj.text}`);
  return { userId: user.id, token, projectId: proj.body.id as string };
}

type EventRow = { id: string; actor_kind: string; verb: string; subject_id: string; payload: string };
async function memoryEvents(pid: string): Promise<Array<EventRow & { payload: Record<string, unknown> }>> {
  const { results } = await appEnv.DB.prepare(
    "SELECT id, actor_kind, verb, subject_id, payload FROM events WHERE project_id = ? AND verb = 'memory.changed'",
  ).bind(pid).all<EventRow>();
  return results.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

describe('outbox delivery — forward direction is idempotent', () => {
  it('replaying the same delivery N times yields exactly one appended event', async () => {
    const { projectId } = await newOwnedProject('pm-outbox-fwd@example.com', 'PMOBXF');
    const { memoryId, operationId } = await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'a learning', actor: SYSTEM });
    const delivery = {
      operationId,
      verb: 'memory.changed',
      subjectType: 'memory',
      subjectId: memoryId,
      payload: { operationId, entityType: 'memory_item', kind: 'learning', authority: 1 },
    };

    const r1 = await room(projectId).receiveMemoryEvent(projectId, delivery);
    const r2 = await room(projectId).receiveMemoryEvent(projectId, delivery);
    const r3 = await room(projectId).receiveMemoryEvent(projectId, delivery);
    expect([r1.deduped, r2.deduped, r3.deduped]).toEqual([false, true, true]);

    const events = await memoryEvents(projectId);
    expect(events).toHaveLength(1);
    expect(events[0]!.actor_kind).toBe('system');
    expect(events[0]!.subject_id).toBe(memoryId);
    // Compact payload only — no memory body (statement/evidence) ever rides the event log.
    // actorName rides every event's payload (emit()'s own convention); everything else here
    // is exactly what the outbox row's summary carried, nothing more.
    expect(events[0]!.payload).toEqual({ operationId, entityType: 'memory_item', kind: 'learning', authority: 1, actorName: 'system' });
    expect(events[0]!.payload.statement).toBeUndefined();
    expect(events[0]!.payload.evidence).toBeUndefined();
  });

  it('drainOutbox actually delivers a pending row end to end', async () => {
    const { projectId } = await newOwnedProject('pm-outbox-drain@example.com', 'PMOBXD');
    await memory(projectId).recordMemory(projectId, { kind: 'decision', statement: 'a decision', actor: SYSTEM });
    const result = await memory(projectId).drainOutbox(projectId);
    expect(result).toEqual({ delivered: 1, failed: 0 });
    expect(await memoryEvents(projectId)).toHaveLength(1);

    // Re-draining is a no-op — the row is already marked delivered.
    const again = await memory(projectId).drainOutbox(projectId);
    expect(again).toEqual({ delivered: 0, failed: 0 });
    expect(await memoryEvents(projectId)).toHaveLength(1);
  });

  it('does not retain the dedupe marker when the event append fails', async () => {
    const { projectId } = await newOwnedProject('pm-outbox-atomic@example.com', 'PMOBXAT');
    const seq = await appEnv.DB.prepare('SELECT next_event_seq AS n FROM projects WHERE id = ?')
      .bind(projectId).first<{ n: number }>();
    expect(seq).toBeTruthy();

    // Force emit()'s event INSERT to collide while leaving its dedupe INSERT valid. The batch
    // must roll both back, allowing the exact same operation id to be retried afterward.
    await appEnv.DB.prepare(
      `INSERT INTO events (id, project_id, seq, actor_kind, actor_id, verb, subject_type, subject_id)
       VALUES (?, ?, ?, 'system', 'system', 'test.collision', 'test', 'test')`,
    ).bind('ev_memory_atomic_collision', projectId, seq!.n).run();
    const delivery = {
      operationId: 'op_memory_atomic_retry', verb: 'memory.changed', subjectType: 'memory', subjectId: 'mem_atomic',
    };
    await expect(room(projectId).receiveMemoryEvent(projectId, delivery)).rejects.toThrow();
    expect(await appEnv.DB.prepare('SELECT 1 FROM memory_event_dedup WHERE operation_id = ?')
      .bind(delivery.operationId).first()).toBeNull();

    await appEnv.DB.prepare('UPDATE projects SET next_event_seq = ? WHERE id = ?')
      .bind(seq!.n + 1, projectId).run();
    await expect(room(projectId).receiveMemoryEvent(projectId, delivery)).resolves.toEqual({ ok: true, deduped: false });
    expect(await memoryEvents(projectId)).toHaveLength(1);
  });
});

describe('injected delivery failure + reconciliation', () => {
  it('a failed delivery leaves canonical state correct; reconcile closes the gap', async () => {
    const { projectId } = await newOwnedProject('pm-outbox-fail@example.com', 'PMOBXFL');
    await memory(projectId).recordMemory(projectId, { kind: 'hazard', statement: 'a hazard', actor: SYSTEM });

    await memory(projectId)._setForceDeliveryFailure(projectId, true);
    const failedAttempt = await memory(projectId).drainOutbox(projectId);
    expect(failedAttempt).toEqual({ delivered: 0, failed: 1 });
    expect(await memoryEvents(projectId)).toHaveLength(0); // no data loss, no partial event

    await memory(projectId)._setForceDeliveryFailure(projectId, false);
    const reconciled = await memory(projectId).reconcile(projectId);
    expect(reconciled.delivered).toBe(1);
    expect(await memoryEvents(projectId)).toHaveLength(1);
  });
});

describe('D1 event projector — reverse direction is idempotent', () => {
  it('projects task.created into a graph node once, and re-running applies nothing new', async () => {
    const { token, projectId } = await newOwnedProject('pm-projector@example.com', 'PMPROJ');
    const task = await mcpCall(token, 'create_task', { projectId, title: 'projected task', tags: ['memory-outbox-test'], allowNewTags: true });
    if (task.isError) throw new Error(`create_task failed: ${task.text}`);
    const taskId = task.body.id as string;

    const first = await memory(projectId).runProjector(projectId);
    expect(first.applied).toBeGreaterThan(0);
    const healthAfterFirst = await memory(projectId).health(projectId);
    expect(healthAfterFirst.tableCounts.nodes).toBeGreaterThan(0);

    // Cursor and projection move together (atomic by construction — one transactionSync per
    // event): re-running over the now-fully-consumed range writes nothing new.
    const second = await memory(projectId).runProjector(projectId);
    expect(second.applied).toBe(0);
    expect(second.cursor).toBe(first.cursor);
    const healthAfterSecond = await memory(projectId).health(projectId);
    expect(healthAfterSecond.tableCounts.nodes).toBe(healthAfterFirst.tableCounts.nodes);

    void taskId; // the projected node's uri embeds this; asserted via table count above
  });

  it('PLNR-283: widens to plan.created/doc.created/milestone.created, each an addressable node', async () => {
    const { token, projectId } = await newOwnedProject('pm-projector-wide@example.com', 'PMPROJW');
    const plan = await mcpCall(token, 'create_plan', {
      projectId, title: 'projected plan',
      phases: [{ title: 'phase 1', newTasks: [{ title: 'phase task' }] }],
    });
    if (plan.isError) throw new Error(`create_plan failed: ${plan.text}`);
    const planId = plan.body.id as string;

    const doc = await mcpCall(token, 'create_doc', { projectId, name: 'projected doc', body: 'settled content.' });
    if (doc.isError) throw new Error(`create_doc failed: ${doc.text}`);
    const docId = doc.body.id as string;

    const milestone = await mcpCall(token, 'create_milestone', { projectId, title: 'projected milestone' });
    if (milestone.isError) throw new Error(`create_milestone failed: ${milestone.text}`);
    const milestoneId = milestone.body.id as string;

    const first = await memory(projectId).runProjector(projectId);
    expect(first.applied).toBeGreaterThan(0);

    const planNode = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: buildEntityUri({ kind: 'plan', id: planId }) });
    expect(planNode.coverage.reasons).not.toContain('seed-not-found');
    const docNode = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: buildEntityUri({ kind: 'artifact', id: docId }) });
    expect(docNode.coverage.reasons).not.toContain('seed-not-found');
    const milestoneNode = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: buildEntityUri({ kind: 'unknown', id: milestoneId }) });
    expect(milestoneNode.coverage.reasons).not.toContain('seed-not-found');

    // Re-running over the now-fully-consumed range writes nothing new — same idempotency
    // guarantee as the task.created case above, now exercised across every widened verb.
    const nodesAfterFirst = await memory(projectId)._countNodes(projectId);
    const second = await memory(projectId).runProjector(projectId);
    expect(second.applied).toBe(0);
    expect(await memory(projectId)._countNodes(projectId)).toBe(nodesAfterFirst);
  });
});

describe('memory delivery never touches agent liveness', () => {
  it("a memory.changed delivery does not renew any agent's claim expiry", async () => {
    const { token, projectId } = await newOwnedProject('pm-outbox-liveness@example.com', 'PMLIVE');
    const task = await mcpCall(token, 'create_task', { projectId, title: 'claimed task', tags: ['memory-outbox-test'], allowNewTags: true });
    if (task.isError) throw new Error(`create_task failed: ${task.text}`);
    const taskId = task.body.id as string;
    await mcpCall(token, 'claim_task', { projectId, taskId });

    const before = await appEnv.DB.prepare('SELECT claim_expires_at FROM tasks WHERE id = ?')
      .bind(taskId)
      .first<{ claim_expires_at: string }>();
    expect(before?.claim_expires_at).toBeTruthy();

    await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'liveness probe', actor: SYSTEM });
    await memory(projectId).drainOutbox(projectId);

    const after = await appEnv.DB.prepare('SELECT claim_expires_at FROM tasks WHERE id = ?')
      .bind(taskId)
      .first<{ claim_expires_at: string }>();
    expect(after?.claim_expires_at).toBe(before?.claim_expires_at);
  });
});
