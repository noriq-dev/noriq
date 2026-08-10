// PLNR-295: deterministic pre-dispatch scope and budget evidence. This module composes the
// existing task context pack and similar-effort cases; it does not create a scorer, mutate the
// task, or feed any value into claim/dispatch decisions.
import type { Env } from '../env';
import { resolveRepositoryByKey, type ProjectMemoryStub } from '../lib/project-memory';
import { readExecutionSpec } from '../lib/execution-spec';
import { assembleContextPack } from './context-pack';
import { SIMILAR_EFFORT_RETRIEVAL_VERSION, type PriorEffortCase, type PriorEffortObservation } from './similar-effort';
import {
  AUTHORITY_HUMAN_APPROVED, AUTHORITY_VERIFIED_MERGED,
  type ContextPackMemoryExcerpt, type ExecutionSpec, type RunBudget,
} from '@noriq-dev/shared';

export const PRE_DISPATCH_RISK_VERSION = 'scope-budget-risk-v1';
export const PRE_DISPATCH_CASE_LIMIT = 20;

export interface PreDispatchRiskInput {
  repositoryKey?: string | null;
  branch?: string | null;
  baseId?: string | null;
  budget?: RunBudget | null;
  observedAt?: string;
}

interface ObservedRange {
  observedCount: number;
  partialCount: number;
  unavailableCount: number;
  min: number | null;
  median: number | null;
  max: number | null;
}

export interface BudgetContext extends ObservedRange {
  proposed: number | null;
  belowObservedCases: number;
  completeness: 'unavailable' | 'partial' | 'complete';
  observation: string;
}

export interface PreDispatchRiskResult {
  advisory: true;
  observedAt: string;
  versions: { risk: typeof PRE_DISPATCH_RISK_VERSION; retrieval: typeof SIMILAR_EFFORT_RETRIEVAL_VERSION };
  target: {
    taskId: string;
    taskKey: string;
    taskUpdatedAt: string;
    executionSpec: ExecutionSpec | null;
    executionSpecUnreadable: boolean;
    repository: { requestedKey: string | null; canonical: boolean; branch: string | null; baseId: string | null };
    dependencies: Array<{ taskId: string; key: string; status: string }>;
    phases: Array<{ planId: string; planTitle: string; planStatus: string; phaseId: string; phaseTitle: string; order: number }>;
  };
  coverage: { status: 'unanswerable' | 'partial' | 'complete'; reasons: string[] };
  scope: {
    status: 'unanswerable' | 'partial' | 'observed';
    anticipatedFiles: string[];
    priorFileCounts: ObservedRange;
    verificationOrRepairCases: { observedCount: number; yes: number; unavailableCount: number };
    observation: string;
  };
  budget: {
    maxTokens: BudgetContext;
    maxUsd: BudgetContext;
    maxDurationSeconds: BudgetContext;
    maxRounds: BudgetContext;
  };
  currentAuthority: {
    kind: 'current_project_authority';
    decisions: ContextPackMemoryExcerpt[];
    hazards: ContextPackMemoryExcerpt[];
    unknowns: ContextPackMemoryExcerpt[];
  };
  priorEvidence: {
    kind: 'historical_case_observation';
    retrievalMode: 'semantic' | 'keyword';
    branchPolicy: 'prefer_not_filter';
    supportRule: 'two_independent_kinds';
    caseLimit: number;
    consideredCount: number;
    coverage: { complete: boolean; candidatesConsidered: number; eligibleCases: number; reasons: string[] };
    cases: Array<PriorEffortCase & { contextMatch: {
      repository: boolean | null; branch: boolean | null; baseId: boolean | null;
    } }>;
  };
}

function observedRange(values: PriorEffortObservation[]): ObservedRange {
  const observed = values
    .filter((item): item is PriorEffortObservation & { value: number } => typeof item.value === 'number')
    .map((item) => item.value)
    .sort((a, b) => a - b);
  const median = observed.length
    ? observed.length % 2 ? observed[Math.floor(observed.length / 2)]! :
      (observed[observed.length / 2 - 1]! + observed[observed.length / 2]!) / 2
    : null;
  return {
    observedCount: observed.length,
    partialCount: values.filter((item) => typeof item.value === 'number' && item.completeness === 'partial').length,
    unavailableCount: values.length - observed.length,
    min: observed[0] ?? null,
    median,
    max: observed.at(-1) ?? null,
  };
}

