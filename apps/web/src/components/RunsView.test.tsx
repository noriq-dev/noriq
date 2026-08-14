import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiRunner, type ApiRunnerJobActivityPage, type ApiRunnerJobActivityStage, type ApiRunnerJobOutput, type ApiRunnerJobSummary } from '../api';
import type { AppStore } from '../store';
import { hasMeaningfulLineage, JOB_STATUS_STYLE, JobActivity, RUN_STATUS_STYLE, runnerJobCostLabel, RunnerJobDispatchForm, RunnerJobOutputSummary } from './RunsView';

let container: HTMLDivElement;
let root: Root | null = null;

const runner = {
  id: 'runner_1', projectId: 'project_1', label: 'Runner one', status: 'online',
  capabilities: { tools: [], kinds: [], maxConcurrency: 1 }, freeSlots: 1,
  repos: [{
    id: 'repo_1', projectKey: 'RUN', projectId: 'project_1', board: null, boardId: null,
    name: 'Repository', defaultBranch: 'main', workflows: [], baseRevision: 'a'.repeat(40),
  }],
  lastHeartbeatAt: null, offboardedAt: null, version: null, createdAt: '2026-08-13T00:00:00.000Z',
} satisfies ApiRunner;

const store = {
  currentPid: 'project_1',
  snapshot: { plans: [] },
  helpers: { allTasksOf: () => [] },
} as unknown as AppStore;

function renderDispatchForm() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const onDone = vi.fn().mockResolvedValue(undefined);
  act(() => root!.render(<RunnerJobDispatchForm store={store} runners={[runner]} onDone={onDone} />));
  return onDone;
}

function inputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const activityTiming: ApiRunnerJobActivityPage['timing'] = {
  runner: { startedAt: '2026-08-13T00:00:00.000Z', finishedAt: null },
  server: {
    asOf: '2026-08-13T00:01:00.000Z', commissionedAt: '2026-08-13T00:00:00.000Z',
    workStartedAt: '2026-08-13T00:00:00.000Z', workFinishedAt: null,
    queueMs: 0, elapsedMs: null, humanWaitMs: 0, humanWaitStartedAt: null,
    landing: { requestedAt: null, startedAt: null, finishedAt: null, durationMs: null }, task: null,
  },
};

