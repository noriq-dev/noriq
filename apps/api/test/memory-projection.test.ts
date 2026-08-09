// PLNR-262: project an activated generation's staged entities/edges into the live graph.
// Drives the real begin/batch/complete/activate (PLNR-261) + projectActiveGeneration RPCs
// directly, then PLNR-258's dependencyNeighborhood to prove the primitives answer over PROJECTED
// data (not seeded fixtures) — stable identity across reindex, retirement without breaking
// historical uri resolution, co-change labelling, and the one-summary-event bulk write.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import type { Actor, CreateRunInput, RunView } from '../src/do/ProjectRoom';
import { createUser, mintTokenForUser, mcpCall } from './helpers';
import { buildEntityUri } from '@noriq-dev/shared';
import { mapCoordinationEvent } from '../src/memory/projection';

const appEnv = env as unknown as Env;
// The DurableObjectStub RPC type collapses CreateRun's RunView return to `never` (same reason
// runs.test.ts hand-types it) — address ProjectRoom through a facade scoped to what these tests
// need, not the whole surface.
interface RoomRpc {
  createRun(projectId: string, actor: Actor, input: CreateRunInput): Promise<RunView>;
  // PLNR-319: exercised directly (not through MCP) the same way file-locks.test.ts already
  // drives deleteTask — these are REST/human-only surfaces with no MCP tool.
  deleteTask(projectId: string, actor: Actor, taskId: string): Promise<{ ok: true; key: string }>;
  deletePlan(projectId: string, actor: Actor, planId: string): Promise<{ ok: true }>;
  deleteDoc(projectId: string, actor: Actor, docId: string): Promise<{ ok: true }>;
  moveTask(projectId: string, actor: Actor, taskId: string, toProjectId: string): Promise<{ ok: true }>;
}
const room = (projectId: string) => appEnv.PROJECT_ROOM.get(appEnv.PROJECT_ROOM.idFromName(projectId)) as unknown as RoomRpc;
const SYSTEM_ACTOR: Actor = { kind: 'system', id: 'system', name: 'system' };

interface IndexManifestInput {
  generationId: string; projectId: string; repositoryKey: string; branch: string; baseId: string;
  indexerVersion: string; batchCount: number; fileCount: number; contentHash: string; deletions: string[]; createdAt: string;
}
interface StagedRow { kind: 'node' | 'edge'; uri?: string; type?: string; label?: string; content?: string | null; from?: string; to?: string }
interface NodeRow { nodeId: string; uri: string; type: string; label: string }
interface DependencyResult { coverage: { complete: boolean; reasons: string[] }; upstream: NodeRow[]; downstream: NodeRow[] }

interface RecordMemoryInput {
  operationId?: string;
  kind: string;
  statement: string;
  authority?: number;
  confidence?: number | null;
  evidence?: unknown[];
  supersedesMemoryId?: string | null;
  scope?: unknown;
  actor: { kind: string; id: string | null };
}

interface MemRpc {
  beginIndexIngest(pid: string, manifest: IndexManifestInput): Promise<{ ok: true }>;
  ingestIndexBatch(pid: string, batch: { generationId: string; batchNumber: number; batchHash: string }, rows: StagedRow[]): Promise<{ ok: true; deduped: boolean }>;
  completeIndexIngest(pid: string, generationId: string): Promise<{ ok: true; batchesReceived: number; validation: { ok: boolean; problems: string[] } }>;
  activateIndexGeneration(pid: string, generationId: string): Promise<{
    activated: string; superseded: string[];
    projection: { nodesWritten: number; edgesWritten: number; entitiesSkipped: number; edgesSkipped: number; retired: number; coChangeEdges: number };
  }>;
  projectActiveGeneration(pid: string, generationId: string): Promise<{ nodesWritten: number; edgesWritten: number; entitiesSkipped: number; edgesSkipped: number; retired: number; coChangeEdges: number }>;
  runProjector(pid: string): Promise<{ applied: number; cursor: number }>;
  dependencyNeighborhood(pid: string, input: { entityUri: string; edgeTypes?: string[]; maxDepth?: number; maxResults?: number }): Promise<DependencyResult>;
  health(pid: string): Promise<{ tableCounts: Record<string, number> }>;
  _countNodes(pid: string): Promise<number>;
  _countEdges(pid: string): Promise<number>;
  _edgeProvenance(pid: string, type: string, fromUri: string, toUri: string): Promise<string | null>;
  recordMemory(pid: string, input: RecordMemoryInput): Promise<{ memoryId: string; operationId: string; deduped: boolean }>;
  rebuildProjection(pid: string): Promise<{ nodesWritten: number; edgesWritten: number }>;
  searchProjectMemory(pid: string, opts: Record<string, unknown>): Promise<{ mode: string; results: Array<{ entityType: string; id: string; uri?: string }> }>;
}

const SYSTEM = { kind: 'system', id: null };
const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as MemRpc;

async function newOwnedProject(email: string, key: string) {
  const user = await createUser(email, 'Owner', 'longenough1');
  const token = await mintTokenForUser(email);
  const proj = await mcpCall(token, 'create_project', { key, name: `${key} project` });
  if (proj.isError) throw new Error(`create_project(${key}) failed: ${proj.text}`);
  return { userId: user.id, token, projectId: proj.body.id as string };
}

const baseManifest = (over: Partial<IndexManifestInput> & Pick<IndexManifestInput, 'generationId' | 'projectId' | 'repositoryKey'>): IndexManifestInput => ({
  branch: 'main', baseId: 'sha_1', indexerVersion: 'v1', batchCount: 1, fileCount: 1, contentHash: 'sha256:x', deletions: [], createdAt: new Date().toISOString(),
  ...over,
});

/** Stage one batch and drive it all the way to a projected, active generation. */
async function stageAndProject(projectId: string, opts: { generationId: string; repositoryKey: string; rows: StagedRow[]; fileCount?: number }) {
  const m = memory(projectId);
  await m.beginIndexIngest(projectId, baseManifest({
    generationId: opts.generationId, projectId, repositoryKey: opts.repositoryKey,
    fileCount: opts.fileCount ?? opts.rows.filter((r) => r.kind === 'node' && r.type === 'file').length,
  }));
  await m.ingestIndexBatch(projectId, { generationId: opts.generationId, batchNumber: 0, batchHash: 'h' }, opts.rows);
  const completed = await m.completeIndexIngest(projectId, opts.generationId);
  if (!completed.validation.ok) throw new Error(`validation failed: ${completed.validation.problems.join('; ')}`);
  return (await m.activateIndexGeneration(projectId, opts.generationId)).projection;
}

