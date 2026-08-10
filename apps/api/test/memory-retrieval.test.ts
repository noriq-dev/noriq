// PLNR-257: hybrid search_project_memory (exact + lexical + semantic + bounded graph
// expansion). Drives the DO's RPCs directly for the shape/provenance/bound assertions (same
// technique as the other memory-*.test.ts files), and the real MCP surface for registration/
// floor-gating (same technique as memory-mcp.test.ts).
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { createUser, mintTokenForUser, mcpCall, mcpList, createRunAgent } from './helpers';
import { dedupeCandidates, type RetrievalHit } from '../src/memory/retrieval';

const appEnv = env as unknown as Env;
const SYSTEM = { kind: 'system', id: null };

interface RankedHit {
  entityType: 'memory' | 'episode' | 'node';
  id: string;
  uri?: string;
  kind?: string;
  title: string;
  snippet: string;
  stage: 'exact' | 'lexical' | 'semantic' | 'graph';
  score: number;
  repositoryKey?: string | null;
  branch?: string | null;
  authority?: number;
  validity?: string;
  status?: string;
  evidenceVerification?: string[];
  seedNodeId?: string;
  edgePath?: string;
  depth?: number;
  alsoFoundBy?: string[];
  isLead: boolean;
  leadReasons: string[];
  finalScore: number;
}

interface MemRpc {
  recordMemory(
    pid: string,
    input: {
      kind: string; statement: string; authority?: number;
      evidence?: Array<{ repositoryKey: string; branch: string; baseId: string; path: string; verificationState?: string }>;
      scope?: { repositoryKey?: string; branch?: string; baseId?: string };
      actor: { kind: string; id: string | null };
    },
  ): Promise<{ memoryId: string }>;
  approveDecision(pid: string, input: { memoryItemId: string; actorUserId: string }): Promise<{ approvedMemoryId: string }>;
  transitionMemoryValidity(pid: string, input: { memoryItemId: string; validity: string; actor: { kind: string; id: string | null } }): Promise<{ ok: true }>;
  writeNode(pid: string, input: { type: string; uri: string; label: string; actor: { kind: string; id: string | null } }): Promise<{ nodeId: string }>;
  writeEdge(pid: string, input: { type: string; fromNodeId: string; toNodeId: string; actor: { kind: string; id: string | null } }): Promise<{ edgeId: string }>;
  traverseGraph(
    pid: string,
    input: { seedNodeIds: string[]; edgeTypes?: string[]; maxDepth?: number; maxResults?: number },
  ): Promise<Array<{ nodeId: string; uri: string; type: string; label: string; depth: number; edgePath: string }>>;
  searchProjectMemory(
    pid: string,
    opts: {
      query?: string; memoryItemId?: string; episodeId?: string; taskId?: string; seedEntityUri?: string;
      edgeTypes?: string[]; maxDepth?: number; repositoryKey?: string; branch?: string; preferBranch?: string; kind?: string;
      minAuthority?: number; validity?: string; limit?: number;
    },
  ): Promise<{ mode: 'semantic' | 'keyword'; results: RankedHit[] }>;
  runProjector(pid: string): Promise<{ applied: number; cursor: number }>;
}
const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as MemRpc;

async function newOwnedProject(email: string, key: string) {
  await createUser(email, 'Owner', 'longenough1');
  const token = await mintTokenForUser(email);
  const proj = await mcpCall(token, 'create_project', { key, name: `${key} project` });
  if (proj.isError) throw new Error(`create_project(${key}) failed: ${proj.text}`);
  return { token, projectId: proj.body.id as string };
}

