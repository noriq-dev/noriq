import { describe, expect, it } from 'vitest';
import { JOB_STATUS_STYLE, RUN_STATUS_STYLE } from './RunsView';

describe('run status presentation (PLNR-477)', () => {
  it('renders gated as an amber decision state, distinct from failed', () => {
    expect(RUN_STATUS_STYLE.gated).toMatchObject({ color: '#f5a623' });
    expect(RUN_STATUS_STYLE.gated).not.toEqual(RUN_STATUS_STYLE.failed);
    expect(RUN_STATUS_STYLE.gated.live).not.toBe(true);
  });
});

describe('RunnerJob status presentation (PLNR-501)', () => {
  it('keeps partial output distinct from both success and failure', () => {
    expect(JOB_STATUS_STYLE.partial).not.toEqual(JOB_STATUS_STYLE.succeeded);
    expect(JOB_STATUS_STYLE.partial).not.toEqual(JOB_STATUS_STYLE.failed);
  });
});