describe('projecting an activated generation into the graph', () => {
  it('projects file/symbol entities and their edges into nodes/edges — dependencyNeighborhood answers without seeded fixtures', async () => {
    const { projectId } = await newOwnedProject('pm-262-project@example.com', 'PM62PRJ');
    const fileUri = buildEntityUri({ kind: 'file', projectKey: 'PM62PRJ', repositoryKey: 'repo-a', path: 'src/a.ts' });
    const symbolUri = buildEntityUri({ kind: 'symbol', projectKey: 'PM62PRJ', repositoryKey: 'repo-a', path: 'src/a.ts', name: 'foo' });
    const result = await stageAndProject(projectId, {
      generationId: 'gen_proj', repositoryKey: 'repo-a',
      rows: [
        { kind: 'node', uri: fileUri, type: 'file', label: 'a.ts' },
        { kind: 'node', uri: symbolUri, type: 'symbol', label: 'foo' },
        { kind: 'edge', type: 'declares', from: fileUri, to: symbolUri },
      ],
    });
    expect(result).toEqual({ nodesWritten: 2, edgesWritten: 1, entitiesSkipped: 0, edgesSkipped: 0, retired: 0, coChangeEdges: 0 });

    const neighborhood = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: fileUri, edgeTypes: ['declares'] });
    expect(neighborhood.downstream.map((n) => n.uri)).toEqual([symbolUri]);
  });

  it('api and database_entity project too, using PLNR-278\'s arms — no packages/shared change needed here', async () => {
    const { projectId } = await newOwnedProject('pm-262-apidb@example.com', 'PM62API');
    const apiUri = buildEntityUri({ kind: 'api', projectKey: 'PM62API', repositoryKey: 'repo-a', path: 'src/routes.ts', name: 'POST /widgets' });
    const dbUri = buildEntityUri({ kind: 'database_entity', projectKey: 'PM62API', repositoryKey: 'repo-a', name: 'widgets' });
    const result = await stageAndProject(projectId, {
      generationId: 'gen_apidb', repositoryKey: 'repo-a', fileCount: 0,
      rows: [
        { kind: 'node', uri: apiUri, type: 'api', label: 'POST /widgets' },
        { kind: 'node', uri: dbUri, type: 'database_entity', label: 'widgets' },
      ],
    });
    expect(result.nodesWritten).toBe(2);
    expect(result.entitiesSkipped).toBe(0);
  });

  it('re-projecting the SAME entity content under a NEW generationId leaves the node id unchanged', async () => {
    const { projectId } = await newOwnedProject('pm-262-stable@example.com', 'PM62STB');
    const fileUri = buildEntityUri({ kind: 'file', projectKey: 'PM62STB', repositoryKey: 'repo-a', path: 'src/a.ts' });
    await memory(projectId).runProjector(projectId);
    const baseline = await memory(projectId)._countNodes(projectId);
    await stageAndProject(projectId, { generationId: 'gen_s1', repositoryKey: 'repo-a', rows: [{ kind: 'node', uri: fileUri, type: 'file', label: 'a.ts' }] });
    const nodesAfterFirst = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: fileUri });
    // No downstream expected — just confirming the seed resolves; capture the node id via a
    // second lookup path (a self-edge would be circular, so assert stability through re-query).
    await stageAndProject(projectId, { generationId: 'gen_s2', repositoryKey: 'repo-a', rows: [{ kind: 'node', uri: fileUri, type: 'file', label: 'a.ts (revised)' }] });
    const count = await memory(projectId)._countNodes(projectId);
    expect(count).toBe(baseline + 1); // an upsert at the same id, not a second code node
    expect(nodesAfterFirst.coverage).toBeDefined();
  });

  it('an entity absent from the new active generation stops appearing as current (edges severed), but its node row survives by uri', async () => {
    const { projectId } = await newOwnedProject('pm-262-retire@example.com', 'PM62RET');
    const keptUri = buildEntityUri({ kind: 'file', projectKey: 'PM62RET', repositoryKey: 'repo-a', path: 'kept.ts' });
    const removedUri = buildEntityUri({ kind: 'file', projectKey: 'PM62RET', repositoryKey: 'repo-a', path: 'removed.ts' });
    await stageAndProject(projectId, {
      generationId: 'gen_r1', repositoryKey: 'repo-a',
      rows: [
        { kind: 'node', uri: keptUri, type: 'file', label: 'kept.ts' },
        { kind: 'node', uri: removedUri, type: 'file', label: 'removed.ts' },
        { kind: 'edge', type: 'imports', from: keptUri, to: removedUri },
      ],
    });
    let neighborhood = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: keptUri, edgeTypes: ['imports'] });
    expect(neighborhood.downstream.map((n) => n.uri)).toEqual([removedUri]);

    const result = await stageAndProject(projectId, {
      generationId: 'gen_r2', repositoryKey: 'repo-a',
      rows: [{ kind: 'node', uri: keptUri, type: 'file', label: 'kept.ts' }],
    });
    expect(result.retired).toBe(1);

    // Retired: no longer reachable via traversal.
    neighborhood = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: keptUri, edgeTypes: ['imports'] });
    expect(neighborhood.downstream).toEqual([]);
    // Survives: the node itself still resolves as a seed (historical citation-by-uri intact).
    const removedAsSeed = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: removedUri });
    expect(removedAsSeed.coverage.reasons).not.toContain('seed-not-found');
  });

  it('commonly_changes_with edges are labelled observed-correlation, distinct from a real dependency', async () => {
    const { projectId } = await newOwnedProject('pm-262-cochange@example.com', 'PM62COC');
    const aUri = buildEntityUri({ kind: 'file', projectKey: 'PM62COC', repositoryKey: 'repo-a', path: 'a.ts' });
    const bUri = buildEntityUri({ kind: 'file', projectKey: 'PM62COC', repositoryKey: 'repo-a', path: 'b.ts' });
    // gen_c1 has NO files — gen_c2 then introduces a.ts and b.ts TOGETHER, so both are "changed"
    // relative to gen_c1 and nothing else is, giving exactly one pair.
    await stageAndProject(projectId, { generationId: 'gen_c1', repositoryKey: 'repo-a', fileCount: 0, rows: [] });
    const result = await stageAndProject(projectId, {
      generationId: 'gen_c2', repositoryKey: 'repo-a',
      rows: [
        { kind: 'node', uri: aUri, type: 'file', label: 'a.ts' },
        { kind: 'node', uri: bUri, type: 'file', label: 'b.ts' },
      ],
    });
    expect(result.coChangeEdges).toBe(1);
    const neighborhood = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: aUri, edgeTypes: ['commonly_changes_with'] });
    expect(neighborhood.downstream.map((n) => n.uri)).toEqual([bUri]);
    // Never presented as a real dependency — depends_on/imports/calls (the default edge set)
    // finds nothing between them.
    const asDependency = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: aUri });
    expect(asDependency.downstream).toEqual([]);
  });

  it('projecting a generation with many entities emits ONE summary memory event, not one per entity', async () => {
    const { projectId } = await newOwnedProject('pm-262-bulk@example.com', 'PM62BLK');
    const rows: StagedRow[] = Array.from({ length: 20 }, (_, i) => ({
      kind: 'node' as const, uri: buildEntityUri({ kind: 'file', projectKey: 'PM62BLK', repositoryKey: 'repo-a', path: `f${i}.ts` }), type: 'file', label: `f${i}.ts`,
    }));
    await memory(projectId).runProjector(projectId);
    const baseline = await memory(projectId)._countNodes(projectId);
    const before = await memory(projectId).health(projectId);
    await stageAndProject(projectId, { generationId: 'gen_bulk', repositoryKey: 'repo-a', rows });
    const after = await memory(projectId).health(projectId);
    expect((after.tableCounts.outbox ?? 0) - (before.tableCounts.outbox ?? 0)).toBe(1);
    expect(await memory(projectId)._countNodes(projectId)).toBe(baseline + 20);
  });

  it('a malformed staged entity (bad type) is skipped rather than aborting the whole projection', async () => {
    const { projectId } = await newOwnedProject('pm-262-badtype@example.com', 'PM62BADT');
    const goodUri = buildEntityUri({ kind: 'file', projectKey: 'PM62BADT', repositoryKey: 'repo-a', path: 'good.ts' });
    const result = await stageAndProject(projectId, {
      generationId: 'gen_bad', repositoryKey: 'repo-a', fileCount: 1,
      rows: [
        { kind: 'node', uri: goodUri, type: 'file', label: 'good.ts' },
        { kind: 'node', uri: 'noriq://file/PM62BADT/repo-a/bad.ts', type: 'not-a-real-type', label: 'bad.ts' },
      ],
    });
    expect(result.nodesWritten).toBe(1);
    expect(result.entitiesSkipped).toBe(1);
  });

  it('projecting a non-active generation is refused', async () => {
    const { projectId } = await newOwnedProject('pm-262-notactive@example.com', 'PM62NOT');
    const m = memory(projectId);
    await m.beginIndexIngest(projectId, baseManifest({ generationId: 'gen_pending', projectId, repositoryKey: 'repo-a' }));
    await expect(m.projectActiveGeneration(projectId, 'gen_pending')).rejects.toThrow(/only an active generation/);
    await expect(m.projectActiveGeneration(projectId, 'gen_nonexistent')).rejects.toThrow(/not found/);
  });
});

