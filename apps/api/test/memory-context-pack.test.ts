// PLNR-267: get_task_context task-aware context packs. Three layers, cheapest-first (same split
// memory-similar-effort.test.ts / memory-episodes.test.ts use):
//   - memory/context-pack.ts's PURE `allocateBudget` — the exact place to pin down determinism
//     and role-reweighting without any DO or retrieval noise.
//   - `assembleContextPack` end to end (real DO, real D1, real graph/retrieval/verification) —
//     the two load-bearing acceptance lines (determinism, required-fact precedence), evidence/
//     authority/validity/base-scoped-verification, honest empty-vs-unanswerable notices,
//     read-only, and no-Vectorize degradation.
//   - the real MCP tool (get_task_context) and its REST twin.
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import type { Env } from '../src/env';
import { createAgent, createRunAgent, createUser, mintTokenForUser, loginSession, mcpCall, mcpList } from './helpers';
import { allocateBudget, SECTION_ORDER, CHARS_PER_TOKEN, assembleContextPack } from '../src/memory/context-pack';
import { buildEntityUri } from '@noriq-dev/shared';

const appEnv = env as unknown as Env;

interface MemRpc {
  health(pid: string): Promise<{ schemaVersion: number; memoryRevision: number; tableCounts: Record<string, number> }>;
  getMemoryItem(pid: string, id: string): Promise<{ evidence: Array<{ evidenceHash: string | null }> } | null>;
  acceptVerificationReport(
    pid: string,
    report: { citations: Array<{ memoryItemId: string; evidenceHash: string; state: string; baseId: string; branch: string }>; source: string },
    actor: { kind: string; id: string | null },
  ): Promise<{ applied: number; skipped: number; touchedMemoryIds: string[] }>;
  reconcile(pid: string): Promise<{ delivered: number; failed: number; applied: number; cursor: number }>;
  recordEpisode(pid: string, input: Record<string, unknown>): Promise<{ episodeId: string }>;
  writeNode(pid: string, input: { type: string; uri: string; label: string; actor: { kind: string; id: string | null } }): Promise<{ nodeId: string }>;
  writeEdge(pid: string, input: { type: string; fromNodeId: string; toNodeId: string; actor: { kind: string; id: string | null } }): Promise<{ edgeId: string }>;
}
const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as MemRpc;

interface RoomRpc {
  setFileLocking(pid: string, opts: { enabled?: boolean; ttlSeconds?: number | null }): Promise<{ fileLockingEnabled: boolean }>;
}
const room = (pid: string) => appEnv.PROJECT_ROOM.get(appEnv.PROJECT_ROOM.idFromName(pid)) as unknown as RoomRpc;

let agent: { id: string; apiKey: string };
async function newProject(key: string): Promise<string> {
  const r = await mcpCall(agent.apiKey, 'create_project', { key, name: `${key} project` });
  if (r.isError) throw new Error(`create_project(${key}) failed: ${r.text}`);
  const projectId = r.body.id as string;
  // PLNR-419: settle create_project's own coordination events (the seeded "Backlog" milestone)
  // deterministically now, rather than leaving them for some later, unpredictably-timed alarm to
  // consume — see memory-lifecycle.test.ts's newOwnedProject for the full explanation.
  await memory(projectId).reconcile(projectId);
  return projectId;
}

beforeAll(async () => {
  agent = await createAgent('memory-context-pack-agent');
}, 60000);

// -------------------------------------------------------------------------------------------
// Layer 1 — allocateBudget, pure
// -------------------------------------------------------------------------------------------

