// PLNR-257: hybrid retrieval — storage-free composition, filtering, and ranking. Never opens
// `ctx.storage` (same discipline as backup.ts/restore.ts/lifecycle.ts/writes.ts): ProjectMemory
// gathers rows from its own SQLite (exact lookup, the lexical LIKE scan, bounded graph
// traversal) and from search.ts's semantic layer, and hands them here to filter, rerank, and
// label. This file has no opinion on WHERE a candidate came from beyond the `stage` field it
// already carries.

export type RetrievalStage = 'exact' | 'lexical' | 'semantic' | 'graph';

/**
 * One candidate, before ranking. `entityType` distinguishes a canonical memory/episode row
 * from a graph node reached by traversal — a graph hit before Phase 5/6 is always a 'task'
 * node (the projector is the only node writer today), so it carries no authority/validity/kind
 * of its own; a memory/episode hit carries them from its canonical row, read live by the
 * caller at query time (never from vector metadata — §1/§12).
 */
export interface RetrievalHit {
  entityType: 'memory' | 'episode' | 'node';
  /** The memory/episode/node id. */
  id: string;
  /** Stable entity URI, when the candidate has one (nodes always do; memory/episode may not
   *  yet — Phase 6/7 is where memories become addressable graph nodes too). */
  uri?: string;
  /** Memory kind (learning/decision/…) or graph node type — filterable by `kind`. */
  kind?: string;
  title: string;
  snippet: string;
  stage: RetrievalStage;
  /** Raw stage score — vector similarity, lexical match strength (1.0 = every term matched),
   *  or 1/(1+depth) for a graph hit. Comparable only after `rankCandidates` reweights it. */
  score: number;
  repositoryKey?: string | null;
  branch?: string | null;
  /** memory/episode only — current authority (1-5), read live. */
  authority?: number;
  /** memory only — current validity, read live. */
  validity?: string;
  /** episode only — landing outcome. */
  status?: string;
  /** memory only — each citation's current verification_state. */
  evidenceVerification?: string[];
  /** memory only — index-aligned with `evidenceVerification` (PLNR-265): whether that SAME
   *  citation is verified `verifiedForBase` — i.e. actually 'valid' AND (when the caller supplied
   *  a branch/base) checked against that same branch/base. A citation can read 'valid' here and
   *  `false` there — verified, just not for THIS caller's branch/base — which is exactly the
   *  distinction `classifyLead`'s `evidence-base-mismatch` reason exists to surface. Absent
   *  entirely for a hit with no evidence of its own (episodes, graph nodes). */
  evidenceVerifiedForCaller?: boolean[];
  /** graph hits only — the node id expansion started from. */
  seedNodeId?: string;
  /** graph hits only — the edge chain from the seed to this node, `from>type>to` per hop,
   *  hops separated by `;`. Required provenance, not a debug extra (§1: "results explain why
   *  each item was selected and which evidence/edges support it"). */
  edgePath?: string;
  /** graph hits only — hop count from the nearest seed. */
  depth?: number;
}

export interface RankedHit extends RetrievalHit {
  /** True when this item must be presented as a LEAD, never a settled answer (§1/§12/§13):
   *  authority <= 2, validity moved off 'active', or any evidence citation not 'valid'. Node
   *  hits (no authority/validity/evidence of their own) are never leads on those grounds. */
  isLead: boolean;
  /** Which of the above triggered `isLead` — empty when it isn't one. */
  leadReasons: string[];
  /** The reweighted score `rankCandidates` sorted on — stage weight + authority bonus +
   *  branch-mismatch penalty. Not meaningful outside one call's result set. */
  finalScore: number;
}

/** Depth/result bounds, all named rather than literals at call sites (locked decision: never
 *  an unbounded walk trimmed afterward). `Ceiling` values are the maximum a caller may request;
 *  the plain values are the default when a caller asks for nothing in particular. */
export const RETRIEVAL_DEFAULTS = {
  maxDepth: 2,
  maxDepthCeiling: 4,
  maxGraphResults: 25,
  maxGraphResultsCeiling: 100,
  maxResults: 20,
  maxResultsCeiling: 100,
} as const;

// Stage precedence when scores are otherwise close: an exact id match beats a lexical hit,
// which beats a semantic guess, which beats a graph-proximity hit (the loosest signal — "reached
// via an edge", not "actually about this").
const STAGE_WEIGHT: Record<RetrievalStage, number> = { exact: 1, semantic: 0.9, lexical: 0.8, graph: 0.6 };
// Authority 1..5 contributes up to +0.4 to the reweighted score — enough to let a verified
// decision (5) outrank an equally-matched hypothesis (1), never enough to override a much
// stronger stage/match-quality signal.
const AUTHORITY_WEIGHT = 0.08;
// A memory scoped to a DIFFERENT branch than the caller's is not necessarily wrong — just less
// applicable (discretion) — so this is a rerank penalty, not a hard exclusion.
const BRANCH_MISMATCH_PENALTY = 0.3;

