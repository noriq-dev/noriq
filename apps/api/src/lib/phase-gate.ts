// The phase-boundary verify gate policy (RUN-21). A phase advances (its review
// tasks → done, unblocking the next phase) only when verify passes. On failure we
// bounce and retry — but bounded: after K failed cycles we stop auto-retrying and
// escalate to a human, so a broken phase never becomes a fix→fail→fix budget sink.

export type PhaseGateAction = 'advance' | 'retry' | 'escalate';

/** How many failed verify cycles before we stop auto-retrying and escalate. */
export const DEFAULT_MAX_VERIFY_ATTEMPTS = 2;

/**
 * Decide what to do with a phase after a verify cycle.
 * @param attempts total failed cycles INCLUDING this one (0 when this cycle passed)
 * @param passed   did verify (deterministic floor + independent agent) pass?
 */
export function phaseGateDecision(
  attempts: number,
  passed: boolean,
  maxAttempts: number = DEFAULT_MAX_VERIFY_ATTEMPTS,
): PhaseGateAction {
  if (passed) return 'advance';
  return attempts >= maxAttempts ? 'escalate' : 'retry';
}
