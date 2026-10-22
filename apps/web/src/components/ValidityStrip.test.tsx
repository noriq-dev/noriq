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
    expect(text).toContain('Validate');
    expect(text).toContain('Flag');
    expect(text).toContain('Snooze');
    expect(text).toContain('Supersede');
    expect(text).toContain('Open in Review');
  });

  it('Validate posts a validation record then refreshes freshness', async () => {
    const record = vi.spyOn(api, 'recordValidation').mockResolvedValue({
      id: 'val_1',
      projectId: 'prj_1',
      subjectType: 'task',
      subjectId: 'task_1',
      contentFingerprint: 'fp',
      validatedAt: '2026-10-22T00:00:00.000Z',
      actorKind: 'human',
      actorId: 'u1',
      actorName: 'Human',
      baselines: { docPins: [], codeAssessments: [] },
      note: '',
    });
    const load = vi.spyOn(api, 'subjectFreshness').mockResolvedValue(freshness({
      lastValidatedAt: '2026-10-22T00:00:00.000Z',
      causes: [],
      impactUnknown: false,
    }));
    mount();
    const validate = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Validate');
    expect(validate).toBeTruthy();
    await act(async () => { validate!.click(); });
    expect(record).toHaveBeenCalledWith('prj_1', { subjectType: 'task', subjectId: 'task_1' });
    expect(load).toHaveBeenCalled();
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