describe('dedupeCandidates — pure cross-stage collapse (PLNR-282)', () => {
  function hit(overrides: Partial<RetrievalHit> & Pick<RetrievalHit, 'entityType' | 'id' | 'stage' | 'score'>): RetrievalHit {
    return { title: 't', snippet: 's', ...overrides };
  }

  it('collapses the same entity found by lexical AND semantic into one hit, retaining both stages', () => {
    const lexical = hit({ entityType: 'memory', id: 'mem_1', stage: 'lexical', score: 1 });
    const semantic = hit({ entityType: 'memory', id: 'mem_1', stage: 'semantic', score: 0.5702917 });
    const result = dedupeCandidates([lexical, semantic]);
    expect(result).toHaveLength(1);
    expect(result[0]!.score).toBe(1); // max across stages survives
    expect(new Set([result[0]!.stage, ...(result[0]!.alsoFoundBy ?? [])])).toEqual(new Set(['lexical', 'semantic']));
  });

  it('an exact lookup merged with a lexical hit for the same memory reports both stages', () => {
    const exact = hit({ entityType: 'memory', id: 'mem_2', stage: 'exact', score: 1 });
    const lexical = hit({ entityType: 'memory', id: 'mem_2', stage: 'lexical', score: 1 });
    const result = dedupeCandidates([exact, lexical]);
    expect(result).toHaveLength(1);
    expect(new Set([result[0]!.stage, ...(result[0]!.alsoFoundBy ?? [])])).toEqual(new Set(['exact', 'lexical']));
  });

  it('a graph hit merged with a text hit for the SAME entity retains edgePath/seedNodeId/depth regardless of arrival order', () => {
    const text = hit({ entityType: 'episode', id: 'ep_1', stage: 'lexical', score: 0.9 });
    const graph = hit({
      entityType: 'episode', id: 'ep_1', stage: 'graph', score: 0.3,
      seedNodeId: 'node_seed', edgePath: 'node_seed>related_to>node_ep_1', depth: 1,
    });

    // similar-effort.ts treats edgePath as the ONLY source of its graph-neighborhood/
    // shared-decision support kinds — losing it in a merge, in either arrival order, would
    // silently weaken PLNR-264's duplicate-work warnings.
    const textThenGraph = dedupeCandidates([text, graph])[0]!;
    expect(textThenGraph.edgePath).toBe('node_seed>related_to>node_ep_1');
    expect(textThenGraph.seedNodeId).toBe('node_seed');
    expect(textThenGraph.depth).toBe(1);
    expect(textThenGraph.score).toBe(0.9); // higher raw score still wins, even though it came from the non-graph side
    expect(textThenGraph.alsoFoundBy).toContain('lexical');

    const graphThenText = dedupeCandidates([graph, text])[0]!;
    expect(graphThenText.edgePath).toBe('node_seed>related_to>node_ep_1');
    expect(graphThenText.seedNodeId).toBe('node_seed');
    expect(graphThenText.depth).toBe(1);
    expect(graphThenText.score).toBe(0.9);
  });

  it('never collapses across different entityTypes even when ids coincide', () => {
    const memory = hit({ entityType: 'memory', id: 'shared_id', stage: 'lexical', score: 1 });
    const episode = hit({ entityType: 'episode', id: 'shared_id', stage: 'lexical', score: 1 });
    expect(dedupeCandidates([memory, episode])).toHaveLength(2);
  });

  it('never collapses a memory with a DIFFERENT memory that supersedes it — collapse keys on identity, never on similar content (§12)', () => {
    const original = hit({ entityType: 'memory', id: 'mem_old', stage: 'lexical', score: 0.5, snippet: 'old statement' });
    const superseding = hit({ entityType: 'memory', id: 'mem_new', stage: 'lexical', score: 0.9, snippet: 'corrected statement' });
    const result = dedupeCandidates([original, superseding]);
    expect(result.map((r) => r.id).sort()).toEqual(['mem_new', 'mem_old']);
  });

  it('a candidate found by all three text/exact stages accumulates every one in alsoFoundBy', () => {
    const exact = hit({ entityType: 'memory', id: 'mem_3', stage: 'exact', score: 1 });
    const lexical = hit({ entityType: 'memory', id: 'mem_3', stage: 'lexical', score: 0.8 });
    const semantic = hit({ entityType: 'memory', id: 'mem_3', stage: 'semantic', score: 0.6 });
    const result = dedupeCandidates([exact, lexical, semantic]);
    expect(result).toHaveLength(1);
    expect(new Set([result[0]!.stage, ...(result[0]!.alsoFoundBy ?? [])])).toEqual(new Set(['exact', 'lexical', 'semantic']));
  });

  it('a distinct, single-stage hit is passed through with no alsoFoundBy added', () => {
    const solo = hit({ entityType: 'memory', id: 'mem_4', stage: 'lexical', score: 1 });
    const result = dedupeCandidates([solo]);
    expect(result).toHaveLength(1);
    expect(result[0]!.alsoFoundBy).toBeUndefined();
  });
});

