// PLNR-263: deterministic episode ingest and the canonical episode graph.
//
// Two layers, same split the implementation itself uses:
//   - `recordEpisode` driven DIRECTLY via the ProjectMemory stub — the fast, precise way to pin
//     down upsert/idempotency/self-summary-merge/graph-edge behavior without needing a real Run
//     row for every case (same technique memory-search.test.ts and project-memory-do.test.ts use).
//   - the real `ProjectRoom.transitionRun` → `recordEpisodeForRun` → `ProjectMemory.recordEpisode`
//     path, proving the WIRING itself (a terminal Run really does produce an episode, reachable
//     from its task/run/agent nodes, and a ProjectMemory failure never touches the Run).
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import type { Actor, CreateRunInput, RunPatch, RunView } from '../src/do/ProjectRoom';
import type { Env } from '../src/env';
import { buildEntityUri } from '@noriq-dev/shared';
import { createAgent, mcpCall } from './helpers';

const appEnv = env as unknown as Env;
const actor: Actor = { kind: 'human', id: 'usr_epi_test', name: 'Episode Tester' };

interface RoomRpc {
  createRun(projectId: string, actor: Actor, input: CreateRunInput): Promise<RunView>;
  dispatchRun(projectId: string, actor: Actor, runId: string, runnerId: string): Promise<RunView>;
  transitionRun(projectId: string, actor: Actor, runId: string, patch: RunPatch): Promise<RunView>;
}
const room = (projectId: string) => appEnv.PROJECT_ROOM.get(appEnv.PROJECT_ROOM.idFromName(projectId)) as unknown as RoomRpc;

interface RecordEpisodeInput {
  runId: string; agentId: string | null; runKind: string; outcome: string; startedAt: string | null; finishedAt: string | null;
  taskId: string | null; taskTitle?: string | null; repositoryKey: string | null; baseId: string | null;
  timeline: Array<{ at: string; label: string }>; filesTouched: string[]; commands: string[]; testsRun: string[]; failures: string[];
  findings: Array<{ summary: string; severity?: string }>; reviewRounds: number; tokenUsage: Record<string, unknown>; costUSD: number;
  acceptanceCoverage: number | null; steeringEvents: string[]; landingOutcome: string; remainingWork: string[]; selfSummary?: unknown;
  actor: { kind: string; id: string | null };
}
interface EpisodeUploadRow {
  runId: string; taskId?: string | null; repositoryKey?: string | null; baseId?: string | null;
  timeline?: Array<{ at: string; label: string }>; filesTouched?: string[]; commands?: string[]; testsRun?: string[]; failures?: string[];
  findings?: Array<{ summary: string; severity?: string }>; reviewRounds?: number; tokenUsage?: Record<string, unknown>; costUSD?: number;
  acceptanceCoverage?: number | null; steeringEvents?: string[]; landingOutcome?: string; remainingWork?: string[]; selfSummary?: unknown;
}
interface MemRpc {
  health(pid: string): Promise<{ schemaVersion: number; memoryRevision: number; tableCounts: Record<string, number> }>;
  recordEpisode(
    pid: string,
    input: RecordEpisodeInput,
  ): Promise<{ episodeId: string; runId: string; created: boolean; nodesWritten: number; edgesWritten: number }>;
  recordMemory(
    pid: string,
    input: { kind: string; statement: string; actor: { kind: string; id: string | null } },
  ): Promise<{ memoryId: string }>;
  dependencyNeighborhood(
    pid: string,
    input: { entityUri: string; edgeTypes?: string[] },
  ): Promise<{ upstream: Array<{ uri: string; type: string }>; downstream: Array<{ uri: string; type: string }> }>;
  searchProjectMemory(
    pid: string,
    opts: { episodeId?: string },
  ): Promise<{ results: Array<{ id: string; title: string; snippet: string; status?: string }> }>;
  _setForceWriteFailure(pid: string, fail: boolean): Promise<void>;
  beginEpisodeIngest(pid: string, manifest: { scopeId: string; projectId: string; batchCount: number }): Promise<{ ok: true }>;
  ingestEpisodeBatch(pid: string, scopeId: string, batchNumber: number, rows: EpisodeUploadRow[]): Promise<{ ok: true; deduped: boolean }>;
  completeEpisodeIngest(
    pid: string,
    scopeId: string,
  ): Promise<{ ok: true; batchesReceived: number; rowCount: number; recorded: number; skipped: number }>;
}
const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as MemRpc;