// PLNR-283: recordMemory's own graph node + evidence-cited edges, the widened coordination
// projector's rebuild backfill, and the URI-parity retrieval needs (PLNR-284/286).
describe('recordMemory writes its own node and typed edges to cited entities (PLNR-283)', () => {
  it('evidence citing a task and a doc creates the memory node and both edges in ONE transaction with ONE outbox row, reachable from the task in one hop', async () => {
    const { token, projectId } = await newOwnedProject('pm-283-evidence@example.com', 'PM283EV');
    const task = await mcpCall(token, 'create_task', { projectId, title: 'cited task', tags: ['pm-283'], allowNewTags: true });
    if (task.isError) throw new Error(`create_task failed: ${task.text}`);
    const taskId = task.body.id as string;
    const doc = await mcpCall(token, 'create_doc', { projectId, name: 'cited doc', body: 'a settled decision, written down.' });
    if (doc.isError) throw new Error(`create_doc failed: ${doc.text}`);
    const docId = doc.body.id as string;

    const before = await memory(projectId).health(projectId);
    const { memoryId } = await memory(projectId).recordMemory(projectId, {
      kind: 'learning',
      statement: 'observed while working the cited task, backed by the cited doc',
      evidence: [{ kind: 'task', id: taskId }, { kind: 'artifact', id: docId }],
      actor: SYSTEM,
    });
    const after = await memory(projectId).health(projectId);
    // ONE outbox row for the whole write — memory_item + node + two edges, not four.
    expect((after.tableCounts.outbox ?? 0) - (before.tableCounts.outbox ?? 0)).toBe(1);

    const memoryUri = buildEntityUri({ kind: 'memory', id: memoryId });
    const taskUri = buildEntityUri({ kind: 'task', id: taskId });
    const docUri = buildEntityUri({ kind: 'artifact', id: docId });

    const fromTask = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: taskUri, edgeTypes: ['observed_in'] });
    expect(fromTask.upstream.map((n) => n.uri)).toContain(memoryUri);
    const fromDoc = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: docUri, edgeTypes: ['observed_in'] });
    expect(fromDoc.upstream.map((n) => n.uri)).toContain(memoryUri);

    // Provenance names the citation that caused each edge (locked decision's own grammar).
    expect(await memory(projectId)._edgeProvenance(projectId, 'observed_in', memoryUri, taskUri)).toMatch(/^evidence:/);
    expect(await memory(projectId)._edgeProvenance(projectId, 'observed_in', memoryUri, docUri)).toMatch(/^evidence:/);
  });

  it('a memory with no evidence still gets its own node', async () => {
    const { projectId } = await newOwnedProject('pm-283-bare@example.com', 'PM283BR');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'unknown', statement: 'an unattached observation', actor: SYSTEM });
    const uri = buildEntityUri({ kind: 'memory', id: memoryId });
    const neighborhood = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: uri });
    expect(neighborhood.coverage.reasons).not.toContain('seed-not-found');
  });

  it('a search hit for the memory carries the SAME uri its graph node was written under', async () => {
    const { projectId } = await newOwnedProject('pm-283-uriparity@example.com', 'PM283UP');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'decision', statement: 'a URI-parity probe memory', actor: SYSTEM });
    const { results } = await memory(projectId).searchProjectMemory(projectId, { memoryItemId: memoryId });
    const hit = results.find((r) => r.entityType === 'memory' && r.id === memoryId);
    expect(hit?.uri).toBe(buildEntityUri({ kind: 'memory', id: memoryId }));
  });

  it('a repository citation still writes its evidence row AND now also a file node/edge', async () => {
    const { projectId } = await newOwnedProject('pm-283-repo-evidence@example.com', 'PM283RE');
    const { memoryId } = await memory(projectId).recordMemory(projectId, {
      kind: 'learning',
      statement: 'observed in this file',
      evidence: [{ repositoryKey: 'repo-a', branch: 'main', baseId: 'sha_1', path: 'src/a.ts', symbol: 'foo' }],
      actor: SYSTEM,
    });
    const fileUri = buildEntityUri({ kind: 'file', projectKey: 'PM283RE', repositoryKey: 'repo-a', path: 'src/a.ts' });
    const memoryUri = buildEntityUri({ kind: 'memory', id: memoryId });
    const fromFile = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: fileUri, edgeTypes: ['observed_in'] });
    expect(fromFile.upstream.map((n) => n.uri)).toContain(memoryUri);
  });
});

describe('rebuildProjection — idempotent full-state backfill (PLNR-283)', () => {
  it('projects plans/docs/milestones/agents and the task<->plan/task<->doc relationships the board already knows; re-running changes nothing', async () => {
    const { token, projectId } = await newOwnedProject('pm-283-rebuild@example.com', 'PM283RB');
    const task = await mcpCall(token, 'create_task', { projectId, title: 'rebuild task', tags: ['pm-283'], allowNewTags: true });
    if (task.isError) throw new Error(`create_task failed: ${task.text}`);
    const taskId = task.body.id as string;

    const doc = await mcpCall(token, 'create_doc', { projectId, name: 'rebuild doc', body: 'a settled fact.' });
    if (doc.isError) throw new Error(`create_doc failed: ${doc.text}`);
    const docId = doc.body.id as string;
    const linked = await mcpCall(token, 'update_task', { projectId, taskId, docIds: [docId] });
    if (linked.isError) throw new Error(`update_task(docIds) failed: ${linked.text}`);

    const plan = await mcpCall(token, 'create_plan', { projectId, title: 'rebuild plan', phases: [{ title: 'phase 1', taskIds: [taskId] }] });
    if (plan.isError) throw new Error(`create_plan failed: ${plan.text}`);
    const planId = plan.body.id as string;

    const milestone = await mcpCall(token, 'create_milestone', { projectId, title: 'rebuild milestone' });
    if (milestone.isError) throw new Error(`create_milestone failed: ${milestone.text}`);

    const first = await memory(projectId).rebuildProjection(projectId);
    expect(first.nodesWritten).toBeGreaterThan(0);
    expect(first.edgesWritten).toBeGreaterThanOrEqual(2); // at least task<->plan and task<->doc

    const taskUri = buildEntityUri({ kind: 'task', id: taskId });
    const planUri = buildEntityUri({ kind: 'plan', id: planId });
    const docUri = buildEntityUri({ kind: 'artifact', id: docId });
    const toPlanAndDoc = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: taskUri, edgeTypes: ['related_to'] });
    expect(toPlanAndDoc.downstream.map((n) => n.uri).sort()).toEqual([docUri, planUri].sort());

    const nodesAfterFirst = await memory(projectId)._countNodes(projectId);
    const edgesAfterFirst = await memory(projectId)._countEdges(projectId);

    const second = await memory(projectId).rebuildProjection(projectId);
    expect(second).toEqual(first); // identical counts, re-running is a pure no-op count-wise
    expect(await memory(projectId)._countNodes(projectId)).toBe(nodesAfterFirst);
    expect(await memory(projectId)._countEdges(projectId)).toBe(edgesAfterFirst);
  });

  it('a project with no repository index and no episodes still produces a connected graph from memories, tasks, plans and docs alone', async () => {
    const { token, projectId } = await newOwnedProject('pm-283-connected@example.com', 'PM283CN');
    const task = await mcpCall(token, 'create_task', { projectId, title: 'connected task', tags: ['pm-283'], allowNewTags: true });
    if (task.isError) throw new Error(`create_task failed: ${task.text}`);
    const taskId = task.body.id as string;
    const plan = await mcpCall(token, 'create_plan', { projectId, title: 'connected plan', phases: [{ title: 'phase 1', taskIds: [taskId] }] });
    if (plan.isError) throw new Error(`create_plan failed: ${plan.text}`);
    const planId = plan.body.id as string;

    await memory(projectId).recordMemory(projectId, {
      kind: 'learning',
      statement: 'a memory about the connected task',
      evidence: [{ kind: 'task', id: taskId }],
      actor: SYSTEM,
    });
    await memory(projectId).rebuildProjection(projectId);

    // memory -> task -> plan, all reachable without a code-graph or episode ever existing.
    const memoryToTask = await memory(projectId).dependencyNeighborhood(projectId, {
      entityUri: buildEntityUri({ kind: 'task', id: taskId }), edgeTypes: ['observed_in'],
    });
    expect(memoryToTask.upstream.length).toBeGreaterThan(0);
    const taskToPlan = await memory(projectId).dependencyNeighborhood(projectId, {
      entityUri: buildEntityUri({ kind: 'task', id: taskId }), edgeTypes: ['related_to'],
    });
    expect(taskToPlan.downstream.map((n) => n.uri)).toContain(buildEntityUri({ kind: 'plan', id: planId }));
  });
});

