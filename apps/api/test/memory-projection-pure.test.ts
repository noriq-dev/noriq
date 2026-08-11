import { describe, expect, it } from 'vitest';
import { buildEntityUri } from '@noriq-dev/shared';
import {
  mapCoordinationEvent,
  memoryItemNode,
  MEMORY_PROJECTION_LABEL_MAX_CHARS,
  phaseTaskProvenance,
} from '../src/memory/projection';

describe('PLNR-470 projection derivations', () => {
  it('maps a stored memory to a canonical bounded graph node', () => {
    const projected = memoryItemNode('mem_projection', `  ${'stellar observation '.repeat(8)}\nwith evidence  `);
    expect(projected).toEqual(expect.objectContaining({
      type: 'memory',
      uri: buildEntityUri({ kind: 'memory', id: 'mem_projection' }),
    }));
    expect(projected.label).not.toMatch(/\s{2,}|\n/);
    expect(projected.label).toHaveLength(MEMORY_PROJECTION_LABEL_MAX_CHARS);
    expect(projected.label.endsWith('…')).toBe(true);
  });

  it('projects plan-task links with phase-qualified provenance while replaying legacy payloads', () => {
    const current = mapCoordinationEvent({
      verb: 'plan.tasks_linked',
      subjectId: 'plan_abc',
      payload: { links: [{ taskId: 'task_abc', planId: 'plan_abc', phaseId: 'phs_abc' }] },
    });
    expect(current?.edges[0]?.provenance).toBe(phaseTaskProvenance('phs_abc'));

    const legacy = mapCoordinationEvent({
      verb: 'plan.tasks_linked',
      subjectId: 'plan_abc',
      payload: { links: [{ taskId: 'task_abc', planId: 'plan_abc' }] },
    });
    expect(legacy?.edges[0]?.provenance).toBe('event:plan.tasks_linked');
  });
});
