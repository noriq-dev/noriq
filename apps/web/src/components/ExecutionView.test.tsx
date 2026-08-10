import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiExecutionNode, type ApiOrchestrationSummary, type ApiOrchestrationTree } from '../api';
import type { AppStore } from '../store';
import { ExecutionView } from './ExecutionView';

let container: HTMLDivElement;
let root: Root | null = null;
const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

const summary: ApiOrchestrationSummary = {
  id: 'orc_1', anchorType: 'task', anchorId: 'task_1', anchorLabel: 'PLNR-369 · Execution tree',
  rootExecutionId: 'exe_root', status: 'succeeded', completenessStatus: 'complete',
  completenessMissing: [], completenessReason: null, createdByKind: 'copilot', createdById: 'agt_1',
  createdByName: 'Codex', nodeCount: 2, liveNodeCount: 0, incompleteNodeCount: 0,
  createdAt: '2026-08-09T20:00:00.000Z', updatedAt: '2026-08-09T20:02:00.000Z', finishedAt: '2026-08-09T20:02:00.000Z',
};
const node = (input: Partial<ApiExecutionNode> & Pick<ApiExecutionNode, 'id' | 'parentExecutionId' | 'kind'>): ApiExecutionNode => ({
  role: 'worker', actorKind: 'copilot', actorId: 'agt_1', actorName: 'Codex', presenceId: null,
  taskId: 'task_1', taskKey: 'PLNR-369', taskTitle: 'Execution tree', planId: null, planTitle: null,
  runId: null, sitting: null, stage: null, step: null, gateId: null, status: 'succeeded',
  completenessStatus: 'complete', completenessMissing: [], completenessReason: null, lastRevision: 2,
  startedAt: '2026-08-09T20:00:00.000Z', parkedAt: null, finishedAt: '2026-08-09T20:02:00.000Z',
  outcomeReason: null, createdAt: '2026-08-09T20:00:00.000Z', updatedAt: '2026-08-09T20:02:00.000Z',
  ...input,
});
const tree: ApiOrchestrationTree = {
  orchestration: summary,
  nodes: [
    node({ id: 'exe_root', parentExecutionId: null, kind: 'copilot_session', role: 'orchestrator', stage: 'Plan execution' }),
    node({ id: 'exe_child', parentExecutionId: 'exe_root', kind: 'gate', gateId: 'verify', step: 'Verification gate' }),
  ],
  rootExecutionIds: ['exe_root'], relations: [], timeline: [],
  timelinePage: { limit: 100, hasMore: false, nextCursor: null },
};

function mount(search = '') {
  history.replaceState(null, '', `/project/prj_1/executions${search}`);
  vi.spyOn(api, 'orchestrations').mockResolvedValue({
    orchestrations: [summary], counts: { active: 0, history: 1, total: 1 },
    page: { limit: 40, hasMore: false, nextCursor: null },
  });
  vi.spyOn(api, 'orchestration').mockResolvedValue(tree);
  Element.prototype.scrollIntoView = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<ExecutionView store={{ currentPid: 'prj_1' } as AppStore} />));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  vi.restoreAllMocks();
});

describe('execution hierarchy (PLNR-369)', () => {
  it('collapses completed history branches and renders their children only when expanded', async () => {
    mount('?orchestration=orc_1');
    await tick(); await tick();
    expect(container.textContent).toContain('Plan execution');
    expect(container.textContent).not.toContain('Verification gate');

    const expand = container.querySelector<HTMLButtonElement>('button[aria-label="Expand Plan execution"]');
    await act(async () => { expand!.click(); });
    expect(container.textContent).toContain('Verification gate');
  });

  it('opens the server-authored ancestor path for a deep-linked execution', async () => {
    mount('?orchestration=orc_1&execution=exe_child');
    await tick(); await tick();
    expect(container.textContent).toContain('Verification gate');
    expect(api.orchestration).toHaveBeenCalledWith('prj_1', 'orc_1', { timelineLimit: 100 });
  });
});
