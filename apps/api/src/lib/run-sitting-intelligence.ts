import type { ExecutedConfigurationEvidence, ExecutionSpec, ProjectIntelligenceEpisode } from '@noriq-dev/shared';
import { readExecutionSpec } from './execution-spec';
import { nowIso, sha256Hex } from './util';

export const INTELLIGENCE_EXTRACTION_VERSION = 'commissioning-v1';

export interface RunCommissioningSnapshot {
  runId: string;
  sitting: number;
  projectId: string;
  taskId: string | null;
  taskTitle: string | null;
  taskType: string | null;
  tags: string[];
  planId: string | null;
  phaseId: string | null;
  phaseOrder: number | null;
  planDispatchId: string | null;
  gateMode: string | null;
  repositoryKey: string | null;
  repoRef: string;
  branch: string | null;
  baseId: string | null;
  requested: {
    tool: string | null;
    agent: string | null;
    model: string | null;
    effort: string | null;
    workflow: string | null;
  };
  commissioned: {
    tool: string | null;
    agent: string | null;
    model: string | null;
    effort: string | null;
    workflow: string | null;
  };
  executionSpec: ExecutionSpec | null;
  executionSpecUnreadable: boolean;
  executionSpecFingerprint: string | null;
  configuration: Array<{ kind: 'runner' | 'workflow' | 'reviewer' | 'verifier' | 'manifest' | 'context'; name: string | null; version: string | null; fingerprint: string }>;
  capturedAt: string;
}

