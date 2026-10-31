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

describe('assessment events', () => {
  it.each(['passed', 'failed', 'inconclusive'])('renders the reported %s outcome with a task link', outcome => {
    expect(eventToVM(event('task.updated', {payload:{key:'PLNR-624',fields:['assessment'],purpose:'implementation',outcome}}))).toMatchObject({
      verb:'assessment',subject:`PLNR-624 · implementation · ${outcome} (actor-reported)`,contentTarget:{kind:'task',id:'task_1'},
    });
  });
  it('uses retained IDs for old incomplete events without inventing an outcome', () => {
    expect(eventToVM(event('task.updated',{payload:{fields:['assessment'],purpose:'readiness'}}))).toMatchObject({subject:'task_1 · readiness'});
    expect(eventToVM(event('task.updated',{payload:{fields:['readinessOverride']}})).subject).toBe('task_1 · readinessOverride');
  });
  it('identifies plan and document assessments and preserves doc revision navigation', () => {
    expect(eventToVM(event('plan.updated',{subjectType:'plan',subjectId:'plan_1',payload:{title:'Release',fields:['assessment'],purpose:'document',outcome:'passed'}})).subject).toBe('Release · document · passed (actor-reported)');
    expect(eventToVM(event('doc.updated',{subjectType:'doc',subjectId:'doc_1',payload:{name:'Contract',version:2,fields:['assessment'],purpose:'document',outcome:'failed'}}))).toMatchObject({subject:'Contract · document · failed (actor-reported)',contentTarget:{kind:'doc',id:'doc_1',version:2}});
  });
  it('keeps legacy attestations distinct from passing evidence', () => {
    expect(eventToVM(event('task.updated',{payload:{key:'PLNR-1',fields:['assessment'],purpose:'legacy_attestation'}}))).toMatchObject({verb:'attested',subject:'PLNR-1 · legacy attestation'});
  });
});
