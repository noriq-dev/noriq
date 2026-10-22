// PLNR-583: Validity inbox group-by toggle + Supersede… action (no auto-close).
// PLNR-588: Memory tab shares Review chrome without merging authority models.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiEntityReviewInboxItem } from '../api';
import type { AppStore } from '../store';
import { REVIEW_TAB_KEY } from './ReviewInboxChrome';
import { ReviewView } from './ReviewView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

const item = (partial: Partial<ApiEntityReviewInboxItem> & Pick<ApiEntityReviewInboxItem, 'subjectId' | 'subjectType' | 'title' | 'primaryCause'>): ApiEntityReviewInboxItem => ({
  key: null,
  causes: [partial.primaryCause],
  lastValidatedAt: null,
  ageSinceValidationSeconds: null,
  ...partial,
});

const inboxItems: ApiEntityReviewInboxItem[] = [
  item({
    subjectType: 'task',
    subjectId: 'task_old',
    key: 'PLNR-1',
    title: 'Old task needing supersession',
    primaryCause: 'content_changed',
    causes: ['content_changed'],
  }),
  item({
    subjectType: 'plan',
    subjectId: 'plan_a',
    title: 'Drifted plan',
    primaryCause: 'doc_baseline_moved',
    causes: ['doc_baseline_moved'],
  }),
  item({
    subjectType: 'doc',
    subjectId: 'doc_a',
    title: 'Superseded doc',
    primaryCause: 'superseded',
    causes: ['superseded'],
  }),
];

function store(): AppStore {
  return {
    currentPid: 'prj_1',
    permissions: { canManage: true },
    helpers: {
      tasksOf: () => [],
    },
    actions: {
      openTask: vi.fn(),
      setView: vi.fn(),
      moveTask: vi.fn(),
    },
  } as unknown as AppStore;
}

function mockMemoryQueue(overallTotal = 0) {
  return vi.spyOn(api, 'memoryReviewQueue').mockResolvedValue({
    items: [],
    counts: {
      proposed_decision: 0,
      contradiction: 0,
      stale_invalid: 0,
      recent_negative_feedback: 0,
      low_authority: 0,
    },
    overallTotal,
    total: 0,
    offset: 0,
    nextOffset: null,
  });
}

function mockInbox(items = inboxItems) {
  return vi.spyOn(api, 'reviewInbox').mockResolvedValue({
    items,
    counts: {
      content_changed: 1,
      doc_baseline_moved: 1,
      superseded: 1,
    },
    overallTotal: items.length,
    total: items.length,
    offset: 0,
    nextOffset: null,
    groupBy: 'cause',
  });
}

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ReviewView store={store()} />);
  });
  const validity = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Validity'));
  expect(validity).toBeDefined();
  await act(async () => { validity!.click(); });
  await act(async () => { await Promise.resolve(); });
}

const text = () => container.textContent ?? '';
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

beforeEach(() => {
  sessionStorage.clear();
  mockMemoryQueue();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('ReviewView shared chrome', () => {
  it('exposes Work, Validity, and Memory tabs and opens Memory queue under Review', async () => {
    mockInbox();
    const memory = mockMemoryQueue(2);
    memory.mockResolvedValue({
      items: [{
        id: 'mem_1',
        kind: 'decision',
        statement: 'Keep memory authority separate from entity validation.',
        authority: 2,
        validity: 'active',
        recordedAt: '2026-10-22T00:00:00.000Z',
        recordedByAgentId: 'agt_1',
        proposedAt: '2026-10-22T00:00:00.000Z',
        repositoryKey: null,
        branch: null,
        baseId: null,
        reasons: ['proposed_decision', 'low_authority'],
        contradictionSetIds: [],
        recentNegativeFeedbackCount: 0,
        latestNegativeFeedbackAt: null,
      }],
      counts: {
        proposed_decision: 1,
        contradiction: 0,
        stale_invalid: 0,
        recent_negative_feedback: 0,
        low_authority: 1,
      },
      overallTotal: 2,
      total: 1,
      offset: 0,
      nextOffset: null,
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<ReviewView store={store()} />); });
    await act(async () => { await Promise.resolve(); });

    expect(text()).toContain('Work review');
    expect(text()).toContain('Validity');
    expect(text()).toMatch(/Memory\s*·\s*2/);

    const memoryTab = [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Memory'));
    expect(memoryTab).toBeDefined();
    await act(async () => { memoryTab!.click(); });
    await act(async () => { await Promise.resolve(); });

    expect(text()).toContain('Memory review · 2');
    expect(text()).toContain('Same Review chrome as Validity');
    expect(text()).toContain('Keep memory authority separate from entity validation.');
    expect(text()).toContain('Proposed decisions');
    expect(text()).toContain('Approve decision');
    expect(memory).toHaveBeenCalled();
  });

  it('honors noriq.reviewTab=memory as the initial Review shell tab', async () => {
    mockInbox();
    sessionStorage.setItem(REVIEW_TAB_KEY, 'memory');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<ReviewView store={store()} />); });
    await act(async () => { await Promise.resolve(); });

    expect(text()).toContain('Memory review');
    expect(sessionStorage.getItem(REVIEW_TAB_KEY)).toBeNull();
  });
});

