// PLNR-229: a cancelled task must not hold a phase — and therefore a plan — open.
//
// The bug was drift, not logic: the server's phase-order gate finishes a phase when every task
// is `done` OR `cancelled`, while this view asked `!== 'done'`. So the server opened phase 2
// while the Plans card kept phase 1 highlighted as active and its progress rail short of full,
// showing the plan blocked on work nobody would ever do. These pin the two halves of the fix —
// the shared predicate, and the active-phase rule that reads it.
import { describe, expect, it } from 'vitest';
import { isSettledTaskStatus } from '@noriq-dev/shared';
import {
  activePhaseIndex,
  PLAN_ARCHIVE_TASK_CANCELLATION_OPTIONS,
  PLAN_DELETE_TASK_DISPOSITION_OPTIONS,
  planDispatchRunCounts,
} from './PlansView';

const PHASES = [{ id: 'ph1' }, { id: 'ph2' }];
const LINKS = [
  { phaseId: 'ph1', taskId: 't1' },
  { phaseId: 'ph1', taskId: 't2' },
  { phaseId: 'ph2', taskId: 't3' },
];
/** Look tasks up the way the component does — through a map that can miss. */
const statuses = (m: Record<string, string>) => (id: string) => m[id];

describe('isSettledTaskStatus (PLNR-229)', () => {
  it('settles done and cancelled — both terminal, neither still owed', () => {
    expect(isSettledTaskStatus('done')).toBe(true);
    expect(isSettledTaskStatus('cancelled')).toBe(true);
  });

  it('leaves every status that still owes work unsettled', () => {
    for (const s of ['todo', 'claimed', 'in_progress', 'blocked', 'review']) {
      expect(isSettledTaskStatus(s)).toBe(false);
    }
  });

  it('does NOT settle `failed` — a gate-failed task is re-armable and still owed', () => {
    expect(isSettledTaskStatus('failed')).toBe(false);
  });

  it('answers for a missing status instead of throwing', () => {
    expect(isSettledTaskStatus(undefined)).toBe(false);
  });
});

describe('activePhaseIndex (PLNR-229)', () => {
  it('advances past a phase whose remaining task was CANCELLED — the bug', () => {
    // Phase 1: one shipped, one abandoned. Nothing is still owed, so phase 2 is active.
    const idx = activePhaseIndex(PHASES, LINKS, statuses({ t1: 'done', t2: 'cancelled', t3: 'todo' }));
    expect(idx).toBe(1);
  });

  it('advances when a whole phase was cancelled outright', () => {
    const idx = activePhaseIndex(PHASES, LINKS, statuses({ t1: 'cancelled', t2: 'cancelled', t3: 'todo' }));
    expect(idx).toBe(1);
  });

  it('still holds at a phase with genuinely unfinished work', () => {
    const idx = activePhaseIndex(PHASES, LINKS, statuses({ t1: 'done', t2: 'in_progress', t3: 'todo' }));
    expect(idx).toBe(0);
  });

  it('holds at a phase whose task is in review — review is not settled', () => {
    // Matches the server: a phase in review has not passed its gate, so phase 2 stays shut.
    const idx = activePhaseIndex(PHASES, LINKS, statuses({ t1: 'done', t2: 'review', t3: 'todo' }));
    expect(idx).toBe(0);
  });

  it('reports -1 when every phase is settled, so a finished plan highlights nothing', () => {
    const idx = activePhaseIndex(PHASES, LINKS, statuses({ t1: 'done', t2: 'cancelled', t3: 'done' }));
    expect(idx).toBe(-1);
  });
});

describe('planDispatchRunCounts (PLNR-477)', () => {
  it('surfaces gated runs separately from failed runs', () => {
    expect(planDispatchRunCounts([
      { taskId: 'g', runId: 'run_g', runStatus: 'gated' },
      { taskId: 'f', runId: 'run_f', runStatus: 'failed' },
      { taskId: 'd', runId: 'run_d', runStatus: 'done' },
      { taskId: 'w', runId: null, runStatus: null },
    ])).toEqual({ waiting: 1, running: 0, done: 1, gated: 1, failed: 1 });
  });
});

describe('plan lifecycle task choices (PLNR-480)', () => {
  it('offers archive-only, open-task cancellation, and all-task cancellation', () => {
    expect(PLAN_ARCHIVE_TASK_CANCELLATION_OPTIONS).toEqual([
      { value: 'none', label: 'Keep task statuses unchanged' },
      { value: 'open', label: 'Cancel open tasks' },
      { value: 'all', label: 'Cancel every associated task' },
    ]);
  });

  it('offers orphan, cancel-and-keep, and permanent deletion when deleting a plan', () => {
    expect(PLAN_DELETE_TASK_DISPOSITION_OPTIONS).toEqual([
      { value: 'orphan', label: 'Keep and orphan tasks' },
      { value: 'cancel', label: 'Cancel and keep tasks' },
      { value: 'delete', label: 'Permanently delete tasks' },
    ]);
  });
});