describe('allocateBudget — pure, deterministic character budgeting', () => {
  it('zero (or negative) remaining allocates zero to every section', () => {
    const zero = allocateBudget(0);
    expect(Object.values(zero).every((v) => v === 0)).toBe(true);
    expect(Object.keys(zero).sort()).toEqual(SECTION_ORDER.map((s) => s.id).sort());
    expect(allocateBudget(-50)).toEqual(zero);
  });

  it('splits proportionally by weight, with the flooring remainder handed to the EARLIEST sections', () => {
    const twoEqual = allocateBudget(100, [{ id: 'active_decisions', weight: 1 }, { id: 'known_hazards', weight: 1 }] as never);
    expect(twoEqual).toEqual({ active_decisions: 50, known_hazards: 50 });
    // 101 does not split evenly — floor(50.5)=50 each, one leftover character goes to the FIRST
    // section in the table, not the second, and not split.
    const oddRemainder = allocateBudget(101, [{ id: 'active_decisions', weight: 1 }, { id: 'known_hazards', weight: 1 }] as never);
    expect(oddRemainder).toEqual({ active_decisions: 51, known_hazards: 50 });
    // The total allocated is EXACTLY the input, at any size — the load-bearing property that
    // guarantees the sum of section caps never exceeds the requested budget.
    expect(Object.values(oddRemainder).reduce((a, b) => a + b, 0)).toBe(101);
  });

  it('is a pure function of its inputs: same remainingChars + table + role -> the same allocation, always', () => {
    const a = allocateBudget(10_000, SECTION_ORDER, 'build');
    const b = allocateBudget(10_000, SECTION_ORDER, 'build');
    expect(a).toEqual(b);
  });

  it('role reweights shares without adding/removing/reordering a section', () => {
    const human = allocateBudget(10_000, SECTION_ORDER, 'human');
    const build = allocateBudget(10_000, SECTION_ORDER, 'build');
    expect(Object.keys(human).sort()).toEqual(Object.keys(build).sort());
    // build's locked multiplier doubles graph_neighborhood's weight relative to human's baseline.
    expect(build.graph_neighborhood).toBeGreaterThan(human.graph_neighborhood!);
    const verify = allocateBudget(10_000, SECTION_ORDER, 'verify');
    expect(verify.failed_approaches).toBeGreaterThan(human.failed_approaches!);
  });
});

// -------------------------------------------------------------------------------------------
// Layer 2 — assembleContextPack end to end
// -------------------------------------------------------------------------------------------

