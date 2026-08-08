// PLNR-246: the routing seam onto ProjectMemory (PLNR-245) — authorize, THEN route. Registry
// rows in D1 (migration 0069) route to the right DO; they never authorize by themselves.
// Possessing or forging a project_repositories row grants nothing — the check below always
// runs first, at the Worker boundary, before env.PROJECT_MEMORY.get() is ever called.
import type { Env } from '../env';
import type { ProjectMemoryHealth } from '../do/ProjectMemory';
import type { RankedHit } from '../memory/retrieval';
import type { DuplicateWarning, EffortSummary } from '../memory/similar-effort';
import type {
  DependencyNeighborhoodResult, ValidatingTestsResult, ImplementingWorkResult, DecisionLineageResult, ChangeImpactResult,
} from '../memory/graph-queries';
import type { SurfaceId } from '../memory/guidance-drift';
import { renderEvidenceFrame, type EvidenceFrameItem, type EvidenceFrameResult } from '../memory/evidence-frame';
import { userCanAccessProject } from './visibility';
import { readExecutionSpec } from './execution-spec';

/** PLNR-266: one stored, deduplicated guidance-drift finding — see ProjectMemory.
 *  listGuidanceDriftFindings and memory/guidance-drift.ts's DriftFinding for the full shape this
 *  is read back from. */
