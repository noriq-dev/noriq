// PLNR-296: deterministic, read-only collision and bottleneck evidence. Current classifications
// come from coordination facts; historical episodes are a separately labelled support channel.
import type { Env } from '../env';
import { analyticsSourceWatermarks } from './analytics';
import {
  projectTaskClaimability, taskClaimability, type Claimability, type ClaimabilityReason,
} from '../lib/claimability';
import { readExecutionSpec } from '../lib/execution-spec';
import {
  branchScopesOverlap, normalizePattern, patternsOverlap, type NormalizedPattern,
} from '../lib/lockmatch';
import { RUNNER_HEARTBEAT_TTL_MS } from '../lib/runner-roster';
import type { ProjectMemoryStub } from '../lib/project-memory';
import { buildEntityUri } from '@noriq-dev/shared';
import type { PriorEffortCase } from './similar-effort';

export const BOTTLENECK_ASSESSMENT_VERSION = 'collision-bottleneck-v1';
export const BOTTLENECK_TASK_LIMIT = 100;
export const BOTTLENECK_RUNNER_LIMIT = 200;
export const BOTTLENECK_GRAPH_TASK_LIMIT = 12;
export const BOTTLENECK_COLLISION_LIMIT = 200;

export type BottleneckKind =
  | 'ready' | 'dependency' | 'approval' | 'landing' | 'lock'
  | 'human' | 'execution' | 'runner_capacity' | 'unknown';

export type IntelligenceExecutorMode = 'runner' | 'copilot' | 'human';

export interface BottleneckAssessmentInput {
  taskId?: string | null;
  repositoryKey?: string | null;
  branch?: string | null;
  baseId?: string | null;
  observedAt?: string;
  taskLimit?: number;
  /** Only Runner execution is gated on Runner inventory. */
  executorMode?: IntelligenceExecutorMode;
}

type TaskRow = {
  id: string;
  key: string;
  title: string;
  body: string | null;
  status: string;
  claimedBy: string | null;
  executionSpec: string | null;
  updatedAt: string;
};

type LiveRun = {
  id: string;
  taskId: string | null;
  runnerId: string | null;
  agentId: string | null;
  sitting: number;
  status: string;
  phase: string | null;
  targetBranch: string | null;
  planDispatchId: string | null;
  orchestrationId: string | null;
  executionId: string | null;
  updatedAt: string;
};

type LiveLock = {
  id: string;
  taskId: string | null;
  taskKey: string | null;
  agentId: string;
  agentName: string | null;
  kind: string;
  canonPattern: string;
  branch: string | null;
  allBranches: number;
  acquiredAt: string;
  expiresAt: string;
};

type RunnerRow = {
  id: string;
  label: string;
  status: string;
  capabilities: string;
  repos: string;
  reportedFreeSlots: number;
  lastHeartbeatAt: string | null;
  offboardedAt: string | null;
  retiredAt: string | null;
  archivedAt: string | null;
};

type PreparedTask = TaskRow & {
  claimability: Claimability;
  anticipatedFiles: string[];
  executionSpecUnreadable: boolean;
  branch: string | null;
  liveRuns: LiveRun[];
};

export interface CurrentLockCollision {
  taskId: string;
  taskKey: string;
  requestedPath: string;
  lockId: string;
  lockedPath: string;
  lockTaskId: string | null;
  lockTaskKey: string | null;
  holderAgentId: string;
  holderName: string | null;
  lockBranch: string | null;
  allBranches: boolean;
  branchOverlap: boolean | null;
  expiresAt: string;
}