describe('assembleContextPack — required facts are never displaced, at any budget', () => {
  it('a small and a large budget both carry the FULL required facts; only retrieved sections shrink', async () => {
    const projectId = await newProject('MCP1');
    const made = await mcpCall(agent.apiKey, 'create_task', {
      projectId, title: 'Rework the settings sync throttle', tags: ['context-pack-test'],
      executionSpec: {
        lockedDecisions: [{ decision: 'use a single shared timer', because: 'simplicity', source: '' }],
        acceptance: { observableTruths: ['the throttle no longer leaks handles'], artifacts: [], links: [] },
        anticipatedFiles: [{ path: 'apps/api/src/sync/throttle.ts', change: 'modify', why: 'fix the leak' }],
      },
    });
    const taskId = made.body.id as string;

    // A real memory that WOULD show up in relevant_memories given enough room.
    await mcpCall(agent.apiKey, 'record_memory', {
      // The lexical stage is an AND-of-every-query-term LIKE scan (memory/retrieval.ts) — this
      // statement deliberately repeats every word of the task's own title so it is guaranteed
      // to match with no VECTORIZE binding in this test harness (see the degraded-mode test below).
      projectId, kind: 'learning', statement: 'Rework the settings sync throttle: the timer is shared across all sync windows, see apps/api/src/sync/throttle.ts',
    });

    const tiny = await assembleContextPack(appEnv, projectId, taskId, { tokenBudget: 1 });
    const large = await assembleContextPack(appEnv, projectId, taskId, { tokenBudget: 50_000 });

    // The required facts are BYTE IDENTICAL regardless of budget.
    expect(tiny.taskFacts).toEqual(large.taskFacts);
    expect(tiny.taskFacts.executionSpec?.lockedDecisions).toHaveLength(1);
    expect(tiny.taskFacts.executionSpec?.acceptance.observableTruths).toEqual(['the throttle no longer leaks handles']);

    // Only the retrieved sections differ between the two.
    const tinyMemories = tiny.sections.find((s) => s.id === 'relevant_memories')!;
    const largeMemories = large.sections.find((s) => s.id === 'relevant_memories')!;
    expect(tinyMemories.excerpts.length).toBe(0); // starved by the tiny budget
    expect(largeMemories.excerpts.length).toBeGreaterThan(0); // the same memory now fits
  });

  it('a deliberately high-scoring, large memory cannot push the required facts out even when the budget alone could not hold both', async () => {
    const projectId = await newProject('MCP2');
    const made = await mcpCall(agent.apiKey, 'create_task', {
      projectId, title: 'Migrate database connection pooling logic', tags: ['context-pack-test'],
      executionSpec: { acceptance: { observableTruths: ['pooling no longer deadlocks under load'], artifacts: [], links: [] } },
    });
    const taskId = made.body.id as string;

    // Exact title-text match (ranks #1 via the exact/lexical stage) with a long statement — the
    // decoy this test's own name promises.
    await mcpCall(agent.apiKey, 'record_memory', {
      projectId, kind: 'decision',
      statement: 'Migrate database connection pooling logic '.repeat(50),
    });

    // A budget far smaller than even the task's OWN required facts — the pathological case where
    // honoring the floor necessarily means going over the nominal budget. That is intended: the
    // required facts win regardless (locked decision), and every retrieved section is starved to
    // zero rather than borrowing room from taskFacts. But the overrun must not be SILENT — a
    // caller assembling a prompt against a real token ceiling needs a pack-level notice, not just
    // two numbers (charBudget vs charsUsed) to compare and guess at.
    const pack = await assembleContextPack(appEnv, projectId, taskId, { tokenBudget: 1 });
    expect(pack.taskFacts.executionSpec?.acceptance.observableTruths).toEqual(['pooling no longer deadlocks under load']);
    for (const section of pack.sections) {
      expect(section.excerpts.length + section.graphEntities.length + section.items.length).toBe(0);
    }
    expect(pack.charsUsed).toBeGreaterThan(pack.charBudget);
    expect(pack.notices).toHaveLength(1);
    expect(pack.notices[0]!.kind).toBe('required_facts_exceeded_budget'); // distinguishable from 'truncated' — nothing was cut
    expect(pack.notices[0]!.reason).toContain(`requested budget: ${pack.charBudget} characters`);
    expect(pack.notices[0]!.reason).toContain('task facts are never displaced by budget');
  });

  it('carries NO pack-level notice when the required facts fit comfortably within the requested budget', async () => {
    const projectId = await newProject('MCP2B');
    const made = await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'A small, ordinary task', tags: ['context-pack-test'] });
    const pack = await assembleContextPack(appEnv, projectId, made.body.id as string, { tokenBudget: 5000 });
    expect(pack.charsUsed).toBeLessThanOrEqual(pack.charBudget);
    expect(pack.notices).toEqual([]);
  });

  it('identical inputs at the same budget produce a byte-identical pack (generatedAt excluded — the one deliberate wall-clock field)', async () => {
    const projectId = await newProject('MCP3');
    const made = await mcpCall(agent.apiKey, 'create_task', {
      projectId, title: 'Determinism probe task', tags: ['context-pack-test'],
      executionSpec: { anticipatedFiles: [{ path: 'apps/api/src/probe.ts', change: 'modify', why: 'probe' }] },
    });
    const taskId = made.body.id as string;
    await mcpCall(agent.apiKey, 'record_memory', { projectId, kind: 'hazard', statement: 'probe task touches a shared cache' });

    const a = await assembleContextPack(appEnv, projectId, taskId, { tokenBudget: 2000, branch: 'main', baseId: 'sha-1' });
    const b = await assembleContextPack(appEnv, projectId, taskId, { tokenBudget: 2000, branch: 'main', baseId: 'sha-1' });
    const normalize = (p: typeof a) => JSON.stringify({ ...p, generatedAt: 'X' });
    expect(normalize(a)).toBe(normalize(b));

    // And the total is within the requested budget at a REALISTIC (not sub-floor) budget.
    expect(a.charsUsed).toBeLessThanOrEqual(a.charBudget);
    expect(a.charBudget).toBe(2000 * CHARS_PER_TOKEN);
  });
});

