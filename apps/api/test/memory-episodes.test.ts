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
import { buildEntityUri, IntelligenceContextConsumptionMetric, ProjectIntelligenceEpisode, UploadedEpisodeIntelligence } from '@noriq-dev/shared';
import { createAgent, mcpCall } from './helpers';
import {
  processPendingCopilotEpisodeJob, recordEpisodeForCopilotClaim,
  recordEpisodeForRun, sweepPendingEpisodeJobs,
} from '../src/memory/episodes';

const appEnv = env as unknown as Env;
const actor: Actor = { kind: 'human', id: 'usr_epi_test', name: 'Episode Tester' };

interface RoomRpc {
  createRun(projectId: string, actor: Actor, input: CreateRunInput): Promise<RunView>;
  dispatchRun(projectId: string, actor: Actor, runId: string, runnerId: string): Promise<RunView>;
  transitionRun(projectId: string, actor: Actor, runId: string, patch: RunPatch): Promise<RunView>;
  reopenRun(projectId: string, actor: Actor, runId: string, rounds: number | null): Promise<RunView>;
  recordRunTelemetry(projectId: string, runId: string, telemetry: Record<string, unknown>): Promise<void>;
}
const room = (projectId: string) => appEnv.PROJECT_ROOM.get(appEnv.PROJECT_ROOM.idFromName(projectId)) as unknown as RoomRpc;

interface RecordEpisodeInput {
  runId: string; sitting: number; agentId: string | null; runKind: string; outcome: string; startedAt: string | null; finishedAt: string | null;
  taskId: string | null; taskTitle?: string | null; repositoryKey: string | null; baseId: string | null;
  timeline: Array<{ at: string; label: string }>; filesTouched: string[]; commands: string[]; testsRun: string[]; failures: string[];
  findings: Array<{ summary: string; severity?: string }>; reviewRounds: number; tokenUsage: Record<string, unknown>; costUSD: number;
  acceptanceCoverage: number | null; steeringEvents: string[]; landingOutcome: string; remainingWork: string[]; selfSummary?: unknown;
  actor: { kind: string; id: string | null }; writeMode?: 'replace' | 'skeleton' | 'enrichment';
}
interface EpisodeUploadRow {
  runId: string; taskId?: string | null; repositoryKey?: string | null; baseId?: string | null;
  timeline?: Array<{ at: string; label: string }>; filesTouched?: string[]; commands?: string[]; testsRun?: string[]; failures?: string[];
  findings?: Array<{ summary: string; severity?: string }>; reviewRounds?: number; tokenUsage?: Record<string, unknown>; costUSD?: number;
  acceptanceCoverage?: number | null; steeringEvents?: string[]; landingOutcome?: string; remainingWork?: string[]; selfSummary?: unknown;
  intelligence?: Record<string, unknown>;
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
  runProjector(pid: string): Promise<{ applied: number; cursor: number }>;
  _setForceWriteFailure(pid: string, fail: boolean): Promise<void>;
  beginEpisodeIngest(pid: string, manifest: { scopeId: string; projectId: string; batchCount: number }): Promise<{ ok: true }>;
  ingestEpisodeBatch(pid: string, scopeId: string, batchNumber: number, rows: EpisodeUploadRow[]): Promise<{ ok: true; deduped: boolean }>;
  completeEpisodeIngest(
    pid: string,
    scopeId: string,
  ): Promise<{ ok: true; batchesReceived: number; rowCount: number; recorded: number; skipped: number }>;
  _getEpisodeForTest(pid: string, runId: string, sitting?: number): Promise<Record<string, unknown> | null>;
}
const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as MemRpc;

/** A full, minimal `recordEpisode` input — every case below starts here and overrides only what
 *  it needs, so a test reads as "what's different" rather than restating the whole shape. */
function baseEpisodeInput(runId: string, overrides: Partial<RecordEpisodeInput> = {}): RecordEpisodeInput {
  return {
    runId, sitting: 1, agentId: null, runKind: 'build', outcome: 'done', startedAt: null, finishedAt: null,
    taskId: null, repositoryKey: null, baseId: null, timeline: [], filesTouched: [], commands: [],
    testsRun: [], failures: [], findings: [], reviewRounds: 0, tokenUsage: {}, costUSD: 0,
    acceptanceCoverage: null, steeringEvents: [], landingOutcome: 'pending', remainingWork: [],
    actor: { kind: 'system', id: null },
    ...overrides,
  };
}

const DAEMON_OBSERVED_AT = '2026-08-10T18:00:00.000Z';
const FORGED_ACCEPTED_AT = '2000-01-01T00:00:00.000Z';
function daemonMetric<T>(
  value: T,
  provenance: 'runner_observed' | 'backend_observed' | 'derived' | 'driver_reported' = 'runner_observed',
  source: 'runner' | 'vcs_backend' | 'driver' = 'runner',
) {
  return {
    status: 'complete' as const,
    value,
    provenance,
    source,
    sourceId: 'daemon-source',
    observedAt: DAEMON_OBSERVED_AT,
    acceptedAt: FORGED_ACCEPTED_AT,
    reason: null,
  };
}
/** RUN-243: a metric can be genuinely unavailable (e.g. a Codex reviewer reports tokens but
 * never sets cost) while still carrying legitimate daemon provenance — `unavailable` is itself
 * a MetricProvenance member and DAEMON_PROVENANCE must accept it. */