// PLNR-316: applyCoordinationEvent draws edges, not just stars — the coordination projector's
// mechanism (mapCoordinationEvent returning edges too, applyCoordinationEvent upserting both
// endpoints and linking/unlinking) proven on the verbs whose payload is genuinely complete.
describe('mapCoordinationEvent — pure mapping (PLNR-316)', () => {
  it('task.claimed projects an owned_by edge from the task to the agent, no top-level node', () => {
    const projected = mapCoordinationEvent({
      verb: 'task.claimed', subjectId: 'task_abc', payload: { key: 'PM-1', title: 'a task', agentId: 'agt_xyz', expiresAt: '2026-01-01T00:00:00.000Z' },
    });
    expect(projected).toEqual({
      node: null,
      edges: [{
        type: 'owned_by',
        from: { type: 'task', uri: buildEntityUri({ kind: 'task', id: 'task_abc' }), label: 'a task' },
        to: { type: 'agent', uri: buildEntityUri({ kind: 'agent', id: 'agt_xyz' }), label: 'agt_xyz' },
        op: 'link',
        provenance: 'event:task.claimed',
      }],
    });
  });

  it('task.claimed from a run-minted claim (no key/title in the payload) still projects, task labelled by its own id', () => {
    // ProjectRoom.ts's claimAnchorTaskForRun emits exactly this shape — no key/title.
    const projected = mapCoordinationEvent({ verb: 'task.claimed', subjectId: 'task_abc', payload: { agentId: 'agt_xyz', expiresAt: 'x', by: 'run' } });
    expect(projected?.edges[0]?.from.label).toBe('task_abc');
  });

  it('task.released projects the SAME edge type as an unlink, keyed off previousHolder (not `by`)', () => {
    const projected = mapCoordinationEvent({
      verb: 'task.released',
      subjectId: 'task_abc',
      payload: { key: 'PM-1', title: 'a task', by: 'agt_human_override', previousHolder: 'agt_xyz', toStatus: 'review' },
    });
    expect(projected).toEqual({
      node: null,
      edges: [{
        type: 'owned_by',
        from: { type: 'task', uri: buildEntityUri({ kind: 'task', id: 'task_abc' }), label: 'a task' },
        to: { type: 'agent', uri: buildEntityUri({ kind: 'agent', id: 'agt_xyz' }), label: 'agt_xyz' },
        op: 'unlink',
        provenance: 'event:task.released',
      }],
    });
  });

  it('task.released with no live holder (defensive — should not occur in practice) projects nothing', () => {
    expect(mapCoordinationEvent({ verb: 'task.released', subjectId: 'task_abc', payload: { previousHolder: null } })).toBeNull();
  });

  // PLNR-322: the payloads are widened with an id (`dependsOnId`/`anchorId`) alongside the
  // pre-existing key/type fields — see mapCoordinationEvent's own doc comment for why PLNR-316
  // could not build these edges from the OLD shape, and why the old shape is still accepted
  // (the existing fields are untouched, additive only).
  it('dependency.added projects a depends_on edge from the dependent task to its blocker, both keyed by id', () => {
    const projected = mapCoordinationEvent({
      verb: 'dependency.added', subjectId: 'task_abc', payload: { key: 'PM-1', dependsOn: 'PM-2', dependsOnId: 'task_def' },
    });
    expect(projected).toEqual({
      node: null,
      edges: [{
        type: 'depends_on',
        from: { type: 'task', uri: buildEntityUri({ kind: 'task', id: 'task_abc' }), label: 'PM-1' },
        to: { type: 'task', uri: buildEntityUri({ kind: 'task', id: 'task_def' }), label: 'PM-2' },
        op: 'link',
        provenance: 'event:dependency.added',
      }],
    });
  });

  it('dependency.removed projects the SAME edge as an unlink', () => {
    const projected = mapCoordinationEvent({
      verb: 'dependency.removed', subjectId: 'task_abc', payload: { key: 'PM-1', dependsOn: 'PM-2', dependsOnId: 'task_def' },
    });
    expect(projected).toEqual({
      node: null,
      edges: [{
        type: 'depends_on',
        from: { type: 'task', uri: buildEntityUri({ kind: 'task', id: 'task_abc' }), label: 'PM-1' },
        to: { type: 'task', uri: buildEntityUri({ kind: 'task', id: 'task_def' }), label: 'PM-2' },
        op: 'unlink',
        provenance: 'event:dependency.removed',
      }],
    });
  });

  it('dependency.added with no dependsOnId (pre-widening payload, defensive) projects nothing', () => {
    expect(mapCoordinationEvent({ verb: 'dependency.added', subjectId: 'task_abc', payload: { key: 'PM-1', dependsOn: 'PM-2' } })).toBeNull();
  });

  it('a CROSS-PROJECT dependency.added (dependsOnProjectId present) projects no edge — a foreign task would be an unreachable stub star', () => {
    const projected = mapCoordinationEvent({
      verb: 'dependency.added',
      subjectId: 'task_abc',
      payload: { key: 'PM-1', dependsOn: 'OTH-1', dependsOnId: 'task_foreign', dependsOnProjectId: 'prj_other' },
    });
    expect(projected).toEqual({ node: null, edges: [] });
  });

  it('run.created projects its own run node, labelled by kind', () => {
    const projected = mapCoordinationEvent({
      verb: 'run.created', subjectId: 'run_abc', payload: { kind: 'build', agentTool: 'claude', repoRef: 'main', anchor: null, anchorId: null },
    });
    expect(projected).toEqual({
      node: { type: 'run', uri: buildEntityUri({ kind: 'run', id: 'run_abc' }), label: 'build run' },
      edges: [],
    });
  });

  it('an anchored run.created ALSO projects a related_to edge from the run to its anchor task', () => {
    const projected = mapCoordinationEvent({
      verb: 'run.created', subjectId: 'run_abc', payload: { kind: 'build', agentTool: 'claude', repoRef: 'main', anchor: 'task', anchorId: 'task_anchor' },
    });
    expect(projected).toEqual({
      node: { type: 'run', uri: buildEntityUri({ kind: 'run', id: 'run_abc' }), label: 'build run' },
      edges: [{
        type: 'related_to',
        from: { type: 'run', uri: buildEntityUri({ kind: 'run', id: 'run_abc' }), label: 'build run' },
        to: { type: 'task', uri: buildEntityUri({ kind: 'task', id: 'task_anchor' }), label: 'task_anchor' },
        op: 'link',
        provenance: 'event:run.created',
      }],
    });
  });

  it('a plan-anchored run.created edges to a plan node, not a task node', () => {
    const projected = mapCoordinationEvent({
      verb: 'run.created', subjectId: 'run_abc', payload: { kind: 'scope', agentTool: 'codex', repoRef: 'main', anchor: 'plan', anchorId: 'plan_anchor' },
    });
    expect(projected?.edges[0]?.to).toEqual({ type: 'plan', uri: buildEntityUri({ kind: 'plan', id: 'plan_anchor' }), label: 'plan_anchor' });
  });

  it('dependency.unblocked still projects nothing — no new relationship (the depends_on edge already exists; unblocking is a readiness change, not a graph change)', () => {
    expect(mapCoordinationEvent({ verb: 'dependency.unblocked', subjectId: 'task_abc', payload: { key: 'PM-1', title: 'a task', blockerKey: 'PM-2' } })).toBeNull();
  });
});

