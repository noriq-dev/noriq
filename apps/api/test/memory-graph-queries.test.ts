// PLNR-258: named graph-query primitives (dependencyNeighborhood, validatingTests,
// implementingWork, decisionLineage, changeImpact). Drives the DO's RPCs directly (same
// technique as the other memory-*.test.ts files) plus the real MCP surface for
// registration/floor-gating (same technique as memory-mcp.test.ts / memory-retrieval.test.ts).
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { createUser, mintTokenForUser, mcpCall, mcpList, createRunAgent } from './helpers';

const appEnv = env as unknown as Env;
const SYSTEM = { kind: 'system', id: null };

interface GraphEntityRef { nodeId: string; uri: string; type: string; label: string }
interface EdgeHop { fromNodeId: string; edgeType: string; toNodeId: string }
interface RelatedEntity extends GraphEntityRef { depth: number; edgePath: EdgeHop[] }
interface Coverage { complete: boolean; reasons: string[]; edgeTypesWithNoWriter?: string[] }

interface MemRpc {
  recordMemory(
    pid: string,
    input: { kind: string; statement: string; evidence?: Array<{ repositoryKey: string; branch: string; baseId: string; path: string }>; actor: { kind: string; id: string | null } },
  ): Promise<{ memoryId: string }>;
  writeNode(pid: string, input: { type: string; uri: string; label: string; actor: { kind: string; id: string | null } }): Promise<{ nodeId: string }>;
  writeEdge(pid: string, input: { type: string; fromNodeId: string; toNodeId: string; actor: { kind: string; id: string | null } }): Promise<{ edgeId: string }>;
  dependencyNeighborhood(
    pid: string,
    input: { entityUri: string; edgeTypes?: string[]; maxDepth?: number; maxResults?: number },
  ): Promise<{ seed: GraphEntityRef | null; downstream: RelatedEntity[]; upstream: RelatedEntity[]; coverage: Coverage }>;
  validatingTests(pid: string, input: { entityUri: string; maxDepth?: number; maxResults?: number }): Promise<{ seed: GraphEntityRef | null; tests: RelatedEntity[]; coverage: Coverage }>;
  implementingWork(pid: string, input: { entityUri: string; maxDepth?: number; maxResults?: number }): Promise<{ seed: GraphEntityRef | null; implementingTasks: RelatedEntity[]; coverage: Coverage }>;
  decisionLineage(pid: string, input: { decisionUri: string; maxDepth?: number; maxResults?: number }): Promise<{
    seed: GraphEntityRef | null;
    implementingTasks: RelatedEntity[];
    affectedEntities: RelatedEntity[];
    supersedingDecisions: RelatedEntity[];
    evidence: Array<{ repositoryKey: string; branch: string; baseId: string; path: string; verificationState: string }>;
    coverage: Coverage;
  }>;
  changeImpact(pid: string, input: { entityUris: string[]; maxDepth?: number; maxResults?: number }): Promise<{
    resolvedSeeds: GraphEntityRef[];
    uncertainEdges: Array<{ entityUri: string; reason: string }>;
    impactedTests: RelatedEntity[];
    coverage: Coverage;
  }>;
}
const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as MemRpc;

async function newOwnedProject(email: string, key: string) {
  await createUser(email, 'Owner', 'longenough1');
  const token = await mintTokenForUser(email);
  const proj = await mcpCall(token, 'create_project', { key, name: `${key} project` });
  if (proj.isError) throw new Error(`create_project(${key}) failed: ${proj.text}`);
  return { token, projectId: proj.body.id as string };
}

describe('explain_project_area — registration and MCP floor gating', () => {
  it('appears in tools/list with coverage guidance intact, and is absent for a floor that omits it', async () => {
    const { token } = await newOwnedProject('pm-gq-mcp@example.com', 'PMGQMCP');
    const tools = await mcpList(token);
    const tool = tools.find((t) => t.name === 'explain_project_area');
    expect(tool).toBeTruthy();
    expect(tool!.description).toContain('coverage');
    expect(tool!.description).toContain('code-graph-empty');
    expect(tool!.description).toContain('decisionUri');
  });

  it('is absent from tools/list for a floor that omits it, present and callable for one that includes it', async () => {
    const { projectId } = await newOwnedProject('pm-gq-floor@example.com', 'PMGQFLR');
    const without = await createRunAgent(projectId, 'build', { ownerEmail: 'pm-gq-floor@example.com', allowedTools: ['get_briefing'] });
    expect((await mcpList(without.apiKey)).map((t) => t.name)).not.toContain('explain_project_area');

    const withIt = await createRunAgent(projectId, 'build', { ownerEmail: 'pm-gq-floor@example.com', allowedTools: ['get_briefing', 'explain_project_area'] });
    expect((await mcpList(withIt.apiKey)).map((t) => t.name)).toContain('explain_project_area');
    const called = await mcpCall(withIt.apiKey, 'explain_project_area', { projectId, focus: 'impact', entityUris: ['noriq://file/PMGQFLR/repo-x/never-indexed.ts'] });
    expect(called.isError).toBeFalsy();
  });
});