/** A full, minimal `recordEpisode` input — every case below starts here and overrides only what
 *  it needs, so a test reads as "what's different" rather than restating the whole shape. */
function baseEpisodeInput(runId: string, overrides: Partial<RecordEpisodeInput> = {}): RecordEpisodeInput {
  return {
    runId, agentId: null, runKind: 'build', outcome: 'done', startedAt: null, finishedAt: null,
    taskId: null, repositoryKey: null, baseId: null, timeline: [], filesTouched: [], commands: [],
    testsRun: [], failures: [], findings: [], reviewRounds: 0, tokenUsage: {}, costUSD: 0,
    acceptanceCoverage: null, steeringEvents: [], landingOutcome: 'pending', remainingWork: [],
    actor: { kind: 'system', id: null },
    ...overrides,
  };
}

let agent: { id: string; apiKey: string };
const seedRunner = (id: string) => env.DB.prepare('INSERT OR IGNORE INTO runners (id, label) VALUES (?, ?)').bind(id, id).run();
const seedAgent = (id: string, runnerId: string, projectId: string) =>
  env.DB.prepare(`INSERT OR IGNORE INTO agents (id, name, kind, runner_id, project_id) VALUES (?, ?, 'agent', ?, ?)`)
    .bind(id, id, runnerId, projectId).run();

async function newProject(key: string): Promise<string> {
  const r = await mcpCall(agent.apiKey, 'create_project', { key, name: `${key} project` });
  if (r.isError) throw new Error(`create_project(${key}) failed: ${r.text}`);
  return r.body.id as string;
}

beforeAll(async () => {
  agent = await createAgent('memory-episodes-agent');
}, 60000);