describe('duplicate collapse across stages, end-to-end through searchProjectMemory (PLNR-282)', () => {
  it('an exact memoryItemId lookup combined with a query matching the SAME memory yields one result, not two', async () => {
    const { projectId } = await newOwnedProject('pm-retr-dedupe1@example.com', 'PMRDDP1');
    const { memoryId } = await memory(projectId).recordMemory(projectId, {
      kind: 'decision', statement: 'retry storms need exponential backoff', actor: { kind: 'agent', id: 'agt_x' },
    });

    const { results } = await memory(projectId).searchProjectMemory(projectId, { memoryItemId: memoryId, query: 'exponential backoff' });
    const matches = results.filter((r) => r.id === memoryId);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.stage).toBe('exact');
    expect(matches[0]!.alsoFoundBy).toContain('lexical');
  });

  it('a duplicate no longer consumes a limit slot — a `limit: N` query still returns N DISTINCT memories', async () => {
    const { projectId } = await newOwnedProject('pm-retr-dedupe2@example.com', 'PMRDDP2');
    const { memoryId: memA } = await memory(projectId).recordMemory(projectId, {
      kind: 'decision', statement: 'retry storms need exponential backoff', actor: { kind: 'agent', id: 'agt_x' },
    });
    const { memoryId: memB } = await memory(projectId).recordMemory(projectId, {
      kind: 'learning', statement: 'circuit breakers prevent retry storms cascading', actor: { kind: 'agent', id: 'agt_x' },
    });

    // memA matches BOTH the exact memoryItemId lookup and the lexical scan (the query shares its
    // words); memB matches only the lexical scan. Pre-fix, memA's two candidate rows both
    // survived ranking untouched and a limit of 2 could return [memA, memA] — memB never got a
    // slot despite genuinely matching too.
    const { results } = await memory(projectId).searchProjectMemory(projectId, {
      memoryItemId: memA, query: 'retry storms', limit: 2,
    });
    expect(results.map((r) => r.id).sort()).toEqual([memA, memB].sort());
  });
});

describe('search_project_memory — registration and MCP floor gating', () => {
  it('appears in tools/list with its guidance intact, and is absent for a floor that omits it', async () => {
    const { token } = await newOwnedProject('pm-retr-mcp@example.com', 'PMRMCP');
    const tools = await mcpList(token);
    const tool = tools.find((t) => t.name === 'search_project_memory');
    expect(tool).toBeTruthy();
    expect(tool!.description).toContain('isLead');
    expect(tool!.description.toLowerCase()).toContain('lead');
    expect(tool!.description).toContain('taskId');
    expect(tool!.description).toContain('baseId');
    expect(tool!.description).toContain('preferBranch');
    expect((tool as unknown as { inputSchema: { properties: Record<string, unknown> } }).inputSchema.properties).toHaveProperty('baseId');
    expect((tool as unknown as { inputSchema: { properties: Record<string, unknown> } }).inputSchema.properties).toHaveProperty('preferBranch');
  });

  it('is absent from tools/list for a floor that omits it, present and callable for one that includes it', async () => {
    const { projectId } = await newOwnedProject('pm-retr-floor@example.com', 'PMRFLR');
    const withoutFloor = ['get_briefing', 'get_task', 'heartbeat'];
    const without = await createRunAgent(projectId, 'build', { ownerEmail: 'pm-retr-floor@example.com', allowedTools: withoutFloor });
    expect((await mcpList(without.apiKey)).map((t) => t.name)).not.toContain('search_project_memory');

    const withIt = await createRunAgent(projectId, 'build', { ownerEmail: 'pm-retr-floor@example.com', allowedTools: [...withoutFloor, 'search_project_memory'] });
    expect((await mcpList(withIt.apiKey)).map((t) => t.name)).toContain('search_project_memory');
    const called = await mcpCall(withIt.apiKey, 'search_project_memory', { projectId, query: 'anything' });
    expect(called.isError).toBeFalsy();
  });
});

