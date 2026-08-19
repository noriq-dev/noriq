// PLNR-303: one read-only view model shared by task preview and dispatch UI. It composes the
// already-authoritative context/risk/bottleneck/comparison paths and never changes claimability,
// a selected strategy, a budget, or the dispatch payload.
import type { ContextPackDocumentReference, RunBudget } from '@noriq-dev/shared';
import type { Env } from '../env';
import { resolveRepositoryByKey } from '../lib/project-memory';
import {
  assessProjectBottlenecks, type IntelligenceExecutorMode,
} from './bottlenecks';
import { assessPreDispatchRisk } from './scope-risk';
import {
  queryStrategyComparison, type ComparisonMetric, type StrategyDimension,
} from './strategy-comparison';
import { assembleContextPack } from './context-pack';

export const DISPATCH_INTELLIGENCE_VERSION = 'dispatch-intelligence-v2';

export interface DispatchIntelligenceInput {
  taskId: string;
  runnerId?: string | null;
  repositoryCheckoutId?: string | null;
  repositoryKey?: string | null;
  branch?: string | null;
  baseId?: string | null;
  budget?: RunBudget | null;
  comparison?: { dimension: StrategyDimension; metric: ComparisonMetric };
  executorMode?: IntelligenceExecutorMode;
}

export interface DispatchIntelligenceComposition {
  /** Reuse a caller's canonical pack (notably get_task_context) instead of assembling again. */
  contextPack?: Awaited<ReturnType<typeof assembleContextPack>> | Promise<Awaited<ReturnType<typeof assembleContextPack>>>;
  /** Narrow test seam that proves the production path performs one assembly. */
  assemble?: typeof assembleContextPack;
}

function documentContext(pack: Awaited<ReturnType<typeof assembleContextPack>>) {
  const required = pack.taskFacts.relatedDocuments ?? [];
  const retrievedSection = pack.sections.find((section) => section.id === 'related_documents');
  const retrieved = retrievedSection?.documentReferences ?? [];
  const byRelationship = (relationship: ContextPackDocumentReference['relationship']) =>
    required.filter((document) => document.relationship === relationship);
  return {
    kind: 'metadata_only_document_context' as const,
    bodiesIncluded: false as const,
    linkedProjectDocuments: byRelationship('task_link'),
    planLocalDocuments: byRelationship('plan_membership'),
    semanticDocuments: retrieved,
    coverage: {
      retrievalMode: retrieved[0]?.retrieval.mode ?? null,
      empty: retrieved.length === 0 && retrievedSection?.notice == null,
      unavailable: retrievedSection?.notice?.kind === 'unanswerable',
      truncated: retrievedSection?.notice?.kind === 'truncated',
      notice: retrievedSection?.notice ?? null,
    },
  };
}

export async function resolveDispatchRepository(
  env: Env, projectId: string, runnerId?: string | null, checkoutId?: string | null,
  requestedRepositoryKey?: string | null,
): Promise<{ repositoryKey: string | null; reason: string | null }> {
  if (requestedRepositoryKey) {
    const repository = await resolveRepositoryByKey(env, projectId, requestedRepositoryKey);
    return repository
      ? { repositoryKey: repository.repositoryKey, reason: null }
      : { repositoryKey: null, reason: 'repository key is not registered to this project' };
  }
  if (!runnerId || !checkoutId) return { repositoryKey: null, reason: 'runner checkout context was not supplied' };
  const row = await env.DB.prepare(
    `SELECT pr.repository_key AS repositoryKey
       FROM repository_checkouts rc JOIN project_repositories pr ON pr.id = rc.project_repository_id
      WHERE rc.runner_id = ? AND rc.checkout_id = ? AND pr.project_id = ?`,
  ).bind(runnerId, checkoutId, projectId).first<{ repositoryKey: string }>();
  return row
    ? { repositoryKey: row.repositoryKey, reason: null }
    : { repositoryKey: null, reason: 'runner checkout is not associated with a canonical project repository' };
}

