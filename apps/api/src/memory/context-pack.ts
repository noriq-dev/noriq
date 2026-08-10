// PLNR-267: get_task_context — the task-aware context pack assembler (§10). Composition ONLY:
// every retrieval primitive this module needs already shipped in Phase 6 (PLNR-257/258/264/265)
// — `ProjectMemory.searchProjectMemory`/`similarEffort`/`dependencyNeighborhood`/`validatingTests`/
// `changeImpact`/`getMemoryItem`. Nothing here opens a new retrieval path; it reads the task's own
// D1 row for the REQUIRED half of the pack and composes the shipped RPCs for everything else.
//
// WHY THIS LIVES HERE AND NOT AS A NEW ProjectMemory RPC (locked decision): the pack's required
// facts (goal, executionSpec, acceptance, open comments, claim state) are D1 coordination data the
// Worker already holds; the memory half is fully served by RPCs ProjectMemory already exports.
// Putting assembly inside the DO would make it re-read D1 through the stub for data the caller
// already has, and would bury a composition concern inside the canonical writer. `memory/
// episodes.ts`'s `recordEpisodeForRun` is the shape this module copies: pure builders + one
// `env`-reading, D1-and-stub-calling entry point.
//
// WHY CHARACTERS, NEVER TOKENS (locked decision, §20): a real tokenizer would make the bound
// depend on an optional AI binding, which §20 forbids for a core path, and would make the bound
// untestable (different tokenizer versions/models disagree on token counts for the same text).
// CHARS_PER_TOKEN is a deliberate UNDER-estimate of real average chars-per-token (real English/
// code tokenizers average roughly 4 chars/token) — using a SMALLER constant makes the character
// budget this module allocates for a given `tokenBudget` smaller than what a real tokenizer would
// need to spend that many tokens, so the REAL token count for an emitted pack can only come in
// UNDER the caller's requested budget, never over.
import type { Env } from '../env';
import { nowIso } from '../lib/util';
import { readExecutionSpec } from '../lib/execution-spec';
import { normalizePattern, patternsOverlap, LockPatternError } from '../lib/lockmatch';
import type { ProjectMemoryStub } from '../lib/project-memory';
import { RETRIEVAL_DEFAULTS, type RankedHit, type RetrievalStage } from './retrieval';
import { effortSignals } from './similar-effort';
import { verifiedForBase, type CallerBaseScope } from './verification';
import { renderEvidenceFrame, type EvidenceFrameItem, type EvidenceFrameResult } from './evidence-frame';
import {
  buildEntityUri,
  type ContextPack,
  type ContextPackCitation,
  type ContextPackCoverage,
  type ContextPackEpisodeExcerpt,
  type ContextPackExcerpt,
  type ContextPackGraphEntity,
  type ContextPackMemoryExcerpt,
  type ContextPackMode,
  type ContextPackNotice,
  type ContextPackRole,
  type ContextPackSection,
  type ContextPackSectionId,
  type ContextPackTaskFacts,
  type MemoryItem,
} from '@noriq-dev/shared';

// See the module comment: a deliberate UNDER-estimate of real chars/token so a caller's real
// tokenizer can only find FEWER tokens than the budget this module enforces, never more.
export const CHARS_PER_TOKEN = 3;
// Used only when the caller supplies no `tokenBudget` at all — generous enough to be useful,
// bounded enough that "no budget given" cannot mean "unbounded".
export const DEFAULT_CHAR_BUDGET = 24_000;
// A retrieval RPC can rank up to `RETRIEVAL_DEFAULTS.maxResultsCeiling` (100) hits; enriching
// every one of them with a live `getMemoryItem` call before budgeting even starts would be up to
// 100 DO round-trips for content most of which will never fit. This caps how many top-ranked
// candidates per section get enriched at all — a candidate ceiling, deliberately distinct from
// the character BUDGET (allocateBudget) below, which then decides how many of THESE fit.
const MAX_CANDIDATES_PER_SECTION = 8;

// ---------------------------------------------------------------------------------------------
// Section fill order and budget weights (locked decision: "declared as data ... not implied by
// statement order in the code"). `task_facts` is deliberately NOT here — see ContextPackTaskFacts'
// own doc comment; it is allocated its own unbounded floor before this table is ever consulted.
// ---------------------------------------------------------------------------------------------

export interface SectionSpec<Id extends string = ContextPackSectionId> {
  id: Id;
  /** Baseline relative share of the budget LEFT OVER after the task's required facts. Decisions/
   *  hazards/failed-approaches/relevant-memories/similar-episodes are the highest-value LEADS a
   *  working agent weighs first, so they get the largest shares; graph/test/neighboring-work
   *  facts are supplementary orientation; `source_excerpts` needs enough room to carry full
   *  citations for whatever survived its own section's cut. */
  weight: number;
}

export const SECTION_ORDER: readonly SectionSpec[] = [
  { id: 'active_decisions', weight: 3 },
  { id: 'known_hazards', weight: 2 },
  { id: 'failed_approaches', weight: 2 },
  { id: 'relevant_memories', weight: 2 },
  { id: 'similar_episodes', weight: 2 },
  { id: 'graph_neighborhood', weight: 1 },
  { id: 'affected_tests', weight: 1 },
  { id: 'active_neighboring_work', weight: 1 },
  { id: 'uncertainty', weight: 1 },
  { id: 'source_excerpts', weight: 2 },
];

/**
 * Role reweights section budgets ONLY — it never adds, removes, or reorders a section, and it
 * never changes which facts are authoritative (locked decision: authority is a property of the
 * record, §12, never of who is reading it — a verify run must see the SAME truth as the build run
 * it is judging, just with a different lens on what deserves more room).
 */
