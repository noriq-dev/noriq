// Write-freeze / maintenance mode (PLNR-166).
//
// Prevention for the PLNR-164 incident: during the planar→noriq cutover the worker kept
// acknowledging writes into a database that was about to be abandoned (from `d1 export`
// until the repointed deploy went live), and 12 acked writes were silently left behind.
// The coordination plane's core contract is that an `ok` is durable, so an ack must never
// point at a doomed database.
//
// When on, every WRITE is refused with a clear, retryable signal (REST → 503; MCP write
// tools → an isError tool result) while reads stay live. Flip it on before the export and
// clear it after the repoint. It is an env var, not a DB/KV flag, on purpose: the freeze
// exists precisely because the database is being swapped, so its control must not live in
// the database being swapped.

/** The single message shown to humans (REST 503 body) and agents (MCP tool error). */
export const MAINTENANCE_MESSAGE = 'maintenance in progress — writes are paused, retry shortly';

/** Truthy check mirroring the DEMO_MODE convention: any value except unset / '0' / 'false'. */
export const isMaintenanceMode = (env: { MAINTENANCE_MODE?: string }): boolean => {
  const v = env.MAINTENANCE_MODE;
  return !!v && v !== '0' && v.toLowerCase() !== 'false';
};
