import { describe, expect, it } from 'vitest';
import type { ApiSnapshot } from './api';
import { eventToVM } from './store';

function event(verb: string): ApiSnapshot['events'][number] {
  return {
    id: `evt_${verb}`,
    seq: 1,
    actorKind: 'agent',
    actorId: 'agt_1',
    verb,
    subjectType: 'task',
    subjectId: 'task_1',
    payload: { key: 'PLNR-1', title: 'Follow-up', sourceTaskKey: 'PLNR-0' },
    createdAt: '2026-08-14T12:00:00.000Z',
  };
}

describe('proposal event compatibility', () => {
  it('renders new generic proposal lifecycle events', () => {
    expect(eventToVM(event('task.proposed'))).toMatchObject({
      verb: 'proposal', subject: 'proposed PLNR-1 · Follow-up (found in PLNR-0)', taskId: 'task_1',
    });
    expect(eventToVM(event('task.proposal_accepted')).verb).toBe('proposal ✓');
    expect(eventToVM(event('task.proposal_rejected')).verb).toBe('proposal ✗');
  });

  it('continues rendering historical spin-off verbs without emitting them anew', () => {
    expect(eventToVM(event('task.spun_off')).verb).toBe('spin-off');
    expect(eventToVM(event('task.spinoff_accepted')).verb).toBe('spin-off ✓');
    expect(eventToVM(event('task.spinoff_rejected')).verb).toBe('spin-off ✗');
  });
});