type SnapshotRow = {
  commissioning: string;
  executedSpecs: string | null;
  executedConfig: string | null;
  runnerObservedAt: string | null;
};

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

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/** Capture once at the server's committed dispatch boundary. Replays never mutate history. */
export async function captureRunCommissioningSnapshot(
  db: D1Database,
  projectId: string,
  runId: string,
  capturedAt = nowIso(),
): Promise<RunCommissioningSnapshot> {
  const run = await db.prepare(
    `SELECT r.id, r.project_id AS projectId, r.sitting, r.anchor_type AS anchorType,
            r.anchor_id AS anchorId, r.plan_id AS planId, r.plan_dispatch_id AS planDispatchId,
            r.repo_ref AS repoRef, r.runner_id AS runnerId, r.target_branch AS targetBranch,
            r.agent_tool AS agentTool, r.agent, r.model, r.effort, r.workflow,
            t.title AS taskTitle, t.type AS taskType, t.execution_spec AS executionSpec,
            ph.id AS phaseId, ph."order" AS phaseOrder, pd.gate AS gateMode,
            pr.repository_key AS repositoryKey, rn.version AS runnerVersion
       FROM runs r
       LEFT JOIN runners rn ON rn.id = r.runner_id
       LEFT JOIN tasks t ON r.anchor_type = 'task' AND t.id = r.anchor_id AND t.project_id = r.project_id
       LEFT JOIN phase_tasks pt ON pt.task_id = t.id
       LEFT JOIN phases ph ON ph.id = pt.phase_id AND (r.plan_id IS NULL OR ph.plan_id = r.plan_id)
       LEFT JOIN plan_dispatches pd ON pd.id = r.plan_dispatch_id
       LEFT JOIN repository_checkouts rc ON rc.runner_id = r.runner_id AND rc.checkout_id = r.repo_ref
       LEFT JOIN project_repositories pr ON pr.id = rc.project_repository_id AND pr.project_id = r.project_id
      WHERE r.id = ? AND r.project_id = ?
      ORDER BY ph."order" ASC LIMIT 1`,
  ).bind(runId, projectId).first<Record<string, unknown>>();
  if (!run) throw new Error(`cannot snapshot missing run ${runId}`);

  const taskId = run.anchorType === 'task' ? String(run.anchorId) : null;
  const tags = taskId
    ? (await db.prepare(
        `SELECT g.name FROM task_tags tt JOIN tags g ON g.id = tt.tag_id
          WHERE tt.task_id = ? ORDER BY g.name ASC`,
      ).bind(taskId).all<{ name: string }>()).results.map((row) => row.name)
    : [];
  const storedSpec = readExecutionSpec(run.executionSpec, taskId ?? runId);
  const executionSpecFingerprint = storedSpec.spec ? await sha256Hex(canonicalJson(storedSpec.spec)) : null;
  const requested = {
    tool: String(run.agentTool),
    agent: run.agent == null ? null : String(run.agent),
    model: run.model == null ? null : String(run.model),
    effort: run.effort == null ? null : String(run.effort),
    workflow: run.workflow == null ? null : String(run.workflow),
  };
  const configuration: RunCommissioningSnapshot['configuration'] = [];
  if (run.runnerId != null && run.runnerVersion != null) {
    const version = String(run.runnerVersion);
    configuration.push({
      kind: 'runner', name: String(run.runnerId), version,
      fingerprint: await sha256Hex(canonicalJson({ runnerId: run.runnerId, version })),
    });
  }
  const snapshot: RunCommissioningSnapshot = {
    runId,
    sitting: Number(run.sitting),
    projectId,
    taskId,
    taskTitle: run.taskTitle == null ? null : String(run.taskTitle),
    taskType: run.taskType == null ? null : String(run.taskType),
    tags,
    planId: run.planId == null ? null : String(run.planId),
    phaseId: run.phaseId == null ? null : String(run.phaseId),
    phaseOrder: run.phaseOrder == null ? null : Number(run.phaseOrder),
    planDispatchId: run.planDispatchId == null ? null : String(run.planDispatchId),
    gateMode: run.gateMode == null ? null : String(run.gateMode),
    repositoryKey: run.repositoryKey == null ? null : String(run.repositoryKey),
    repoRef: String(run.repoRef),
    branch: run.targetBranch == null ? null : String(run.targetBranch),
    baseId: null,
    requested,
    commissioned: { ...requested },
    executionSpec: storedSpec.spec,
    executionSpecUnreadable: storedSpec.unreadable === true,
    executionSpecFingerprint,
    configuration,
    capturedAt,
  };
  const commissioning = canonicalJson(snapshot);
  await db.prepare(
    `INSERT OR IGNORE INTO run_sitting_intelligence
       (run_id, sitting, project_id, commissioning, commissioning_fingerprint, captured_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(runId, snapshot.sitting, projectId, commissioning, await sha256Hex(commissioning), capturedAt).run();

  const stored = await loadRunSittingEvidence(db, runId, snapshot.sitting);
  if (!stored) throw new Error(`commissioning snapshot for ${runId}/${snapshot.sitting} was not stored`);
  return stored.commissioning;
}

/** Attach a Runner-observed executed spec to the current sitting without touching commissioning. */
export async function recordRunSittingExecutedSpec(
  db: D1Database,
  projectId: string,
  runId: string,
  executedSpec: unknown,
  observedAt = nowIso(),
): Promise<void> {
  const row = await db.prepare(
    `SELECT sitting FROM runs WHERE id = ? AND project_id = ?`,
  ).bind(runId, projectId).first<{ sitting: number }>();
  if (!row) return;
  const evidence = await loadRunSittingEvidence(db, runId, row.sitting);
  if (!evidence) return;
  const history = evidence.executedSpecs;
  if (canonicalJson(history.at(-1) ?? null) === canonicalJson(executedSpec)) return;
  history.push(executedSpec);
  await db.prepare(
    `UPDATE run_sitting_intelligence SET executed_specs = ?, runner_observed_at = ?
      WHERE run_id = ? AND sitting = ? AND project_id = ?`,
  ).bind(JSON.stringify(history), observedAt, runId, row.sitting, projectId).run();
}

export async function recordRunSittingExecutedConfiguration(
  db: D1Database,
  projectId: string,
  runId: string,
  configuration: ExecutedConfigurationEvidence,
  observedAt = nowIso(),
): Promise<void> {
  const row = await db.prepare('SELECT sitting FROM runs WHERE id = ? AND project_id = ?')
    .bind(runId, projectId).first<{ sitting: number }>();
  if (!row) return;
  await db.prepare(
    `UPDATE run_sitting_intelligence SET executed_config = ?, runner_observed_at = ?
      WHERE run_id = ? AND sitting = ? AND project_id = ?`,
  ).bind(canonicalJson(configuration), observedAt, runId, row.sitting, projectId).run();
}

export async function loadRunSittingEvidence(db: D1Database, runId: string, sitting: number): Promise<{
  commissioning: RunCommissioningSnapshot;
  executedSpecs: unknown[];
  executedConfig: ExecutedConfigurationEvidence | null;
  runnerObservedAt: string | null;
} | null> {
  const row = await db.prepare(
    `SELECT commissioning, executed_specs AS executedSpecs, executed_config AS executedConfig,
            runner_observed_at AS runnerObservedAt
       FROM run_sitting_intelligence WHERE run_id = ? AND sitting = ?`,
  ).bind(runId, sitting).first<SnapshotRow>();
  if (!row) return null;
  return {
    commissioning: parseJson<RunCommissioningSnapshot>(row.commissioning, null as never),
    executedSpecs: parseJson<unknown[]>(row.executedSpecs, []),
    executedConfig: parseJson<ExecutedConfigurationEvidence | null>(row.executedConfig, null),
    runnerObservedAt: row.runnerObservedAt,
  };
}

export type EpisodeIntelligenceDraft = Omit<ProjectIntelligenceEpisode, 'identity'> & {
  identity: Omit<ProjectIntelligenceEpisode['identity'], 'episodeId'>;
};