export async function getDispatchIntelligence(
  env: Env, projectId: string, input: DispatchIntelligenceInput,
  composition: DispatchIntelligenceComposition = {},
) {
  const repository = await resolveDispatchRepository(
    env, projectId, input.runnerId, input.repositoryCheckoutId, input.repositoryKey,
  );
  const executorMode = input.executorMode ?? 'runner';
  const observedAt = new Date().toISOString();
  const context = {
    repositoryKey: repository.repositoryKey,
    branch: input.branch ?? null,
    baseId: input.baseId ?? null,
  };
  const assembledPack = composition.contextPack
    ? Promise.resolve(composition.contextPack)
    : (composition.assemble ?? assembleContextPack)(env, projectId, input.taskId, {
        ...context, role: 'scope', tokenBudget: 8_000,
      });
  const packPromise = assembledPack.then((pack) => {
    if (pack.projectId !== projectId || pack.taskId !== input.taskId) {
      throw new Error('preassembled context pack does not match the dispatch intelligence target');
    }
    return pack;
  });
  const [risk, bottlenecks, comparison, pack] = await Promise.all([
    assessPreDispatchRisk(env, projectId, input.taskId, {
      ...context, budget: input.budget ?? null, observedAt, contextPack: packPromise,
    }),
    assessProjectBottlenecks(env, projectId, {
      taskId: input.taskId, ...context, observedAt, executorMode,
    }),
    input.comparison
      ? queryStrategyComparison(env, projectId, input.comparison)
      : Promise.resolve(null),
    packPromise,
  ]);
  return {
    advisory: true as const,
    version: DISPATCH_INTELLIGENCE_VERSION,
    observedAt,
    targetContext: {
      taskId: input.taskId,
      runnerId: input.runnerId ?? null,
      repositoryCheckoutId: input.repositoryCheckoutId ?? null,
      executorMode,
      repositoryKey: repository.repositoryKey,
      repositoryResolutionReason: repository.reason,
      branch: input.branch ?? null,
      baseId: input.baseId ?? null,
    },
    current: {
      kind: 'current_project_state' as const,
      readiness: bottlenecks.readiness.tasks.find((task) => task.taskId === input.taskId) ?? null,
      capacity: bottlenecks.capacity,
      collisions: bottlenecks.collisions,
      planGates: bottlenecks.planGates,
      humanBlocks: bottlenecks.humanBlocks.filter((block) => block.taskId === input.taskId),
      coverage: bottlenecks.coverage,
      sources: bottlenecks.sources.current,
    },
    documents: documentContext(pack),
    constraints: risk.currentAuthority,
    quotedEvidence: risk.quotedMemoryEvidence,
    historical: risk.priorEvidence,
    observations: {
      kind: 'statistical_observation' as const,
      scope: risk.scope,
      budget: risk.budget,
      coverage: risk.coverage,
      versions: risk.versions,
    },
    comparison,
    feedback: {
      endpoint: `/api/projects/${projectId}/memory/dispatch-intelligence/feedback`,
      requiresExplicitHumanAction: true as const,
      previewCreatesOccurrence: false as const,
    },
  };
}

/** A deliberately small subset for automatic inclusion in get_task_context. The full packet is
 * available by requesting intelligenceDetail="full"; quoted evidence and case bodies are never
 * duplicated into the summary context pack. */
export function summarizeDispatchIntelligence(
  packet: Awaited<ReturnType<typeof getDispatchIntelligence>>,
) {
  return {
    advisory: true as const,
    available: true as const,
    version: packet.version,
    observedAt: packet.observedAt,
    executorMode: packet.targetContext.executorMode,
    repository: {
      key: packet.targetContext.repositoryKey,
      reason: packet.targetContext.repositoryResolutionReason,
      branch: packet.targetContext.branch,
      baseId: packet.targetContext.baseId,
    },
    readiness: packet.current.readiness,
    collisions: {
      lockingStatus: packet.current.collisions.locking.status,
      liveLockCount: packet.current.collisions.locking.current.length,
      anticipatedPathOverlapCount: packet.current.collisions.anticipatedPaths.overlaps.length,
      graphImpactOverlapCount: packet.current.collisions.graphImpact.overlaps.length,
    },
    blockingHumanInputCount: packet.current.humanBlocks.length,
    coverage: packet.current.coverage,
    scope: {
      status: packet.observations.scope.status,
      observation: packet.observations.scope.observation,
    },
    historicalCaseCount: packet.historical.cases.length,
    documents: {
      linkedProjectCount: packet.documents.linkedProjectDocuments.length,
      planLocalCount: packet.documents.planLocalDocuments.length,
      semanticCount: packet.documents.semanticDocuments.length,
      coverage: packet.documents.coverage,
      metadataOnly: true as const,
    },
    fullPacketTool: 'get_task_context' as const,
    fullPacketArguments: { intelligenceDetail: 'full' as const },
  };
}