export interface BottleneckAssessmentResult {
  advisory: true;
  version: typeof BOTTLENECK_ASSESSMENT_VERSION;
  observedAt: string;
  targetContext: {
    taskId: string | null;
    repositoryKey: string | null;
    branch: string | null;
    baseId: string | null;
    executorMode: IntelligenceExecutorMode;
  };
  sources: {
    current: { kind: 'point_in_time'; coordinationEventSequence: number | null; orchestrationWatermark: string; runnerHeartbeatCutoff: string };
    graph: { kind: 'derived_graph'; memoryRevision: number | null };
    historical: { kind: 'historical_episode_cases'; retrievalVersion: string | null };
  };
  coverage: { status: 'unanswerable' | 'partial' | 'complete'; reasons: string[] };
  capacity: {
    status: 'unanswerable' | 'partial' | 'observed';
    availableSlots: number | null;
    activeCapableRunners: number;
    liveRunsCounted: number;
    inventoryLimit: number;
    inventoryTruncated: boolean;
    note: string;
    runners: Array<{
      id: string; label: string; lifecycle: 'active' | 'stale' | 'draining' | 'retired';
      heartbeatAt: string | null; heartbeatFresh: boolean; presenceState: string | null;
      advertisesProject: boolean; advertisesRepository: boolean | null; buildCapable: boolean | null;
      maxConcurrency: number | null; reportedFreeSlots: number; busyRuns: number;
      derivedFreeSlots: number | null; completeness: 'complete' | 'partial' | 'unavailable';
    }>;
  };
  readiness: {
    taskLimit: number;
    truncated: boolean;
    counts: Record<BottleneckKind, number>;
    tasks: Array<{
      taskId: string; taskKey: string; title: string; status: string;
      primary: BottleneckKind; reason: string; claimability: Claimability;
      anticipatedFiles: string[]; branch: string | null;
      currentRunIds: string[]; currentExecutionIds: string[];
      blockingInputRequestIds: string[]; lockCollisionIds: string[];
    }>;
  };
  collisions: {
    focusTaskId: string | null;
    locking: { status: 'unanswerable' | 'observed'; enabled: boolean; current: CurrentLockCollision[] };
    anticipatedPaths: { status: 'unanswerable' | 'partial' | 'observed'; overlaps: Array<{
      taskId: string; taskKey: string; focusPath: string; otherPath: string;
      branchOverlap: boolean | null; currentClaimOrExecution: boolean;
    }> };
    graphImpact: { status: 'unanswerable' | 'partial' | 'observed'; coverageReasons: string[]; candidateLimit: number; truncated: boolean; overlaps: Array<{
      taskId: string; taskKey: string; sharedEntities: Array<{ uri: string; type: string; label: string }>;
    }> };
  };
  execution: {
    liveRuns: LiveRun[];
    liveWorkerCount: number;
    nodeCounts: Array<{ status: string; kind: string; role: string; count: number }>;
    note: string;
  };
  humanBlocks: Array<{
    signalId: string; taskId: string; taskKey: string; title: string; createdAt: string;
    runIds: string[]; kind: 'blocking_input_request';
  }>;
  planGates: {
    dispatches: Array<{ id: string; planId: string; status: string; gate: string; stallReason: string | null; updatedAt: string }>;
    phaseGates: Array<{ phaseId: string; planId: string; status: string; attempts: number; updatedAt: string }>;
    owedLandings: Array<{ planId: string; completedAt: string; failedDetail: string | null }>;
  };
  historicalSupport: {
    status: 'unanswerable' | 'observed';
    consideredCount: number;
    cases: Array<PriorEffortCase & {
      collisionMentions: string[];
      contextMatch: { repository: boolean | null; branch: boolean | null; baseId: boolean | null };
    }>;
  };
}

const placeholders = (values: readonly unknown[]) => values.map(() => '?').join(',');

function parsePattern(path: string): NormalizedPattern | null {
  try { return normalizePattern(path); } catch { return null; }
}

function taskBranch(taskId: string, focusTaskId: string | null, requested: string | null, runs: LiveRun[]) {
  if (focusTaskId === taskId && requested) return requested;
  return runs.find((run) => run.taskId === taskId && run.targetBranch)?.targetBranch ?? null;
}

function lockBranchOverlap(taskBranchValue: string | null, lock: LiveLock): boolean | null {
  if (lock.allBranches) return true;
  if (!taskBranchValue || !lock.branch) return null;
  return branchScopesOverlap(
    { branch: taskBranchValue, allBranches: false },
    { branch: lock.branch, allBranches: false },
  );
}

function collisionMentions(item: PriorEffortCase): string[] {
  const text = [item.whatWasAttempted, ...item.whatFailed, ...item.whatRemainsUncertain].join(' ').toLowerCase();
  return ['conflict', 'collision', 'merge', 'rebase', 'lock']
    .filter((term) => new RegExp(`\\b${term}(?:s|ed|ing)?\\b`).test(text));
}

