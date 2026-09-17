// PLNR-561: dual-plane backup invariants.
import { describe, expect, it } from 'vitest';
import {
  PRIORITY_INVERT_DEPLOYED_AT,
  d1ImportSuccessWarnings,
  isPre0066PrioritySnapshot,
  pre0066PriorityBlockMessage,
} from '../src/lib/backup-dual-plane';
describe('backup dual-plane helpers', () => {
  it('detects pre-0066 snapshots by exportedAt', () => {
    expect(isPre0066PrioritySnapshot('2026-07-31T12:00:00.000Z')).toBe(true);
    expect(isPre0066PrioritySnapshot(PRIORITY_INVERT_DEPLOYED_AT)).toBe(false);
    expect(isPre0066PrioritySnapshot('2026-08-01T00:00:00.000Z')).toBe(false);
  });

  it('surfaces dual-plane warnings on D1 import success', () => {
    const codes = d1ImportSuccessWarnings('2026-09-01T00:00:00.000Z').map((w) => w.code);
    expect(codes).toContain('memory_plane_unchanged');
    expect(codes).toContain('agent_session_cursors');
    expect(codes).not.toContain('pre_0066_priority');
  });

  it('includes pre-0066 warning when exportedAt is old', () => {
    const codes = d1ImportSuccessWarnings('2026-07-01T00:00:00.000Z').map((w) => w.code);
    expect(codes).toContain('pre_0066_priority');
  });

  it('documents the pre-0066 acknowledgement gate', () => {
    expect(pre0066PriorityBlockMessage('2026-07-01T00:00:00.000Z')).toContain('acknowledgePre0066Priority');
  });
});