describe('applyCoordinationEvent draws edges end to end (PLNR-316)', () => {
  it('claiming a task through ProjectRoom and running the projector produces an owned_by edge, no manual rebuild', async () => {
    const { token, projectId } = await newOwnedProject('pm-316-claim@example.com', 'PM316CL');
    const task = await mcpCall(token, 'create_task', { projectId, title: 'claim-edge task', tags: ['pm-316'], allowNewTags: true });
    if (task.isError) throw new Error(`create_task failed: ${task.text}`);
    const taskId = task.body.id as string;
    const claim = await mcpCall(token, 'claim_task', { projectId, taskId });
    if (claim.isError) throw new Error(`claim_task failed: ${claim.text}`);

    const { agentId } = await appEnv.DB.prepare('SELECT claimed_by AS agentId FROM tasks WHERE id = ?')
      .bind(taskId).first<{ agentId: string }>() ?? {};
    expect(agentId).toBeTruthy();

    const first = await memory(projectId).runProjector(projectId);
    expect(first.applied).toBeGreaterThan(0);

    const taskUri = buildEntityUri({ kind: 'task', id: taskId });
    const agentUri = buildEntityUri({ kind: 'agent', id: agentId! });
    const neighborhood = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: taskUri, edgeTypes: ['owned_by'] });
    expect(neighborhood.downstream.map((n) => n.uri)).toEqual([agentUri]);
    expect(await memory(projectId)._edgeProvenance(projectId, 'owned_by', taskUri, agentUri)).toBe('event:task.claimed');

    // The agent's own node was never separately created by any event (agent.registered is
    // never emitted) — it was STUBBED as this edge's endpoint, labelled with its own id.
    const agentAsSeed = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: agentUri });
    expect(agentAsSeed.coverage.reasons).not.toContain('seed-not-found');

    // Idempotent: re-running the projector over the now-consumed range writes nothing new.
    const edgesAfterFirst = await memory(projectId)._countEdges(projectId);
    const second = await memory(projectId).runProjector(projectId);
    expect(second.applied).toBe(0);
    expect(await memory(projectId)._countEdges(projectId)).toBe(edgesAfterFirst);
  });

  it('releasing the task unlinks the owned_by edge; the agent stub node survives', async () => {
    const { token, projectId } = await newOwnedProject('pm-316-release@example.com', 'PM316RL');
    const task = await mcpCall(token, 'create_task', { projectId, title: 'release-edge task', tags: ['pm-316'], allowNewTags: true });
    if (task.isError) throw new Error(`create_task failed: ${task.text}`);
    const taskId = task.body.id as string;
    const claim = await mcpCall(token, 'claim_task', { projectId, taskId });
    if (claim.isError) throw new Error(`claim_task failed: ${claim.text}`);
    const { agentId } = await appEnv.DB.prepare('SELECT claimed_by AS agentId FROM tasks WHERE id = ?')
      .bind(taskId).first<{ agentId: string }>() ?? {};

    // Project the claim first, so the edge genuinely exists before it is removed.
    await memory(projectId).runProjector(projectId);
    const taskUri = buildEntityUri({ kind: 'task', id: taskId });
    const agentUri = buildEntityUri({ kind: 'agent', id: agentId! });
    expect((await memory(projectId).dependencyNeighborhood(projectId, { entityUri: taskUri, edgeTypes: ['owned_by'] })).downstream.map((n) => n.uri)).toEqual([agentUri]);

    const release = await mcpCall(token, 'release_task', { projectId, taskId, toStatus: 'review' });
    if (release.isError) throw new Error(`release_task failed: ${release.text}`);
    const edgesBeforeUnlink = await memory(projectId)._countEdges(projectId);
    const applied = await memory(projectId).runProjector(projectId);
    expect(applied.applied).toBeGreaterThan(0);

    const afterRelease = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: taskUri, edgeTypes: ['owned_by'] });
    expect(afterRelease.downstream).toEqual([]);
    expect(await memory(projectId)._countEdges(projectId)).toBe(edgesBeforeUnlink - 1);

    // The agent node itself is untouched by the unlink — only the edge is gone.
    const agentAsSeed = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: agentUri });
    expect(agentAsSeed.coverage.reasons).not.toContain('seed-not-found');

    // Idempotent: re-running finds nothing left to unlink.
    const edgesAfterUnlink = await memory(projectId)._countEdges(projectId);
    const second = await memory(projectId).runProjector(projectId);
    expect(second.applied).toBe(0);
    expect(await memory(projectId)._countEdges(projectId)).toBe(edgesAfterUnlink);
  });
});

// PLNR-322: the widening PLNR-316 declined to guess at — ProjectRoom.ts now serializes
// dependsOnId/anchorId, so dependency.added/removed and run.created draw real edges too, and
// rebuildProjection is taught the same dependency edge so a repair rebuild does not drop it.
describe('dependency.added/removed draw real depends_on edges end to end (PLNR-322)', () => {
  it('add_dependency then the projector produces a depends_on edge from dependent to blocker; remove_dependency unlinks it', async () => {
    const { token, projectId } = await newOwnedProject('pm-322-dep@example.com', 'PM322DP');
    const dependent = await mcpCall(token, 'create_task', { projectId, title: 'dependent task', tags: ['pm-322'], allowNewTags: true });
    if (dependent.isError) throw new Error(`create_task failed: ${dependent.text}`);
    const blocker = await mcpCall(token, 'create_task', { projectId, title: 'blocker task', tags: ['pm-322'], allowNewTags: true });
    if (blocker.isError) throw new Error(`create_task failed: ${blocker.text}`);
    const dependentId = dependent.body.id as string;
    const blockerId = blocker.body.id as string;

    const add = await mcpCall(token, 'add_dependency', { projectId, taskId: dependentId, dependsOnTaskId: blockerId });
    if (add.isError) throw new Error(`add_dependency failed: ${add.text}`);

    const applied = await memory(projectId).runProjector(projectId);
    expect(applied.applied).toBeGreaterThan(0);

    const dependentUri = buildEntityUri({ kind: 'task', id: dependentId });
    const blockerUri = buildEntityUri({ kind: 'task', id: blockerId });
    const neighborhood = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: dependentUri, edgeTypes: ['depends_on'] });
    expect(neighborhood.downstream.map((n) => n.uri)).toEqual([blockerUri]);
    expect(await memory(projectId)._edgeProvenance(projectId, 'depends_on', dependentUri, blockerUri)).toBe('event:dependency.added');

    const remove = await mcpCall(token, 'remove_dependency', { projectId, taskId: dependentId, dependsOnTaskId: blockerId });
    if (remove.isError) throw new Error(`remove_dependency failed: ${remove.text}`);
    const edgesBeforeUnlink = await memory(projectId)._countEdges(projectId);
    const secondApplied = await memory(projectId).runProjector(projectId);
    expect(secondApplied.applied).toBeGreaterThan(0);

    const afterRemove = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: dependentUri, edgeTypes: ['depends_on'] });
    expect(afterRemove.downstream).toEqual([]);
    expect(await memory(projectId)._countEdges(projectId)).toBe(edgesBeforeUnlink - 1);
  });

  it('a CROSS-PROJECT dependency projects no edge in either project\'s graph — discretion: skip (a foreign task would be an unreachable stub star)', async () => {
    // Same owning user for both projects (dependencies.test.ts's own cross-project pattern) —
    // add_dependency's access check is per-USER project membership, not per-token/session.
    const a = await newOwnedProject('pm-322-cross@example.com', 'PM322CA');
    const dependent = await mcpCall(a.token, 'create_task', { projectId: a.projectId, title: 'cross-project dependent', tags: ['pm-322'], allowNewTags: true });
    if (dependent.isError) throw new Error(`create_task failed: ${dependent.text}`);
    const dependentId = dependent.body.id as string;

    const other = await mcpCall(a.token, 'create_project', { key: 'PM322CB', name: 'PM322CB project' });
    if (other.isError) throw new Error(`create_project failed: ${other.text}`);
    const otherProjectId = other.body.id as string;
    const blocker = await mcpCall(a.token, 'create_task', { projectId: otherProjectId, title: 'cross-project blocker', tags: ['pm-322'], allowNewTags: true });
    if (blocker.isError) throw new Error(`create_task failed: ${blocker.text}`);
    const blockerId = blocker.body.id as string;

    const add = await mcpCall(a.token, 'add_dependency', { projectId: a.projectId, taskId: dependentId, dependsOnTaskId: blockerId });
    if (add.isError) throw new Error(`add_dependency failed: ${add.text}`);

    const edgesBefore = await memory(a.projectId)._countEdges(a.projectId);
    const applied = await memory(a.projectId).runProjector(a.projectId);
    expect(applied.applied).toBeGreaterThan(0); // the event WAS consumed — just projected no edge
    expect(await memory(a.projectId)._countEdges(a.projectId)).toBe(edgesBefore);

    const dependentUri = buildEntityUri({ kind: 'task', id: dependentId });
    const neighborhood = await memory(a.projectId).dependencyNeighborhood(a.projectId, { entityUri: dependentUri, edgeTypes: ['depends_on'] });
    expect(neighborhood.downstream).toEqual([]);

    // rebuildProjection makes the identical choice — convergence, not just the incremental path.
    const rebuilt = await memory(a.projectId).rebuildProjection(a.projectId);
    expect(rebuilt.edgesWritten).toBe(0);
  });

  it('rebuildProjection produces the SAME depends_on edge the incremental path does, so a rebuild after incremental projection adds nothing new', async () => {
    const { token, projectId } = await newOwnedProject('pm-322-converge@example.com', 'PM322CV');
    const dependent = await mcpCall(token, 'create_task', { projectId, title: 'converge dependent', tags: ['pm-322'], allowNewTags: true });
    if (dependent.isError) throw new Error(`create_task failed: ${dependent.text}`);
    const blocker = await mcpCall(token, 'create_task', { projectId, title: 'converge blocker', tags: ['pm-322'], allowNewTags: true });
    if (blocker.isError) throw new Error(`create_task failed: ${blocker.text}`);
    const dependentId = dependent.body.id as string;
    const blockerId = blocker.body.id as string;
    const add = await mcpCall(token, 'add_dependency', { projectId, taskId: dependentId, dependsOnTaskId: blockerId });
    if (add.isError) throw new Error(`add_dependency failed: ${add.text}`);

    // Incremental first.
    await memory(projectId).runProjector(projectId);
    const dependentUri = buildEntityUri({ kind: 'task', id: dependentId });
    const blockerUri = buildEntityUri({ kind: 'task', id: blockerId });
    expect((await memory(projectId).dependencyNeighborhood(projectId, { entityUri: dependentUri, edgeTypes: ['depends_on'] })).downstream.map((n) => n.uri)).toEqual([blockerUri]);
    const edgesAfterIncremental = await memory(projectId)._countEdges(projectId);

    // A rebuild after incremental projection adds no NEW edge (stated acceptance) — the edge's
    // provenance stays the incremental writer's, since linkGraphEdge writes provenance only once.
    const rebuilt = await memory(projectId).rebuildProjection(projectId);
    expect(rebuilt.edgesWritten).toBeGreaterThan(0); // the rebuild still WROTE (attempted) the edge...
    expect(await memory(projectId)._countEdges(projectId)).toBe(edgesAfterIncremental); // ...but nothing NEW landed
    expect(await memory(projectId)._edgeProvenance(projectId, 'depends_on', dependentUri, blockerUri)).toBe('event:dependency.added');
  });

  it('rebuildProjection alone (no incremental projector run) still produces the depends_on edge, tagged with its own provenance', async () => {
    const { token, projectId } = await newOwnedProject('pm-322-rebuild-only@example.com', 'PM322RO');
    const dependent = await mcpCall(token, 'create_task', { projectId, title: 'rebuild-only dependent', tags: ['pm-322'], allowNewTags: true });
    if (dependent.isError) throw new Error(`create_task failed: ${dependent.text}`);
    const blocker = await mcpCall(token, 'create_task', { projectId, title: 'rebuild-only blocker', tags: ['pm-322'], allowNewTags: true });
    if (blocker.isError) throw new Error(`create_task failed: ${blocker.text}`);
    const dependentId = dependent.body.id as string;
    const blockerId = blocker.body.id as string;
    const add = await mcpCall(token, 'add_dependency', { projectId, taskId: dependentId, dependsOnTaskId: blockerId });
    if (add.isError) throw new Error(`add_dependency failed: ${add.text}`);

    const rebuilt = await memory(projectId).rebuildProjection(projectId);
    expect(rebuilt.edgesWritten).toBeGreaterThan(0);
    const dependentUri = buildEntityUri({ kind: 'task', id: dependentId });
    const blockerUri = buildEntityUri({ kind: 'task', id: blockerId });
    expect((await memory(projectId).dependencyNeighborhood(projectId, { entityUri: dependentUri, edgeTypes: ['depends_on'] })).downstream.map((n) => n.uri)).toEqual([blockerUri]);
    expect(await memory(projectId)._edgeProvenance(projectId, 'depends_on', dependentUri, blockerUri)).toBe('coordination:dependencies');
  });
});

