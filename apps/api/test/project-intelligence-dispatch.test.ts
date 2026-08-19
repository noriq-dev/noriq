import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { getDispatchIntelligence } from '../src/memory/dispatch-intelligence';
import { assembleContextPack } from '../src/memory/context-pack';
import { getPlanDispatchIntelligence } from '../src/memory/plan-dispatch-intelligence';
import { createAgent, mcpCall } from './helpers';

const appEnv = env as unknown as Env;
interface MemoryRpc {
  recordEpisode(projectId: string, input: Record<string, unknown>): Promise<{ episodeId: string }>;
  reconcile(projectId: string): Promise<unknown>;
}
const memory = (projectId: string) => appEnv.PROJECT_MEMORY.get(
  appEnv.PROJECT_MEMORY.idFromName(projectId),
) as unknown as MemoryRpc;
let owner: { apiKey: string };
beforeAll(async () => { owner = await createAgent('dispatch-intelligence'); }, 60_000);

describe('dispatch-time Project Intelligence (PLNR-303)', () => {
  it('renders the default 100-task advisory without exceeding D1 bind limits', async () => {
    const projectId = (await mcpCall(owner.apiKey, 'create_project', {
      key: 'PIBOUND', name: 'Bounded dispatch intelligence',
    })).body.id as string;
    const tasks = Array.from({ length: 100 }, (_, index) => ({
      id: `task_pi_bound_${index + 1}`,
      key: `PIBOUND-${index + 1}`,
    }));
    await appEnv.DB.batch(tasks.map((item, index) => appEnv.DB.prepare(
      `INSERT INTO tasks (id, project_id, key, title, status, priority, "order")
       VALUES (?, ?, ?, ?, 'todo', 2, ?)`,
    ).bind(item.id, projectId, item.key, `Bounded task ${index + 1}`, index)));

    let assemblies = 0;
    const result = await getDispatchIntelligence(appEnv, projectId, {
      taskId: tasks[0]!.id,
      executorMode: 'copilot',
    }, {
      assemble: async (...args) => {
        assemblies++;
        return assembleContextPack(...args);
      },
    });

    expect(assemblies).toBe(1);
    expect(result.current.readiness).toMatchObject({
      taskId: tasks[0]!.id,
      primary: 'ready',
    });
    expect(result.current.coverage.reasons).not.toContain(expect.stringMatching(/SQL|variable/i));
  });

  it('preserves derived failed status and retry readiness in the full packet (PLNR-514)', async () => {
    const projectId = (await mcpCall(owner.apiKey, 'create_project', {
      key: 'PIFAIL', name: 'Failed dispatch intelligence',
    })).body.id as string;
    const taskId = (await mcpCall(owner.apiKey, 'create_task', {
      projectId, title: 'Retry through an IDE Copilot', tags: ['analytics-test'],
    })).body.id as string;
    const failedAt = '2026-08-14T00:00:00.000Z';
    await appEnv.DB.prepare("UPDATE tasks SET failed_at = ? WHERE id = ? AND status = 'todo'")
      .bind(failedAt, taskId).run();

    const full = await mcpCall(owner.apiKey, 'get_task_intelligence', {
      projectId, taskId, executorMode: 'copilot',
    });
    expect(full.isError).toBe(false);
    expect(full.body.current.readiness).toMatchObject({
      taskId, status: 'failed', primary: 'ready',
      claimability: { claimable: true, reasonCode: 'claimable' },
      reason: expect.stringMatching(/failed work is ready for retry/),
    });
    expect(await appEnv.DB.prepare('SELECT status, failed_at AS failedAt FROM tasks WHERE id = ?')
      .bind(taskId).first()).toEqual({ status: 'todo', failedAt });
  });

  it('serves a validated executor-aware packet and bounded summary to MCP Copilots', async () => {
    const projectId = (await mcpCall(owner.apiKey, 'create_project', {
      key: 'PICOP', name: 'Copilot intelligence',
    })).body.id as string;
    const taskId = (await mcpCall(owner.apiKey, 'create_task', {
      projectId, title: 'Build through an IDE Copilot', tags: ['analytics-test'],
      executionSpec: {
        anticipatedFiles: [{ path: 'apps/api/src/mcp.ts', change: 'modify', why: 'expose intelligence' }],
      },
    })).body.id as string;
    await appEnv.DB.prepare(
      `INSERT INTO project_repositories (id, project_id, repository_key, created_at)
       VALUES ('prp_picop', ?, 'noriq', datetime('now'))`,
    ).bind(projectId).run();

    const full = await mcpCall(owner.apiKey, 'get_task_intelligence', {
      projectId, taskId, executorMode: 'copilot', repositoryKey: 'noriq', branch: 'main', baseId: 'copilot-base',
    });
    expect(full.isError).toBe(false);
    expect(full.body).toMatchObject({
      advisory: true,
      targetContext: { taskId, executorMode: 'copilot', repositoryKey: 'noriq', repositoryResolutionReason: null },
      current: { readiness: { primary: 'ready' } },
    });

    const context = await mcpCall(owner.apiKey, 'get_task_context', {
      projectId, taskId, repositoryKey: 'noriq', branch: 'main', baseId: 'copilot-base', budgetTokens: 500,
    });
    expect(context.isError).toBe(false);
    expect(context.body.intelligenceSummary).toMatchObject({
      advisory: true, available: true, executorMode: 'copilot',
      repository: { key: 'noriq', reason: null },
      readiness: { taskId, primary: 'ready' },
      fullPacketTool: 'get_task_context',
      documents: { linkedProjectCount: 0, planLocalCount: 0, metadataOnly: true },
    });
    expect(context.body.intelligenceSummary).not.toHaveProperty('quotedEvidence');

    const unregistered = await mcpCall(owner.apiKey, 'get_task_intelligence', {
      projectId, taskId, executorMode: 'copilot', repositoryKey: 'not-this-project',
    });
    expect(unregistered.isError).toBe(false);
    expect(unregistered.body.targetContext).toMatchObject({
      repositoryKey: null, repositoryResolutionReason: 'repository key is not registered to this project',
    });
  });

  it('reuses the MCP context pack and exposes identical complete document metadata in full detail', async () => {
    const projectId = (await mcpCall(owner.apiKey, 'create_project', {
      key: 'PIDOCS', name: 'Dispatch document intelligence',
    })).body.id as string;
    const linked = await mcpCall(owner.apiKey, 'create_doc', {
      projectId, name: 'Settled dispatch architecture', description: 'Required architecture',
      body: 'The full settled body stays behind get_doc.', tags: ['analytics-test'],
    });
    const task = await mcpCall(owner.apiKey, 'create_task', {
      projectId, title: 'Enrich dispatch document context', tags: ['analytics-test'], docIds: [linked.body.id],
    });
    const plan = await mcpCall(owner.apiKey, 'create_plan', {
      projectId, title: 'Document rollout', phases: [{ title: 'Compose', taskIds: [task.body.id] }],
    });
    const planDoc = await mcpCall(owner.apiKey, 'create_plan_doc', {
      projectId, planId: plan.body.id, name: 'Working rollout notes',
      description: 'Provisional plan notes', body: 'The provisional body stays behind get_plan_doc.',
    });

    const restPacket = await getDispatchIntelligence(appEnv, projectId, { taskId: task.body.id as string });
    const full = await mcpCall(owner.apiKey, 'get_task_context', {
      projectId, taskId: task.body.id, intelligenceDetail: 'full', budgetTokens: 8_000,
    });
    expect(full.isError).toBe(false);
    expect(full.body.intelligence.version).toBe('dispatch-intelligence-v2');
    expect(full.body.intelligence.documents).toEqual(restPacket.documents);
    expect(full.body.intelligence.documents).toMatchObject({
      kind: 'metadata_only_document_context', bodiesIncluded: false,
      linkedProjectDocuments: [expect.objectContaining({ id: linked.body.id, relationship: 'task_link' })],
      planLocalDocuments: [expect.objectContaining({
        id: planDoc.body.id, relationship: 'plan_membership', provisional: true,
      })],
    });
    expect(JSON.stringify(full.body.intelligence.documents)).not.toContain('full settled body');
    expect(JSON.stringify(full.body.intelligence.documents)).not.toContain('provisional body');
  });

  it('loads an explicitly opened completed task outside the bounded open-task inventory', async () => {
    const projectId = (await mcpCall(owner.apiKey, 'create_project', {
      key: 'PIDONE', name: 'Completed dispatch intelligence',
    })).body.id as string;
    const created = await mcpCall(owner.apiKey, 'create_task', {
      projectId, title: 'Inspect completed mobile fix', tags: ['analytics-test'],
      executionSpec: {
        anticipatedFiles: [{ path: 'apps/web/src/components/Drawer.tsx', change: 'modify', why: 'mobile fix' }],
      },
    });
    const taskId = created.body.id as string;
    const taskKey = created.body.key as string;
    await appEnv.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").bind(taskId).run();

    const result = await getDispatchIntelligence(appEnv, projectId, { taskId });

    expect(result.current.readiness).toMatchObject({
      taskId, taskKey, status: 'done', primary: 'unknown',
      claimability: { claimable: false, reasonCode: 'status' },
    });
    expect(result.current.coverage.reasons).not.toContain('focus_task_not_supplied');
    expect(result.targetContext.taskId).toBe(taskId);
  });

  it('returns case cards and honest lock uncertainty without writing preview calibration rows', async () => {
    const projectId = (await mcpCall(owner.apiKey, 'create_project', { key: 'PIDISP', name: 'Dispatch intelligence' })).body.id as string;
    const taskId = (await mcpCall(owner.apiKey, 'create_task', {
      projectId, title: 'Repair shared dispatch cache', body: 'Prevent stale dispatch cache reuse.', tags: ['analytics-test'],
      executionSpec: { anticipatedFiles: [{ path: 'apps/api/src/dispatch-cache.ts', change: 'modify', why: 'repair cache' }] },
    })).body.id as string;
    const now = new Date().toISOString();
    for (let index = 1; index <= 3; index++) {
      await memory(projectId).recordEpisode(projectId, {
        runId: `run_dispatch_prior_${index}`, sitting: 1, agentId: null, runKind: 'build', outcome: index === 1 ? 'failed' : 'done',
        startedAt: now, finishedAt: now, taskId, taskTitle: `Repair shared dispatch cache attempt ${index}`,
        repositoryKey: null, baseId: null, timeline: [], filesTouched: ['apps/api/src/dispatch-cache.ts'], commands: [], testsRun: [],
        failures: index === 1 ? ['stale dispatch cache reused'] : [], findings: [{ summary: 'shared dispatch cache repair' }],
        reviewRounds: index, tokenUsage: {}, costUSD: 0, acceptanceCoverage: null, steeringEvents: [],
        landingOutcome: index === 1 ? 'failed' : 'landed', remainingWork: [],
        selfSummary: { approachSummary: `repair shared dispatch cache approach ${index}`, rejectedHypotheses: [], durableLearnings: [], unresolvedQuestions: [] },
        actor: { kind: 'system', id: null },
      });
    }
    await memory(projectId).reconcile(projectId);
    const before = await appEnv.DB.prepare('SELECT COUNT(*) AS count FROM similar_effort_occurrences WHERE project_id = ?')
      .bind(projectId).first<{ count: number }>();
    const result = await getDispatchIntelligence(appEnv, projectId, {
      taskId, budget: { maxTokens: 1000, maxUsd: null, maxDurationSeconds: null, maxRounds: null },
    });
    const after = await appEnv.DB.prepare('SELECT COUNT(*) AS count FROM similar_effort_occurrences WHERE project_id = ?')
      .bind(projectId).first<{ count: number }>();
    expect(result).toMatchObject({
      advisory: true, version: 'dispatch-intelligence-v2',
      feedback: { requiresExplicitHumanAction: true, previewCreatesOccurrence: false },
      current: { collisions: { locking: { status: 'unanswerable', enabled: false, current: [] } } },
      targetContext: { repositoryKey: null, repositoryResolutionReason: 'runner checkout context was not supplied' },
    });
    expect(result.current.coverage.reasons).toContain('locking_disabled');
    expect(result.historical.cases).toHaveLength(3);
    expect(result.historical.cases.map((item) => `${item.runId}/${item.sitting}`)).toEqual(expect.arrayContaining([
      'run_dispatch_prior_1/1', 'run_dispatch_prior_2/1', 'run_dispatch_prior_3/1',
    ]));
    expect(result.historical.cases.every((item) => item.retrieval.support.length > 0)).toBe(true);
    expect(after?.count).toBe(before?.count ?? 0);
  });
});