function primaryClassification(input: {
  task: PreparedTask;
  humanSignalIds: string[];
  lockCollisionIds: string[];
  capacityKnown: boolean;
  availableSlots: number;
  executorMode: IntelligenceExecutorMode;
}): { primary: BottleneckKind; reason: string } {
  const { task, humanSignalIds, lockCollisionIds, capacityKnown, availableSlots, executorMode } = input;
  if (humanSignalIds.length) return { primary: 'human', reason: 'an open blocking input request parks this task' };
  if (task.liveRuns.length) {
    if (task.liveRuns.some((run) => run.phase === 'landing')) return { primary: 'landing', reason: 'a live run is in its landing phase' };
    return { primary: 'execution', reason: 'a canonical live run already owns or queues this work' };
  }
  const reasonCode: ClaimabilityReason = task.claimability.reasonCode;
  if (reasonCode === 'spin_off_approval' || reasonCode === 'plan_approval') {
    return { primary: 'approval', reason: task.claimability.reason ?? 'human approval is required' };
  }
  if (reasonCode === 'dependency') {
    const landing = task.claimability.gate === 'landed'
      && task.claimability.blockers.some((blocker) => blocker.status === 'review' && !blocker.landedRun);
    return landing
      ? { primary: 'landing', reason: 'the landed gate is waiting for a review blocker to produce a done run' }
      : { primary: 'dependency', reason: task.claimability.reason ?? 'unfinished dependencies block this task' };
  }
  if (!task.claimability.claimable) {
    if (task.status === 'review') return { primary: 'approval', reason: 'the task is in review; review alone is not a human-blocked interval' };
    if (task.status === 'in_progress') return { primary: 'execution', reason: 'the task is in progress without a currently reported run' };
    return { primary: 'unknown', reason: task.claimability.reason ?? `task status ${task.status} is not claimable` };
  }
  if (lockCollisionIds.length) return { primary: 'lock', reason: 'a live overlapping lock blocks an anticipated path on this branch' };
  if (executorMode !== 'runner') {
    return {
      primary: 'ready',
      reason: executorMode === 'copilot'
        ? 'shared claimability passes for the active Copilot executor; Runner capacity is not applicable'
        : 'shared claimability passes for the human executor; Runner capacity is not applicable',
    };
  }
  if (!capacityKnown) return { primary: 'unknown', reason: 'Runner capacity is unavailable; zero capacity was not inferred' };
  if (availableSlots === 0) return { primary: 'runner_capacity', reason: 'the task is claimable and live capable Runners have no derived free slot' };
  return { primary: 'ready', reason: 'shared claimability passes and a live capable Runner slot is available' };
}

function capacityFacts(
  projectId: string,
  repositoryKey: string | null,
  observedAt: string,
  rows: RunnerRow[],
  presence: Map<string, string>,
  busy: Map<string, number>,
  inventoryTruncated: boolean,
) {
  const cutoff = new Date(Date.parse(observedAt) - RUNNER_HEARTBEAT_TTL_MS).toISOString();
  const runners = rows.map((row) => {
    let maxConcurrency: number | null = null;
    let buildCapable: boolean | null = null;
    let repoRows: Array<{ projectId?: string | null; repositoryKey?: string | null }> = [];
    let completeness: 'complete' | 'partial' | 'unavailable' = 'complete';
    try {
      const capabilities = JSON.parse(row.capabilities || '{}') as { maxConcurrency?: unknown; kinds?: unknown };
      if (typeof capabilities.maxConcurrency === 'number' && Number.isInteger(capabilities.maxConcurrency) && capabilities.maxConcurrency >= 0) {
        maxConcurrency = capabilities.maxConcurrency;
      }
      buildCapable = Array.isArray(capabilities.kinds) ? capabilities.kinds.includes('build') : null;
      if (maxConcurrency == null || buildCapable == null) completeness = 'partial';
    } catch { completeness = 'unavailable'; }
    try { repoRows = JSON.parse(row.repos || '[]') as typeof repoRows; } catch { completeness = 'unavailable'; }
    const advertisesProject = repoRows.some((repo) => repo.projectId === projectId);
    const advertisesRepository = repositoryKey
      ? repoRows.some((repo) => repo.projectId === projectId && repo.repositoryKey === repositoryKey)
      : null;
    const heartbeatFresh = !!row.lastHeartbeatAt && row.lastHeartbeatAt >= cutoff;
    const retired = !!row.offboardedAt || !!row.retiredAt || !!row.archivedAt;
    const lifecycle = retired ? 'retired' as const
      : !heartbeatFresh ? 'stale' as const
        : row.status === 'draining' ? 'draining' as const : 'active' as const;
    const busyRuns = busy.get(row.id) ?? 0;
    const acceptsWork = lifecycle === 'active' && row.status === 'online' && advertisesProject
      && (advertisesRepository !== false) && buildCapable === true && maxConcurrency != null;
    return {
      id: row.id, label: row.label, lifecycle,
      heartbeatAt: row.lastHeartbeatAt, heartbeatFresh, presenceState: presence.get(row.id) ?? null,
      advertisesProject, advertisesRepository, buildCapable, maxConcurrency,
      reportedFreeSlots: Number(row.reportedFreeSlots), busyRuns,
      derivedFreeSlots: acceptsWork ? Math.max(0, maxConcurrency! - busyRuns) : null,
      completeness,
    };
  });
  const capable = runners.filter((runner) => runner.derivedFreeSlots != null);
  const unknownRelevant = runners.some((runner) => runner.advertisesProject && runner.completeness !== 'complete');
  return {
    cutoff,
    result: {
      status: capable.length
        ? (unknownRelevant || inventoryTruncated ? 'partial' as const : 'observed' as const)
        : 'unanswerable' as const,
      availableSlots: capable.length ? capable.reduce((sum, runner) => sum + runner.derivedFreeSlots!, 0) : null,
      activeCapableRunners: capable.length,
      liveRunsCounted: capable.reduce((sum, runner) => sum + runner.busyRuns, 0),
      inventoryLimit: BOTTLENECK_RUNNER_LIMIT,
      inventoryTruncated,
      note: inventoryTruncated
        ? 'capacity is a lower bound over a truncated Runner inventory; each dispatched/running run is counted once and execution-tree stages never add workers'
        : 'capacity counts each dispatched/running run once; sittings and execution-tree stages never add workers',
      runners,
    },
  };
}