describe('run.created draws a run node and a related_to edge to its anchor end to end (PLNR-322)', () => {
  it('a task-anchored run projects a run node and an edge to the task', async () => {
    const { token, projectId } = await newOwnedProject('pm-322-run@example.com', 'PM322RN');
    const task = await mcpCall(token, 'create_task', { projectId, title: 'anchor task', tags: ['pm-322'], allowNewTags: true });
    if (task.isError) throw new Error(`create_task failed: ${task.text}`);
    const taskId = task.body.id as string;

    const run = await room(projectId).createRun(projectId, SYSTEM_ACTOR, {
      kind: 'build', repoRef: 'repo_a', agentTool: 'claude', anchor: { type: 'task', id: taskId },
    } as CreateRunInput);

    const applied = await memory(projectId).runProjector(projectId);
    expect(applied.applied).toBeGreaterThan(0);

    const runUri = buildEntityUri({ kind: 'run', id: run.id });
    const taskUri = buildEntityUri({ kind: 'task', id: taskId });
    const neighborhood = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: runUri, edgeTypes: ['related_to'] });
    expect(neighborhood.downstream.map((n) => n.uri)).toEqual([taskUri]);
    expect(await memory(projectId)._edgeProvenance(projectId, 'related_to', runUri, taskUri)).toBe('event:run.created');

    // The run node itself is independently addressable (not just a dangling edge endpoint).
    const runAsSeed = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: runUri });
    expect(runAsSeed.coverage.reasons).not.toContain('seed-not-found');
  });

  it('an UNANCHORED run projects just the run node, no edge', async () => {
    const { projectId } = await newOwnedProject('pm-322-run-bare@example.com', 'PM322RB');
    const run = await room(projectId).createRun(projectId, SYSTEM_ACTOR, {
      kind: 'scope', repoRef: 'repo_a', agentTool: 'codex',
    } as CreateRunInput);

    const edgesBefore = await memory(projectId)._countEdges(projectId);
    await memory(projectId).runProjector(projectId);
    expect(await memory(projectId)._countEdges(projectId)).toBe(edgesBefore);

    const runUri = buildEntityUri({ kind: 'run', id: run.id });
    const runAsSeed = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: runUri });
    expect(runAsSeed.coverage.reasons).not.toContain('seed-not-found');
  });
});

// PLNR-319: the root cause of the empty map — phase_tasks ("task joined a plan phase") and
// task_docs ("doc attached to a task") were written in six-plus ProjectRoom.ts sites and NEVER
// named by an event, so `rebuildProjection`'s live D1 read was the only source of these edges.
// `plan.tasks_linked`/`plan.tasks_unlinked` and `task.docs_linked`/`task.docs_unlinked` close
// that gap: same `related_to` edge type, same task -> plan / task -> doc direction
// rebuildProjection already draws — only the provenance grammar differs (`event:<verb>` vs
// `coordination:phase_tasks`/`coordination:task_docs`), the same precedent dependency.added and
// run.created already set two tasks ago.
const HUMAN_ACTOR: Actor = { kind: 'human', id: 'usr_pm319', name: 'PM319 Tester' };

describe('mapCoordinationEvent — plan.tasks_linked/unlinked, task.docs_linked/unlinked (PLNR-319)', () => {
  it('plan.tasks_linked projects one related_to edge PER LINK in the payload, task -> plan', () => {
    const projected = mapCoordinationEvent({
      verb: 'plan.tasks_linked',
      subjectId: 'plan_abc',
      payload: {
        planTitle: 'Q3 plan',
        links: [
          { taskId: 'task_1', taskTitle: 'first', planId: 'plan_abc', planTitle: 'Q3 plan' },
          { taskId: 'task_2', taskTitle: 'second', planId: 'plan_abc', planTitle: 'Q3 plan' },
        ],
      },
    });
    expect(projected).toEqual({
      node: null,
      edges: [
        {
          type: 'related_to',
          from: { type: 'task', uri: buildEntityUri({ kind: 'task', id: 'task_1' }), label: 'first' },
          to: { type: 'plan', uri: buildEntityUri({ kind: 'plan', id: 'plan_abc' }), label: 'Q3 plan' },
          op: 'link',
          provenance: 'event:plan.tasks_linked',
        },
        {
          type: 'related_to',
          from: { type: 'task', uri: buildEntityUri({ kind: 'task', id: 'task_2' }), label: 'second' },
          to: { type: 'plan', uri: buildEntityUri({ kind: 'plan', id: 'plan_abc' }), label: 'Q3 plan' },
          op: 'link',
          provenance: 'event:plan.tasks_linked',
        },
      ],
    });
  });

  it('plan.tasks_unlinked projects the same shape with op: unlink; a missing label falls back to the bare id', () => {
    const projected = mapCoordinationEvent({
      verb: 'plan.tasks_unlinked',
      subjectId: 'plan_abc',
      payload: { links: [{ taskId: 'task_1', planId: 'plan_abc' }] },
    });
    expect(projected?.edges).toHaveLength(1);
    expect(projected?.edges[0]).toMatchObject({ op: 'unlink', provenance: 'event:plan.tasks_unlinked' });
    expect(projected?.edges[0]?.from.label).toBe('task_1');
    expect(projected?.edges[0]?.to.label).toBe('plan_abc');
  });

  it('task.docs_linked/unlinked mirror the same shape, task -> doc (the artifact node type)', () => {
    const linked = mapCoordinationEvent({
      verb: 'task.docs_linked',
      subjectId: 'task_1',
      payload: { taskTitle: 'a task', links: [{ taskId: 'task_1', taskTitle: 'a task', docId: 'doc_1', docLabel: 'design doc' }] },
    });
    expect(linked).toEqual({
      node: null,
      edges: [{
        type: 'related_to',
        from: { type: 'task', uri: buildEntityUri({ kind: 'task', id: 'task_1' }), label: 'a task' },
        to: { type: 'artifact', uri: buildEntityUri({ kind: 'artifact', id: 'doc_1' }), label: 'design doc' },
        op: 'link',
        provenance: 'event:task.docs_linked',
      }],
    });

    const unlinked = mapCoordinationEvent({
      verb: 'task.docs_unlinked',
      subjectId: 'task_1',
      payload: { links: [{ taskId: 'task_1', docId: 'doc_1' }] },
    });
    expect(unlinked?.edges[0]).toMatchObject({ op: 'unlink', provenance: 'event:task.docs_unlinked' });
  });

  it('a non-array payload projects nothing; a malformed link item is skipped, not the whole event', () => {
    expect(mapCoordinationEvent({ verb: 'plan.tasks_linked', subjectId: 'plan_abc', payload: {} })).toBeNull();
    const projected = mapCoordinationEvent({
      verb: 'task.docs_linked',
      subjectId: 'task_1',
      payload: { links: [{ taskId: 'task_1' /* no docId */ }, { taskId: 'task_2', docId: 'doc_2' }] },
    });
    expect(projected?.edges).toHaveLength(1);
  });
});