describe('ProjectMemory.recordEpisode — the deterministic writer (§14)', () => {
  it('creates one episode row and links it to its own run via derived_from', async () => {
    const projectId = await newProject('MEPI1');
    const runId = 'run_epi_solo';
    const result = await memory(projectId).recordEpisode(projectId, baseEpisodeInput(runId));
    expect(result.created).toBe(true);
    expect(result.runId).toBe(runId);

    const runUri = buildEntityUri({ kind: 'run', id: runId });
    const neighborhood = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: runUri, edgeTypes: ['derived_from'] });
    // The edge is episode --derived_from--> run, so from the RUN's own seed the episode is
    // reached walking BACKWARD over that edge — dependencyNeighborhood's `upstream` side.
    expect(neighborhood.upstream).toEqual([expect.objectContaining({ type: 'episode', uri: buildEntityUri({ kind: 'episode', id: result.episodeId }) })]);
  });

  it('links to the task, the owning agent, each touched file, and memories that agent recorded — five edges total', async () => {
    const projectId = await newProject('MEPI2');
    const made = await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'the task an episode cites', tags: ['episode-test'] });
    const taskId = made.body.id as string;
    await seedRunner('rnr_epi2');
    await seedAgent('agt_epi2', 'rnr_epi2', projectId);
    // A memory this SAME agent recorded — the correlation is by recorded_by_agent_id, not by
    // any explicit list the caller passes (a runner-spawned agent lives for exactly one run,
    // RUN-43, so this is exactly "what this run learned").
    const mem = await memory(projectId).recordMemory(projectId, {
      kind: 'learning', statement: 'the flaky test needed a retry, not a fix', actor: { kind: 'agent', id: 'agt_epi2' },
    });

    const runId = 'run_epi_linked';
    const result = await memory(projectId).recordEpisode(projectId, baseEpisodeInput(runId, {
      taskId, agentId: 'agt_epi2', repositoryKey: 'repo1', filesTouched: ['src/flaky.test.ts'],
    }));
    expect(result.edgesWritten).toBe(5); // derived_from + related_to(task) + owned_by + modifies + related_to(memory)

    const episodeUri = buildEntityUri({ kind: 'episode', id: result.episodeId });
    const taskNeighborhood = await memory(projectId).dependencyNeighborhood(projectId, {
      entityUri: buildEntityUri({ kind: 'task', id: taskId }), edgeTypes: ['related_to'],
    });
    expect(taskNeighborhood.upstream.some((e) => e.uri === episodeUri)).toBe(true);

    const agentNeighborhood = await memory(projectId).dependencyNeighborhood(projectId, {
      entityUri: buildEntityUri({ kind: 'agent', id: 'agt_epi2' }), edgeTypes: ['owned_by'],
    });
    expect(agentNeighborhood.upstream.some((e) => e.uri === episodeUri)).toBe(true);

    const fileNeighborhood = await memory(projectId).dependencyNeighborhood(projectId, {
      entityUri: buildEntityUri({ kind: 'file', projectKey: 'MEPI2', repositoryKey: 'repo1', path: 'src/flaky.test.ts' }),
      edgeTypes: ['modifies'],
    });
    expect(fileNeighborhood.upstream.some((e) => e.uri === episodeUri)).toBe(true);

    const memoryNeighborhood = await memory(projectId).dependencyNeighborhood(projectId, {
      entityUri: buildEntityUri({ kind: 'memory', id: mem.memoryId }), edgeTypes: ['related_to'],
    });
    expect(memoryNeighborhood.upstream.some((e) => e.uri === episodeUri)).toBe(true);
  });

  it('recording the same run twice is idempotent: one row, one node, no duplicate edges, one revision bump each time', async () => {
    const projectId = await newProject('MEPI3');
    const runId = 'run_epi_dupe';
    const input = baseEpisodeInput(runId, { findings: [{ summary: 'duplicate delivery must not pile up' }] });

    const before = await memory(projectId).health(projectId);
    const first = await memory(projectId).recordEpisode(projectId, input);
    const afterFirst = await memory(projectId).health(projectId);
    const second = await memory(projectId).recordEpisode(projectId, input);
    const afterSecond = await memory(projectId).health(projectId);

    expect(first.episodeId).toBe(second.episodeId);
    expect(second.created).toBe(false);
    // Table counts identical after the redelivery — nothing accumulated.
    expect(afterSecond.tableCounts.episodes).toBe(afterFirst.tableCounts.episodes);
    expect(afterSecond.tableCounts.nodes).toBe(afterFirst.tableCounts.nodes);
    expect(afterSecond.tableCounts.edges).toBe(afterFirst.tableCounts.edges);
    // The revision bump is the SAME size both times — the second call is not a no-op internally
    // (it re-affirms the same facts), but it is not a bigger operation either.
    expect(afterFirst.memoryRevision - before.memoryRevision).toBe(afterSecond.memoryRevision - afterFirst.memoryRevision);
  });

  it('a present self-summary enriches the episode, and a later skeleton-only write does not erase it', async () => {
    const projectId = await newProject('MEPI4');
    const runId = 'run_epi_summary';
    await memory(projectId).recordEpisode(projectId, baseEpisodeInput(runId, {
      selfSummary: { approachSummary: 'tried a retry loop before finding the real race', rejectedHypotheses: [], durableLearnings: [], unresolvedQuestions: [] },
    }));
    // A later write for the SAME run carries no selfSummary at all — e.g. a replayed skeleton.
    const { episodeId } = await memory(projectId).recordEpisode(projectId, baseEpisodeInput(runId, { costUSD: 1.5 }));

    const { results } = await memory(projectId).searchProjectMemory(projectId, { episodeId });
    expect(results[0]!.snippet).toContain('tried a retry loop before finding the real race');
  });

  it('an absent or malformed self-summary does not discard the deterministic evidence already recorded', async () => {
    const projectId = await newProject('MEPI5');
    const runId = 'run_epi_malformed';
    const { episodeId } = await memory(projectId).recordEpisode(projectId, baseEpisodeInput(runId, {
      findings: [{ summary: 'the deterministic half must survive a garbage self-summary' }],
      selfSummary: 'not an object — a daemon bug, not a valid EpisodeSelfSummary',
    }));
    const { results } = await memory(projectId).searchProjectMemory(projectId, { episodeId });
    expect(results).toHaveLength(1);
    expect(results[0]!.snippet).toContain('the deterministic half must survive a garbage self-summary');
  });

  it('searchProjectMemory with episodeId returns the episode with its live landing outcome', async () => {
    const projectId = await newProject('MEPI6');
    const { episodeId } = await memory(projectId).recordEpisode(projectId, baseEpisodeInput('run_epi_outcome', { landingOutcome: 'landed' }));
    const { results } = await memory(projectId).searchProjectMemory(projectId, { episodeId });
    expect(results[0]).toMatchObject({ id: episodeId, status: 'landed' });
  });
});

