// PLNR-534: bounded, read-only intelligence for dispatching a whole plan. This deliberately
// aggregates plan facts in fixed query counts; it never assembles member task context packs.
import type { ContextPackDocumentReference } from '@noriq-dev/shared';
import type { Env } from '../env';
import { resolveDispatchRepository, type DispatchIntelligenceInput } from './dispatch-intelligence';
import { search } from '../search';
import { renderEvidenceFrame } from './evidence-frame';
import { searchHitToEvidenceItem, type ProjectMemoryStub } from '../lib/project-memory';

export const PLAN_DISPATCH_INTELLIGENCE_VERSION = 'plan-dispatch-intelligence-v1';
export const PLAN_TASK_LIMIT = 500;
export const PLAN_PHASE_LIMIT = 500;
export const PLAN_DOC_LIMIT = 50;
export const LINKED_DOC_LIMIT = 100;
export const SEMANTIC_DOC_LIMIT = 12;
export const PLAN_QUERY_LIMIT = 6_000;
const PLAN_BODY_QUERY_LIMIT = 2_000;
const BLOCKER_SUMMARY_LIMIT = 100;

export interface PlanDispatchIntelligenceInput {
  planId: string;
  runnerId?: string | null;
  repositoryCheckoutId?: string | null;
  repositoryKey?: string | null;
  branch?: string | null;
  baseId?: string | null;
}

type PlanRow = {
  id: string; title: string; description: string; body: string; status: string;
  createdAt: string;
};
type PhaseRow = { id: string; title: string; body: string; order: number; totalPhases: number };
type TaskRow = {
  id: string; key: string; title: string; status: string; storedStatus: string; failedAt: string | null;
  proposedAt: string | null; priority: number; order: number; phaseId: string; phaseTitle: string;
  phaseOrder: number; claimed: number; reserved: number; totalTasks: number;
};
type BlockerRow = { taskId: string; blockerCount: number };
type PlanDocRow = {
  id: string; name: string; description: string; updatedAt: string; totalDocuments: number;
};
type LinkedDocRow = PlanDocRow & { totalTaskLinks: number; exampleTaskKeys: string };

function boundedPlanQuery(plan: PlanRow, phases: PhaseRow[], tasks: TaskRow[]): string {
  return [
    plan.title,
    plan.description,
    plan.body.slice(0, PLAN_BODY_QUERY_LIMIT),
    ...phases.map((phase) => phase.title),
    ...tasks.map((task) => task.title),
  ].filter(Boolean).join('\n').slice(0, PLAN_QUERY_LIMIT);
}

function projectDocReference(row: {
  id: string; name: string; description: string; updatedAt: string;
}, retrieval: { mode: 'explicit' | 'semantic' | 'keyword'; score: number | null; indexFreshness: 'current' | 'unverified' }): ContextPackDocumentReference {
  return {
    kind: 'project_doc', id: row.id, name: row.name, description: row.description,
    updatedAt: row.updatedAt, relationship: retrieval.mode === 'explicit' ? 'task_link' : 'semantic',
    provisional: false, plan: null, retrieval,
    readRef: { kind: 'project_doc', docId: row.id },
  };
}

function planDocReference(row: PlanDocRow, plan: PlanRow): ContextPackDocumentReference {
  return {
    kind: 'plan_doc', id: row.id, name: row.name, description: row.description,
    updatedAt: row.updatedAt, relationship: 'plan_membership', provisional: true,
    plan: {
      id: plan.id, title: plan.title, status: plan.status,
      phaseId: null, phaseTitle: null, phaseOrder: null,
    },
    retrieval: { mode: 'explicit', score: null, indexFreshness: 'current' },
    readRef: { kind: 'plan_doc', planId: plan.id, docId: row.id },
  };
}

function safeExampleKeys(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 5) : [];
  } catch {
    return [];
  }
}