describe('plan dispatch intelligence (PLNR-534)', () => {
  it('aggregates task readiness and attributed metadata-only documents without eager task packs', async () => {
    const projectId = (await mcpCall(owner.apiKey, 'create_project', {
      key: 'PIPLANA', name: 'Plan aggregate intelligence',
    })).body.id as string;
    const linked = await mcpCall(owner.apiKey, 'create_doc', {
      projectId, name: 'Shared dispatch contract', description: 'Settled shared contract',
      body: 'Full settled content', tags: ['analytics-test'],
    });
    const first = await mcpCall(owner.apiKey, 'create_task', {
      projectId, title: 'Prepare dispatch context', tags: ['analytics-test'], docIds: [linked.body.id],
    });
    const second = await mcpCall(owner.apiKey, 'create_task', {
      projectId, title: 'Apply dispatch context', tags: ['analytics-test'], docIds: [linked.body.id],
    });
    const third = await mcpCall(owner.apiKey, 'create_task', {
      projectId, title: 'Verify dispatch context', tags: ['analytics-test'],
    });
    const plan = await mcpCall(owner.apiKey, 'create_plan', {
      projectId, title: 'Context rollout', description: 'Roll out the shared context',
      phases: [
        { title: 'Prepare', taskIds: [first.body.id] },
        { title: 'Apply', taskIds: [second.body.id, third.body.id] },
      ],
    });
    const planDoc = await mcpCall(owner.apiKey, 'create_plan_doc', {
      projectId, planId: plan.body.id, name: 'Rollout scratchpad',
      description: 'Working plan notes', body: 'Full provisional content',
    });
    await appEnv.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").bind(first.body.id).run();
    await appEnv.DB.prepare("UPDATE tasks SET failed_at = '2026-08-18T00:00:00.000Z' WHERE id = ?")
      .bind(third.body.id).run();

    const result = await getPlanDispatchIntelligence(appEnv, projectId, { planId: plan.body.id as string });
    expect(result).toMatchObject({
      advisory: true, version: 'plan-dispatch-intelligence-v1',
      plan: { id: plan.body.id, phaseCount: 2, taskCount: 3 },
      counts: { phases: 2, tasks: 3, settled: 1, claimed: 0, reserved: 0 },
      documents: {
        bodiesIncluded: false,
        planLocal: [expect.objectContaining({ id: planDoc.body.id, provisional: true })],
        linkedProject: [expect.objectContaining({
          id: linked.body.id, totalTaskLinks: 2,
          exampleTaskKeys: expect.arrayContaining([first.body.key, second.body.key]),
        })],
      },
      taskDetail: {
        endpoint: `/api/projects/${projectId}/memory/dispatch-intelligence`,
        instruction: expect.stringMatching(/only when a member task is expanded/i),
      },
    });
    expect(result.taskIndex).toHaveLength(3);
    expect(result.query.chars).toBeLessThanOrEqual(6_000);
    expect(JSON.stringify(result.documents)).not.toContain('Full settled content');
    expect(JSON.stringify(result.documents)).not.toContain('Full provisional content');
  });

  it('keeps a 500-task plan and large document associations below bind limits with visible truncation', async () => {
    const projectId = (await mcpCall(owner.apiKey, 'create_project', {
      key: 'PIPLANB', name: 'Large plan aggregate',
    })).body.id as string;
    const planId = 'pln_pi_large';
    const phaseId = 'phs_pi_large';
    await appEnv.DB.batch([
      appEnv.DB.prepare("INSERT INTO plans (id, project_id, title, description, body, status) VALUES (?, ?, 'Large dispatch plan', 'bounded aggregate', '', 'active')").bind(planId, projectId),
      appEnv.DB.prepare("INSERT INTO phases (id, plan_id, title, body, \"order\") VALUES (?, ?, 'All work', '', 0)").bind(phaseId, planId),
    ]);
    await appEnv.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500)
       INSERT INTO tasks (id, project_id, key, title, status, priority, "order")
       SELECT 'task_pi_large_' || i, ?1, 'PIPLANB-' || i, 'Large member task ' || i, 'todo', 2, i FROM n`,
    ).bind(projectId).run();
    await appEnv.DB.prepare(
      `INSERT INTO phase_tasks (phase_id, task_id)
       SELECT ?1, id FROM tasks WHERE project_id = ?2`,
    ).bind(phaseId, projectId).run();
    await appEnv.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 120)
       INSERT INTO docs (id, project_id, name, description, body)
       SELECT 'doc_pi_large_' || i, ?1, 'Large doc ' || printf('%03d', i), 'metadata ' || i, 'body ' || i FROM n`,
    ).bind(projectId).run();
    await appEnv.DB.prepare(
      `INSERT INTO task_docs (task_id, doc_id)
       SELECT 'task_pi_large_1', id FROM docs WHERE project_id = ?1`,
    ).bind(projectId).run();
    await appEnv.DB.prepare(
      `INSERT OR IGNORE INTO task_docs (task_id, doc_id)
       SELECT id, 'doc_pi_large_1' FROM tasks WHERE project_id = ?1`,
    ).bind(projectId).run();
    await appEnv.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 55)
       INSERT INTO plan_docs (id, plan_id, project_id, name, description, body)
       SELECT 'pdoc_pi_large_' || i, ?1, ?2, 'Working doc ' || printf('%03d', i), 'provisional ' || i, 'body ' || i FROM n`,
    ).bind(planId, projectId).run();

    const result = await getPlanDispatchIntelligence(appEnv, projectId, { planId });
    expect(result.taskIndex).toHaveLength(500);
    expect(result.taskIndexCoverage).toEqual({ limit: 500, total: 500, emitted: 500, omitted: 0, complete: true });
    expect(result.documents.planLocal).toHaveLength(50);
    expect(result.documents.linkedProject).toHaveLength(100);
    expect(result.documents.linkedProject[0]).toMatchObject({ id: 'doc_pi_large_1', totalTaskLinks: 500 });
    expect(result.documents.coverage.planLocal).toMatchObject({ total: 55, omitted: 5 });
    expect(result.documents.coverage.linkedProject).toMatchObject({ total: 120, omitted: 20 });
    expect(result.coverage.reasons).toEqual(expect.arrayContaining(['plan_doc_limit_reached', 'linked_doc_limit_reached']));
  });

  it('reports semantic and memory outages without failing the aggregate', async () => {
    const projectId = (await mcpCall(owner.apiKey, 'create_project', {
      key: 'PIPLANC', name: 'Degraded plan aggregate',
    })).body.id as string;
    const task = await mcpCall(owner.apiKey, 'create_task', {
      projectId, title: 'Degraded aggregate task', tags: ['analytics-test'],
    });
    const plan = await mcpCall(owner.apiKey, 'create_plan', {
      projectId, title: 'Degraded aggregate plan', phases: [{ title: 'Work', taskIds: [task.body.id] }],
    });
    const unavailableMemory = {
      searchProjectMemory: async () => { throw new Error('memory unavailable'); },
    } as unknown as MemoryRpc;
    const result = await getPlanDispatchIntelligence(appEnv, projectId, { planId: plan.body.id as string }, {
      search: async () => { throw new Error('search unavailable'); },
      memory: unavailableMemory as never,
    });
    expect(result.documents.coverage.semantic).toMatchObject({
      mode: null, unavailable: true, emitted: 0, status: 'unavailable', freshness: null,
    });
    expect(result.memory.coverage).toMatchObject({ mode: null, unavailable: true, candidates: 0 });
    expect(result.coverage).toMatchObject({
      status: 'partial', reasons: expect.arrayContaining(['document_retrieval_unavailable', 'project_memory_unavailable']),
    });
  });
});