describe('a terminal Run produces its deterministic episode (ProjectRoom → recordEpisodeForRun)', () => {
  it.each(['done', 'failed', 'cancelled'] as const)('a build run reaching %s produces exactly one episode, reachable from its task/run/agent nodes', async (outcome) => {
    const projectId = await newProject(`MEPIR${outcome[0]!.toUpperCase()}`);
    const made = await mcpCall(agent.apiKey, 'create_task', { projectId, title: `task settled by a ${outcome} run`, tags: ['episode-test'] });
    const taskId = made.body.id as string;
    const runnerId = `rnr_epir_${outcome}`;
    const agentId = `agt_epir_${outcome}`;
    await seedRunner(runnerId);
    await seedAgent(agentId, runnerId, projectId);

    const run = await room(projectId).createRun(projectId, actor, {
      kind: 'build', repoRef: 'r', agentTool: 'claude', anchor: { type: 'task', id: taskId },
    });
    await room(projectId).dispatchRun(projectId, actor, run.id, runnerId);
    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'running', agentId });
    const settled = await room(projectId).transitionRun(projectId, actor, run.id, { status: outcome });
    expect(settled.status).toBe(outcome);

    // Fire-and-forget (§19) — poll briefly for it to land, same technique memory-registry.test.ts
    // uses for the erasure fire-and-forget.
    const runUri = buildEntityUri({ kind: 'run', id: run.id });
    let episodeUri: string | null = null;
    for (let i = 0; i < 20 && !episodeUri; i++) {
      const neighborhood = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: runUri, edgeTypes: ['derived_from'] });
      episodeUri = neighborhood.upstream.find((e) => e.type === 'episode')?.uri ?? null;
      if (!episodeUri) await new Promise((r) => setTimeout(r, 50));
    }
    expect(episodeUri).not.toBeNull();

    const taskNeighborhood = await memory(projectId).dependencyNeighborhood(projectId, {
      entityUri: buildEntityUri({ kind: 'task', id: taskId }), edgeTypes: ['related_to'],
    });
    expect(taskNeighborhood.upstream.some((e) => e.uri === episodeUri)).toBe(true);

    const agentNeighborhood = await memory(projectId).dependencyNeighborhood(projectId, {
      entityUri: buildEntityUri({ kind: 'agent', id: agentId }), edgeTypes: ['owned_by'],
    });
    expect(agentNeighborhood.upstream.some((e) => e.uri === episodeUri)).toBe(true);

    const episodeId = episodeUri!.split('/').pop()!;
    const { results } = await memory(projectId).searchProjectMemory(projectId, { episodeId });
    expect(results[0]!.title).toContain(run.id);
  });

  it('a ProjectMemory write failure never fails, delays, or alters the run\'s terminal transition', async () => {
    const projectId = await newProject('MEPIFAIL');
    const runnerId = 'rnr_epi_fail';
    const agentId = 'agt_epi_fail';
    await seedRunner(runnerId);
    await seedAgent(agentId, runnerId, projectId);
    await memory(projectId)._setForceWriteFailure(projectId, true);
    try {
      const run = await room(projectId).createRun(projectId, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude' });
      await room(projectId).dispatchRun(projectId, actor, run.id, runnerId);
      await room(projectId).transitionRun(projectId, actor, run.id, { status: 'running', agentId });
      const done = await room(projectId).transitionRun(projectId, actor, run.id, { status: 'done' });
      expect(done.status).toBe('done');
      expect(done.exit).toMatchObject({ outcome: 'done' });
    } finally {
      await memory(projectId)._setForceWriteFailure(projectId, false);
    }
  });
});