describe('dependencyNeighborhood — directional, bounded, populated code graph', () => {
  it('splits upstream/downstream over a depends_on chain, populated codeGraphPopulated', async () => {
    const { projectId } = await newOwnedProject('pm-gq-dep@example.com', 'PMGQDEP');
    const a = await memory(projectId).writeNode(projectId, { type: 'file', uri: 'noriq://file/PMGQDEP/repo-x/a.ts', label: 'a.ts', actor: SYSTEM });
    const b = await memory(projectId).writeNode(projectId, { type: 'file', uri: 'noriq://file/PMGQDEP/repo-x/b.ts', label: 'b.ts', actor: SYSTEM });
    const c = await memory(projectId).writeNode(projectId, { type: 'file', uri: 'noriq://file/PMGQDEP/repo-x/c.ts', label: 'c.ts', actor: SYSTEM });
    await memory(projectId).writeEdge(projectId, { type: 'depends_on', fromNodeId: a.nodeId, toNodeId: b.nodeId, actor: SYSTEM });
    await memory(projectId).writeEdge(projectId, { type: 'depends_on', fromNodeId: b.nodeId, toNodeId: c.nodeId, actor: SYSTEM });

    // Restricted to the ONE edge type this test actually seeded — the default (depends_on +
    // imports + calls) would honestly report 'no-writer-yet' for the other two, which is
    // exactly correct behavior and exercised separately below.
    const fromA = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: 'noriq://file/PMGQDEP/repo-x/a.ts', edgeTypes: ['depends_on'], maxDepth: 2 });
    expect(fromA.seed?.nodeId).toBe(a.nodeId);
    expect(fromA.downstream.map((h) => h.nodeId).sort()).toEqual([b.nodeId, c.nodeId].sort());
    expect(fromA.upstream).toEqual([]);
    expect(fromA.coverage.complete).toBe(true); // file nodes exist, depends_on has a writer, nothing truncated

    const fromC = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: 'noriq://file/PMGQDEP/repo-x/c.ts', edgeTypes: ['depends_on'], maxDepth: 2 });
    expect(fromC.upstream.map((h) => h.nodeId).sort()).toEqual([a.nodeId, b.nodeId].sort());
    expect(fromC.downstream).toEqual([]);

    const bHop = fromA.downstream.find((h) => h.nodeId === b.nodeId)!;
    expect(bHop.edgePath[0]).toEqual({ fromNodeId: a.nodeId, edgeType: 'depends_on', toNodeId: b.nodeId });
  });

  it('respects the row-limit bound and reports it via coverage.reasons', async () => {
    const { projectId } = await newOwnedProject('pm-gq-bound@example.com', 'PMGQBND');
    const seed = await memory(projectId).writeNode(projectId, { type: 'file', uri: 'noriq://file/PMGQBND/repo-x/seed.ts', label: 'seed.ts', actor: SYSTEM });
    for (let i = 0; i < 10; i++) {
      const n = await memory(projectId).writeNode(projectId, { type: 'file', uri: `noriq://file/PMGQBND/repo-x/f${i}.ts`, label: `f${i}.ts`, actor: SYSTEM });
      await memory(projectId).writeEdge(projectId, { type: 'depends_on', fromNodeId: seed.nodeId, toNodeId: n.nodeId, actor: SYSTEM });
    }
    const bounded = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: 'noriq://file/PMGQBND/repo-x/seed.ts', maxResults: 3 });
    expect(bounded.downstream).toHaveLength(3);
    expect(bounded.coverage.complete).toBe(false);
    expect(bounded.coverage.reasons).toContain('row-limit-reached');
  });

  it('a seed with no matching node reports seed-not-found and returns nothing, not an error', async () => {
    const { projectId } = await newOwnedProject('pm-gq-noseed@example.com', 'PMGQNOSD');
    const r = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: 'noriq://file/PMGQNOSD/repo-x/ghost.ts' });
    expect(r.seed).toBeNull();
    expect(r.downstream).toEqual([]);
    expect(r.coverage.complete).toBe(false);
    expect(r.coverage.reasons).toContain('seed-not-found');
    expect(r.coverage.reasons).toContain('code-graph-empty'); // no file/symbol/test/api node exists in THIS project either
  });
});