describe('exact + lexical + semantic (keyword-mode) stages, with live authority/validity', () => {
  it('memoryItemId does an exact lookup, and query does a lexical scan — no AI/VECTORIZE bound, mode is keyword', async () => {
    const { projectId } = await newOwnedProject('pm-retr-1@example.com', 'PMRETR1');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'decision', statement: 'use exponential backoff for retries', actor: { kind: 'agent', id: 'agt_x' } });

    const exact = await memory(projectId).searchProjectMemory(projectId, { memoryItemId: memoryId });
    expect(exact.mode).toBe('keyword');
    expect(exact.results).toHaveLength(1);
    expect(exact.results[0]!.stage).toBe('exact');
    expect(exact.results[0]!.id).toBe(memoryId);
    expect(exact.results[0]!.authority).toBe(1);
    expect(exact.results[0]!.validity).toBe('active');

    const lexical = await memory(projectId).searchProjectMemory(projectId, { query: 'exponential backoff' });
    expect(lexical.mode).toBe('keyword');
    expect(lexical.results.some((r) => r.id === memoryId && r.stage === 'lexical')).toBe(true);
  });

  it('validity mutated AFTER the query is visible on the NEXT query with no re-index (live read, not cached)', async () => {
    const { projectId } = await newOwnedProject('pm-retr-2@example.com', 'PMRETR2');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'the staging DB ignores retry-after headers', actor: { kind: 'agent', id: 'agt_x' } });
    const before = await memory(projectId).searchProjectMemory(projectId, { memoryItemId: memoryId });
    expect(before.results[0]!.validity).toBe('active');

    await memory(projectId).transitionMemoryValidity(projectId, { memoryItemId: memoryId, validity: 'stale', actor: SYSTEM });
    const after = await memory(projectId).searchProjectMemory(projectId, { memoryItemId: memoryId });
    expect(after.results[0]!.validity).toBe('stale');
  });
});

describe('lead labelling — low authority, non-active validity, and unverified evidence', () => {
  it('an agent-recorded memory (authority 1) is returned and labelled a lead', async () => {
    const { projectId } = await newOwnedProject('pm-retr-3@example.com', 'PMRETR3');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'failed_approach', statement: 'tried a single global mutex — deadlocked', actor: { kind: 'agent', id: 'agt_x' } });
    const { results } = await memory(projectId).searchProjectMemory(projectId, { memoryItemId: memoryId });
    expect(results[0]!.isLead).toBe(true);
    expect(results[0]!.leadReasons).toContain('low-authority');
  });

  it('a human-approved decision (authority 5, active, no evidence) is NOT a lead', async () => {
    const { projectId } = await newOwnedProject('pm-retr-4@example.com', 'PMRETR4');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'decision', statement: 'adopt trunk-based development', actor: { kind: 'agent', id: 'agt_x' } });
    const { approvedMemoryId } = await memory(projectId).approveDecision(projectId, { memoryItemId: memoryId, actorUserId: 'user_1' });
    const { results } = await memory(projectId).searchProjectMemory(projectId, { memoryItemId: approvedMemoryId });
    expect(results[0]!.authority).toBe(5);
    expect(results[0]!.isLead).toBe(false);
    expect(results[0]!.leadReasons).toEqual([]);
  });

  it('unverified evidence marks an otherwise-high-authority-looking memory a lead too', async () => {
    const { projectId } = await newOwnedProject('pm-retr-5@example.com', 'PMRETR5');
    const { memoryId } = await memory(projectId).recordMemory(projectId, {
      kind: 'procedure', statement: 'run migrations with --safe-mode',
      evidence: [{ repositoryKey: 'repo-x', branch: 'main', baseId: 'sha1', path: 'MIGRATIONS.md' }], // defaults to unverifiable
      actor: { kind: 'agent', id: 'agt_x' },
    });
    const { results } = await memory(projectId).searchProjectMemory(projectId, { memoryItemId: memoryId });
    expect(results[0]!.leadReasons).toContain('unverified-evidence');
  });
});