async function graphImpactOverlaps(
  stub: ProjectMemoryStub,
  projectId: string,
  projectKey: string,
  repositoryKey: string | null,
  focus: PreparedTask | null,
  candidates: PreparedTask[],
) {
  if (!focus) return { status: 'unanswerable' as const, coverageReasons: ['focus_task_not_supplied'], candidateLimit: BOTTLENECK_GRAPH_TASK_LIMIT, truncated: false, overlaps: [] };
  if (!repositoryKey) return { status: 'unanswerable' as const, coverageReasons: ['canonical_repository_not_supplied'], candidateLimit: BOTTLENECK_GRAPH_TASK_LIMIT, truncated: false, overlaps: [] };
  if (!focus.anticipatedFiles.length) return { status: 'unanswerable' as const, coverageReasons: ['anticipated_files_absent'], candidateLimit: BOTTLENECK_GRAPH_TASK_LIMIT, truncated: false, overlaps: [] };
  const eligible = candidates.filter((task) => task.id !== focus.id && task.anticipatedFiles.length);
  const selected = [focus, ...eligible.slice(0, BOTTLENECK_GRAPH_TASK_LIMIT)];
  const impacts = await Promise.all(selected.map(async (task) => {
    const uris = task.anticipatedFiles.flatMap((path) => {
      try { return [buildEntityUri({ kind: 'file', projectKey, repositoryKey, path })]; } catch { return []; }
    });
    return { task, impact: await stub.changeImpact(projectId, { entityUris: uris, maxDepth: 2, maxResults: 100 }) };
  }));
  const focusImpact = impacts[0]!.impact;
  const reasons = new Set<string>();
  for (const { task, impact } of impacts) {
    for (const reason of impact.coverage.reasons) reasons.add(`${task.key}:${reason}`);
    if (impact.uncertainEdges.length) reasons.add(`${task.key}:unresolved-seeds`);
  }
  const focusTests = new Map(focusImpact.impactedTests.map((item) => [item.uri, item]));
  const overlaps = impacts.slice(1).flatMap(({ task, impact }) => {
    const shared = impact.impactedTests.filter((item) => focusTests.has(item.uri))
      .map((item) => ({ uri: item.uri, type: item.type, label: item.label }));
    return shared.length ? [{ taskId: task.id, taskKey: task.key, sharedEntities: shared }] : [];
  });
  return {
    status: reasons.size ? 'partial' as const : 'observed' as const,
    coverageReasons: [...reasons],
    candidateLimit: BOTTLENECK_GRAPH_TASK_LIMIT,
    truncated: eligible.length > BOTTLENECK_GRAPH_TASK_LIMIT,
    overlaps,
  };
}

