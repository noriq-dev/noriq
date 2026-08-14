import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiOrchestrationSummary, type ApiOrchestrationTree } from '../api';
import { LineageExplorer, LineagePanel } from './LineagePanel';

let root: Root | null = null;
let container: HTMLDivElement;
const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

const summary: ApiOrchestrationSummary = {
  id: 'orc_1', anchorType: 'task', anchorId: 'task_1', anchorLabel: 'RUN-1 · Lineage',
  rootExecutionId: 'exe_root', status: 'failed', completenessStatus: 'partial',
  completenessMissing: ['events'], completenessReason: 'finish event absent',
  createdByKind: 'runner', createdById: 'runner_1', createdByName: 'Runner',
  nodeCount: 2, liveNodeCount: 0, incompleteNodeCount: 1, relationCount: 1,
  runnerJobId: 'job_1', createdAt: '2026-08-14T00:00:00.000Z',
  updatedAt: '2026-08-14T00:01:00.000Z', finishedAt: '2026-08-14T00:01:00.000Z',
};
const tree: ApiOrchestrationTree = {
  orchestration: summary,
  nodes: [{
    id: 'exe_root', parentExecutionId: null, kind: 'run', role: 'orchestrator', actorKind: 'runner',
    actorId: 'runner_1', actorName: 'Runner', presenceId: null, taskId: 'task_1', taskKey: 'RUN-1',
    taskTitle: 'Lineage', planId: null, planTitle: null, runId: null, sitting: null, stage: null,
    step: null, gateId: null, status: 'failed', completenessStatus: 'partial', completenessMissing: ['events'],
    completenessReason: 'finish event absent', lastRevision: 1, startedAt: summary.createdAt, parkedAt: null,
    finishedAt: summary.finishedAt, outcomeReason: 'review failed', createdAt: summary.createdAt, updatedAt: summary.updatedAt,
  }, {
    id: 'exe_repair', parentExecutionId: 'exe_root', kind: 'stage', role: 'repair', actorKind: 'agent',
    actorId: 'agent_1', actorName: 'Codex', presenceId: null, taskId: 'task_1', taskKey: 'RUN-1',
    taskTitle: 'Lineage', planId: null, planTitle: null, runId: null, sitting: null, stage: 'repair',
    step: null, gateId: null, status: 'succeeded', completenessStatus: 'complete', completenessMissing: [],
    completenessReason: null, lastRevision: 1, startedAt: summary.createdAt, parkedAt: null,
    finishedAt: summary.finishedAt, outcomeReason: null, createdAt: summary.createdAt, updatedAt: summary.updatedAt,
  }],
  rootExecutionIds: ['exe_root'],
  relations: [{ id: 'rel_1', fromExecutionId: 'exe_repair', toExecutionId: 'exe_root', type: 'repairs', metadata: {}, createdAt: summary.updatedAt }],
  timeline: [{ eventId: 'evt_1', executionId: 'exe_root', revision: 1, eventType: 'failed', observedAt: summary.finishedAt!, targetExecutionId: null, reason: 'review failed', metadata: {}, acceptedAt: summary.finishedAt! }],
  timelinePage: { limit: 100, hasMore: false, nextCursor: null },
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove(); root = null; vi.restoreAllMocks();
});

describe('contextual Lineage', () => {
  it('browses lineage and opens a selected canonical node without a standalone route', async () => {
    vi.spyOn(api, 'orchestrations').mockResolvedValue({
      orchestrations: [summary], counts: { active: 0, history: 1, total: 1 },
      page: { limit: 40, hasMore: false, nextCursor: null },
    });
    vi.spyOn(api, 'orchestration').mockResolvedValue(tree);
    const selection = vi.fn();
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    act(() => root!.render(<LineageExplorer projectId="project_1" initialOrchestrationId="orc_1" initialExecutionId="exe_repair" onSelectionChange={selection} />));
    await tick();

    expect(container.textContent).toContain('RUN-1 · Lineage');
    expect(container.textContent).toContain('Incomplete lineage · finish event absent');
    expect(container.querySelector('#lineage-exe_repair')?.getAttribute('data-selected')).not.toBeNull();
    expect(container.textContent).toContain('repairs → RUN-1');
  });

  it('offers the associated Job from a contextual lineage panel', async () => {
    vi.spyOn(api, 'orchestration').mockResolvedValue(tree);
    const openJob = vi.fn();
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    act(() => root!.render(<LineagePanel projectId="project_1" orchestrationId="orc_1" onOpenJob={openJob} />));
    await tick();
    const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Open job')!;
    act(() => button.click());
    expect(openJob).toHaveBeenCalledWith('job_1');
  });
});