/** One deterministic aggregate. All task-set SQL uses one JSON parameter, never N placeholders. */
export async function getPlanDispatchIntelligence(
  env: Env, projectId: string, input: PlanDispatchIntelligenceInput,
  dependencies: { search?: typeof search; memory?: ProjectMemoryStub } = {},
) {
  const observedAt = new Date().toISOString();
  const repository = await resolveDispatchRepository(
    env, projectId, input.runnerId, input.repositoryCheckoutId, input.repositoryKey,
  );
  const plan = await env.DB.prepare(
    `SELECT id, title, description, body, status, created_at AS createdAt
       FROM plans WHERE id = ? AND project_id = ?`,
  ).bind(input.planId, projectId).first<PlanRow>();
  if (!plan) throw new Error(`plan ${input.planId} not found in project ${projectId}`);

  const [phasesResult, tasksResult, activeDispatch] = await Promise.all([
    env.DB.prepare(
      `SELECT id, title, body, "order" AS "order", COUNT(*) OVER() AS totalPhases FROM phases
        WHERE plan_id = ? ORDER BY "order", id LIMIT ?`,
    ).bind(plan.id, PLAN_PHASE_LIMIT + 1).all<PhaseRow>(),
    env.DB.prepare(
      `SELECT t.id, t.key, t.title,
              CASE WHEN t.failed_at IS NOT NULL AND t.status = 'todo' THEN 'failed'
                   WHEN t.proposed_at IS NOT NULL AND t.status = 'todo' THEN 'proposed'
                   ELSE t.status END AS status,
              t.status AS storedStatus, t.failed_at AS failedAt, t.proposed_at AS proposedAt,
              t.priority, t."order" AS "order", ph.id AS phaseId, ph.title AS phaseTitle,
              ph."order" AS phaseOrder,
              EXISTS(SELECT 1 FROM claims c WHERE c.task_id = t.id AND c.released_at IS NULL AND c.expires_at > ?1) AS claimed,
              EXISTS(SELECT 1 FROM runner_job_items rji WHERE rji.task_id = t.id AND rji.reservation_active = 1) AS reserved,
              COUNT(*) OVER() AS totalTasks
         FROM phase_tasks pt JOIN phases ph ON ph.id = pt.phase_id JOIN tasks t ON t.id = pt.task_id
        WHERE ph.plan_id = ?2 AND t.project_id = ?3
        ORDER BY ph."order", t."order", t.key LIMIT ?4`,
    ).bind(observedAt, plan.id, projectId, PLAN_TASK_LIMIT + 1).all<TaskRow>(),
    env.DB.prepare(
      `SELECT id, gate, status, updated_at AS updatedAt FROM plan_dispatches
        WHERE plan_id = ? AND status = 'active' ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).bind(plan.id).first<{ id: string; gate: string; status: string; updatedAt: string }>(),
  ]);
  const totalTasks = Number(tasksResult.results[0]?.totalTasks ?? 0);
  const tasks = tasksResult.results.slice(0, PLAN_TASK_LIMIT);
  const totalPhases = Number(phasesResult.results[0]?.totalPhases ?? 0);
  const phases = phasesResult.results.slice(0, PLAN_PHASE_LIMIT);
  const taskIdsJson = JSON.stringify(tasks.map((task) => task.id));
  const gate = activeDispatch?.gate === 'landed' ? 'landed' : 'strict';

  const [blockersResult, planDocsResult, linkedDocsResult] = await Promise.all([
    tasks.length ? env.DB.prepare(
      `WITH requested_tasks(id) AS (SELECT CAST(value AS TEXT) FROM json_each(?1)),
       candidates AS (
         SELECT d.task_id AS taskId, blocker.id AS blockerTaskId, blocker.status,
                (EXISTS(SELECT 1 FROM runs r WHERE r.anchor_type = 'task' AND r.anchor_id = blocker.id AND r.status = 'done')
                 OR EXISTS(SELECT 1 FROM mission_task_attempts ma JOIN mission_handoffs mh ON mh.root_run_id = ma.root_run_id
                            WHERE ma.task_id = blocker.id AND ma.status = 'review' AND ma.outcome = 'done' AND mh.consumed_at IS NOT NULL)) AS landedRun
           FROM requested_tasks requested JOIN dependencies d ON d.task_id = requested.id
           JOIN tasks blocker ON blocker.id = d.depends_on_task_id
          WHERE blocker.status NOT IN ('done','cancelled')
         UNION ALL
         SELECT pt.task_id AS taskId, blocker.id AS blockerTaskId, blocker.status,
                (EXISTS(SELECT 1 FROM runs r WHERE r.anchor_type = 'task' AND r.anchor_id = blocker.id AND r.status = 'done')
                 OR EXISTS(SELECT 1 FROM mission_task_attempts ma JOIN mission_handoffs mh ON mh.root_run_id = ma.root_run_id
                            WHERE ma.task_id = blocker.id AND ma.status = 'review' AND ma.outcome = 'done' AND mh.consumed_at IS NOT NULL)) AS landedRun
           FROM requested_tasks requested JOIN phase_tasks pt ON pt.task_id = requested.id
           JOIN phases ph ON ph.id = pt.phase_id JOIN phases prev ON prev.plan_id = ph.plan_id AND prev."order" < ph."order"
           JOIN phase_tasks ppt ON ppt.phase_id = prev.id JOIN tasks blocker ON blocker.id = ppt.task_id
          WHERE blocker.status NOT IN ('done','cancelled')
       ), active AS (
         SELECT DISTINCT taskId, blockerTaskId FROM candidates
          WHERE ?2 != 'landed' OR status != 'review' OR landedRun = 0
       )
       SELECT taskId, COUNT(*) AS blockerCount FROM active GROUP BY taskId`,
    ).bind(taskIdsJson, gate).all<BlockerRow>() : Promise.resolve({ results: [] as BlockerRow[] }),
    env.DB.prepare(
      `SELECT id, name, description, updated_at AS updatedAt, COUNT(*) OVER() AS totalDocuments
         FROM plan_docs WHERE plan_id = ? AND project_id = ?
        ORDER BY updated_at DESC, name, id LIMIT ?`,
    ).bind(plan.id, projectId, PLAN_DOC_LIMIT + 1).all<PlanDocRow>(),
    tasks.length ? env.DB.prepare(
      `WITH requested_tasks(id) AS (SELECT CAST(value AS TEXT) FROM json_each(?1)),
       links AS (
         SELECT td.doc_id AS docId, t.key AS taskKey
           FROM requested_tasks requested JOIN tasks t ON t.id = requested.id
           JOIN task_docs td ON td.task_id = t.id
       ), aggregated AS (
         SELECT d.id, d.name, d.description, d.updated_at AS updatedAt, COUNT(*) AS totalTaskLinks
           FROM links l JOIN docs d ON d.id = l.docId
          WHERE d.project_id = ?2 AND d.archived_at IS NULL GROUP BY d.id, d.name, d.description, d.updated_at
       )
       SELECT a.*, COUNT(*) OVER() AS totalDocuments,
              (SELECT json_group_array(taskKey) FROM (
                 SELECT taskKey FROM links WHERE docId = a.id ORDER BY taskKey LIMIT 5
               )) AS exampleTaskKeys
         FROM aggregated a ORDER BY a.totalTaskLinks DESC, a.name, a.id LIMIT ?3`,
    ).bind(taskIdsJson, projectId, LINKED_DOC_LIMIT + 1).all<LinkedDocRow>()
      : Promise.resolve({ results: [] as LinkedDocRow[] }),
  ]);

  const blockerCount = new Map(blockersResult.results.map((row) => [row.taskId, Number(row.blockerCount)]));
  const taskIndex = tasks.map((task) => {
    const blockedBy = blockerCount.get(task.id) ?? 0;
    const baseClaimable = task.storedStatus === 'todo' && !task.proposedAt && plan.status !== 'proposed' && blockedBy === 0;
    return {
      taskId: task.id, taskKey: task.key, title: task.title, status: task.status,
      phase: { id: task.phaseId, title: task.phaseTitle, order: task.phaseOrder },
      order: task.order, priority: task.priority, retry: task.status === 'failed',
      claimed: !!task.claimed, reserved: !!task.reserved, blockerCount: blockedBy,
      dispatchable: baseClaimable && !task.claimed && !task.reserved,
    };
  });
  const blockers = taskIndex.filter((task) => task.blockerCount > 0 ||
    (task.status === 'proposed' || plan.status === 'proposed'));
  const planDocRows = planDocsResult.results.slice(0, PLAN_DOC_LIMIT);
  const linkedDocRows = linkedDocsResult.results.slice(0, LINKED_DOC_LIMIT);
  const query = boundedPlanQuery(plan, phases, tasks);

  const stub = dependencies.memory ?? (
    env.PROJECT_MEMORY.get(env.PROJECT_MEMORY.idFromName(projectId)) as unknown as ProjectMemoryStub
  );
  const searchDocuments = dependencies.search ?? search;
  const [documentSearch, memorySearch] = await Promise.all([
    searchDocuments(env, { q: query || plan.title, projectIds: [projectId], kinds: ['doc'], limit: SEMANTIC_DOC_LIMIT * 2 })
      .then((result) => ({ ...result, unavailableReason: null as string | null }))
      .catch((error) => ({ mode: null, results: [], unavailableReason: error instanceof Error ? error.message : String(error) })),
    stub.searchProjectMemory(projectId, {
      query: query || plan.title, repositoryKey: repository.repositoryKey ?? undefined,
      preferBranch: input.branch ?? undefined, baseId: input.baseId ?? undefined,
      minAuthority: 4, validity: 'active', limit: 30,
    }).then((result) => ({ ...result, unavailableReason: null as string | null }))
      .catch((error) => ({ mode: null, results: [], unavailableReason: error instanceof Error ? error.message : String(error) })),
  ]);

  const semanticCandidateIds = documentSearch.results.map((hit) => hit.id);
  const explicitlyLinked = semanticCandidateIds.length && tasks.length
    ? await env.DB.prepare(
      `WITH candidate_docs(id) AS (SELECT CAST(value AS TEXT) FROM json_each(?1)),
            requested_tasks(id) AS (SELECT CAST(value AS TEXT) FROM json_each(?2))
       SELECT DISTINCT candidate.id FROM candidate_docs candidate
         JOIN task_docs td ON td.doc_id = candidate.id JOIN requested_tasks task ON task.id = td.task_id`,
    ).bind(JSON.stringify(semanticCandidateIds), taskIdsJson).all<{ id: string }>()
    : { results: [] as Array<{ id: string }> };
  const explicitIds = new Set(explicitlyLinked.results.map((row) => row.id));
  const semanticDocuments = documentSearch.results
    .filter((hit) => hit.kind === 'doc' && hit.projectId === projectId && !!hit.updatedAt && !explicitIds.has(hit.id))
    .slice(0, SEMANTIC_DOC_LIMIT)
    .map((hit) => projectDocReference({
      id: hit.id, name: hit.title, description: hit.description ?? '', updatedAt: hit.updatedAt!,
    }, {
      mode: documentSearch.mode === 'semantic' ? 'semantic' : 'keyword', score: hit.score,
      indexFreshness: documentSearch.mode === 'semantic' ? 'unverified' : 'current',
    }));
  const memoryConstraints = memorySearch.results.filter((hit) =>
    hit.entityType === 'memory' && ['decision', 'hazard', 'requirement', 'unknown'].includes(hit.kind ?? '') &&
    (hit.authority ?? 0) >= 4 && hit.validity === 'active');
  const memoryEvidenceItems = memorySearch.results.map(searchHitToEvidenceItem)
    .filter((item): item is NonNullable<typeof item> => item !== null);

  const totalPlanDocs = Number(planDocsResult.results[0]?.totalDocuments ?? 0);
  const totalLinkedDocs = Number(linkedDocsResult.results[0]?.totalDocuments ?? 0);
  const coverageReasons = [
    totalTasks > PLAN_TASK_LIMIT ? 'task_index_limit_reached' : null,
    totalPhases > PLAN_PHASE_LIMIT ? 'phase_index_limit_reached' : null,
    totalPlanDocs > PLAN_DOC_LIMIT ? 'plan_doc_limit_reached' : null,
    totalLinkedDocs > LINKED_DOC_LIMIT ? 'linked_doc_limit_reached' : null,
    documentSearch.unavailableReason ? 'document_retrieval_unavailable' : null,
    memorySearch.unavailableReason ? 'project_memory_unavailable' : null,
    documentSearch.results.length >= SEMANTIC_DOC_LIMIT * 2 ? 'semantic_candidate_limit_reached' : null,
    blockers.length > BLOCKER_SUMMARY_LIMIT ? 'blocker_summary_limit_reached' : null,
  ].filter((reason): reason is string => reason !== null);

  return {
    advisory: true as const,
    version: PLAN_DISPATCH_INTELLIGENCE_VERSION,
    observedAt,
    plan: {
      id: plan.id, title: plan.title, description: plan.description, status: plan.status,
      phaseCount: totalPhases, taskCount: totalTasks,
    },
    targetContext: {
      runnerId: input.runnerId ?? null, repositoryCheckoutId: input.repositoryCheckoutId ?? null,
      repositoryKey: repository.repositoryKey, repositoryResolutionReason: repository.reason,
      branch: input.branch ?? null, baseId: input.baseId ?? null,
    },
    counts: {
      phases: totalPhases, tasks: totalTasks,
      dispatchable: taskIndex.filter((task) => task.dispatchable).length,
      retry: taskIndex.filter((task) => task.retry && task.dispatchable).length,
      settled: taskIndex.filter((task) => task.status === 'done' || task.status === 'cancelled').length,
      claimed: taskIndex.filter((task) => task.claimed).length,
      reserved: taskIndex.filter((task) => task.reserved).length,
    },
    blockers: {
      totalTasks: blockers.length,
      items: blockers.slice(0, BLOCKER_SUMMARY_LIMIT).map((task) => ({
        taskId: task.taskId, taskKey: task.taskKey, status: task.status,
        blockerCount: task.blockerCount,
        reason: plan.status === 'proposed' ? 'plan_approval' : task.status === 'proposed' ? 'task_approval' : 'dependency_or_phase',
      })),
      omitted: Math.max(0, blockers.length - BLOCKER_SUMMARY_LIMIT),
    },
    repository: {
      key: repository.repositoryKey, reason: repository.reason,
      branch: input.branch ?? null, baseId: input.baseId ?? null,
    },
    documents: {
      bodiesIncluded: false as const,
      planLocal: planDocRows.map((row) => planDocReference(row, plan)),
      linkedProject: linkedDocRows.map((row) => ({
        ...projectDocReference(row, { mode: 'explicit', score: null, indexFreshness: 'current' }),
        totalTaskLinks: Number(row.totalTaskLinks), exampleTaskKeys: safeExampleKeys(row.exampleTaskKeys),
      })),
      semantic: semanticDocuments,
      coverage: {
        planLocal: { total: totalPlanDocs, emitted: planDocRows.length, omitted: Math.max(0, totalPlanDocs - planDocRows.length) },
        linkedProject: { total: totalLinkedDocs, emitted: linkedDocRows.length, omitted: Math.max(0, totalLinkedDocs - linkedDocRows.length) },
        semantic: {
          mode: documentSearch.mode, unavailable: documentSearch.unavailableReason !== null,
          reason: documentSearch.unavailableReason, emitted: semanticDocuments.length,
          candidateLimitReached: documentSearch.results.length >= SEMANTIC_DOC_LIMIT * 2,
          status: documentSearch.unavailableReason ? 'unavailable' as const
            : documentSearch.results.length >= SEMANTIC_DOC_LIMIT * 2 ? 'truncated' as const
              : documentSearch.mode === 'keyword' ? 'fallback' as const
                : semanticDocuments.length === 0 ? 'empty' as const : 'complete' as const,
          freshness: documentSearch.mode === 'semantic' ? 'unverified' as const
            : documentSearch.mode === 'keyword' ? 'current' as const : null,
        },
      },
    },
    memory: {
      constraints: memoryConstraints,
      evidenceFrame: renderEvidenceFrame(memoryEvidenceItems, { maxChars: 8_000, maxItemChars: 2_000 }),
      coverage: {
        mode: memorySearch.mode, unavailable: memorySearch.unavailableReason !== null,
        reason: memorySearch.unavailableReason, candidates: memorySearch.results.length,
      },
    },
    taskIndex,
    taskIndexCoverage: {
      limit: PLAN_TASK_LIMIT, total: totalTasks, emitted: taskIndex.length,
      omitted: Math.max(0, totalTasks - taskIndex.length), complete: totalTasks <= PLAN_TASK_LIMIT,
    },
    taskDetail: {
      endpoint: `/api/projects/${projectId}/memory/dispatch-intelligence`, method: 'POST' as const,
      instruction: 'Call only when a member task is expanded; do not eagerly load task packets.',
      request: {
        taskId: '$TASK_ID', runnerId: input.runnerId ?? null,
        repositoryCheckoutId: input.repositoryCheckoutId ?? null,
        repositoryKey: repository.repositoryKey, branch: input.branch ?? null, baseId: input.baseId ?? null,
      } satisfies DispatchIntelligenceInput,
    },
    query: { text: query, chars: query.length, limit: PLAN_QUERY_LIMIT },
    coverage: {
      status: coverageReasons.length ? 'partial' as const : 'complete' as const,
      reasons: coverageReasons,
    },
  };
}
