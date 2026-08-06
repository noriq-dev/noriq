// PLNR-247: the reverse half of the memory<->coordination bridge — selecting a project's D1
// coordination events for ProjectMemory to project forward into its own graph. The cursor this
// pairs with (events.global_seq) lives INSIDE ProjectMemory, not here; this file only knows how
// to read D1, never how to advance the cursor or write the projection (that's ProjectMemory's
// own transaction, so cursor-advance and projection-write commit together).
import type { Env } from '../env';

export interface ProjectedEvent {
  id: string;
  globalSeq: number;
  verb: string;
  subjectType: string;
  subjectId: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/**
 * This project's coordination events with `events.global_seq > sinceGlobalSeq`, oldest first.
 * `global_seq` is the trigger-assigned, reuse-proof counter (migration 0056) — never `rowid`
 * (reused after deleteProject, PLNR-111) and never the per-project `seq` (that one is the WS
 * resume cursor, a different consumer entirely).
 */
export async function projectCoordinationEvents(
  env: Env,
  projectId: string,
  sinceGlobalSeq: number,
): Promise<ProjectedEvent[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, global_seq, verb, subject_type, subject_id, payload, created_at
     FROM events WHERE project_id = ? AND global_seq > ? ORDER BY global_seq ASC`,
  )
    .bind(projectId, sinceGlobalSeq)
    .all<{
      id: string;
      global_seq: number;
      verb: string;
      subject_type: string;
      subject_id: string;
      payload: string;
      created_at: string;
    }>();
  return results.map((r) => ({
    id: r.id,
    globalSeq: r.global_seq,
    verb: r.verb,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    createdAt: r.created_at,
  }));
}