function budgetContext(label: string, proposed: number | null, values: PriorEffortObservation[]): BudgetContext {
  const range = observedRange(values);
  const observedValues = values.flatMap((item) => typeof item.value === 'number' ? [item.value] : []);
  if (proposed == null) {
    return {
      ...range, proposed: null, belowObservedCases: 0, completeness: 'unavailable',
      observation: `${label} was not proposed; no budget comparison was made`,
    };
  }
  if (!observedValues.length) {
    return {
      ...range, proposed, belowObservedCases: 0, completeness: 'unavailable',
      observation: `${label} is ${proposed}, but relevant cases have no usable observation for this metric`,
    };
  }
  const belowObservedCases = observedValues.filter((value) => proposed < value).length;
  return {
    ...range,
    proposed,
    belowObservedCases,
    completeness: range.unavailableCount || range.partialCount ? 'partial' : 'complete',
    observation: `${label} ${proposed} is below ${belowObservedCases} of ${range.observedCount} observed relevant cases; range ${range.min}-${range.max}, median ${range.median}`,
  };
}

function memoryExcerpts(pack: Awaited<ReturnType<typeof assembleContextPack>>, sectionId: string): ContextPackMemoryExcerpt[] {
  return (pack.sections.find((section) => section.id === sectionId)?.excerpts ?? [])
    .filter((excerpt): excerpt is ContextPackMemoryExcerpt => excerpt.excerptKind === 'memory');
}

function currentHighAuthority(pack: Awaited<ReturnType<typeof assembleContextPack>>, sectionId: string) {
  return memoryExcerpts(pack, sectionId)
    .filter((item) => item.validity === 'active' && item.authority >= AUTHORITY_VERIFIED_MERGED);
}

/** All realized fields used here belong to terminal PRIOR cases. The target contributes only its
 * current structured task/spec/dependency/repository context and proposed budget. */