/** Is this candidate a lead — never a settled answer? See `RankedHit.isLead`'s doc comment. */
export function classifyLead(
  item: Pick<RetrievalHit, 'authority' | 'validity' | 'evidenceVerification' | 'evidenceVerifiedForCaller'>,
): { isLead: boolean; leadReasons: string[] } {
  const reasons: string[] = [];
  if (item.authority !== undefined && item.authority <= 2) reasons.push('low-authority');
  if (item.validity !== undefined && item.validity !== 'active') reasons.push(`validity-${item.validity}`);
  if (item.evidenceVerification?.some((v) => v !== 'valid')) reasons.push('unverified-evidence');
  // PLNR-265: a citation can read 'valid' in its OWN row yet have been checked against a
  // DIFFERENT branch/base than the one THIS caller asked about — never let that read as verified
  // for them (the task's own load-bearing acceptance line). Distinct from 'unverified-evidence'
  // above: the citation genuinely verified successfully, just not against the base this caller
  // cares about, so it gets its own named reason rather than being folded into the generic one.
  if (item.evidenceVerification && item.evidenceVerifiedForCaller) {
    const baseMismatch = item.evidenceVerification.some((v, i) => v === 'valid' && item.evidenceVerifiedForCaller![i] === false);
    if (baseMismatch) reasons.push('evidence-base-mismatch');
  }
  return { isLead: reasons.length > 0, leadReasons: reasons };
}

export interface MemoryFilters {
  repositoryKey?: string;
  branch?: string;
  kind?: string;
  minAuthority?: number;
  validity?: string;
}

/**
 * Apply project-level filters BEFORE ranking (repository/branch/kind/authority/validity each
 * narrow independently; combining them narrows further — stated acceptance). A filter never
 * excludes a candidate that simply doesn't carry the field it's filtering on (a bare-URI graph
 * node has no `kind`/`authority` of its own, and a project-wide memory has no `repositoryKey`)
 * — a filter only excludes a candidate whose field is PRESENT and DIFFERENT. `task` filtering
 * is a graph-seed choice made upstream (which node to expand from), not a post-hoc filter here.
 */
export function applyMemoryFilters(candidates: RetrievalHit[], filters: MemoryFilters): RetrievalHit[] {
  return candidates.filter((c) => {
    if (filters.repositoryKey && c.repositoryKey != null && c.repositoryKey !== filters.repositoryKey) return false;
    if (filters.branch && c.branch != null && c.branch !== filters.branch) return false;
    if (filters.kind && c.kind !== undefined && c.kind !== filters.kind) return false;
    if (filters.minAuthority !== undefined && c.authority !== undefined && c.authority < filters.minAuthority) return false;
    if (filters.validity && c.validity !== undefined && c.validity !== filters.validity) return false;
    return true;
  });
}

export interface RankOptions {
  limit?: number;
  /** An item scoped to a branch other than this one is penalized, not excluded — see
   *  BRANCH_MISMATCH_PENALTY's doc comment. */
  preferBranch?: string | null;
}

/**
 * Combine candidates from every stage into one ranked, labelled, bounded list — the one export
 * every retrieval path funnels through. Reranks by stage weight + authority + branch fit,
 * attaches the lead label, and truncates to `limit` (default/max from RETRIEVAL_DEFAULTS).
 * Filtering happens upstream (`applyMemoryFilters`); this only reranks and bounds what it's given.
 */
export function rankCandidates(candidates: RetrievalHit[], opts: RankOptions = {}): RankedHit[] {
  const limit = Math.min(opts.limit ?? RETRIEVAL_DEFAULTS.maxResults, RETRIEVAL_DEFAULTS.maxResultsCeiling);
  const ranked = candidates.map((c) => {
    const { isLead, leadReasons } = classifyLead(c);
    let finalScore = c.score * (STAGE_WEIGHT[c.stage] ?? 0.5) + (c.authority ?? 0) * AUTHORITY_WEIGHT;
    if (opts.preferBranch && c.branch != null && c.branch !== opts.preferBranch) finalScore -= BRANCH_MISMATCH_PENALTY;
    return { ...c, isLead, leadReasons, finalScore };
  });
  ranked.sort((a, b) => b.finalScore - a.finalScore);
  return ranked.slice(0, limit);
}
