// PLNR-265: server-side citation verification — the pure per-citation verdict rule, the
// base-scoped "is this verified FOR THIS CALLER" check, the memory-level validity roll-up, and
// Runner-report normalization. Same split as writes.ts/retrieval.ts/similar-effort.ts: this file
// never opens `ctx.storage` — `ProjectMemory` gathers rows (evidence, the active index
// generation's graph nodes, a Runner's uploaded report) and hands them here to judge, roll up,
// and validate. Nothing here compares, parses, shortens, or otherwise interprets a `baseId`
// beyond `===` — §6 is explicit that Perforce changelists and Diversion commit ids share this
// column with git SHAs, and string equality is the only comparison every backend agrees on.
import { z } from 'zod';
import { BaseId, BranchRef, RepoPath, VerificationState, type VerificationState as VerificationStateT } from '@noriq-dev/shared';

// ---------------------------------------------------------------------------------------------
// The per-citation verdict rule — the CHEAP server-side tier (§15)
// ---------------------------------------------------------------------------------------------

/**
 * What the cheap tier could determine about a citation from the active index generation's graph
 * (ProjectMemory.verifyMemoryCitations builds this by looking up the citation's file/symbol node
 * URIs) — or `null` when there is no active generation for the citation's repository at all (no
 * index has ever run, or it has been staged but never activated), which is the honest "nothing to
 * check against" case, not "checked and failed".
 */
export interface CitationCheck {
  /** Does a `file` node for the citation's path exist in the active generation's graph? */
  pathPresent: boolean;
  /** Does a `symbol` node for the citation's (path, symbol) exist? `null` when the citation cites
   *  no symbol at all — a path-only citation has nothing further to check once the path itself
   *  is confirmed present. */
  symbolPresent: boolean | null;
}

/**
 * The cheap tier's verdict, from a `CitationCheck` (or `null` — no active generation to check
 * against). Deliberately narrow:
 *
 *   - `check === null`               -> 'unverifiable' — no index to check against. NEVER 'valid'
 *                                        (an absent index proves nothing) and NEVER 'missing' (it
 *                                        would invalidate every citation in every unindexed
 *                                        repository on the very first sweep) — §1's exact framing.
 *   - `!pathPresent`                 -> 'missing' — the cited file no longer exists at the
 *                                        verified base.
 *   - `pathPresent && symbolPresent === false` -> 'changed' — the file survives, but the specific
 *                                        symbol the citation names does not; the citation's claim
 *                                        has changed even though the artifact has not vanished.
 *   - otherwise (path present, and no symbol was cited or the symbol is also present) -> 'valid'.
 *
 * This tier NEVER returns 'moved' (discretion, recorded here rather than left implicit):
 * detecting a symbol that relocated to a DIFFERENT path means searching by symbol name/label
 * across every path in the graph, which is a materially different (and much more expensive)
 * query than a single uri lookup, and the Runner's worktree tier (§15) can already answer it
 * cheaply with a real `git grep`/AST search against the actual leased checkout. 'moved' is
 * reachable only through a Runner report (`acceptVerificationReport`).
 */
export function citationVerdict(check: CitationCheck | null): VerificationStateT {
  if (check === null) return 'unverifiable';
  if (!check.pathPresent) return 'missing';
  if (check.symbolPresent === false) return 'changed';
  return 'valid';
}

// ---------------------------------------------------------------------------------------------
// Base-scoped verification — "verified" is not a single bit; it is a claim scoped to a
// branch/base, and it only counts as verified FOR a caller who asked about that same branch/base.
// ---------------------------------------------------------------------------------------------

/** What a retrieval caller is asking about — both optional: a caller with no branch/base context
 *  (the common case for a plain keyword/semantic search with no worktree behind it) gets no
 *  scoping penalty at all, the same "a filter never excludes what it can't compare" posture
 *  `applyMemoryFilters` already uses. */
export interface CallerBaseScope {
  baseId?: string | null;
  branch?: string | null;
}

/** One citation's currently-recorded verification facts — exactly the columns 0008 added,
 *  reshaped to camelCase for this file's callers. */
export interface VerifiedCitation {
  verificationState: string;
  lastVerifiedBaseId: string | null;
  lastVerifiedBranch: string | null;
}

/**
 * Is this citation verified — genuinely 'valid' — AND, when the caller specified a branch/base,
 * scoped to the SAME one? This is the single load-bearing predicate the task's acceptance names
 * first: "retrieval never labels a memory verified solely because it was verified on an
 * unrelated branch/base". A citation verified 'valid' against branch A / base X is worthless as
 * proof for a caller asking about branch B / base Y — worse than worthless, because a bare
 * `verificationState === 'valid'` read on its own would look like settled truth.
 *
 * String equality only (§6) — `!==` on `baseId`/`branch`, nothing that inspects their shape.
 */