describe('assembleContextPack — evidence, authority, validity, and base-scoped verification', () => {
  it('retrieves the same relevant memories across caller branches instead of filtering cross-branch knowledge', async () => {
    const projectId = await newProject('MCPBRNCH');
    const made = await mcpCall(agent.apiKey, 'create_task', {
      projectId, title: 'Cross branch memory retrieval probe', tags: ['context-pack-test'],
    });
    const recorded = await mcpCall(agent.apiKey, 'record_memory', {
      projectId,
      kind: 'learning',
      statement: 'Cross branch memory retrieval probe keeps durable context visible',
      scope: { repositoryKey: 'repo-x', branch: 'feature' },
    });
    const memoryId = recorded.body.memoryId as string;

    const fromMain = await assembleContextPack(appEnv, projectId, made.body.id as string, {
      repositoryKey: 'repo-x', branch: 'main', tokenBudget: 10_000,
    });
    const fromFeature = await assembleContextPack(appEnv, projectId, made.body.id as string, {
      repositoryKey: 'repo-x', branch: 'feature', tokenBudget: 10_000,
    });
    const ids = (pack: typeof fromMain) => pack.sections
      .flatMap((section) => section.excerpts)
      .filter((excerpt) => excerpt.excerptKind === 'memory')
      .map((excerpt) => excerpt.id);

    expect(ids(fromMain)).toContain(memoryId);
    expect(ids(fromFeature)).toContain(memoryId);
  });

  it('every memory excerpt states authority/validity/evidence, and a citation verified at a DIFFERENT base is not presented as verified for this caller', async () => {
    const projectId = await newProject('MCP4');
    const made = await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'A task needing a settled decision', tags: ['context-pack-test'] });
    const taskId = made.body.id as string;

    const rec = await mcpCall(agent.apiKey, 'record_memory', {
      projectId, kind: 'decision', statement: 'A task needing a settled decision uses the shared connection pool',
      evidence: [{ repositoryKey: 'repo-x', branch: 'main', baseId: 'sha-original', path: 'apps/api/src/pool.ts' }],
    });
    const memoryId = rec.body.memoryId as string;
    const item = await memory(projectId).getMemoryItem(projectId, memoryId);
    const evidenceHash = item!.evidence[0]!.evidenceHash!;

    // The cheap server-side tier would report 'unverifiable' (no index generation exists in this
    // test project) — a Runner report is the direct, controllable way to pin a specific
    // (state, baseId, branch) for this test, exactly as memory-verification.test.ts does.
    await memory(projectId).acceptVerificationReport(
      projectId,
      { citations: [{ memoryItemId: memoryId, evidenceHash, state: 'valid', baseId: 'sha-original', branch: 'main' }], source: 'test' },
      { kind: 'system', id: null },
    );

    const sameBase = await assembleContextPack(appEnv, projectId, taskId, { baseId: 'sha-original', branch: 'main', tokenBudget: 10_000 });
    const decision = sameBase.sections.find((s) => s.id === 'active_decisions')!.excerpts[0];
    expect(decision).toBeTruthy();
    expect(decision!.excerptKind).toBe('memory');
    if (decision!.excerptKind === 'memory') {
      expect(decision!.authority).toBeGreaterThanOrEqual(1);
      expect(decision!.validity).toBeTruthy();
      expect(decision!.evidence).toHaveLength(1);
      expect(decision!.evidence[0]!.verificationState).toBe('valid');
      expect(decision!.evidence[0]!.lastVerifiedBaseId).toBe('sha-original');
      expect(decision!.evidence[0]!.verifiedForCaller).toBe(true);
    }

    const differentBase = await assembleContextPack(appEnv, projectId, taskId, { baseId: 'sha-DIFFERENT', branch: 'main', tokenBudget: 10_000 });
    const decision2 = differentBase.sections.find((s) => s.id === 'active_decisions')!.excerpts[0];
    expect(decision2).toBeTruthy();
    if (decision2!.excerptKind === 'memory') {
      // Still recorded as 'valid' in its own row — just not verified FOR THIS caller's base.
      expect(decision2!.evidence[0]!.verificationState).toBe('valid');
      expect(decision2!.evidence[0]!.verifiedForCaller).toBe(false);
    }
  });
});