describe('graph expansion — bounded, provenance-carrying, and cross-project isolated', () => {
  it('taskId seeds expansion; a graph hit carries seedNodeId, edgePath, and depth', async () => {
    const { token, projectId } = await newOwnedProject('pm-retr-graph@example.com', 'PMRGRF');
    const task = await mcpCall(token, 'create_task', { projectId, title: 'investigate flaky webhook retries', tags: ['webhooks'] });
    const taskId = task.body.id as string;
    await memory(projectId).runProjector(projectId); // projects task.created into a 'task' graph node

    const { nodeId: extraNode } = await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/related-hazard', label: 'related hazard', actor: SYSTEM });
    // writeNode is an upsert keyed on uri (PLNR-251) — re-declaring the task's ALREADY-projected
    // node just returns its existing id, giving us a handle to writeEdge FROM without a
    // separate "look up a node by uri" RPC.
    const { nodeId: taskNodeId } = await memory(projectId).writeNode(projectId, { type: 'task', uri: `noriq://task/${taskId}`, label: 'investigate flaky webhook retries', actor: SYSTEM });
    await memory(projectId).writeEdge(projectId, { type: 'related_to', fromNodeId: taskNodeId, toNodeId: extraNode, actor: SYSTEM });

    const { results } = await memory(projectId).searchProjectMemory(projectId, { taskId, edgeTypes: ['related_to'] });
    const graphHit = results.find((r) => r.stage === 'graph');
    expect(graphHit).toBeTruthy();
    expect(graphHit!.id).toBe(extraNode);
    expect(graphHit!.depth).toBe(1);
    expect(graphHit!.edgePath).toContain('related_to');
    expect(graphHit!.seedNodeId).toBe(taskNodeId);
  });

  it('respects maxDepth: a node two hops away is excluded at maxDepth=1, included at maxDepth=2', async () => {
    const { projectId } = await newOwnedProject('pm-retr-depth@example.com', 'PMRDEP');
    const { nodeId: a } = await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/d-a', label: 'a', actor: SYSTEM });
    const { nodeId: b } = await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/d-b', label: 'b', actor: SYSTEM });
    const { nodeId: c } = await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/d-c', label: 'c', actor: SYSTEM });
    await memory(projectId).writeEdge(projectId, { type: 'related_to', fromNodeId: a, toNodeId: b, actor: SYSTEM });
    await memory(projectId).writeEdge(projectId, { type: 'related_to', fromNodeId: b, toNodeId: c, actor: SYSTEM });

    const depth1 = await memory(projectId).traverseGraph(projectId, { seedNodeIds: [a], maxDepth: 1 });
    expect(depth1.map((h) => h.nodeId)).toEqual([b]);

    const depth2 = await memory(projectId).traverseGraph(projectId, { seedNodeIds: [a], maxDepth: 2 });
    expect(depth2.map((h) => h.nodeId).sort()).toEqual([b, c].sort());
    const cHit = depth2.find((h) => h.nodeId === c)!;
    expect(cHit.depth).toBe(2);
    expect(cHit.edgePath.split(';')).toHaveLength(2); // two hops recorded in the path
  });

  it('respects maxResults — a hard row bound, not a post-hoc trim', async () => {
    const { projectId } = await newOwnedProject('pm-retr-budget@example.com', 'PMRBGT');
    const { nodeId: seed } = await memory(projectId).writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/wide-seed', label: 'seed', actor: SYSTEM });
    for (let i = 0; i < 10; i++) {
      const { nodeId } = await memory(projectId).writeNode(projectId, { type: 'unknown', uri: `noriq://unknown/wide-${i}`, label: `n${i}`, actor: SYSTEM });
      await memory(projectId).writeEdge(projectId, { type: 'related_to', fromNodeId: seed, toNodeId: nodeId, actor: SYSTEM });
    }
    const bounded = await memory(projectId).traverseGraph(projectId, { seedNodeIds: [seed], maxResults: 3 });
    expect(bounded).toHaveLength(3);
  });

  it('cross-project isolation: a project\'s graph never returns another project\'s nodes, even with identical edge shapes', async () => {
    const { projectId: pA } = await newOwnedProject('pm-retr-isoA@example.com', 'PMRISOA');
    const { projectId: pB } = await newOwnedProject('pm-retr-isoB@example.com', 'PMRISOB');
    const { nodeId: aSeed } = await memory(pA).writeNode(pA, { type: 'unknown', uri: 'noriq://unknown/iso-seed', label: 'seed', actor: SYSTEM });
    const { nodeId: aTarget } = await memory(pA).writeNode(pA, { type: 'unknown', uri: 'noriq://unknown/iso-target', label: 'target', actor: SYSTEM });
    await memory(pA).writeEdge(pA, { type: 'related_to', fromNodeId: aSeed, toNodeId: aTarget, actor: SYSTEM });
    // Same URIs/shape in project B — a DIFFERENT DO instance entirely.
    const { nodeId: bSeed } = await memory(pB).writeNode(pB, { type: 'unknown', uri: 'noriq://unknown/iso-seed', label: 'seed', actor: SYSTEM });
    const { nodeId: bTarget } = await memory(pB).writeNode(pB, { type: 'unknown', uri: 'noriq://unknown/iso-target', label: 'target', actor: SYSTEM });
    await memory(pB).writeEdge(pB, { type: 'related_to', fromNodeId: bSeed, toNodeId: bTarget, actor: SYSTEM });

    const fromA = await memory(pA).traverseGraph(pA, { seedNodeIds: [aSeed] });
    expect(fromA.map((h) => h.nodeId)).toEqual([aTarget]);
    expect(fromA.some((h) => h.nodeId === bTarget)).toBe(false);

    // B's seed id is meaningless inside A's DO — it simply doesn't exist there.
    const crossed = await memory(pA).traverseGraph(pA, { seedNodeIds: [bSeed] });
    expect(crossed).toEqual([]);
  });
});