export async function assessPreDispatchRisk(
  env: Env,
  projectId: string,
  taskId: string,
  input: PreDispatchRiskInput = {},
): Promise<PreDispatchRiskResult> {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const task = await env.DB.prepare(
    `SELECT id, key, title, body, execution_spec AS executionSpec, updated_at AS updatedAt
       FROM tasks WHERE id = ? AND project_id = ?`,
  ).bind(taskId, projectId).first<{
    id: string; key: string; title: string; body: string; executionSpec: string | null; updatedAt: string;
  }>();
  if (!task) throw new Error(`task ${taskId} not found in project ${projectId}`);
  const spec = readExecutionSpec(task.executionSpec, task.id);
  const anticipatedFiles = spec.spec?.anticipatedFiles.map((file) => file.path) ?? [];
  const stub = env.PROJECT_MEMORY.get(env.PROJECT_MEMORY.idFromName(projectId)) as unknown as ProjectMemoryStub;
  const [dependencies, phases, repository, pack, prior] = await Promise.all([
    env.DB.prepare(
      `SELECT dependency.id AS taskId, dependency.key, dependency.status
         FROM dependencies d JOIN tasks dependency ON dependency.id = d.depends_on_task_id
        WHERE d.task_id = ? ORDER BY dependency.key`,
    ).bind(task.id).all<{ taskId: string; key: string; status: string }>(),
    env.DB.prepare(
      `SELECT p.id AS planId, p.title AS planTitle, p.status AS planStatus,
              ph.id AS phaseId, ph.title AS phaseTitle, ph."order" AS "order"
         FROM phase_tasks pt JOIN phases ph ON ph.id = pt.phase_id JOIN plans p ON p.id = ph.plan_id
        WHERE pt.task_id = ? ORDER BY p.id, ph."order"`,
    ).bind(task.id).all<{
      planId: string; planTitle: string; planStatus: string;
      phaseId: string; phaseTitle: string; order: number;
    }>(),
    input.repositoryKey ? resolveRepositoryByKey(env, projectId, input.repositoryKey) : Promise.resolve(null),
    assembleContextPack(env, projectId, task.id, {
      repositoryKey: input.repositoryKey ?? null,
      branch: input.branch ?? null,
      baseId: input.baseId ?? null,
      role: 'scope',
      tokenBudget: 8_000,
    }),
    stub.similarEffort(projectId, {
      taskId: task.id, title: task.title, body: task.body, anticipatedFiles,
      repositoryKey: input.repositoryKey ?? undefined,
      preferBranch: input.branch ?? undefined,
      limit: PRE_DISPATCH_CASE_LIMIT,
    }),
  ]);

  const cases = prior.cases.slice(0, PRE_DISPATCH_CASE_LIMIT).map((item) => ({
    ...item,
    contextMatch: {
      repository: input.repositoryKey && item.repositoryKey ? input.repositoryKey === item.repositoryKey : null,
      branch: input.branch && item.branch ? input.branch === item.branch : null,
      baseId: input.baseId && item.baseId ? input.baseId === item.baseId : null,
    },
  }));
  const graph = pack.sections.find((section) => section.id === 'graph_neighborhood');
  const impact = pack.sections.find((section) => section.id === 'affected_tests');
  const reasons: string[] = [];
  if (spec.unreadable) reasons.push('execution_spec_unreadable');
  else if (!spec.spec) reasons.push('execution_spec_absent');
  if (!spec.spec?.anticipatedFiles.length) reasons.push('anticipated_files_absent');
  if (!input.repositoryKey) reasons.push('canonical_repository_not_supplied');
  else if (!repository) reasons.push('canonical_repository_not_registered');
  if (!input.branch) reasons.push('branch_context_absent');
  if (!input.baseId) reasons.push('base_id_context_absent');
  if (!graph?.coverage?.complete) reasons.push(...(graph?.coverage?.reasons.map((reason) => `graph:${reason}`) ?? ['graph:unanswerable']));
  if (!impact?.coverage?.complete) reasons.push(...(impact?.coverage?.reasons.map((reason) => `impact:${reason}`) ?? ['impact:unanswerable']));
  if (!cases.length) reasons.push('adequate_prior_retrieval_support_absent');

  const priorFiles = observedRange(cases.map((item) => item.observed.filesTouched));
  const verification = cases.map((item) => item.observed.verificationOrRepair);
  const verificationObserved = verification.filter((item) => typeof item.value === 'boolean');
  const scopeStatus = !anticipatedFiles.length || !cases.length
    ? 'unanswerable'
    : graph?.coverage?.complete && impact?.coverage?.complete &&
        priorFiles.unavailableCount === 0 && priorFiles.partialCount === 0
      ? 'observed'
      : 'partial';
  const coverageStatus = reasons.length === 0
    ? 'complete'
    : reasons.some((reason) => ['execution_spec_absent', 'execution_spec_unreadable', 'canonical_repository_not_registered'].includes(reason))
      ? 'unanswerable'
      : 'partial';
  const scopeObservation = priorFiles.observedCount
    ? `${priorFiles.observedCount} relevant prior cases touched ${priorFiles.min}-${priorFiles.max} files (median ${priorFiles.median}); ${verificationObserved.filter((item) => item.value === true).length} of ${verificationObserved.length} cases with stage evidence included verification or repair`
    : 'No relevant prior case has a usable changed-file observation; no low-scope conclusion was made';
  const budget = input.budget ?? { maxTokens: null, maxUsd: null, maxDurationSeconds: null, maxRounds: null };

  return {
    advisory: true,
    observedAt,
    versions: { risk: PRE_DISPATCH_RISK_VERSION, retrieval: SIMILAR_EFFORT_RETRIEVAL_VERSION },
    target: {
      taskId: task.id,
      taskKey: task.key,
      taskUpdatedAt: task.updatedAt,
      executionSpec: spec.spec,
      executionSpecUnreadable: !!spec.unreadable,
      repository: {
        requestedKey: input.repositoryKey ?? null,
        canonical: !!repository,
        branch: input.branch ?? null,
        baseId: input.baseId ?? null,
      },
      dependencies: dependencies.results,
      phases: phases.results,
    },
    coverage: { status: coverageStatus, reasons: [...new Set(reasons)] },
    scope: {
      status: scopeStatus,
      anticipatedFiles,
      priorFileCounts: priorFiles,
      verificationOrRepairCases: {
        observedCount: verificationObserved.length,
        yes: verificationObserved.filter((item) => item.value === true).length,
        unavailableCount: verification.length - verificationObserved.length,
      },
      observation: scopeObservation,
    },
    budget: {
      maxTokens: budgetContext('maxTokens', budget.maxTokens, cases.map((item) => item.observed.tokens)),
      maxUsd: budgetContext('maxUsd', budget.maxUsd, cases.map((item) => item.observed.costUSD)),
      maxDurationSeconds: budgetContext('maxDurationSeconds', budget.maxDurationSeconds,
        cases.map((item) => ({ ...item.observed.elapsedMs, value: typeof item.observed.elapsedMs.value === 'number' ? item.observed.elapsedMs.value / 1_000 : null }))),
      maxRounds: budgetContext('maxRounds', budget.maxRounds, cases.map((item) => item.observed.reviewRounds)),
    },
    currentAuthority: {
      kind: 'current_project_authority',
      decisions: currentHighAuthority(pack, 'active_decisions')
        .filter((item) => item.authority === AUTHORITY_HUMAN_APPROVED),
      hazards: currentHighAuthority(pack, 'known_hazards'),
      unknowns: currentHighAuthority(pack, 'uncertainty'),
    },
    priorEvidence: {
      kind: 'historical_case_observation',
      retrievalMode: pack.mode,
      branchPolicy: 'prefer_not_filter',
      supportRule: 'two_independent_kinds',
      caseLimit: PRE_DISPATCH_CASE_LIMIT,
      consideredCount: prior.consideredCount,
      coverage: prior.coverage,
      cases,
    },
  };
}