function activityStage(input: Partial<ApiRunnerJobActivityStage> & Pick<ApiRunnerJobActivityStage, 'id' | 'observationId' | 'stage' | 'attempt' | 'taskId' | 'status' | 'occurredAt'>): ApiRunnerJobActivityStage {
  return {
    kind: 'stage', actor: { kind: 'command', driver: 'git', vendor: null, model: null, effort: null, role: null, operation: 'inspect' },
    startedAt: input.occurredAt, finishedAt: input.status === 'running' ? null : input.occurredAt,
    updatedAt: input.occurredAt, duration: { status: 'complete', value: 10, provenance: 'runner_reported' },
    usage: {
      inputTokens: { status: 'not_applicable', value: null, provenance: 'derived' },
      outputTokens: { status: 'not_applicable', value: null, provenance: 'derived' },
      cacheReadTokens: { status: 'not_applicable', value: null, provenance: 'derived' },
      cacheWriteTokens: { status: 'not_applicable', value: null, provenance: 'derived' },
      calls: { status: 'not_applicable', value: null, provenance: 'derived' },
      costUsd: { status: 'not_applicable', value: null, provenance: 'derived' },
    },
    costBasis: null,
    recovery: 'none', evidence: null, startSeq: 1, finishSeq: 2, cursorSeq: 2,
    ...input,
  };
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('run status presentation (PLNR-477)', () => {
  it('renders gated as an amber decision state, distinct from failed', () => {
    expect(RUN_STATUS_STYLE.gated).toMatchObject({ color: '#f5a623' });
    expect(RUN_STATUS_STYLE.gated).not.toEqual(RUN_STATUS_STYLE.failed);
    expect(RUN_STATUS_STYLE.gated.live).not.toBe(true);
  });
});

describe('RunnerJob status presentation (PLNR-501)', () => {
  it('keeps partial output distinct from both success and failure', () => {
    expect(JOB_STATUS_STYLE.partial).not.toEqual(JOB_STATUS_STYLE.succeeded);
    expect(JOB_STATUS_STYLE.partial).not.toEqual(JOB_STATUS_STYLE.failed);
  });

  it('shows contextual lineage only when it contains useful structure or a completeness warning', () => {
    const base = { orchestrationId: 'orc_1', nodeCount: 1, relationCount: 0, incompleteNodeCount: 0 };
    expect(hasMeaningfulLineage(base)).toBe(false);
    expect(hasMeaningfulLineage({ ...base, nodeCount: 2 })).toBe(true);
    expect(hasMeaningfulLineage({ ...base, relationCount: 1 })).toBe(true);
    expect(hasMeaningfulLineage({ ...base, incompleteNodeCount: 1 })).toBe(true);
  });
});

describe('RunnerJob VCS-neutral output presentation (PLNR-504)', () => {
  it('labels opaque revisions and retained locations without Git-only terms', () => {
    const output = {
      workspaceMode: 'isolated',
      retainedLocation: { vcs: 'perforce', label: 'shelf 184206', url: null },
      baseRevision: '//depot/noriq/main@184205', headRevision: 'shelf:184206',
      acceptedTaskCheckpoints: {}, checks: [], findings: [],
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: null, calls: 0 },
      summary: 'Retained for review', dirtyPaths: [],
    } satisfies ApiRunnerJobOutput;
    const job = {
      landingStatus: 'retained', landingPolicy: 'retain', landingTarget: null, landingError: null,
    } as ApiRunnerJobSummary;
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    act(() => root!.render(<RunnerJobOutputSummary output={output} job={job} />));

    expect(container.textContent).toContain('perforce');
    expect(container.textContent).toContain('shelf 184206');
    expect(container.textContent).toContain('base revision');
    expect(container.textContent).toContain('head revision');
    expect(container.textContent).not.toContain('branch');
    expect(container.textContent).not.toContain('commit');
  });
});