function unavailableDaemonMetric(source: 'runner' | 'vcs_backend' | 'driver' = 'driver') {
  return {
    status: 'unavailable' as const,
    value: null,
    provenance: 'unavailable' as const,
    source,
    sourceId: 'daemon-source',
    observedAt: DAEMON_OBSERVED_AT,
    acceptedAt: FORGED_ACCEPTED_AT,
    reason: 'not reported by the daemon',
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

    await memory(projectId).runProjector(projectId);
    const before = await memory(projectId).health(projectId);
    const first = await memory(projectId).recordEpisode(projectId, input);
    await memory(projectId).runProjector(projectId);
    const afterFirst = await memory(projectId).health(projectId);
    const second = await memory(projectId).recordEpisode(projectId, input);
    await memory(projectId).runProjector(projectId);
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
  it('keeps immutable commissioning facts distinct from the executed spec and later task drift', async () => {
    const projectId = await newProject('MEPIINT');
    const commissionedSpec = {
      requirementIds: ['BEFORE-DISPATCH'],
      anticipatedFiles: [{ path: 'src/commissioned.ts', action: 'modify' }],
    };
    const executedSpec = {
      requirementIds: ['EXECUTED'],
      acceptance: { observableTruths: ['the Runner used this contract'] },
    };
    const made = await mcpCall(agent.apiKey, 'create_task', {
      projectId, title: 'title at commissioning', type: 'research', tags: ['commissioned-tag'],
      allowNewTags: true, executionSpec: commissionedSpec,
    });
    const taskId = made.body.id as string;
    const runnerId = 'rnr_epi_int';
    const agentId = 'agt_epi_int';
    await seedRunner(runnerId);
    await seedAgent(agentId, runnerId, projectId);

    const run = await room(projectId).createRun(projectId, actor, {
      kind: 'build', repoRef: 'r', agentTool: 'codex', model: 'gpt-5', effort: 'high', workflow: 'careful',
      anchor: { type: 'task', id: taskId },
    });
    await room(projectId).dispatchRun(projectId, actor, run.id, runnerId);
    await room(projectId).recordRunTelemetry(projectId, run.id, {
      executedSpec,
      executedConfiguration: {
        strategy: {
          tool: 'codex', vendor: 'openai', model: 'gpt-5-resolved', effort: 'high', workflow: 'careful',
          reviewer: null, verifier: null, contextStrategy: null, concurrencyStrategy: null,
        },
        configuration: [{ kind: 'runner', name: runnerId, version: 'test', fingerprint: 'runner-test' }],
      },
    });

    // These are intentionally mutable live facts. The terminal episode must not use them to
    // reconstruct what was commissioned earlier.
    await env.DB.prepare(
      `UPDATE tasks SET title = 'title after drift', type = 'bug', execution_spec = NULL WHERE id = ?`,
    ).bind(taskId).run();
    await env.DB.prepare('DELETE FROM task_tags WHERE task_id = ?').bind(taskId).run();

    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'running', agentId });
    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'done' });
    let episode: Record<string, unknown> | null = null;
    for (let i = 0; i < 20 && !episode; i++) {
      episode = await memory(projectId)._getEpisodeForTest(projectId, run.id);
      if (!episode) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const intelligence = episode?.intelligence as Record<string, any>;
    expect(intelligence.identity).toMatchObject({
      episodeId: episode?.id, projectId, runId: run.id, sitting: 1, taskId,
      orchestrationId: expect.stringMatching(/^orc_/), executionId: expect.stringMatching(/^exe_/),
    });
    expect(intelligence.preExecution.task).toMatchObject({ taskType: 'research', tags: ['commissioned-tag'] });
    expect(intelligence.preExecution.commissionedSpec.requirementIds).toEqual(['BEFORE-DISPATCH']);
    expect(intelligence.execution.executedSpec.requirementIds).toEqual(['EXECUTED']);
    expect(intelligence.execution.executedStrategy).toMatchObject({ vendor: 'openai', model: 'gpt-5-resolved' });
    expect(intelligence.preExecution.commissionedStrategy).toMatchObject({
      tool: 'codex', model: 'gpt-5', effort: 'high', workflow: 'careful',
    });
    expect(intelligence.execution.observedModelUsage).toMatchObject({ status: 'unavailable', value: null });
    expect(intelligence.execution.changes.changedFiles).toMatchObject({ status: 'unavailable', value: null });
  });

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

  it('a ProjectMemory write failure never alters the terminal transition and its durable job retries successfully', async () => {
    const projectId = await newProject('MEPIFAIL');
    const runnerId = 'rnr_epi_fail';
    const agentId = 'agt_epi_fail';
    await seedRunner(runnerId);
    await seedAgent(agentId, runnerId, projectId);
    await memory(projectId)._setForceWriteFailure(projectId, true);
    const run = await room(projectId).createRun(projectId, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude' });
    try {
      await room(projectId).dispatchRun(projectId, actor, run.id, runnerId);
      await room(projectId).transitionRun(projectId, actor, run.id, { status: 'running', agentId });
      const done = await room(projectId).transitionRun(projectId, actor, run.id, { status: 'done' });
      expect(done.status).toBe('done');
      expect(done.exit).toMatchObject({ outcome: 'done' });

      // Wait until the background attempt has actually failed, proving this is the retry path
      // rather than racing the initial delivery after fault injection is disabled.
      let attempts = 0;
      for (let i = 0; i < 20 && attempts === 0; i++) {
        attempts = (await appEnv.DB.prepare(
          'SELECT attempts FROM memory_episode_jobs WHERE run_id = ? AND sitting = 1',
        ).bind(run.id).first<{ attempts: number }>())?.attempts ?? 0;
        if (attempts === 0) await new Promise((r) => setTimeout(r, 25));
      }
      expect(attempts).toBeGreaterThan(0);
    } finally {
      await memory(projectId)._setForceWriteFailure(projectId, false);
    }

    expect(await sweepPendingEpisodeJobs(appEnv)).toMatchObject({ completed: 1 });
    expect(await appEnv.DB.prepare(
      'SELECT 1 FROM memory_episode_jobs WHERE run_id = ? AND sitting = 1',
    ).bind(run.id).first()).toBeNull();
    const neighborhood = await memory(projectId).dependencyNeighborhood(projectId, {
      entityUri: buildEntityUri({ kind: 'run', id: run.id }), edgeTypes: ['derived_from'],
    });
    expect(neighborhood.upstream.some((e) => e.type === 'episode')).toBe(true);
  });

  // PLNR-263 correction: `reopenRun` (RUN-182, "continue a failed run") reuses the SAME run id
  // for a second sitting — it does NOT mint a new run. Before migration 0075/0007, the reopened
  // sitting's terminal transition would upsert straight over the failed sitting's episode (both
  // shared one `run_id`), destroying it. Episode identity is now (run_id, sitting), so the failed
  // sitting's episode must survive a reopen-then-succeed cycle intact, and the successful
  // sitting must get its OWN episode — both reachable from the one task they share.
  it('a failed sitting keeps its own episode across a reopen — the next sitting gets its own, both linked to the same task', async () => {
    const projectId = await newProject('MEPISIT');
    const made = await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'task worked across two sittings', tags: ['episode-test'] });
    const taskId = made.body.id as string;
    const runnerId = 'rnr_epi_sit';
    const agentSitting1 = 'agt_epi_sit1';
    const agentSitting2 = 'agt_epi_sit2';
    await seedRunner(runnerId);
    // reopenRun (unlike a fresh dispatch) insists the SAME runner is still online and still
    // advertises the repo — it is reclaiming a machine-local worktree, not picking a new home.
    await env.DB.prepare(`UPDATE runners SET status = 'online', repos = ? WHERE id = ?`)
      .bind(JSON.stringify([{ id: 'r' }]), runnerId).run();
    await seedAgent(agentSitting1, runnerId, projectId);
    await seedAgent(agentSitting2, runnerId, projectId);

    const run = await room(projectId).createRun(projectId, actor, {
      kind: 'build', repoRef: 'r', agentTool: 'claude', anchor: { type: 'task', id: taskId },
    });
    await room(projectId).dispatchRun(projectId, actor, run.id, runnerId);
    await room(projectId).recordRunTelemetry(projectId, run.id, {
      executedSpec: { requirementIds: ['SITTING-1'] },
    });
    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'running', agentId: agentSitting1 });
    const failed = await room(projectId).transitionRun(projectId, actor, run.id, { status: 'failed' });
    expect(failed.status).toBe('failed');

    const runUri = buildEntityUri({ kind: 'run', id: run.id });
    const episodeUrisAfter = async (count: number): Promise<string[]> => {
      let uris: string[] = [];
      for (let i = 0; i < 20 && uris.length < count; i++) {
        const neighborhood = await memory(projectId).dependencyNeighborhood(projectId, { entityUri: runUri, edgeTypes: ['derived_from'] });
        uris = neighborhood.upstream.filter((e) => e.type === 'episode').map((e) => e.uri);
        if (uris.length < count) await new Promise((r) => setTimeout(r, 50));
      }
      return uris;
    };

    // Sitting 1's episode lands (fire-and-forget) before we reopen.
    const afterSitting1 = await episodeUrisAfter(1);
    expect(afterSitting1).toHaveLength(1);
    const episodeId1 = afterSitting1[0]!.split('/').pop()!;
    const failedHit = await memory(projectId).searchProjectMemory(projectId, { episodeId: episodeId1 });
    expect(failedHit.results[0]).toMatchObject({ id: episodeId1, status: 'failed' });

    // Continue the failed run — RUN-182's reopenRun, same run id, new sitting.
    await room(projectId).reopenRun(projectId, actor, run.id, null);
    await room(projectId).recordRunTelemetry(projectId, run.id, {
      executedSpec: { requirementIds: ['SITTING-2'] },
    });
    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'running', agentId: agentSitting2 });
    const done = await room(projectId).transitionRun(projectId, actor, run.id, { status: 'done' });
    expect(done.status).toBe('done');

    // Sitting 2 produces its OWN episode — now TWO, both hanging off the same run node — and
    // sitting 1's episode is untouched (still 'failed'), not overwritten by sitting 2's 'done'.
    const afterSitting2 = await episodeUrisAfter(2);
    expect(afterSitting2).toHaveLength(2);
    expect(afterSitting2).toContain(afterSitting1[0]);
    const episodeId2 = afterSitting2.find((u) => u !== afterSitting1[0])!.split('/').pop()!;

    const stillFailedHit = await memory(projectId).searchProjectMemory(projectId, { episodeId: episodeId1 });
    expect(stillFailedHit.results[0]).toMatchObject({ id: episodeId1, status: 'failed' });
    const newHit = await memory(projectId).searchProjectMemory(projectId, { episodeId: episodeId2 });
    // 'pending' (not 'failed'): a done sitting with no merged PR is "awaiting review", the
    // ordinary state — see landingOutcomeFor's doc comment in memory/episodes.ts.
    expect(newHit.results[0]).toMatchObject({ id: episodeId2, status: 'pending' });

    const sittingFacts = (await env.DB.prepare(
      `SELECT sitting, executed_specs AS executedSpecs FROM run_sitting_intelligence
        WHERE run_id = ? ORDER BY sitting`,
    ).bind(run.id).all<{ sitting: number; executedSpecs: string }>()).results;
    expect(sittingFacts.map((row) => ({
      sitting: row.sitting,
      requirementId: (JSON.parse(row.executedSpecs) as Array<{ requirementIds: string[] }>)[0]!.requirementIds[0],
    }))).toEqual([
      { sitting: 1, requirementId: 'SITTING-1' },
      { sitting: 2, requirementId: 'SITTING-2' },
    ]);

    // Both episodes are reachable from the ONE task they share — the acceptance line's "linked
    // to the earlier one" is this shared task neighborhood, not a direct episode-to-episode edge.
    const taskNeighborhood = await memory(projectId).dependencyNeighborhood(projectId, {
      entityUri: buildEntityUri({ kind: 'task', id: taskId }), edgeTypes: ['related_to'],
    });
    const linkedEpisodeUris = taskNeighborhood.upstream.filter((e) => e.type === 'episode').map((e) => e.uri);
    expect(linkedEpisodeUris).toEqual(expect.arrayContaining(afterSitting2));
  });
});

