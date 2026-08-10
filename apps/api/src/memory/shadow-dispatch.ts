// PLNR-300: immutable, per-sitting shadow evidence captured after dispatch commits. Nothing in
// this module selects a strategy or returns a recommendation; capture failure degrades to an
// explicit missing feature and is never thrown back through the dispatch response.
import { RunnerCapabilities, type RunBudget } from '@noriq-dev/shared';
import type { Env } from '../env';
import {
  INTELLIGENCE_EXTRACTION_VERSION, loadRunSittingEvidence, type RunCommissioningSnapshot,
} from '../lib/run-sitting-intelligence';
import { newId, nowIso, sha256Hex } from '../lib/util';
import { ANALYTICS_EXTRACTION_VERSION } from './analytics';
import { assessPreDispatchRisk, PRE_DISPATCH_RISK_VERSION } from './scope-risk';
import { SIMILAR_EFFORT_RETRIEVAL_VERSION } from './similar-effort';

export const SHADOW_DISPATCH_VERSION = 'shadow-dispatch-v1';
const MAX_OPTIONS = 50;
const MAX_CASES = 20;

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

type Feature<T> = {
  status: 'complete' | 'partial' | 'unavailable';
  value: T | null;
  source: string;
  version: string | null;
  reasons: string[];
};

export interface ShadowDispatchSnapshot {
  schemaVersion: 1;
  version: typeof SHADOW_DISPATCH_VERSION;
  identity: {
    projectId: string; runId: string; sitting: number; taskId: string | null;
    planId: string | null; phaseId: string | null; phaseOrder: number | null;
    planDispatchId: string | null; orchestrationId: string | null; executionId: string | null;
    repositoryKey: string | null; branch: string | null; baseId: string | null;
    previousSitting: number | null;
  };
  source: {
    capturedAt: string;
    commissioningFingerprint: string;
    versions: {
      shadow: typeof SHADOW_DISPATCH_VERSION;
      commissioning: string;
      risk: typeof PRE_DISPATCH_RISK_VERSION;
      retrieval: typeof SIMILAR_EFFORT_RETRIEVAL_VERSION;
      analytics: typeof ANALYTICS_EXTRACTION_VERSION;
    };
    memoryRevision: Feature<number>;
    graphRevision: Feature<number>;
  };
  features: {
    taskShape: {
      taskType: string | null; tags: string[]; executionSpecFingerprint: string | null;
      executionSpecUnreadable: boolean;
      budget: RunBudget;
    };
    structuralRisk: Feature<{
      coverage: string; scopeStatus: string; anticipatedFileCount: number;
      priorFileCounts: { observedCount: number; partialCount: number; unavailableCount: number; min: number | null; median: number | null; max: number | null };
      budgetCompleteness: Record<string, string>;
    }>;
    relevantCases: Feature<Array<{
      episodeId: string; runId: string; sitting: number; supportKinds: string[];
      retrievalVersion: string; score: number; branchApplicability: string; baseApplicability: string;
    }>>;
    retrievalCoverage: Feature<{ candidatesConsidered: number; eligibleCases: number }>;
    availableStrategies: Feature<{
      workflows: string[];
      agents: Array<{ tool: string; models: string[]; efforts: string[] }>;
    }>;
    chosenStrategy: {
      selectedBy: { kind: 'human' | 'agent' | 'system' | 'unknown'; id: string };
      requested: RunCommissioningSnapshot['requested'];
      commissioned: RunCommissioningSnapshot['commissioned'];
    };
    gateMode: Feature<string>;
    runnerCapabilityClass: Feature<{
      runnerId: string; runnerVersion: string | null; fingerprint: string;
      tools: string[]; kinds: string[]; maxConcurrency: number;
    }>;
  };
  constraints: { recommendationStored: false; predictedWinnerStored: false; modelScoreStored: false };
}

