import { describe, expect, it } from 'vitest';
import type { ApiSnapshot } from './api';
import { eventToVM } from './store';

function event(
  verb: string,
  overrides: Partial<ApiSnapshot['events'][number]> = {},
): ApiSnapshot['events'][number] {
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
    ...overrides,
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

describe('event content targets', () => {
  it('retains the exact document revision for navigable lifecycle events', () => {
    expect(eventToVM(event('doc.updated', {
      subjectType: 'doc', subjectId: 'doc_1', payload: { name: 'Architecture', version: 4 },
    }))).toMatchObject({
      subject: 'revised "Architecture"',
      contentTarget: { kind: 'doc', id: 'doc_1', version: 4 },
    });
    expect(eventToVM(event('doc.archived', {
      subjectType: 'doc', subjectId: 'doc_1', payload: { name: 'Architecture', version: 4 },
    }))).toMatchObject({ contentTarget: { kind: 'doc', id: 'doc_1', version: 4 } });
  });

  it('routes retained plan documents but leaves deleted content non-navigable', () => {
    expect(eventToVM(event('plan_doc.updated', {
      subjectType: 'plan_doc', subjectId: 'pdoc_1', payload: { name: 'Rollout', planId: 'plan_1' },
    }))).toMatchObject({ contentTarget: { kind: 'plan_doc', id: 'pdoc_1', planId: 'plan_1' } });
    expect(eventToVM(event('doc.deleted', {
      subjectType: 'doc', subjectId: 'doc_1', payload: { name: 'Architecture' },
    })).contentTarget).toBeUndefined();
    expect(eventToVM(event('plan_doc.deleted', {
      subjectType: 'plan_doc', subjectId: 'pdoc_1', payload: { name: 'Rollout', planId: 'plan_1' },
    })).contentTarget).toBeUndefined();
  });
});