describe('Copilot claim episodes (PLNR-483)', () => {
  it('records one discriminated episode without a Run and keeps IDE testimony driver-reported', async () => {
    const projectId = await newProject('MEPICOP');
    const made = await mcpCall(agent.apiKey, 'create_task', {
      projectId, title: 'Implement from an IDE', tags: ['episode-test'],
      executionSpec: { anticipatedFiles: [{ path: 'src/expected.ts', change: 'modify', why: 'planned scope' }] },
    });
    const taskId = made.body.id as string;
    const claimed = await mcpCall(agent.apiKey, 'claim_task', { projectId, taskId, workRole: 'verify' });
    const claimId = claimed.body.claimId as string;
    expect(claimed.body.executionId).toMatch(/^exe_/);

    const released = await mcpCall(agent.apiKey, 'release_task', {
      projectId, taskId, toStatus: 'review', commitId: 'copilot-commit-1',
      workEvidence: {
        filesTouched: ['src/reported.ts'], testsRun: ['npm test -- reported'],
        outcomeSummary: 'IDE reported that focused verification passed',
      },
    });
    expect(released.isError).toBe(false);
    await processPendingCopilotEpisodeJob(appEnv, projectId, claimId).catch(() => false);

    const first = await recordEpisodeForCopilotClaim(appEnv, projectId, claimId);
    const second = await recordEpisodeForCopilotClaim(appEnv, projectId, claimId);
    expect(second.episodeId).toBe(first.episodeId);
    expect(second.created).toBe(false);
    expect(await appEnv.DB.prepare('SELECT id FROM runs WHERE id = ?').bind(claimId).first()).toBeNull();

    const episode = await memory(projectId)._getEpisodeForTest(projectId, claimId, 1) as any;
    expect(episode).toMatchObject({
      runId: claimId,
      workSource: { kind: 'copilot_claim', claimId, executionId: claimed.body.executionId },
      taskId, baseId: 'copilot-commit-1', filesTouched: [], testsRun: [],
      reportedEvidence: {
        provenance: 'driver_reported', source: 'driver', sourceId: claimId,
        filesTouched: ['src/reported.ts'], testsRun: ['npm test -- reported'],
      },
      intelligence: {
        identity: { workSource: { kind: 'copilot_claim', claimId } },
        execution: {
          observedModelUsage: { status: 'unavailable', value: null },
          changes: { changedFiles: { status: 'partial', provenance: 'driver_reported', value: 1 } },
        },
      },
    });
  });

  it('commits release and retains a retry job when ProjectMemory episode recording fails', async () => {
    const projectId = await newProject('MEPICF');
    const made = await mcpCall(agent.apiKey, 'create_task', {
      projectId, title: 'Release despite analytics outage', tags: ['episode-test'],
    });
    const taskId = made.body.id as string;
    const claimed = await mcpCall(agent.apiKey, 'claim_task', { projectId, taskId });
    const claimId = claimed.body.claimId as string;
    await memory(projectId)._setForceWriteFailure(projectId, true);

    const released = await mcpCall(agent.apiKey, 'release_task', {
      projectId, taskId, toStatus: 'review', commitId: 'copilot-commit-retry',
    });
    expect(released.isError).toBe(false);
    expect(await appEnv.DB.prepare('SELECT status, claimed_by AS claimedBy FROM tasks WHERE id = ?')
      .bind(taskId).first()).toMatchObject({ status: 'review', claimedBy: null });
    expect(await appEnv.DB.prepare('SELECT claim_id AS claimId FROM copilot_episode_jobs WHERE claim_id = ?')
      .bind(claimId).first()).toEqual({ claimId });

    await memory(projectId)._setForceWriteFailure(projectId, false);
    const swept = await sweepPendingEpisodeJobs(appEnv);
    expect(swept.completed).toBeGreaterThanOrEqual(1);
    expect(await memory(projectId)._getEpisodeForTest(projectId, claimId, 1)).not.toBeNull();
    expect(await appEnv.DB.prepare('SELECT 1 FROM copilot_episode_jobs WHERE claim_id = ?')
      .bind(claimId).first()).toBeNull();
  });
});