describe('ReviewView Validity inbox', () => {
  it('defaults to group-by-cause and toggles to entity type sections', async () => {
    const review = mockInbox();
    await mount();

    expect(review).toHaveBeenCalledWith('prj_1', expect.objectContaining({ groupBy: 'cause' }));
    expect(button('By cause')?.getAttribute('aria-pressed')).toBe('true');
    expect(text()).toContain('Content changed');
    expect(text()).toContain('Old task needing supersession');

    await act(async () => { button('By entity type')!.click(); });
    await act(async () => { await Promise.resolve(); });

    expect(review).toHaveBeenCalledWith('prj_1', expect.objectContaining({ groupBy: 'entity' }));
    expect(button('By entity type')?.getAttribute('aria-pressed')).toBe('true');
    expect(text()).toMatch(/Tasks\s*·\s*1/);
    expect(text()).toMatch(/Plans\s*·\s*1/);
    expect(text()).toMatch(/Docs\s*·\s*1/);
  });

  it('wires Supersede… to setSupersedes without inventing auto-close', async () => {
    mockInbox([inboxItems[0]!]);
    const supersede = vi.spyOn(api, 'setSupersedes').mockResolvedValue({ ok: true });
    vi.spyOn(api, 'searchTasks').mockResolvedValue({
      tasks: [{
        id: 'task_new',
        key: 'PLNR-2',
        title: 'Replacement task',
        status: 'todo',
        priority: 2,
        type: 'feature',
        projectId: 'prj_1',
        projectKey: 'PLNR',
        boardId: 'board_1',
        updatedAt: '2026-10-22T00:00:00.000Z',
      }],
      matched: 1,
      returned: 1,
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const s = store();
    const moveTask = s.actions.moveTask as unknown as ReturnType<typeof vi.fn>;
    await act(async () => { root!.render(<ReviewView store={s} />); });
    const validity = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Validity'));
    await act(async () => { validity!.click(); });
    await act(async () => { await Promise.resolve(); });

    await act(async () => { button('Supersede…')!.click(); });
    expect(text()).toContain('new current');
    expect(text()).toContain('status is not auto-closed');

    const input = container.querySelector<HTMLInputElement>('[role="combobox"]');
    expect(input).toBeTruthy();
    await act(async () => {
      input!.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input!, 'PLNR-2');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 220)); });

    const option = container.querySelector<HTMLElement>('[role="option"]');
    expect(option?.textContent).toContain('PLNR-2');
    await act(async () => { option!.click(); });
    await act(async () => { button('link supersedes')!.click(); });
    await act(async () => { await Promise.resolve(); });

    expect(supersede).toHaveBeenCalledWith('prj_1', {
      subjectType: 'task',
      subjectId: 'task_new',
      priorId: 'task_old',
    });
    expect(moveTask).not.toHaveBeenCalled();
  });

  it('keeps a multi-cause subject under a non-primary cause filter', async () => {
    // Codex P2: primaryCause=content_changed but causes also includes doc_baseline_moved —
    // filtering "Doc pin drifted" must still render the subject (badge vs blank list).
    const multi = item({
      subjectType: 'task',
      subjectId: 'task_multi',
      key: 'PLNR-9',
      title: 'Multi-cause subject',
      primaryCause: 'content_changed',
      causes: ['content_changed', 'doc_baseline_moved'],
    });
    vi.spyOn(api, 'reviewInbox').mockImplementation(async (_pid, opts) => {
      const cause = opts?.cause;
      const items = !cause || multi.causes.includes(cause) ? [multi] : [];
      return {
        items,
        counts: {
          content_changed: 1,
          doc_baseline_moved: 1,
        },
        overallTotal: 1,
        total: items.length,
        offset: 0,
        nextOffset: null,
        groupBy: 'cause',
      };
    });
    await mount();

    expect(text()).toContain('Multi-cause subject');
    expect(text()).toContain('Content changed');
    expect(text()).toContain('Doc pin drifted');

    const docPinChip = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Doc pin drifted'),
    );
    expect(docPinChip).toBeDefined();
    await act(async () => { docPinChip!.click(); });
    await act(async () => { await Promise.resolve(); });

    expect(text()).toContain('Multi-cause subject');
    expect(text()).not.toContain('nothing needs validity review');
  });

  it('keeps mark validated and dismiss cause actions', async () => {
    mockInbox([inboxItems[0]!]);
    const validate = vi.spyOn(api, 'recordValidation').mockResolvedValue({
      id: 'val_1',
      projectId: 'prj_1',
      subjectType: 'task',
      subjectId: 'task_old',
      contentFingerprint: 'fp',
      validatedAt: '2026-10-22T00:00:00.000Z',
      actorKind: 'human',
      actorId: 'u_1',
      actorName: 'Montana',
      baselines: { docPins: [], codeAssessments: [] },
      note: '',
    });
    const dismiss = vi.spyOn(api, 'setReviewCause').mockResolvedValue({ ok: true });
    await mount();

    await act(async () => { button('mark validated')!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(validate).toHaveBeenCalledWith('prj_1', { subjectType: 'task', subjectId: 'task_old' });

    await act(async () => { button('dismiss cause')!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(dismiss).toHaveBeenCalledWith('prj_1', {
      subjectType: 'task',
      subjectId: 'task_old',
      cause: 'content_changed',
      status: 'dismissed',
    });
  });
});