export interface StoredShadowDispatchSnapshot {
  runId: string; sitting: number; projectId: string; commissioningFingerprint: string;
  snapshot: ShadowDispatchSnapshot; snapshotHash: string;
  captureStatus: 'complete' | 'partial' | 'failed'; captureError: string | null; capturedAt: string;
}

type ShadowBaseRow = {
  commissioningFingerprint: string; capturedAt: string; runnerId: string | null;
  runnerVersion: string | null; runnerCapabilities: string | null; runnerRepos: string | null;
  createdBy: string; orchestrationId: string | null; executionId: string | null; baseId: string | null;
};

async function loadStored(db: D1Database, runId: string, sitting: number): Promise<StoredShadowDispatchSnapshot | null> {
  const row = await db.prepare(
    `SELECT run_id AS runId, sitting, project_id AS projectId,
            commissioning_fingerprint AS commissioningFingerprint, snapshot,
            snapshot_hash AS snapshotHash, capture_status AS captureStatus,
            capture_error AS captureError, captured_at AS capturedAt
       FROM run_sitting_shadow_snapshots WHERE run_id = ? AND sitting = ?`,
  ).bind(runId, sitting).first<Omit<StoredShadowDispatchSnapshot, 'snapshot'> & { snapshot: string }>();
  return row ? { ...row, snapshot: JSON.parse(row.snapshot) as ShadowDispatchSnapshot } : null;
}

function actorKind(createdBy: string, userIds: Set<string>, agentIds: Set<string>): 'human' | 'agent' | 'system' | 'unknown' {
  if (createdBy === 'system') return 'system';
  if (userIds.has(createdBy)) return 'human';
  if (agentIds.has(createdBy)) return 'agent';
  return 'unknown';
}

/** Capture is insert-once. Infrastructure failures become unavailable features; a hard capture
 * failure gets a small immutable failed row whenever commissioning identity is still readable. */