describe('episode upload ingest — completeEpisodeIngest merges partial enrichment over the server skeleton', () => {
  it('preserves every server-built field while applying daemon enrichment and ignoring forged skeleton fields', async () => {
    const projectId = await newProject('MEPIING1');
    const runnerId = 'rnr_epi_ing1';
    const agentId = 'agt_epi_ing1';
    const made = await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'authoritative episode task', tags: ['episode-test'] });
    const taskId = made.body.id as string;
    await mcpCall(agent.apiKey, 'attach_ref', { taskId, kind: 'commit', ref: 'server-base-sha' });
    await seedRunner(runnerId);
    await appEnv.DB.prepare('UPDATE runners SET version = ? WHERE id = ?').bind('server-runner-v1', runnerId).run();
    await seedAgent(agentId, runnerId, projectId);
    const now = new Date().toISOString();
    await appEnv.DB.prepare(
      `INSERT INTO project_repositories (id, project_id, repository_key, indexing_enabled, ingest_status, created_at, updated_at)
       VALUES (?, ?, 'repo1', 0, 'none', ?, ?)`,
    ).bind('prp_epi_ing1', projectId, now, now).run();
    await appEnv.DB.prepare(
      `INSERT INTO repository_checkouts (id, project_repository_id, runner_id, checkout_id, created_at, updated_at)
       VALUES ('ckt_epi_ing1', 'prp_epi_ing1', ?, 'r', ?, ?)`,
    ).bind(runnerId, now, now).run();
    const run = await room(projectId).createRun(projectId, actor, {
      kind: 'build', repoRef: 'r', agentTool: 'claude', anchor: { type: 'task', id: taskId },
    });
    await room(projectId).dispatchRun(projectId, actor, run.id, runnerId);
    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'running', agentId });
    const modelUsage = {
      'test-model': { inputTokens: 21, outputTokens: 8, cacheReadInputTokens: 5, cacheCreationInputTokens: 3, costUSD: 4.25 },
    };
    await appEnv.DB.prepare('UPDATE runs SET usd_spent = 4.25, model_usage = ? WHERE id = ?')
      .bind(JSON.stringify(modelUsage), run.id).run();
    await appEnv.DB.prepare(
      `INSERT INTO steers (id, run_id, agent_id, mode, delivered_via, created_at)
       VALUES ('str_epi_ing1', ?, ?, 'hard', 'runtime', ?)`,
    ).bind(run.id, agentId, now).run();
    await appEnv.DB.prepare(
      `INSERT INTO run_log_segments (run_id, seq, role, round, text, created_at)
       VALUES (?, 1, 'reviewer', 3, 'review transcript must not enter the episode', ?)`,
    ).bind(run.id, now).run();
    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'done' });
    // Make the pre-upload skeleton deterministic even if the transition's background delivery
    // has not run yet. A later background replay uses skeleton mode and must preserve enrichment.
    await recordEpisodeForRun(appEnv, projectId, run.id);

    const scopeId = run.id;
    await memory(projectId).beginEpisodeIngest(projectId, { scopeId, projectId, batchCount: 1 });
    await memory(projectId).ingestEpisodeBatch(projectId, scopeId, 0, [
      {
        runId: run.id,
        filesTouched: ['src/slow.ts'],
        commands: ['npm test'],
        testsRun: ['memory-episodes.test.ts'],
        failures: ['first attempt timed out'],
        findings: [{ summary: 'the daemon observed a slow query in the diff' }],
        selfSummary: { approachSummary: 'profiled before changing the query' },
        // Legacy/full clients may still send these. Every value is forged and must be ignored.
        taskId: null,
        repositoryKey: 'forged-repository',
        baseId: 'forged-base',
        timeline: [],
        reviewRounds: 0,
        tokenUsage: {},
        costUSD: 0,
        acceptanceCoverage: 0.99,
        steeringEvents: [],
        landingOutcome: 'not-a-real-outcome',
        remainingWork: ['forged remaining work'],
        intelligence: {
          schemaVersion: 1,
          identity: { episodeId: 'forged-episode', projectId: 'forged-project', runId: 'forged-run', sitting: 99 },
          sources: { memoryRevision: 999, capturedAt: '2000-01-01T00:00:00.000Z' },
          versions: { extraction: 'forged-extractor' },
          preExecution: {
            task: { taskType: 'forged', tags: ['forged'], capturedAt: '2000-01-01T00:00:00.000Z' },
            requestedStrategy: { model: 'forged-model' },
            configuration: [
              { kind: 'runner', name: runnerId, version: 'server-runner-v1', fingerprint: 'forged-runner-fingerprint' },
              { kind: 'workflow', name: 'daemon-workflow', version: '1.0.0', fingerprint: 'workflow-sha256' },
            ],
          },
          execution: {
            executedStrategy: { model: 'forged-model' },
            observedModelUsage: daemonMetric({
              'daemon-model': {
                inputTokens: 34, outputTokens: 13, cacheReadInputTokens: 8,
                cacheCreationInputTokens: 5, costUSD: 2.75,
              },
            }),
            clocks: {
              queueDurationMs: daemonMetric(99_999),
              verifyDurationMs: daemonMetric(1_250),
            },
            stages: [{
              executionId: 'exe_daemon_verify', kind: 'stage', role: 'verifier', stage: 'tests',
              elapsedMs: daemonMetric(1_250), tokens: daemonMetric(55), costUSD: daemonMetric(0.75),
            }],
            changes: {
              backend: 'git',
              changedFiles: daemonMetric(3, 'backend_observed', 'vcs_backend'),
              additions: daemonMetric(21, 'backend_observed', 'vcs_backend'),
              deletions: daemonMetric(8, 'backend_observed', 'vcs_backend'),
              churn: daemonMetric(29, 'derived', 'vcs_backend'),
            },
          },
          outcome: { runOutcome: 'failed', landingOutcome: 'failed' },
        },
      },
    ]);
    const completed = await memory(projectId).completeEpisodeIngest(projectId, scopeId);
    expect(completed.recorded).toBe(1);
    expect(completed.skipped).toBe(0);

    const episode = await memory(projectId)._getEpisodeForTest(projectId, run.id);
    expect(episode).toMatchObject({
      runId: run.id,
      taskId,
      repositoryKey: 'repo1',
      baseId: 'server-base-sha',
      reviewRounds: 3,
      tokenUsage: modelUsage,
      costUSD: 4.25,
      acceptanceCoverage: null,
      steeringEvents: ['hard steer (runtime)'],
      landingOutcome: 'pending',
      remainingWork: [],
      filesTouched: ['src/slow.ts'],
      commands: ['npm test'],
      testsRun: ['memory-episodes.test.ts'],
      failures: ['first attempt timed out'],
      findings: [{ summary: 'the daemon observed a slow query in the diff' }],
      selfSummary: expect.objectContaining({ approachSummary: 'profiled before changing the query' }),
    });
    expect((episode!.timeline as Array<{ label: string }>).map((entry) => entry.label)).toEqual([
      'queued', 'dispatched to runner', 'agent started', 'run done',
    ]);
    expect(episode!.intelligence).toMatchObject({
      identity: { episodeId: episode!.id, projectId, runId: run.id, sitting: 1, taskId },
      sources: { capturedAt: expect.not.stringContaining('2000-01-01') },
      versions: { extraction: 'commissioning-v2' },
      preExecution: {
        task: { tags: ['episode-test'] },
        configuration: expect.arrayContaining([
          expect.objectContaining({ kind: 'runner', name: runnerId, version: 'server-runner-v1' }),
          { kind: 'workflow', name: 'daemon-workflow', version: '1.0.0', fingerprint: 'workflow-sha256' },
        ]),
      },
      execution: {
        observedModelUsage: expect.objectContaining({
          value: expect.objectContaining({ 'daemon-model': expect.objectContaining({ costUSD: 2.75 }) }),
          provenance: 'runner_observed', source: 'runner',
        }),
        clocks: {
          verifyDurationMs: expect.objectContaining({ value: 1_250, provenance: 'runner_observed' }),
        },
        stages: [expect.objectContaining({ stage: 'tests', elapsedMs: expect.objectContaining({ value: 1_250 }) })],
        changes: {
          backend: 'git',
          changedFiles: expect.objectContaining({ value: 3 }), additions: expect.objectContaining({ value: 21 }),
          deletions: expect.objectContaining({ value: 8 }), churn: expect.objectContaining({ value: 29 }),
        },
      },
      outcome: { runOutcome: 'done', landingOutcome: 'pending' },
    });
    const acceptedUsage = (episode!.intelligence as any).execution.observedModelUsage;
    expect(acceptedUsage.acceptedAt).not.toBe(FORGED_ACCEPTED_AT);
    expect(acceptedUsage.acceptedAt).toEqual(expect.any(String));
    const acceptedConfiguration = (episode!.intelligence as any).preExecution.configuration as Array<Record<string, unknown>>;
    expect(acceptedConfiguration.find((item) => item.kind === 'runner')?.fingerprint).not.toBe('forged-runner-fingerprint');
    // The upload's forged queue clock was stripped; this remains the server's D1-derived value.
    expect((episode!.intelligence as any).execution.clocks.queueDurationMs.value).not.toBe(99_999);
    // Nor may the daemon replace a server-derived executed strategy.
    expect((episode!.intelligence as any).execution.executedStrategy?.model).not.toBe('forged-model');

    // A later partial intelligence enrichment changes only the individual metric it names.
    // Explicit [] still clears the daemon-owned stages array, while [] cannot erase the
    // server-owned commissioning fingerprints.
    const partialScopeId = `${run.id}_partial`;
    await memory(projectId).beginEpisodeIngest(projectId, { scopeId: partialScopeId, projectId, batchCount: 1 });
    await memory(projectId).ingestEpisodeBatch(projectId, partialScopeId, 0, [
      {
        runId: run.id,
        findings: [{ summary: 'the follow-up review confirmed the query fix' }],
        intelligence: {
          preExecution: { configuration: [] },
          execution: {
            stages: [],
            changes: { additions: daemonMetric(34, 'backend_observed', 'vcs_backend') },
          },
        },
      },
    ]);
    expect(await memory(projectId).completeEpisodeIngest(projectId, partialScopeId)).toMatchObject({ recorded: 1, skipped: 0 });
    expect(await memory(projectId)._getEpisodeForTest(projectId, run.id)).toMatchObject({
      filesTouched: ['src/slow.ts'],
      commands: ['npm test'],
      testsRun: ['memory-episodes.test.ts'],
      findings: [{ summary: 'the follow-up review confirmed the query fix' }],
      intelligence: {
        preExecution: { configuration: expect.arrayContaining([
          expect.objectContaining({ kind: 'runner', name: runnerId }),
          expect.objectContaining({ kind: 'workflow', name: 'daemon-workflow' }),
        ]) },
        execution: {
          observedModelUsage: expect.objectContaining({ value: expect.objectContaining({ 'daemon-model': expect.anything() }) }),
          clocks: { verifyDurationMs: expect.objectContaining({ value: 1_250 }) },
          stages: [],
          changes: {
            changedFiles: expect.objectContaining({ value: 3 }), additions: expect.objectContaining({ value: 34 }),
            deletions: expect.objectContaining({ value: 8 }), churn: expect.objectContaining({ value: 29 }),
          },
        },
      },
    });

    // A terminal-job retry after enrichment must not clear the daemon-owned half either.
    await recordEpisodeForRun(appEnv, projectId, run.id);
    expect(await memory(projectId)._getEpisodeForTest(projectId, run.id)).toMatchObject({
      filesTouched: ['src/slow.ts'], commands: ['npm test'], findings: [{ summary: 'the follow-up review confirmed the query fix' }],
      intelligence: {
        identity: { episodeId: episode!.id, runId: run.id, sitting: 1 },
        execution: {
          observedModelUsage: expect.objectContaining({ value: expect.objectContaining({ 'daemon-model': expect.anything() }) }),
          clocks: { verifyDurationMs: expect.objectContaining({ value: 1_250 }) },
          changes: {
            changedFiles: expect.objectContaining({ value: 3 }), additions: expect.objectContaining({ value: 34 }),
          },
        },
      },
    });
  });

  it('skips malformed, unknown-run, and non-terminal rows without failing the rest of the batch', async () => {
    const projectId = await newProject('MEPIING2');
    const runnerId = 'rnr_epi_ing2';
    const agentId = 'agt_epi_ing2';
    await seedRunner(runnerId);
    await seedAgent(agentId, runnerId, projectId);
    const run = await room(projectId).createRun(projectId, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude' });
    await room(projectId).dispatchRun(projectId, actor, run.id, runnerId);
    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'running', agentId });
    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'done' });
    const nonterminal = await room(projectId).createRun(projectId, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude' });

    const scopeId = `${run.id}_batch2`;
    await memory(projectId).beginEpisodeIngest(projectId, { scopeId, projectId, batchCount: 1 });
    await memory(projectId).ingestEpisodeBatch(projectId, scopeId, 0, [
      { runId: run.id, findings: [{ summary: '' }] }, // malformed daemon-owned enrichment
      {
        runId: run.id,
        intelligence: {
          execution: {
            observedModelUsage: {
              ...daemonMetric({}), provenance: 'server_observed', source: 'd1_coordination',
            },
          },
        },
      }, // daemon may not forge server-observed provenance
      { runId: 'run_does_not_exist' }, // parses fine, but no such run in this project
      { runId: nonterminal.id, commands: ['must not record yet'] },
    ]);
    const completed = await memory(projectId).completeEpisodeIngest(projectId, scopeId);
    expect(completed.recorded).toBe(0);
    expect(completed.skipped).toBe(4);
  });

  it('a stage fact with provenance "unavailable" and source "driver" parses and is recorded (RUN-243 regression guard)', async () => {
    const projectId = await newProject('MEPIING3');
    const runnerId = 'rnr_epi_ing3';
    const agentId = 'agt_epi_ing3';
    await seedRunner(runnerId);
    await seedAgent(agentId, runnerId, projectId);
    const run = await room(projectId).createRun(projectId, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude' });
    await room(projectId).dispatchRun(projectId, actor, run.id, runnerId);
    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'running', agentId });
    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'done' });

    const scopeId = `${run.id}_run243`;
    await memory(projectId).beginEpisodeIngest(projectId, { scopeId, projectId, batchCount: 1 });
    await memory(projectId).ingestEpisodeBatch(projectId, scopeId, 0, [{
      runId: run.id,
      intelligence: {
        execution: {
          stages: [{
            executionId: 'exe_run243', kind: 'stage', role: 'reviewer', stage: 'review',
            elapsedMs: daemonMetric(4_000, 'driver_reported', 'driver'),
            tokens: daemonMetric(120, 'driver_reported', 'driver'),
            // Exactly the RUN-243 shape: a Codex reviewer reports tokens/elapsed but never sets
            // cost, so the cost metric is genuinely unavailable — this must still be accepted.
            costUSD: unavailableDaemonMetric('driver'),
          }],
        },
      },
    }]);
    const completed = await memory(projectId).completeEpisodeIngest(projectId, scopeId);
    expect(completed).toMatchObject({ recorded: 1, skipped: 0 });

    const episode = await memory(projectId)._getEpisodeForTest(projectId, run.id);
    const stage = (episode!.intelligence as any).execution.stages[0];
    expect(stage.costUSD).toMatchObject({ status: 'unavailable', value: null, provenance: 'unavailable', source: 'driver' });
    expect(stage.elapsedMs).toMatchObject({ status: 'complete', value: 4_000, provenance: 'driver_reported' });
  });

  it('a single bad metric discards the whole row, including its otherwise-valid deterministic fields — the pinned PLNR-426 blast radius', async () => {
    const projectId = await newProject('MEPIING4');
    const runnerId = 'rnr_epi_ing4';
    const agentId = 'agt_epi_ing4';
    await seedRunner(runnerId);
    await seedAgent(agentId, runnerId, projectId);
    const run = await room(projectId).createRun(projectId, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude' });
    await room(projectId).dispatchRun(projectId, actor, run.id, runnerId);
    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'running', agentId });
    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'done' });

    const scopeId = `${run.id}_blast`;
    await memory(projectId).beginEpisodeIngest(projectId, { scopeId, projectId, batchCount: 1 });
    await memory(projectId).ingestEpisodeBatch(projectId, scopeId, 0, [{
      runId: run.id,
      // Otherwise entirely valid daemon-owned deterministic fields...
      filesTouched: ['src/would-have-recorded.ts'],
      commands: ['npm test'],
      findings: [{ summary: 'this finding is discarded along with the rest of the row' }],
      intelligence: {
        // ...sunk by ONE metric asserting provenance a daemon may not claim. See the decision
        // comment in ProjectMemory.ts#completeEpisodeIngest: this is a deliberate PLNR-426
        // choice, not an oversight — the whole row is discarded rather than salvaging the
        // deterministic half.
        execution: {
          observedModelUsage: {
            ...daemonMetric({ 'test-model': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.1 } }),
            provenance: 'server_observed',
            source: 'd1_coordination',
          },
        },
      },
    }]);
    const completed = await memory(projectId).completeEpisodeIngest(projectId, scopeId);
    expect(completed).toMatchObject({ recorded: 0, skipped: 1 });

    const episode = await memory(projectId)._getEpisodeForTest(projectId, run.id);
    expect(episode?.filesTouched ?? []).not.toContain('src/would-have-recorded.ts');
    expect(episode?.commands ?? []).not.toContain('npm test');
  });
});

