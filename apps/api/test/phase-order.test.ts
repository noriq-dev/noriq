import { describe, expect, it } from 'vitest';
import { displayPhaseOrder, presentCreatedPhases, presentPhaseOrder } from '../src/lib/phase-order';

describe('displayPhaseOrder', () => {
  it('converts stored 0-based order to the 1-based number humans and agents see', () => {
    expect(displayPhaseOrder(0)).toBe(1);
    expect(displayPhaseOrder(2)).toBe(3);
    expect(presentPhaseOrder({ id: 'phs_a', order: 0, title: 'Build' }))
      .toEqual({ id: 'phs_a', order: 1, title: 'Build' });
    expect(presentCreatedPhases([{ id: 'a' }, { id: 'b' }])).toEqual([
      { id: 'a', order: 1 },
      { id: 'b', order: 2 },
    ]);
  });
});