describe('RunnerJob activity timeline', () => {
  it('keeps permanent summary cost labels honest', () => {
    const metric = {
      status: 'partial' as const, value: 0.125, observedCount: 1,
      partialCount: 1, unavailableCount: 0, notApplicableCount: 0,
    };
    expect(runnerJobCostLabel(metric, [{
      kind: 'api_list_estimate',
      priceSource: { provider: 'openai', catalog: 'official-api-list', fetchedAt: '2026-08-13T00:00:00.000Z', ageSeconds: 10, stale: false },
    }])).toBe('≈$0.1250 API-list estimate · partial');
    expect(runnerJobCostLabel({ ...metric, status: 'complete', value: 0.2 }, [{ kind: 'driver_reported' }]))
      .toBe('$0.2000 reported · complete');
    expect(runnerJobCostLabel({ ...metric, status: 'unavailable', value: null }, []))
      .toBe('unavailable');
  });

  it('groups a running stage, replaces it with finish evidence, and pauses without losing the cursor', async () => {
    const base = {
      observationId: 'obs_1', taskId: 'task_1', stage: 'build' as const, attempt: 1,
      actor: {
        kind: 'agent' as const, driver: 'codex', vendor: 'openai', model: 'gpt-test',
        effort: 'medium', role: 'build', operation: 'invoke',
      },
      startedAt: '2026-08-13T00:00:00.000Z', recovery: null,
      evidence: null, startSeq: 2, finishSeq: null,
    };
    const page = (finished: boolean): ApiRunnerJobActivityPage => ({
      items: [{
        ...base,
        kind: 'stage', id: 'stage:obs_1', occurredAt: base.startedAt,
        updatedAt: finished ? '2026-08-13T00:00:01.000Z' : base.startedAt,
        status: finished ? 'succeeded' : 'running',
        finishedAt: finished ? '2026-08-13T00:00:01.000Z' : null,
        duration: finished ? { status: 'complete', value: 1_000, provenance: 'runner_reported' } : null,
        usage: finished ? {
          inputTokens: { status: 'complete', value: 100, provenance: 'driver_reported' },
          outputTokens: { status: 'complete', value: 25, provenance: 'driver_reported' },
          cacheReadTokens: { status: 'unavailable', value: null, provenance: 'not_reported' },
          cacheWriteTokens: { status: 'not_applicable', value: null, provenance: 'derived' },
          calls: { status: 'complete', value: 1, provenance: 'driver_reported' },
          costUsd: { status: 'unavailable', value: null, provenance: 'not_reported' },
        } : null,
        costBasis: null,
        finishSeq: finished ? 3 : null, cursorSeq: finished ? 3 : 2,
      }],
      cursor: { next: finished ? 'cursor_3' : 'cursor_2', hasMore: false },
      scope: { taskId: 'task_1' },
      timing: {
        runner: { startedAt: base.startedAt, finishedAt: finished ? '2026-08-13T00:00:01.000Z' : null },
        server: {
          asOf: '2026-08-13T00:00:01.000Z', commissionedAt: base.startedAt,
          workStartedAt: base.startedAt, workFinishedAt: finished ? '2026-08-13T00:00:01.000Z' : null,
          queueMs: 0, elapsedMs: finished ? 1_000 : null, humanWaitMs: 0, humanWaitStartedAt: null,
          landing: { requestedAt: null, startedAt: null, finishedAt: null, durationMs: null },
          task: { startedAt: base.startedAt, finishedAt: finished ? '2026-08-13T00:00:01.000Z' : null, durationMs: finished ? 1_000 : null },
        },
      },
      partial: !finished, expired: false,
    });
    const observations = vi.spyOn(api, 'runnerJobActivity')
      .mockResolvedValueOnce(page(false)).mockResolvedValue(page(true));
    vi.spyOn(api, 'runnerJobIntelligence').mockResolvedValue({
      state: 'pending', status: 'running', projectedAt: null, detailPrunedAt: null,
      job: null, tasks: [],
    });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    act(() => root!.render(<JobActivity
      projectId="project_1"
      jobId="job_1"
      items={[{
        taskId: 'task_1', taskKey: 'RUN-1', phaseOrder: 0, taskOrder: 0, status: 'running',
        phase: 'building', progress: 0.5, phaseUpdatedAt: base.startedAt,
        plan: null, checkpointRef: null, summary: null, findings: [], projectionConflict: null,
        startedAt: base.startedAt, finishedAt: null, updatedAt: base.startedAt,
      }]}
      terminal={false}
    />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('running');
    expect(container.textContent).toContain('usage not reported');

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(container.querySelectorAll('.runner-activity-stage')).toHaveLength(1);
    expect(container.textContent).toContain('succeeded');
    expect(container.textContent).toContain('125 tokens');
    const follow = [...container.querySelectorAll('button')].find((button) => button.textContent === 'following')!;
    act(() => follow.click());
    const calls = observations.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(observations).toHaveBeenCalledTimes(calls);
  });

  it('nests job overhead and tasks beneath chronological stage attempts without rendering irrelevant metrics', async () => {
    vi.spyOn(api, 'runnerJobActivity').mockResolvedValue({
      items: [{
        kind: 'milestone', id: 'job:commissioned', type: 'commissioned', status: 'succeeded',
        occurredAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.000Z',
        taskId: null, title: 'Job commissioned', detail: null, cursorSeq: null,
      },
      activityStage({ id: 'stage:finalize-job', observationId: 'finalize-job', stage: 'finalize', attempt: 1, taskId: null, status: 'succeeded', occurredAt: '2026-08-13T00:00:01.000Z' }),
      activityStage({ id: 'stage:finalize-task', observationId: 'finalize-task', stage: 'finalize', attempt: 1, taskId: 'task_1', status: 'succeeded', occurredAt: '2026-08-13T00:00:02.000Z' }),
      activityStage({ id: 'stage:review-1', observationId: 'review-1', stage: 'review', attempt: 1, taskId: 'task_1', status: 'succeeded', occurredAt: '2026-08-13T00:00:03.000Z' }),
      { kind: 'milestone', id: 'event:warning', type: 'warning', status: 'warning', occurredAt: '2026-08-13T00:00:04.000Z', updatedAt: '2026-08-13T00:00:04.000Z', taskId: null, title: 'Review retry', detail: 'One more pass', cursorSeq: 7 },
      activityStage({ id: 'stage:review-2', observationId: 'review-2', stage: 'review', attempt: 2, taskId: 'task_1', status: 'running', occurredAt: '2026-08-13T00:00:05.000Z' })],
      cursor: { next: 'cursor_7', hasMore: false }, scope: { taskId: null }, timing: activityTiming,
      partial: true, expired: false,
    });
    vi.spyOn(api, 'runnerJobIntelligence').mockResolvedValue({ state: 'pending', status: 'running', projectedAt: null, detailPrunedAt: null, job: null, tasks: [] });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    act(() => root!.render(<JobActivity projectId="project_1" jobId="job_1" items={[{
      taskId: 'task_1', taskKey: 'RUN-1', phaseOrder: 0, taskOrder: 0, status: 'running', plan: null,
      phase: null, progress: null, phaseUpdatedAt: null,
      checkpointRef: null, summary: null, findings: [], projectionConflict: null, startedAt: null,
      finishedAt: null, updatedAt: '2026-08-13T00:00:00.000Z',
    }]} terminal={false} />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const stages = [...container.querySelectorAll<HTMLElement>('.runner-activity-stage')];
    expect(stages).toHaveLength(3);
    expect(stages[0]!.textContent).toContain('finalizeattempt 12 operations · 1 task');
    expect(stages[1]!.textContent).toContain('reviewattempt 1');
    expect(stages[2]!.textContent).toContain('reviewattempt 2');
    expect(container.textContent).not.toContain('not applicable');
    act(() => stages[0]!.querySelector<HTMLButtonElement>('button')!.click());
    expect(stages[0]!.textContent).toContain('Job overhead');
    expect(stages[0]!.textContent).toContain('RUN-1');
    expect(stages[2]!.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('labels adaptive routes and reported, estimated, stale, and unavailable cost truthfully', async () => {
    const route = {
      taskId: 'task_1', role: 'build', attempt: 1, policyVersion: 'adaptive-v2',
      size: 'tiny' as const, risk: 'high' as const, specCoverage: 'complete' as const,
      reasons: ['risk.high'], candidateCount: 2, eligibleCount: 1, decision: 'invoke' as const,
      actor: {
        kind: 'agent' as const, driver: 'codex', vendor: 'openai', model: 'gpt-5.6-codex',
        effort: 'high', role: 'build', operation: 'invoke',
      },
    };
    const codex = activityStage({
      id: 'stage:codex', observationId: 'codex', stage: 'build', attempt: 1,
      taskId: 'task_1', status: 'succeeded', occurredAt: '2026-08-13T00:00:01.000Z',
      actor: route.actor,
      usage: {
        inputTokens: { status: 'complete', value: 100, provenance: 'driver_reported' },
        outputTokens: { status: 'complete', value: 25, provenance: 'driver_reported' },
        cacheReadTokens: { status: 'unavailable', value: null, provenance: 'not_reported' },
        cacheWriteTokens: { status: 'not_applicable', value: null, provenance: 'derived' },
        calls: { status: 'complete', value: 1, provenance: 'driver_reported' },
        costUsd: { status: 'partial', value: 0.125, provenance: 'derived' },
      },
      costBasis: {
        kind: 'api_list_estimate',
        priceSource: {
          provider: 'openai', catalog: 'official-api-list', fetchedAt: '2026-08-12T22:00:00.000Z',
          ageSeconds: 7_200, stale: true,
        },
      },
    });
    const claude = activityStage({
      id: 'stage:claude', observationId: 'claude', stage: 'review', attempt: 1,
      taskId: 'task_1', status: 'succeeded', occurredAt: '2026-08-13T00:00:02.000Z',
      actor: {
        kind: 'agent', driver: 'claude', vendor: 'anthropic', model: 'claude-opus',
        effort: 'high', role: 'review', operation: 'invoke',
      },
      usage: {
        inputTokens: { status: 'complete', value: 80, provenance: 'driver_reported' },
        outputTokens: { status: 'complete', value: 20, provenance: 'driver_reported' },
        cacheReadTokens: { status: 'unavailable', value: null, provenance: 'not_reported' },
        cacheWriteTokens: { status: 'not_applicable', value: null, provenance: 'derived' },
        calls: { status: 'complete', value: 1, provenance: 'driver_reported' },
        costUsd: { status: 'complete', value: 0.2, provenance: 'driver_reported' },
      },
      costBasis: { kind: 'driver_reported' },
    });
    const unavailable = activityStage({
      id: 'stage:missing', observationId: 'missing', stage: 'check', attempt: 1,
      taskId: 'task_1', status: 'succeeded', occurredAt: '2026-08-13T00:00:03.000Z',
      usage: {
        inputTokens: { status: 'unavailable', value: null, provenance: 'not_reported' },
        outputTokens: { status: 'unavailable', value: null, provenance: 'not_reported' },
        cacheReadTokens: { status: 'unavailable', value: null, provenance: 'not_reported' },
        cacheWriteTokens: { status: 'unavailable', value: null, provenance: 'not_reported' },
        calls: { status: 'unavailable', value: null, provenance: 'not_reported' },
        costUsd: { status: 'unavailable', value: null, provenance: 'not_reported' },
      },
    });
    vi.spyOn(api, 'runnerJobActivity').mockResolvedValue({
      items: [{
        kind: 'milestone', id: 'event:route', type: 'agent_route', status: 'succeeded',
        occurredAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.000Z',
        taskId: 'task_1', title: 'Agent route selected', detail: null, cursorSeq: 1, route,
      }, codex, claude, unavailable],
      cursor: { next: 'cursor_4', hasMore: false }, scope: { taskId: null }, timing: activityTiming,
      partial: false, expired: false,
    });
    vi.spyOn(api, 'runnerJobIntelligence').mockResolvedValue({
      state: 'pending', status: 'succeeded', projectedAt: null, detailPrunedAt: null, job: null, tasks: [],
    });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    act(() => root!.render(<JobActivity projectId="project_1" jobId="job_1" items={[{
      taskId: 'task_1', taskKey: 'RUN-1', phaseOrder: 0, taskOrder: 0, status: 'accepted',
      phase: 'building', progress: 0.4, phaseUpdatedAt: '2026-08-13T00:00:00.000Z',
      plan: null, checkpointRef: null, summary: null, findings: [], projectionConflict: null,
      startedAt: null, finishedAt: null, updatedAt: '2026-08-13T00:00:00.000Z',
    }]} terminal />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    for (const stage of container.querySelectorAll<HTMLElement>('.runner-activity-stage')) {
      act(() => stage.querySelector<HTMLButtonElement>('button')!.click());
    }

    expect(container.textContent).toContain('gpt-5.6-codex · high · tiny · high risk · complete spec · adaptive-v2');
    expect(container.textContent).toContain('RUN-1 · building 40%');
    expect(container.textContent).toContain('≈$0.1250 API-list estimate');
    expect(container.textContent).toContain('openai official-api-list · 2h old · stale · partial');
    expect(container.textContent).toContain('$0.2000 reported · complete');
    expect(container.textContent).toContain('cost unavailable');
    expect(container.textContent).not.toContain('$0.0000');
  });
});

describe('RunnerJob dispatch target search', () => {
  it('dispatches a searched task even when the Runs snapshot contains no tasks', async () => {
    const task = {
      id: 'task_1', key: 'RUN-508', title: 'Find me remotely', status: 'todo', priority: 1, type: 'bug',
      projectId: 'project_1', projectKey: 'RUN', boardId: null, updatedAt: '2026-08-13T00:00:00.000Z',
    };
    vi.spyOn(api, 'searchTasks').mockImplementation(async (input) => ({
      tasks: input.status === 'todo' ? [task] : [], matched: input.status === 'todo' ? 1 : 0, returned: input.status === 'todo' ? 1 : 0,
    }));
    const dispatch = vi.spyOn(api, 'dispatchTaskJob').mockResolvedValue({ job: { id: 'job_1' } as never, delivered: true });
    const onDone = renderDispatchForm();

    const input = container.querySelector<HTMLInputElement>('[aria-label="Task"]')!;
    act(() => input.focus());
    act(() => inputValue(input, 'RUN-508'));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    act(() => container.querySelector<HTMLElement>('[role="option"]')!.click());
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.includes('dispatch task'))!.click();
    });

    expect(dispatch).toHaveBeenCalledWith('project_1', 'task_1', { runnerId: 'runner_1', repoRef: 'repo_1' });
    expect(onDone).toHaveBeenCalledWith('job_1');
  });

  it('makes a failed-task retry explicit and surfaces a commissioning rejection', async () => {
    const task = {
      id: 'task_failed', key: 'RUN-513', title: 'Retry me', status: 'failed', priority: 1, type: 'bug',
      projectId: 'project_1', projectKey: 'RUN', boardId: null, updatedAt: '2026-08-13T00:00:00.000Z',
    };
    vi.spyOn(api, 'searchTasks').mockImplementation(async (input) => ({
      tasks: input.status === 'failed' ? [task] : [], matched: input.status === 'failed' ? 1 : 0, returned: input.status === 'failed' ? 1 : 0,
    }));
    const dispatch = vi.spyOn(api, 'dispatchTaskJob').mockRejectedValue(new Error('selected tasks have live claims: RUN-513'));
    const onDone = renderDispatchForm();

    const input = container.querySelector<HTMLInputElement>('[aria-label="Task"]')!;
    act(() => input.focus());
    act(() => inputValue(input, 'RUN-513'));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    act(() => container.querySelector<HTMLElement>('[role="option"]')!.click());
    expect(container.textContent).toContain('Retry creates a fresh RunnerJob');
    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'retry task')!;
    await act(async () => { retry.click(); });

    expect(dispatch).toHaveBeenCalledWith('project_1', 'task_failed', { runnerId: 'runner_1', repoRef: 'repo_1' });
    expect(container.textContent).toContain('selected tasks have live claims: RUN-513');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('dispatches a searched plan even when the Runs snapshot contains no plans', async () => {
    const plan = {
      id: 'plan_1', title: 'Remote plan', description: 'Not in the snapshot', status: 'active',
      projectId: 'project_1', projectKey: 'RUN', createdAt: '2026-08-13T00:00:00.000Z',
    };
    vi.spyOn(api, 'searchPlans').mockResolvedValue({ plans: [plan], matched: 1, returned: 1 });
    const dispatch = vi.spyOn(api, 'dispatchPlanJob').mockResolvedValue({ job: { id: 'job_2' } as never, delivered: true });
    const onDone = renderDispatchForm();

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="source"]')!.click());
    const planKind = [...container.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent?.includes('entire plan'))!;
    act(() => planKind.click());
    const input = container.querySelector<HTMLInputElement>('[aria-label="Plan"]')!;
    act(() => input.focus());
    act(() => inputValue(input, 'Remote'));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    act(() => container.querySelector<HTMLElement>('[role="option"]')!.click());
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.includes('dispatch plan'))!.click();
    });

    expect(dispatch).toHaveBeenCalledWith('project_1', 'plan_1', { runnerId: 'runner_1', repoRef: 'repo_1' });
    expect(onDone).toHaveBeenCalledWith('job_2');
  });
});