describe('assembleContextPack — an unanswerable section is distinguishable from an empty one', () => {
  it('active_neighboring_work: unanswerable when file locking is off; empty (no notice) when on with no overlapping locks; populated when a lock overlaps', async () => {
    const projectId = await newProject('MCP5');
    const made = await mcpCall(agent.apiKey, 'create_task', {
      projectId, title: 'Touches a locked file', tags: ['context-pack-test'],
      executionSpec: { anticipatedFiles: [{ path: 'apps/api/src/shared/thing.ts', change: 'modify', why: 'x' }] },
    });
    const taskId = made.body.id as string;

    const off = await assembleContextPack(appEnv, projectId, taskId, {});
    const offSection = off.sections.find((s) => s.id === 'active_neighboring_work')!;
    expect(offSection.notice?.kind).toBe('unanswerable');
    expect(offSection.notice?.reason).toMatch(/file locking is disabled/);

    await room(projectId).setFileLocking(projectId, { enabled: true });
    const onEmpty = await assembleContextPack(appEnv, projectId, taskId, {});
    const onEmptySection = onEmpty.sections.find((s) => s.id === 'active_neighboring_work')!;
    expect(onEmptySection.notice).toBeNull(); // answerable, genuinely nothing found
    expect(onEmptySection.items).toEqual([]);

    // A DIFFERENT agent holds an overlapping lock.
    const other = await createAgent('context-pack-lock-holder');
    const acquired = await mcpCall(other.apiKey, 'acquire_lock', { projectId, paths: ['apps/api/src/shared/thing.ts'], allBranches: true });
    expect(acquired.isError).toBeFalsy();

    const onPopulated = await assembleContextPack(appEnv, projectId, taskId, {});
    const onPopulatedSection = onPopulated.sections.find((s) => s.id === 'active_neighboring_work')!;
    expect(onPopulatedSection.notice).toBeNull();
    expect(onPopulatedSection.items.length).toBeGreaterThan(0);
    expect(onPopulatedSection.items[0]).toMatchObject({ path: 'apps/api/src/shared/thing.ts' });
  });

  it('graph_neighborhood: a task with no graph node at all is unanswerable, never presented as "no related entities"', async () => {
    const projectId = await newProject('MCP6');
    const made = await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'Never touched by any episode', tags: ['context-pack-test'] });
    const pack = await assembleContextPack(appEnv, projectId, made.body.id as string, {});
    const graph = pack.sections.find((s) => s.id === 'graph_neighborhood')!;
    expect(graph.notice?.kind).toBe('unanswerable');
    expect(graph.graphEntities).toEqual([]);
  });

  it('graph_neighborhood: an existing task node with no episode seed is incomplete, not an affirmative empty answer', async () => {
    const projectId = await newProject('MCP6A');
    const made = await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'Projected but never run', tags: ['context-pack-test'] });
    await memory(projectId).reconcile(projectId);

    const pack = await assembleContextPack(appEnv, projectId, made.body.id as string, {});
    const graph = pack.sections.find((s) => s.id === 'graph_neighborhood')!;
    expect(graph.graphEntities).toEqual([]);
    expect(graph.coverage).toMatchObject({ complete: false, reasons: expect.arrayContaining(['task-episode-seed-missing']) });
    expect(graph.notice).toMatchObject({ kind: 'unanswerable' });
  });

  it('graph_neighborhood: a real task episode reaches observed files and derived co-change files with the full edge path', async () => {
    const projectKey = 'MCP6B';
    const projectId = await newProject(projectKey);
    const made = await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'Change two connected files', tags: ['context-pack-test'] });
    const taskId = made.body.id as string;
    const directUri = buildEntityUri({ kind: 'file', projectKey, repositoryKey: 'repo-x', path: 'src/direct.ts' });
    const cochangeUri = buildEntityUri({ kind: 'file', projectKey, repositoryKey: 'repo-x', path: 'src/cochange.ts' });

    await memory(projectId).recordEpisode(projectId, {
      runId: 'run_context_pack_episode', sitting: 1, agentId: null, runKind: 'build', outcome: 'done',
      startedAt: null, finishedAt: null, taskId, taskTitle: 'Change two connected files',
      repositoryKey: 'repo-x', baseId: 'sha-context-pack', timeline: [], filesTouched: ['src/direct.ts'],
      commands: [], testsRun: [], failures: [], findings: [], reviewRounds: 0, tokenUsage: {}, costUSD: 0,
      acceptanceCoverage: 1, steeringEvents: [], landingOutcome: 'landed', remainingWork: [],
      actor: { kind: 'system', id: null },
    });
    const direct = await memory(projectId).writeNode(projectId, {
      type: 'file', uri: directUri, label: 'src/direct.ts', actor: { kind: 'system', id: null },
    });
    const cochange = await memory(projectId).writeNode(projectId, {
      type: 'file', uri: cochangeUri, label: 'src/cochange.ts', actor: { kind: 'system', id: null },
    });
    await memory(projectId).writeEdge(projectId, {
      type: 'commonly_changes_with', fromNodeId: cochange.nodeId, toNodeId: direct.nodeId,
      actor: { kind: 'system', id: null },
    });

    const pack = await assembleContextPack(appEnv, projectId, taskId, { tokenBudget: 30_000 });
    const graph = pack.sections.find((s) => s.id === 'graph_neighborhood')!;
    const directEntity = graph.graphEntities.find((entity) => entity.uri === directUri)!;
    const cochangeEntity = graph.graphEntities.find((entity) => entity.uri === cochangeUri)!;

    expect(graph.coverage).toMatchObject({ complete: true, reasons: [] });
    expect(graph.notice).toBeNull();
    expect(directEntity.depth).toBe(2);
    expect(directEntity.edgePath).toMatch(/>related_to>.*;.*>modifies>/);
    expect(directEntity.edgePath).not.toContain('commonly_changes_with');
    expect(cochangeEntity.depth).toBe(3);
    expect(cochangeEntity.edgePath).toMatch(/>related_to>.*;.*>modifies>.*;.*>commonly_changes_with>/);
  });
});