describe('filters compose: repository, branch, kind, authority, validity', () => {
  it('each filter narrows independently, and combining them narrows further', async () => {
    const { projectId } = await newOwnedProject('pm-retr-filters@example.com', 'PMRFLT');
    const a = await memory(projectId).recordMemory(projectId, {
      kind: 'hazard', statement: 'repo-x main branch leaks connections',
      scope: { repositoryKey: 'repo-x', branch: 'main' }, actor: { kind: 'agent', id: 'agt_x' },
    });
    const b = await memory(projectId).recordMemory(projectId, {
      kind: 'learning', statement: 'repo-y dev branch leaks connections too',
      scope: { repositoryKey: 'repo-y', branch: 'dev' }, actor: { kind: 'agent', id: 'agt_x' },
    });

    const byRepo = await memory(projectId).searchProjectMemory(projectId, { query: 'leaks connections', repositoryKey: 'repo-x' });
    expect(byRepo.results.map((r) => r.id)).toContain(a.memoryId);
    expect(byRepo.results.map((r) => r.id)).not.toContain(b.memoryId);

    const byKind = await memory(projectId).searchProjectMemory(projectId, { query: 'leaks connections', kind: 'hazard' });
    expect(byKind.results.map((r) => r.id)).toContain(a.memoryId);
    expect(byKind.results.map((r) => r.id)).not.toContain(b.memoryId);

    const byRepoAndKind = await memory(projectId).searchProjectMemory(projectId, { query: 'leaks connections', repositoryKey: 'repo-x', kind: 'learning' });
    expect(byRepoAndKind.results.map((r) => r.id)).not.toContain(a.memoryId); // kind mismatch
    expect(byRepoAndKind.results.map((r) => r.id)).not.toContain(b.memoryId); // repo mismatch

    const byValidity = await memory(projectId).searchProjectMemory(projectId, { query: 'leaks connections', validity: 'active' });
    expect(byValidity.results.map((r) => r.id)).toEqual(expect.arrayContaining([a.memoryId, b.memoryId]));

    const byMinAuthority = await memory(projectId).searchProjectMemory(projectId, { query: 'leaks connections', minAuthority: 3 });
    expect(byMinAuthority.results.map((r) => r.id)).not.toContain(a.memoryId); // both are authority 1
  });

  it('keeps cross-branch memories when branch is only preferred, while an explicit branch still filters', async () => {
    const { projectId } = await newOwnedProject('pm-retr-branch-preference@example.com', 'PMRBRP');
    const main = await memory(projectId).recordMemory(projectId, {
      kind: 'learning', statement: 'branch preference probe common memory main',
      scope: { repositoryKey: 'repo-x', branch: 'main' }, actor: { kind: 'agent', id: 'agt_x' },
    });
    const feature = await memory(projectId).recordMemory(projectId, {
      kind: 'learning', statement: 'branch preference probe common memory feature',
      scope: { repositoryKey: 'repo-x', branch: 'feature' }, actor: { kind: 'agent', id: 'agt_x' },
    });

    const preferred = await memory(projectId).searchProjectMemory(projectId, {
      query: 'branch preference probe common memory', preferBranch: 'main', limit: 10,
    });
    expect(preferred.results.map((r) => r.id)).toEqual(expect.arrayContaining([main.memoryId, feature.memoryId]));
    expect(preferred.results.find((r) => r.id === main.memoryId)!.finalScore)
      .toBeGreaterThan(preferred.results.find((r) => r.id === feature.memoryId)!.finalScore);

    const filtered = await memory(projectId).searchProjectMemory(projectId, {
      query: 'branch preference probe common memory', branch: 'main', limit: 10,
    });
    expect(filtered.results.map((r) => r.id)).toContain(main.memoryId);
    expect(filtered.results.map((r) => r.id)).not.toContain(feature.memoryId);
  });
});

