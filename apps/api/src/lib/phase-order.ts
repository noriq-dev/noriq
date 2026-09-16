/**
 * Plan phases are stored 0-based (`phases."order"` = 0 is first) so gating
 * stays `prev.order < ph.order` with no off-by-one. Humans and agents number
 * from 1, matching the Plans view (`i + 1`). Convert only at the MCP/Ask
 * presentation edge — never persist the display number, and never rewrite
 * the REST snapshot the UI already offsets itself.
 */
export function displayPhaseOrder(storedOrder: number): number {
  return storedOrder + 1;
}

/** Rewrite a stored phase row's `order` for an agent-facing payload. */
export function presentPhaseOrder<T extends { order: unknown }>(phase: T): T & { order: number } {
  return { ...phase, order: displayPhaseOrder(Number(phase.order)) };
}

/**
 * Attach 1-based `order` to create_plan / update_plan structural results,
 * which do not carry the stored column. Index 0 in the returned array is
 * phase 1 — the same number the Plans view shows.
 */
export function presentCreatedPhases<T>(phases: T[]): Array<T & { order: number }> {
  return phases.map((phase, index) => ({ ...phase, order: displayPhaseOrder(index) }));
}