describe('assembleContextPack — no-Vectorize degradation and read-only', () => {
  it('names its degraded mode (this test harness has no VECTORIZE binding — see wrangler.jsonc) and still answers with task facts + lexical memory + graph', async () => {
    const projectId = await newProject('MCP7');
    const made = await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'Degraded mode probe', tags: ['context-pack-test'] });
    await mcpCall(agent.apiKey, 'record_memory', { projectId, kind: 'learning', statement: 'Degraded mode probe needs no embeddings to be found' });
    const pack = await assembleContextPack(appEnv, projectId, made.body.id as string, {});
    expect(pack.mode).toBe('keyword');
    expect(pack.taskFacts.title).toBe('Degraded mode probe');
    const relevant = pack.sections.find((s) => s.id === 'relevant_memories')!;
    expect(relevant.excerpts.length).toBeGreaterThan(0);
  });

  it('is read-only: assembling packs (including one with a verification report already applied) changes no memory row, validity, or revision', async () => {
    const projectId = await newProject('MCP8');
    const made = await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'Read-only probe', tags: ['context-pack-test'] });
    await mcpCall(agent.apiKey, 'record_memory', {
      projectId, kind: 'decision', statement: 'Read-only probe is settled',
      evidence: [{ repositoryKey: 'repo-x', branch: 'main', baseId: 'sha-ro', path: 'a.ts' }],
    });

    // PLNR-419: settle the task.created event (and anything else pending) deterministically
    // before establishing the read-only boundary — otherwise a later alarm-driven runProjector
    // pass could legitimately land between `before` and `after` and perturb tableCounts, which
    // would misreport assembleContextPack itself as non-read-only.
    await memory(projectId).reconcile(projectId);
    const before = await memory(projectId).health(projectId);
    await assembleContextPack(appEnv, projectId, made.body.id as string, { baseId: 'sha-ro', branch: 'main' });
    await assembleContextPack(appEnv, projectId, made.body.id as string, { tokenBudget: 1 });
    const after = await memory(projectId).health(projectId);
    expect(after).toEqual(before);
  });
});