describe('phase_tasks/task_docs draw real edges end to end, converging with rebuildProjection (PLNR-319)', () => {
  it('create_task with docIds produces a task -> doc edge with no manual rebuild, and a rebuild afterwards adds nothing new', async () => {
    const { token, projectId } = await newOwnedProject('pm-319-doc@example.com', 'PM319DC');
    const doc = await mcpCall(token, 'create_doc', { projectId, name: 'design doc', body: 'The API returns JSON. This is settled.' });
    if (doc.isError) throw new Error(`create_doc failed: ${doc.text}`);
    const docId = doc.body.id as string;
    const task = await mcpCall(token, 'create_task', { projectId, title: 'doc-linked task', docIds: [docId], tags: ['pm-319'], allowNewTags: true });
    if (task.isError) throw new Error(`create_task failed: ${task.text}`);
    const taskId = task.body.id as string;

    const applied = await memory(projectId).runProjector(projectId);
    expect(applied.applied).toBeGreaterThan(0);

    const taskUri = buildEntityUri({ kind: 'task', id: taskId });
    const docUri = buildEntityUri({ kind: 'artifact', id: docId });
    const neighborhood = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: taskUri, edgeTypes: ['related_to'] });
    expect(neighborhood.downstream.map((n) => n.uri)).toEqual([docUri]);
    expect(await memory(projectId)._edgeProvenance(projectId, 'related_to', taskUri, docUri)).toBe('event:task.docs_linked');

    // Convergence (stated acceptance): rebuildProjection still WRITES (attempts) the same
    // triple, but nothing NEW lands, and provenance stays the incremental writer's.
    const edgesBefore = await memory(projectId)._countEdges(projectId);
    const rebuilt = await memory(projectId).rebuildProjection(projectId);
    expect(rebuilt.edgesWritten).toBeGreaterThan(0);
    expect(await memory(projectId)._countEdges(projectId)).toBe(edgesBefore);
    expect(await memory(projectId)._edgeProvenance(projectId, 'related_to', taskUri, docUri)).toBe('event:task.docs_linked');
  });

  it('create_task with a phaseId produces a task -> plan edge', async () => {
    const { token, projectId } = await newOwnedProject('pm-319-phase@example.com', 'PM319PH');
    const plan = await mcpCall(token, 'create_plan', { projectId, title: 'phase plan', phases: [{ title: 'phase 1', newTasks: [{ title: 'seed task' }] }] });
    if (plan.isError) throw new Error(`create_plan failed: ${plan.text}`);
    const planId = plan.body.id as string;
    const phaseId = (plan.body.phases as Array<{ id: string }>)[0]!.id;

    const task = await mcpCall(token, 'create_task', { projectId, title: 'joins the phase', phaseId, tags: ['pm-319'], allowNewTags: true });
    if (task.isError) throw new Error(`create_task failed: ${task.text}`);
    const taskId = task.body.id as string;

    const applied = await memory(projectId).runProjector(projectId);
    expect(applied.applied).toBeGreaterThan(0);

    const taskUri = buildEntityUri({ kind: 'task', id: taskId });
    const planUri = buildEntityUri({ kind: 'plan', id: planId });
    const neighborhood = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: taskUri, edgeTypes: ['related_to'] });
    expect(neighborhood.downstream.map((n) => n.uri)).toEqual([planUri]);
    expect(await memory(projectId)._edgeProvenance(projectId, 'related_to', taskUri, planUri)).toBe('event:plan.tasks_linked');
  });

  it('create_plan with many tasks in one phase emits ONE plan.tasks_linked event, not one per task (§19)', async () => {
    const { token, projectId } = await newOwnedProject('pm-319-bulk@example.com', 'PM319BK');
    const newTasks = Array.from({ length: 6 }, (_, i) => ({ title: `bulk task ${i}` }));
    const plan = await mcpCall(token, 'create_plan', { projectId, title: 'bulk plan', phases: [{ title: 'phase 1', newTasks }] });
    if (plan.isError) throw new Error(`create_plan failed: ${plan.text}`);
    const planId = plan.body.id as string;
    const taskIds = (plan.body.phases as Array<{ taskIds: string[] }>)[0]!.taskIds;
    expect(taskIds).toHaveLength(6);

    const { results: linkEvents } = await appEnv.DB.prepare(
      `SELECT payload FROM events WHERE project_id = ? AND verb = 'plan.tasks_linked'`,
    ).bind(projectId).all<{ payload: string }>();
    expect(linkEvents).toHaveLength(1); // bounded: one event for the whole plan, not per task
    const links = JSON.parse(linkEvents[0]!.payload).links as unknown[];
    expect(links).toHaveLength(6);

    const applied = await memory(projectId).runProjector(projectId);
    expect(applied.applied).toBeGreaterThan(0);
    const planUri = buildEntityUri({ kind: 'plan', id: planId });
    const neighborhood = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: planUri, edgeTypes: ['related_to'] });
    expect(neighborhood.upstream.map((n) => n.uri).sort()).toEqual(taskIds.map((id) => buildEntityUri({ kind: 'task', id })).sort());
  });

  it('update_task addDocIds then removeDocIds adds then removes the edge', async () => {
    const { token, projectId } = await newOwnedProject('pm-319-attach@example.com', 'PM319AT');
    const doc = await mcpCall(token, 'create_doc', { projectId, name: 'attach doc', body: 'Settled: this document exists.' });
    if (doc.isError) throw new Error(`create_doc failed: ${doc.text}`);
    const docId = doc.body.id as string;
    const task = await mcpCall(token, 'create_task', { projectId, title: 'attach target', tags: ['pm-319'], allowNewTags: true });
    if (task.isError) throw new Error(`create_task failed: ${task.text}`);
    const taskId = task.body.id as string;

    const attach = await mcpCall(token, 'update_task', { projectId, taskId, addDocIds: [docId] });
    if (attach.isError) throw new Error(`update_task(addDocIds) failed: ${attach.text}`);

    await memory(projectId).runProjector(projectId);
    const taskUri = buildEntityUri({ kind: 'task', id: taskId });
    const docUri = buildEntityUri({ kind: 'artifact', id: docId });
    expect((await memory(projectId).dependencyNeighborhood(projectId, { entityUri: taskUri, edgeTypes: ['related_to'] })).downstream.map((n) => n.uri)).toEqual([docUri]);
    expect(await memory(projectId)._edgeProvenance(projectId, 'related_to', taskUri, docUri)).toBe('event:task.docs_linked');

    const detach = await mcpCall(token, 'update_task', { projectId, taskId, removeDocIds: [docId] });
    if (detach.isError) throw new Error(`update_task(removeDocIds) failed: ${detach.text}`);
    const edgesBeforeUnlink = await memory(projectId)._countEdges(projectId);
    const applied = await memory(projectId).runProjector(projectId);
    expect(applied.applied).toBeGreaterThan(0);
    expect((await memory(projectId).dependencyNeighborhood(projectId, { entityUri: taskUri, edgeTypes: ['related_to'] })).downstream).toEqual([]);
    expect(await memory(projectId)._countEdges(projectId)).toBe(edgesBeforeUnlink - 1);
  });

  it('update_plan structural restructure links a newly-added task and unlinks a removed one; a task kept in the SAME plan is untouched', async () => {
    const { token, projectId } = await newOwnedProject('pm-319-restruct@example.com', 'PM319RS');
    const t1 = await mcpCall(token, 'create_task', { projectId, title: 'stays', tags: ['pm-319'], allowNewTags: true });
    const t2 = await mcpCall(token, 'create_task', { projectId, title: 'leaves', tags: ['pm-319'], allowNewTags: true });
    const t3 = await mcpCall(token, 'create_task', { projectId, title: 'joins', tags: ['pm-319'], allowNewTags: true });
    if (t1.isError || t2.isError || t3.isError) throw new Error('create_task failed');
    const t1Id = t1.body.id as string;
    const t2Id = t2.body.id as string;
    const t3Id = t3.body.id as string;

    const plan = await mcpCall(token, 'create_plan', { projectId, title: 'restructure plan', phases: [{ title: 'phase 1', taskIds: [t1Id, t2Id] }] });
    if (plan.isError) throw new Error(`create_plan failed: ${plan.text}`);
    const planId = plan.body.id as string;
    const phaseId = (plan.body.phases as Array<{ id: string }>)[0]!.id;
    await memory(projectId).runProjector(projectId); // project the initial link event

    const restructure = await mcpCall(token, 'update_plan', {
      projectId, planId, phases: [{ id: phaseId, title: 'phase 1', taskIds: [t1Id, t3Id] }],
    });
    if (restructure.isError) throw new Error(`update_plan failed: ${restructure.text}`);

    const applied = await memory(projectId).runProjector(projectId);
    expect(applied.applied).toBeGreaterThan(0);

    const planUri = buildEntityUri({ kind: 'plan', id: planId });
    const t1Uri = buildEntityUri({ kind: 'task', id: t1Id });
    const t2Uri = buildEntityUri({ kind: 'task', id: t2Id });
    const t3Uri = buildEntityUri({ kind: 'task', id: t3Id });
    const upstreamUris = (await memory(projectId).dependencyNeighborhood(projectId, { entityUri: planUri, edgeTypes: ['related_to'] })).upstream.map((n) => n.uri).sort();
    expect(upstreamUris).toEqual([t1Uri, t3Uri].sort());
    expect(upstreamUris).not.toContain(t2Uri);
  });

  it('deleteTask unlinks its plan and doc edges (the task graph NODE itself is a pre-existing gap this task does not close)', async () => {
    const { token, projectId } = await newOwnedProject('pm-319-deltask@example.com', 'PM319DT');
    const doc = await mcpCall(token, 'create_doc', { projectId, name: 'del task doc', body: 'Settled: a fact.' });
    if (doc.isError) throw new Error(`create_doc failed: ${doc.text}`);
    const docId = doc.body.id as string;
    const plan = await mcpCall(token, 'create_plan', {
      projectId, title: 'del task plan', phases: [{ title: 'phase 1', newTasks: [{ title: 'to be deleted', docIds: [docId] }] }],
    });
    if (plan.isError) throw new Error(`create_plan failed: ${plan.text}`);
    const planId = plan.body.id as string;
    const taskId = (plan.body.phases as Array<{ taskIds: string[] }>)[0]!.taskIds[0]!;

    await memory(projectId).runProjector(projectId);
    const taskUri = buildEntityUri({ kind: 'task', id: taskId });
    const planUri = buildEntityUri({ kind: 'plan', id: planId });
    const docUri = buildEntityUri({ kind: 'artifact', id: docId });
    expect((await memory(projectId).dependencyNeighborhood(projectId, { entityUri: taskUri, edgeTypes: ['related_to'] })).downstream.map((n) => n.uri).sort())
      .toEqual([docUri, planUri].sort());

    await room(projectId).deleteTask(projectId, HUMAN_ACTOR, taskId);
    const applied = await memory(projectId).runProjector(projectId);
    expect(applied.applied).toBeGreaterThan(0);
    expect((await memory(projectId).dependencyNeighborhood(projectId, { entityUri: taskUri, edgeTypes: ['related_to'] })).downstream).toEqual([]);
  });

  it('deleteDoc unlinks every task it was attached to', async () => {
    const { token, projectId } = await newOwnedProject('pm-319-deldoc@example.com', 'PM319DD');
    const doc = await mcpCall(token, 'create_doc', { projectId, name: 'doomed doc', body: 'Settled: a fact.' });
    if (doc.isError) throw new Error(`create_doc failed: ${doc.text}`);
    const docId = doc.body.id as string;
    const task = await mcpCall(token, 'create_task', { projectId, title: 'attached to doomed doc', docIds: [docId], tags: ['pm-319'], allowNewTags: true });
    if (task.isError) throw new Error(`create_task failed: ${task.text}`);
    const taskId = task.body.id as string;

    await memory(projectId).runProjector(projectId);
    const taskUri = buildEntityUri({ kind: 'task', id: taskId });
    const docUri = buildEntityUri({ kind: 'artifact', id: docId });
    expect((await memory(projectId).dependencyNeighborhood(projectId, { entityUri: taskUri, edgeTypes: ['related_to'] })).downstream.map((n) => n.uri)).toEqual([docUri]);

    await room(projectId).deleteDoc(projectId, HUMAN_ACTOR, docId);
    const applied = await memory(projectId).runProjector(projectId);
    expect(applied.applied).toBeGreaterThan(0);
    expect((await memory(projectId).dependencyNeighborhood(projectId, { entityUri: taskUri, edgeTypes: ['related_to'] })).downstream).toEqual([]);
  });

  it('deletePlan unlinks every task still in it', async () => {
    const { token, projectId } = await newOwnedProject('pm-319-delplan@example.com', 'PM319DP2');
    const plan = await mcpCall(token, 'create_plan', { projectId, title: 'doomed plan', phases: [{ title: 'phase 1', newTasks: [{ title: 'member task' }] }] });
    if (plan.isError) throw new Error(`create_plan failed: ${plan.text}`);
    const planId = plan.body.id as string;
    const taskId = (plan.body.phases as Array<{ taskIds: string[] }>)[0]!.taskIds[0]!;

    await memory(projectId).runProjector(projectId);
    const taskUri = buildEntityUri({ kind: 'task', id: taskId });
    const planUri = buildEntityUri({ kind: 'plan', id: planId });
    expect((await memory(projectId).dependencyNeighborhood(projectId, { entityUri: taskUri, edgeTypes: ['related_to'] })).downstream.map((n) => n.uri)).toEqual([planUri]);

    await room(projectId).deletePlan(projectId, HUMAN_ACTOR, planId);
    const applied = await memory(projectId).runProjector(projectId);
    expect(applied.applied).toBeGreaterThan(0);
    expect((await memory(projectId).dependencyNeighborhood(projectId, { entityUri: taskUri, edgeTypes: ['related_to'] })).downstream).toEqual([]);
  });

  it('moveTask unlinks its plan and doc edges in the SOURCE project', async () => {
    const { token, projectId } = await newOwnedProject('pm-319-move@example.com', 'PM319MV');
    const other = await mcpCall(token, 'create_project', { key: 'PM319MVT', name: 'move target' });
    if (other.isError) throw new Error(`create_project failed: ${other.text}`);
    const toProjectId = other.body.id as string;

    const doc = await mcpCall(token, 'create_doc', { projectId, name: 'move doc', body: 'Settled: a fact.' });
    if (doc.isError) throw new Error(`create_doc failed: ${doc.text}`);
    const docId = doc.body.id as string;
    const task = await mcpCall(token, 'create_task', { projectId, title: 'to be moved', docIds: [docId], tags: ['pm-319'], allowNewTags: true });
    if (task.isError) throw new Error(`create_task failed: ${task.text}`);
    const taskId = task.body.id as string;

    await memory(projectId).runProjector(projectId);
    const taskUri = buildEntityUri({ kind: 'task', id: taskId });
    const docUri = buildEntityUri({ kind: 'artifact', id: docId });
    expect((await memory(projectId).dependencyNeighborhood(projectId, { entityUri: taskUri, edgeTypes: ['related_to'] })).downstream.map((n) => n.uri)).toEqual([docUri]);

    await room(projectId).moveTask(projectId, HUMAN_ACTOR, taskId, toProjectId);
    const applied = await memory(projectId).runProjector(projectId);
    expect(applied.applied).toBeGreaterThan(0);
    expect((await memory(projectId).dependencyNeighborhood(projectId, { entityUri: taskUri, edgeTypes: ['related_to'] })).downstream).toEqual([]);
  });
});