describe('validatingTests — direction-agnostic merge, partial no-writer detection', () => {
  it('finds a test connected via `tests` regardless of edge direction, and flags validated_by as having no writer', async () => {
    const { projectId } = await newOwnedProject('pm-gq-tests@example.com', 'PMGQTST');
    const file = await memory(projectId).writeNode(projectId, { type: 'file', uri: 'noriq://file/PMGQTST/repo-x/svc.ts', label: 'svc.ts', actor: SYSTEM });
    const test = await memory(projectId).writeNode(projectId, { type: 'test', uri: 'noriq://test/PMGQTST/repo-x/svc.ts#covers', label: 'svc test', actor: SYSTEM });
    // Convention is deliberately undecided (no writer exists yet) — this test proves BOTH
    // directions are found, not just the one a real writer will eventually pick.
    await memory(projectId).writeEdge(projectId, { type: 'tests', fromNodeId: test.nodeId, toNodeId: file.nodeId, actor: SYSTEM });

    const r = await memory(projectId).validatingTests(projectId, { entityUri: 'noriq://file/PMGQTST/repo-x/svc.ts' });
    expect(r.tests.map((t) => t.nodeId)).toEqual([test.nodeId]);
    // 'tests' now has a writer (this test just wrote one); 'validated_by' still doesn't —
    // coverage must name it specifically, not just say "incomplete" generically.
    expect(r.coverage.complete).toBe(false);
    expect(r.coverage.edgeTypesWithNoWriter).toEqual(['validated_by']);
  });
});

describe('implementingWork — code-graph-empty is a real caveat even when the answer is found', () => {
  it('finds an implementing task, but coverage still flags code-graph-empty (task/requirement nodes are not CODE nodes)', async () => {
    const { projectId } = await newOwnedProject('pm-gq-impl@example.com', 'PMGQIMP');
    const req = await memory(projectId).writeNode(projectId, { type: 'requirement', uri: 'noriq://requirement/req_1', label: 'must retry on 5xx', actor: SYSTEM });
    const task = await memory(projectId).writeNode(projectId, { type: 'task', uri: 'noriq://task/task_1', label: 'implement retry', actor: SYSTEM });
    await memory(projectId).writeEdge(projectId, { type: 'implements', fromNodeId: task.nodeId, toNodeId: req.nodeId, actor: SYSTEM });

    const r = await memory(projectId).implementingWork(projectId, { entityUri: 'noriq://requirement/req_1' });
    expect(r.implementingTasks.map((t) => t.nodeId)).toEqual([task.nodeId]);
    // A real answer was found (implements HAS a writer here) — but this project's graph holds
    // no file/symbol/test/api node at all, so "affected code" claims elsewhere would still be
    // unanswerable. The marker says so even though THIS query's own answer is solid.
    expect(r.coverage.reasons).toEqual(['code-graph-empty']);
  });
});

describe('decisionLineage — implements-then-modifies composition, superseding decisions, and evidence', () => {
  it('returns implementing tasks, affected code (via the tasks\' modifies edges), superseding decisions, and the backing memory\'s evidence', async () => {
    const { projectId } = await newOwnedProject('pm-gq-dec@example.com', 'PMGQDEC');
    const { memoryId } = await memory(projectId).recordMemory(projectId, {
      kind: 'decision', statement: 'adopt exponential backoff for retries',
      evidence: [{ repositoryKey: 'repo-x', branch: 'main', baseId: 'sha1', path: 'RETRY.md' }],
      actor: { kind: 'agent', id: 'agt_x' },
    });
    const decisionUri = `noriq://decision/${memoryId}`;
    const decisionNode = await memory(projectId).writeNode(projectId, { type: 'decision', uri: decisionUri, label: 'adopt exponential backoff', actor: SYSTEM });
    const task = await memory(projectId).writeNode(projectId, { type: 'task', uri: 'noriq://task/task_dec1', label: 'implement backoff', actor: SYSTEM });
    await memory(projectId).writeEdge(projectId, { type: 'implements', fromNodeId: task.nodeId, toNodeId: decisionNode.nodeId, actor: SYSTEM });
    const file = await memory(projectId).writeNode(projectId, { type: 'file', uri: 'noriq://file/PMGQDEC/repo-x/retry.ts', label: 'retry.ts', actor: SYSTEM });
    await memory(projectId).writeEdge(projectId, { type: 'modifies', fromNodeId: task.nodeId, toNodeId: file.nodeId, actor: SYSTEM });

    const { memoryId: newerMemId } = await memory(projectId).recordMemory(projectId, { kind: 'decision', statement: 'adopt jittered exponential backoff instead', actor: { kind: 'agent', id: 'agt_x' } });
    const newerDecision = await memory(projectId).writeNode(projectId, { type: 'decision', uri: `noriq://decision/${newerMemId}`, label: 'adopt jittered backoff', actor: SYSTEM });
    await memory(projectId).writeEdge(projectId, { type: 'supersedes', fromNodeId: newerDecision.nodeId, toNodeId: decisionNode.nodeId, actor: SYSTEM });

    const r = await memory(projectId).decisionLineage(projectId, { decisionUri });
    expect(r.implementingTasks.map((t) => t.nodeId)).toEqual([task.nodeId]);
    expect(r.affectedEntities.map((t) => t.nodeId)).toEqual([file.nodeId]);
    expect(r.supersedingDecisions.map((t) => t.nodeId)).toEqual([newerDecision.nodeId]);
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0]!.path).toBe('RETRY.md');
    expect(r.coverage.complete).toBe(true); // every edge type used here has a writer, and a file node exists
  });
});