const ROLE_WEIGHT_MULTIPLIERS: Partial<Record<ContextPackRole, Partial<Record<ContextPackSectionId, number>>>> = {
  // Choosing what to build: leans on decisions/requirements/uncertainty; has no code yet to check
  // dependencies or tests against.
  scope: { relevant_memories: 1.5, uncertainty: 1.5, graph_neighborhood: 0.5, affected_tests: 0.5 },
  // About to touch files: dependency/test/neighboring-work facts earn more room.
  build: { graph_neighborhood: 2, affected_tests: 2, active_neighboring_work: 2, uncertainty: 0.5 },
  // Judging someone else's diff: prior-failure signal and full source citations matter more than
  // fresh exploration leads.
  verify: { failed_approaches: 2, similar_episodes: 1.5, source_excerpts: 1.5, active_neighboring_work: 0.5 },
  // A human reading this in a UI gets the baseline weights untouched.
  human: {},
};

// PLNR-268: generalized from `id: ContextPackSectionId` to any string `Id` — get_briefing's
// project-memory pulse (sync.ts) reuses this exact greedy budget-splitting rule for its OWN,
// unrelated section vocabulary rather than re-deriving it. `ROLE_WEIGHT_MULTIPLIERS` above still
// only knows `ContextPackSectionId`, so a foreign `Id` simply finds no entry (multiplier 1, i.e.
// no reweight) — exactly get_briefing's baseline, which has no `role` concept of its own. Every
// EXISTING call site (context-pack.ts's own `SECTION_ORDER`, all `ContextPackSectionId`) keeps
// its exact prior behavior: the default type parameter makes this widening source-compatible.
function weightFor<Id extends string>(role: ContextPackRole, id: Id, baseWeight: number): number {
  return baseWeight * (ROLE_WEIGHT_MULTIPLIERS[role]?.[id as ContextPackSectionId] ?? 1);
}

/**
 * Pure: split `remainingChars` across `sections` by (role-reweighted) share. Floor each share,
 * then hand the flooring remainder to the EARLIEST sections in `SECTION_ORDER`, one character
 * each, so the total allocated is EXACTLY `remainingChars` and ties always resolve the same way —
 * determinism (stated acceptance) all the way down to how a leftover character is placed. No I/O,
 * no DO: the "pure budgeting half" the task's own acceptance requires be unit-testable alone.
 */
export function allocateBudget<Id extends string = ContextPackSectionId>(
  remainingChars: number,
  sections: readonly SectionSpec<Id>[] = SECTION_ORDER as readonly SectionSpec<Id>[],
  role: ContextPackRole = 'human',
): Record<Id, number> {
  const clamped = Math.max(0, Math.floor(remainingChars));
  const weights = sections.map((s) => Math.max(0, weightFor(role, s.id, s.weight)));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const result: Record<string, number> = {};
  for (const s of sections) result[s.id] = 0;
  if (clamped === 0 || totalWeight <= 0) return result as Record<Id, number>;
  const floors = weights.map((w) => Math.floor((clamped * w) / totalWeight));
  sections.forEach((s, i) => { result[s.id] = floors[i]!; });
  let remainder = clamped - floors.reduce((a, b) => a + b, 0);
  for (let i = 0; i < sections.length && remainder > 0; i++) {
    const id = sections[i]!.id;
    result[id] = (result[id] ?? 0) + 1;
    remainder--;
  }
  return result as Record<Id, number>;
}

// ---------------------------------------------------------------------------------------------
// Deterministic character accounting and greedy, order-preserving fill
// ---------------------------------------------------------------------------------------------

/** One deterministic size for any pack content: the length of its own stable JSON encoding. Every
 *  excerpt/entity/item built below is a freshly-constructed object with a fixed key order, so
 *  `JSON.stringify` is deterministic across calls with the same content — which is exactly what
 *  "identical inputs produce a byte-identical pack" (stated acceptance) needs from this function. */
// Exported (PLNR-268): get_briefing's project-memory pulse (sync.ts) measures its own,
// unrelated candidate shapes with the SAME deterministic rule rather than a second one.
export function charSize(value: unknown): number {
  return JSON.stringify(value).length;
}

/**
 * Fill from `candidates` (already ranked by whichever retrieval primitive produced them — this
 * reranks nothing) into `cap` characters. A candidate that does not fit STOPS the fill rather than
 * being skipped in favor of a smaller later one: "the first N that fit", never "as many as fit" —
 * the rule that keeps the same budget always producing the same cut. Returns how much of `cap`
 * went unused so the caller can roll it forward into the NEXT section in `SECTION_ORDER` (fixed
 * order — nothing here spends a later section's share early).
 */
// Exported (PLNR-268): same "reuse the section/budget machinery" reason as `charSize` above.
export function fillGreedy<T>(candidates: readonly T[], cap: number): { taken: T[]; used: number; truncated: boolean } {
  const taken: T[] = [];
  let used = 0;
  for (const c of candidates) {
    const size = charSize(c);
    if (used + size > cap) return { taken, used, truncated: true };
    taken.push(c);
    used += size;
  }
  return { taken, used, truncated: false };
}

function emptySection(id: ContextPackSectionId, cap: number, notice: ContextPackNotice | null): ContextPackSection {
  return { id, provenance: ['none'], notice, charsAllotted: cap, charsUsed: 0, excerpts: [], graphEntities: [], coverage: null, items: [] };
}

