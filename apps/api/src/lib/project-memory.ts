// PLNR-246: the routing seam onto ProjectMemory (PLNR-245) — authorize, THEN route. Registry
// rows in D1 (migration 0069) route to the right DO; they never authorize by themselves.
// Possessing or forging a project_repositories row grants nothing — the check below always
// runs first, at the Worker boundary, before env.PROJECT_MEMORY.get() is ever called.
import type { Env } from '../env';
import type { ProjectMemoryHealth } from '../do/ProjectMemory';
import type { RankedHit } from '../memory/retrieval';
import { userCanAccessProject } from './visibility';

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
  evidence: Array<{ id: string; repositoryKey: string; branch: string; baseId: string; path: string; symbol: string | null; verificationState: string }>;
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
  promoteMemoriesOnMerge(
    projectId: string,
    input: { repositoryKey: string; branch: string; mergedBaseId: string },
  ): Promise<{ promoted: string[]; skipped: number }>;
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
      kind?: string;
      minAuthority?: number;
      validity?: string;
      limit?: number;
    },
  ): Promise<{ mode: 'semantic' | 'keyword'; results: RankedHit[] }>;
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

export interface ProjectRepositoryRow {
  id: string;
  projectId: string;
  repositoryKey: string;
  indexingEnabled: boolean;
  ingestStatus: 'none' | 'staged' | 'active' | 'failed';
  createdAt: string;
}

/** Straight D1 read (CLAUDE.md: reads go straight to D1; only writes cross into a DO) — no
 *  access check here, same as every other read helper in lib/. Callers guard access themselves
 *  (REST/MCP edges already do this for every other project-scoped read). */
export async function listProjectRepositories(env: Env, projectId: string): Promise<ProjectRepositoryRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT id, project_id, repository_key, indexing_enabled, ingest_status, created_at FROM project_repositories WHERE project_id = ? ORDER BY created_at',
  ).bind(projectId).all<{
    id: string;
    project_id: string;
    repository_key: string;
    indexing_enabled: number;
    ingest_status: string;
    created_at: string;
  }>();
  return results.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    repositoryKey: r.repository_key,
    indexingEnabled: !!r.indexing_enabled,
    ingestStatus: r.ingest_status as ProjectRepositoryRow['ingestStatus'],
    createdAt: r.created_at,
  }));
}