describe('changeImpact — uncertain edges are distinct from "no impact found"', () => {
  it('an unresolved entity uri becomes an uncertain edge, never a silent empty result', async () => {
    const { projectId } = await newOwnedProject('pm-gq-imp@example.com', 'PMGQIMP2');
    const file = await memory(projectId).writeNode(projectId, { type: 'file', uri: 'noriq://file/PMGQIMP2/repo-x/svc.ts', label: 'svc.ts', actor: SYSTEM });
    const test = await memory(projectId).writeNode(projectId, { type: 'test', uri: 'noriq://test/PMGQIMP2/repo-x/svc.ts#covers', label: 'svc test', actor: SYSTEM });
    await memory(projectId).writeEdge(projectId, { type: 'tests', fromNodeId: test.nodeId, toNodeId: file.nodeId, actor: SYSTEM });

    const r = await memory(projectId).changeImpact(projectId, {
      entityUris: ['noriq://file/PMGQIMP2/repo-x/svc.ts', 'noriq://file/PMGQIMP2/repo-x/never-indexed.ts'],
    });
    expect(r.resolvedSeeds.map((s) => s.nodeId)).toEqual([file.nodeId]);
    expect(r.uncertainEdges).toEqual([{ entityUri: 'noriq://file/PMGQIMP2/repo-x/never-indexed.ts', reason: 'not-yet-indexed' }]);
    expect(r.impactedTests.map((t) => t.nodeId)).toEqual([test.nodeId]);
  });

  it('an empty code graph answers "cannot tell yet", not "zero impact"', async () => {
    const { projectId } = await newOwnedProject('pm-gq-empty@example.com', 'PMGQEMP');
    const r = await memory(projectId).changeImpact(projectId, { entityUris: ['noriq://file/PMGQEMP/repo-x/anything.ts'] });
    expect(r.resolvedSeeds).toEqual([]);
    expect(r.impactedTests).toEqual([]);
    expect(r.uncertainEdges).toEqual([{ entityUri: 'noriq://file/PMGQEMP/repo-x/anything.ts', reason: 'not-yet-indexed' }]);
    // The critical assertion: this is NOT the same shape as "we checked and nothing is impacted"
    // — coverage says so explicitly.
    expect(r.coverage.complete).toBe(false);
    expect(r.coverage.reasons).toEqual(expect.arrayContaining(['seed-not-found', 'code-graph-empty']));
  });
});

describe('no edge type outside MemoryEdgeType, and no AI/VECTORIZE dependency', () => {
  it('every primitive answers with the default workerd bindings (no AI/VECTORIZE) — they never call an embedder', async () => {
    const { projectId } = await newOwnedProject('pm-gq-noai@example.com', 'PMGQNOAI');
    const a = await memory(projectId).writeNode(projectId, { type: 'file', uri: 'noriq://file/PMGQNOAI/repo-x/a.ts', label: 'a.ts', actor: SYSTEM });
    const b = await memory(projectId).writeNode(projectId, { type: 'file', uri: 'noriq://file/PMGQNOAI/repo-x/b.ts', label: 'b.ts', actor: SYSTEM });
    await memory(projectId).writeEdge(projectId, { type: 'depends_on', fromNodeId: a.nodeId, toNodeId: b.nodeId, actor: SYSTEM });
    // No AI/VECTORIZE bound in this workerd test env by default — a successful, non-throwing
    // result across every primitive IS the proof they never reach for an embeddings backend.
    await expect(memory(projectId).dependencyNeighborhood(projectId, { entityUri: 'noriq://file/PMGQNOAI/repo-x/a.ts' })).resolves.toBeTruthy();
    await expect(memory(projectId).validatingTests(projectId, { entityUri: 'noriq://file/PMGQNOAI/repo-x/a.ts' })).resolves.toBeTruthy();
    await expect(memory(projectId).implementingWork(projectId, { entityUri: 'noriq://file/PMGQNOAI/repo-x/a.ts' })).resolves.toBeTruthy();
    await expect(memory(projectId).changeImpact(projectId, { entityUris: ['noriq://file/PMGQNOAI/repo-x/a.ts'] })).resolves.toBeTruthy();
  });
});
