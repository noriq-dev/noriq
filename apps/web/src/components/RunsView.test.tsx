import { describe, expect, it } from 'vitest';
import { RUN_STATUS_STYLE } from './RunsView';

describe('run status presentation (PLNR-477)', () => {
  it('renders gated as an amber decision state, distinct from failed', () => {
    expect(RUN_STATUS_STYLE.gated).toMatchObject({ color: '#f5a623' });
    expect(RUN_STATUS_STYLE.gated).not.toEqual(RUN_STATUS_STYLE.failed);
    expect(RUN_STATUS_STYLE.gated.live).not.toBe(true);
  });
});
