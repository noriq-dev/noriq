// P2-B: subject Validity strip shares Review actions via existing REST.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiSubjectFreshness } from '../api';
import { REVIEW_TAB_KEY } from './ReviewInboxChrome';
import { ValidityStrip } from './ValidityStrip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

const freshness = (partial: Partial<ApiSubjectFreshness> = {}): ApiSubjectFreshness => ({
  subjectType: 'task',
  subjectId: 'task_1',
  contentFingerprint: 'fp',
  lastValidatedAt: null,
  matchingValidationId: null,
  causes: [{ code: 'never_validated', severity: 'advisory' }],
  criticalCauses: [],
  impactUnknown: true,
  baselines: null,
  docPins: [],
  ...partial,
});

function mount(props: Partial<Parameters<typeof ValidityStrip>[0]> = {}) {
  const setView = vi.fn();
  act(() => {
    root = createRoot(container);
    root.render(
      <ValidityStrip
        projectId="prj_1"
        subjectType="task"
        subjectId="task_1"
        initialFreshness={freshness()}
        setView={setView}
        {...props}
      />,
    );
  });
  return { setView };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  sessionStorage.clear();
});

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  container.remove();
  vi.restoreAllMocks();
});

describe('ValidityStrip', () => {
  it('renders causes and Validate / Flag / Snooze / Supersede / Open in Review', () => {
    mount();
    const text = container.textContent ?? '';
    expect(text).toContain('Validity');
    expect(text).toContain('NEVER VALIDATED');
    expect(text).toContain('Record evidence');
    expect(text).toContain('Flag');
    expect(text).toContain('Snooze');
    expect(text).toContain('Supersede');
    expect(text).toContain('Open in Review');
  });

  it('requires evidence instead of recording an assertion on click', async () => {
    const record = vi.spyOn(api, 'recordValidation');
    mount();
    const button = [...container.querySelectorAll('button')].find(b => b.textContent === 'Record evidence')!;
    await act(async () => button.click());
    expect(container.querySelector('form[aria-label="Record verification evidence"]')).toBeTruthy();
    expect(record).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Revision checked');
  });

  it('shows claim blockers even when their reminders are suppressed', () => {
    mount({ initialFreshness: freshness({ causes: [], criticalCauses: ['content_changed'] }) });
    expect(container.textContent).toContain('CONTENT CHANGED');
    expect(container.textContent).not.toContain('CURRENT');
  });

  it('Flag opens human_flagged via setReviewCause', async () => {
    const flag = vi.spyOn(api, 'setReviewCause').mockResolvedValue({ ok: true });
    vi.spyOn(api, 'subjectFreshness').mockResolvedValue(freshness({
      causes: [{ code: 'human_flagged', severity: 'advisory' }],
    }));
    mount();
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Flag');
    await act(async () => { btn!.click(); });
    expect(flag).toHaveBeenCalledWith('prj_1', {
      subjectType: 'task',
      subjectId: 'task_1',
      cause: 'human_flagged',
      status: 'open',
    });
  });

  it('Open in Review sets the Validity tab hint', () => {
    const { setView } = mount();
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Open in Review');
    act(() => { btn!.click(); });
    expect(sessionStorage.getItem(REVIEW_TAB_KEY)).toBe('validity');
    expect(setView).toHaveBeenCalledWith('review');
  });

  it('Snooze posts status=snoozed with durationSeconds for the primary cause', async () => {
    const snooze = vi.spyOn(api, 'setReviewCause').mockResolvedValue({
      ok: true,
      snoozedUntil: '2026-10-23T00:00:00.000Z',
    });
    vi.spyOn(api, 'subjectFreshness').mockResolvedValue(freshness({
      causes: [{ code: 'content_changed', severity: 'critical' }],
      criticalCauses: ['content_changed'],
      impactUnknown: false,
    }));
    mount({
      initialFreshness: freshness({
        causes: [{ code: 'content_changed', severity: 'critical' }],
        criticalCauses: ['content_changed'],
        impactUnknown: false,
      }),
    });
    const open = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Snooze…');
    expect(open).toBeTruthy();
    await act(async () => { open!.click(); });
    const oneDay = [...container.querySelectorAll('button')].find((b) => b.textContent === '1d');
    expect(oneDay).toBeTruthy();
    await act(async () => { oneDay!.click(); });
    expect(snooze).toHaveBeenCalledWith('prj_1', {
      subjectType: 'task',
      subjectId: 'task_1',
      cause: 'content_changed',
      status: 'snoozed',
      durationSeconds: 86400,
    });
  });
});

it('lets readers inspect failed evidence history and retry a failed history request', async () => {
  const history = vi.spyOn(api, 'assessmentHistory').mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ limit: 20, overrides: [], assessments: [{
    id: 'asm_failed', subjectType: 'task', subjectId: 'task_1', purpose: 'readiness', outcome: 'failed', scope: 'non_code', summary: 'The proposed requirements contradict the agreed contract.',
    evidence: [{ kind: 'human_review', reference: 'contract section 2', result: 'Acceptance criteria are inconsistent.' }], actorKind: 'human', actorId: 'u1', actorName: 'Reviewer',
    createdAt: '2026-10-26T10:00:00Z', contentFingerprint: 'old', contextFingerprint: 'old', provenance: 'actor_reported',
  }] });
  mount({ canAct: false });
  expect(container.textContent).not.toContain('Record evidence');
  await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Evidence history')!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('offline');
  await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Retry history')!.click());
  expect(history).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain('readiness · failed · Reviewer');
  expect(container.textContent).toContain('Acceptance criteria are inconsistent.');
});