export async function assessProjectBottlenecks(
  env: Env,
  projectId: string,
  input: BottleneckAssessmentInput = {},
): Promise<BottleneckAssessmentResult> {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const executorMode = input.executorMode ?? 'runner';
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error('observedAt must be an ISO date-time');
  const focusTaskId = input.taskId ?? null;
  const taskLimit = Math.min(BOTTLENECK_TASK_LIMIT, Math.max(1, Math.trunc(input.taskLimit ?? BOTTLENECK_TASK_LIMIT)));
  const claimability = await projectTaskClaimability(env.DB, projectId, taskLimit);
  const boundedTaskIds = claimability.items.map((item) => item.id);
  let claimabilityItems = claimability.items;
  let focusTaskRow: TaskRow | null = null;
  if (focusTaskId && !claimabilityItems.some((item) => item.id === focusTaskId)) {
    const focus = await env.DB.prepare(
      `SELECT id, key, title, body, status, claimed_by AS claimedBy,
              execution_spec AS executionSpec, updated_at AS updatedAt, proposed_at AS proposedAt
         FROM tasks WHERE id = ? AND project_id = ?`,
    ).bind(focusTaskId, projectId).first<{
      id: string; key: string; title: string; body: string | null; status: string;
      claimedBy: string | null; executionSpec: string | null; updatedAt: string; proposedAt: string | null;
    }>();
    if (!focus) throw new Error(`task ${focusTaskId} not found in project ${projectId}`);
    // The project-wide inventory intentionally stays bounded to open tasks. An explicitly
    // requested focus is a separate, authoritative point lookup: combine it in memory so task
    // drawers can inspect completed/review work without widening the project scan or pushing a
    // full 100-task IN query beyond D1's bind-variable ceiling.
    focusTaskRow = focus;
    claimabilityItems = [
      ...claimabilityItems,
      { ...focus, claimability: await taskClaimability(env.DB, focus.id) },
    ];
  }
  const taskIds = claimabilityItems.map((item) => item.id);
  const ids = boundedTaskIds.length ? placeholders(boundedTaskIds) : "''";
  const [project, taskRows, runs, signals, locks, runnerRows, runnerPresence, busyRuns, nodeCounts,
    dispatches, phaseGates, landings, watermarks] = await Promise.all([
    env.DB.prepare('SELECT key, file_locking_enabled AS fileLockingEnabled FROM projects WHERE id = ?')
      .bind(projectId).first<{ key: string; fileLockingEnabled: number }>(),
    boundedTaskIds.length ? env.DB.prepare(
      `SELECT id, key, title, body, status, claimed_by AS claimedBy, execution_spec AS executionSpec, updated_at AS updatedAt
         FROM tasks WHERE id IN (${ids})`,
    ).bind(...boundedTaskIds).all<TaskRow>() : Promise.resolve({ results: [] as TaskRow[] }),
    env.DB.prepare(
      `SELECT r.id, CASE WHEN r.anchor_type = 'task' THEN r.anchor_id END AS taskId,
              r.runner_id AS runnerId, r.agent_id AS agentId, r.sitting, r.status, r.phase,
              r.target_branch AS targetBranch, r.plan_dispatch_id AS planDispatchId,
              n.orchestration_id AS orchestrationId, n.id AS executionId, r.updated_at AS updatedAt
         FROM runs r LEFT JOIN execution_nodes n ON n.run_id = r.id AND n.kind = 'sitting' AND n.sitting = r.sitting
        WHERE r.project_id = ? AND r.status IN ('queued','dispatched','running','blocked')
        ORDER BY r.created_at, r.id`,
    ).bind(projectId).all<LiveRun>(),
    env.DB.prepare(
      `SELECT s.id AS signalId, s.task_id AS taskId, t.key AS taskKey, s.title, s.created_at AS createdAt
         FROM signals s JOIN tasks t ON t.id = s.task_id
        WHERE s.project_id = ? AND s.type = 'input_request' AND s.blocking = 1 AND s.status = 'open'
        ORDER BY s.created_at, s.id`,
    ).bind(projectId).all<{ signalId: string; taskId: string; taskKey: string; title: string; createdAt: string }>(),
    env.DB.prepare(
      `SELECT fl.id, fl.task_id AS taskId, t.key AS taskKey, fl.agent_id AS agentId,
              COALESCE(a.label, a.name) AS agentName, fl.kind, fl.canon_pattern AS canonPattern,
              fl.branch, fl.all_branches AS allBranches, fl.acquired_at AS acquiredAt, fl.expires_at AS expiresAt
         FROM file_locks fl LEFT JOIN tasks t ON t.id = fl.task_id LEFT JOIN agents a ON a.id = fl.agent_id
        WHERE fl.project_id = ? AND fl.released_at IS NULL AND fl.expires_at > ?
        ORDER BY fl.acquired_at, fl.id`,
    ).bind(projectId, observedAt).all<LiveLock>(),
    env.DB.prepare(
      `SELECT r.id, r.label, r.status, r.capabilities, r.repos, r.free_slots AS reportedFreeSlots,
              r.last_heartbeat_at AS lastHeartbeatAt, r.offboarded_at AS offboardedAt,
              r.retired_at AS retiredAt, r.archived_at AS archivedAt
         FROM runners r WHERE r.project_id = ?1
            OR EXISTS (SELECT 1 FROM json_each(COALESCE(r.repos, '[]')) repo
                        WHERE json_extract(repo.value, '$.projectId') = ?1)
            OR EXISTS (SELECT 1 FROM runs run WHERE run.runner_id = r.id AND run.project_id = ?1)
        ORDER BY r.last_heartbeat_at DESC, r.id
        LIMIT ?2`,
    ).bind(projectId, BOTTLENECK_RUNNER_LIMIT + 1).all<RunnerRow>(),
    env.DB.prepare(
      `SELECT runner_id AS runnerId, state, last_seen_at AS lastSeenAt FROM agent_presences
        WHERE kind = 'runner_daemon' AND archived_at IS NULL AND runner_id IS NOT NULL
          AND (project_id = ?1 OR EXISTS (
            SELECT 1 FROM runs run WHERE run.runner_id = agent_presences.runner_id AND run.project_id = ?1
          ))
        ORDER BY last_seen_at DESC
        LIMIT ?2`,
    ).bind(projectId, BOTTLENECK_RUNNER_LIMIT + 1).all<{ runnerId: string; state: string; lastSeenAt: string | null }>(),
    env.DB.prepare(
      `SELECT runner_id AS runnerId, COUNT(DISTINCT id) AS count FROM runs
        WHERE runner_id IS NOT NULL AND status IN ('dispatched','running')
          AND EXISTS (
            SELECT 1 FROM runners runner WHERE runner.id = runs.runner_id
              AND (runner.project_id = ?1
                OR EXISTS (SELECT 1 FROM json_each(COALESCE(runner.repos, '[]')) repo
                            WHERE json_extract(repo.value, '$.projectId') = ?1)
                OR runs.project_id = ?1)
          )
        GROUP BY runner_id`,
    ).bind(projectId).all<{ runnerId: string; count: number }>(),
    env.DB.prepare(
      `SELECT status, kind, role, COUNT(*) AS count FROM execution_nodes
        WHERE project_id = ? AND status IN ('pending','running','parked') GROUP BY status, kind, role
        ORDER BY status, kind, role`,
    ).bind(projectId).all<{ status: string; kind: string; role: string; count: number }>(),
    env.DB.prepare(
      `SELECT id, plan_id AS planId, status, gate, stall_reason AS stallReason, updated_at AS updatedAt
         FROM plan_dispatches WHERE project_id = ? AND status IN ('active','stalled') ORDER BY created_at, id`,
    ).bind(projectId).all<{ id: string; planId: string; status: string; gate: string; stallReason: string | null; updatedAt: string }>(),
    env.DB.prepare(
      `SELECT pg.phase_id AS phaseId, ph.plan_id AS planId, pg.status, pg.attempts, pg.updated_at AS updatedAt
         FROM phase_gates pg JOIN phases ph ON ph.id = pg.phase_id JOIN plans p ON p.id = ph.plan_id
        WHERE p.project_id = ? AND pg.status != 'passed' ORDER BY ph.plan_id, ph."order"`,
    ).bind(projectId).all<{ phaseId: string; planId: string; status: string; attempts: number; updatedAt: string }>(),
    env.DB.prepare(
      `SELECT plan_id AS planId, completed_at AS completedAt, failed_detail AS failedDetail
         FROM plan_landings WHERE project_id = ? AND (merge_requested_at IS NULL OR failed_detail IS NOT NULL)
        ORDER BY completed_at, plan_id`,
    ).bind(projectId).all<{ planId: string; completedAt: string; failedDetail: string | null }>(),
    analyticsSourceWatermarks(env, projectId),
  ]);
  if (!project) throw new Error(`project ${projectId} not found`);

  const claimById = new Map(claimabilityItems.map((item) => [item.id, item.claimability]));
  const runsByTask = new Map<string, LiveRun[]>();
  for (const run of runs.results) if (run.taskId) runsByTask.set(run.taskId, [...(runsByTask.get(run.taskId) ?? []), run]);
  const selectedTaskRows = focusTaskRow ? [...taskRows.results, focusTaskRow] : taskRows.results;
  const prepared: PreparedTask[] = selectedTaskRows.map((row) => {
    const read = readExecutionSpec(row.executionSpec, row.id);
    return {
      ...row,
      claimability: claimById.get(row.id)!,
      anticipatedFiles: read.spec?.anticipatedFiles.map((file) => file.path) ?? [],
      executionSpecUnreadable: !!read.unreadable,
      branch: taskBranch(row.id, focusTaskId, input.branch ?? null, runs.results),
      liveRuns: runsByTask.get(row.id) ?? [],
    };
  }).sort((a, b) => taskIds.indexOf(a.id) - taskIds.indexOf(b.id));
  const focus = focusTaskId ? prepared.find((task) => task.id === focusTaskId) ?? null : null;

  const runnerInventoryTruncated = runnerRows.results.length > BOTTLENECK_RUNNER_LIMIT;
  const boundedRunnerRows = runnerRows.results.slice(0, BOTTLENECK_RUNNER_LIMIT);
  const presence = new Map<string, string>();
  for (const row of runnerPresence.results) if (!presence.has(row.runnerId)) presence.set(row.runnerId, row.state);
  const busy = new Map(busyRuns.results.map((row) => [row.runnerId, Number(row.count)]));
  const capacity = capacityFacts(
    projectId, input.repositoryKey ?? null, observedAt, boundedRunnerRows, presence, busy, runnerInventoryTruncated,
  );
  const capacityKnown = capacity.result.availableSlots != null;

  const lockCollisions: CurrentLockCollision[] = [];
  if (project.fileLockingEnabled) {
    for (const task of prepared) {
      for (const path of task.anticipatedFiles) {
        const wanted = parsePattern(path);
        if (!wanted) continue;
        for (const lock of locks.results) {
          if (task.claimedBy && task.claimedBy === lock.agentId) continue;
          const stored = parsePattern(lock.kind === 'dir' ? `${lock.canonPattern}/` : lock.canonPattern);
          if (!stored || !patternsOverlap(wanted, stored)) continue;
          if (lockCollisions.length >= BOTTLENECK_COLLISION_LIMIT) break;
          lockCollisions.push({
            taskId: task.id, taskKey: task.key, requestedPath: path,
            lockId: lock.id, lockedPath: lock.canonPattern, lockTaskId: lock.taskId,
            lockTaskKey: lock.taskKey, holderAgentId: lock.agentId, holderName: lock.agentName,
            lockBranch: lock.branch, allBranches: !!lock.allBranches,
            branchOverlap: lockBranchOverlap(task.branch, lock), expiresAt: lock.expiresAt,
          });
        }
      }
    }
  }

  const pathOverlaps: BottleneckAssessmentResult['collisions']['anticipatedPaths']['overlaps'] = [];
  if (focus) {
    for (const task of prepared) {
      if (task.id === focus.id) continue;
      for (const focusPath of focus.anticipatedFiles) for (const otherPath of task.anticipatedFiles) {
        const a = parsePattern(focusPath);
        const b = parsePattern(otherPath);
        if (!a || !b || !patternsOverlap(a, b)) continue;
        const branchOverlap = focus.branch && task.branch
          ? branchScopesOverlap(
            { branch: focus.branch, allBranches: false },
            { branch: task.branch, allBranches: false },
          )
          : null;
        pathOverlaps.push({
          taskId: task.id, taskKey: task.key, focusPath, otherPath, branchOverlap,
          currentClaimOrExecution: !!task.claimedBy || task.liveRuns.length > 0,
        });
        if (pathOverlaps.length >= BOTTLENECK_COLLISION_LIMIT) break;
      }
      if (pathOverlaps.length >= BOTTLENECK_COLLISION_LIMIT) break;
    }
  }

  const stub = env.PROJECT_MEMORY.get(env.PROJECT_MEMORY.idFromName(projectId)) as unknown as ProjectMemoryStub;
  const [graphHealth, graphImpact, prior] = await Promise.all([
    stub.health(projectId).catch(() => null),
    graphImpactOverlaps(stub, projectId, project.key, input.repositoryKey ?? null, focus, prepared).catch((error) => ({
      status: 'unanswerable' as const, coverageReasons: [`graph_query_failed:${String(error)}`],
      candidateLimit: BOTTLENECK_GRAPH_TASK_LIMIT, truncated: false, overlaps: [],
    })),
    focus ? stub.similarEffort(projectId, {
      taskId: focus.id, title: focus.title, body: focus.body, anticipatedFiles: focus.anticipatedFiles,
      repositoryKey: input.repositoryKey ?? undefined,
      preferBranch: input.branch ?? undefined,
      limit: 10,
    }).catch(() => null) : Promise.resolve(null),
  ]);

  const humanByTask = new Map<string, string[]>();
  for (const signal of signals.results) humanByTask.set(signal.taskId, [...(humanByTask.get(signal.taskId) ?? []), signal.signalId]);
  const lockByTask = new Map<string, string[]>();
  for (const collision of lockCollisions) {
    if (collision.branchOverlap !== true) continue;
    lockByTask.set(collision.taskId, [...(lockByTask.get(collision.taskId) ?? []), collision.lockId]);
  }
  const classified = prepared.map((task) => {
    const blockingInputRequestIds = humanByTask.get(task.id) ?? [];
    const lockCollisionIds = [...new Set(lockByTask.get(task.id) ?? [])];
    const primary = primaryClassification({
      task, humanSignalIds: blockingInputRequestIds, lockCollisionIds,
      capacityKnown, availableSlots: capacity.result.availableSlots ?? 0,
      executorMode,
    });
    return {
      taskId: task.id, taskKey: task.key, title: task.title, status: task.status,
      ...primary, claimability: task.claimability, anticipatedFiles: task.anticipatedFiles,
      branch: task.branch, currentRunIds: task.liveRuns.map((run) => run.id),
      currentExecutionIds: task.liveRuns.flatMap((run) => run.executionId ? [run.executionId] : []),
      blockingInputRequestIds, lockCollisionIds,
    };
  });
  const counts = Object.fromEntries(
    ['ready', 'dependency', 'approval', 'landing', 'lock', 'human', 'execution', 'runner_capacity', 'unknown']
      .map((kind) => [kind, classified.filter((task) => task.primary === kind).length]),
  ) as Record<BottleneckKind, number>;

  const coverageReasons: string[] = [];
  if (claimability.truncated) coverageReasons.push('open_task_limit_reached');
  if (runnerInventoryTruncated) coverageReasons.push('runner_inventory_limit_reached');
  if (!project.fileLockingEnabled) coverageReasons.push('locking_disabled');
  if (prepared.some((task) => !task.anticipatedFiles.length)) coverageReasons.push('anticipated_files_absent');
  if (prepared.some((task) => task.executionSpecUnreadable)) coverageReasons.push('execution_spec_unreadable');
  if (executorMode === 'runner' && capacity.result.status === 'unanswerable') coverageReasons.push('runner_capacity_unknown');
  if (graphImpact.status !== 'observed') coverageReasons.push(...graphImpact.coverageReasons.map((reason) => `graph:${reason}`));
  if (!focus) coverageReasons.push('focus_task_not_supplied');
  const unanswerable = prepared.length === 0 || (focus !== null && !focus.anticipatedFiles.length);

  return {
    advisory: true,
    version: BOTTLENECK_ASSESSMENT_VERSION,
    observedAt,
    targetContext: {
      taskId: focusTaskId,
      repositoryKey: input.repositoryKey ?? null,
      branch: input.branch ?? null,
      baseId: input.baseId ?? null,
      executorMode,
    },
    sources: {
      current: {
        kind: 'point_in_time', coordinationEventSequence: watermarks.eventWatermark,
        orchestrationWatermark: watermarks.orchestrationWatermark, runnerHeartbeatCutoff: capacity.cutoff,
      },
      graph: { kind: 'derived_graph', memoryRevision: graphHealth?.memoryRevision ?? null },
      historical: { kind: 'historical_episode_cases', retrievalVersion: prior?.cases[0]?.retrieval.version ?? null },
    },
    coverage: {
      status: unanswerable ? 'unanswerable' : coverageReasons.length ? 'partial' : 'complete',
      reasons: [...new Set(coverageReasons)],
    },
    capacity: capacity.result,
    readiness: { taskLimit, truncated: claimability.truncated, counts, tasks: classified },
    collisions: {
      focusTaskId,
      locking: {
        status: project.fileLockingEnabled ? 'observed' : 'unanswerable',
        enabled: !!project.fileLockingEnabled,
        current: project.fileLockingEnabled ? lockCollisions : [],
      },
      anticipatedPaths: {
        status: !focus || !focus.anticipatedFiles.length ? 'unanswerable'
          : pathOverlaps.some((item) => item.branchOverlap == null) ? 'partial' : 'observed',
        overlaps: pathOverlaps,
      },
      graphImpact,
    },
    execution: {
      liveRuns: runs.results,
      liveWorkerCount: runs.results.filter((run) => run.status === 'dispatched' || run.status === 'running').length,
      nodeCounts: nodeCounts.results.map((row) => ({ ...row, count: Number(row.count) })),
      note: 'execution nodes describe lineage and stages; concurrent workers are counted from distinct live run rows only',
    },
    humanBlocks: signals.results.map((signal) => ({
      ...signal, runIds: runsByTask.get(signal.taskId)?.map((run) => run.id) ?? [], kind: 'blocking_input_request' as const,
    })),
    planGates: {
      dispatches: dispatches.results,
      phaseGates: phaseGates.results,
      owedLandings: landings.results,
    },
    historicalSupport: prior ? {
      status: 'observed', consideredCount: prior.consideredCount,
      cases: prior.cases.map((item) => ({
        ...item,
        collisionMentions: collisionMentions(item),
        contextMatch: {
          repository: input.repositoryKey ? item.repositoryKey === input.repositoryKey : null,
          branch: input.branch ? item.branch === input.branch : null,
          baseId: input.baseId ? item.baseId === input.baseId : null,
        },
      })),
    } : { status: 'unanswerable', consideredCount: 0, cases: [] },
  };
}