export interface GuidanceDriftFindingRecord {
  id: string;
  ruleId: string;
  description: string;
  presentSurfaces: SurfaceId[];
  missingSurfaces: SurfaceId[];
  unavailableSurfaces: SurfaceId[];
  quotes: Partial<Record<SurfaceId, string>>;
  recommendedEdit: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** An evidence citation as the write RPCs accept it — validated server-side (writes.ts) against
 *  the shared RepositoryKey/BranchRef/BaseId/RepoPath schemas; not re-validated here. */
export interface MemoryEvidenceInput {
  repositoryKey: string;
  branch: string;
  baseId: string;
  path: string;
  symbol?: string | null;
}
export interface MemoryActorRef {
  kind: string;
  id: string | null;
}
export interface MemoryItemRecord {
  id: string;
  kind: string;
  statement: string;
  authority: number;
  confidence: number | null;
  contentHash: string | null;
  repositoryKey: string | null;
  branch: string | null;
  baseId: string | null;
  validity: string;
  supersedesMemoryId: string | null;
  recordedByAgentId: string | null;
  recordedAt: string;
  proposedAt: string | null;
  rejectedAt: string | null;
  evidence: Array<{
    id: string; repositoryKey: string; branch: string; baseId: string; path: string; symbol: string | null;
    verificationState: string;
    /** The citation's stable identity (writes.ts's evidenceHash) — what a Runner verification
     *  report addresses this citation by (see VerificationReportCitationInput below). */
    evidenceHash: string | null;
    /** PLNR-265: when/against-what/by-whom this citation was last checked — null across the
     *  board for a citation no sweep or Runner report has ever reached. */
    lastVerifiedAt: string | null;
    lastVerifiedBaseId: string | null;
    lastVerifiedBranch: string | null;
    verificationSource: string | null;
    observedPath: string | null;
  }>;
}
/** One citation's verdict from a Runner's worktree-leased verification pass — see
 *  memory/verification.ts's `VerificationReportCitation` for the full field-by-field rationale.
 *  Re-declared here (not imported) because this is the STUB's own narrow view of the shape, the
 *  same convention `MemoryEvidenceInput` above already follows for evidence. */
export interface VerificationReportCitationInput {
  memoryItemId: string;
  evidenceHash: string;
  state: 'valid' | 'moved' | 'changed' | 'missing' | 'unverifiable';
  baseId: string;
  branch: string;
  observedPath?: string | null;
}

/** The subset of ProjectMemory's RPC surface callers outside the DO reach through. Widened as
 *  each phase adds a real API (PLNR-251's write APIs, PLNR-252's agent-facing tool + human
 *  reads) — the stub itself is untyped RPC, this is just the slice callers here are allowed to see. */
export interface ProjectMemoryStub {
  health(projectId: string): Promise<ProjectMemoryHealth>;
  erase(projectId: string): Promise<{ ok: true }>;
  recordMemory(
    projectId: string,
    input: {
      operationId?: string;
      kind: string;
      statement: string;
      authority?: number;
      confidence?: number | null;
      evidence?: MemoryEvidenceInput[];
      supersedesMemoryId?: string | null;
      scope?: { repositoryKey?: string; branch?: string; baseId?: string };
      actor: MemoryActorRef;
    },
  ): Promise<{ memoryId: string; operationId: string; deduped: boolean }>;
  addContradiction(
    projectId: string,
    input: { operationId?: string; memoryItemId: string; contradictsMemoryItemId: string; setId?: string | null; actor: MemoryActorRef },
  ): Promise<{ setId: string; contradictionId: string; operationId: string; deduped: boolean }>;
  recordFeedback(
    projectId: string,
    input: { operationId?: string; memoryItemId: string; vote: 'up' | 'down'; reason?: string | null; actor: MemoryActorRef },
  ): Promise<{ feedbackId: string; operationId: string; deduped: boolean }>;
  getMemoryItem(projectId: string, memoryId: string): Promise<MemoryItemRecord | null>;
  getContradictionSet(projectId: string, setId: string): Promise<{ setId: string; memoryItemIds: string[]; resolvedAt: string | null }>;
  listProposedDecisions(
    projectId: string,
  ): Promise<Array<{ id: string; statement: string; authority: number; recordedByAgentId: string | null; recordedAt: string; proposedAt: string }>>;
  approveDecision(
    projectId: string,
    input: { memoryItemId: string; actorUserId: string; note?: string | null; revision?: string | null },
  ): Promise<{ approvedMemoryId: string; transitionId: string }>;
  rejectDecision(projectId: string, input: { memoryItemId: string; actorUserId: string; note?: string | null }): Promise<{ ok: true; transitionId: string }>;
  /** PLNR-266: merge-evidence promotion, gated on PLNR-265's verification path — a candidate's
   *  citations must verify (verifiedForBase) at the merged (branch, baseId), not merely cite the
   *  right repository/branch. A skipped candidate is reported with its reason (no evidence, wrong
   *  repository/branch, or citations that do not verify at the merged base); never promotes past
   *  authority 4 (AUTHORITY_VERIFIED_MERGED) — see ProjectMemory's own doc comment. */
  promoteMemoriesOnMerge(
    projectId: string,
    input: { repositoryKey: string; branch: string; mergedBaseId: string },
  ): Promise<{ promoted: string[]; skipped: Array<{ memoryItemId: string; reason: string }> }>;
  /** PLNR-266: run the guidance-drift scan (memory/guidance-drift.ts's compareSurfaces) against
   *  caller-supplied surface text and persist deduplicated findings. This DO never reads
   *  INSTRUCTIONS/SKILL_MD/DOC_SKILL_MD itself — the caller (index.ts) owns importing the MCP
   *  layer's exports, keeping ProjectMemory ignorant of it. */
  recordGuidanceDriftScan(
    projectId: string,
    surfaces: Partial<Record<SurfaceId, string | null>>,
  ): Promise<{ findings: number; newFindings: number }>;
  /** PLNR-266: the stored, deduplicated guidance-drift findings for this project — read-only. */
  listGuidanceDriftFindings(projectId: string): Promise<GuidanceDriftFindingRecord[]>;
  /** PLNR-257: bounded multi-hop graph traversal from one or more seed nodes, each hit carrying
   *  the edge path back to its seed — the general read API `_traverseFrom` was a narrow
   *  test-only stand-in for. */
  traverseGraph(
    projectId: string,
    input: { seedNodeIds: string[]; edgeTypes?: string[]; maxDepth?: number; maxResults?: number },
  ): Promise<Array<{ nodeId: string; uri: string; type: string; label: string; depth: number; edgePath: string }>>;
  /** PLNR-257: the hybrid retrieval entry point — exact + lexical + semantic + bounded graph
   *  expansion, filtered/reranked/lead-labelled. Read-only. */
  searchProjectMemory(
    projectId: string,
    opts: {
      query?: string;
      memoryItemId?: string;
      episodeId?: string;
      taskId?: string;
      seedEntityUri?: string;
      edgeTypes?: string[];
      maxDepth?: number;
      repositoryKey?: string;
      branch?: string;
      /** PLNR-265: the caller's own opaque VCS revision — string-compared only, scopes whether a
       *  'valid' citation reads as verified FOR THIS CALLER (`evidence-base-mismatch`). */
      baseId?: string;
      kind?: string;
      minAuthority?: number;
      validity?: string;
      limit?: number;
    },
  ): Promise<{ mode: 'semantic' | 'keyword'; results: RankedHit[] }>;
  /** PLNR-265: the cheap server-side citation-verification tier — one memory (`memoryItemId`) or
   *  a bounded oldest/never-verified sweep (`limit`) when omitted. See ProjectMemory's own doc
   *  comment for what a 'valid'/'missing'/'changed'/'unverifiable' verdict does and does not
   *  prove. Never throws for a repository with no active index generation. */
  verifyMemoryCitations(
    projectId: string,
    input: { memoryItemId?: string; limit?: number },
  ): Promise<{ checked: number; updated: number; results: Array<{ evidenceId: string; memoryItemId: string; verificationState: string }> }>;
  /** PLNR-265: the Runner worktree-verification (thorough) tier's landing point. Idempotent by
   *  (evidenceHash, reported base, reported state) — see ProjectMemory.acceptVerificationReport's
   *  own doc comment. */
  acceptVerificationReport(
    projectId: string,
    report: { citations: VerificationReportCitationInput[]; source: string },
    actor: MemoryActorRef,
  ): Promise<{ applied: number; skipped: number; touchedMemoryIds: string[] }>;
  /** PLNR-264: has this task's likely area of work already been attempted? Read-only —
   *  see ProjectMemory.similarEffort's own doc comment for the full retrieval story. */
  similarEffort(
    projectId: string,
    input: { taskId: string; title: string; body?: string | null; anticipatedFiles?: string[]; limit?: number },
  ): Promise<{ warnings: DuplicateWarning[]; summary: EffortSummary; consideredCount: number }>;
  /** PLNR-258: named graph-query primitives — see memory/graph-queries.ts for the shared
   *  completeness-marker contract every one of these returns. */
  dependencyNeighborhood(
    projectId: string,
    input: { entityUri: string; edgeTypes?: string[]; maxDepth?: number; maxResults?: number },
  ): Promise<DependencyNeighborhoodResult>;
  validatingTests(projectId: string, input: { entityUri: string; maxDepth?: number; maxResults?: number }): Promise<ValidatingTestsResult>;
  implementingWork(projectId: string, input: { entityUri: string; maxDepth?: number; maxResults?: number }): Promise<ImplementingWorkResult>;
  decisionLineage(projectId: string, input: { decisionUri: string; maxDepth?: number; maxResults?: number }): Promise<DecisionLineageResult>;
  changeImpact(projectId: string, input: { entityUris: string[]; maxDepth?: number; maxResults?: number }): Promise<ChangeImpactResult>;
  /** PLNR-255: re-embed this project's memories/episodes into the operational search index and
   *  clear `project_memory_registry.vector_dirty` on success (Phase 4's fill-in of the Phase
   *  2/3 no-op hook). No-ops honestly when no embeddings backend is bound. */
  rebuildVectorIndex(projectId: string): Promise<{ ok: true; rebuilt: boolean; reason?: string; reindexed?: number }>;
  /** PLNR-255: fill display fields (+ LIVE authority/validity) for memory/episode vector
   *  matches — search.ts's hydrate() calls this once per distinct projectId in a match set. */
  hydrateSearchHits(
    projectId: string,
    refs: Array<{ kind: 'memory' | 'episode'; id: string }>,
  ): Promise<Array<{ kind: 'memory' | 'episode'; id: string; title: string; snippet: string; status?: string; authority?: number; validity?: string }>>;
  /** PLNR-255: the no-Vectorize lexical fallback over memory_items/episodes — memory content
   *  never reaches D1, so this scan runs INSIDE ProjectMemory rather than as a D1 query. */
  searchMemoryLexical(
    projectId: string,
    opts: { q: string; kinds?: Array<'memory' | 'episode'>; limit?: number },
  ): Promise<Array<{ kind: 'memory' | 'episode'; id: string; title: string; snippet: string; score: number; status?: string; authority?: number; validity?: string }>>;
  /** PLNR-260: repository-index ingest — TRANSPORT only, in-memory bridge state (PLNR-261 adds
   *  the durable staged-generation tables this will drive instead). */
  beginIndexIngest(projectId: string, manifest: { generationId: string; projectId: string; repositoryKey: string; branch: string; baseId: string; indexerVersion: string; batchCount: number; fileCount: number; contentHash: string; deletions: string[]; createdAt: string }): Promise<{ ok: true }>;
  ingestIndexBatch(projectId: string, batch: { generationId: string; batchNumber: number; batchHash: string }, rows: Array<Record<string, unknown>>): Promise<{ ok: true; deduped: boolean }>;
  completeIndexIngest(projectId: string, generationId: string): Promise<{ ok: true; batchesReceived: number; rowCount: number }>;
  abortIndexIngest(projectId: string, generationId: string): Promise<{ ok: true }>;
  indexIngestStatus(projectId: string, generationId: string): Promise<{ status: 'unknown' | 'pending' | 'complete' | 'aborted'; batchesReceived: number; batchesExpected: number | null }>;
  /** PLNR-260: episode ingest — endpoint only; real episode RECORD semantics are PLNR-263's. */
  beginEpisodeIngest(projectId: string, manifest: { scopeId: string; projectId: string; batchCount: number }): Promise<{ ok: true }>;
  ingestEpisodeBatch(projectId: string, scopeId: string, batchNumber: number, rows: Array<Record<string, unknown>>): Promise<{ ok: true; deduped: boolean }>;
  completeEpisodeIngest(projectId: string, scopeId: string): Promise<{ ok: true; batchesReceived: number; rowCount: number }>;
  abortEpisodeIngest(projectId: string, scopeId: string): Promise<{ ok: true }>;
  episodeIngestStatus(projectId: string, scopeId: string): Promise<{ status: 'unknown' | 'pending' | 'complete' | 'aborted'; batchesReceived: number; batchesExpected: number | null }>;
}

/**
 * Resolve a ProjectMemory stub for `projectId`, but only after confirming `userId` can reach
 * that project. Throws (not-found, matching the rest of the codebase's leak-free style — see
 * mcp.ts's `userCanAccessProject` call sites) rather than distinguishing "no access" from
 * "doesn't exist".
 */
export async function projectMemory(env: Env, userId: string, projectId: string): Promise<ProjectMemoryStub> {
  if (!(await userCanAccessProject(env, userId, projectId))) {
    throw new Error(`project ${projectId} not found`);
  }
  return env.PROJECT_MEMORY.get(env.PROJECT_MEMORY.idFromName(projectId)) as unknown as ProjectMemoryStub;
}

export type SimilarEffortResult = { warnings: DuplicateWarning[]; summary: EffortSummary; consideredCount: number };

// PLNR-270 (§13): `whatWasAttempted`/`whatFailed`/`whatRemainsUncertain` are past-agent prose —
// untrusted the same way a memory statement is — and `priorEffort` hands them to an agent at the
// MOMENT it starts work, before anything else. Mirrors `context-pack.ts`'s
// `episodeExcerptToEvidenceItem` (the SAME `DuplicateWarning` shape, produced by the SAME
// `ProjectMemory.similarEffort` RPC) as its own small adapter rather than a shared export: the two
// call sites key episodes differently (`id` vs `episodeId`) and a shared helper would need to
// bridge that for no real savings. `renderEvidenceFrame` itself is NOT reimplemented here — same
// renderer, imported, same as every other surface.
function duplicateWarningToEvidenceItem(w: DuplicateWarning): EvidenceFrameItem {
  const parts = [w.whatWasAttempted];
  if (w.whatFailed.length) parts.push(`What failed:\n- ${w.whatFailed.join('\n- ')}`);
  if (w.whatRemainsUncertain.length) parts.push(`Remains uncertain:\n- ${w.whatRemainsUncertain.join('\n- ')}`);
  if (w.support.length) parts.push(`Support:\n${w.support.map((s) => `- ${s.kind}: ${s.detail}`).join('\n')}`);
  return {
    id: w.episodeId,
    label: 'episode',
    text: `outcome: ${w.outcome} (landing: ${w.landingOutcome})\n\n${parts.join('\n\n')}`,
  };
}

/**
 * PLNR-264: the ONE place `can_claim`/`claim_task` (mcp.ts) and the human REST twin (index.ts)
 * call into `ProjectMemory.similarEffort` — so the two surfaces can't drift on how a task's
 * title/body/anticipatedFiles become the RPC's input. Never throws: a memory failure (the DO
 * unreachable, a malformed stored execution spec) degrades to `null` — "no priorEffort block" —
 * per this task's own locked decision that memory retrieval must never touch a claim (§19).
 *
 * PLNR-270: `evidenceFrame` is ADDITIVE, same pattern as `assembleContextPack`/
 * `assembleProjectMemoryPulse`/`search_project_memory` — the raw `warnings[]` fields stay in
 * place for programmatic/UI inspection (a `support` entry's `detail` is genuinely useful to show
 * structured), but a caller building an agent-facing PROMPT should read `evidenceFrame`, never the
 * raw text fields, as the untrusted-content presentation.
 */
export async function loadPriorEffort(
  env: Env,
  projectId: string,
  task: { id: string; title: string; body: string | null; executionSpec: string | null },
): Promise<(SimilarEffortResult & { evidenceFrame: EvidenceFrameResult }) | null> {
  try {
    const stored = readExecutionSpec(task.executionSpec, task.id);
    const anticipatedFiles = stored.spec?.anticipatedFiles?.map((f) => f.path) ?? [];
    const stub = env.PROJECT_MEMORY.get(env.PROJECT_MEMORY.idFromName(projectId)) as unknown as ProjectMemoryStub;
    const result = await stub.similarEffort(projectId, { taskId: task.id, title: task.title, body: task.body, anticipatedFiles });
    const evidenceFrame = renderEvidenceFrame(result.warnings.map(duplicateWarningToEvidenceItem));
    return { ...result, evidenceFrame };
  } catch (err) {
    console.warn(`similarEffort lookup failed for task ${task.id} in project ${projectId}: ${String(err)}`);
    return null;
  }
}

export interface ProjectRepositoryRow {
  id: string;
  projectId: string;
  repositoryKey: string;
  indexingEnabled: boolean;
  ingestStatus: 'none' | 'staged' | 'active' | 'failed';
  defaultBranch: string | null;
  vcsKind: string | null;
  branchClasses: string[];
  latestObservedBase: string | null;
  /** A D1-side PROJECTION of the ProjectMemory DO's index_generations.status='active' — never
   *  authority; mirrored DO -> ProjectRoom -> D1 (see ProjectRoom.setRepositoryActiveGeneration). */
  activeGenerationId: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface RepositoryCheckoutRow {
  id: string;
  projectRepositoryId: string;
  runnerId: string;
  /** RunnerRepo.id — display/association data only, never canonical identity. */
  checkoutId: string;
  createdAt: string;
  updatedAt: string;
}

/** Straight D1 read (CLAUDE.md: reads go straight to D1; only writes cross into a DO) — no
 *  access check here, same as every other read helper in lib/. Callers guard access themselves
 *  (REST/MCP edges already do this for every other project-scoped read). */
export async function listProjectRepositories(env: Env, projectId: string): Promise<ProjectRepositoryRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, project_id, repository_key, indexing_enabled, ingest_status,
            default_branch, vcs_kind, branch_classes, latest_observed_base, active_generation_id,
            created_at, updated_at
     FROM project_repositories WHERE project_id = ? ORDER BY created_at`,
  ).bind(projectId).all<{
    id: string;
    project_id: string;
    repository_key: string;
    indexing_enabled: number;
    ingest_status: string;
    default_branch: string | null;
    vcs_kind: string | null;
    branch_classes: string;
    latest_observed_base: string | null;
    active_generation_id: string | null;
    created_at: string;
    updated_at: string | null;
  }>();
  return results.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    repositoryKey: r.repository_key,
    indexingEnabled: !!r.indexing_enabled,
    ingestStatus: r.ingest_status as ProjectRepositoryRow['ingestStatus'],
    defaultBranch: r.default_branch,
    vcsKind: r.vcs_kind,
    branchClasses: JSON.parse(r.branch_classes || '[]'),
    latestObservedBase: r.latest_observed_base,
    activeGenerationId: r.active_generation_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/** Resolve one repository by its committed key within a project — the read side of
 *  registerRepository/associateCheckout, and how a caller (e.g. the ingest endpoints in
 *  PLNR-260) turns a repositoryKey into the canonical row before minting a scoped capability. */
export async function resolveRepositoryByKey(env: Env, projectId: string, repositoryKey: string): Promise<ProjectRepositoryRow | null> {
  const rows = await listProjectRepositories(env, projectId);
  return rows.find((r) => r.repositoryKey === repositoryKey) ?? null;
}

/** Straight D1 read of a canonical repository's checkout associations — the human-facing view
 *  of which runner-local checkouts converge on it. */
export async function listRepositoryCheckouts(env: Env, projectRepositoryId: string): Promise<RepositoryCheckoutRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT id, project_repository_id, runner_id, checkout_id, created_at, updated_at FROM repository_checkouts WHERE project_repository_id = ? ORDER BY created_at',
  ).bind(projectRepositoryId).all<{
    id: string; project_repository_id: string; runner_id: string; checkout_id: string; created_at: string; updated_at: string;
  }>();
  return results.map((r) => ({
    id: r.id,
    projectRepositoryId: r.project_repository_id,
    runnerId: r.runner_id,
    checkoutId: r.checkout_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}