// ---------------------------------------------------------------------------------------------
// Memory excerpt enrichment — read live from the canonical row at assembly time (locked
// decision), never from the RankedHit's own snippet/aggregate-verification-state fields.
// ---------------------------------------------------------------------------------------------

async function buildMemoryExcerpt(
  stub: ProjectMemoryStub, projectId: string, hit: RankedHit, caller: CallerBaseScope,
): Promise<ContextPackMemoryExcerpt | null> {
  const row = await stub.getMemoryItem(projectId, hit.id);
  if (!row) return null; // decayed/superseded-away between search and assembly — degrade, don't fail the pack
  return {
    excerptKind: 'memory',
    id: row.id,
    memoryKind: row.kind as ContextPackMemoryExcerpt['memoryKind'],
    statement: row.statement,
    authority: row.authority as ContextPackMemoryExcerpt['authority'],
    confidence: row.confidence,
    validity: row.validity,
    isLead: hit.isLead ?? false,
    leadReasons: hit.leadReasons ?? [],
    recordedByAgentId: row.recordedByAgentId,
    recordedAt: row.recordedAt,
    supersedesMemoryId: row.supersedesMemoryId,
    evidence: row.evidence.map((e): ContextPackCitation => ({
      repositoryKey: e.repositoryKey,
      branch: e.branch,
      baseId: e.baseId,
      path: e.path,
      symbol: e.symbol,
      verificationState: e.verificationState as ContextPackCitation['verificationState'],
      lastVerifiedAt: e.lastVerifiedAt,
      lastVerifiedBaseId: e.lastVerifiedBaseId,
      lastVerifiedBranch: e.lastVerifiedBranch,
      verifiedForCaller: verifiedForBase(
        { verificationState: e.verificationState, lastVerifiedBaseId: e.lastVerifiedBaseId, lastVerifiedBranch: e.lastVerifiedBranch },
        caller,
      ),
    })),
  };
}

async function buildMemoryExcerpts(
  stub: ProjectMemoryStub, projectId: string, hits: RankedHit[], caller: CallerBaseScope,
): Promise<ContextPackMemoryExcerpt[]> {
  const capped = hits.slice(0, MAX_CANDIDATES_PER_SECTION);
  const built = await Promise.all(capped.map((h) => buildMemoryExcerpt(stub, projectId, h, caller)));
  return built.filter((e): e is ContextPackMemoryExcerpt => e !== null);
}

function memoryHitStages(hits: RankedHit[]): RetrievalStage[] {
  return [...new Set(hits.map((h) => h.stage))];
}

// ---------------------------------------------------------------------------------------------
// The assembler
// ---------------------------------------------------------------------------------------------

export interface ContextPackInput {
  /** The caller's own opaque VCS revision/branch (§6, PLNR-265) — string-compared only, scopes
   *  whether a citation reads as verified FOR THIS CALLER. */
  branch?: string | null;
  baseId?: string | null;
  /** The canonical repository key (§6) a `repositoryKey`-scoped graph query resolves the task's
   *  own `anticipatedFiles` against. Omitted entirely, the pack still assembles (§20) — file-level
   *  graph sections degrade to the task's own node as their seed instead. */
  repositoryKey?: string | null;
  role?: ContextPackRole;
  /** Tokens, converted to a character budget via `CHARS_PER_TOKEN`. Omitted → `DEFAULT_CHAR_BUDGET`. */
  tokenBudget?: number | null;
}

interface TaskRow {
  id: string;
  key: string;
  project_id: string;
  title: string;
  body: string | null;
  status: string;
  priority: number;
  claimed_by: string | null;
  claim_expires_at: string | null;
  execution_spec: string | null;
  failed_at: string | null;
  proposed_at: string | null;
  file_locking_enabled: number;
  project_key: string;
}

interface OpenCommentRow {
  id: string;
  kind: string;
  body: string;
  authorKind: string;
  authorId: string | null;
  createdAt: string;
}

/**
 * Assemble one task-aware context pack (§10). `taskId` MUST already be resolved to its canonical
 * id and known to belong to `projectId` — same contract every other `memory/*.ts` module and
 * `lib/project-memory.ts` helper holds; project/task access itself is checked at the MCP/REST edge
 * (`tool()`'s wrapper / `requireProjectAccess`), never re-derived in here.
 *
 * READ-ONLY throughout (locked decision): every ProjectMemory RPC this calls
 * (`searchProjectMemory`/`similarEffort`/`dependencyNeighborhood`/`validatingTests`/
 * `changeImpact`/`getMemoryItem`) is itself read-only, and every D1 query here is a plain SELECT.
 * Assembling a pack changes no memory row, no validity, no verification state, and emits no
 * outbox event.
 */