export function verifiedForBase(citation: VerifiedCitation, caller: CallerBaseScope): boolean {
  if (citation.verificationState !== 'valid') return false;
  if (caller.baseId != null && citation.lastVerifiedBaseId !== caller.baseId) return false;
  if (caller.branch != null && citation.lastVerifiedBranch !== caller.branch) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Memory-level validity roll-up (locked decision — see the task's execution spec verbatim)
// ---------------------------------------------------------------------------------------------

/**
 * Roll every one of a memory's repository-citation verification states up into the memory's OWN
 * validity. `null` means "do not transition at all" — the caller (`ProjectMemory`) must leave
 * the memory's current validity untouched, never write 'active' over it defensively. This is the
 * ONLY way a memory with zero repository evidence is protected: a project-wide decision or
 * procedure (writes.ts's `MemoryScope` is all-optional) legitimately cites nothing, and treating
 * that as automatically "fully verified" — or, worse, as grounds to demote it — would degrade the
 * highest-authority records in the store for a property they were never supposed to have.
 *
 * The three explicit buckets, and the one implicit one:
 *   - every citation 'valid'   -> 'active'
 *   - every citation 'missing' -> 'invalid'
 *   - any other non-empty mix (including every citation sitting at 'unverifiable' — a memory
 *     whose evidence has simply never been checked yet, or can't be) -> 'stale'. This is a
 *     deliberate reading of "some valid, some not": an unverified claim is not disproven, but it
 *     is exactly what §1 calls a lead rather than a settled answer, and 'stale' is what makes it
 *     present as one (`classifyLead`'s `validity-stale` reason) without erasing anything.
 */
export function rollUpValidity(states: readonly string[]): 'active' | 'stale' | 'invalid' | null {
  if (states.length === 0) return null;
  if (states.every((s) => s === 'valid')) return 'active';
  if (states.every((s) => s === 'missing')) return 'invalid';
  return 'stale';
}

// ---------------------------------------------------------------------------------------------
// Runner verification reports — the THOROUGH tier (§15)
// ---------------------------------------------------------------------------------------------

/**
 * One citation's verdict from a Runner's worktree-leased verification pass. Citations are
 * addressed by `(memoryItemId, evidenceHash)`, never by ProjectMemory's own internal `evidence.id`
 * — `evidenceHash` (writes.ts) is already the citation's stable, recomputable identity
 * (repository/branch/baseId/path/symbol), so a Runner that re-derives it from the citation text it
 * was handed needs no separate id lookup round-trip, and a citation Noriq has since forgotten
 * (superseded, decayed) is simply skipped rather than failing the whole report.
 *
 * `baseId`/`branch` are the worktree's ACTUAL state at verification time — not necessarily the
 * citation's own originally-recorded scope — exactly the fields `verifiedForBase` compares a
 * later caller's request against.
 */
export const VerificationReportCitation = z.object({
  memoryItemId: z.string().min(1),
  evidenceHash: z.string().min(1),
  state: VerificationState,
  baseId: BaseId,
  branch: BranchRef,
  /** Where a 'moved' citation was actually found. Only meaningful when `state === 'moved'`;
   *  ignored (and stored as NULL) otherwise — a stale `observedPath` left over from filling in a
   *  test fixture must never be attributed to a citation the report calls 'valid'. */
  observedPath: RepoPath.nullable().optional(),
});
export type VerificationReportCitation = z.infer<typeof VerificationReportCitation>;

export const VerificationReport = z.object({
  citations: z.array(VerificationReportCitation).min(1),
  /** Free text, not an enum (see 0008's own comment) — defaults to the Runner tier since that is
   *  the only caller of `acceptVerificationReport` today (§15's "thorough tier"); the cheap
   *  server-side tier writes its own fixed `'server-index'` source directly and never goes
   *  through this report shape. */
  source: z.string().min(1).default('runner-report'),
});
export type VerificationReport = z.infer<typeof VerificationReport>;

/**
 * Validate + normalize a raw Runner report body. Throws (zod's own `ZodError`) on anything
 * malformed — the route handler is what turns that into a 400, exactly like `validateEvidenceRef`
 * (writes.ts) does for `record_memory`. Deduplicates exact-duplicate citation entries WITHIN one
 * report (same memoryItemId+evidenceHash+state+baseId+branch+observedPath), keeping the last —
 * this is a courtesy for a caller that batches redundantly; it is NOT what makes repeated
 * REQUESTS idempotent (that is `ProjectMemory.acceptVerificationReport`'s job, comparing the
 * incoming verdict against each evidence row's CURRENTLY STORED one).
 */
export function normalizeVerificationReport(raw: unknown): VerificationReport {
  const parsed = VerificationReport.parse(raw);
  const byKey = new Map<string, VerificationReportCitation>();
  for (const c of parsed.citations) {
    const key = [c.memoryItemId, c.evidenceHash, c.state, c.baseId, c.branch, c.observedPath ?? ''].join(' ');
    byKey.set(key, c);
  }
  return { citations: [...byKey.values()], source: parsed.source };
}