export async function captureShadowDispatchSnapshot(
  env: Env,
  projectId: string,
  runId: string,
  sitting: number,
  capturedAt = nowIso(),
): Promise<StoredShadowDispatchSnapshot | null> {
  const existing = await loadStored(env.DB, runId, sitting);
  if (existing) return existing;
  const evidence = await loadRunSittingEvidence(env.DB, runId, sitting);
  const base = await env.DB.prepare(
    `SELECT rsi.commissioning_fingerprint AS commissioningFingerprint,
            rsi.captured_at AS capturedAt, r.runner_id AS runnerId, rn.version AS runnerVersion,
            rn.capabilities AS runnerCapabilities, rn.repos AS runnerRepos, r.created_by AS createdBy,
            en.orchestration_id AS orchestrationId, en.id AS executionId,
            (SELECT tr.ref FROM task_refs tr
              WHERE tr.task_id = CASE WHEN r.anchor_type = 'task' THEN r.anchor_id ELSE NULL END
                AND tr.kind = 'commit' ORDER BY tr.created_at DESC LIMIT 1) AS baseId
       FROM run_sitting_intelligence rsi JOIN runs r ON r.id = rsi.run_id
       LEFT JOIN runners rn ON rn.id = r.runner_id
       LEFT JOIN execution_nodes en ON en.project_id = r.project_id AND en.run_id = r.id
         AND en.sitting = rsi.sitting AND en.kind = 'sitting'
      WHERE rsi.project_id = ? AND rsi.run_id = ? AND rsi.sitting = ? LIMIT 1`,
  ).bind(projectId, runId, sitting).first<ShadowBaseRow>();
  if (!evidence || !base) return null;
  const commissioning = evidence.commissioning;

  const [riskSettled, healthSettled, users, agents] = await Promise.all([
    commissioning.taskId
      ? assessPreDispatchRisk(env, projectId, commissioning.taskId, {
          repositoryKey: commissioning.repositoryKey, branch: commissioning.branch,
          baseId: base.baseId, budget: commissioning.budget, observedAt: capturedAt,
        }).then((value) => ({ ok: true as const, value })).catch((error) => ({ ok: false as const, error: String(error) }))
      : Promise.resolve({ ok: false as const, error: 'run is not anchored to a task' }),
    env.PROJECT_MEMORY.get(env.PROJECT_MEMORY.idFromName(projectId)).health(projectId)
      .then((value) => ({ ok: true as const, value })).catch((error) => ({ ok: false as const, error: String(error) })),
    env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(base.createdBy).all<{ id: string }>(),
    env.DB.prepare('SELECT id FROM agents WHERE id = ?').bind(base.createdBy).all<{ id: string }>(),
  ]);

  let workflows = ['scope', 'build', 'verify'];
  let availableReason: string[] = [];
  try {
    const repos = JSON.parse(base.runnerRepos ?? '[]') as Array<{ id?: string; workflows?: Array<string | { name: string }> }>;
    const repo = repos.find((item) => item.id === commissioning.repoRef);
    for (const item of repo?.workflows ?? []) workflows.push(typeof item === 'string' ? item : item.name);
  } catch { availableReason.push('runner repository advertisement is unreadable'); }
  workflows = [...new Set(workflows)].sort().slice(0, MAX_OPTIONS);
  const parsedCapabilities = RunnerCapabilities.safeParse((() => {
    try { return JSON.parse(base.runnerCapabilities ?? '{}'); } catch { return {}; }
  })());
  const capabilities = parsedCapabilities.success ? parsedCapabilities.data : RunnerCapabilities.parse({});
  if (!parsedCapabilities.success) availableReason.push('runner capabilities are unreadable');
  const agentsMenu = capabilities.agents.slice(0, MAX_OPTIONS).map((item) => ({
    tool: item.tool, models: item.models.slice(0, MAX_OPTIONS), efforts: item.efforts.slice(0, MAX_OPTIONS),
  }));
  const capabilityFingerprint = await sha256Hex(canonicalJson({
    version: base.runnerVersion, tools: capabilities.tools, kinds: capabilities.kinds,
    maxConcurrency: capabilities.maxConcurrency, agents: agentsMenu,
  }));

  const unavailableRevision = (reason: string): Feature<number> => ({
    status: 'unavailable', value: null, source: 'project_memory_health', version: null, reasons: [reason],
  });
  const memoryRevision: Feature<number> = healthSettled.ok
    ? { status: 'complete', value: healthSettled.value.memoryRevision, source: 'project_memory_health', version: null, reasons: [] }
    : unavailableRevision(healthSettled.error);
  const riskReasons = riskSettled.ok ? riskSettled.value.coverage.reasons : [riskSettled.error];
  const risk = riskSettled.ok ? riskSettled.value : null;
  const riskFeature: ShadowDispatchSnapshot['features']['structuralRisk'] = risk ? {
    status: risk.coverage.status === 'complete' ? 'complete' : 'partial',
    value: {
      coverage: risk.coverage.status, scopeStatus: risk.scope.status,
      anticipatedFileCount: risk.scope.anticipatedFiles.length,
      priorFileCounts: risk.scope.priorFileCounts,
      budgetCompleteness: Object.fromEntries(Object.entries(risk.budget).map(([key, item]) => [key, item.completeness])),
    },
    source: 'pre_dispatch_risk', version: risk.versions.risk, reasons: riskReasons,
  } : { status: 'unavailable', value: null, source: 'pre_dispatch_risk', version: PRE_DISPATCH_RISK_VERSION, reasons: riskReasons };
  const cases = risk?.priorEvidence.cases.slice(0, MAX_CASES).map((item) => ({
    episodeId: item.episodeId, runId: item.runId, sitting: item.sitting,
    supportKinds: [...new Set(item.retrieval.support.map((support) => support.kind))].sort(),
    retrievalVersion: item.retrieval.version, score: item.retrieval.score,
    branchApplicability: item.applicability.branch, baseApplicability: item.applicability.baseId,
  })) ?? [];
  const retrievalCoverage = risk?.priorEvidence.coverage;
  const snapshot: ShadowDispatchSnapshot = {
    schemaVersion: 1,
    version: SHADOW_DISPATCH_VERSION,
    identity: {
      projectId, runId, sitting, taskId: commissioning.taskId,
      planId: commissioning.planId, phaseId: commissioning.phaseId, phaseOrder: commissioning.phaseOrder,
      planDispatchId: commissioning.planDispatchId, orchestrationId: base.orchestrationId,
      executionId: base.executionId, repositoryKey: commissioning.repositoryKey,
      branch: commissioning.branch, baseId: base.baseId, previousSitting: sitting > 1 ? sitting - 1 : null,
    },
    source: {
      capturedAt: base.capturedAt ?? capturedAt,
      commissioningFingerprint: base.commissioningFingerprint,
      versions: {
        shadow: SHADOW_DISPATCH_VERSION, commissioning: INTELLIGENCE_EXTRACTION_VERSION,
        risk: PRE_DISPATCH_RISK_VERSION, retrieval: SIMILAR_EFFORT_RETRIEVAL_VERSION,
        analytics: ANALYTICS_EXTRACTION_VERSION,
      },
      memoryRevision,
      graphRevision: healthSettled.ok
        ? { status: 'complete', value: healthSettled.value.memoryRevision, source: 'project_memory_graph', version: null, reasons: [] }
        : unavailableRevision(healthSettled.error),
    },
    features: {
      taskShape: {
        taskType: commissioning.taskType, tags: commissioning.tags,
        executionSpecFingerprint: commissioning.executionSpecFingerprint,
        executionSpecUnreadable: commissioning.executionSpecUnreadable,
        budget: commissioning.budget,
      },
      structuralRisk: riskFeature,
      relevantCases: {
        status: risk ? (retrievalCoverage?.complete ? 'complete' : 'partial') : 'unavailable',
        value: risk ? cases : null, source: 'similar_effort_cases', version: SIMILAR_EFFORT_RETRIEVAL_VERSION,
        reasons: risk ? (retrievalCoverage?.reasons ?? []) : riskReasons,
      },
      retrievalCoverage: {
        status: retrievalCoverage ? (retrievalCoverage.complete ? 'complete' : 'partial') : 'unavailable',
        value: retrievalCoverage ? {
          candidatesConsidered: retrievalCoverage.candidatesConsidered,
          eligibleCases: retrievalCoverage.eligibleCases,
        } : null,
        source: 'similar_effort_cases', version: SIMILAR_EFFORT_RETRIEVAL_VERSION,
        reasons: retrievalCoverage?.reasons ?? riskReasons,
      },
      availableStrategies: {
        status: availableReason.length ? 'partial' : 'complete',
        value: { workflows, agents: agentsMenu }, source: 'runner_advertisement',
        version: base.runnerVersion, reasons: availableReason,
      },
      chosenStrategy: {
        selectedBy: {
          kind: actorKind(base.createdBy, new Set(users.results.map((row) => row.id)), new Set(agents.results.map((row) => row.id))),
          id: base.createdBy,
        },
        requested: commissioning.requested, commissioned: commissioning.commissioned,
      },
      gateMode: commissioning.gateMode
        ? { status: 'complete', value: commissioning.gateMode, source: 'plan_dispatch', version: null, reasons: [] }
        : { status: 'unavailable', value: null, source: 'plan_dispatch', version: null, reasons: ['run has no plan dispatch gate'] },
      runnerCapabilityClass: base.runnerId ? {
        status: parsedCapabilities.success ? 'complete' : 'partial',
        value: {
          runnerId: base.runnerId, runnerVersion: base.runnerVersion, fingerprint: capabilityFingerprint,
          tools: capabilities.tools, kinds: capabilities.kinds, maxConcurrency: capabilities.maxConcurrency,
        },
        source: 'runner_advertisement', version: base.runnerVersion, reasons: availableReason,
      } : { status: 'unavailable', value: null, source: 'runner_advertisement', version: null, reasons: ['run has no assigned runner'] },
    },
    constraints: { recommendationStored: false, predictedWinnerStored: false, modelScoreStored: false },
  };
  const encoded = canonicalJson(snapshot);
  const status: StoredShadowDispatchSnapshot['captureStatus'] = [
    snapshot.source.memoryRevision.status, snapshot.features.structuralRisk.status,
    snapshot.features.retrievalCoverage.status, snapshot.features.availableStrategies.status,
    snapshot.features.runnerCapabilityClass.status,
  ].every((item) => item === 'complete') ? 'complete' : 'partial';
  await env.DB.prepare(
    `INSERT OR IGNORE INTO run_sitting_shadow_snapshots
       (run_id, sitting, project_id, commissioning_fingerprint, snapshot, snapshot_hash,
        capture_status, capture_error, captured_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(
    runId, sitting, projectId, base.commissioningFingerprint, encoded, await sha256Hex(encoded),
    status, null, base.capturedAt ?? capturedAt,
  ).run();
  return loadStored(env.DB, runId, sitting);
}

/** Outcome enrichment is append-only and idempotent. It never updates the snapshot row/hash. */
export async function attachShadowOutcomeRef(
  db: D1Database,
  projectId: string,
  runId: string,
  sitting: number,
  refType: 'episode' | 'quality_event',
  refId: string,
  observedAt = nowIso(),
): Promise<{ attached: boolean }> {
  const commissioned = await db.prepare(
    'SELECT 1 AS ok FROM run_sitting_intelligence WHERE project_id = ? AND run_id = ? AND sitting = ?',
  ).bind(projectId, runId, sitting).first<{ ok: number }>();
  if (!commissioned) return { attached: false };
  const { meta } = await db.prepare(
    `INSERT OR IGNORE INTO run_sitting_shadow_outcome_refs
       (id, project_id, run_id, sitting, ref_type, ref_id, observed_at, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).bind(newId('sor'), projectId, runId, sitting, refType, refId, observedAt, nowIso()).run();
  return { attached: (meta.changes ?? 0) > 0 };
}

/** Last-resort observability for a capture that failed before it could build feature fields. The
 * row is still immutable and keyed to the commissioning fingerprint; retries remain idempotent. */
export async function recordShadowCaptureFailure(
  db: D1Database,
  projectId: string,
  runId: string,
  sitting: number,
  error: string,
  capturedAt = nowIso(),
): Promise<void> {
  const row = await db.prepare(
    `SELECT commissioning_fingerprint AS fingerprint, captured_at AS capturedAt
       FROM run_sitting_intelligence WHERE project_id = ? AND run_id = ? AND sitting = ?`,
  ).bind(projectId, runId, sitting).first<{ fingerprint: string; capturedAt: string }>();
  if (!row) return;
  const failure = canonicalJson({
    schemaVersion: 1, version: SHADOW_DISPATCH_VERSION,
    identity: { projectId, runId, sitting },
    source: { capturedAt: row.capturedAt ?? capturedAt, commissioningFingerprint: row.fingerprint },
    failure: { status: 'failed', reason: error.slice(0, 2_000) },
    constraints: { recommendationStored: false, predictedWinnerStored: false, modelScoreStored: false },
  });
  await db.prepare(
    `INSERT OR IGNORE INTO run_sitting_shadow_snapshots
       (run_id, sitting, project_id, commissioning_fingerprint, snapshot, snapshot_hash,
        capture_status, capture_error, captured_at) VALUES (?,?,?,?,?,?,'failed',?,?)`,
  ).bind(
    runId, sitting, projectId, row.fingerprint, failure, await sha256Hex(failure),
    error.slice(0, 2_000), row.capturedAt ?? capturedAt,
  ).run();
}