describe('assembleContextPack — project scoping', () => {
  it('refuses a task that belongs to a DIFFERENT project than the one named', async () => {
    const projectA = await newProject('MCP9A');
    const projectB = await newProject('MCP9B');
    const made = await mcpCall(agent.apiKey, 'create_task', { projectId: projectA, title: 'Lives in A', tags: ['context-pack-test'] });
    await expect(assembleContextPack(appEnv, projectB, made.body.id as string, {})).rejects.toThrow(/not found/);
  });
});

// -------------------------------------------------------------------------------------------
// Layer 3 — the real MCP tool and its REST twin
// -------------------------------------------------------------------------------------------

describe('get_task_context — the real MCP tool', () => {
  it('is registered with READ hints, and role defaults from the calling agent\'s own run kind', async () => {
    const tools = await mcpList(agent.apiKey);
    const tool = tools.find((t) => t.name === 'get_task_context');
    expect(tool).toBeTruthy();
    expect(tool!.description).toMatch(/read-only/i);

    const projectId = await newProject('MCPA1');
    const made = await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'Build-run role probe', tags: ['context-pack-test'] });
    const taskId = made.body.id as string;

    const builder = await createRunAgent(projectId, 'build');
    const res = await mcpCall(builder.apiKey, 'get_task_context', { projectId, taskId });
    expect(res.isError).toBeFalsy();
    expect(res.body.role).toBe('build');

    // Explicit role overrides the derived default.
    const overridden = await mcpCall(builder.apiKey, 'get_task_context', { projectId, taskId, role: 'verify' });
    expect(overridden.body.role).toBe('verify');

    // A copilot (this suite's shared `agent`) with no live run defaults to 'human'.
    const asCopilot = await mcpCall(agent.apiKey, 'get_task_context', { projectId, taskId });
    expect(asCopilot.body.role).toBe('human');
  });

  it('is refused for a project the caller cannot reach, the same way every other project-scoped tool refuses it', async () => {
    await createUser('mcpa2-outsider@example.com', 'Outsider', 'longenough1');
    const outsiderToken = await mintTokenForUser('mcpa2-outsider@example.com');
    const set = await mcpCall(outsiderToken, 'set_agent_identity', { name: 'outsider-mcpa2' });
    expect(set.isError).toBeFalsy();

    const projectId = await newProject('MCPA2'); // owned by the shared `agent` fixture, not the outsider
    const res = await mcpCall(outsiderToken, 'get_task_context', { projectId, taskId: 'task_nope' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not found|not accessible/i);
  });

  it('is refused for a task that exists but belongs to a DIFFERENT project than the one named', async () => {
    const projectA = await newProject('MCPA4A');
    const projectB = await newProject('MCPA4B');
    const made = await mcpCall(agent.apiKey, 'create_task', { projectId: projectA, title: 'Lives in A', tags: ['context-pack-test'] });
    const res = await mcpCall(agent.apiKey, 'get_task_context', { projectId: projectB, taskId: made.body.id as string });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not found/i);
  });
});

describe('/api/projects/:pid/memory/context — the human REST twin', () => {
  it('returns the same assembled pack shape over a session cookie', async () => {
    await createUser('mcpa3-owner@example.com', 'Owner', 'longenough1');
    const cookie = await loginSession('mcpa3-owner@example.com', 'longenough1');
    const token = await mintTokenForUser('mcpa3-owner@example.com');
    const proj = await mcpCall(token, 'create_project', { key: 'MCPA3', name: 'MCPA3 project' });
    const projectId = proj.body.id as string;
    const made = await mcpCall(token, 'create_task', { projectId, title: 'REST twin probe', tags: ['context-pack-test'] });

    const res = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/memory/context`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: made.body.id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { taskFacts: { title: string }; role: string; sections: unknown[] };
    expect(body.taskFacts.title).toBe('REST twin probe');
    expect(body.role).toBe('human');
    expect(Array.isArray(body.sections)).toBe(true);
  });
});