export async function assembleContextPack(
  env: Env, projectId: string, taskId: string, input: ContextPackInput = {},
): Promise<ContextPack & { evidenceFrame: EvidenceFrameResult }> {
  const stub = env.PROJECT_MEMORY.get(env.PROJECT_MEMORY.idFromName(projectId)) as unknown as ProjectMemoryStub;
  const role: ContextPackRole = input.role ?? 'human';
  const caller: CallerBaseScope = { baseId: input.baseId ?? null, branch: input.branch ?? null };

  // ---- 1. Required task facts — D1, full, FIRST, from a reserved floor (locked decision) -----
  const row = await env.DB.prepare(
    `SELECT t.id, t.key, t.project_id, t.title, t.body, t.status, t.priority, t.claimed_by, t.claim_expires_at,
            t.execution_spec, t.failed_at, t.proposed_at, p.file_locking_enabled, p.key AS project_key
     FROM tasks t JOIN projects p ON p.id = t.project_id
     WHERE t.id = ?`,
  ).bind(taskId).first<TaskRow>();
  // Same leak-free posture as resolveTaskId/resolveBlockerRef (mcp.ts): a task that exists but
  // belongs to a DIFFERENT project than the caller named reads identically to one that doesn't
  // exist at all — this is the "refused the same way every other project-scoped surface refuses
  // it" acceptance line.
  if (!row || row.project_id !== projectId) throw new Error(`task ${taskId} not found in project ${projectId}`);

  const derivedStatus = row.failed_at ? 'failed' : row.proposed_at && row.status === 'todo' ? 'proposed' : row.status;
  const storedSpec = readExecutionSpec(row.execution_spec, row.id);
  const { results: openCommentRows } = await env.DB.prepare(
    `SELECT id, kind, body, author_kind AS authorKind, author_id AS authorId, created_at AS createdAt
     FROM comments WHERE task_id = ? AND status IN ('open','acknowledged') ORDER BY created_at ASC`,
  ).bind(row.id).all<OpenCommentRow>();

  const taskFacts: ContextPackTaskFacts = {
    taskId: row.id,
    key: row.key,
    title: row.title,
    body: row.body,
    status: derivedStatus,
    priority: row.priority,
    claimedBy: row.claimed_by,
    claimExpiresAt: row.claim_expires_at,
    openComments: openCommentRows,
    executionSpec: storedSpec.spec,
    executionSpecUnreadable: !!storedSpec.unreadable,
  };
  const anticipatedFiles = storedSpec.spec?.anticipatedFiles?.map((f) => f.path) ?? [];

  const charBudget = input.tokenBudget ? Math.max(1, Math.floor(input.tokenBudget * CHARS_PER_TOKEN)) : DEFAULT_CHAR_BUDGET;
  const taskFactsChars = charSize(taskFacts);
  // The floor: whatever is left AFTER the required facts, however small (even zero) — the
  // required facts themselves are NEVER reduced to make room (locked decision).
  const remaining = Math.max(0, charBudget - taskFactsChars);
  const allotments = allocateBudget(remaining, SECTION_ORDER, role);

  // The required-facts floor can legitimately be bigger than what the caller asked for — the
  // precedence is intentional (task facts are never displaced or truncated), but a caller
  // assembling a prompt against a real token ceiling needs to be TOLD, not left to infer an
  // overrun by comparing `charBudget` against `charsUsed` itself. Pack-level, not a section
  // notice: nothing here was truncated (no content was cut to fit) and nothing was unanswerable
  // (the question WAS answered, in full) — it is its own distinguishable claim.
  const packNotices: ContextPackNotice[] = [];
  if (taskFactsChars > charBudget) {
    packNotices.push({
      kind: 'required_facts_exceeded_budget',
      reason: `requested budget: ${charBudget} characters; the task's required facts alone are ${taskFactsChars} characters — task facts are never displaced by budget, so this pack exceeds the requested budget by ${taskFactsChars - charBudget} characters.`,
    });
  }

  // ---- 2. Fetch everything the memory half needs, in parallel where independent -------------
  const signals = effortSignals({ title: row.title, body: row.body, anticipatedFiles });
  const taskUri = buildEntityUri({ kind: 'task', id: row.id });

  const fileUris: string[] = [];
  if (input.repositoryKey && anticipatedFiles.length) {
    for (const path of anticipatedFiles) {
      try {
        fileUris.push(buildEntityUri({ kind: 'file', projectKey: row.project_key, repositoryKey: input.repositoryKey, path }));
      } catch { /* malformed path slipped past the write-seam validator — skip it, don't fail the pack */ }
    }
  }

  const [searchResult, effortResult, depResult, testsResult, lockRows] = await Promise.all([
    stub.searchProjectMemory(projectId, {
      query: signals.queryText || undefined,
      taskId: row.id,
      repositoryKey: input.repositoryKey ?? undefined,
      // The task's caller branch is a ranking/verification preference, not a hard filter: a pack
      // must retain relevant project knowledge recorded on another branch, only demoting it.
      preferBranch: input.branch ?? undefined,
      baseId: input.baseId ?? undefined,
      limit: RETRIEVAL_DEFAULTS.maxResultsCeiling,
    }),
    stub.similarEffort(projectId, { taskId: row.id, title: row.title, body: row.body, anticipatedFiles, limit: RETRIEVAL_DEFAULTS.maxResults }),
    stub.dependencyNeighborhood(projectId, { entityUri: taskUri, maxDepth: RETRIEVAL_DEFAULTS.maxDepth, maxResults: RETRIEVAL_DEFAULTS.maxGraphResults }),
    fileUris.length
      ? stub.changeImpact(projectId, { entityUris: fileUris, maxDepth: RETRIEVAL_DEFAULTS.maxDepth, maxResults: RETRIEVAL_DEFAULTS.maxGraphResults })
      : stub.validatingTests(projectId, { entityUri: taskUri, maxDepth: RETRIEVAL_DEFAULTS.maxDepth, maxResults: RETRIEVAL_DEFAULTS.maxGraphResults }),
    row.file_locking_enabled
      ? env.DB.prepare(
          `SELECT fl.id, fl.task_id AS taskId, fl.agent_id AS agentId, fl.canon_pattern AS canonPattern,
                  t.key AS taskKey, t.title AS taskTitle, t.status AS taskStatus
           FROM file_locks fl LEFT JOIN tasks t ON t.id = fl.task_id
           WHERE fl.project_id = ? AND fl.released_at IS NULL
           ORDER BY fl.acquired_at ASC LIMIT 500`,
        ).bind(projectId).all<{ id: string; taskId: string | null; agentId: string; canonPattern: string; taskKey: string | null; taskTitle: string | null; taskStatus: string | null }>()
      : Promise.resolve({ results: [] as Array<{ id: string; taskId: string | null; agentId: string; canonPattern: string; taskKey: string | null; taskTitle: string | null; taskStatus: string | null }> }),
  ]);

  // Bucket searchProjectMemory's hits by kind — one call feeds five sections (locked-decision-
  // adjacent efficiency: it's the SAME retrieval every one of those sections would otherwise
  // issue separately). Episode hits from this call are dropped: `similarEffort` (above) already
  // covers episodes with a richer, purpose-built shape (whatWasAttempted/whatFailed/support) —
  // presenting the SAME episode twice in two different shapes would be noise, not evidence.
  const memHitsByKind = new Map<string, RankedHit[]>();
  for (const hit of searchResult.results) {
    if (hit.entityType !== 'memory') continue;
    const k = hit.kind ?? 'unknown';
    const list = memHitsByKind.get(k);
    if (list) list.push(hit); else memHitsByKind.set(k, [hit]);
  }
  const decisionHits = memHitsByKind.get('decision') ?? [];
  const hazardHits = memHitsByKind.get('hazard') ?? [];
  const failedHits = memHitsByKind.get('failed_approach') ?? [];
  const unknownHits = memHitsByKind.get('unknown') ?? [];
  const relevantHits = [
    ...(memHitsByKind.get('learning') ?? []),
    ...(memHitsByKind.get('procedure') ?? []),
    ...(memHitsByKind.get('requirement') ?? []),
  ];

  const [decisionExcerpts, hazardExcerpts, failedExcerpts, relevantExcerpts, unknownExcerpts] = await Promise.all([
    buildMemoryExcerpts(stub, projectId, decisionHits, caller),
    buildMemoryExcerpts(stub, projectId, hazardHits, caller),
    buildMemoryExcerpts(stub, projectId, failedHits, caller),
    buildMemoryExcerpts(stub, projectId, relevantHits, caller),
    buildMemoryExcerpts(stub, projectId, unknownHits, caller),
  ]);

  const episodeExcerpts: ContextPackEpisodeExcerpt[] = effortResult.warnings.map((w) => ({
    excerptKind: 'episode',
    id: w.episodeId,
    runId: w.runId,
    taskId: w.taskId,
    taskKey: w.taskKey,
    runKind: w.runKind,
    outcome: w.outcome,
    landingOutcome: w.landingOutcome,
    whatWasAttempted: w.whatWasAttempted,
    whatFailed: w.whatFailed,
    whatRemainsUncertain: w.whatRemainsUncertain,
    support: w.support,
  }));

  function toGraphEntity(e: { uri: string; type: string; label: string; depth: number; edgePath: Array<{ fromNodeId: string; edgeType: string; toNodeId: string }> }): ContextPackGraphEntity {
    return { uri: e.uri, type: e.type, label: e.label, depth: e.depth, edgePath: e.edgePath.map((h) => `${h.fromNodeId}>${h.edgeType}>${h.toNodeId}`).join(';') };
  }
  const graphCandidates = [...depResult.downstream, ...depResult.upstream].map(toGraphEntity);
  const graphCoverage: ContextPackCoverage = depResult.coverage;

  const usedChangeImpact = 'impactedTests' in testsResult;
  const testCandidates = (usedChangeImpact ? testsResult.impactedTests : testsResult.tests).map(toGraphEntity);
  const testCoverage: ContextPackCoverage = testsResult.coverage;

  // ---- 3. Active neighboring work — file-lock overlap (discretion: cheap, real-time, D1-only;
  // see the module comment for why this beats scanning every task's own stored execution_spec) --
  interface NeighboringItem { path: string; lockId: string; holderAgentId: string; taskId: string | null; taskKey: string | null; taskTitle: string | null; taskStatus: string | null }
  const neighboringCandidates: NeighboringItem[] = [];
  let neighboringNotice: ContextPackNotice | null = null;
  if (!row.file_locking_enabled) {
    neighboringNotice = { kind: 'unanswerable', reason: 'file locking is disabled for this project — live lock state cannot be checked' };
  } else if (!anticipatedFiles.length) {
    neighboringNotice = { kind: 'unanswerable', reason: 'this task has no anticipatedFiles in its executionSpec — nothing to check for overlapping locks against' };
  } else {
    for (const path of anticipatedFiles) {
      let filePattern;
      try { filePattern = normalizePattern(path); } catch (err) { if (err instanceof LockPatternError) continue; throw err; }
      for (const lock of lockRows.results) {
        let lockPattern;
        try { lockPattern = normalizePattern(lock.canonPattern); } catch { continue; }
        if (!patternsOverlap(filePattern, lockPattern)) continue;
        neighboringCandidates.push({
          path, lockId: lock.id, holderAgentId: lock.agentId, taskId: lock.taskId,
          taskKey: lock.taskKey, taskTitle: lock.taskTitle, taskStatus: lock.taskStatus,
        });
      }
    }
  }

  // ---- 4. Fill sections in the FIXED order, rolling unused budget forward -------------------
  const sections: ContextPackSection[] = [];
  let pool = 0;
  let takenExcerptsSoFar: ContextPackExcerpt[] = [];

  for (const spec of SECTION_ORDER) {
    const cap = (allotments[spec.id] ?? 0) + pool;
    let section: ContextPackSection;

    switch (spec.id) {
      case 'active_decisions': {
        const { taken, used, truncated } = fillGreedy(decisionExcerpts, cap);
        section = {
          id: spec.id, provenance: taken.length ? memoryHitStages(decisionHits) : ['none'],
          notice: truncated ? { kind: 'truncated', reason: `${decisionExcerpts.length - taken.length} more decision(s) did not fit in ${cap} characters` } : null,
          charsAllotted: cap, charsUsed: used, excerpts: taken, graphEntities: [], coverage: null, items: [],
        };
        takenExcerptsSoFar = [...takenExcerptsSoFar, ...taken];
        break;
      }
      case 'known_hazards': {
        const { taken, used, truncated } = fillGreedy(hazardExcerpts, cap);
        section = {
          id: spec.id, provenance: taken.length ? memoryHitStages(hazardHits) : ['none'],
          notice: truncated ? { kind: 'truncated', reason: `${hazardExcerpts.length - taken.length} more hazard(s) did not fit in ${cap} characters` } : null,
          charsAllotted: cap, charsUsed: used, excerpts: taken, graphEntities: [], coverage: null, items: [],
        };
        takenExcerptsSoFar = [...takenExcerptsSoFar, ...taken];
        break;
      }
      case 'failed_approaches': {
        const { taken, used, truncated } = fillGreedy(failedExcerpts, cap);
        section = {
          id: spec.id, provenance: taken.length ? memoryHitStages(failedHits) : ['none'],
          notice: truncated ? { kind: 'truncated', reason: `${failedExcerpts.length - taken.length} more failed-approach record(s) did not fit in ${cap} characters` } : null,
          charsAllotted: cap, charsUsed: used, excerpts: taken, graphEntities: [], coverage: null, items: [],
        };
        takenExcerptsSoFar = [...takenExcerptsSoFar, ...taken];
        break;
      }
      case 'relevant_memories': {
        const { taken, used, truncated } = fillGreedy(relevantExcerpts, cap);
        section = {
          id: spec.id, provenance: taken.length ? memoryHitStages(relevantHits) : ['none'],
          notice: truncated ? { kind: 'truncated', reason: `${relevantExcerpts.length - taken.length} more memory item(s) did not fit in ${cap} characters` } : null,
          charsAllotted: cap, charsUsed: used, excerpts: taken, graphEntities: [], coverage: null, items: [],
        };
        takenExcerptsSoFar = [...takenExcerptsSoFar, ...taken];
        break;
      }
      case 'similar_episodes': {
        const { taken, used, truncated } = fillGreedy(episodeExcerpts, cap);
        section = {
          id: spec.id, provenance: taken.length ? ['similar-effort'] : ['none'],
          notice: truncated ? { kind: 'truncated', reason: `${episodeExcerpts.length - taken.length} more similar episode(s) did not fit in ${cap} characters` } : null,
          charsAllotted: cap, charsUsed: used, excerpts: taken, graphEntities: [], coverage: null, items: [],
        };
        takenExcerptsSoFar = [...takenExcerptsSoFar, ...taken];
        break;
      }
      case 'graph_neighborhood': {
        const { taken, used, truncated } = fillGreedy(graphCandidates, cap);
        const unanswerable = !graphCoverage.complete;
        section = {
          id: spec.id, provenance: taken.length ? ['graph'] : ['none'],
          notice: unanswerable
            ? { kind: 'unanswerable', reason: graphCoverage.reasons.join(', ') || 'this graph cannot fully answer that yet' }
            : truncated ? { kind: 'truncated', reason: `${graphCandidates.length - taken.length} more related entit(y/ies) did not fit in ${cap} characters` } : null,
          charsAllotted: cap, charsUsed: used, excerpts: [], graphEntities: taken, coverage: graphCoverage, items: [],
        };
        break;
      }
      case 'affected_tests': {
        const { taken, used, truncated } = fillGreedy(testCandidates, cap);
        const unanswerable = !testCoverage.complete;
        section = {
          id: spec.id, provenance: taken.length ? ['graph'] : ['none'],
          notice: unanswerable
            ? { kind: 'unanswerable', reason: testCoverage.reasons.join(', ') || 'this graph cannot fully answer that yet' }
            : truncated ? { kind: 'truncated', reason: `${testCandidates.length - taken.length} more test(s) did not fit in ${cap} characters` } : null,
          charsAllotted: cap, charsUsed: used, excerpts: [], graphEntities: taken, coverage: testCoverage, items: [],
        };
        break;
      }
      case 'active_neighboring_work': {
        if (neighboringNotice) { section = emptySection(spec.id, cap, neighboringNotice); break; }
        const { taken, used, truncated } = fillGreedy(neighboringCandidates as unknown as Record<string, unknown>[], cap);
        section = {
          id: spec.id, provenance: taken.length ? ['coordination'] : ['none'],
          notice: truncated ? { kind: 'truncated', reason: `${neighboringCandidates.length - taken.length} more overlapping lock(s) did not fit in ${cap} characters` } : null,
          charsAllotted: cap, charsUsed: used, excerpts: [], graphEntities: [], coverage: null, items: taken,
        };
        break;
      }
      case 'uncertainty': {
        interface UncertainQuestion { question: string; source: string }
        type UncertaintyCandidate = { form: 'memory'; excerpt: ContextPackMemoryExcerpt } | { form: 'question'; item: UncertainQuestion };
        const questionCandidates: UncertaintyCandidate[] = effortResult.warnings.flatMap((w) =>
          w.whatRemainsUncertain.map((q): UncertaintyCandidate => ({ form: 'question', item: { question: q, source: `episode ${w.runId}` } })),
        );
        const memoryCandidates: UncertaintyCandidate[] = unknownExcerpts.map((e): UncertaintyCandidate => ({ form: 'memory', excerpt: e }));
        const combined = [...memoryCandidates, ...questionCandidates];
        const sized = combined.map((c) => (c.form === 'memory' ? c.excerpt : c.item));
        const { taken: takenSized, used, truncated } = fillGreedy(sized, cap);
        const takenSet = new Set(takenSized);
        const takenCombined = combined.filter((c) => takenSet.has(c.form === 'memory' ? c.excerpt : c.item));
        const excerpts = takenCombined.filter((c): c is UncertaintyCandidate & { form: 'memory' } => c.form === 'memory').map((c) => c.excerpt);
        const items = takenCombined.filter((c): c is UncertaintyCandidate & { form: 'question' } => c.form === 'question').map((c) => c.item as unknown as Record<string, unknown>);
        section = {
          id: spec.id, provenance: excerpts.length ? memoryHitStages(unknownHits) : items.length ? ['similar-effort'] : ['none'],
          notice: truncated ? { kind: 'truncated', reason: `${combined.length - takenCombined.length} more uncertainty item(s) did not fit in ${cap} characters` } : null,
          charsAllotted: cap, charsUsed: used, excerpts, graphEntities: [], coverage: null, items,
        };
        takenExcerptsSoFar = [...takenExcerptsSoFar, ...excerpts];
        break;
      }
      case 'source_excerpts': {
        // A pure ROLLUP of what already survived its OWN section's budget above — no extra RPC
        // calls (the full excerpt objects, evidence included, were already built). This is the
        // one well-known place PLNR-270's quoted-evidence renderer can iterate every citation in
        // the pack without walking each section individually. De-duplicated by (kind, id): the
        // same memory/episode can legitimately surface via more than one earlier section (e.g. a
        // decision that is ALSO graph-reachable is not — graph hits don't feed excerpts, so this
        // only guards a hit appearing in two memory-kind buckets, which cannot happen since a
        // memory row has exactly one `kind`, but a defensive dedupe costs nothing and documents
        // the invariant this section relies on).
        const seen = new Set<string>();
        const pool2: ContextPackExcerpt[] = [];
        for (const e of takenExcerptsSoFar) {
          const key = `${e.excerptKind}:${e.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          pool2.push(e);
        }
        const { taken, used, truncated } = fillGreedy(pool2, cap);
        const stages = new Set<string>();
        for (const e of taken) if (e.excerptKind === 'memory') stages.add('exact'); else stages.add('similar-effort');
        section = {
          id: spec.id, provenance: taken.length ? [...stages] as ContextPackSection['provenance'] : ['none'],
          notice: truncated ? { kind: 'truncated', reason: `${pool2.length - taken.length} more citation(s) did not fit in ${cap} characters` } : null,
          charsAllotted: cap, charsUsed: used, excerpts: taken, graphEntities: [], coverage: null, items: [],
        };
        break;
      }
    }

    sections.push(section);
    pool = Math.max(0, cap - section.charsUsed);
  }

  // ---- 5. Populate the pre-existing (PLNR-244) flat fields with real content, byte-identical
  // shapes to what they always declared, now that this task is their first real writer. ---------
  const findSection = (id: ContextPackSectionId) => sections.find((s) => s.id === id)!;
  const memoryExcerptToItem = (e: ContextPackMemoryExcerpt): MemoryItem => ({
    id: e.id,
    projectId,
    kind: e.memoryKind,
    statement: e.statement,
    authority: e.authority,
    confidence: e.confidence,
    evidence: e.evidence.map((c) => ({
      repositoryKey: c.repositoryKey, branch: c.branch, baseId: c.baseId, path: c.path, symbol: c.symbol,
      contentHash: null,
      verificationState: c.verificationState,
    })),
    supersedesMemoryId: e.supersedesMemoryId,
    recordedByAgentId: e.recordedByAgentId,
    recordedAt: e.recordedAt,
  });

  const pack: ContextPack = {
    taskId: row.id,
    projectId,
    branch: input.branch ?? null,
    baseId: input.baseId ?? null,
    tokenBudget: input.tokenBudget ?? null,
    verifiedDecisions: findSection('active_decisions').excerpts
      .filter((e): e is ContextPackMemoryExcerpt => e.excerptKind === 'memory' && e.validity === 'active')
      .map(memoryExcerptToItem),
    relevantEntities: [...new Set([...findSection('graph_neighborhood').graphEntities.map((g) => g.uri), ...findSection('affected_tests').graphEntities.map((g) => g.uri)])],
    similarEpisodes: findSection('similar_episodes').excerpts.map((e) => e.id),
    knownHazards: findSection('known_hazards').excerpts
      .filter((e): e is ContextPackMemoryExcerpt => e.excerptKind === 'memory')
      .map(memoryExcerptToItem),
    affectedTests: findSection('affected_tests').graphEntities.filter((g) => g.type === 'test').map((g) => g.uri),
    activeNeighboringWork: [...new Set(findSection('active_neighboring_work').items.map((i) => i.taskId).filter((t): t is string => typeof t === 'string'))],
    staleWarnings: [
      ...findSection('uncertainty').excerpts.filter((e): e is ContextPackMemoryExcerpt => e.excerptKind === 'memory').map((e) => e.statement),
      ...findSection('uncertainty').items.map((i) => String(i.question ?? '')),
    ].filter(Boolean),
    // The ONE deliberately wall-clock field: "identical inputs produce a byte-identical pack"
    // (stated acceptance) is about the assembled CONTENT, not a fabricated request timestamp —
    // every other field above is built from real, live-read rows (never `nowIso()`) for exactly
    // this reason.
    generatedAt: nowIso(),
    role,
    mode: searchResult.mode as ContextPackMode,
    charBudget,
    charsUsed: taskFactsChars + sections.reduce((sum, s) => sum + s.charsUsed, 0),
    taskFacts,
    sections,
    notices: packNotices,
  };
  // PLNR-270 (§13, locked decision — "ONE renderer, no surface hand-rolls its own framing"): the
  // pack's structured fields above are unchanged (PLNR-267's own comment on `ContextPackMemoryExcerpt`
  // calls them "the structured seam" this task wraps, deliberately not pre-flattened into prose —
  // the UI explorer and REST twin still want raw, addressable fields). `evidenceFrame` is the
  // ADDITIVE agent-facing presentation: every decision/hazard/failed-approach/relevant-memory/
  // episode/uncertainty item, quoted, labelled, and budgeted SEPARATELY from everything above —
  // exhausting it can shrink or empty this one field; it has no path to `taskFacts` or any
  // section's own already-computed content, because it is built AFTER, and only reads, this pack.
  const evidenceFrame = renderEvidenceFrame(collectContextPackEvidenceItems(pack));
  return { ...pack, evidenceFrame };
}

// ---------------------------------------------------------------------------------------------
// PLNR-270: gather every section that carries agent- or repository-authored prose for
// `renderEvidenceFrame` (§13). Deliberately excludes `source_excerpts` (a de-duplicated ROLLUP of
// excerpts already rendered from their OWN section above — rendering it too would show the same
// evidence twice) and the graph/test/neighboring-work sections (structural facts — uri/type/label
// triples from the coordination or code graph, not free-form authored prose; see this task's own
// discretion note on repository-derived text).
// ---------------------------------------------------------------------------------------------

function memoryExcerptToEvidenceItem(e: ContextPackMemoryExcerpt): EvidenceFrameItem {
  return {
    id: e.id,
    label: e.memoryKind,
    text: e.statement,
    authority: e.authority,
    confidence: e.confidence,
    validity: e.validity,
    isLead: e.isLead,
    leadReasons: e.leadReasons,
    citations: e.evidence.map((c) => ({
      repositoryKey: c.repositoryKey, branch: c.branch, baseId: c.baseId, path: c.path, symbol: c.symbol,
      verificationState: c.verificationState, verifiedForCaller: c.verifiedForCaller,
    })),
    recordedAt: e.recordedAt,
    recordedByAgentId: e.recordedByAgentId,
  };
}

function episodeExcerptToEvidenceItem(e: ContextPackEpisodeExcerpt): EvidenceFrameItem {
  // Episodes carry no authority/validity of their own (§14 — a structurally different vocabulary
  // than memory's §12 scale) — every self-authored field (whatWasAttempted/whatFailed/
  // whatRemainsUncertain/support[].detail) is untrusted the same way a memory statement is (§13),
  // so it all goes inside the ONE quoted body rather than being split across renderer-owned lines
  // that don't exist for episodes.
  const parts = [e.whatWasAttempted];
  if (e.whatFailed.length) parts.push(`What failed:\n- ${e.whatFailed.join('\n- ')}`);
  if (e.whatRemainsUncertain.length) parts.push(`Remains uncertain:\n- ${e.whatRemainsUncertain.join('\n- ')}`);
  if (e.support.length) parts.push(`Support:\n${e.support.map((s) => `- ${s.kind}: ${s.detail}`).join('\n')}`);
  return {
    id: e.id,
    label: 'episode',
    text: `outcome: ${e.outcome} (landing: ${e.landingOutcome})\n\n${parts.join('\n\n')}`,
  };
}

/** Pure function of an already-assembled pack (locked decision: reads values the sections already
 *  computed — authority, validity, lead reasons, verification — never re-derives them). Exported
 *  so the adversarial test suite can drive it directly with hand-built packs, without a DO. */
export function collectContextPackEvidenceItems(pack: ContextPack): EvidenceFrameItem[] {
  const items: EvidenceFrameItem[] = [];
  const memorySectionIds: ContextPackSectionId[] = ['active_decisions', 'known_hazards', 'failed_approaches', 'relevant_memories'];
  for (const sectionId of memorySectionIds) {
    const section = pack.sections.find((s) => s.id === sectionId);
    for (const e of section?.excerpts ?? []) {
      if (e.excerptKind === 'memory') items.push(memoryExcerptToEvidenceItem(e));
    }
  }
  const episodes = pack.sections.find((s) => s.id === 'similar_episodes');
  for (const e of episodes?.excerpts ?? []) {
    if (e.excerptKind === 'episode') items.push(episodeExcerptToEvidenceItem(e));
  }
  const uncertainty = pack.sections.find((s) => s.id === 'uncertainty');
  for (const e of uncertainty?.excerpts ?? []) {
    if (e.excerptKind === 'memory') items.push(memoryExcerptToEvidenceItem(e));
  }
  for (const rawItem of uncertainty?.items ?? []) {
    const question = typeof rawItem.question === 'string' ? rawItem.question : null;
    if (question == null) continue; // a shape this section never actually produces beyond {question, source} — degrade, don't fail
    const source = typeof rawItem.source === 'string' ? rawItem.source : 'a prior episode';
    items.push({ id: `uncertainty:${items.length}`, label: 'uncertainty_question', text: `${question} (source: ${source})` });
  }
  return items;
}