describe('no-Vectorize coverage — the default workerd state', () => {
  it('answers from exact + lexical + graph with no AI/VECTORIZE binding, and says so via mode', async () => {
    const { projectId } = await newOwnedProject('pm-retr-noai@example.com', 'PMRNOAI');
    await memory(projectId).recordMemory(projectId, { kind: 'unknown', statement: 'not sure why the cache misses spike hourly', actor: { kind: 'agent', id: 'agt_x' } });
    const { mode, results } = await memory(projectId).searchProjectMemory(projectId, { query: 'cache misses spike' });
    expect(mode).toBe('keyword');
    expect(results.length).toBeGreaterThan(0);
  });
});

describe('read-only: a query writes nothing', () => {
  it('memory_revision is unchanged across a search', async () => {
    const { projectId } = await newOwnedProject('pm-retr-readonly@example.com', 'PMRETRRO');
    const { memoryId } = await memory(projectId).recordMemory(projectId, { kind: 'learning', statement: 'read-only probe', actor: { kind: 'agent', id: 'agt_x' } });
    const before = await appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(projectId)).health(projectId);
    await memory(projectId).searchProjectMemory(projectId, { query: 'read-only probe', memoryItemId: memoryId });
    const after = await appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(projectId)).health(projectId);
    expect(after.memoryRevision).toBe(before.memoryRevision);
  });
});