// PLNR-433: what a run actually READ (`contextConsumption`), as distinct from what it was told to
// do or what it did. Two layers, same reasoning as this file's own opening comment: the first
// group is pure schema tests against `packages/shared/src/intelligence.ts` directly — no DO, no D1
// — because the facts under test (backward compatibility, the no-text rule, and the
// three-states-none-a-zero rule) are properties of the CONTRACT itself, provable without any
// wiring; the second group drives the real `completeEpisodeIngest` → `mergeUploadedEpisodeIntelligence`
// / `preserveAcceptedEpisodeIntelligence` path, matching the style of the daemon-provenance cases
// directly above.
describe('PLNR-433: context-consumption facts', () => {
  const FIXTURE_ISO = '2026-08-10T12:00:00.000Z';

  /** A complete, minimal `ProjectIntelligenceEpisode` with no `contextConsumption` key at all —
   *  standing in for a body stored before this task, since that field did not exist for it to have
   *  omitted on purpose. */
  function fullIntelligenceFixture(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1,
      identity: {
        episodeId: 'epi_ctx_fixture', projectId: 'prj_ctx_fixture', runId: 'run_ctx_fixture', sitting: 1,
        lineage: { status: 'unknown', missing: [], reason: null },
      },
      sources: { capturedAt: FIXTURE_ISO },
      versions: { extraction: 'test-v1' },
      preExecution: { task: { capturedAt: FIXTURE_ISO } },
      execution: {
        observedModelUsage: daemonMetric({}),
        clocks: {
          queueDurationMs: daemonMetric(0), dispatchToStartMs: daemonMetric(0),
          elapsedExecutionMs: daemonMetric(0), humanBlockedMs: daemonMetric(0), verifyDurationMs: daemonMetric(0),
        },
        changes: {
          changedFiles: daemonMetric(0), additions: daemonMetric(0), deletions: daemonMetric(0), churn: daemonMetric(0),
        },
      },
      outcome: {
        runOutcome: 'done', landingOutcome: 'pending',
        reviewRounds: daemonMetric(0), acceptanceCoverage: daemonMetric(0),
      },
      ...overrides,
    };
  }

  /** A fully populated `ContextConsumptionSnapshot` — counts, enums, and booleans only. */
  function fullContextConsumptionSnapshot(mode: 'semantic' | 'keyword' = 'semantic') {
    return {
      mode, role: 'build', charBudget: 8000, charsUsed: 4200,
      sections: [{ id: 'active_decisions', excerptCount: 3, graphEntityCount: 0, truncated: false, unanswerable: false }],
      similarEpisodesConsidered: 2, staleCitationsCount: 0, noticesCount: 0, retrievalTookMs: 120,
    };
  }

  it('an episode payload captured before this change still parses — proven by parsing a pre-change fixture, not by inspection', () => {
    const parsed = ProjectIntelligenceEpisode.parse(fullIntelligenceFixture());
    expect(parsed.contextConsumption).toBeUndefined();
  });

  it('the daemon-assertable subset is expressible in UploadedEpisodeIntelligence and refined by daemonMetric, so a Runner can safeParse before uploading', () => {
    const legal = { contextConsumption: daemonMetric(fullContextConsumptionSnapshot('semantic')) };
    expect(UploadedEpisodeIntelligence.safeParse(legal).success).toBe(true);

    // The RUN-243/PLNR-426 hazard, mirrored onto this new field: a provenance/source combination a
    // daemon may not claim must fail HERE, at parse time — not silently, three calls later,
    // server-side.
    const forged = {
      contextConsumption: { ...daemonMetric(fullContextConsumptionSnapshot('semantic')), provenance: 'server_observed', source: 'd1_coordination' },
    };
    expect(UploadedEpisodeIntelligence.safeParse(forged).success).toBe(false);
  });

  it('no field in the new section can carry memory statement text, a source excerpt, or transcript content — demonstrated by schema rejection, not asserted', () => {
    const suspiciousText = 'The user prefers dark mode because bright screens trigger their migraines — recorded from run_9182 transcript.';

    const textInMode = daemonMetric({ ...fullContextConsumptionSnapshot(), mode: suspiciousText });
    expect(UploadedEpisodeIntelligence.safeParse({ contextConsumption: textInMode }).success).toBe(false);

    const textInSectionId = daemonMetric({
      ...fullContextConsumptionSnapshot(),
      sections: [{ id: suspiciousText, excerptCount: 1, graphEntityCount: 0, truncated: false, unanswerable: false }],
    });
    expect(UploadedEpisodeIntelligence.safeParse({ contextConsumption: textInSectionId }).success).toBe(false);

    // An unrecognized field name carrying text is stripped, not stored: zod drops unknown keys
    // rather than accepting them, so there is no back door via an extra property either.
    const smuggledExtraField = {
      contextConsumption: daemonMetric(fullContextConsumptionSnapshot()),
      memoryStatement: suspiciousText,
    };
    const parsedSmuggled = UploadedEpisodeIntelligence.safeParse(smuggledExtraField);
    expect(parsedSmuggled.success).toBe(true);
    expect(parsedSmuggled.success && 'memoryStatement' in parsedSmuggled.data).toBe(false);
  });

  it('never requested / requested but never rendered / rendered in degraded mode are three distinguishable states, none spelled as a zero', () => {
    const obs = { provenance: 'runner_observed' as const, source: 'runner' as const, sourceId: 's', observedAt: null, acceptedAt: null, reason: null };
    const neverRequested = { status: 'not_applicable' as const, value: null, ...obs };
    const requestedNeverRendered = { status: 'unavailable' as const, value: null, ...obs };
    const renderedDegraded = { status: 'partial' as const, value: fullContextConsumptionSnapshot('keyword'), ...obs };

    for (const candidate of [neverRequested, requestedNeverRendered, renderedDegraded]) {
      expect(IntelligenceContextConsumptionMetric.safeParse(candidate).success).toBe(true);
    }
    // The two null-value states are distinguished ONLY by `status` — nothing numeric tells them apart.
    expect(neverRequested.value).toBeNull();
    expect(requestedNeverRendered.value).toBeNull();
    expect(neverRequested.status).not.toBe(requestedNeverRendered.status);
    expect(renderedDegraded.value).not.toBeNull();
  });

  it('reporting context facts leaves execution.stages/clocks/changes untouched, and a terminal-job replay preserves the accepted fact', async () => {
    const projectId = await newProject('MEPICTX1');
    const runnerId = 'rnr_epi_ctx1';
    const agentId = 'agt_epi_ctx1';
    await seedRunner(runnerId);
    await seedAgent(agentId, runnerId, projectId);
    const run = await room(projectId).createRun(projectId, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude' });
    await room(projectId).dispatchRun(projectId, actor, run.id, runnerId);
    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'running', agentId });
    await room(projectId).transitionRun(projectId, actor, run.id, { status: 'done' });

    const scopeId = `${run.id}_ctx1`;
    await memory(projectId).beginEpisodeIngest(projectId, { scopeId, projectId, batchCount: 1 });
    await memory(projectId).ingestEpisodeBatch(projectId, scopeId, 0, [{
      runId: run.id,
      intelligence: {
        execution: {
          stages: [{
            executionId: 'exe_ctx1', kind: 'stage', role: 'verifier', stage: 'tests',
            elapsedMs: daemonMetric(500), tokens: daemonMetric(10), costUSD: daemonMetric(0.01),
          }],
        },
        contextConsumption: daemonMetric(fullContextConsumptionSnapshot('semantic')),
      },
    }]);
    const completed = await memory(projectId).completeEpisodeIngest(projectId, scopeId);
    expect(completed).toMatchObject({ recorded: 1, skipped: 0 });

    const episode = await memory(projectId)._getEpisodeForTest(projectId, run.id);
    const intelligence = episode!.intelligence as any;
    expect(intelligence.contextConsumption).toMatchObject({
      status: 'complete',
      value: expect.objectContaining({ mode: 'semantic', role: 'build', charsUsed: 4200 }),
    });
    // The sibling execution facts this upload never mentioned (changes) or set through a
    // DIFFERENT field (stages) are untouched by reporting a context fact in the same upload.
    expect(intelligence.execution.stages).toEqual([
      expect.objectContaining({ stage: 'tests', elapsedMs: expect.objectContaining({ value: 500 }) }),
    ]);
    expect(intelligence.execution.clocks.verifyDurationMs.status).toBe('not_applicable'); // untouched server skeleton default (not a verify run)
    expect(intelligence.execution.changes.changedFiles.status).toBe('unavailable'); // untouched server skeleton default

    // A terminal-job replay rebuilds the skeleton fresh from D1 (which knows nothing about the
    // Runner's ContextPack) and must still carry the previously accepted context fact forward.
    await recordEpisodeForRun(appEnv, projectId, run.id);
    const replayed = (await memory(projectId)._getEpisodeForTest(projectId, run.id))!.intelligence as any;
    expect(replayed.contextConsumption).toMatchObject({
      status: 'complete',
      value: expect.objectContaining({ mode: 'semantic', charsUsed: 4200 }),
    });
    expect(replayed.execution.stages).toEqual([expect.objectContaining({ stage: 'tests' })]);
  });
});