describe('episode upload ingest — completeEpisodeIngest parses rows as EffortEpisode and calls the real writer', () => {
  it('records a real episode from an uploaded row, resolving identity from the run itself (never trusting the payload)', async () => {
    const projectId = await newProject('MEPIING1');
    const runnerId = 'rnr_epi_ing1';
    const agentId = 'agt_epi_ing1';
    await seedRunner(runnerId);
    await seedAgent(agentId, runnerId, projectId);
    const run = await room(projectId).createRun(projectId, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude' });
    await room(projectId).dispatchRun(projectId, actor, run.id, runnerId);
    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'running', agentId });
    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'done' });

    const scopeId = run.id;
    await memory(projectId).beginEpisodeIngest(projectId, { scopeId, projectId, batchCount: 1 });
    await memory(projectId).ingestEpisodeBatch(projectId, scopeId, 0, [
      { runId: run.id, findings: [{ summary: 'the daemon observed a slow query in the diff' }], filesTouched: ['src/slow.ts'] },
    ]);
    const completed = await memory(projectId).completeEpisodeIngest(projectId, scopeId);
    expect(completed.recorded).toBe(1);
    expect(completed.skipped).toBe(0);

    const runUri = buildEntityUri({ kind: 'run', id: run.id });
    const neighborhood = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: runUri, edgeTypes: ['derived_from'] });
    const episodeUri = neighborhood.upstream.find((e) => e.type === 'episode')!.uri;
    const episodeId = episodeUri.split('/').pop()!;
    const { results } = await memory(projectId).searchProjectMemory(projectId, { episodeId });
    // Enriches the automatically-recorded skeleton from the SAME run (whichever call landed
    // first) — one row either way, per the run_id UNIQUE index.
    expect(results[0]!.snippet).toContain('the daemon observed a slow query in the diff');
  });

  it('skips a malformed uploaded row and one naming an unknown run, without failing the rest of the batch', async () => {
    const projectId = await newProject('MEPIING2');
    const runnerId = 'rnr_epi_ing2';
    const agentId = 'agt_epi_ing2';
    await seedRunner(runnerId);
    await seedAgent(agentId, runnerId, projectId);
    const run = await room(projectId).createRun(projectId, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude' });
    await room(projectId).dispatchRun(projectId, actor, run.id, runnerId);
    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'running', agentId });
    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'done' });

    const scopeId = `${run.id}_batch2`;
    await memory(projectId).beginEpisodeIngest(projectId, { scopeId, projectId, batchCount: 1 });
    await memory(projectId).ingestEpisodeBatch(projectId, scopeId, 0, [
      { runId: run.id, landingOutcome: 'not-a-real-outcome' as unknown as string }, // fails EffortEpisode's enum
      { runId: 'run_does_not_exist' }, // parses fine, but no such run in this project
    ]);
    const completed = await memory(projectId).completeEpisodeIngest(projectId, scopeId);
    expect(completed.recorded).toBe(0);
    expect(completed.skipped).toBe(2);
  });
});
