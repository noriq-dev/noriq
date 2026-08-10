import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { newId, nowIso } from '../lib/util';
import {
  buildEntityUri, parseEntityUri, AUTHORITY_HYPOTHESIS, AUTHORITY_HUMAN_APPROVED, AUTHORITY_VERIFIED_MERGED,
  EffortEpisode, EpisodeSelfSummary, type EffortEpisode as EffortEpisodeData,
  ProjectIntelligenceEpisode,
  ProjectQualityEvent,
  evidenceHash, type EpisodeLandingOutcome, type MemoryBackupManifest,
} from '@noriq-dev/shared';
import { projectCoordinationEvents, type ProjectedEvent } from '../lib/memory-projector';
import { exportMemorySnapshot, sha256HexBytes } from '../memory/backup';
import { fetchManifest, readSnapshotChunks, checkManifestHeader } from '../memory/restore';
import { deleteAllProjectBackups, sizeStatus, type EraseReport, type EraseStepResult } from '../memory/lifecycle';
import { MEMORY_MIGRATIONS } from '../memory/migrations';
import {
  validateMemoryScope, classifyEvidenceCitation, memoryContentHash, clampAuthority,
  type MemoryScope, type EvidenceCitation,
} from '../memory/writes';
import { searchBackend, indexEntity, removeEntity, clampMetadataTopK } from '../search';
import { codeSearchBackend, indexCodeEntity, removeCodeEntity, type CodeEntityType } from '../memory/code-index';
import {
  parseStagedRow,
  OrderedStagedContentHasher, stagedRowsCanonicalBytes,
  MAX_INDEX_GENERATION_BATCHES, MAX_INDEX_GENERATION_BYTES, MAX_INDEX_GENERATION_FILES, MAX_INDEX_GENERATION_ROWS,
  beginIngestEpisode, applyIngestEpisodeBatch, completeIngestEpisode, abortIngestEpisode, type IngestEpisodeState,
  type EpisodeUploadManifest,
} from '../memory/ingest';
import { IndexGenerationManifest, type IndexBatch } from '@noriq-dev/shared';
import {
  projectionEntityProblem, projectionEdgeTypeProblem, coChangePairs, CO_CHANGE_PAIR_CAP,
  mapCoordinationEvent, evidenceCitationNodes, EVIDENCE_EDGE_TYPE,
} from '../memory/projection';
import type { ProjectedEdgeDescriptor } from '../memory/projection';
import {
  buildConstellationHierarchy, constellationSourceIsCurrent,
  constellationEdgeBaseWeight,
  CONSTELLATION_LAYOUT_VERSION, CONSTELLATION_TOPOLOGY_VERSION,
  type PriorConstellationCommunity,
} from '../memory/constellation-hierarchy';
import {
  clampConstellationLimit, constellationEntityPosition, cursorMatches, decodeConstellationCursor, encodeConstellationCursor,
  CONSTELLATION_V2_DEFAULT_ENTITY_LIMIT, CONSTELLATION_V2_DEFAULT_INCIDENT_LIMIT,
  CONSTELLATION_V2_MAX_ENTITY_LIMIT, CONSTELLATION_V2_MAX_INCIDENT_LIMIT, CONSTELLATION_V2_MAX_OVERVIEW_ROUTES,
  type ConstellationV2AggregateRoute, type ConstellationV2Community, type ConstellationV2CommunityPage,
  type ConstellationV2Coverage, type ConstellationV2Head, type ConstellationV2IncidentPage, type ConstellationV2Overview,
  type ConstellationV2RawEdge, type ConstellationV2Revision, type ConstellationV2Route, type ConstellationV2Unavailable,
} from '../memory/constellation-v2';
import {
  applyMemoryFilters, classifyLead, dedupeCandidates, rankCandidates, RETRIEVAL_DEFAULTS,
  type RetrievalHit, type RetrievalStage, type RankedHit,
} from '../memory/retrieval';
import {
  dependencyNeighborhood, validatingTests, implementingWork, decisionLineage, changeImpact, constellation, listGraphEntities,
  type GraphEntityRef, type DependencyNeighborhoodResult, type ValidatingTestsResult,
  type ImplementingWorkResult, type DecisionLineageResult, type ChangeImpactResult, type ConstellationResult, type ConstellationOptions,
  type GraphEntityPage, type GraphEntityPageInput, type ConstellationInputRows,
} from '../memory/graph-queries';
import { EpisodeSkeletonUnavailableError, loadEpisodeSkeleton } from '../memory/episodes';
import type { EpisodeIntelligenceDraft } from '../lib/run-sitting-intelligence';
import { normalizeAnalyticsEpisode } from '../memory/analytics-normalize';
import {
  aggregateHistoricalAnalytics, HISTORICAL_ANALYTICS_MAX_ROWS, validateHistoricalAnalyticsQuery,
  type HistoricalAnalyticsQuery, type HistoricalAnalyticsResult,
} from '../memory/analytics-query';
import {
  requestProjectAnalyticsRebuild,
  type AnalyticsExecutionEventSnapshot,
  type AnalyticsExecutionNodeSnapshot,
  type AnalyticsQualityEventSnapshot,
  type AnalyticsSnapshotRow,
} from '../memory/analytics';
import {
  effortSignals, duplicateWarnings, priorEffortCase, summarizeEffort,
  type TaskEffortInput, type EffortCandidate, type DuplicateWarning, type EffortSummary,
  type PriorEffortCase, type PriorEffortMemorySupport,
} from '../memory/similar-effort';
import {
  citationVerdict, verifiedForBase, rollUpValidity,
  type CitationCheck, type CallerBaseScope, type VerificationReport,
} from '../memory/verification';
import { compareSurfaces, findingHash, type SurfaceId } from '../memory/guidance-drift';
import type { MemoryReviewQueue, MemoryReviewReason } from '../lib/project-memory';

/**
 * ProjectMemory — one instance per project (idFromName(projectId)), canonical
 * writer and query authority for the project's cognitive memory (Project
 * Memory §2). Separate from ProjectRoom on purpose: graph traversal, ingest,
 * and backup workloads must never sit on coordination mutation latency (§19).
 *
 * This is the FIRST Durable Object in this repo to use the SQLite storage API
 * (`ctx.storage.sql`) directly — ProjectRoom is D1-backed, and AgentSession /
 * RateLimiter / RunnerHub use plain KV storage. The DO's own SQLite is the
 * canonical store; D1 keeps only compact routing/registry rows (PLNR-246), and
 * nothing here parses or normalizes a VCS `baseId` (PLNR-244 keeps that opaque).
 *
 * PLNR-247 adds the outbox<->coordination bridge: a canonical mutation writes its outbox row in
 * the SAME SQLite transaction as the mutation itself; `drainOutbox` delivers pending rows to
 * ProjectRoom (idempotent — retrying is safe, the receiver dedupes); `runProjector` reads D1
 * coordination events past this project's durable `global_seq` cursor and projects a minimal set
 * of them into the graph, advancing the cursor atomically with each projection write. No
 * Queues/Workflows binding exists in this repo (env.ts declares none), so a DO alarm plus the
 * explicit `reconcile` RPC are the whole delivery mechanism — correctness rests on the durable
 * cursor and outbox replay alone, never on a wakeup actually arriving.
 *
 * PLNR-251 adds the real memory/evidence/graph write APIs (`recordMemory`, `writeNode`,
 * `writeEdge`, `addContradiction`) — see the block comment above that section for their shared
 * shape. Later phases (retrieval, ingest, episodes, approval) build on top of these.
 */

// This DO's internal SQLite schema lives in apps/api/memory-migrations — real `.sql` files, one
// per version and nothing else, ordered by the manifest in ../memory/migrations.ts. Adding a
// migration is a new file plus one manifest entry; the rules (never edit a shipped migration;
// stay additive) are documented there. Note that directory is a SIBLING of apps/api/migrations,
// which is D1's and is applied by the wrangler CLI — the two must never be mixed.

export interface ProjectMemoryHealth {
  projectId: string;
  schemaVersion: number;
  memoryRevision: number;
  tableCounts: Record<string, number>;
  databaseSize: number;
  sizeStatus: 'ok' | 'warn' | 'critical';
  /** PLNR-273: whether a retained prior generation exists to roll back to (the same
   *  `_meta.has_prior_generation` flag `rollback()` itself checks) — surfaced so an operator
   *  panel can disable-and-explain rollback/discard controls instead of offering one that would
   *  return `{ ok: false }`. */
  hasPriorGeneration: boolean;
}

/** PLNR-320: one relationship kind's drift subtotal — see `ProjectMemory.projectionDrift`'s own
 *  doc comment for the full contract. `expected` is how many edges `rebuildProjection` currently
 *  expects to exist; `missing` counts absent expected triples, while `unexpected` counts stale
 *  projector-owned triples whose backing D1 relationship no longer exists. */
export interface ProjectionDriftCategory {
  expected: number;
  missing: number;
  /** Projection-owned edges that still exist even though their backing D1 relationship does
   *  not. User-authored edges (which carry no coordination provenance) are never counted here. */
  unexpected: number;
}

/** PLNR-320/PLNR-325: `ProjectMemory.projectionDrift`'s full report — one category per
 *  relationship kind `rebuildProjection` itself covers, plus missing/unexpected totals. `runs`
 *  covers
 *  the run -> anchor `related_to` edge (PLNR-325 gave `rebuildProjection` run coverage, so drift
 *  can now usefully point at it — an unanchored run, or one whose anchor no longer resolves,
 *  contributes no `expected` entry, same as a cross-project dependency blocker). Surfaced on
 *  `GET /memory/ops-status`. */
export interface ProjectionDriftReport {
  phaseTasks: ProjectionDriftCategory;
  taskDocs: ProjectionDriftCategory;
  dependencies: ProjectionDriftCategory;
  runs: ProjectionDriftCategory;
  ownership: ProjectionDriftCategory;
  totalMissing: number;
  totalUnexpected: number;
}

type ProjectionRelationshipCategory = 'phaseTasks' | 'taskDocs' | 'dependencies' | 'runs' | 'ownership';

interface ExpectedProjectionEdge {
  category: ProjectionRelationshipCategory;
  type: string;
  fromUri: string;
  toUri: string;
  provenance: string;
}

interface StoredProjectedEdge extends ExpectedProjectionEdge {
  id: string;
}

interface CoordinationRelationships {
  tasks: { results: Array<{ id: string; title: string }> };
  plans: { results: Array<{ id: string; title: string }> };
  docs: { results: Array<{ id: string; name: string }> };
  milestones: { results: Array<{ id: string; title: string }> };
  agents: { results: Array<{ id: string; name: string }> };
  taskPlanLinks: { results: Array<{ taskId: string; planId: string }> };
  taskDocLinks: { results: Array<{ taskId: string; docId: string }> };
  taskDependencies: { results: Array<{ taskId: string; dependsOnId: string }> };
  taskClaims: { results: Array<{ taskId: string; agentId: string }> };
  runs: { results: Array<{ id: string; kind: string; anchorType: string | null; anchorId: string | null }> };
}

const projectionEdgeKey = (edge: { type: string; fromUri: string; toUri: string }): string =>
  `${edge.type}\0${edge.fromUri}\0${edge.toUri}`;

const projectionCategoryForProvenance = (provenance: string | null): ProjectionRelationshipCategory | null => {
  switch (provenance) {
    case 'coordination:phase_tasks':
    case 'event:plan.tasks_linked':
      return 'phaseTasks';
    case 'coordination:task_docs':
    case 'event:task.docs_linked':
      return 'taskDocs';
    case 'coordination:dependencies':
    case 'event:dependency.added':
      return 'dependencies';
    case 'coordination:runs':
    case 'event:run.created':
      return 'runs';
    case 'coordination:task_claims':
    case 'event:task.claimed':
    case 'event:task.handed_off':
      return 'ownership';
    default:
      return null;
  }
};

/** PLNR-273: one `index_generations` row as an operator-facing read — everything a human needs
 *  to judge whether a staged generation is safe to activate, without re-deriving validity
 *  client-side. `validationProblems` is always an array (never the raw JSON-or-null column). */
export interface IndexGenerationSummary {
  id: string;
  repositoryKey: string;
  branch: string;
  baseId: string;
  indexerVersion: string;
  status: 'staged' | 'active' | 'superseded';
  batchCount: number;
  fileCount: number;
  sealedAt: string | null;
  validationProblems: string[];
  createdAt: string;
  activatedAt: string | null;
}

interface AnalyticsHealthGenerationRow {
  [key: string]: string | number | null;
  id: string;
  status: 'building' | 'complete' | 'failed';
  extractionVersion: string;
  buildMode: 'incremental' | 'full';
  sourceMemoryRevision: number;
  d1EventWatermark: number | null;
  orchestrationWatermark: string | null;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}

/**
 * `recordEpisode`'s input (PLNR-263/340): the deterministic skeleton (matching
 * `memory/episodes.ts`'s `EpisodeSkeleton`) plus daemon-owned enrichment, provenance, and an
 * explicit merge mode. Identity and skeleton evidence are always resolved from `runs` and its
 * related D1 rows, never trusted from an upload. `taskTitle` is only a label hint for the task
 * node; it is not persisted in the episode body.
 *
 * `sitting` (correction, migration 0075/0007): an episode's identity is (run_id, sitting), NOT
 * run_id alone. `ProjectRoom.reopenRun` reuses one run id across multiple sittings (RUN-182) —
 * without this, a reopened run's terminal transition would upsert straight over the failed
 * sitting's episode, destroying evidence §14 requires stay retrievable. Always the run's OWN
 * `runs.sitting` value, resolved by the caller the same way the other identity fields are —
 * never trusted from an uploaded payload.
 */
interface RecordEpisodeInput {
  runId: string;
  sitting: number;
  agentId: string | null;
  runKind: string;
  outcome: string;
  startedAt: string | null;
  finishedAt: string | null;
  taskId: string | null;
  taskTitle?: string | null;
  repositoryKey: string | null;
  baseId: string | null;
  timeline: Array<{ at: string; label: string }>;
  filesTouched?: string[];
  commands?: string[];
  testsRun?: string[];
  failures?: string[];
  findings?: Array<{ summary: string; severity?: string }>;
  reviewRounds: number;
  tokenUsage: Record<string, unknown>;
  costUSD: number;
  acceptanceCoverage: number | null;
  steeringEvents: string[];
  landingOutcome: string;
  remainingWork: string[];
  intelligence?: EpisodeIntelligenceDraft;
  selfSummary?: unknown;
  actor: { kind: string; id: string | null };
  /** Direct callers replace enrichment by default. Skeleton replays preserve it; daemon
   * uploads replace only enrichment fields they actually supplied. */
  writeMode?: 'replace' | 'skeleton' | 'enrichment';
}

export const CANONICAL_TABLES = [
  'repositories',
  'index_generations',
  // PLNR-261's staged-generation tables: children of index_generations by convention (no real
  // FK — see the migration's comment), so they must come right after it here too, both for
  // backup/restore's generic parent-first/child-first ordering and for erase()'s reverse pass.
  'index_batches',
  'index_staged_entities',
  'index_staged_edges',
  'nodes',
  'edges',
  'memory_items',
  'evidence',
  'feedback',
  'contradiction_sets',
  'contradictions',
  'memory_authority_transitions',
  'episodes',
  'outbox',
] as const;

/** PLNR-373: derived Constellation v2 generations. Counted in health and erased with the project,
 * but deliberately absent from portable backup/restore: canonical nodes/edges rebuild them. */
export const CONSTELLATION_DERIVED_TABLES = [
  'constellation_generations',
  'constellation_node_stats',
  'constellation_communities',
  'constellation_memberships',
  'constellation_community_links',
] as const;

export const SCHEMA_TABLES = [...CANONICAL_TABLES, ...CONSTELLATION_DERIVED_TABLES] as const;

// Operational ledgers (PLNR-247) that are not part of SCHEMA_TABLES' health/erase accounting
// (health counts them separately below; erase clears them explicitly) but that a faithful
// backup/restore (PLNR-248/249) must carry — a restore missing these would re-project already
// consumed coordination events and re-deliver already-emitted operations on the next reconcile.
export const OPERATIONAL_TABLES = ['applied_operations', 'memory_revision', 'projector_cursor'] as const;

/** Every table a backup (PLNR-248) exports and a restore (PLNR-249) imports, parents before
 *  children — the same generic per-table chunking applies to both graph data and the
 *  operational singletons (memory_revision, projector_cursor are one row each, chunked the same
 *  way as everything else rather than carved into bespoke manifest fields). */
export const BACKUP_TABLES = [...CANONICAL_TABLES, ...OPERATIONAL_TABLES] as const;

export interface ConstellationGenerationData {
  nodeStats: Array<{ nodeId: string; degree: number; weightedDegree: number; rank: number; boundaryDegree: number }>;
  communities: Array<{
    id: string; parentId: string | null; level: number; label: string; memberCount: number; childCount: number;
    typeCounts: Record<string, number>; internalEdgeCount: number; internalWeight: number; normalizedCohesion: number; boundaryWeight: number;
    anchor: [number, number, number];
  }>;
  memberships: Array<{ nodeId: string; communityId: string; level: number }>;
  links: Array<{
    level: number; fromCommunityId: string; toCommunityId: string; direction: 'forward' | 'reverse' | 'both';
    count: number; weight: number; byType: Record<string, number>;
  }>;
}

export interface ConstellationGenerationStatus {
  id: string;
  sourceRevision: number;
  currentRevision: number;
  topologyVersion: string;
  layoutVersion: string;
  status: 'building' | 'complete' | 'active' | 'superseded' | 'failed';
  createdAt: string;
  completedAt: string | null;
  activatedAt: string | null;
  failureReason: string | null;
}

export interface ConstellationHierarchyDrift {
  activeGenerationId: string | null;
  sourceRevision: number | null;
  currentRevision: number;
  stale: boolean;
  canonicalNodes: number;
  canonicalEdges: number;
  missingNodeStats: number;
  extraNodeStats: number;
  invalidMemberships: number;
  missingAggregatedEdges: number;
  unexpectedAggregatedEdges: number;
  converged: boolean;
}

export interface ConstellationHierarchyOperations {
  state: 'current' | 'stale' | 'building' | 'failed' | 'unavailable';
  active: ConstellationGenerationStatus | null;
  building: ConstellationGenerationStatus | null;
  lastFailed: ConstellationGenerationStatus | null;
  rows: { nodeStats: number; communities: number; memberships: number; links: number };
  cache: { policy: 'private-revalidate'; compactPageTargetBytes: number; compactPageHardLimitBytes: number };
}

interface ConstellationGenerationRow {
  [column: string]: string | number | null;
  id: string;
  source_revision: number;
  topology_version: string;
  layout_version: string;
  status: ConstellationGenerationStatus['status'];
  created_at: string;
  completed_at: string | null;
  activated_at: string | null;
  failure_reason: string | null;
}

/**
 * A daemon upload is deliberately a PARTIAL enrichment, not an `EffortEpisode` replacement.
 * D1 owns identity, lifecycle, task/repository association, cost and review evidence. Unknown
 * keys are stripped, so even a legacy/full payload cannot forge those server-owned fields.
 */
const UPLOADED_EPISODE_SHAPE = EffortEpisode.pick({
  runId: true,
  filesTouched: true,
  commands: true,
  testsRun: true,
  failures: true,
  findings: true,
  selfSummary: true,
}).partial().extend({ runId: EffortEpisode.shape.runId });

/**
 * PLNR-255: the embedding/display text derived from an episode's `body` JSON blob — `body` is
 * written by `recordEpisode` (PLNR-263), the canonical (and, since that task, only) episode
 * writer. Picks the human-legible bits: the self-summary's approach and durable learnings, and
 * each finding's summary. Malformed/absent JSON degrades to a fixed string rather than
 * throwing — an episode this can't summarize should still index and hydrate, just without a
 * preview.
 */
function summarizeEpisodeBody(bodyJson: string): string {
  try {
    const body = JSON.parse(bodyJson) as {
      findings?: Array<{ summary?: string }>;
      selfSummary?: { approachSummary?: string; durableLearnings?: string[] } | null;
    };
    const parts = [
      body.selfSummary?.approachSummary,
      ...(body.findings ?? []).map((f) => f.summary),
      ...(body.selfSummary?.durableLearnings ?? []),
    ].filter((p): p is string => !!p && p.trim().length > 0);
    return parts.length ? parts.join(' — ') : '(no episode summary recorded)';
  } catch {
    return '(unreadable episode body)';
  }
}

/**
 * PLNR-320: the automatic-backfill generation. `backfillProjectionOnce` compares this against
 * the durable `_meta.backfill_version` marker and skips once the marker is at or past it — an
 * INTEGER, not a boolean, precisely so a future fix to the projector (or to `rebuildProjection`
 * itself) can bump this constant to force exactly one more automatic pass over every project,
 * the same lever a schema-version bump gives migrations. Never decrement it by hand — that would
 * make an already-backfilled project look unbackfilled and re-run for no reason (harmless, since
 * the rebuild is idempotent, but pointless CPU).
 */
const BACKFILL_VERSION = 3;

export class ProjectMemory extends DurableObject<Env> {
  // Bound on first call — from ctx.id.name when the runtime exposes it (every
  // real idFromName(projectId) stub), falling back to the caller-provided
  // value on a runtime that does not (mirroring ProjectRoom's own comment on
  // ctx.id.name portability) and persisting it for hibernation recovery.
  // Every later call is asserted against this, never silently reassigned —
  // project isolation inside the DO is a security boundary here, not just a
  // convenience cache the way ProjectRoom's setPid is.
  private _pid?: string;

  private async assertProjectId(projectId: string): Promise<string> {
    if (!this._pid) {
      this._pid = this.ctx.id.name ?? (await this.ctx.storage.get<string>('pid')) ?? projectId;
      await this.ctx.storage.put('pid', this._pid);
    }
    if (this._pid !== projectId) {
      throw new Error(`ProjectMemory: projectId mismatch (bound to ${this._pid}, got ${projectId})`);
    }
    return this._pid;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(() => this.migrate());
  }

  /** Apply any migrations newer than the stored schema version. Repeatable and
   *  additive: re-running against an already-current store is a no-op that
   *  preserves every existing row. */
  private async migrate(): Promise<void> {
    const metaTable = this.ctx.storage.sql
      .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_meta'`)
      .toArray();
    const current = metaTable.length > 0 ? this.readSchemaVersion() : 0;
    for (const migration of MEMORY_MIGRATIONS) {
      if (migration.version <= current) continue;
      // One transaction per migration, and one `exec()` for its whole SQL blob — exec accepts
      // several `;`-separated statements in a single call, so a migration file reads as plain
      // SQL instead of an array of fragments. The version bump commits with the DDL, so a
      // partially-applied migration is impossible.
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(migration.sql);
        this.ctx.storage.sql.exec(
          `INSERT INTO _meta (key, value) VALUES ('schema_version', ?1)
           ON CONFLICT (key) DO UPDATE SET value = ?1`,
          String(migration.version),
        );
      });
    }
  }

  private readSchemaVersion(): number {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>(`SELECT value FROM _meta WHERE key = 'schema_version'`)
      .toArray()[0];
    return row ? Number(row.value) : 0;
  }

  private readMemoryRevision(): number {
    const row = this.ctx.storage.sql.exec<{ value: number }>(`SELECT value FROM memory_revision WHERE id = 0`).toArray()[0];
    return row?.value ?? 0;
  }

  /** Health/schema-version RPC (PLNR-246 projects this into the D1 registry). `databaseSize`
   *  and `sizeStatus` (PLNR-250, §18) are visibility only — nothing here refuses a write at
   *  either threshold; the point is a warning surfaces before the store becomes operationally
   *  unsafe, not that it gets blocked. */
  async health(projectId: string): Promise<ProjectMemoryHealth> {
    await this.assertProjectId(projectId);
    const tableCounts: Record<string, number> = {};
    for (const table of SCHEMA_TABLES) {
      const row = this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0];
      tableCounts[table] = row?.n ?? 0;
    }
    const databaseSize = this.ctx.storage.sql.databaseSize;
    const priorGenFlag = this.ctx.storage.sql.exec<{ value: string }>(`SELECT value FROM _meta WHERE key = 'has_prior_generation'`).toArray()[0];
    return {
      projectId,
      schemaVersion: this.readSchemaVersion(),
      memoryRevision: this.readMemoryRevision(),
      tableCounts,
      databaseSize,
      sizeStatus: sizeStatus(databaseSize),
      hasPriorGeneration: priorGenFlag?.value === '1',
    };
  }

  // ---------------------------------------------------------------------------
  // Disposable Constellation v2 hierarchy generations (PLNR-373)
  // ---------------------------------------------------------------------------

  async beginConstellationGeneration(
    projectId: string,
    input: { topologyVersion: string; layoutVersion: string },
  ): Promise<{ generationId: string; sourceRevision: number }> {
    await this.assertProjectId(projectId);
    const generationId = newId('cgen');
    const sourceRevision = this.readMemoryRevision();
    this.ctx.storage.transactionSync(() => {
      // An explicit retry owns the one build slot. A request interrupted after begin/stage/complete
      // must not leave the active generation reporting `building` forever, and its disposable
      // payload must not accumulate. The active generation is never touched.
      const abandoned = this.ctx.storage.sql.exec<{ id: string }>(
        `SELECT id FROM constellation_generations WHERE status IN ('building', 'complete')`,
      ).toArray();
      for (const row of abandoned) this.deleteConstellationGenerationRows(row.id);
      this.ctx.storage.sql.exec(
        `UPDATE constellation_generations
         SET status = 'failed', failure_reason = 'superseded by constellation generation retry'
         WHERE status IN ('building', 'complete')`,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO constellation_generations
           (id, source_revision, topology_version, layout_version, status, created_at)
         VALUES (?1, ?2, ?3, ?4, 'building', ?5)`,
        generationId, sourceRevision, input.topologyVersion, input.layoutVersion, nowIso(),
      );
    });
    return { generationId, sourceRevision };
  }

  /** Replace a building generation's entire derived payload atomically. Canonical graph rows are
   *  referenced but never mutated, and no reader can select this generation before activation. */
  async stageConstellationGeneration(
    projectId: string,
    generationId: string,
    data: ConstellationGenerationData,
  ): Promise<{ ok: true }> {
    await this.assertProjectId(projectId);
    const generation = this.readConstellationGeneration(generationId);
    if (!generation) throw new Error(`constellation generation ${generationId} not found`);
    if (generation.status !== 'building') throw new Error(`constellation generation ${generationId} is ${generation.status}, not building`);
    this.ctx.storage.transactionSync(() => {
      this.deleteConstellationGenerationRows(generationId);
      for (const row of data.nodeStats) {
        this.ctx.storage.sql.exec(
          `INSERT INTO constellation_node_stats
             (generation_id, node_id, degree, weighted_degree, rank, boundary_degree)
           VALUES (?1,?2,?3,?4,?5,?6)`,
          generationId, row.nodeId, row.degree, row.weightedDegree, row.rank, row.boundaryDegree,
        );
      }
      for (const row of [...data.communities].sort((a, b) => a.level - b.level || a.id.localeCompare(b.id))) {
        this.ctx.storage.sql.exec(
          `INSERT INTO constellation_communities
             (generation_id,id,parent_id,level,label,member_count,child_count,type_counts,internal_weight,normalized_cohesion,boundary_weight,anchor_x,anchor_y,anchor_z,internal_edge_count)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`,
          generationId, row.id, row.parentId, row.level, row.label, row.memberCount, row.childCount,
          JSON.stringify(row.typeCounts), row.internalWeight, row.normalizedCohesion, row.boundaryWeight,
          row.anchor[0], row.anchor[1], row.anchor[2], row.internalEdgeCount,
        );
      }
      for (const row of data.memberships) {
        this.ctx.storage.sql.exec(
          `INSERT INTO constellation_memberships (generation_id,node_id,community_id,level) VALUES (?1,?2,?3,?4)`,
          generationId, row.nodeId, row.communityId, row.level,
        );
      }
      for (const row of data.links) {
        this.ctx.storage.sql.exec(
          `INSERT INTO constellation_community_links
             (generation_id,level,from_community_id,to_community_id,direction,edge_count,weight,by_type)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
          generationId, row.level, row.fromCommunityId, row.toCommunityId, row.direction,
          row.count, row.weight, JSON.stringify(row.byType),
        );
      }
    });
    return { ok: true };
  }

  async completeConstellationGeneration(projectId: string, generationId: string): Promise<{ ok: true }> {
    await this.assertProjectId(projectId);
    const generation = this.readConstellationGeneration(generationId);
    if (!generation) throw new Error(`constellation generation ${generationId} not found`);
    if (generation.status !== 'building') throw new Error(`constellation generation ${generationId} is ${generation.status}, not building`);
    this.ctx.storage.sql.exec(
      `UPDATE constellation_generations SET status = 'complete', completed_at = ?2 WHERE id = ?1`,
      generationId, nowIso(),
    );
    return { ok: true };
  }

  /** The only active-selector writer. The old active generation remains complete data under the
   *  superseded status; generation failure or staging never displaces it. */
  async activateConstellationGeneration(
    projectId: string,
    generationId: string,
  ): Promise<{ activated: string; superseded: string | null }> {
    await this.assertProjectId(projectId);
    let superseded: string | null = null;
    this.ctx.storage.transactionSync(() => {
      const generation = this.readConstellationGeneration(generationId);
      if (!generation) throw new Error(`constellation generation ${generationId} not found`);
      if (generation.status === 'active') return;
      if (generation.status !== 'complete') throw new Error(`constellation generation ${generationId} is ${generation.status}, not complete`);
      if (!constellationSourceIsCurrent(generation.source_revision, this.readMemoryRevision())) {
        throw new Error(`constellation generation ${generationId} source revision ${generation.source_revision} is stale`);
      }
      const prior = this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM constellation_generations WHERE status = 'active'`).toArray()[0];
      superseded = prior?.id ?? null;
      if (prior) this.ctx.storage.sql.exec(`UPDATE constellation_generations SET status = 'superseded' WHERE id = ?1`, prior.id);
      this.ctx.storage.sql.exec(
        `UPDATE constellation_generations SET status = 'active', activated_at = ?2 WHERE id = ?1`,
        generationId, nowIso(),
      );
    });
    return { activated: generationId, superseded };
  }

  async failConstellationGeneration(projectId: string, generationId: string, reason: string): Promise<{ ok: true }> {
    await this.assertProjectId(projectId);
    const generation = this.readConstellationGeneration(generationId);
    if (!generation) throw new Error(`constellation generation ${generationId} not found`);
    if (generation.status !== 'building' && generation.status !== 'complete') {
      throw new Error(`constellation generation ${generationId} is ${generation.status}, not fail-able`);
    }
    this.ctx.storage.sql.exec(
      `UPDATE constellation_generations SET status = 'failed', failure_reason = ?2 WHERE id = ?1`,
      generationId, reason.slice(0, 1000),
    );
    return { ok: true };
  }

  async constellationGenerationStatus(projectId: string, generationId?: string): Promise<ConstellationGenerationStatus | null> {
    await this.assertProjectId(projectId);
    const row = generationId
      ? this.readConstellationGeneration(generationId)
      : this.ctx.storage.sql.exec<ConstellationGenerationRow>(
        `SELECT * FROM constellation_generations
         ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'building' THEN 1 WHEN 'complete' THEN 2 ELSE 3 END, created_at DESC LIMIT 1`,
      ).toArray()[0];
    return row ? this.shapeConstellationGeneration(row) : null;
  }

  /** Operational read model for the hierarchy, separate from visualization data. It reports
   *  failed/retried work even while a prior active generation remains safe to serve. */
  async constellationHierarchyOperations(projectId: string): Promise<ConstellationHierarchyOperations> {
    await this.assertProjectId(projectId);
    const generation = (status: ConstellationGenerationStatus['status']): ConstellationGenerationRow | undefined =>
      this.ctx.storage.sql.exec<ConstellationGenerationRow>(
        `SELECT * FROM constellation_generations WHERE status = ?1 ORDER BY created_at DESC LIMIT 1`, status,
      ).toArray()[0];
    const activeRow = generation('active');
    const buildingRow = generation('building');
    const failedRow = generation('failed');
    const currentRevision = this.readMemoryRevision();
    const rows = activeRow
      ? this.ctx.storage.sql.exec<{ node_stats: number; communities: number; memberships: number; links: number }>(
        `SELECT
          (SELECT COUNT(*) FROM constellation_node_stats WHERE generation_id = ?1) AS node_stats,
          (SELECT COUNT(*) FROM constellation_communities WHERE generation_id = ?1) AS communities,
          (SELECT COUNT(*) FROM constellation_memberships WHERE generation_id = ?1) AS memberships,
          (SELECT COUNT(*) FROM constellation_community_links WHERE generation_id = ?1) AS links`, activeRow.id,
      ).toArray()[0]!
      : { node_stats: 0, communities: 0, memberships: 0, links: 0 };
    return {
      state: buildingRow ? 'building' : activeRow ? (activeRow.source_revision === currentRevision ? 'current' : 'stale') : failedRow ? 'failed' : 'unavailable',
      active: activeRow ? this.shapeConstellationGeneration(activeRow) : null,
      building: buildingRow ? this.shapeConstellationGeneration(buildingRow) : null,
      lastFailed: failedRow ? this.shapeConstellationGeneration(failedRow) : null,
      rows: { nodeStats: rows.node_stats, communities: rows.communities, memberships: rows.memberships, links: rows.links },
      cache: { policy: 'private-revalidate', compactPageTargetBytes: 256 * 1024, compactPageHardLimitBytes: 512 * 1024 },
    };
  }

  private readConstellationGeneration(generationId: string): ConstellationGenerationRow | undefined {
    return this.ctx.storage.sql.exec<ConstellationGenerationRow>(`SELECT * FROM constellation_generations WHERE id = ?1`, generationId).toArray()[0];
  }

  private shapeConstellationGeneration(row: ConstellationGenerationRow): ConstellationGenerationStatus {
    return {
      id: row.id, sourceRevision: row.source_revision, currentRevision: this.readMemoryRevision(),
      topologyVersion: row.topology_version, layoutVersion: row.layout_version, status: row.status,
      createdAt: row.created_at, completedAt: row.completed_at, activatedAt: row.activated_at,
      failureReason: row.failure_reason,
    };
  }

  private deleteConstellationGenerationRows(generationId: string): void {
    this.ctx.storage.sql.exec(`DELETE FROM constellation_community_links WHERE generation_id = ?1`, generationId);
    this.ctx.storage.sql.exec(`DELETE FROM constellation_memberships WHERE generation_id = ?1`, generationId);
    this.ctx.storage.sql.exec(`DELETE FROM constellation_communities WHERE generation_id = ?1`, generationId);
    this.ctx.storage.sql.exec(`DELETE FROM constellation_node_stats WHERE generation_id = ?1`, generationId);
  }

  private clearConstellationDerived(): void {
    for (const table of [...CONSTELLATION_DERIVED_TABLES].reverse()) this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
  }

  private readPriorConstellationCommunities(): PriorConstellationCommunity[] {
    const active = this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM constellation_generations WHERE status = 'active'`).toArray()[0];
    if (!active) return [];
    const rows = this.ctx.storage.sql.exec<{ community_id: string; level: number; uri: string }>(
      `WITH RECURSIVE ancestors(node_id, community_id, level) AS (
         SELECT m.node_id, m.community_id, m.level
         FROM constellation_memberships m WHERE m.generation_id = ?1
         UNION ALL
         SELECT a.node_id, c.parent_id, c.level - 1
         FROM ancestors a
         JOIN constellation_communities c ON c.generation_id = ?1 AND c.id = a.community_id
         WHERE c.parent_id IS NOT NULL
       )
       SELECT a.community_id, a.level, n.uri
       FROM ancestors a JOIN nodes n ON n.id = a.node_id
       ORDER BY a.level, a.community_id, n.uri`,
      active.id,
    ).toArray();
    const grouped = new Map<string, PriorConstellationCommunity>();
    for (const row of rows) {
      const key = `${row.level}\0${row.community_id}`;
      const community = grouped.get(key) ?? { id: row.community_id, level: row.level, memberUris: [] };
      community.memberUris.push(row.uri);
      grouped.set(key, community);
    }
    return [...grouped.values()];
  }

  /** Build off ProjectRoom's coordination path, then publish only if canonical graph revision is
   *  still exactly the revision captured at generation start. Retrying is safe: a stale/failed
   *  attempt is inert, and the next call creates a fresh generation. */
  async rebuildConstellationHierarchy(projectId: string): Promise<
    | { ok: true; generationId: string; sourceRevision: number; nodes: number; edges: number }
    | { ok: false; generationId: string; reason: 'source-revision-advanced' | 'generation-failed'; detail: string }
  > {
    await this.assertProjectId(projectId);
    const started = await this.beginConstellationGeneration(projectId, {
      topologyVersion: CONSTELLATION_TOPOLOGY_VERSION,
      layoutVersion: CONSTELLATION_LAYOUT_VERSION,
    });
    try {
      const rows = this.readConstellationRows();
      const hierarchy = buildConstellationHierarchy(rows.nodes, rows.edges, this.readPriorConstellationCommunities());
      if (!constellationSourceIsCurrent(started.sourceRevision, this.readMemoryRevision())) {
        await this.failConstellationGeneration(projectId, started.generationId, 'canonical source revision advanced during build');
        return { ok: false, generationId: started.generationId, reason: 'source-revision-advanced', detail: 'canonical source revision advanced during build' };
      }
      await this.stageConstellationGeneration(projectId, started.generationId, hierarchy.data);
      if (!constellationSourceIsCurrent(started.sourceRevision, this.readMemoryRevision())) {
        await this.failConstellationGeneration(projectId, started.generationId, 'canonical source revision advanced before completion');
        return { ok: false, generationId: started.generationId, reason: 'source-revision-advanced', detail: 'canonical source revision advanced before completion' };
      }
      await this.completeConstellationGeneration(projectId, started.generationId);
      await this.activateConstellationGeneration(projectId, started.generationId);
      return { ok: true, generationId: started.generationId, sourceRevision: started.sourceRevision, nodes: hierarchy.diagnostics.nodeCount, edges: hierarchy.diagnostics.edgeCount };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const generation = this.readConstellationGeneration(started.generationId);
      if (generation && (generation.status === 'building' || generation.status === 'complete')) {
        await this.failConstellationGeneration(projectId, started.generationId, detail);
      }
      return { ok: false, generationId: started.generationId, reason: detail.includes('source revision') ? 'source-revision-advanced' : 'generation-failed', detail };
    }
  }

  /** Compare the selected disposable projection to canonical graph truth. Counts both missing
   *  rows and stale extra aggregates; a source-revision mismatch can never report converged. */
  async constellationHierarchyDrift(projectId: string): Promise<ConstellationHierarchyDrift> {
    await this.assertProjectId(projectId);
    const currentRevision = this.readMemoryRevision();
    const active = this.ctx.storage.sql.exec<{ id: string; source_revision: number }>(
      `SELECT id, source_revision FROM constellation_generations WHERE status = 'active'`,
    ).toArray()[0];
    const canonicalNodes = this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM nodes`).toArray()[0]?.n ?? 0;
    const canonicalEdges = this.ctx.storage.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM edges e JOIN nodes f ON f.id = e.from_node_id JOIN nodes t ON t.id = e.to_node_id`,
    ).toArray()[0]?.n ?? 0;
    if (!active) {
      return {
        activeGenerationId: null, sourceRevision: null, currentRevision, stale: canonicalNodes > 0,
        canonicalNodes, canonicalEdges, missingNodeStats: canonicalNodes, extraNodeStats: 0,
        invalidMemberships: canonicalNodes, missingAggregatedEdges: canonicalEdges, unexpectedAggregatedEdges: 0,
        converged: canonicalNodes === 0 && canonicalEdges === 0,
      };
    }
    const missingNodeStats = this.ctx.storage.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM nodes n WHERE NOT EXISTS (
         SELECT 1 FROM constellation_node_stats s WHERE s.generation_id = ?1 AND s.node_id = n.id
       )`, active.id,
    ).toArray()[0]?.n ?? 0;
    const extraNodeStats = this.ctx.storage.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM constellation_node_stats s
       WHERE s.generation_id = ?1 AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = s.node_id)`, active.id,
    ).toArray()[0]?.n ?? 0;
    const invalidMemberships = this.ctx.storage.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (
         SELECT n.id, COUNT(m.community_id) AS memberships
         FROM nodes n LEFT JOIN constellation_memberships m ON m.generation_id = ?1 AND m.node_id = n.id
         GROUP BY n.id HAVING memberships != 1
       )`, active.id,
    ).toArray()[0]?.n ?? 0;
    const aggregatedEdges = this.ctx.storage.sql.exec<{ n: number }>(
      `SELECT
         COALESCE((SELECT SUM(internal_edge_count) FROM constellation_communities WHERE generation_id = ?1 AND parent_id IS NULL), 0) +
         COALESCE((SELECT SUM(edge_count) FROM constellation_community_links WHERE generation_id = ?1 AND level = 0), 0) AS n`,
      active.id,
    ).toArray()[0]?.n ?? 0;
    const stale = active.source_revision !== currentRevision;
    const missingAggregatedEdges = Math.max(0, canonicalEdges - aggregatedEdges);
    const unexpectedAggregatedEdges = Math.max(0, aggregatedEdges - canonicalEdges);
    return {
      activeGenerationId: active.id, sourceRevision: active.source_revision, currentRevision, stale,
      canonicalNodes, canonicalEdges, missingNodeStats, extraNodeStats, invalidMemberships,
      missingAggregatedEdges, unexpectedAggregatedEdges,
      converged: !stale && missingNodeStats === 0 && extraNodeStats === 0 && invalidMemberships === 0 && missingAggregatedEdges === 0 && unexpectedAggregatedEdges === 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Constellation v2 bounded read service (PLNR-375)
  // ---------------------------------------------------------------------------

  private activeConstellationRevision(): { generation: ConstellationGenerationRow; revision: ConstellationV2Revision } | null {
    const generation = this.ctx.storage.sql.exec<ConstellationGenerationRow>(
      `SELECT * FROM constellation_generations WHERE status = 'active'`,
    ).toArray()[0];
    if (!generation) return null;
    const currentRevision = this.readMemoryRevision();
    const building = this.ctx.storage.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM constellation_generations WHERE status = 'building'`,
    ).toArray()[0]?.n ?? 0;
    return {
      generation,
      revision: {
        contract: 'constellation-v2', generationId: generation.id, sourceRevision: generation.source_revision,
        currentRevision, topologyVersion: generation.topology_version, layoutVersion: generation.layout_version,
        state: building > 0 ? 'building' : generation.source_revision === currentRevision ? 'current' : 'stale',
        generatedAt: generation.completed_at ?? generation.created_at,
      },
    };
  }

  private unavailableConstellation(error: ConstellationV2Unavailable['error']): ConstellationV2Unavailable {
    return { ok: false, error, currentRevision: this.readMemoryRevision(), retryAfter: error === 'generation-unavailable' ? 5 : undefined };
  }

  /** Metadata-only cache validator: no hierarchy page or canonical graph rows are read. */
  async constellationV2Head(projectId: string): Promise<ConstellationV2Head | ConstellationV2Unavailable> {
    await this.assertProjectId(projectId);
    const active = this.activeConstellationRevision();
    return active ? { revision: active.revision } : this.unavailableConstellation('generation-unavailable');
  }

  private shapeConstellationCommunity(row: Record<string, string | number | null>): ConstellationV2Community {
    return {
      id: String(row.id), parentId: row.parent_id === null ? null : String(row.parent_id), level: Number(row.level), label: String(row.label),
      memberCount: Number(row.member_count), childCommunityCount: Number(row.child_count),
      typeCounts: JSON.parse(String(row.type_counts)) as Record<string, number>, internalEdgeCount: Number(row.internal_edge_count),
      internalWeight: Number(row.internal_weight), normalizedCohesion: Number(row.normalized_cohesion), boundaryWeight: Number(row.boundary_weight),
      anchor: [Number(row.anchor_x), Number(row.anchor_y), Number(row.anchor_z)],
    };
  }

  private readConstellationCommunity(generationId: string, communityId: string): ConstellationV2Community | null {
    const row = this.ctx.storage.sql.exec<Record<string, string | number | null>>(
      `SELECT * FROM constellation_communities WHERE generation_id = ?1 AND id = ?2`, generationId, communityId,
    ).toArray()[0];
    return row ? this.shapeConstellationCommunity(row) : null;
  }

  private readCommunityPath(generationId: string, nodeId: string): ConstellationV2Community[] {
    const rows = this.ctx.storage.sql.exec<Record<string, string | number | null>>(
      `WITH RECURSIVE path AS (
         SELECT c.* FROM constellation_memberships m
         JOIN constellation_communities c ON c.generation_id = m.generation_id AND c.id = m.community_id
         WHERE m.generation_id = ?1 AND m.node_id = ?2
         UNION ALL
         SELECT parent.* FROM path child
         JOIN constellation_communities parent ON parent.generation_id = ?1 AND parent.id = child.parent_id
         WHERE child.parent_id IS NOT NULL
       ) SELECT * FROM path ORDER BY level`,
      generationId, nodeId,
    ).toArray();
    return rows.map((row) => this.shapeConstellationCommunity(row));
  }

  private readAggregateRoutes(
    generationId: string,
    level: number,
    communityIds: string[],
  ): { routes: ConstellationV2AggregateRoute[]; externalCommunities: ConstellationV2Community[]; truncated: boolean } {
    if (communityIds.length === 0) return { routes: [], externalCommunities: [], truncated: false };
    type AggregateRouteRow = {
      from_community_id: string; to_community_id: string; direction: 'forward' | 'reverse' | 'both'; edge_count: number; weight: number; by_type: string;
    };
    // Durable Object SQLite accepts at most 100 numbered variables. Two are reserved for the
    // generation and level, so a community page wider than 98 children must query its route
    // boundary in batches. Reusing each numbered placeholder in both IN clauses does not consume
    // another variable; routes spanning two batches are deduplicated before the global ordering
    // and cap are applied.
    const ids = [...new Set(communityIds)];
    const idsPerQuery = 98;
    const rowByRoute = new Map<string, AggregateRouteRow>();
    let batchTruncated = false;
    for (let offset = 0; offset < ids.length; offset += idsPerQuery) {
      const batch = ids.slice(offset, offset + idsPerQuery);
      const placeholders = batch.map((_, index) => `?${index + 3}`).join(',');
      const rows = this.ctx.storage.sql.exec<AggregateRouteRow>(
        `SELECT from_community_id,to_community_id,direction,edge_count,weight,by_type
         FROM constellation_community_links
         WHERE generation_id = ?1 AND level = ?2
           AND (from_community_id IN (${placeholders}) OR to_community_id IN (${placeholders}))
         ORDER BY weight DESC, from_community_id, to_community_id LIMIT ${CONSTELLATION_V2_MAX_OVERVIEW_ROUTES + 1}`,
        generationId, level, ...batch,
      ).toArray();
      batchTruncated ||= rows.length > CONSTELLATION_V2_MAX_OVERVIEW_ROUTES;
      for (const row of rows) {
        rowByRoute.set(`${row.from_community_id}\0${row.to_community_id}\0${row.direction}`, row);
      }
    }
    const rows = [...rowByRoute.values()].sort((left, right) =>
      right.weight - left.weight
      || left.from_community_id.localeCompare(right.from_community_id)
      || left.to_community_id.localeCompare(right.to_community_id)
      || left.direction.localeCompare(right.direction));
    const truncated = batchTruncated || rows.length > CONSTELLATION_V2_MAX_OVERVIEW_ROUTES;
    const page = rows.slice(0, CONSTELLATION_V2_MAX_OVERVIEW_ROUTES);
    const routes = page.map((row) => ({
      fromCommunityId: row.from_community_id, toCommunityId: row.to_community_id, direction: row.direction,
      count: row.edge_count, weight: row.weight, byType: JSON.parse(row.by_type) as Record<string, number>,
    }));
    const visible = new Set(ids);
    const externalIds = [...new Set(routes.flatMap((route) => [route.fromCommunityId, route.toCommunityId]).filter((id) => !visible.has(id)))];
    const externalCommunities = externalIds.map((id) => this.readConstellationCommunity(generationId, id)).filter((row): row is ConstellationV2Community => row !== null);
    return { routes, externalCommunities, truncated };
  }

  private constellationCoverage(revision: ConstellationV2Revision, pageLimited: boolean, excludedAtLevel = false): ConstellationV2Coverage {
    const reasons: ConstellationV2Coverage['reasons'] = [];
    if (pageLimited) reasons.push('page-limit-reached');
    if (revision.state !== 'current') reasons.push('generation-stale');
    if (excludedAtLevel) reasons.push('excluded-at-this-level');
    return { complete: !pageLimited && revision.state === 'current', reasons };
  }

  private readConstellationBackbone(generationId: string, communityId: string): { edges: ConstellationV2RawEdge[]; truncated: boolean } {
    const candidateLimit = 2_000;
    const rows = this.ctx.storage.sql.exec<{
      edge_id: string; type: string; from_node_id: string; to_node_id: string; provenance: string | null;
    }>(
      `SELECT e.id AS edge_id,e.type,e.from_node_id,e.to_node_id,e.provenance
       FROM edges e
       JOIN constellation_memberships source ON source.generation_id = ?1 AND source.community_id = ?2 AND source.node_id = e.from_node_id
       JOIN constellation_memberships target ON target.generation_id = ?1 AND target.community_id = ?2 AND target.node_id = e.to_node_id
       ORDER BY CASE e.type
         WHEN 'calls' THEN 4 WHEN 'imports' THEN 4 WHEN 'depends_on' THEN 4 WHEN 'tests' THEN 4 WHEN 'validated_by' THEN 4 WHEN 'implements' THEN 4
         WHEN 'modifies' THEN 3 WHEN 'declares' THEN 3 WHEN 'derived_from' THEN 3 WHEN 'decided_by' THEN 3 WHEN 'observed_in' THEN 3 WHEN 'commonly_changes_with' THEN 3
         WHEN 'blocks' THEN 2 WHEN 'owned_by' THEN 2 WHEN 'failed_because' THEN 2 ELSE 1 END DESC,
         e.type,e.from_node_id,e.to_node_id,e.id LIMIT ?3`,
      generationId, communityId, candidateLimit + 1,
    ).toArray();
    const parent = new Map<string, string>();
    const root = (id: string): string => {
      const current = parent.get(id);
      if (!current) { parent.set(id, id); return id; }
      if (current === id) return id;
      const resolved = root(current); parent.set(id, resolved); return resolved;
    };
    const edges: ConstellationV2RawEdge[] = [];
    for (const row of rows.slice(0, candidateLimit)) {
      const fromRoot = root(row.from_node_id), toRoot = root(row.to_node_id);
      if (fromRoot === toRoot) continue;
      parent.set(toRoot, fromRoot);
      edges.push({
        edgeId: row.edge_id, type: row.type, fromNodeId: row.from_node_id, toNodeId: row.to_node_id,
        direction: 'forward', provenance: row.provenance, weight: constellationEdgeBaseWeight(row.type),
        historical: row.type === 'supersedes' || row.type === 'contradicts',
      });
      if (edges.length >= 499) break;
    }
    return { edges, truncated: rows.length > candidateLimit };
  }

  async constellationV2Overview(projectId: string): Promise<ConstellationV2Overview | ConstellationV2Unavailable> {
    await this.assertProjectId(projectId);
    const active = this.activeConstellationRevision();
    if (!active) return this.unavailableConstellation('generation-unavailable');
    const rows = this.ctx.storage.sql.exec<Record<string, string | number | null>>(
      `SELECT * FROM constellation_communities WHERE generation_id = ?1 AND parent_id IS NULL ORDER BY id`, active.generation.id,
    ).toArray();
    const communities = rows.map((row) => this.shapeConstellationCommunity(row));
    const routePage = this.readAggregateRoutes(active.generation.id, 0, communities.map((community) => community.id));
    return {
      revision: active.revision, communities, routes: routePage.routes,
      coverage: this.constellationCoverage(active.revision, routePage.truncated, true),
    };
  }

  async constellationV2Community(
    projectId: string,
    communityId: string,
    input: { cursor?: string; limit?: number } = {},
  ): Promise<ConstellationV2CommunityPage | ConstellationV2Unavailable> {
    await this.assertProjectId(projectId);
    const active = this.activeConstellationRevision();
    if (!active) return this.unavailableConstellation('generation-unavailable');
    const community = this.readConstellationCommunity(active.generation.id, communityId);
    if (!community) return this.unavailableConstellation('not-found');
    const scope = `community:${communityId}`;
    const cursor = decodeConstellationCursor(input.cursor);
    if (input.cursor && (!cursor || !cursorMatches(cursor, active.generation.id, active.revision.currentRevision, scope))) {
      return this.unavailableConstellation('cursor-stale');
    }
    if (community.childCommunityCount > 0) {
      const limit = clampConstellationLimit(input.limit, 128, 128);
      const rows = this.ctx.storage.sql.exec<Record<string, string | number | null>>(
        `SELECT * FROM constellation_communities
         WHERE generation_id = ?1 AND parent_id = ?2 AND id > ?3 ORDER BY id LIMIT ?4`,
        active.generation.id, communityId, cursor?.after ?? '', limit + 1,
      ).toArray();
      const pageLimited = rows.length > limit;
      const communities = rows.slice(0, limit).map((row) => this.shapeConstellationCommunity(row));
      const routePage = this.readAggregateRoutes(active.generation.id, community.level + 1, communities.map((row) => row.id));
      const after = communities.at(-1)?.id;
      return {
        revision: active.revision, community, kind: 'communities', communities, entities: [], backboneEdges: [], routes: routePage.routes,
        externalCommunities: routePage.externalCommunities,
        nextCursor: pageLimited && after ? encodeConstellationCursor({ generationId: active.generation.id, currentRevision: active.revision.currentRevision, scope, after }) : null,
        coverage: this.constellationCoverage(active.revision, pageLimited || routePage.truncated, true),
      };
    }
    const limit = clampConstellationLimit(input.limit, CONSTELLATION_V2_DEFAULT_ENTITY_LIMIT, CONSTELLATION_V2_MAX_ENTITY_LIMIT);
    let afterRank = Number.MAX_VALUE, afterNodeId = '';
    if (cursor) {
      try { [afterRank, afterNodeId] = JSON.parse(cursor.after) as [number, string]; }
      catch { return this.unavailableConstellation('cursor-stale'); }
    }
    const rows = this.ctx.storage.sql.exec<{
      node_id: string; uri: string; type: string; label: string; degree: number; boundary_degree: number; rank: number;
      kind: string | null; authority: number | null; validity: string | null;
    }>(
      `SELECT n.id AS node_id,n.uri,n.type,n.label,s.degree,s.boundary_degree,s.rank,
              COALESCE(mi.kind, ep.landing_outcome) AS kind,mi.authority,mi.validity
       FROM constellation_memberships m
       JOIN constellation_node_stats s ON s.generation_id = m.generation_id AND s.node_id = m.node_id
       JOIN nodes n ON n.id = m.node_id
       LEFT JOIN memory_items mi ON n.type = 'memory' AND n.uri = 'noriq://memory/' || mi.id
       LEFT JOIN episodes ep ON n.type = 'episode' AND n.uri = 'noriq://episode/' || ep.id
       WHERE m.generation_id = ?1 AND m.community_id = ?2
         AND (s.rank < ?3 OR (s.rank = ?3 AND n.id > ?4))
       ORDER BY s.rank DESC,n.id LIMIT ?5`,
      active.generation.id, communityId, afterRank, afterNodeId, limit + 1,
    ).toArray();
    const pageLimited = rows.length > limit;
    const entityRows = rows.slice(0, limit);
    const entities = entityRows.map((row) => {
      const lead = row.authority !== null || row.validity !== null ? classifyLead({ authority: row.authority ?? undefined, validity: row.validity ?? undefined }) : null;
      return {
        nodeId: row.node_id, uri: row.uri, type: row.type, kind: row.kind, label: row.label,
        authority: row.authority, validity: row.validity, isLead: lead?.isLead ?? null, leadReasons: lead?.leadReasons ?? null,
        degree: row.degree, boundaryDegree: row.boundary_degree, groupKey: row.type, communityId,
        position: constellationEntityPosition(row.uri, community.anchor),
      };
    });
    const routePage = this.readAggregateRoutes(active.generation.id, community.level, [community.id]);
    const backbone = this.readConstellationBackbone(active.generation.id, community.id);
    const last = entityRows.at(-1);
    return {
      revision: active.revision, community, kind: 'entities', communities: [], entities, backboneEdges: backbone.edges, routes: routePage.routes,
      externalCommunities: routePage.externalCommunities,
      nextCursor: pageLimited && last ? encodeConstellationCursor({ generationId: active.generation.id, currentRevision: active.revision.currentRevision, scope, after: JSON.stringify([last.rank, last.node_id]) }) : null,
      coverage: this.constellationCoverage(active.revision, pageLimited || routePage.truncated || backbone.truncated),
    };
  }

  async constellationV2Route(projectId: string, uri: string): Promise<ConstellationV2Route | ConstellationV2Unavailable> {
    await this.assertProjectId(projectId);
    const active = this.activeConstellationRevision();
    if (!active) return this.unavailableConstellation('generation-unavailable');
    const node = this.ctx.storage.sql.exec<{ id: string; uri: string }>(`SELECT id,uri FROM nodes WHERE uri = ?1`, uri).toArray()[0];
    if (!node) return this.unavailableConstellation('not-found');
    const communityPath = this.readCommunityPath(active.generation.id, node.id);
    if (communityPath.length === 0) return this.unavailableConstellation('generation-stale');
    return { revision: active.revision, nodeId: node.id, uri: node.uri, communityPath };
  }

  async constellationV2Incidents(
    projectId: string,
    nodeId: string,
    input: { cursor?: string; limit?: number } = {},
  ): Promise<ConstellationV2IncidentPage | ConstellationV2Unavailable> {
    await this.assertProjectId(projectId);
    const active = this.activeConstellationRevision();
    if (!active) return this.unavailableConstellation('generation-unavailable');
    const node = this.ctx.storage.sql.exec<{ id: string; uri: string; type: string; label: string }>(
      `SELECT id,uri,type,label FROM nodes WHERE id = ?1`, nodeId,
    ).toArray()[0];
    if (!node) return this.unavailableConstellation('not-found');
    const communityPath = this.readCommunityPath(active.generation.id, node.id);
    if (communityPath.length === 0) return this.unavailableConstellation('generation-stale');
    const scope = `incidents:${nodeId}`;
    const cursor = decodeConstellationCursor(input.cursor);
    if (input.cursor && (!cursor || !cursorMatches(cursor, active.generation.id, active.revision.currentRevision, scope))) {
      return this.unavailableConstellation('cursor-stale');
    }
    let after: [string, string, string, string] = ['', '', '', ''];
    if (cursor) {
      try { after = JSON.parse(cursor.after) as [string, string, string, string]; }
      catch { return this.unavailableConstellation('cursor-stale'); }
    }
    const limit = clampConstellationLimit(input.limit, CONSTELLATION_V2_DEFAULT_INCIDENT_LIMIT, CONSTELLATION_V2_MAX_INCIDENT_LIMIT);
    const rows = this.ctx.storage.sql.exec<{
      edge_id: string; edge_type: string; direction: 'incoming' | 'outgoing'; provenance: string | null;
      endpoint_id: string; endpoint_uri: string; endpoint_type: string; endpoint_label: string;
    }>(
      `SELECT e.id AS edge_id,e.type AS edge_type,e.provenance,
              CASE WHEN e.from_node_id = ?1 THEN 'outgoing' ELSE 'incoming' END AS direction,
              other.id AS endpoint_id,other.uri AS endpoint_uri,other.type AS endpoint_type,other.label AS endpoint_label
       FROM edges e JOIN nodes other ON other.id = CASE WHEN e.from_node_id = ?1 THEN e.to_node_id ELSE e.from_node_id END
       WHERE (e.from_node_id = ?1 OR e.to_node_id = ?1) AND (
         e.type > ?2 OR (e.type = ?2 AND (CASE WHEN e.from_node_id = ?1 THEN 'outgoing' ELSE 'incoming' END) > ?3) OR
         (e.type = ?2 AND (CASE WHEN e.from_node_id = ?1 THEN 'outgoing' ELSE 'incoming' END) = ?3 AND other.uri > ?4) OR
         (e.type = ?2 AND (CASE WHEN e.from_node_id = ?1 THEN 'outgoing' ELSE 'incoming' END) = ?3 AND other.uri = ?4 AND e.id > ?5)
       )
       ORDER BY e.type,direction,other.uri,e.id LIMIT ?6`,
      nodeId, after[0], after[1], after[2], after[3], limit + 1,
    ).toArray();
    const pageLimited = rows.length > limit;
    const edgeRows = rows.slice(0, limit);
    const edges = edgeRows.map((row) => ({
      edgeId: row.edge_id, type: row.edge_type, direction: row.direction, provenance: row.provenance,
      endpoint: { nodeId: row.endpoint_id, uri: row.endpoint_uri, type: row.endpoint_type, label: row.endpoint_label, communityPath: this.readCommunityPath(active.generation.id, row.endpoint_id) },
    }));
    const last = edgeRows.at(-1);
    return {
      revision: active.revision, node: { nodeId: node.id, uri: node.uri, type: node.type, label: node.label, communityPath }, edges,
      nextCursor: pageLimited && last ? encodeConstellationCursor({
        generationId: active.generation.id, currentRevision: active.revision.currentRevision, scope,
        after: JSON.stringify([last.edge_type, last.direction, last.endpoint_uri, last.edge_id]),
      }) : null,
      coverage: this.constellationCoverage(active.revision, pageLimited),
    };
  }

  // ---------------------------------------------------------------------------
  // Portable snapshot export (PLNR-248)
  // ---------------------------------------------------------------------------

  /**
   * Export this project's canonical memory to R2 in bounded, checksummed chunks (see
   * lib/memory/backup.ts for the pipeline itself — this method only supplies the two
   * synchronous SQLite callbacks and the current schema/revision header fields; only this DO
   * can read its own SQLite, so the pipeline can never open storage itself). Degrades
   * gracefully with `{ ok: false, reason }` rather than throwing when R2 (FILES) is unbound —
   * every other RPC on this DO keeps working with zero optional bindings (§20).
   */
  async exportSnapshot(
    projectId: string,
    opts: { tier?: 'core' | 'full' } = {},
  ): Promise<{ ok: true; manifest: MemoryBackupManifest; manifestKey: string } | { ok: false; reason: string }> {
    await this.assertProjectId(projectId);
    if (!this.env.FILES) return { ok: false, reason: 'R2 (FILES) not configured' };
    // R2 writes yield between chunks, so paging directly over the live tables can otherwise
    // mix revisions (and OFFSET can skip/duplicate rows as concurrent writes land). Materialize
    // one constraint-free, point-in-time copy first; both header fields are captured in the same
    // SQLite transaction as the rows they describe. A unique prefix also makes concurrent export
    // calls independent.
    const copyPrefix = `${newId('export')}_`;
    let schemaVersion = 0;
    let memoryRevision = 0;
    try {
      this.ctx.storage.transactionSync(() => {
        schemaVersion = this.readSchemaVersion();
        memoryRevision = this.readMemoryRevision();
        this.snapshotLiveInto(copyPrefix);
      });
      const result = await exportMemorySnapshot({
        env: this.env,
        projectId,
        schemaVersion,
        memoryRevision,
        tier: opts.tier ?? 'core',
        exportedAt: nowIso(),
        tables: BACKUP_TABLES,
        readBatch: (table, offset, limit) =>
          this.ctx.storage.sql.exec(`SELECT * FROM ${copyPrefix}${table} ORDER BY rowid LIMIT ?1 OFFSET ?2`, limit, offset).toArray(),
        tableCount: (table) =>
          this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${copyPrefix}${table}`).toArray()[0]?.n ?? 0,
      });
      await this.reportBackupStatus(projectId, true);
      return { ok: true, manifest: result.manifest, manifestKey: result.manifestKey };
    } catch (err) {
      await this.reportBackupStatus(projectId, false);
      return { ok: false, reason: String(err) };
    } finally {
      this.ctx.storage.transactionSync(() => {
        for (const table of BACKUP_TABLES) this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${copyPrefix}${table}`);
      });
    }
  }

  /** Project the backup outcome into the D1 registry via ProjectRoom (sole D1 writer per
   *  project) — awaited, not fire-and-forget: unlike erase()'s post-delete notification, the
   *  project here is still very much alive, so the caller (admin route, cron) should see a
   *  settled registry row by the time exportSnapshot resolves. Never lets a registry-write
   *  failure mask the export's own result. */
  private async reportBackupStatus(projectId: string, ok: boolean): Promise<void> {
    await this.env.PROJECT_ROOM.get(this.env.PROJECT_ROOM.idFromName(projectId))
      .updateMemoryBackupStatus(projectId, { ok })
      .catch((err) => console.warn(`ProjectMemory backup-status report for ${projectId} failed: ${String(err)}`));
  }

  // ---------------------------------------------------------------------------
  // Generation-based restore + rollback (PLNR-249)
  //
  // Restore NEVER deletes the active dataset first, and — as of the PLNR-250 follow-up — never
  // RENAMES a live table either. Two platform facts forced that:
  //
  //   1. `ALTER TABLE x RENAME TO y` rewrites x's name in OTHER tables' FK clauses. Renaming
  //      `nodes` to `prev_nodes` silently repointed `edges.from_node_id` at `prev_nodes`, so a
  //      restore corrupted the schema it was restoring.
  //   2. That rename also stores the new name QUOTED (`CREATE TABLE "edges"`), which broke the
  //      textual `CREATE TABLE <t>` munging used to derive a staging schema — a SECOND restore
  //      failed outright with "could not derive staging schema".
  //
  // Neither was caught by the original tests because a single restore of a store that happened
  // to have evidence rows is the one path that worked. So the mechanism is now copy-based and
  // touches no table identity at all:
  //
  //   staging_<t>  — `CREATE TABLE … AS SELECT * FROM <t> WHERE 0`: same columns, and
  //                  deliberately NO constraints. Import order and FK enforcement (which is
  //                  permanently ON here — `PRAGMA foreign_keys = OFF` is ignored by DO SQLite,
  //                  verified against workerd) therefore cannot affect staging at all.
  //   prev_<t>     — `CREATE TABLE … AS SELECT * FROM <t>`: a constraint-free holding copy of
  //                  the outgoing generation, for rollback. One generation back, never a stack.
  //
  // Activation is ONE transactionSync that snapshots live→prev_, empties live child-first, and
  // refills it from staging parent-first. Because the LIVE tables keep their real schema, that
  // refill is checked against the real FKs and CHECKs — a corrupt snapshot fails the restore
  // instead of loading quietly — and because it is one transaction, any throw rolls the whole
  // thing back, leaving the active generation byte-identical.
  // ---------------------------------------------------------------------------

  /** Parent-first (FK-safe insert order) is BACKUP_TABLES; child-first (FK-safe delete order)
   *  is its reverse. Both matter now that refills hit the real constrained tables. */
  private static readonly PARENT_FIRST = BACKUP_TABLES;

  private readonly VALID_COLUMN_NAME = /^[a-z_][a-z0-9_]*$/;

  /** Empty, constraint-free twins of every backup table. Created for ALL of them up front, not
   *  just the ones the snapshot has chunks for: that is what makes the integrity anti-joins
   *  below unconditional. (The previous version created them lazily per-chunk and then queried
   *  `staging_evidence` whenever EITHER edges or evidence was present — so restoring any project
   *  that had edges but no evidence died on "no such table: staging_evidence".) */
  private createEmptyStagingTables(): void {
    for (const table of ProjectMemory.PARENT_FIRST) {
      this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS staging_${table}`);
      this.ctx.storage.sql.exec(`CREATE TABLE staging_${table} AS SELECT * FROM ${table} WHERE 0`);
    }
  }

  private insertStagingRow(table: string, row: Record<string, unknown>): void {
    const cols = Object.keys(row);
    for (const c of cols) {
      if (!this.VALID_COLUMN_NAME.test(c)) throw new Error(`refusing malformed column name in snapshot row: ${c}`);
    }
    const placeholders = cols.map((_, i) => `?${i + 1}`).join(', ');
    this.ctx.storage.sql.exec(
      `INSERT INTO staging_${table} (${cols.join(', ')}) VALUES (${placeholders})`,
      ...cols.map((c) => row[c]),
    );
  }

  private countRows(tablePrefix: string, table: string): number {
    return this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${tablePrefix}${table}`).toArray()[0]?.n ?? 0;
  }

  /** Anti-join graph/evidence integrity over the STAGED tables — an edge or evidence row
   *  pointing at a node/memory item the same snapshot doesn't contain fails the restore before
   *  anything is activated. The live tables' real FKs would also catch this during the refill,
   *  but checking here gives a precise count and a message, and does it before the outgoing
   *  generation has been disturbed at all. */
  private stagingIntegrityProblems(): string[] {
    const problems: string[] = [];
    const danglingEdges = this.ctx.storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM staging_edges e
         WHERE NOT EXISTS (SELECT 1 FROM staging_nodes n WHERE n.id = e.from_node_id)
            OR NOT EXISTS (SELECT 1 FROM staging_nodes n2 WHERE n2.id = e.to_node_id)`,
      )
      .toArray()[0]?.n ?? 0;
    if (danglingEdges > 0) problems.push(`${danglingEdges} staged edge(s) reference a missing node`);
    const danglingEvidence = this.ctx.storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM staging_evidence ev
         WHERE NOT EXISTS (SELECT 1 FROM staging_memory_items m WHERE m.id = ev.memory_item_id)`,
      )
      .toArray()[0]?.n ?? 0;
    if (danglingEvidence > 0) problems.push(`${danglingEvidence} staged evidence row(s) reference a missing memory item`);
    return problems;
  }

  private dropStagingTables(): void {
    for (const table of ProjectMemory.PARENT_FIRST) this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS staging_${table}`);
  }

  /** Replace every live table's contents from same-named tables carrying `fromPrefix`, keeping
   *  the live schema (and therefore its FKs and CHECKs) untouched. Delete child-first, insert
   *  parent-first, so the real FK constraints are satisfied at every step. Caller MUST wrap this
   *  in a transaction — that wrapping is what makes a failed activation leave nothing behind. */
  private replaceLiveContentsFrom(fromPrefix: string): void {
    for (const table of [...ProjectMemory.PARENT_FIRST].reverse()) {
      this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
    }
    for (const table of ProjectMemory.PARENT_FIRST) {
      const source = `${fromPrefix}${table}`;
      const exists = this.ctx.storage.sql
        .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1`, source)
        .toArray().length > 0;
      // A source table that doesn't exist means the snapshot genuinely had no such table (e.g.
      // it predates one). Emptying the live table is the correct reading of that: the snapshot
      // is the truth being restored, not a partial overlay on top of current data.
      if (exists) this.ctx.storage.sql.exec(`INSERT INTO ${table} SELECT * FROM ${source}`);
    }
  }

  private snapshotLiveInto(prefix: string): void {
    for (const table of ProjectMemory.PARENT_FIRST) {
      this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${prefix}${table}`);
      this.ctx.storage.sql.exec(`CREATE TABLE ${prefix}${table} AS SELECT * FROM ${table}`);
    }
  }

  /** Derived analytics never survive a canonical generation switch. They are rebuilt from the
   * newly active episodes and D1 watermarks; retaining them would make a successful restore
   * publish read rows from the pre-restore world. Caller owns transaction boundaries. */
  private clearAnalyticsDerived(): void {
    this.ctx.storage.sql.exec(`DELETE FROM analytics_quality_event_rows`);
    this.ctx.storage.sql.exec(`DELETE FROM analytics_rows`);
    this.ctx.storage.sql.exec(`DELETE FROM analytics_snapshot_rows`);
    this.ctx.storage.sql.exec(`UPDATE analytics_active_generation SET generation_id = NULL WHERE id = 0`);
    this.ctx.storage.sql.exec(`DELETE FROM analytics_generations`);
  }

  /**
   * Restore this project's canonical memory from a portable snapshot (PLNR-248's export).
   * Fetches and validates the manifest, imports every chunk into constraint-free staging tables
   * (chunk-at-a-time, never the whole snapshot in memory), verifies row counts and
   * graph/evidence integrity against staging, and only on success performs one atomic
   * activation. Marks derived vectors dirty on success — a snapshot's vectors, if any existed,
   * never travel with it (§9); the real rebuild is Phase 4's, this only flags it.
   */
  async restoreSnapshot(
    projectId: string,
    opts: { exportedAt: string },
  ): Promise<{ ok: true; tableCounts: Record<string, number> } | { ok: false; reason: string }> {
    await this.assertProjectId(projectId);
    if (!this.env.FILES) return { ok: false, reason: 'R2 (FILES) not configured' };
    let manifest;
    try {
      manifest = await fetchManifest(this.env, projectId, opts.exportedAt);
    } catch (err) {
      return { ok: false, reason: `could not fetch manifest: ${String(err)}` };
    }
    const header = checkManifestHeader(manifest, projectId, this.readSchemaVersion(), BACKUP_TABLES);
    if (!header.ok) return { ok: false, reason: header.problems.join('; ') };

    try {
      this.createEmptyStagingTables();
      for await (const chunk of readSnapshotChunks(this.env, manifest)) {
        if (!ProjectMemory.PARENT_FIRST.includes(chunk.table as (typeof BACKUP_TABLES)[number])) {
          throw new Error(`snapshot contains an unknown table: ${chunk.table}`);
        }
        this.ctx.storage.transactionSync(() => {
          for (const row of chunk.rows) this.insertStagingRow(chunk.table, row);
        });
      }

      const problems: string[] = [];
      for (const [table, expected] of Object.entries(manifest.tableCounts)) {
        const staged = ProjectMemory.PARENT_FIRST.includes(table as (typeof BACKUP_TABLES)[number])
          ? this.countRows('staging_', table)
          : 0;
        if (staged !== expected) problems.push(`${table}: expected ${expected} rows, staged ${staged}`);
      }
      problems.push(...this.stagingIntegrityProblems());
      if (problems.length > 0) {
        this.dropStagingTables();
        return { ok: false, reason: problems.join('; ') };
      }

      // One transaction for the whole activation: retain the outgoing generation, then replace
      // live contents from staging. A constraint violation anywhere rolls all of it back.
      this.ctx.storage.transactionSync(() => {
        this.snapshotLiveInto('prev_');
        // Derived constellation rows are not portable backup truth. A canonical restore
        // invalidates them, so clear them in the same transaction as the switch.
        this.clearConstellationDerived();
        this.replaceLiveContentsFrom('staging_');
        this.clearAnalyticsDerived();
        this.ctx.storage.sql.exec(
          `INSERT INTO _meta (key, value) VALUES ('has_prior_generation', '1')
           ON CONFLICT (key) DO UPDATE SET value = '1'`,
        );
        this.ctx.storage.sql.exec(
          `INSERT INTO _meta (key, value) VALUES ('prior_generation_created_at', ?1)
           ON CONFLICT (key) DO UPDATE SET value = ?1`,
          nowIso(),
        );
      });
      this.dropStagingTables();

      await this.reportVectorDirty(projectId, true);
      await requestProjectAnalyticsRebuild(this.env, projectId).catch((error) =>
        console.warn(`analytics rebuild enqueue after restore failed for ${projectId}: ${String(error)}`));
      const tableCounts: Record<string, number> = {};
      for (const table of ProjectMemory.PARENT_FIRST) tableCounts[table] = this.countRows('', table);
      return { ok: true, tableCounts };
    } catch (err) {
      // A chunk that failed its own checksum (readSnapshotChunks throws rather than yielding
      // untrusted rows) lands here too. Nothing live was touched: staging is separate, and
      // activation is a single transaction that either committed or rolled back whole.
      this.dropStagingTables();
      return { ok: false, reason: String(err) };
    }
  }

  /** Swap the retained prior generation back to active — no R2 read, no re-validation; it was
   *  already trusted when it was live. Single-level undo: rolling back consumes the retained
   *  generation, so a second rollback has nothing left to swap. */
  async rollback(projectId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    await this.assertProjectId(projectId);
    const flag = this.ctx.storage.sql.exec<{ value: string }>(`SELECT value FROM _meta WHERE key = 'has_prior_generation'`).toArray()[0];
    if (flag?.value !== '1') return { ok: false, reason: 'no retained prior generation to roll back to' };
    // Same copy-based shape as activation, in the other direction and in one transaction: refill
    // live from the retained `prev_` copies, then discard them (rollback CONSUMES the retained
    // generation — that is what makes this single-level rather than a stack).
    this.ctx.storage.transactionSync(() => {
      this.clearConstellationDerived();
      this.replaceLiveContentsFrom('prev_');
      this.clearAnalyticsDerived();
      for (const table of ProjectMemory.PARENT_FIRST) this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS prev_${table}`);
      this.ctx.storage.sql.exec(`UPDATE _meta SET value = '0' WHERE key = 'has_prior_generation'`);
    });
    await this.reportVectorDirty(projectId, true);
    await requestProjectAnalyticsRebuild(this.env, projectId).catch((error) =>
      console.warn(`analytics rebuild enqueue after rollback failed for ${projectId}: ${String(error)}`));
    return { ok: true };
  }

  /** Unconditionally discard the retained prior generation — a manual escape hatch. The
   *  scheduled sweep uses the age-gated `pruneRetainedGenerationIfExpired` below instead. */
  async pruneRetainedGeneration(projectId: string): Promise<{ ok: true }> {
    await this.assertProjectId(projectId);
    this.ctx.storage.transactionSync(() => {
      for (const table of BACKUP_TABLES) this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS prev_${table}`);
      this.ctx.storage.sql.exec(`UPDATE _meta SET value = '0' WHERE key = 'has_prior_generation'`);
    });
    return { ok: true };
  }

  /** PLNR-250's scheduled sweep calls this: discard the retained prior generation only once its
   *  rollback window has passed. Idempotent — nothing to prune reports false, cheaply. */
  async pruneRetainedGenerationIfExpired(projectId: string, maxAgeMs: number): Promise<boolean> {
    await this.assertProjectId(projectId);
    const flag = this.ctx.storage.sql.exec<{ value: string }>(`SELECT value FROM _meta WHERE key = 'has_prior_generation'`).toArray()[0];
    if (flag?.value !== '1') return false;
    const createdAtRow = this.ctx.storage.sql
      .exec<{ value: string }>(`SELECT value FROM _meta WHERE key = 'prior_generation_created_at'`)
      .toArray()[0];
    const age = createdAtRow ? Date.now() - new Date(createdAtRow.value).getTime() : Infinity;
    if (age < maxAgeMs) return false;
    await this.pruneRetainedGeneration(projectId);
    return true;
  }

  /** PLNR-250's scheduled sweep calls this: drop staged (never activated) index generations
   *  older than `maxAgeMs`. Nothing stages into `index_generations` before Phase 5's ingest
   *  pipeline exists, so this prunes zero rows until then — the method exists now so that
   *  pipeline has a cleanup path already wired rather than one someone has to remember to add. */
  async pruneAbandonedStagedGenerations(projectId: string, maxAgeMs: number): Promise<number> {
    await this.assertProjectId(projectId);
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const abandoned = this.ctx.storage.sql
      .exec<{ id: string }>(`SELECT id FROM index_generations WHERE status = 'staged' AND created_at < ?1`, cutoff)
      .toArray();
    if (abandoned.length === 0) return 0;
    this.ctx.storage.transactionSync(() => {
      // PLNR-261's staged children carry no real FK to index_generations(id) (see the
      // migration's comment) — delete them explicitly, child-before-parent, rather than relying
      // on a cascade DO SQLite doesn't provide.
      for (const { id } of abandoned) {
        this.ctx.storage.sql.exec(`DELETE FROM index_staged_edges WHERE generation_id = ?1`, id);
        this.ctx.storage.sql.exec(`DELETE FROM index_staged_entities WHERE generation_id = ?1`, id);
        this.ctx.storage.sql.exec(`DELETE FROM index_batches WHERE generation_id = ?1`, id);
      }
      this.ctx.storage.sql.exec(`DELETE FROM index_generations WHERE status = 'staged' AND created_at < ?1`, cutoff);
    });
    return abandoned.length;
  }

  private async reportVectorDirty(projectId: string, dirty: boolean): Promise<void> {
    await this.env.PROJECT_ROOM.get(this.env.PROJECT_ROOM.idFromName(projectId))
      .setMemoryVectorDirty(projectId, dirty)
      .catch((err) => console.warn(`ProjectMemory vector-dirty report for ${projectId} failed: ${String(err)}`));
  }

  /**
   * PLNR-255: the memory half of Phase 4's rebuild — re-embeds every memory item and episode
   * this project holds into the operational `noriq-search` index, then clears
   * `project_memory_registry.vector_dirty` (a restore or rollback sets it; nothing before this
   * task could ever clear it). PLNR-256 grows the CODE half onto the same method. An honest
   * no-op when no embeddings backend is bound — the dirty flag is left alone in that case,
   * since nothing was actually rebuilt from it.
   */
  async rebuildVectorIndex(projectId: string): Promise<{ ok: true; rebuilt: boolean; reason?: string; reindexed?: number }> {
    await this.assertProjectId(projectId);
    const backend = searchBackend(this.env);
    if (!backend) {
      const reason = 'VECTORIZE is not bound — nothing to rebuild';
      console.log(`ProjectMemory rebuildVectorIndex(${projectId}): ${reason}`);
      return { ok: true, rebuilt: false, reason };
    }
    const items = this.ctx.storage.sql
      .exec<{ id: string; kind: string; statement: string }>(`SELECT id, kind, statement FROM memory_items`)
      .toArray();
    for (const m of items) {
      await indexEntity(backend, { kind: 'memory', id: m.id, projectId, title: m.kind, body: m.statement });
    }
    const episodes = this.ctx.storage.sql
      .exec<{ id: string; run_id: string; body: string }>(`SELECT id, run_id, body FROM episodes`)
      .toArray();
    for (const e of episodes) {
      await indexEntity(backend, { kind: 'episode', id: e.id, projectId, title: `episode ${e.run_id}`, body: summarizeEpisodeBody(e.body) });
    }
    await this.reportVectorDirty(projectId, false);
    return { ok: true, rebuilt: true, reindexed: items.length + episodes.length };
  }

  // ---------------------------------------------------------------------------
  // Code-intelligence generation activation (PLNR-256)
  //
  // The code graph is empty today (PLNR-262 populates file/symbol/api/test nodes) — these two
  // RPCs are the ProjectMemory half of Phase 5's future ingest pipeline, which owns discovering
  // `entities`/`deletedUris` from a repository; this reuses the EXISTING `index_generations`
  // registry (migration 0001) rather than a parallel notion of "current generation", and adds
  // no new table. Activation's status transition is a real transactionSync (Vectorize writes
  // cannot join it — §4/§8); publishing/retiring vectors is best-effort outside that transaction,
  // exactly like every other write RPC's fire-and-forget indexing here.
  // ---------------------------------------------------------------------------

  // `activateCodeGeneration` (PLNR-256) used to live here: it inserted a generation DIRECTLY as
  // 'active' given caller-supplied entities, with no staging and no validation. PLNR-261
  // REFACTORED it into the stage (beginIndexIngest/ingestIndexBatch) -> validate
  // (completeIndexIngest) -> promote (activateIndexGeneration, below) sequence — the same RPC
  // surface, not a parallel one, now reading staged rows instead of trusting a direct parameter.

  /**
   * Bookkeeping GC for 'superseded' `index_generations` rows past their retention window —
   * mirrors `pruneAbandonedStagedGenerations`'s shape exactly. This does NOT retire vectors —
   * those are retired eagerly (best-effort) at activation via `deletedUris` above; a surviving
   * entity's vector is never orphaned because it is re-upserted at the same id under the new
   * generation. This only clears the now-inert registry row so `index_generations` does not
   * grow forever. Uses `activated_at` (when THIS generation itself went active) as the age
   * reference — there is no separate "superseded_at" column (adding one would mean a schema
   * migration this task does not need), so a long-lived generation becomes prunable
   * immediately once superseded rather than after its own separate grace period; the tradeoff
   * is documented here rather than hidden behind a precise-sounding column that doesn't exist.
   */
  async pruneSupersededGenerations(projectId: string, maxAgeMs: number): Promise<number> {
    await this.assertProjectId(projectId);
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const rows = this.ctx.storage.sql
      .exec<{ id: string }>(`SELECT id FROM index_generations WHERE status = 'superseded' AND activated_at < ?1`, cutoff)
      .toArray();
    if (rows.length === 0) return 0;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`DELETE FROM index_generations WHERE status = 'superseded' AND activated_at < ?1`, cutoff);
    });
    return rows.length;
  }

  // ---------------------------------------------------------------------------
  // Repository-index ingest — staged generations and atomic activation (PLNR-260/261).
  //
  // Unlike episode ingest below (still an in-memory bridge — PLNR-263 owns real episode
  // semantics), index-generation state is REAL and durable: `index_generations` (already existed,
  // PLNR-256) gains three children — index_batches, index_staged_entities, index_staged_edges —
  // and three additive columns (deletions, sealed_at, validation_problems). A generation's
  // manifest fields (batch_count/file_count/indexer_version/content_hash) are written ONCE, at
  // beginIndexIngest, from the REAL manifest — replacing the old activateCodeGeneration's
  // placeholders (0/entities.length/'unknown') that this refactor retires.
  //
  // Lifecycle: begin (insert 'staged', idempotent resume) -> batch* (idempotent per
  // (generationId, batchNumber), rejected once sealed) -> complete (seals; runs structural +
  // referential validation, recording `validation_problems`) -> activate (the ONLY promotion
  // path — refuses an unsealed or invalid generation; re-checks the current active generation
  // for this repository INSIDE the one transactionSync, so two concurrent activations cannot
  // both supersede the same prior row — reinforced by idx_index_generations_one_active, a
  // partial unique index making the invariant a real constraint, not just a code discipline).
  // Vector publish (best-effort, outside the transaction — a Vectorize upsert cannot join a
  // SQLite transaction, PLNR-256) is the only side effect of activation; PLNR-262 owns
  // projecting staged rows into `nodes`/`edges`.
  // ---------------------------------------------------------------------------
  private ingestEpisodes = new Map<string, IngestEpisodeState>();

  private getIndexGenerationRow(generationId: string) {
    return this.ctx.storage.sql
      .exec<{
        repository_key: string; branch: string; base_id: string; status: string;
        indexer_version: string; batch_count: number; file_count: number; content_hash: string;
        sealed_at: string | null; validation_problems: string | null; deletions: string;
        predecessor_generation_id: string | null; created_at: string;
      }>(
        `SELECT repository_key, branch, base_id, status, indexer_version, batch_count, file_count,
                content_hash, sealed_at, validation_problems, deletions, predecessor_generation_id, created_at
         FROM index_generations WHERE id = ?1`,
        generationId,
      )
      .toArray()[0];
  }

  /** Anti-join over the STAGED tables (mirrors the restore path's stagingIntegrityProblems in
   *  spirit, over a different pair of tables): a staged edge whose from/to uri is absent from
   *  this SAME generation's staged entities fails validation before anything activates. */
  private indexStagingIntegrityProblems(generationId: string): string[] {
    const dangling = this.ctx.storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM index_staged_edges e
         WHERE e.generation_id = ?1
           AND (NOT EXISTS (SELECT 1 FROM index_staged_entities n WHERE n.generation_id = ?1 AND n.uri = e.from_uri)
             OR NOT EXISTS (SELECT 1 FROM index_staged_entities n2 WHERE n2.generation_id = ?1 AND n2.uri = e.to_uri))`,
        generationId,
      )
      .toArray()[0]?.n ?? 0;
    return dangling > 0 ? [`${dangling} staged edge(s) reference a missing staged node`] : [];
  }

  /** Resolve a project's committed KEY from its projectId — a plain D1 read (env.DB is a normal
   *  binding; this isn't a coordination mutation, so it does not need to go through ProjectRoom).
   *  Needed because buildEntityUri's repository-scoped kinds take the project KEY, never the id
   *  (a projectId-shaped URI would parse, store, and never match anything real). */
  private async resolveProjectKey(projectId: string): Promise<string> {
    const row = await this.env.DB.prepare('SELECT key FROM projects WHERE id = ?').bind(projectId).first<{ key: string }>();
    if (!row) throw new Error(`project ${projectId} not found`);
    return row.key;
  }

  async beginIndexIngest(projectId: string, manifest: IndexGenerationManifest): Promise<{ ok: true }> {
    await this.assertProjectId(projectId);
    IndexGenerationManifest.parse(manifest);
    if (manifest.batchCount > MAX_INDEX_GENERATION_BATCHES) throw new Error(`batchCount exceeds ${MAX_INDEX_GENERATION_BATCHES}`);
    if (manifest.fileCount > MAX_INDEX_GENERATION_FILES) throw new Error(`fileCount exceeds ${MAX_INDEX_GENERATION_FILES}`);
    const existing = this.getIndexGenerationRow(manifest.generationId);
    if (existing && (existing.status !== 'staged' || existing.sealed_at)) {
      throw new Error(`generation ${manifest.generationId} already ${existing.sealed_at ? 'completed' : existing.status} — this purpose cannot be reopened`);
    }
    if (existing) {
      const same = existing.repository_key === manifest.repositoryKey
        && existing.branch === manifest.branch
        && existing.base_id === manifest.baseId
        && existing.indexer_version === manifest.indexerVersion
        && existing.batch_count === manifest.batchCount
        && existing.file_count === manifest.fileCount
        && existing.content_hash === manifest.contentHash
        && existing.deletions === JSON.stringify(manifest.deletions)
        && existing.created_at === manifest.createdAt;
      if (!same) throw new Error(`generation ${manifest.generationId} already began with a different manifest`);
      return { ok: true };
    }
    const now = nowIso();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO repositories (repository_key, created_at) VALUES (?1, ?2) ON CONFLICT (repository_key) DO NOTHING`,
        manifest.repositoryKey,
        now,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO index_generations
           (id, repository_key, branch, base_id, indexer_version, batch_count, file_count, content_hash,
            deletions, predecessor_generation_id, status, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,
           (SELECT id FROM index_generations WHERE repository_key = ?2 AND status = 'active'),
           'staged',?10)`,
        manifest.generationId,
        manifest.repositoryKey,
        manifest.branch,
        manifest.baseId,
        manifest.indexerVersion,
        manifest.batchCount,
        manifest.fileCount,
        manifest.contentHash,
        JSON.stringify(manifest.deletions),
        manifest.createdAt,
      );
    });
    return { ok: true };
  }

  async ingestIndexBatch(projectId: string, batch: IndexBatch, rows: Array<Record<string, unknown>>): Promise<{ ok: true; deduped: boolean }> {
    await this.assertProjectId(projectId);
    const gen = this.getIndexGenerationRow(batch.generationId);
    if (!gen) throw new Error(`no ingest in progress for generation ${batch.generationId} — call beginIndexIngest first`);
    if (gen.sealed_at || gen.status !== 'staged') {
      throw new Error(`generation ${batch.generationId} is already ${gen.sealed_at ? 'completed' : gen.status} — refusing a batch for a completed purpose`);
    }
    if (batch.batchNumber >= gen.batch_count) throw new Error(`batchNumber ${batch.batchNumber} is outside declared batchCount ${gen.batch_count}`);
    const already = this.ctx.storage.sql
      .exec<{ batch_hash: string }>(`SELECT batch_hash FROM index_batches WHERE generation_id = ?1 AND batch_number = ?2`, batch.generationId, batch.batchNumber)
      .toArray()[0];
    if (already) {
      if (already.batch_hash !== batch.batchHash) throw new Error(`batch ${batch.batchNumber} was already accepted with a different hash`);
      return { ok: true, deduped: true };
    }
    const parsedRows = rows.map(parseStagedRow);
    const contentBytes = stagedRowsCanonicalBytes(parsedRows);
    const totals = this.ctx.storage.sql
      .exec<{ rows: number; bytes: number }>(
        `SELECT COALESCE(SUM(row_count), 0) AS rows, COALESCE(SUM(content_bytes), 0) AS bytes
           FROM index_batches WHERE generation_id = ?1`, batch.generationId,
      ).toArray()[0]!;
    // Each batch's own canonical size excludes the separator that would sit between it and
    // previously accepted rows in the generation-wide newline-delimited representation.
    const accountedContentBytes = contentBytes + (totals.rows > 0 && parsedRows.length > 0 ? 1 : 0);
    if (totals.rows + parsedRows.length > MAX_INDEX_GENERATION_ROWS) throw new Error(`generation exceeds ${MAX_INDEX_GENERATION_ROWS} rows`);
    if (totals.bytes + accountedContentBytes > MAX_INDEX_GENERATION_BYTES) throw new Error(`generation exceeds ${MAX_INDEX_GENERATION_BYTES} canonical bytes`);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO index_batches (generation_id, batch_number, batch_hash, row_count, content_bytes, received_at) VALUES (?1,?2,?3,?4,?5,?6)`,
        batch.generationId,
        batch.batchNumber,
        batch.batchHash,
        rows.length,
        accountedContentBytes,
        nowIso(),
      );
      for (const row of parsedRows) {
        if (row.kind === 'node') {
          this.ctx.storage.sql.exec(
            `INSERT INTO index_staged_entities (generation_id, uri, type, label, content) VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT (generation_id, uri) DO UPDATE SET type = excluded.type, label = excluded.label, content = excluded.content`,
            batch.generationId,
            row.uri,
            row.type,
            row.label,
            row.content,
          );
        } else {
          this.ctx.storage.sql.exec(
            `INSERT INTO index_staged_edges (generation_id, type, from_uri, to_uri) VALUES (?1,?2,?3,?4)
             ON CONFLICT (generation_id, type, from_uri, to_uri) DO NOTHING`,
            batch.generationId,
            row.type,
            row.from,
            row.to,
          );
        }
      }
    });
    return { ok: true, deduped: false };
  }

  /** The VALIDATE + conditional PROMOTE step. Seals the generation (no further batches accepted)
   *  and records actionable `validation_problems`. A clean generation auto-activates only if its
   *  recorded predecessor is still current. Idempotent retries re-report validation and the same
   *  activation rather than rebuilding a second generation. */
  async completeIndexIngest(
    projectId: string,
    generationId: string,
  ): Promise<{
    ok: true; batchesReceived: number; validation: { ok: boolean; problems: string[] };
    activation?: Awaited<ReturnType<ProjectMemory['activateIndexGeneration']>>;
  }> {
    await this.assertProjectId(projectId);
    const gen = this.getIndexGenerationRow(generationId);
    if (!gen) throw new Error(`no ingest in progress for generation ${generationId}`);
    if (gen.status === 'active') {
      const activation = await this.activateIndexGeneration(projectId, generationId, true);
      return { ok: true, batchesReceived: gen.batch_count, validation: { ok: true, problems: [] }, activation };
    }
    if (gen.status !== 'staged') throw new Error(`generation ${generationId} is already ${gen.status}`);
    const received = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM index_batches WHERE generation_id = ?1`, generationId)
      .toArray()[0]!.n;
    if (gen.sealed_at) {
      const problems: string[] = gen.validation_problems ? JSON.parse(gen.validation_problems) : [];
      if (problems.length) return { ok: true, batchesReceived: received, validation: { ok: false, problems } };
      const activation = await this.activateIndexGeneration(projectId, generationId, true);
      return { ok: true, batchesReceived: received, validation: { ok: true, problems }, activation };
    }
    const problems: string[] = [];
    if (received !== gen.batch_count) problems.push(`expected ${gen.batch_count} batches, received ${received}`);
    const fileEntities = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM index_staged_entities WHERE generation_id = ?1 AND type = 'file'`, generationId)
      .toArray()[0]!.n;
    if (fileEntities !== gen.file_count) problems.push(`manifest declares fileCount ${gen.file_count}, staged ${fileEntities} file entities`);
    problems.push(...this.indexStagingIntegrityProblems(generationId));
    const stagedRows = this.ctx.storage.sql
      .exec<{ n: number }>(
        `SELECT
           (SELECT COUNT(*) FROM index_staged_entities WHERE generation_id = ?1) +
           (SELECT COUNT(*) FROM index_staged_edges WHERE generation_id = ?1) AS n`,
        generationId,
      ).toArray()[0]!.n;
    const receivedRows = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COALESCE(SUM(row_count), 0) AS n FROM index_batches WHERE generation_id = ?1`, generationId)
      .toArray()[0]!.n;
    if (receivedRows !== stagedRows) problems.push(`received ${receivedRows} rows but staged ${stagedRows} unique rows`);
    const hasher = new OrderedStagedContentHasher();
    for (const entity of this.ctx.storage.sql.exec<{ uri: string; type: string; label: string; content: string | null }>(
      `SELECT uri, type, label, content FROM index_staged_entities WHERE generation_id = ?1 ORDER BY uri`,
      generationId,
    )) {
      hasher.update({ kind: 'node', ...entity });
    }
    for (const edge of this.ctx.storage.sql.exec<{ type: string; from_uri: string; to_uri: string }>(
      `SELECT type, from_uri, to_uri FROM index_staged_edges
       WHERE generation_id = ?1 ORDER BY from_uri, type, to_uri`,
      generationId,
    )) {
      hasher.update({ kind: 'edge', type: edge.type, from: edge.from_uri, to: edge.to_uri });
    }
    const actualHash = hasher.digestHex();
    if (actualHash !== gen.content_hash) problems.push(`contentHash mismatch: expected ${gen.content_hash}, computed ${actualHash}`);
    const projectKey = await this.resolveProjectKey(projectId);
    let omittedValidationProblems = 0;
    const addValidationProblem = (problem: string) => {
      if (problems.length < 100) problems.push(problem);
      else omittedValidationProblems++;
    };
    for (const entity of this.ctx.storage.sql.exec<{ uri: string; type: string; label: string }>(
      `SELECT uri, type, label FROM index_staged_entities WHERE generation_id = ?1`, generationId,
    )) {
      const reason = projectionEntityProblem(projectKey, { ...entity, content: null }, gen.repository_key);
      if (reason) addValidationProblem(`invalid entity ${entity.uri}: ${reason}`);
    }
    for (const edge of this.ctx.storage.sql.exec<{ type: string; from_uri: string; to_uri: string }>(
      `SELECT type, from_uri, to_uri FROM index_staged_edges WHERE generation_id = ?1`, generationId,
    )) {
      const projected = { type: edge.type, fromUri: edge.from_uri, toUri: edge.to_uri };
      const reason = projectionEdgeTypeProblem(projected);
      if (reason) addValidationProblem(`invalid edge ${projected.fromUri} -[${projected.type}]-> ${projected.toUri}: ${reason}`);
    }
    if (omittedValidationProblems) problems.push(`${omittedValidationProblems} additional validation problem(s) omitted`);
    this.ctx.storage.sql.exec(
      `UPDATE index_generations SET sealed_at = ?2, validation_problems = ?3 WHERE id = ?1`,
      generationId,
      nowIso(),
      problems.length ? JSON.stringify(problems) : null,
    );
    if (problems.length) return { ok: true, batchesReceived: received, validation: { ok: false, problems } };
    const activation = await this.activateIndexGeneration(projectId, generationId, true);
    return { ok: true, batchesReceived: received, validation: { ok: true, problems }, activation };
  }

  private appliedGenerationProjection(generationId: string): {
    nodesWritten: number; edgesWritten: number; entitiesSkipped: number; edgesSkipped: number; retired: number; coChangeEdges: number;
  } | null {
    const row = this.ctx.storage.sql.exec<{ result: string }>(
      `SELECT result FROM applied_operations
        WHERE subject_type = 'generation-projection' AND subject_id = ?1
        ORDER BY applied_at DESC LIMIT 1`, generationId,
    ).toArray()[0];
    if (!row) return null;
    const prior = JSON.parse(row.result) as Partial<{
      nodesWritten: number; edgesWritten: number; entitiesSkipped: number; edgesSkipped: number; retired: number; coChangeEdges: number;
    }>;
    return {
      nodesWritten: prior.nodesWritten ?? 0,
      edgesWritten: prior.edgesWritten ?? 0,
      entitiesSkipped: prior.entitiesSkipped ?? 0,
      edgesSkipped: prior.edgesSkipped ?? 0,
      retired: prior.retired ?? 0,
      coChangeEdges: prior.coChangeEdges ?? 0,
    };
  }

  /** Apply graph rows, retirement, revision and idempotency bookkeeping inside the caller's
   * transaction. The staged cursors are consumed one row at a time; source `content` is neither
   * selected nor copied because graph projection only needs uri/type/label. Generation status
   * changes are deliberately performed in that same transaction. */
  private applyGenerationProjection(
    generationId: string,
    previousGenerationId: string | null,
  ): { nodesWritten: number; edgesWritten: number; entitiesSkipped: number; edgesSkipped: number; retired: number; coChangeEdges: number } {
    let nodesWritten = 0;
    let edgesWritten = 0;
    let retired = 0;
    let coChangeEdges = 0;
    const now = nowIso();
    for (const e of this.ctx.storage.sql.exec<{ uri: string; type: string; label: string }>(
      `SELECT uri, type, label FROM index_staged_entities WHERE generation_id = ?1`, generationId,
    )) {
      this.ctx.storage.sql.exec(
        `INSERT INTO nodes (id, type, uri, label, created_at) VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT (uri) DO UPDATE SET label = excluded.label, type = excluded.type`,
        newId('node'), e.type, e.uri, e.label, now,
      );
      nodesWritten++;
    }
    const nodeIdByUri = (uri: string): string | undefined =>
      this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE uri = ?1`, uri).toArray()[0]?.id;
    for (const e of this.ctx.storage.sql.exec<{ type: string; from_uri: string; to_uri: string }>(
      `SELECT type, from_uri, to_uri FROM index_staged_edges WHERE generation_id = ?1`, generationId,
    )) {
      const fromId = nodeIdByUri(e.from_uri);
      const toId = nodeIdByUri(e.to_uri);
      if (!fromId || !toId) throw new Error(`validated edge endpoint disappeared during projection`);
      this.ctx.storage.sql.exec(
        `INSERT INTO edges (id, type, from_node_id, to_node_id, created_at) VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT (type, from_node_id, to_node_id) DO NOTHING`,
        newId('edge'), e.type, fromId, toId, now,
      );
      edgesWritten++;
    }
    if (previousGenerationId) {
      for (const prior of this.ctx.storage.sql.exec<{ uri: string }>(
        `SELECT previous.uri FROM index_staged_entities previous
         WHERE previous.generation_id = ?1 AND previous.type = 'file'
           AND NOT EXISTS (
             SELECT 1 FROM index_staged_entities current
             WHERE current.generation_id = ?2 AND current.type = 'file' AND current.uri = previous.uri
           )`,
        previousGenerationId,
        generationId,
      )) {
        const node = nodeIdByUri(prior.uri);
        if (!node) continue;
        this.ctx.storage.sql.exec(`DELETE FROM edges WHERE from_node_id = ?1 OR to_node_id = ?1`, node);
        retired++;
      }
      const changed = this.ctx.storage.sql.exec<{ uri: string }>(
        `SELECT previous.uri FROM index_staged_entities previous
         WHERE previous.generation_id = ?1 AND previous.type = 'file'
           AND NOT EXISTS (
             SELECT 1 FROM index_staged_entities current
             WHERE current.generation_id = ?2 AND current.type = 'file' AND current.uri = previous.uri
           )
         UNION ALL
         SELECT current.uri FROM index_staged_entities current
         WHERE current.generation_id = ?2 AND current.type = 'file'
           AND NOT EXISTS (
             SELECT 1 FROM index_staged_entities previous
             WHERE previous.generation_id = ?1 AND previous.type = 'file' AND previous.uri = current.uri
           )
         LIMIT ?3`,
        previousGenerationId,
        generationId,
        CO_CHANGE_PAIR_CAP + 1,
      ).toArray().map((row) => row.uri);
      if (changed.length > CO_CHANGE_PAIR_CAP) {
        console.warn(`ProjectMemory projection(${generationId}): more than ${CO_CHANGE_PAIR_CAP} files exceed the co-change cap`);
      }
      for (const [a, b] of coChangePairs(changed)) {
        const aId = nodeIdByUri(a);
        const bId = nodeIdByUri(b);
        if (!aId || !bId) continue;
        this.ctx.storage.sql.exec(
          `INSERT INTO edges (id, type, from_node_id, to_node_id, created_at) VALUES (?1,'commonly_changes_with',?2,?3,?4)
           ON CONFLICT (type, from_node_id, to_node_id) DO NOTHING`,
          newId('edge'), aId, bId, now,
        );
        coChangeEdges++;
      }
    }
    const result = {
      nodesWritten,
      edgesWritten,
      entitiesSkipped: 0,
      edgesSkipped: 0,
      retired,
      coChangeEdges,
    };
    const operationId = newId('op');
    this.ctx.storage.sql.exec(
      `INSERT INTO outbox (id, operation_id, verb, subject_type, subject_id, payload, created_at) VALUES (?1,?2,'memory.changed','memory',?3,?4,?5)`,
      newId('obx'), operationId, generationId,
      JSON.stringify({ operationId, entityType: 'generation-projection', generationId, nodesWritten: result.nodesWritten, edgesWritten: result.edgesWritten }),
      now,
    );
    this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = value + 1 WHERE id = 0`);
    this.ctx.storage.sql.exec(
      `INSERT INTO applied_operations (operation_id, applied_at, subject_type, subject_id, result) VALUES (?1,?2,'generation-projection',?3,?4)`,
      operationId, now, generationId, JSON.stringify(result),
    );
    return result;
  }

  /** Best-effort vector publishing stays off the activation response path and consumes one
   * staged content row at a time. `waitUntil` preserves the prior non-blocking contract while
   * the awaited loop prevents thousands of content-holding embedding promises from piling up. */
  private async publishGenerationVectors(
    backend: NonNullable<ReturnType<typeof codeSearchBackend>>,
    projectId: string,
    generationId: string,
    repositoryKey: string,
    encodedDeletions: string,
  ): Promise<void> {
    for (const entity of this.ctx.storage.sql.exec<{ uri: string; type: string; label: string; content: string | null }>(
      `SELECT uri, type, label, content FROM index_staged_entities WHERE generation_id = ?1 ORDER BY uri`,
      generationId,
    )) {
      await indexCodeEntity(backend, {
        uri: entity.uri,
        projectId,
        repositoryKey,
        generationId,
        type: entity.type as CodeEntityType,
        label: entity.label,
        content: entity.content,
      }).catch((err) => console.warn(`ProjectMemory code-index for ${entity.uri} failed: ${String(err)}`));
    }
    const deletions: string[] = JSON.parse(encodedDeletions || '[]');
    if (!deletions.length) return;
    const projectKey = await this.resolveProjectKey(projectId);
    for (const path of deletions) {
      const uri = buildEntityUri({ kind: 'file', projectKey, repositoryKey, path });
      await removeCodeEntity(backend, uri)
        .catch((err) => console.warn(`ProjectMemory code-deindex for ${uri} failed: ${String(err)}`));
    }
  }

  /** The PROMOTE step — the ONLY writer of `status = 'active'`. Refuses a generation that has
   *  not completed ingest (no `sealed_at`) or that failed validation. Re-activating the current
   *  generation republishes it idempotently, so a partial failure or lost response is retryable. */
  async activateIndexGeneration(
    projectId: string,
    generationId: string,
    enforcePredecessor = false,
  ): Promise<{
    activated: string;
    superseded: string[];
    projection: { nodesWritten: number; edgesWritten: number; entitiesSkipped: number; edgesSkipped: number; retired: number; coChangeEdges: number };
  }> {
    await this.assertProjectId(projectId);
    const gen = this.getIndexGenerationRow(generationId);
    if (!gen) throw new Error(`generation ${generationId} not found`);
    const retryingActive = gen.status === 'active';
    if (!retryingActive && gen.status !== 'staged') throw new Error(`generation ${generationId} is already ${gen.status}`);
    if (!retryingActive && !gen.sealed_at) throw new Error(`generation ${generationId} has not completed ingest — call completeIndexIngest first`);
    if (!retryingActive && gen.validation_problems) throw new Error(`generation ${generationId} failed validation: ${gen.validation_problems}`);

    let superseded: string[] = [];
    let projection = this.appliedGenerationProjection(generationId);
    if (!projection) {
      this.ctx.storage.transactionSync(() => {
        const active = this.ctx.storage.sql
          .exec<{ id: string }>(`SELECT id FROM index_generations WHERE repository_key = ?1 AND status = 'active'`, gen.repository_key)
          .toArray();
        const currentActive = active[0]?.id ?? null;
        if (!retryingActive && enforcePredecessor && currentActive !== gen.predecessor_generation_id) {
          throw new Error(
            `generation ${generationId} cannot auto-activate because the active predecessor changed from ${gen.predecessor_generation_id ?? 'none'} to ${currentActive ?? 'none'}`,
          );
        }
        superseded = retryingActive ? [] : active.map((r) => r.id);
        projection = this.applyGenerationProjection(generationId, retryingActive ? null : currentActive);
        for (const id of superseded) this.ctx.storage.sql.exec(`UPDATE index_generations SET status = 'superseded' WHERE id = ?1`, id);
        if (!retryingActive) {
          this.ctx.storage.sql.exec(`UPDATE index_generations SET status = 'active', activated_at = ?2 WHERE id = ?1`, generationId, nowIso());
        }
      });
      this.ctx.storage.setAlarm(Date.now()).catch(() => {});
    }

    // Best-effort vector publish, OUTSIDE the transaction (PLNR-256: a Vectorize upsert cannot
    // join a SQLite transaction; correctness comes from query-time generation filtering, never
    // from "we deleted the old vectors").
    const backend = codeSearchBackend(this.env);
    if (backend) {
      this.ctx.waitUntil(
        this.publishGenerationVectors(backend, projectId, generationId, gen.repository_key, gen.deletions)
          .catch((err) => console.warn(`ProjectMemory code-index generation ${generationId} failed: ${String(err)}`)),
      );
    }

    // D1-side active-generation PROJECTION (PLNR-259) — DO -> ProjectRoom -> D1, mirroring
    // upsertMemoryHealth/updateMemoryBackupStatus/setMemoryVectorDirty. Best-effort: the DO's own
    // index_generations.status is authority regardless of whether this projection lands.
    await this.env.PROJECT_ROOM.get(this.env.PROJECT_ROOM.idFromName(projectId))
      .setRepositoryActiveGeneration(projectId, gen.repository_key, generationId)
      .catch((err) => console.warn(`ProjectMemory active-generation projection for ${projectId}/${gen.repository_key} failed: ${String(err)}`));

    return { activated: generationId, superseded, projection: projection! };
  }

  /**
   * Project an ALREADY-ACTIVE generation's staged entities/edges into the live graph
   * (`nodes`/`edges`) — PLNR-262. Staging (PLNR-261) never writes here, which is what keeps a
   * staged-but-unvalidated generation invisible to every query surface; this is the one place
   * that promotes staged rows into current project knowledge.
   *
   * Bulk, not per-row: a single `transactionSync` upserts every valid entity and edge and emits
   * ONE summary outbox event, never one per entity/edge (writeNode/writeEdge's per-call outbox +
   * memory_revision + applied_operations + alarm would flood the coordination event log on a
   * real repository).
   *
   * Stable identity is free: `buildEntityUri` is generation-free (§18) and the upsert is
   * `ON CONFLICT (uri) DO UPDATE`, so an unchanged entity re-projected under a new generationId
   * keeps its existing node id automatically — no version key needed.
   *
   * Retirement: an entity present in the PREVIOUS active generation for this repository but
   * absent from this one has its live EDGES severed (not its node deleted — edges FK-reference
   * nodes and Durable Object SQLite enforces that always; the node row survives so evidence/
   * episodes citing its uri by string still resolve). Every current graph-traversal query
   * surface (dependencyNeighborhood et al., PLNR-258) walks edges from a seed, so a retired
   * entity stops appearing as "current" without its history being erased.
   */
  async projectActiveGeneration(
    projectId: string,
    generationId: string,
  ): Promise<{ nodesWritten: number; edgesWritten: number; entitiesSkipped: number; edgesSkipped: number; retired: number; coChangeEdges: number }> {
    await this.assertProjectId(projectId);
    const gen = this.getIndexGenerationRow(generationId);
    if (!gen) throw new Error(`generation ${generationId} not found`);
    if (gen.status !== 'active') throw new Error(`generation ${generationId} is ${gen.status} — only an active generation may be projected`);
    const priorProjection = this.appliedGenerationProjection(generationId);
    if (priorProjection) return priorProjection;
    const prevGen = this.ctx.storage.sql
      .exec<{ id: string }>(
        `SELECT id FROM index_generations WHERE repository_key = ?1 AND status = 'superseded' AND id != ?2 ORDER BY activated_at DESC, id DESC LIMIT 1`,
        gen.repository_key,
        generationId,
      )
      .toArray()[0];
    let result!: ReturnType<ProjectMemory['applyGenerationProjection']>;
    this.ctx.storage.transactionSync(() => {
      result = this.applyGenerationProjection(generationId, prevGen?.id ?? null);
    });
    this.ctx.storage.setAlarm(Date.now()).catch(() => {});
    return result;
  }

  /** Abort a still-staged generation, dropping its staged rows. Refuses once active/superseded —
   *  there is no undo for a promotion; a sealed-but-not-yet-activated (validated or not)
   *  generation may still be aborted. */
  async abortIndexIngest(projectId: string, generationId: string): Promise<{ ok: true }> {
    await this.assertProjectId(projectId);
    const gen = this.getIndexGenerationRow(generationId);
    if (!gen) return { ok: true };
    if (gen.status !== 'staged') throw new Error(`generation ${generationId} is already ${gen.status} — cannot abort`);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`DELETE FROM index_staged_edges WHERE generation_id = ?1`, generationId);
      this.ctx.storage.sql.exec(`DELETE FROM index_staged_entities WHERE generation_id = ?1`, generationId);
      this.ctx.storage.sql.exec(`DELETE FROM index_batches WHERE generation_id = ?1`, generationId);
      this.ctx.storage.sql.exec(`DELETE FROM index_generations WHERE id = ?1`, generationId);
    });
    return { ok: true };
  }

  async indexIngestStatus(
    projectId: string,
    generationId: string,
  ): Promise<{ status: 'unknown' | 'staged' | 'active' | 'superseded'; sealed: boolean; batchesReceived: number; batchesExpected: number | null; validation: { ok: boolean; problems: string[] } | null }> {
    await this.assertProjectId(projectId);
    const gen = this.getIndexGenerationRow(generationId);
    if (!gen) return { status: 'unknown', sealed: false, batchesReceived: 0, batchesExpected: null, validation: null };
    const received = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM index_batches WHERE generation_id = ?1`, generationId)
      .toArray()[0]!.n;
    return {
      status: gen.status as 'staged' | 'active' | 'superseded',
      sealed: !!gen.sealed_at,
      batchesReceived: received,
      batchesExpected: gen.batch_count,
      validation: gen.sealed_at ? { ok: !gen.validation_problems, problems: gen.validation_problems ? JSON.parse(gen.validation_problems) : [] } : null,
    };
  }

  /** PLNR-273: every `index_generations` row for this project (staged, active, and superseded),
   *  newest first — the operator panel's source for per-repository generation history, ingest
   *  progress/errors, and which staged generations are (and are not) safe to offer for
   *  activation. A straight read; it does not filter by repository or status, matching this DO's
   *  other list RPCs (the caller narrows). */
  async listIndexGenerations(projectId: string): Promise<IndexGenerationSummary[]> {
    await this.assertProjectId(projectId);
    const rows = this.ctx.storage.sql
      .exec<{
        id: string; repository_key: string; branch: string; base_id: string; indexer_version: string;
        status: string; batch_count: number; file_count: number; sealed_at: string | null;
        validation_problems: string | null; created_at: string; activated_at: string | null;
      }>(
        `SELECT id, repository_key, branch, base_id, indexer_version, status, batch_count, file_count,
                sealed_at, validation_problems, created_at, activated_at
         FROM index_generations ORDER BY created_at DESC`,
      )
      .toArray();
    return rows.map((r) => ({
      id: r.id,
      repositoryKey: r.repository_key,
      branch: r.branch,
      baseId: r.base_id,
      indexerVersion: r.indexer_version,
      status: r.status as IndexGenerationSummary['status'],
      batchCount: r.batch_count,
      fileCount: r.file_count,
      sealedAt: r.sealed_at,
      validationProblems: r.validation_problems ? (JSON.parse(r.validation_problems) as string[]) : [],
      createdAt: r.created_at,
      activatedAt: r.activated_at,
    }));
  }

  /**
   * The canonical episode writer (PLNR-263, §14). ONE episode per (run, sitting): UPSERTs on
   * `(run_id, sitting)` (0007's unique index — corrected from 0006's run_id-only index, which
   * let `ProjectRoom.reopenRun`'s second sitting of a build overwrite the first sitting's
   * episode; RUN-182's reopen reuses one run id across sittings, it does not mint a new run),
   * which is what makes duplicate delivery idempotent without an operation-id ledger lookup — a
   * re-recorded skeleton (a replay, or the same sitting settling twice through two different
   * callers) just overwrites the same row, while a NEW sitting gets its own.
   *
   * Server-owned skeleton fields always win. The optional daemon-owned enrichment fields merge
   * according to `writeMode`: skeleton replays preserve all prior enrichment; enrichment uploads
   * replace only fields actually present in the upload; direct callers retain replace semantics.
   * A present, valid selfSummary wins while an absent or malformed one always preserves the
   * existing value.
   *
   * Bulk graph write, ONE transaction, ONE outbox event — the same discipline
   * `projectActiveGeneration`'s doc comment states and for the same reason: per-edge
   * writeNode/writeEdge calls would emit an outbox row and bump `memory_revision` once per edge
   * for one logical "this run produced an episode" fact.
   *
   * The five edges this writes, and only these (locked — see the task's execution spec):
   *   episode --derived_from--> run
   *   episode --related_to--> task        (if this run has a task anchor)
   *   episode --owned_by--> agent         (if this run minted an agent)
   *   episode --modifies--> file          (one per `filesTouched`, only when `repositoryKey` is
   *                                         known — an unqualified path cannot become a URI)
   *   episode --related_to--> memory      (every `memory_items` row this run's OWN agent
   *                                         recorded — a runner-spawned agent lives for exactly
   *                                         one run, RUN-43, so `recorded_by_agent_id = agentId`
   *                                         IS "recorded during this run", no time-window needed)
   */
  async recordEpisode(
    projectId: string,
    input: RecordEpisodeInput,
  ): Promise<{ episodeId: string; runId: string; created: boolean; nodesWritten: number; edgesWritten: number }> {
    await this.assertProjectId(projectId);
    if (!['done', 'failed', 'cancelled'].includes(input.outcome)) {
      throw new Error(`recordEpisode: outcome "${input.outcome}" is not one of done/failed/cancelled`);
    }
    const now = nowIso();

    // Absent OR malformed both leave the episode valid (§14) — `.catch(null)` swallows a bad
    // self-summary rather than rejecting the whole record, reusing the SAME tolerance
    // `EffortEpisode.selfSummary` already declares (see that field's doc comment in memory.ts).
    const providedSelfSummary = EpisodeSelfSummary.nullable().catch(null).parse(input.selfSummary ?? null);

    // Read BEFORE building the new body: merge modes need the prior daemon enrichment and every
    // upsert needs its STABLE id. Keyed on (run_id, sitting) — a DIFFERENT
    // sitting of the same run must find no existing row here, which is exactly what makes it a
    // fresh episode rather than an overwrite of an earlier sitting's. A plain read needs no
    // transactionSync (nothing else can run inside this DO concurrently); the transactionSync
    // below is for the WRITE.
    const existingRow = this.ctx.storage.sql
      .exec<{ id: string; body: string; created_at: string }>(
        `SELECT id, body, created_at FROM episodes WHERE run_id = ?1 AND sitting = ?2`,
        input.runId, input.sitting,
      )
      .toArray()[0];
    let existingBody: Partial<EffortEpisodeData> = {};
    if (existingRow) {
      try {
        const parsedExisting = EffortEpisode.safeParse(JSON.parse(existingRow.body));
        if (parsedExisting.success) existingBody = parsedExisting.data;
      } catch { /* an unreadable prior body is treated as no prior enrichment, not an error */ }
    }
    const mergedSelfSummary = providedSelfSummary ?? existingBody.selfSummary ?? null;
    const mode = input.writeMode ?? 'replace';
    const mergeEnrichment = <K extends 'filesTouched' | 'commands' | 'testsRun' | 'failures' | 'findings'>(
      key: K,
      fallback: NonNullable<RecordEpisodeInput[K]>,
    ): NonNullable<RecordEpisodeInput[K]> => {
      const provided = input[key];
      if (mode === 'skeleton') return (existingBody[key] as NonNullable<RecordEpisodeInput[K]> | undefined) ?? provided ?? fallback;
      if (mode === 'enrichment') return provided ?? (existingBody[key] as NonNullable<RecordEpisodeInput[K]> | undefined) ?? fallback;
      return provided ?? fallback;
    };
    const filesTouched = mergeEnrichment('filesTouched', []);
    const commands = mergeEnrichment('commands', []);
    const testsRun = mergeEnrichment('testsRun', []);
    const failures = mergeEnrichment('failures', []);
    const findings = mergeEnrichment('findings', []);
    const createdAt = existingRow?.created_at ?? now;
    // Resolved ONCE, synchronously, before either the hash or the write — never re-derived from
    // an ON CONFLICT clause's excluded/target ambiguity, so `body.id` and the row's own `id`
    // column can never disagree.
    const episodeId = existingRow?.id ?? newId('epi');
    const created = !existingRow;
    const acceptedMemoryRevision = (this.ctx.storage.sql
      .exec<{ value: number }>(`SELECT value FROM memory_revision WHERE id = 0`)
      .toArray()[0]?.value ?? 0) + 1;
    // The caller cannot know the Durable Object's stable episode id. It supplies every other
    // server-derived fact; this storage seam completes the identity. Daemon enrichment cannot
    // replace it because its accepted upload schema never carries `intelligence`.
    const intelligence = input.intelligence
      ? {
          ...input.intelligence,
          identity: { episodeId, ...input.intelligence.identity },
          sources: { ...input.intelligence.sources, memoryRevision: acceptedMemoryRevision },
        }
      : existingBody.intelligence;

    // Validated (and default-filled) through the SAME shared schema the wire contract uses —
    // the full EffortEpisode rides `body` as JSON (locked decision; the table's own header
    // comment already settles this), so this is the one construction site for that JSON, not a
    // hand-rolled shape a second place could drift from.
    const bodyObject = EffortEpisode.parse({
      id: episodeId,
      projectId,
      runId: input.runId,
      taskId: input.taskId,
      repositoryKey: input.repositoryKey,
      baseId: input.baseId,
      timeline: input.timeline,
      filesTouched,
      commands,
      testsRun,
      failures,
      findings,
      reviewRounds: input.reviewRounds,
      tokenUsage: input.tokenUsage,
      costUSD: input.costUSD,
      acceptanceCoverage: input.acceptanceCoverage,
      steeringEvents: input.steeringEvents,
      landingOutcome: input.landingOutcome,
      remainingWork: input.remainingWork,
      intelligence,
      selfSummary: mergedSelfSummary,
      createdAt,
    });
    const finalBody = JSON.stringify(bodyObject);
    const contentHash = await sha256HexBytes(new TextEncoder().encode(finalBody));

    // Only needed to build file URIs (§18's repository-scoped shape) — skip the D1 round trip
    // when there is nothing to link.
    const projectKey = input.repositoryKey && bodyObject.filesTouched.length ? await this.resolveProjectKey(projectId) : null;

    let nodesWritten = 0;
    let edgesWritten = 0;
    this.ctx.storage.transactionSync(() => {
      if (this._forceWriteFailure) throw new Error('injected write failure (test)');
      // `episodeId` (from `existingRow.id`, when present) is ALSO what conflicts on
      // `(run_id, sitting)` below — so on an update this re-supplies the SAME id the row already
      // has, never a fresh one; on a first write of this sitting it is the only id anyone has
      // ever assigned. Either way the `id` column itself is never in the UPDATE SET list,
      // matching writeNode/writeEdge's own "never move a stable id" convention. A DIFFERENT
      // sitting of the same run conflicts on neither `id` (a fresh `newId('epi')`, since
      // `existingRow` above found nothing for THIS sitting) nor `run_id` alone (0007 dropped that
      // unique index) — it inserts a brand-new row.
      this.ctx.storage.sql.exec(
        `INSERT INTO episodes
           (id, run_id, sitting, task_id, repository_key, base_id, landing_outcome, review_rounds, cost_usd,
            acceptance_coverage, body, created_at, agent_id, run_kind, outcome, started_at, finished_at, content_hash)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)
         ON CONFLICT (run_id, sitting) DO UPDATE SET
           task_id = excluded.task_id, repository_key = excluded.repository_key, base_id = excluded.base_id,
           landing_outcome = excluded.landing_outcome, review_rounds = excluded.review_rounds,
           cost_usd = excluded.cost_usd, acceptance_coverage = excluded.acceptance_coverage, body = excluded.body,
           agent_id = excluded.agent_id, run_kind = excluded.run_kind, outcome = excluded.outcome,
           started_at = excluded.started_at, finished_at = excluded.finished_at, content_hash = excluded.content_hash`,
        episodeId, input.runId, input.sitting, input.taskId, input.repositoryKey, input.baseId, input.landingOutcome,
        input.reviewRounds, input.costUSD, input.acceptanceCoverage, finalBody, createdAt,
        input.agentId, input.runKind, input.outcome, input.startedAt, input.finishedAt, contentHash,
      );

      const upsertNode = (type: string, uri: string, label: string): string => {
        this.ctx.storage.sql.exec(
          `INSERT INTO nodes (id, type, uri, label, created_at) VALUES (?1,?2,?3,?4,?5)
           ON CONFLICT (uri) DO UPDATE SET label = excluded.label`,
          newId('node'), type, uri, label, now,
        );
        nodesWritten++;
        return this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE uri = ?1`, uri).toArray()[0]!.id;
      };
      const linkEdge = (type: string, fromNodeId: string, toNodeId: string): void => {
        this.ctx.storage.sql.exec(
          `INSERT INTO edges (id, type, from_node_id, to_node_id, created_at) VALUES (?1,?2,?3,?4,?5)
           ON CONFLICT (type, from_node_id, to_node_id) DO NOTHING`,
          newId('edge'), type, fromNodeId, toNodeId, now,
        );
        edgesWritten++;
      };

      const episodeNodeId = upsertNode('episode', buildEntityUri({ kind: 'episode', id: episodeId }), `${input.runKind} episode (${input.outcome})`);
      const runNodeId = upsertNode('run', buildEntityUri({ kind: 'run', id: input.runId }), `${input.runKind} run`);
      linkEdge('derived_from', episodeNodeId, runNodeId);

      if (input.taskId) {
        const taskNodeId = upsertNode('task', buildEntityUri({ kind: 'task', id: input.taskId }), input.taskTitle ?? input.taskId);
        linkEdge('related_to', episodeNodeId, taskNodeId);
      }
      if (input.agentId) {
        const agentNodeId = upsertNode('agent', buildEntityUri({ kind: 'agent', id: input.agentId }), input.agentId);
        linkEdge('owned_by', episodeNodeId, agentNodeId);
      }
      if (projectKey && input.repositoryKey) {
        for (const path of bodyObject.filesTouched) {
          const fileNodeId = upsertNode('file', buildEntityUri({ kind: 'file', projectKey, repositoryKey: input.repositoryKey, path }), path);
          linkEdge('modifies', episodeNodeId, fileNodeId);
        }
      }
      if (input.agentId) {
        const recordedMemories = this.ctx.storage.sql
          .exec<{ id: string; kind: string }>(`SELECT id, kind FROM memory_items WHERE recorded_by_agent_id = ?1`, input.agentId)
          .toArray();
        for (const m of recordedMemories) {
          const memoryNodeId = upsertNode('memory', buildEntityUri({ kind: 'memory', id: m.id }), m.kind);
          linkEdge('related_to', episodeNodeId, memoryNodeId);
        }
      }

      // ONE summary outbox event for the whole write — never one per node/edge.
      const operationId = newId('op');
      this.ctx.storage.sql.exec(
        `INSERT INTO outbox (id, operation_id, verb, subject_type, subject_id, payload, created_at) VALUES (?1,?2,'memory.changed','memory',?3,?4,?5)`,
        newId('obx'), operationId, episodeId,
        JSON.stringify({ operationId, entityType: 'episode', runId: input.runId, outcome: input.outcome, nodesWritten, edgesWritten }),
        now,
      );
      this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = value + 1 WHERE id = 0`);
    });
    this.ctx.storage.setAlarm(Date.now()).catch(() => {});

    // PLNR-255: index/re-index this episode the same way `rebuildVectorIndex` does — fire-and-
    // forget, must never fail or slow the write it derives from.
    const backend = searchBackend(this.env);
    if (backend) {
      void indexEntity(backend, { kind: 'episode', id: episodeId, projectId, title: `episode ${input.runId}`, body: summarizeEpisodeBody(finalBody) })
        .catch((err) => console.warn(`ProjectMemory episode-index for ${episodeId} failed: ${String(err)}`));
    }

    return { episodeId, runId: input.runId, created, nodesWritten, edgesWritten };
  }

  // -------------------------------------------------------------------------
  // Project Intelligence derived generations (PLNR-292)
  // -------------------------------------------------------------------------

  async beginAnalyticsGeneration(projectId: string, input: {
    extractionVersion: string;
    d1EventWatermark: number | null;
    orchestrationWatermark: string | null;
    force: boolean;
  }): Promise<{ generationId: string; unchanged: boolean }> {
    await this.assertProjectId(projectId);
    const memoryRevision = this.ctx.storage.sql
      .exec<{ value: number }>(`SELECT value FROM memory_revision WHERE id = 0`).toArray()[0]?.value ?? 0;
    const active = this.ctx.storage.sql.exec<{
      id: string; extraction_version: string; source_memory_revision: number;
      d1_event_watermark: number | null; orchestration_watermark: string | null;
    }>(
      `SELECT g.id, g.extraction_version, g.source_memory_revision,
              g.d1_event_watermark, g.orchestration_watermark
         FROM analytics_active_generation a JOIN analytics_generations g ON g.id = a.generation_id
        WHERE a.id = 0 AND g.status = 'complete'`,
    ).toArray()[0];
    if (!input.force && active
      && active.extraction_version === input.extractionVersion
      && active.source_memory_revision === memoryRevision
      && active.d1_event_watermark === input.d1EventWatermark
      && active.orchestration_watermark === input.orchestrationWatermark) {
      return { generationId: active.id, unchanged: true };
    }
    const building = !input.force ? this.ctx.storage.sql.exec<{ id: string }>(
      `SELECT id FROM analytics_generations
        WHERE status = 'building' AND extraction_version = ?1 AND source_memory_revision = ?2
          AND d1_event_watermark IS ?3 AND orchestration_watermark IS ?4
        ORDER BY created_at DESC LIMIT 1`,
      input.extractionVersion, memoryRevision, input.d1EventWatermark, input.orchestrationWatermark,
    ).toArray()[0] : null;
    if (building) return { generationId: building.id, unchanged: false };

    const generationId = newId('ang');
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
      `INSERT INTO analytics_generations
         (id, status, extraction_version, base_generation_id, source_memory_revision, d1_event_watermark,
          orchestration_watermark, completeness, created_at, build_mode)
       VALUES (?1, 'building', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        generationId, input.extractionVersion, input.force ? null : active?.id ?? null,
        memoryRevision, input.d1EventWatermark, input.orchestrationWatermark,
        JSON.stringify({ status: 'building', reasons: [] }), nowIso(), input.force || !active ? 'full' : 'incremental',
      );
      if (!input.force && active) {
        this.ctx.storage.sql.exec(
          `INSERT INTO analytics_rows
             (generation_id, episode_id, run_id, sitting, normalized, source_fingerprint, row_checksum)
           SELECT ?1, episode_id, run_id, sitting, normalized, source_fingerprint, row_checksum
             FROM analytics_rows WHERE generation_id = ?2`,
          generationId, active.id,
        );
      }
    });
    return { generationId, unchanged: false };
  }

  async ingestAnalyticsSnapshot(
    projectId: string,
    generationId: string,
    rows: AnalyticsSnapshotRow[],
  ): Promise<{ accepted: number }> {
    await this.assertProjectId(projectId);
    if (rows.length > 500) throw new Error('analytics snapshot page exceeds 500 rows');
    const generation = this.ctx.storage.sql.exec<{ status: string }>(
      `SELECT status FROM analytics_generations WHERE id = ?1`, generationId,
    ).toArray()[0];
    if (!generation || generation.status !== 'building') throw new Error(`analytics generation ${generationId} is not building`);
    this.ctx.storage.transactionSync(() => {
      for (const row of rows) {
        const body = JSON.stringify(row.body);
        if (new TextEncoder().encode(body).byteLength > 65_536) throw new Error('analytics snapshot row exceeds 64 KiB');
        const node = row.sourceKind === 'execution_node' ? row.body as AnalyticsExecutionNodeSnapshot : null;
        const event = row.sourceKind === 'execution_event' ? row.body as AnalyticsExecutionEventSnapshot : null;
        this.ctx.storage.sql.exec(
          `INSERT INTO analytics_snapshot_rows
             (generation_id, source_kind, source_key, run_id, sitting, execution_id, body)
           VALUES (?1,?2,?3,?4,?5,?6,?7)
           ON CONFLICT (generation_id, source_kind, source_key) DO UPDATE SET
             run_id = excluded.run_id, sitting = excluded.sitting,
             execution_id = excluded.execution_id, body = excluded.body`,
          generationId, row.sourceKind, row.sourceKey, node?.runId ?? event?.runId ?? null,
          node?.sitting ?? event?.sitting ?? null,
          node?.id ?? event?.executionId ?? null, body,
        );
      }
    });
    return { accepted: rows.length };
  }

  async ingestAnalyticsQualityEvents(
    projectId: string,
    generationId: string,
    rows: AnalyticsQualityEventSnapshot[],
  ): Promise<{ accepted: number }> {
    await this.assertProjectId(projectId);
    if (rows.length > 500) throw new Error('analytics quality-event page exceeds 500 rows');
    const generation = this.ctx.storage.sql.exec<{ status: string }>(
      `SELECT status FROM analytics_generations WHERE id = ?1`, generationId,
    ).toArray()[0];
    if (!generation || generation.status !== 'building') throw new Error(`analytics generation ${generationId} is not building`);
    const prepared = await Promise.all(rows.map(async (candidate) => {
      const linkedEpisode = candidate.runId && candidate.sitting ? this.ctx.storage.sql.exec<{ id: string }>(
        `SELECT id FROM episodes WHERE run_id = ?1 AND sitting = ?2`, candidate.runId, candidate.sitting,
      ).toArray()[0] : null;
      const row = ProjectQualityEvent.parse({ ...candidate, episodeId: linkedEpisode?.id ?? null });
      if (row.projectId !== projectId) throw new Error('analytics quality event belongs to another project');
      const body = JSON.stringify(row);
      const bytes = new TextEncoder().encode(body);
      if (bytes.byteLength > 65_536) throw new Error('analytics quality event exceeds 64 KiB');
      return { row, body, checksum: await sha256HexBytes(bytes) };
    }));
    this.ctx.storage.transactionSync(() => {
      for (const { row, body, checksum } of prepared) {
        this.ctx.storage.sql.exec(
          `INSERT INTO analytics_quality_event_rows
             (generation_id, event_id, run_id, sitting, body, row_checksum)
           VALUES (?1,?2,?3,?4,?5,?6)
           ON CONFLICT (generation_id, event_id) DO UPDATE SET
             run_id = excluded.run_id, sitting = excluded.sitting,
             body = excluded.body, row_checksum = excluded.row_checksum`,
          generationId, row.id, row.runId, row.sitting, body, checksum,
        );
      }
    });
    return { accepted: rows.length };
  }

  async completeAnalyticsGeneration(projectId: string, generationId: string): Promise<{
    generationId: string; rowCount: number; checksum: string; activated: boolean;
  }> {
    await this.assertProjectId(projectId);
    const generation = this.ctx.storage.sql.exec<{
      status: string; extraction_version: string; source_memory_revision: number;
      d1_event_watermark: number | null; orchestration_watermark: string | null; base_generation_id: string | null;
      checksum: string | null; row_count: number;
    }>(
      `SELECT status, extraction_version, source_memory_revision, d1_event_watermark, orchestration_watermark, base_generation_id,
              checksum, row_count FROM analytics_generations WHERE id = ?1`, generationId,
    ).toArray()[0];
    if (!generation) throw new Error(`analytics generation ${generationId} not found`);
    if (generation.status === 'complete') {
      return {
        generationId, rowCount: generation.row_count, checksum: generation.checksum!,
        activated: this.ctx.storage.sql.exec<{ generation_id: string | null }>(
          `SELECT generation_id FROM analytics_active_generation WHERE id = 0`,
        ).toArray()[0]?.generation_id === generationId,
      };
    }
    if (generation.status !== 'building') throw new Error(`analytics generation ${generationId} is ${generation.status}`);
    const currentMemoryRevision = this.ctx.storage.sql
      .exec<{ value: number }>(`SELECT value FROM memory_revision WHERE id = 0`).toArray()[0]?.value ?? 0;
    if (currentMemoryRevision !== generation.source_memory_revision) {
      throw new Error(
        `analytics memory snapshot changed during build: expected revision ${generation.source_memory_revision}, current ${currentMemoryRevision}`,
      );
    }

    // A retry restarts only this disposable generation. The previous complete generation and
    // every canonical table remain untouched throughout the build.
    if (!generation.base_generation_id) {
      this.ctx.storage.sql.exec(`DELETE FROM analytics_rows WHERE generation_id = ?1`, generationId);
    } else {
      this.ctx.storage.sql.exec(
        `DELETE FROM analytics_rows WHERE generation_id = ?1
          AND episode_id NOT IN (SELECT id FROM episodes)`, generationId,
      );
    }
    let offset = 0;
    let rowCount = 0;
    let rollingChecksum = await sha256HexBytes(new TextEncoder().encode(JSON.stringify({
      extractionVersion: generation.extraction_version,
      memoryRevision: generation.source_memory_revision,
      d1EventWatermark: generation.d1_event_watermark,
      orchestrationWatermark: generation.orchestration_watermark,
    })));
    const completenessReasons = new Set<string>();
    for (;;) {
      const episodes = this.ctx.storage.sql.exec<{
        id: string; run_id: string; sitting: number; run_kind: string | null;
        outcome: string | null; body: string;
      }>(
        `SELECT id, run_id, sitting, run_kind, outcome, body FROM episodes
          ORDER BY run_id, sitting LIMIT 100 OFFSET ?1`, offset,
      ).toArray();
      if (!episodes.length) break;
      for (const row of episodes) {
        const episode = EffortEpisode.parse(JSON.parse(row.body));
        const nodeEntries = this.ctx.storage.sql.exec<{ body: string }>(
          `SELECT body FROM analytics_snapshot_rows
            WHERE generation_id = ?1 AND source_kind = 'execution_node'
              AND run_id = ?2 AND sitting = ?3 ORDER BY source_key`,
          generationId, row.run_id, row.sitting,
        ).toArray();
        const nodes = nodeEntries.map((entry) => JSON.parse(entry.body) as AnalyticsExecutionNodeSnapshot);
        const eventEntries = nodes.length ? this.ctx.storage.sql.exec<{ body: string }>(
          `SELECT body FROM analytics_snapshot_rows
            WHERE generation_id = ?1 AND source_kind = 'execution_event'
              AND run_id = ?2 AND sitting = ?3
            ORDER BY source_key`,
          generationId, row.run_id, row.sitting,
        ).toArray() : [];
        const events = eventEntries.map((entry) => JSON.parse(entry.body) as AnalyticsExecutionEventSnapshot);
        const sourceFingerprint = await sha256HexBytes(new TextEncoder().encode(JSON.stringify({
          episode: row.body,
          nodes: nodeEntries.map((entry) => entry.body),
          events: eventEntries.map((entry) => entry.body),
          extractionVersion: generation.extraction_version,
        })));
        const copied = generation.base_generation_id ? this.ctx.storage.sql.exec<{
          normalized: string; source_fingerprint: string;
        }>(
          `SELECT normalized, source_fingerprint FROM analytics_rows
            WHERE generation_id = ?1 AND episode_id = ?2`, generationId, row.id,
        ).toArray()[0] : null;
        const copiedNormalized = copied?.source_fingerprint === sourceFingerprint
          ? ProjectIntelligenceEpisode.parse(JSON.parse(copied.normalized))
          : null;
        const normalized = copiedNormalized
          ? ProjectIntelligenceEpisode.parse({
              ...copiedNormalized,
              sources: {
                ...copiedNormalized.sources,
                memoryRevision: generation.source_memory_revision,
                coordinationEventSequence: generation.d1_event_watermark,
              },
              versions: { ...copiedNormalized.versions, extraction: generation.extraction_version },
            })
          : normalizeAnalyticsEpisode({
              episode, sitting: row.sitting, runKind: row.run_kind ?? 'build',
              outcome: row.outcome === 'failed' || row.outcome === 'cancelled' ? row.outcome : 'done',
              sourceMemoryRevision: generation.source_memory_revision,
              d1EventWatermark: generation.d1_event_watermark,
              extractionVersion: generation.extraction_version,
              nodes, events,
            });
        if (normalized.identity.lineage.status !== 'complete') completenessReasons.add('partial_lineage');
        const encoded = JSON.stringify(normalized);
        const rowChecksum = await sha256HexBytes(new TextEncoder().encode(encoded));
        rollingChecksum = await sha256HexBytes(new TextEncoder().encode(`${rollingChecksum}:${rowChecksum}`));
        this.ctx.storage.sql.exec(
          `INSERT INTO analytics_rows
             (generation_id, episode_id, run_id, sitting, normalized, source_fingerprint, row_checksum)
           VALUES (?1,?2,?3,?4,?5,?6,?7)
           ON CONFLICT (generation_id, episode_id) DO UPDATE SET
             run_id = excluded.run_id, sitting = excluded.sitting, normalized = excluded.normalized,
             source_fingerprint = excluded.source_fingerprint, row_checksum = excluded.row_checksum`,
          generationId, row.id, row.run_id, row.sitting, encoded, sourceFingerprint, rowChecksum,
        );
        rowCount++;
      }
      offset += episodes.length;
    }
    const canonicalCount = this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM episodes`).toArray()[0]?.n ?? 0;
    const derivedCount = this.ctx.storage.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM analytics_rows WHERE generation_id = ?1`, generationId,
    ).toArray()[0]?.n ?? 0;
    if (canonicalCount !== rowCount || derivedCount !== rowCount) {
      throw new Error(`analytics validation count mismatch: canonical=${canonicalCount}, normalized=${rowCount}, stored=${derivedCount}`);
    }
    const qualityRows = this.ctx.storage.sql.exec<{ row_checksum: string }>(
      `SELECT row_checksum FROM analytics_quality_event_rows
        WHERE generation_id = ?1 ORDER BY event_id`, generationId,
    ).toArray();
    for (const row of qualityRows) {
      rollingChecksum = await sha256HexBytes(new TextEncoder().encode(`${rollingChecksum}:quality:${row.row_checksum}`));
    }
    const completedAt = nowIso();
    const completeness = JSON.stringify({
      status: completenessReasons.size ? 'partial' : 'complete', reasons: [...completenessReasons].sort(),
    });
    this.ctx.storage.transactionSync(() => {
      const activationRevision = this.readMemoryRevision();
      if (activationRevision !== generation.source_memory_revision) {
        throw new Error(
          `analytics memory snapshot changed before activation: expected revision ${generation.source_memory_revision}, current ${activationRevision}`,
        );
      }
      this.ctx.storage.sql.exec(
        `UPDATE analytics_generations SET status = 'complete', completeness = ?2,
                row_count = ?3, checksum = ?4, completed_at = ?5, error = NULL
          WHERE id = ?1 AND status = 'building'`,
        generationId, completeness, rowCount, rollingChecksum, completedAt,
      );
      this.ctx.storage.sql.exec(
        `UPDATE analytics_active_generation SET generation_id = ?1 WHERE id = 0`, generationId,
      );
      this.ctx.storage.sql.exec(`DELETE FROM analytics_snapshot_rows WHERE generation_id = ?1`, generationId);
    });
    return { generationId, rowCount, checksum: rollingChecksum, activated: true };
  }

  async failAnalyticsGeneration(projectId: string, generationId: string, error: string): Promise<void> {
    await this.assertProjectId(projectId);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `UPDATE analytics_generations SET status = 'failed', error = ?2, completed_at = ?3
          WHERE id = ?1 AND status = 'building'`,
        generationId, error.slice(0, 4_000), nowIso(),
      );
      this.ctx.storage.sql.exec(`DELETE FROM analytics_snapshot_rows WHERE generation_id = ?1`, generationId);
    });
  }

  /** Stored half of analytics health. Current D1/orchestration watermarks and retry metadata are
   * deliberately joined outside the DO by memory/analytics.ts, preserving source authority. */
  async analyticsGenerationHealth(projectId: string): Promise<{
    memoryRevision: number;
    active: AnalyticsHealthGenerationRow | null;
    building: AnalyticsHealthGenerationRow | null;
    latestFailure: AnalyticsHealthGenerationRow | null;
    lastSuccessfulIncrementalAt: string | null;
    lastSuccessfulFullRebuildAt: string | null;
    counts: { episodes: number; generations: number; rows: number; snapshotRows: number; qualityRows: number };
  }> {
    await this.assertProjectId(projectId);
    const select = `SELECT id, status, extraction_version AS extractionVersion,
      build_mode AS buildMode, source_memory_revision AS sourceMemoryRevision,
      d1_event_watermark AS d1EventWatermark, orchestration_watermark AS orchestrationWatermark,
      created_at AS createdAt, completed_at AS completedAt, error FROM analytics_generations`;
    const activeId = this.ctx.storage.sql.exec<{ generation_id: string | null }>(
      `SELECT generation_id FROM analytics_active_generation WHERE id = 0`,
    ).toArray()[0]?.generation_id ?? null;
    const one = (where: string, ...args: Array<string | number | null>) =>
      this.ctx.storage.sql.exec<AnalyticsHealthGenerationRow>(`${select} ${where}`, ...args).toArray()[0] ?? null;
    const count = (table: string) => this.ctx.storage.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table}`,
    ).toArray()[0]?.n ?? 0;
    return {
      memoryRevision: this.readMemoryRevision(),
      active: activeId ? one('WHERE id = ?1', activeId) : null,
      building: one("WHERE status = 'building' ORDER BY created_at DESC, id DESC LIMIT 1"),
      latestFailure: one("WHERE status = 'failed' ORDER BY completed_at DESC, id DESC LIMIT 1"),
      lastSuccessfulIncrementalAt: one("WHERE status = 'complete' AND build_mode = 'incremental' ORDER BY completed_at DESC LIMIT 1")?.completedAt ?? null,
      lastSuccessfulFullRebuildAt: one("WHERE status = 'complete' AND build_mode = 'full' ORDER BY completed_at DESC LIMIT 1")?.completedAt ?? null,
      counts: {
        episodes: count('episodes'), generations: count('analytics_generations'),
        rows: count('analytics_rows'), snapshotRows: count('analytics_snapshot_rows'),
        qualityRows: count('analytics_quality_event_rows'),
      },
    };
  }

  /** Read only from the atomically activated generation. The hard row budget bounds CPU and
   * response latency; a larger generation is reported as partial coverage rather than silently
   * masquerading as a complete population. */
  async queryHistoricalAnalytics(
    projectId: string,
    query: HistoricalAnalyticsQuery,
  ): Promise<HistoricalAnalyticsResult> {
    await this.assertProjectId(projectId);
    validateHistoricalAnalyticsQuery(query);
    const generation = this.ctx.storage.sql.exec<{
      id: string; extraction_version: string; completed_at: string;
      source_memory_revision: number; d1_event_watermark: number | null;
      orchestration_watermark: string | null; completeness: string;
    }>(
      `SELECT g.id, g.extraction_version, g.completed_at, g.source_memory_revision,
              g.d1_event_watermark, g.orchestration_watermark, g.completeness
         FROM analytics_active_generation a JOIN analytics_generations g ON g.id = a.generation_id
        WHERE a.id = 0 AND g.status = 'complete'`,
    ).toArray()[0];
    if (!generation) throw new Error('no complete analytics generation is available');
    const stored = this.ctx.storage.sql.exec<{ normalized: string }>(
      `SELECT normalized FROM analytics_rows WHERE generation_id = ?1
        ORDER BY run_id, sitting LIMIT ?2`,
      generation.id, HISTORICAL_ANALYTICS_MAX_ROWS + 1,
    ).toArray();
    let completeness: unknown = { status: 'unknown', reasons: ['malformed_generation_completeness'] };
    try { completeness = JSON.parse(generation.completeness); } catch { /* explicit unknown above */ }
    const rows = stored.slice(0, HISTORICAL_ANALYTICS_MAX_ROWS);
    const storedQuality = this.ctx.storage.sql.exec<{ body: string }>(
      `SELECT body FROM analytics_quality_event_rows WHERE generation_id = ?1
        ORDER BY event_id LIMIT ?2`, generation.id, HISTORICAL_ANALYTICS_MAX_ROWS + 1,
    ).toArray();
    const qualityRows = storedQuality.slice(0, HISTORICAL_ANALYTICS_MAX_ROWS);
    return aggregateHistoricalAnalytics({
      episodes: rows.map((row) => ProjectIntelligenceEpisode.parse(JSON.parse(row.normalized))),
      qualityEvents: qualityRows.map((row) => ProjectQualityEvent.parse(JSON.parse(row.body))),
      scannedRows: rows.length,
      truncated: stored.length > HISTORICAL_ANALYTICS_MAX_ROWS,
      qualityEventsTruncated: storedQuality.length > HISTORICAL_ANALYTICS_MAX_ROWS,
      query,
      generation: {
        id: generation.id,
        extractionVersion: generation.extraction_version,
        completedAt: generation.completed_at,
        memoryRevision: generation.source_memory_revision,
        coordinationEventSequence: generation.d1_event_watermark,
        orchestrationWatermark: generation.orchestration_watermark,
        completeness,
      },
    });
  }

  /** Keep only the active complete generation, one prior complete cutover target, the newest
   * failure diagnostic, and non-abandoned builds. Snapshot inbox rows exist only for live builds.
   * This is bounded and idempotent; canonical episodes are never touched. */
  async pruneAnalyticsGenerations(projectId: string, maxBuildingAgeMs: number): Promise<{
    pruned: number; abandoned: number;
  }> {
    await this.assertProjectId(projectId);
    const cutoff = new Date(Date.now() - maxBuildingAgeMs).toISOString();
    const activeId = this.ctx.storage.sql.exec<{ generation_id: string | null }>(
      `SELECT generation_id FROM analytics_active_generation WHERE id = 0`,
    ).toArray()[0]?.generation_id ?? null;
    const priorId = this.ctx.storage.sql.exec<{ id: string }>(
      `SELECT id FROM analytics_generations WHERE status = 'complete' AND id IS NOT ?1
        ORDER BY completed_at DESC, id DESC LIMIT 1`, activeId,
    ).toArray()[0]?.id ?? null;
    const failureId = this.ctx.storage.sql.exec<{ id: string }>(
      `SELECT id FROM analytics_generations WHERE status = 'failed'
        ORDER BY completed_at DESC, id DESC LIMIT 1`,
    ).toArray()[0]?.id ?? null;
    const abandoned = this.ctx.storage.sql.exec<{ id: string }>(
      `SELECT id FROM analytics_generations WHERE status = 'building' AND created_at < ?1
        ORDER BY created_at DESC, id DESC`, cutoff,
    ).toArray();
    const keep = new Set([activeId, priorId, failureId].filter((id): id is string => !!id));
    if (abandoned[0]) keep.add(abandoned[0].id);
    const all = this.ctx.storage.sql.exec<{ id: string; status: string; created_at: string }>(
      `SELECT id, status, created_at FROM analytics_generations`,
    ).toArray();
    const remove = all.filter((row) => !keep.has(row.id)
      && (row.status !== 'building' || row.created_at < cutoff));
    this.ctx.storage.transactionSync(() => {
      for (const row of abandoned) {
        this.ctx.storage.sql.exec(
          `UPDATE analytics_generations SET status = 'failed', completed_at = ?2,
                  error = 'abandoned analytics build expired during lifecycle sweep'
            WHERE id = ?1 AND status = 'building'`, row.id, nowIso(),
        );
        this.ctx.storage.sql.exec(`DELETE FROM analytics_snapshot_rows WHERE generation_id = ?1`, row.id);
      }
      for (const row of remove) {
        this.ctx.storage.sql.exec(`DELETE FROM analytics_snapshot_rows WHERE generation_id = ?1`, row.id);
        this.ctx.storage.sql.exec(`DELETE FROM analytics_rows WHERE generation_id = ?1`, row.id);
        this.ctx.storage.sql.exec(`DELETE FROM analytics_generations WHERE id = ?1`, row.id);
      }
    });
    return { pruned: remove.length, abandoned: abandoned.length };
  }

  async beginEpisodeIngest(projectId: string, manifest: EpisodeUploadManifest): Promise<{ ok: true }> {
    await this.assertProjectId(projectId);
    this.ingestEpisodes.set(manifest.scopeId, beginIngestEpisode(this.ingestEpisodes.get(manifest.scopeId), manifest));
    return { ok: true };
  }

  async ingestEpisodeBatch(
    projectId: string,
    scopeId: string,
    batchNumber: number,
    rows: Array<Record<string, unknown>>,
  ): Promise<{ ok: true; deduped: boolean }> {
    await this.assertProjectId(projectId);
    const state = this.ingestEpisodes.get(scopeId);
    if (!state) throw new Error(`no episode ingest in progress for ${scopeId} — call beginEpisodeIngest first`);
    const { deduped } = applyIngestEpisodeBatch(state, batchNumber, rows);
    return { ok: true, deduped };
  }

  /**
   * Seals the upload, parses each row as partial daemon enrichment, and overlays it on the exact
   * same D1-built skeleton used by the terminal job. No lifecycle, identity, task, repository,
   * cost, review, or landing field is trusted from the payload. Unknown and non-terminal runs
   * remain per-row skips rather than failing the batch.
   */
  async completeEpisodeIngest(
    projectId: string,
    scopeId: string,
  ): Promise<{ ok: true; batchesReceived: number; rowCount: number; recorded: number; skipped: number }> {
    await this.assertProjectId(projectId);
    const state = this.ingestEpisodes.get(scopeId);
    if (!state) throw new Error(`no episode ingest in progress for ${scopeId}`);
    completeIngestEpisode(state);

    let recorded = 0;
    let skipped = 0;
    for (const row of state.rows) {
      const parsed = UPLOADED_EPISODE_SHAPE.safeParse(row);
      if (!parsed.success) {
        console.warn(`ProjectMemory episode-ingest(${scopeId}): skipping malformed uploaded row: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
        skipped++;
        continue;
      }
      let skeleton: Awaited<ReturnType<typeof loadEpisodeSkeleton>>;
      try {
        skeleton = await loadEpisodeSkeleton(this.env, projectId, parsed.data.runId);
      } catch (error) {
        if (!(error instanceof EpisodeSkeletonUnavailableError)) throw error;
        console.warn(`ProjectMemory episode-ingest(${scopeId}): ${error.message} — skipping`);
        skipped++;
        continue;
      }
      // Zod retains the shared EffortEpisode defaults inside `.partial()`. Presence must
      // therefore come from the raw row, otherwise an omitted array parses as [] and becomes an
      // accidental clear — the exact PLNR-340 data-loss bug this boundary fixes.
      const supplied = <K extends 'filesTouched' | 'commands' | 'testsRun' | 'failures' | 'findings' | 'selfSummary'>(key: K) =>
        Object.prototype.hasOwnProperty.call(row, key) ? parsed.data[key] : undefined;
      await this.recordEpisode(projectId, {
        ...skeleton,
        filesTouched: supplied('filesTouched'),
        commands: supplied('commands'),
        testsRun: supplied('testsRun'),
        failures: supplied('failures'),
        findings: supplied('findings'),
        selfSummary: supplied('selfSummary'),
        actor: { kind: 'agent', id: skeleton.agentId },
        writeMode: 'enrichment',
      });
      recorded++;
    }
    if (recorded) {
      await requestProjectAnalyticsRebuild(this.env, projectId).catch((error) =>
        console.warn(`analytics enqueue after episode enrichment failed: ${String(error)}`));
    }
    return { ok: true, batchesReceived: state.receivedBatches.size, rowCount: state.rows.length, recorded, skipped };
  }

  async abortEpisodeIngest(projectId: string, scopeId: string): Promise<{ ok: true }> {
    await this.assertProjectId(projectId);
    const state = this.ingestEpisodes.get(scopeId);
    if (state) abortIngestEpisode(state);
    return { ok: true };
  }

  async episodeIngestStatus(
    projectId: string,
    scopeId: string,
  ): Promise<{ status: 'unknown' | 'pending' | 'complete' | 'aborted'; batchesReceived: number; batchesExpected: number | null }> {
    await this.assertProjectId(projectId);
    const state = this.ingestEpisodes.get(scopeId);
    if (!state) return { status: 'unknown', batchesReceived: 0, batchesExpected: null };
    return { status: state.status, batchesReceived: state.receivedBatches.size, batchesExpected: state.manifest.batchCount };
  }

  /**
   * Best-effort wipe of every row (PLNR-246), called fire-and-forget from
   * ProjectRoom.deleteProject once the D1 registry rows are already gone. Full
   * retention/quota/disaster-recovery policy is PLNR-250's — this is the
   * scheduling hook it hangs off of, not that policy itself. Deletes
   * children before parents (the reverse of SCHEMA_TABLES' creation order)
   * so it stays FK-safe even on a connection where `PRAGMA foreign_keys = ON`
   * is in effect. Schema and migration state are left intact — this empties
   * the store, it does not destroy it.
   */
  async erase(projectId: string): Promise<{ ok: true }> {
    await this.assertProjectId(projectId);
    this.ctx.storage.transactionSync(() => {
      this.clearAnalyticsDerived();
      for (const table of [...SCHEMA_TABLES].reverse()) {
        this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
      }
      this.ctx.storage.sql.exec(`DELETE FROM applied_operations`);
      this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = 0 WHERE id = 0`);
      this.ctx.storage.sql.exec(`UPDATE projector_cursor SET global_seq = 0 WHERE id = 0`);
      // PLNR-266: guidance_drift_findings is deliberately OUTSIDE SCHEMA_TABLES (it is
      // re-derivable from a fresh scan and never authoritative project knowledge, so it is
      // excluded from backup/restore) — but erase()'s "every row" promise (PLNR-250's eraseAll
      // sells this as complete) still applies to it, so it is cleared here explicitly, the same
      // way applied_operations/memory_revision/projector_cursor are handled just above.
      this.ctx.storage.sql.exec(`DELETE FROM guidance_drift_findings`);
    });
    return { ok: true };
  }

  /**
   * The full auditable erasure sequence (PLNR-250) — what a durable tombstone (migration 0072)
   * is retried against until every step reports complete. Order: (1) operational-memory and
   * code-intelligence vectors; (2) this DO's rows, including any retained `prev_`, import
   * `staging_`, or export-copy tables; (3) this project's R2 memory-backups prefix; (4) ingest
   * capability state. Vector deletion must succeed before canonical rows are erased, because
   * those rows are the retry ledger for the otherwise filter-less Vectorize delete API. Each
   * step is idempotent: a tombstone can safely drive the whole sequence again after any failure.
   */
  /** Test-only fault injection: force the next eraseAll's "store" step to fail — mirrors
   *  _setForceDeliveryFailure (PLNR-247), same reason: proves the tombstone survives a failed
   *  attempt and a later sweep completes it, without fighting the runtime for a real failure. */
  private _forceEraseFailure = false;
  async _setForceEraseFailure(projectId: string, fail: boolean): Promise<void> {
    await this.assertProjectId(projectId);
    this._forceEraseFailure = fail;
  }

  async eraseAll(projectId: string): Promise<EraseReport> {
    await this.assertProjectId(projectId);
    const steps: EraseStepResult[] = [];

    // Capture every stable id before touching the canonical store. Vectorize has no
    // delete-by-project operation; successful deletion of these ids is therefore a prerequisite
    // for clearing the rows that let a later tombstone retry reconstruct the same target set.
    const memoryVectorRefs = this.ctx.storage.sql
      .exec<{ id: string; kind: 'memory' | 'episode' }>(
        `SELECT id, 'memory' AS kind FROM memory_items
         UNION ALL SELECT id, 'episode' AS kind FROM episodes`,
      )
      .toArray();
    const codeVectorUris = this.ctx.storage.sql
      .exec<{ uri: string }>(
        `SELECT uri FROM index_staged_entities
         UNION
         SELECT uri FROM nodes WHERE type IN ('file','symbol','api','test','database_entity','procedure','artifact')`,
      )
      .toArray()
      .map((r) => r.uri);

    let vectorsCleared = true;
    try {
      const operational = searchBackend(this.env);
      if (operational) {
        for (const ref of memoryVectorRefs) await removeEntity(operational, ref.kind, ref.id);
      }
      const code = codeSearchBackend(this.env);
      if (code) {
        for (const uri of codeVectorUris) await removeCodeEntity(code, uri);
      }
      const removed = memoryVectorRefs.length + codeVectorUris.length;
      const configured = !!operational || !!code;
      steps.push({
        step: 'vectors',
        ok: true,
        detail: configured ? `${removed} canonical vector target(s) deleted` : 'vector indexes not configured — nothing to delete',
      });
    } catch (err) {
      vectorsCleared = false;
      steps.push({ step: 'vectors', ok: false, detail: String(err) });
    }

    if (!vectorsCleared) {
      steps.push({ step: 'store', ok: false, detail: 'deferred until vector deletion succeeds so its retry targets remain available' });
    } else {
      try {
        if (this._forceEraseFailure) throw new Error('injected erase failure (test)');
        await this.erase(projectId);
        this.ctx.storage.transactionSync(() => {
          for (const table of BACKUP_TABLES) {
            this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS prev_${table}`);
            this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS staging_${table}`);
          }
          const exportTables = this.ctx.storage.sql
            .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'export!_%' ESCAPE '!'`)
            .toArray();
          for (const { name } of exportTables) this.ctx.storage.sql.exec(`DROP TABLE ${name}`);
          this.ctx.storage.sql.exec(`UPDATE _meta SET value = '0' WHERE key = 'has_prior_generation'`);
        });
        this.ingestEpisodes.clear();
        steps.push({ step: 'store', ok: true, detail: 'rows and any generation debris cleared' });
      } catch (err) {
        steps.push({ step: 'store', ok: false, detail: String(err) });
      }
    }

    try {
      const deleted = await deleteAllProjectBackups(this.env, projectId);
      steps.push({ step: 'r2-backups', ok: true, detail: this.env.FILES ? `${deleted} object(s) deleted` : 'R2 not configured — nothing to delete' });
    } catch (err) {
      steps.push({ step: 'r2-backups', ok: false, detail: String(err) });
    }

    // Capability signatures themselves are stateless, but every consume route revalidates the
    // live D1 project/repository scope. Project deletion removed that scope before eraseAll was
    // called, so a pre-deletion token can no longer recreate rows in this DO.
    steps.push({
      step: 'ingest-capabilities',
      ok: true,
      detail: 'stateless tokens are inert because every use revalidates the deleted D1 project/repository scope',
    });

    return { ok: steps.every((s) => s.ok), steps };
  }

  // ---------------------------------------------------------------------------
  // Outbox delivery + D1 event projector (PLNR-247)
  // ---------------------------------------------------------------------------

  /**
   * Test-only fault injection: force the next `drainOutbox` delivery attempt
   * to fail before it ever reaches ProjectRoom. Lets a test prove the outbox
   * row survives a failed delivery and a later `reconcile` closes the gap,
   * without fighting the runtime for a real transport failure.
   */
  private _forceDeliveryFailure = false;
  async _setForceDeliveryFailure(projectId: string, fail: boolean): Promise<void> {
    await this.assertProjectId(projectId);
    this._forceDeliveryFailure = fail;
  }

  // ---------------------------------------------------------------------------
  // Real memory/evidence/graph write APIs (PLNR-251) — replaces the old `_mutate` stand-in.
  //
  // Every write here shares one shape: resolve an operation id, check `applied_operations` for
  // a prior application of it (idempotent replay), and — for a genuinely new operation — run ONE
  // `transactionSync` that performs the mutation, writes the outbox row, bumps `memory_revision`,
  // and records the operation as applied together with the id it produced. All four commit or
  // none do (§4) — that is what makes a retried write with the same operation id safe rather
  // than merely detected-after-the-fact.
  //
  // The outbox always emits verb 'memory.changed' / subjectType 'memory' — the ONE compact verb
  // ProjectRoom's closed `EventVerb`/subjectType enums carry for every memory-subsystem change
  // (see events.ts). Which kind of record changed rides the payload's `entityType`, never the
  // verb or subjectType themselves.
  // ---------------------------------------------------------------------------

  private lookupAppliedOperation(operationId: string): { subject_type: string; subject_id: string; result: string } | null {
    const row = this.ctx.storage.sql
      .exec<{ subject_type: string; subject_id: string; result: string }>(
        `SELECT subject_type, subject_id, result FROM applied_operations WHERE operation_id = ?1`,
        operationId,
      )
      .toArray()[0];
    return row ?? null;
  }

  /** Test-only fault injection: force the next write RPC's transaction to throw mid-commit,
   *  proving the mutation, its outbox row, and its revision bump are one atomic unit rather
   *  than three separate writes that could partially land. Mirrors `_setForceDeliveryFailure`
   *  / `_setForceEraseFailure` (same reason: a real SQLite failure isn't reproducible on demand). */
  private _forceWriteFailure = false;
  async _setForceWriteFailure(projectId: string, fail: boolean): Promise<void> {
    await this.assertProjectId(projectId);
    this._forceWriteFailure = fail;
  }

  /** Test-only clock override: pin `recordMemory`'s `recorded_at` to an exact instant instead of
   *  `nowIso()`. PLNR-323's flake (two versions racing to the SAME millisecond) needs genuine CPU
   *  contention to reproduce on demand — this makes the tie deterministic so a regression test can
   *  force it every run rather than occasionally, the same "not reproducible on demand" reasoning
   *  as `_setForceWriteFailure` above. `null` restores the real clock. */
  private _forceRecordedAt: string | null = null;
  async _setForceRecordedAt(projectId: string, iso: string | null): Promise<void> {
    await this.assertProjectId(projectId);
    this._forceRecordedAt = iso;
  }

  /**
   * PLNR-283: idempotent-by-uri node upsert, INSIDE the caller's transaction — the same idiom
   * `recordEpisode`'s local `upsertNode` closure establishes (kept a class METHOD here, not a
   * third local closure, because `recordMemory`, `applyCoordinationEvent`, and
   * `rebuildProjection` all need it and none of them track a running node/edge count the way
   * `recordEpisode`'s own RPC result does). Never bumps `memory_revision` or writes an outbox
   * row itself — every caller owns that once per logical mutation.
   */
  private upsertGraphNode(type: string, uri: string, label: string, now: string): string {
    this.ctx.storage.sql.exec(
      `INSERT INTO nodes (id, type, uri, label, created_at) VALUES (?1,?2,?3,?4,?5)
       ON CONFLICT (uri) DO UPDATE SET label = excluded.label`,
      newId('node'),
      type,
      uri,
      label,
      now,
    );
    return this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE uri = ?1`, uri).toArray()[0]!.id;
  }

  /**
   * PLNR-283: idempotent-by-triple edge upsert — 0002's `idx_edges_unique` already enforces
   * `(type, from_node_id, to_node_id)` uniqueness (this task's own migration, 0010, only adds
   * `provenance`; see that file's header comment). `provenance` is written on the FIRST insert
   * of a triple only — `ON CONFLICT ... DO NOTHING` never touches an existing row's provenance,
   * so a later idempotent replay can never overwrite it and make the audit trail lie about which
   * write actually caused the edge.
   */
  private linkGraphEdge(type: string, fromNodeId: string, toNodeId: string, now: string, provenance: string | null = null): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO edges (id, type, from_node_id, to_node_id, created_at, provenance) VALUES (?1,?2,?3,?4,?5,?6)
       ON CONFLICT (type, from_node_id, to_node_id) DO NOTHING`,
      newId('edge'),
      type,
      fromNodeId,
      toNodeId,
      now,
      provenance,
    );
  }

  /** PLNR-316: a node's id by its uri, or `null` when no such node has been written yet —
   *  `unlinkGraphEdge`'s own lookup (an edge-removal endpoint is looked up, never stubbed; see
   *  `ProjectedEdgeDescriptor`'s doc comment for why). */
  private findGraphNodeId(uri: string): string | null {
    return this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE uri = ?1`, uri).toArray()[0]?.id ?? null;
  }

  /** PLNR-316: the inverse of `linkGraphEdge` — deletes the `(type, from, to)` triple if present,
   *  a no-op otherwise. Idempotent by construction (same idiom as `upsertGraphNode`/
   *  `linkGraphEdge`'s own `ON CONFLICT`s): replaying the same removal event twice deletes the
   *  edge once, then finds nothing the second time. */
  private unlinkGraphEdge(type: string, fromNodeId: string, toNodeId: string): void {
    this.ctx.storage.sql.exec(`DELETE FROM edges WHERE type = ?1 AND from_node_id = ?2 AND to_node_id = ?3`, type, fromNodeId, toNodeId);
  }

  /**
   * PLNR-317: remove a node and every edge incident on it — the projection of a `*.deleted`/
   * `.rejected` coordination event (`mapCoordinationEvent`'s `removeNodeUri`), for an entity whose
   * D1 row is genuinely gone. Idempotent by construction, same idiom as every other write in this
   * file: a uri with no node (already removed by an earlier apply of the same event, or a stub
   * that was simply never written) is a no-op, not an error. Edges go FIRST, deliberately — 0001's
   * `edges` table declares `from_node_id`/`to_node_id` as `NOT NULL REFERENCES nodes(id)`, and
   * Durable Object SQLite enforces foreign keys unconditionally (CLAUDE.md), so deleting the node
   * row first would raise `SQLITE_CONSTRAINT` on any surviving edge. `idx_edges_from`/
   * `idx_edges_to` (0001) already index both columns — no new index needed for either `DELETE`
   * below to be a lookup, not a scan.
   *
   * `memory` nodes are never reachable here — no delete verb `mapCoordinationEvent` handles ever
   * sets `removeNodeUri` for a memory's own uri (§12: superseded/invalidated, never destructively
   * erased) — so this method trusts its caller rather than special-casing `type = 'memory'` for a
   * path nothing can reach.
   *
   * `evidence` rows are untouched, structurally: 0001's `evidence` table has no column referencing
   * `nodes` at all (`memory_item_id` -> `memory_items` only) — a repository citation's evidence row
   * survives this by construction, same as an entity citation (task/plan/doc/…) never had one to
   * begin with (`recordMemory` writes those as a bare `observed_in` EDGE, which — being incident on
   * the removed node — IS one of the edges the `DELETE FROM edges` below correctly drops).
   */
  private removeGraphNode(uri: string): void {
    const node = this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE uri = ?1`, uri).toArray()[0];
    if (!node) return;
    this.ctx.storage.sql.exec(`DELETE FROM edges WHERE from_node_id = ?1 OR to_node_id = ?1`, node.id);
    this.ctx.storage.sql.exec(`DELETE FROM nodes WHERE id = ?1`, node.id);
  }

  /** PLNR-314: a canvas label is unreadable past ~80 chars, so this is the bound every memory
   *  node's label is held to — both here (a freshly written or re-touched node) and in
   *  memory-migration 0011's one-time backfill of nodes written before this fix, which mirrors
   *  this normalization in SQL as closely as SQLite's string functions allow. */
  private static readonly MEMORY_NODE_LABEL_MAX_CHARS = 80;

  /**
   * PLNR-314: a memory graph node's label is a bounded, single-line EXCERPT OF THE STATEMENT —
   * never `kind`. Before this fix `upsertGraphNode('memory', …, input.kind, …)` named the node
   * after its kind, so every `hazard`/`decision`/`unknown` memory rendered as an identically
   * titled star; `kind` already travels as its own field on the constellation wire
   * (graph-queries.ts resolves it from `memory_items`), so the label was the only place a memory
   * node's actual content could appear at all, and this fixes that. Collapses whitespace/newlines
   * to single spaces first — a multi-line statement makes an unreadable canvas label — then
   * truncates with a trailing ellipsis past the bound. Display only (locked decision): never
   * widen this excerpt, or reuse it, anywhere that renders in instruction position — a statement
   * is untrusted model output, already quoted inside the evidence frame everywhere it is read as
   * content (§13), and a graph label must not become a second, unframed path for the same text.
   */
  private static memoryNodeLabel(statement: string): string {
    const normalized = statement.replace(/\s+/g, ' ').trim();
    if (normalized.length <= ProjectMemory.MEMORY_NODE_LABEL_MAX_CHARS) return normalized;
    return `${normalized.slice(0, ProjectMemory.MEMORY_NODE_LABEL_MAX_CHARS - 1)}…`;
  }

  /** Project one stored memory row and every exact repository citation it owns. This is the
   *  shared reconstruction primitive for promotion writes and the versioned full backfill:
   *  everything here is derived from durable columns, never inferred from statement text. */
  private projectStoredMemoryItem(memoryId: string, projectKey: string | null, now: string): { nodesWritten: number; edgesWritten: number } {
    const row = this.ctx.storage.sql
      .exec<{ id: string; kind: string; statement: string; supersedes_memory_id: string | null }>(
        `SELECT id, kind, statement, supersedes_memory_id FROM memory_items WHERE id = ?1`, memoryId,
      )
      .toArray()[0];
    if (!row) return { nodesWritten: 0, edgesWritten: 0 };

    let nodesWritten = 0;
    let edgesWritten = 0;
    const memoryNodeId = this.upsertGraphNode(
      'memory', buildEntityUri({ kind: 'memory', id: row.id }), ProjectMemory.memoryNodeLabel(row.statement), now,
    );
    nodesWritten++;
    const decisionNodeId = row.kind === 'decision'
      ? this.upsertGraphNode(
          'decision', buildEntityUri({ kind: 'decision', id: row.id }), ProjectMemory.memoryNodeLabel(row.statement), now,
        )
      : null;
    if (decisionNodeId) {
      nodesWritten++;
      this.linkGraphEdge('derived_from', decisionNodeId, memoryNodeId, now, 'memory_items:decision');
      edgesWritten++;
    }

    if (row.supersedes_memory_id) {
      const prior = this.ctx.storage.sql
        .exec<{ kind: string; statement: string }>(`SELECT kind, statement FROM memory_items WHERE id = ?1`, row.supersedes_memory_id)
        .toArray()[0];
      if (prior) {
        const priorNodeId = this.upsertGraphNode(
          'memory', buildEntityUri({ kind: 'memory', id: row.supersedes_memory_id }),
          ProjectMemory.memoryNodeLabel(prior.statement), now,
        );
        nodesWritten++;
        this.linkGraphEdge('supersedes', memoryNodeId, priorNodeId, now, 'memory_items:supersedes');
        edgesWritten++;
        if (decisionNodeId && prior.kind === 'decision') {
          const priorDecisionNodeId = this.upsertGraphNode(
            'decision', buildEntityUri({ kind: 'decision', id: row.supersedes_memory_id }),
            ProjectMemory.memoryNodeLabel(prior.statement), now,
          );
          nodesWritten++;
          this.linkGraphEdge('supersedes', decisionNodeId, priorDecisionNodeId, now, 'memory_items:supersedes');
          edgesWritten++;
        }
      }
    }

    if (projectKey) {
      const evidenceRows = this.ctx.storage.sql
        .exec<{ id: string; repository_key: string; path: string; symbol: string | null }>(
          `SELECT id, repository_key, path, symbol FROM evidence WHERE memory_item_id = ?1`, memoryId,
        )
        .toArray();
      for (const evidence of evidenceRows) {
        const fileNodeId = this.upsertGraphNode(
          'file',
          buildEntityUri({ kind: 'file', projectKey, repositoryKey: evidence.repository_key, path: evidence.path }),
          evidence.path,
          now,
        );
        nodesWritten++;
        this.linkGraphEdge(EVIDENCE_EDGE_TYPE, memoryNodeId, fileNodeId, now, `evidence:${evidence.id}`);
        edgesWritten++;
        if (evidence.symbol) {
          const symbolNodeId = this.upsertGraphNode(
            'symbol',
            buildEntityUri({ kind: 'symbol', projectKey, repositoryKey: evidence.repository_key, path: evidence.path, name: evidence.symbol }),
            evidence.symbol,
            now,
          );
          nodesWritten++;
          this.linkGraphEdge(EVIDENCE_EDGE_TYPE, memoryNodeId, symbolNodeId, now, `evidence:${evidence.id}`);
          edgesWritten++;
        }
      }
    }
    return { nodesWritten, edgesWritten };
  }

  /** Reconstruct the historical memory graph from facts ProjectMemory already stores: memory
   *  rows/evidence, correction lineage, contradiction pairs, and episode agent identity. */
  private projectStoredMemoryRelationships(projectKey: string | null, now: string): { nodesWritten: number; edgesWritten: number } {
    let nodesWritten = 0;
    let edgesWritten = 0;
    const memories = this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM memory_items`).toArray();
    for (const memory of memories) {
      const written = this.projectStoredMemoryItem(memory.id, projectKey, now);
      nodesWritten += written.nodesWritten;
      edgesWritten += written.edgesWritten;
    }

    const contradictions = this.ctx.storage.sql
      .exec<{ id: string; memory_item_id: string; contradicts_memory_item_id: string }>(
        `SELECT id, memory_item_id, contradicts_memory_item_id FROM contradictions`,
      )
      .toArray();
    for (const contradiction of contradictions) {
      const fromId = this.findGraphNodeId(buildEntityUri({ kind: 'memory', id: contradiction.memory_item_id }));
      const toId = this.findGraphNodeId(buildEntityUri({ kind: 'memory', id: contradiction.contradicts_memory_item_id }));
      if (fromId && toId) {
        this.linkGraphEdge('contradicts', fromId, toId, now, `memory:contradiction:${contradiction.id}`);
        edgesWritten++;
      }
    }

    const episodeMemories = this.ctx.storage.sql
      .exec<{ episode_id: string; run_kind: string | null; outcome: string | null; memory_item_id: string }>(
        `SELECT e.id AS episode_id, e.run_kind, e.outcome, m.id AS memory_item_id
         FROM episodes e JOIN memory_items m ON m.recorded_by_agent_id = e.agent_id
         WHERE e.agent_id IS NOT NULL`,
      )
      .toArray();
    for (const relation of episodeMemories) {
      const episodeNodeId = this.upsertGraphNode(
        'episode', buildEntityUri({ kind: 'episode', id: relation.episode_id }),
        `${relation.run_kind ?? 'run'} episode (${relation.outcome ?? 'unknown'})`, now,
      );
      nodesWritten++;
      const memoryNodeId = this.findGraphNodeId(buildEntityUri({ kind: 'memory', id: relation.memory_item_id }));
      if (memoryNodeId) {
        this.linkGraphEdge('related_to', episodeNodeId, memoryNodeId, now, `memory:episode-agent:${relation.episode_id}`);
        edgesWritten++;
      }
    }
    return { nodesWritten, edgesWritten };
  }

  async recordMemory(
    projectId: string,
    input: {
      operationId?: string;
      kind: string;
      statement: string;
      authority?: number;
      confidence?: number | null;
      evidence?: unknown[];
      supersedesMemoryId?: string | null;
      scope?: unknown;
      actor: { kind: string; id: string | null };
    },
  ): Promise<{ memoryId: string; operationId: string; deduped: boolean }> {
    await this.assertProjectId(projectId);
    if (input.operationId) {
      const existing = this.lookupAppliedOperation(input.operationId);
      if (existing) return { memoryId: (JSON.parse(existing.result) as { memoryId: string }).memoryId, operationId: input.operationId, deduped: true };
    }
    const scope = validateMemoryScope(input.scope ?? {});
    // PLNR-283: an evidence array entry is either the existing repository-scoped citation
    // (verified per branch/baseId, written to `evidence`) or a bare entity reference (task/
    // plan/run/decision/episode/artifact/agent/…) naming a durable entity the statement is
    // about — a graph fact, never an `evidence` row (nothing to re-verify against a worktree).
    const citations = (input.evidence ?? []).map((e) => classifyEvidenceCitation(e));
    const repoCitations = citations
      .filter((c): c is Extract<EvidenceCitation, { source: 'repository' }> => c.source === 'repository')
      .map((c) => c.ref);
    const evidenceHashes = await Promise.all(repoCitations.map((e) => evidenceHash(e)));
    const contentHash = await memoryContentHash(input.kind, input.statement, scope);
    // Only needed to build file/symbol uris (§18's repository-scoped shape) — skip the D1 round
    // trip when nothing here cites a repository (matches `recordEpisode`'s own gating).
    const projectKey = repoCitations.length ? await this.resolveProjectKey(projectId) : null;

    const operationId = input.operationId ?? newId('op');
    const authority = clampAuthority(input.authority ?? AUTHORITY_HYPOTHESIS, input.actor.kind);
    const memoryId = newId('mem');
    const now = this._forceRecordedAt ?? nowIso();

    this.ctx.storage.transactionSync(() => {
      if (this._forceWriteFailure) throw new Error('injected write failure (test)');
      if (scope.repositoryKey) {
        this.ctx.storage.sql.exec(
          `INSERT INTO repositories (repository_key, created_at) VALUES (?1, ?2) ON CONFLICT (repository_key) DO NOTHING`,
          scope.repositoryKey,
          now,
        );
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO memory_items
           (id, kind, statement, authority, confidence, content_hash, repository_key, branch, base_id, supersedes_memory_id, recorded_by_agent_id, recorded_at, proposed_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`,
        memoryId,
        input.kind,
        input.statement,
        authority,
        input.confidence ?? null,
        contentHash,
        scope.repositoryKey ?? null,
        scope.branch ?? null,
        scope.baseId ?? null,
        input.supersedesMemoryId ?? null,
        input.actor.id ?? null,
        now,
        // A decision an AGENT records enters the approval queue automatically (§12/PLNR-253) —
        // it is already non-authoritative (clamped above), and "proposed" is what makes it
        // visible-but-inert until a human decides, the SAME derived-state pattern spin-off tasks
        // use (migrations/0064). A human/system-recorded decision (there is no such path yet,
        // but the field is actor-general) is not auto-proposed — only an untrusted AI claim needs
        // the gate.
        input.kind === 'decision' && input.actor.kind === 'agent' ? now : null,
      );
      // PLNR-283 (§5/§11): the memory's own graph node, and typed edges to every entity its
      // evidence cites — SAME transaction, SAME single outbox row below (never a second
      // mutation, never a per-edge outbox row — the locked decision this task's execution spec
      // states verbatim). The node is written even with zero citations: a memory is always a
      // node. ONE pass over `citations` (not two) so a repository citation's freshly-minted
      // `evidence` row id is on hand to become that citation's edge provenance — `evidence:
      // <evidenceId>` (locked decision's own example grammar); an entity citation gets no
      // `evidence` row to point at, so its provenance names the memory itself.
      const memoryNodeId = this.upsertGraphNode(
        'memory',
        buildEntityUri({ kind: 'memory', id: memoryId }),
        ProjectMemory.memoryNodeLabel(input.statement),
        now,
      );
      const decisionNodeId = input.kind === 'decision'
        ? this.upsertGraphNode(
            'decision',
            buildEntityUri({ kind: 'decision', id: memoryId }),
            ProjectMemory.memoryNodeLabel(input.statement),
            now,
          )
        : null;
      if (decisionNodeId) {
        this.linkGraphEdge('derived_from', decisionNodeId, memoryNodeId, now, 'memory_items:decision');
      }
      let repoCitationIndex = 0;
      for (const citation of citations) {
        let provenance: string;
        if (citation.source === 'repository') {
          const ref = citation.ref;
          const evidenceId = newId('ev');
          this.ctx.storage.sql.exec(
            `INSERT INTO evidence
               (id, memory_item_id, repository_key, branch, base_id, path, symbol, content_hash, evidence_hash, verification_state, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
            evidenceId,
            memoryId,
            ref.repositoryKey,
            ref.branch,
            ref.baseId,
            ref.path,
            ref.symbol,
            ref.contentHash,
            evidenceHashes[repoCitationIndex]!,
            ref.verificationState,
            now,
          );
          repoCitationIndex++;
          provenance = `evidence:${evidenceId}`;
        } else {
          provenance = `evidence:${memoryId}`;
        }
        for (const node of evidenceCitationNodes(projectKey ?? '', citation)) {
          const targetNodeId = this.upsertGraphNode(node.type, node.uri, node.label, now);
          this.linkGraphEdge(EVIDENCE_EDGE_TYPE, memoryNodeId, targetNodeId, now, provenance);
        }
      }
      if (input.supersedesMemoryId) {
        const prior = this.ctx.storage.sql
          .exec<{ kind: string; statement: string }>(`SELECT kind, statement FROM memory_items WHERE id = ?1`, input.supersedesMemoryId)
          .toArray()[0];
        if (prior) {
          const priorNodeId = this.upsertGraphNode(
            'memory', buildEntityUri({ kind: 'memory', id: input.supersedesMemoryId }),
            ProjectMemory.memoryNodeLabel(prior.statement), now,
          );
          this.linkGraphEdge('supersedes', memoryNodeId, priorNodeId, now, 'memory_items:supersedes');
          if (decisionNodeId && prior.kind === 'decision') {
            const priorDecisionNodeId = this.upsertGraphNode(
              'decision',
              buildEntityUri({ kind: 'decision', id: input.supersedesMemoryId }),
              ProjectMemory.memoryNodeLabel(prior.statement),
              now,
            );
            this.linkGraphEdge('supersedes', decisionNodeId, priorDecisionNodeId, now, 'memory_items:supersedes');
          }
        }
      }

      this.ctx.storage.sql.exec(
        `INSERT INTO outbox (id, operation_id, verb, subject_type, subject_id, payload, created_at) VALUES (?1,?2,'memory.changed','memory',?3,?4,?5)`,
        newId('obx'),
        operationId,
        memoryId,
        JSON.stringify({ operationId, entityType: 'memory_item', kind: input.kind, authority }),
        now,
      );
      this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = value + 1 WHERE id = 0`);
      this.ctx.storage.sql.exec(
        `INSERT INTO applied_operations (operation_id, applied_at, subject_type, subject_id, result) VALUES (?1,?2,'memory_item',?3,?4)`,
        operationId,
        now,
        memoryId,
        JSON.stringify({ memoryId }),
      );
    });
    this.ctx.storage.setAlarm(Date.now()).catch(() => {});
    // PLNR-255: index the new version (and de-index the one it supersedes, so the old
    // statement stops out-ranking its replacement — the row itself stays fully readable via
    // getMemoryItem, only its vector is dropped). Fire-and-forget, same as every other write
    // side-effect here: indexing must never fail or slow down the write it derives from.
    const searchBackendForIndex = searchBackend(this.env);
    if (searchBackendForIndex) {
      const supersedes = input.supersedesMemoryId ?? null;
      void indexEntity(searchBackendForIndex, { kind: 'memory', id: memoryId, projectId, title: input.kind, body: input.statement })
        .then(() => (supersedes ? removeEntity(searchBackendForIndex, 'memory', supersedes) : undefined))
        .catch((err) => console.warn(`ProjectMemory memory-index for ${memoryId} failed: ${String(err)}`));
    }
    return { memoryId, operationId, deduped: false };
  }

  async writeNode(
    projectId: string,
    input: { operationId?: string; type: string; uri: string; label: string; actor: { kind: string; id: string | null } },
  ): Promise<{ nodeId: string; operationId: string; deduped: boolean }> {
    await this.assertProjectId(projectId);
    if (input.operationId) {
      const existing = this.lookupAppliedOperation(input.operationId);
      if (existing) return { nodeId: (JSON.parse(existing.result) as { nodeId: string }).nodeId, operationId: input.operationId, deduped: true };
    }
    const operationId = input.operationId ?? newId('op');
    const candidateId = newId('node');
    const now = nowIso();
    let nodeId = candidateId;
    this.ctx.storage.transactionSync(() => {
      if (this._forceWriteFailure) throw new Error('injected write failure (test)');
      this.ctx.storage.sql.exec(
        `INSERT INTO nodes (id, type, uri, label, created_at) VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT (uri) DO UPDATE SET label = excluded.label`,
        candidateId,
        input.type,
        input.uri,
        input.label,
        now,
      );
      nodeId = this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE uri = ?1`, input.uri).toArray()[0]!.id;
      this.ctx.storage.sql.exec(
        `INSERT INTO outbox (id, operation_id, verb, subject_type, subject_id, payload, created_at) VALUES (?1,?2,'memory.changed','memory',?3,?4,?5)`,
        newId('obx'),
        operationId,
        nodeId,
        JSON.stringify({ operationId, entityType: 'node', nodeType: input.type }),
        now,
      );
      this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = value + 1 WHERE id = 0`);
      this.ctx.storage.sql.exec(
        `INSERT INTO applied_operations (operation_id, applied_at, subject_type, subject_id, result) VALUES (?1,?2,'node',?3,?4)`,
        operationId,
        now,
        nodeId,
        JSON.stringify({ nodeId }),
      );
    });
    this.ctx.storage.setAlarm(Date.now()).catch(() => {});
    return { nodeId, operationId, deduped: false };
  }

  async writeEdge(
    projectId: string,
    input: { operationId?: string; type: string; fromNodeId: string; toNodeId: string; actor: { kind: string; id: string | null } },
  ): Promise<{ edgeId: string; operationId: string; deduped: boolean }> {
    await this.assertProjectId(projectId);
    if (input.operationId) {
      const existing = this.lookupAppliedOperation(input.operationId);
      if (existing) return { edgeId: (JSON.parse(existing.result) as { edgeId: string }).edgeId, operationId: input.operationId, deduped: true };
    }
    const operationId = input.operationId ?? newId('op');
    const candidateId = newId('edge');
    const now = nowIso();
    let edgeId = candidateId;
    this.ctx.storage.transactionSync(() => {
      if (this._forceWriteFailure) throw new Error('injected write failure (test)');
      this.ctx.storage.sql.exec(
        `INSERT INTO edges (id, type, from_node_id, to_node_id, created_at) VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT (type, from_node_id, to_node_id) DO NOTHING`,
        candidateId,
        input.type,
        input.fromNodeId,
        input.toNodeId,
        now,
      );
      edgeId = this.ctx.storage.sql
        .exec<{ id: string }>(`SELECT id FROM edges WHERE type = ?1 AND from_node_id = ?2 AND to_node_id = ?3`, input.type, input.fromNodeId, input.toNodeId)
        .toArray()[0]!.id;
      this.ctx.storage.sql.exec(
        `INSERT INTO outbox (id, operation_id, verb, subject_type, subject_id, payload, created_at) VALUES (?1,?2,'memory.changed','memory',?3,?4,?5)`,
        newId('obx'),
        operationId,
        edgeId,
        JSON.stringify({ operationId, entityType: 'edge', edgeType: input.type }),
        now,
      );
      this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = value + 1 WHERE id = 0`);
      this.ctx.storage.sql.exec(
        `INSERT INTO applied_operations (operation_id, applied_at, subject_type, subject_id, result) VALUES (?1,?2,'edge',?3,?4)`,
        operationId,
        now,
        edgeId,
        JSON.stringify({ edgeId }),
      );
    });
    this.ctx.storage.setAlarm(Date.now()).catch(() => {});
    return { edgeId, operationId, deduped: false };
  }

  /** Link two memories as contradicting each other, addressable as one named set (§12). Passing
   *  an existing `setId` folds a third (or later) memory into the same disagreement rather than
   *  starting a new one. */
  async addContradiction(
    projectId: string,
    input: {
      operationId?: string;
      memoryItemId: string;
      contradictsMemoryItemId: string;
      setId?: string | null;
      actor: { kind: string; id: string | null };
    },
  ): Promise<{ setId: string; contradictionId: string; operationId: string; deduped: boolean }> {
    await this.assertProjectId(projectId);
    if (input.operationId) {
      const existing = this.lookupAppliedOperation(input.operationId);
      if (existing) {
        const result = JSON.parse(existing.result) as { setId: string; contradictionId: string };
        return { ...result, operationId: input.operationId, deduped: true };
      }
    }
    const operationId = input.operationId ?? newId('op');
    const setId = input.setId ?? newId('cset');
    const contradictionId = newId('contra');
    const now = nowIso();
    this.ctx.storage.transactionSync(() => {
      if (this._forceWriteFailure) throw new Error('injected write failure (test)');
      if (!input.setId) {
        this.ctx.storage.sql.exec(`INSERT INTO contradiction_sets (id, created_at) VALUES (?1, ?2)`, setId, now);
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO contradictions (id, memory_item_id, contradicts_memory_item_id, set_id, created_at) VALUES (?1,?2,?3,?4,?5)`,
        contradictionId,
        input.memoryItemId,
        input.contradictsMemoryItemId,
        setId,
        now,
      );
      const fromMemory = this.ctx.storage.sql
        .exec<{ statement: string }>(`SELECT statement FROM memory_items WHERE id = ?1`, input.memoryItemId)
        .toArray()[0];
      const toMemory = this.ctx.storage.sql
        .exec<{ statement: string }>(`SELECT statement FROM memory_items WHERE id = ?1`, input.contradictsMemoryItemId)
        .toArray()[0];
      if (fromMemory && toMemory) {
        const fromNodeId = this.upsertGraphNode(
          'memory', buildEntityUri({ kind: 'memory', id: input.memoryItemId }),
          ProjectMemory.memoryNodeLabel(fromMemory.statement), now,
        );
        const toNodeId = this.upsertGraphNode(
          'memory', buildEntityUri({ kind: 'memory', id: input.contradictsMemoryItemId }),
          ProjectMemory.memoryNodeLabel(toMemory.statement), now,
        );
        this.linkGraphEdge('contradicts', fromNodeId, toNodeId, now, `memory:contradiction:${contradictionId}`);
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO outbox (id, operation_id, verb, subject_type, subject_id, payload, created_at) VALUES (?1,?2,'memory.changed','memory',?3,?4,?5)`,
        newId('obx'),
        operationId,
        contradictionId,
        JSON.stringify({ operationId, entityType: 'contradiction', setId }),
        now,
      );
      this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = value + 1 WHERE id = 0`);
      this.ctx.storage.sql.exec(
        `INSERT INTO applied_operations (operation_id, applied_at, subject_type, subject_id, result) VALUES (?1,?2,'contradiction',?3,?4)`,
        operationId,
        now,
        contradictionId,
        JSON.stringify({ setId, contradictionId }),
      );
    });
    this.ctx.storage.setAlarm(Date.now()).catch(() => {});
    return { setId, contradictionId, operationId, deduped: false };
  }

  /** Every memory item currently in a named contradiction set — the set is the addressable
   *  unit a caller resolves, not the individual pairwise rows. */
  async getContradictionSet(projectId: string, setId: string): Promise<{ setId: string; memoryItemIds: string[]; resolvedAt: string | null }> {
    await this.assertProjectId(projectId);
    const rows = this.ctx.storage.sql
      .exec<{ memory_item_id: string; contradicts_memory_item_id: string }>(
        `SELECT memory_item_id, contradicts_memory_item_id FROM contradictions WHERE set_id = ?1`,
        setId,
      )
      .toArray();
    const ids = new Set<string>();
    for (const r of rows) {
      ids.add(r.memory_item_id);
      ids.add(r.contradicts_memory_item_id);
    }
    const setRow = this.ctx.storage.sql.exec<{ resolved_at: string | null }>(`SELECT resolved_at FROM contradiction_sets WHERE id = ?1`, setId).toArray()[0];
    return { setId, memoryItemIds: [...ids], resolvedAt: setRow?.resolved_at ?? null };
  }

  /** Basic up/down feedback on a memory (§11 — an operation on the memory surface, not a
   *  separate agent tool). 0001's `feedback.vote` is CHECK-constrained to exactly these two
   *  values; PLNR-254 widens the vocabulary (useful/incorrect/outdated/harmful/unverifiable)
   *  with its own additive migration — this RPC does not anticipate that shape. */
  /** Feedback kind -> vote, when a caller supplies `kind` but not `vote` (§11/PLNR-254): the
   *  richer vocabulary still lands in the plain up/down bucket every existing reader (and the
   *  0001-era `vote` NOT NULL constraint) expects, without forcing every caller to state both. */
  private static readonly FEEDBACK_KIND_VOTE: Record<string, 'up' | 'down'> = {
    useful: 'up',
    incorrect: 'down',
    outdated: 'down',
    harmful: 'down',
    unverifiable: 'down',
  };

  /**
   * Record feedback on a memory (§11 — an operation on the memory surface, never a separate
   * agent tool). Influences ranking/presentation ONLY: it never touches the target's statement,
   * evidence, or authority — a correction is a NEW version (recordMemory + supersedesMemoryId),
   * not an edit here. `kind` (PLNR-254) carries the five-value vocabulary useful / incorrect /
   * outdated / harmful / unverifiable; `vote` (0001) stays the plain up/down signal every
   * existing caller already sends. At least one of the two is required; the other is derived
   * when omitted.
   */
  async recordFeedback(
    projectId: string,
    input: {
      operationId?: string;
      memoryItemId: string;
      vote?: 'up' | 'down';
      kind?: 'useful' | 'incorrect' | 'outdated' | 'harmful' | 'unverifiable';
      reason?: string | null;
      actor: { kind: string; id: string | null };
    },
  ): Promise<{ feedbackId: string; operationId: string; deduped: boolean }> {
    await this.assertProjectId(projectId);
    if (input.operationId) {
      const existing = this.lookupAppliedOperation(input.operationId);
      if (existing) return { feedbackId: (JSON.parse(existing.result) as { feedbackId: string }).feedbackId, operationId: input.operationId, deduped: true };
    }
    if (!input.vote && !input.kind) throw new Error('recordFeedback requires vote and/or kind');
    const vote = input.vote ?? ProjectMemory.FEEDBACK_KIND_VOTE[input.kind!]!;
    const kind = input.kind ?? null;

    const operationId = input.operationId ?? newId('op');
    const feedbackId = newId('fbk');
    const now = nowIso();
    this.ctx.storage.transactionSync(() => {
      if (this._forceWriteFailure) throw new Error('injected write failure (test)');
      this.ctx.storage.sql.exec(
        `INSERT INTO feedback (id, memory_item_id, actor_id, vote, kind, reason, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)`,
        feedbackId,
        input.memoryItemId,
        input.actor.id ?? 'system',
        vote,
        kind,
        input.reason ?? null,
        now,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO outbox (id, operation_id, verb, subject_type, subject_id, payload, created_at) VALUES (?1,?2,'memory.changed','memory',?3,?4,?5)`,
        newId('obx'),
        operationId,
        feedbackId,
        JSON.stringify({ operationId, entityType: 'feedback', memoryItemId: input.memoryItemId, vote, kind }),
        now,
      );
      this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = value + 1 WHERE id = 0`);
      this.ctx.storage.sql.exec(
        `INSERT INTO applied_operations (operation_id, applied_at, subject_type, subject_id, result) VALUES (?1,?2,'feedback',?3,?4)`,
        operationId,
        now,
        feedbackId,
        JSON.stringify({ feedbackId }),
      );
    });
    this.ctx.storage.setAlarm(Date.now()).catch(() => {});
    return { feedbackId, operationId, deduped: false };
  }

  /**
   * Transition a memory's own presentation validity (§15) — 'active' | 'stale' | 'invalid'.
   * Deliberately separate from `evidence.verification_state` (per-citation freshness, 0001):
   * this is the memory's OWN state, and setting it never touches any evidence row's own value.
   * Recorded as a state change alongside canonical history, never a deletion — the memory stays
   * fully readable at every validity, exactly like a superseded or rejected one.
   */
  async transitionMemoryValidity(
    projectId: string,
    input: { memoryItemId: string; validity: 'active' | 'stale' | 'invalid'; reason?: string | null; actor: { kind: string; id: string | null } },
  ): Promise<{ ok: true }> {
    await this.assertProjectId(projectId);
    const row = this.loadMemoryRow(input.memoryItemId);
    if (!row) throw new Error(`memory item ${input.memoryItemId} not found`);
    const operationId = newId('op');
    const now = nowIso();
    this.ctx.storage.transactionSync(() => {
      if (this._forceWriteFailure) throw new Error('injected write failure (test)');
      this.ctx.storage.sql.exec(`UPDATE memory_items SET validity = ?2 WHERE id = ?1`, input.memoryItemId, input.validity);
      this.ctx.storage.sql.exec(
        `INSERT INTO outbox (id, operation_id, verb, subject_type, subject_id, payload, created_at) VALUES (?1,?2,'memory.changed','memory',?3,?4,?5)`,
        newId('obx'),
        operationId,
        input.memoryItemId,
        JSON.stringify({ operationId, entityType: 'validity_transition', memoryItemId: input.memoryItemId, validity: input.validity, reason: input.reason ?? null }),
        now,
      );
      this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = value + 1 WHERE id = 0`);
      this.ctx.storage.sql.exec(
        `INSERT INTO applied_operations (operation_id, applied_at, subject_type, subject_id, result) VALUES (?1,?2,'validity_transition',?3,'{}')`,
        operationId,
        now,
        input.memoryItemId,
      );
    });
    this.ctx.storage.setAlarm(Date.now()).catch(() => {});
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // PLNR-265: server-side citation verification. Two tiers, ONE downstream path
  // (`rollUpAndTransitionValidity` below) — a memory's OWN validity always changes through
  // `transitionMemoryValidity` above, never a direct UPDATE, so a verification-driven demotion
  // stays canonical history exactly like a human/approval-driven one (locked decision: "written
  // through the EXISTING transitionMemoryValidity RPC, not a new direct UPDATE").
  //   - `verifyMemoryCitations` — the CHEAP tier (§15): checks citations against the ACTIVE index
  //     generation's graph only. No network calls (locked decision: no GitHub client exists in
  //     this codebase, and outbound fetch from the worker isolate reached via SELF.fetch cannot
  //     be intercepted by `fetchMock` — CLAUDE.md — so that path is a named seam, not built here).
  //   - `acceptVerificationReport` — the THOROUGH tier's landing point: a Runner's worktree
  //     verification pass. Idempotent by (evidenceHash, reported base, reported state): a citation
  //     already at the reported values is left untouched, so a daemon retry after a dropped
  //     response changes nothing.
  // Neither path ever deletes a memory, its evidence, or its history (§12/§15) — every write here
  // is an UPDATE of 0008's verification columns on an EXISTING evidence row.
  // ---------------------------------------------------------------------------

  /** The active generation's (id, branch, baseId) for one repository, memoized per verification
   *  call — many citations in one sweep typically share a repository, and this would otherwise
   *  be one SELECT per citation. `null` when the repository has no active generation at all (no
   *  index has ever run, or one is only staged) — the honest "nothing to check against" case. */
  private activeGenerationScope(
    repositoryKey: string,
    cache: Map<string, { id: string; branch: string; baseId: string } | null>,
  ): { id: string; branch: string; baseId: string } | null {
    if (!cache.has(repositoryKey)) {
      const gen = this.ctx.storage.sql
        .exec<{ id: string; branch: string; base_id: string }>(
          `SELECT id, branch, base_id FROM index_generations WHERE repository_key = ?1 AND status = 'active'`,
          repositoryKey,
        )
        .toArray()[0];
      cache.set(repositoryKey, gen ? { id: gen.id, branch: gen.branch, baseId: gen.base_id } : null);
    }
    return cache.get(repositoryKey)!;
  }

  /**
   * Did THIS ACTIVE GENERATION actually stage a `file`/`symbol` entity for this citation? Reads
   * `index_staged_entities` (keyed `(generation_id, uri)`, retained for the life of the
   * generation — PLNR-261 never deletes staged rows on supersession), never the live `nodes`
   * table. PLNR-283: `nodes` is no longer a reliable proxy for "the index actually found this
   * file at this base" once `recordMemory` also upserts a `file`/`symbol` node for any
   * repository-scoped evidence citation, real or not — a citation naming a file the repository
   * has actually deleted must still verify `missing` even though the memory citing it just
   * caused that same uri to exist as a node. Only meaningful once a caller has confirmed an
   * active generation exists for the repository — see `citationVerdict` for what a `null` (no
   * generation) result means instead.
   */
  private checkCitationAgainstGraph(generationId: string, projectKey: string, citation: { repository_key: string; path: string; symbol: string | null }): CitationCheck {
    const fileUri = buildEntityUri({ kind: 'file', projectKey, repositoryKey: citation.repository_key, path: citation.path });
    const pathPresent = !!this.ctx.storage.sql
      .exec<{ x: number }>(`SELECT 1 AS x FROM index_staged_entities WHERE generation_id = ?1 AND uri = ?2`, generationId, fileUri)
      .toArray()[0];
    let symbolPresent: boolean | null = null;
    if (citation.symbol) {
      const symbolUri = buildEntityUri({ kind: 'symbol', projectKey, repositoryKey: citation.repository_key, path: citation.path, name: citation.symbol });
      symbolPresent = !!this.ctx.storage.sql
        .exec<{ x: number }>(`SELECT 1 AS x FROM index_staged_entities WHERE generation_id = ?1 AND uri = ?2`, generationId, symbolUri)
        .toArray()[0];
    }
    return { pathPresent, symbolPresent };
  }

  /** Recompute one memory's validity from its CURRENT evidence rows (`rollUpValidity`) and, only
   *  when it actually differs from what is stored, write it through `transitionMemoryValidity` —
   *  the same choke point every other validity change goes through. Doing nothing when nothing
   *  changed is what makes both verification RPCs idempotent: a repeated sweep/report that alters
   *  no evidence row never calls this at all (its caller only invokes this for a memory whose
   *  evidence it just touched), and even if it did, a same-answer rollup is a no-op here too. */
  private async rollUpAndTransitionValidity(
    projectId: string,
    memoryItemId: string,
    reason: string,
    actor: { kind: string; id: string | null },
  ): Promise<void> {
    const states = this.ctx.storage.sql
      .exec<{ verification_state: string }>(`SELECT verification_state FROM evidence WHERE memory_item_id = ?1`, memoryItemId)
      .toArray()
      .map((r) => r.verification_state);
    const rollup = rollUpValidity(states);
    if (rollup === null) return; // no repository evidence at all — never demoted by this path (locked decision)
    const current = this.ctx.storage.sql.exec<{ validity: string }>(`SELECT validity FROM memory_items WHERE id = ?1`, memoryItemId).toArray()[0];
    if (!current || current.validity === rollup) return;
    await this.transitionMemoryValidity(projectId, { memoryItemId, validity: rollup, reason, actor });
  }

  /**
   * The cheap server-side tier (§15): verify one memory's citations (`memoryItemId`), or a
   * bounded sweep of the project's oldest/never-verified citations (`limit`, default 25, capped
   * 200) when no `memoryItemId` is given — both forms share this one RPC (discretion). Never
   * throws for a repository with no active generation or a project with no index at all; every
   * such citation simply reads 'unverifiable' (§1) rather than 'valid' or 'missing'.
   *
   * An evidence row is updated ONLY when its verdict/base/branch/source actually changed from
   * what is already stored — an unchanged citation is left byte-identical (no new
   * `last_verified_at`), which is what keeps a repeated sweep over an unindexed project from
   * endlessly bumping timestamps for no new information.
   */
  async verifyMemoryCitations(
    projectId: string,
    input: { memoryItemId?: string; limit?: number },
  ): Promise<{ checked: number; updated: number; results: Array<{ evidenceId: string; memoryItemId: string; verificationState: string }> }> {
    await this.assertProjectId(projectId);
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 200);
    type EvidenceRow = {
      id: string; memory_item_id: string; repository_key: string; path: string; symbol: string | null;
      verification_state: string; last_verified_at: string | null; last_verified_base_id: string | null;
      last_verified_branch: string | null; verification_source: string | null; observed_path: string | null;
    };
    const cols = `id, memory_item_id, repository_key, path, symbol, verification_state,
                  last_verified_at, last_verified_base_id, last_verified_branch, verification_source, observed_path`;
    const rows = input.memoryItemId
      ? this.ctx.storage.sql.exec<EvidenceRow>(`SELECT ${cols} FROM evidence WHERE memory_item_id = ?1 ORDER BY created_at`, input.memoryItemId).toArray()
      // Oldest/never-verified first — a bounded sweep with no target memory makes forward
      // progress across the whole project rather than re-checking the same head-of-table rows
      // every call. `last_verified_at IS NOT NULL` sorts every never-verified row (NULL) first.
      : this.ctx.storage.sql.exec<EvidenceRow>(`SELECT ${cols} FROM evidence ORDER BY last_verified_at IS NOT NULL, last_verified_at ASC LIMIT ?1`, limit).toArray();
    if (!rows.length) return { checked: 0, updated: 0, results: [] };

    const projectKey = await this.resolveProjectKey(projectId);
    const genCache = new Map<string, { id: string; branch: string; baseId: string } | null>();
    const now = nowIso();
    const source = 'server-index';
    const results: Array<{ evidenceId: string; memoryItemId: string; verificationState: string }> = [];
    const touchedMemoryIds = new Set<string>();
    let updated = 0;

    this.ctx.storage.transactionSync(() => {
      if (this._forceWriteFailure) throw new Error('injected write failure (test)');
      for (const row of rows) {
        const gen = this.activeGenerationScope(row.repository_key, genCache);
        const check = gen ? this.checkCitationAgainstGraph(gen.id, projectKey, row) : null;
        const verdict = citationVerdict(check);
        const baseId = gen?.baseId ?? null;
        const branch = gen?.branch ?? null;
        // A Runner/worktree report is the thorough tier (§15). While it describes the same
        // active base the cheap index check is looking at, preserve its richer verdict (notably
        // `moved`) and observed path. The source remains a free label for verifier identity;
        // `server-index` is the sole cheap-tier label, so every other non-null source has higher
        // fidelity. Once the active base advances, this guard naturally expires and the cheap
        // tier may establish a verdict for the new generation.
        const preserveThoroughVerdict =
          row.verification_source !== null && row.verification_source !== source &&
          row.last_verified_base_id === baseId;
        if (preserveThoroughVerdict) {
          results.push({ evidenceId: row.id, memoryItemId: row.memory_item_id, verificationState: row.verification_state });
          continue;
        }
        results.push({ evidenceId: row.id, memoryItemId: row.memory_item_id, verificationState: verdict });
        const unchanged =
          row.verification_state === verdict && row.last_verified_base_id === baseId &&
          row.last_verified_branch === branch && row.verification_source === source && row.observed_path === null;
        if (unchanged) continue;
        this.ctx.storage.sql.exec(
          `UPDATE evidence SET verification_state = ?2, last_verified_at = ?3, last_verified_base_id = ?4,
                  last_verified_branch = ?5, verification_source = ?6, observed_path = NULL WHERE id = ?1`,
          row.id,
          verdict,
          now,
          baseId,
          branch,
          source,
        );
        touchedMemoryIds.add(row.memory_item_id);
        updated++;
      }
    });

    for (const memoryItemId of touchedMemoryIds) {
      await this.rollUpAndTransitionValidity(projectId, memoryItemId, 'server-side citation verification sweep', { kind: 'system', id: null });
    }
    return { checked: rows.length, updated, results };
  }

  /**
   * The Runner's thorough tier lands here (§15). `report` is assumed already validated/normalized
   * by the caller (`normalizeVerificationReport` — the REST route's job, matching
   * `validateEvidenceRef`'s split for `record_memory`) — this RPC trusts the SHAPE but not the
   * CONTENT: a citation naming a `(memoryItemId, evidenceHash)` pair this project no longer has
   * (superseded, decayed) is silently skipped, never a fatal error for the rest of the report.
   *
   * Idempotent by construction (locked decision — "idempotency keys off the citation's
   * evidence_hash plus the reported base and state"): a citation whose state/baseId/branch/
   * source/observedPath ALL already match the evidence row's current values is left completely
   * untouched — no write, no outbox event, no validity transition — so a daemon retry after a
   * dropped response is free. A report that changes NOTHING therefore also transitions NO
   * memory's validity, which is what makes repeated identical reports produce zero extra events.
   */
  async acceptVerificationReport(
    projectId: string,
    report: VerificationReport,
    actor: { kind: string; id: string | null },
  ): Promise<{ applied: number; skipped: number; touchedMemoryIds: string[] }> {
    await this.assertProjectId(projectId);
    type EvidenceRow = {
      id: string; memory_item_id: string; verification_state: string; last_verified_base_id: string | null;
      last_verified_branch: string | null; verification_source: string | null; observed_path: string | null;
    };
    const now = nowIso();
    const touchedMemoryIds = new Set<string>();
    let applied = 0;
    let skipped = 0;

    this.ctx.storage.transactionSync(() => {
      if (this._forceWriteFailure) throw new Error('injected write failure (test)');
      for (const citation of report.citations) {
        const row = this.ctx.storage.sql
          .exec<EvidenceRow>(
            `SELECT id, memory_item_id, verification_state, last_verified_base_id, last_verified_branch, verification_source, observed_path
             FROM evidence WHERE memory_item_id = ?1 AND evidence_hash = ?2`,
            citation.memoryItemId,
            citation.evidenceHash,
          )
          .toArray()[0];
        if (!row) { skipped++; continue; } // report cites evidence this project no longer has — tolerate, never fail the whole report
        const observedPath = citation.observedPath ?? null;
        const unchanged =
          row.verification_state === citation.state && row.last_verified_base_id === citation.baseId &&
          row.last_verified_branch === citation.branch && row.verification_source === report.source && row.observed_path === observedPath;
        if (unchanged) { skipped++; continue; }
        this.ctx.storage.sql.exec(
          `UPDATE evidence SET verification_state = ?2, last_verified_at = ?3, last_verified_base_id = ?4,
                  last_verified_branch = ?5, verification_source = ?6, observed_path = ?7 WHERE id = ?1`,
          row.id,
          citation.state,
          now,
          citation.baseId,
          citation.branch,
          report.source,
          observedPath,
        );
        touchedMemoryIds.add(row.memory_item_id);
        applied++;
      }
    });

    for (const memoryItemId of touchedMemoryIds) {
      await this.rollUpAndTransitionValidity(projectId, memoryItemId, `verification report (${report.source})`, actor);
    }
    return { applied, skipped, touchedMemoryIds: [...touchedMemoryIds] };
  }

  /**
   * Bounded retention for unused low-authority hypotheses (§18/PLNR-254). A candidate is
   * decayed only when ALL of: authority below `authorityCeiling`, recorded before the cutoff,
   * no feedback of any kind has ever been recorded on it (feedback IS usage — a memory somebody
   * reacted to is not "unused"), it is not part of any authority-transition history (never
   * approved, rejected, or merge-promoted, and never itself the RESULT of one), and nothing
   * supersedes it (a memory another version links back to is history, not a cache entry).
   * Unlike supersession/rejection, decay actually DELETES the row — recoverable only by
   * restoring a pre-decay snapshot (PLNR-248/249), which is what "reversible from backup" means
   * here, not an in-store undo. One compact outbox audit event covers the whole run; no memory
   * body rides it. Safe to call repeatedly: a project with nothing left to decay is a no-op.
   *
   * NOTE on "unused": no retrieval/usage-counter infrastructure exists yet (that is Phase 4's
   * retrieval work) — absence of feedback plus age is the only honest signal available today.
   * A real usage counter can replace or narrow this once retrieval exists.
   */
  async decayLowAuthorityMemories(
    projectId: string,
    input: { maxAgeMs: number; authorityCeiling: number },
  ): Promise<{ decayed: string[] }> {
    await this.assertProjectId(projectId);
    const cutoff = new Date(Date.now() - input.maxAgeMs).toISOString();
    const candidates = this.ctx.storage.sql
      .exec<{ id: string }>(
        `SELECT id FROM memory_items m
         WHERE authority < ?1 AND recorded_at < ?2
           AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.memory_item_id = m.id)
           AND NOT EXISTS (SELECT 1 FROM memory_items m2 WHERE m2.supersedes_memory_id = m.id)
           AND NOT EXISTS (
             SELECT 1 FROM memory_authority_transitions t
             WHERE t.memory_item_id = m.id OR t.resulting_memory_id = m.id
           )`,
        input.authorityCeiling,
        cutoff,
      )
      .toArray();
    if (candidates.length === 0) return { decayed: [] };

    const decayed = candidates.map((c) => c.id);
    const operationId = newId('op');
    const now = nowIso();
    this.ctx.storage.transactionSync(() => {
      if (this._forceWriteFailure) throw new Error('injected write failure (test)');
      for (const id of decayed) {
        this.ctx.storage.sql.exec(`DELETE FROM feedback WHERE memory_item_id = ?1`, id);
        this.ctx.storage.sql.exec(`DELETE FROM evidence WHERE memory_item_id = ?1`, id);
        this.ctx.storage.sql.exec(`DELETE FROM memory_items WHERE id = ?1`, id);
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO outbox (id, operation_id, verb, subject_type, subject_id, payload, created_at) VALUES (?1,?2,'memory.changed','memory',?3,?4,?5)`,
        newId('obx'),
        operationId,
        projectId,
        JSON.stringify({ operationId, entityType: 'decay', count: decayed.length, decayedIds: decayed }),
        now,
      );
      this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = value + 1 WHERE id = 0`);
      this.ctx.storage.sql.exec(
        `INSERT INTO applied_operations (operation_id, applied_at, subject_type, subject_id, result) VALUES (?1,?2,'decay',?3,'{}')`,
        operationId,
        now,
        projectId,
      );
    });
    this.ctx.storage.setAlarm(Date.now()).catch(() => {});
    // PLNR-255: decay is the one path that hard-deletes memory rows — their vectors must be
    // dropped too, or they hydrate to nothing forever (hydrate's silent-skip would just make
    // them vanish from results, but the vector itself would sit in the index permanently).
    const searchBackendForIndex = searchBackend(this.env);
    if (searchBackendForIndex) {
      for (const id of decayed) {
        void removeEntity(searchBackendForIndex, 'memory', id).catch((err) => console.warn(`ProjectMemory memory-deindex for ${id} failed: ${String(err)}`));
      }
    }
    return { decayed };
  }

  /** A memory item in full — statement, authority, scope, and its evidence — exactly as
   *  recorded. A superseded item is reachable through this the same way its replacement is;
   *  supersession never mutates or hides the row it links back to (§12). */
  async getMemoryItem(projectId: string, memoryId: string): Promise<{
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
      // The citation's stable identity (shared evidenceHash — repository/branch/baseId/
      // path/symbol) — PLNR-265's Runner verification report addresses a citation by
      // (memoryItemId, evidenceHash), never this row's internal `id`, so exposing it here is
      // what lets a human (or a future Runner integration) build a report without recomputing
      // the hash independently.
      evidenceHash: string | null;
      // PLNR-265: when/against-what/by-whom this citation was last checked (§15's stated
      // acceptance — "verification source and timestamp are inspectable"). All null for a
      // citation no sweep or Runner report has ever reached yet — never implied 'valid' by their
      // absence, which is exactly the failure mode a silently-defaulted timestamp would create.
      lastVerifiedAt: string | null;
      lastVerifiedBaseId: string | null;
      lastVerifiedBranch: string | null;
      verificationSource: string | null;
      observedPath: string | null;
    }>;
  } | null> {
    await this.assertProjectId(projectId);
    const row = this.ctx.storage.sql
      .exec<{
        id: string;
        kind: string;
        statement: string;
        authority: number;
        confidence: number | null;
        content_hash: string | null;
        repository_key: string | null;
        branch: string | null;
        base_id: string | null;
        validity: string;
        supersedes_memory_id: string | null;
        recorded_by_agent_id: string | null;
        recorded_at: string;
        proposed_at: string | null;
        rejected_at: string | null;
      }>(`SELECT * FROM memory_items WHERE id = ?1`, memoryId)
      .toArray()[0];
    if (!row) return null;
    const evidence = this.ctx.storage.sql
      .exec<{
        id: string; repository_key: string; branch: string; base_id: string; path: string; symbol: string | null;
        verification_state: string; evidence_hash: string | null; last_verified_at: string | null; last_verified_base_id: string | null;
        last_verified_branch: string | null; verification_source: string | null; observed_path: string | null;
      }>(
        `SELECT id, repository_key, branch, base_id, path, symbol, verification_state, evidence_hash,
                last_verified_at, last_verified_base_id, last_verified_branch, verification_source, observed_path
         FROM evidence WHERE memory_item_id = ?1 ORDER BY created_at`,
        memoryId,
      )
      .toArray();
    return {
      id: row.id,
      kind: row.kind,
      statement: row.statement,
      authority: row.authority,
      confidence: row.confidence,
      contentHash: row.content_hash,
      repositoryKey: row.repository_key,
      branch: row.branch,
      baseId: row.base_id,
      validity: row.validity,
      supersedesMemoryId: row.supersedes_memory_id,
      recordedByAgentId: row.recorded_by_agent_id,
      recordedAt: row.recorded_at,
      proposedAt: row.proposed_at,
      rejectedAt: row.rejected_at,
      evidence: evidence.map((e) => ({
        id: e.id,
        repositoryKey: e.repository_key,
        branch: e.branch,
        baseId: e.base_id,
        path: e.path,
        symbol: e.symbol,
        verificationState: e.verification_state,
        evidenceHash: e.evidence_hash,
        lastVerifiedAt: e.last_verified_at,
        lastVerifiedBaseId: e.last_verified_base_id,
        lastVerifiedBranch: e.last_verified_branch,
        verificationSource: e.verification_source,
        observedPath: e.observed_path,
      })),
    };
  }

  /**
   * PLNR-271: the human explorer's "what is this memory's lineage, and what has been said about
   * it" read. Walks the `supersedes_memory_id` chain in BOTH directions from `memoryItemId` —
   * ancestors (what this version corrected) and descendants (what corrected it, possibly more
   * than one if two independent corrections were ever recorded) — so a human opening ANY version
   * in a lineage sees the whole thread, not just one hop. Bounded (`MAX_CHAIN`) the same way
   * every graph walk in this file is bounded (locked decision: never an unbounded traversal).
   *
   * Read-only: no memory_revision bump, no outbox row, same as the PLNR-255 hydration RPCs above.
   * Returns `null` only when `memoryItemId` itself does not exist — every OTHER field is an
   * empty array rather than an error, the same "absence is not a failure" posture the rest of
   * this file uses (a memory with no transitions/contradictions/feedback is the common case, not
   * a broken one).
   */
  async getMemoryHistory(
    projectId: string,
    memoryItemId: string,
  ): Promise<{
    versions: Array<{
      id: string; kind: string; statement: string; authority: number; validity: string;
      recordedByAgentId: string | null; recordedAt: string; proposedAt: string | null; rejectedAt: string | null;
      supersedesMemoryId: string | null; supersededByMemoryId: string | null;
    }>;
    transitions: Array<{
      id: string; memoryItemId: string; resultingMemoryId: string | null; outcome: string;
      newAuthority: number | null; actorKind: string; actorId: string | null; revision: string | null;
      note: string | null; createdAt: string;
    }>;
    contradictions: Array<{ setId: string; memoryItemIds: string[]; resolvedAt: string | null }>;
    feedback: Array<{ id: string; actorId: string; vote: string; kind: string | null; reason: string | null; createdAt: string }>;
  } | null> {
    await this.assertProjectId(projectId);
    const root = this.loadMemoryRow(memoryItemId);
    if (!root) return null;

    const MAX_CHAIN = 100;
    const ids = new Set<string>([memoryItemId]);
    const queue = [memoryItemId];
    while (queue.length && ids.size < MAX_CHAIN) {
      const cur = queue.shift()!;
      const row = this.ctx.storage.sql.exec<{ supersedes_memory_id: string | null }>(
        `SELECT supersedes_memory_id FROM memory_items WHERE id = ?1`, cur,
      ).toArray()[0];
      if (row?.supersedes_memory_id && !ids.has(row.supersedes_memory_id)) {
        ids.add(row.supersedes_memory_id);
        queue.push(row.supersedes_memory_id);
      }
      const children = this.ctx.storage.sql.exec<{ id: string }>(
        `SELECT id FROM memory_items WHERE supersedes_memory_id = ?1`, cur,
      ).toArray();
      for (const ch of children) {
        if (!ids.has(ch.id)) { ids.add(ch.id); queue.push(ch.id); }
      }
    }

    const idList = [...ids];
    const placeholders = idList.map((_, i) => `?${i + 1}`).join(',');
    const versionRows = this.ctx.storage.sql
      .exec<{
        id: string; kind: string; statement: string; authority: number; validity: string;
        recorded_by_agent_id: string | null; recorded_at: string; proposed_at: string | null;
        rejected_at: string | null; supersedes_memory_id: string | null;
      }>(
        // PLNR-323: `recorded_at` is millisecond-resolution and a supersession's original +
        // correction can be recorded back-to-back in the SAME millisecond under contention —
        // SQLite's tie-break for equal ORDER BY values is unspecified, so without `id` this
        // query alone was flaky. `id` (Crockford-ish: ms timestamp + RANDOM suffix, newId() in
        // lib/util.ts) makes the SQL order total and reproducible, but its suffix is random, not
        // a counter, so it does NOT reliably resolve ties in the "correct" (oldest-first)
        // direction — that correction happens below, from the supersession graph itself.
        `SELECT id, kind, statement, authority, validity, recorded_by_agent_id, recorded_at, proposed_at, rejected_at, supersedes_memory_id
         FROM memory_items WHERE id IN (${placeholders}) ORDER BY recorded_at, id`,
        ...idList,
      )
      .toArray();
    const supersededByOf = new Map<string, string>();
    for (const v of versionRows) if (v.supersedes_memory_id) supersededByOf.set(v.supersedes_memory_id, v.id);

    // Re-sort by chain depth (hops back to a "local root" — a version whose predecessor is
    // outside this result set, usually because it has none). Unlike a recorded_at tiebreak, this
    // is not a coin flip: a version can never have been recorded before what it supersedes, so
    // ordering by depth is STRUCTURALLY guaranteed oldest-first, immune to clock resolution
    // entirely — which is what "returns the whole chain, oldest first" actually needs. Only
    // versions at the SAME depth (independent corrections of the same parent — the schema
    // allows branching, though nothing in this codebase creates it today) fall back to the
    // recorded_at/id order already established above; a defensive `seen` guard means a
    // (should-never-happen) cycle in supersedes_memory_id degrades to that same fallback rather
    // than infinite-looping.
    const byId = new Map(versionRows.map((v) => [v.id, v]));
    const depthOf = new Map<string, number>();
    const chainDepth = (id: string, seen: Set<string>): number => {
      if (depthOf.has(id)) return depthOf.get(id)!;
      if (seen.has(id)) return 0;
      const parentId = byId.get(id)?.supersedes_memory_id;
      const parent = parentId ? byId.get(parentId) : undefined;
      const depth = parent ? chainDepth(parent.id, new Set(seen).add(id)) + 1 : 0;
      depthOf.set(id, depth);
      return depth;
    };
    for (const v of versionRows) chainDepth(v.id, new Set());
    versionRows.sort((a, b) =>
      (depthOf.get(a.id)! - depthOf.get(b.id)!) ||
      a.recorded_at.localeCompare(b.recorded_at) ||
      a.id.localeCompare(b.id),
    );

    const versions = versionRows.map((v) => ({
      id: v.id,
      kind: v.kind,
      statement: v.statement,
      authority: v.authority,
      validity: v.validity,
      recordedByAgentId: v.recorded_by_agent_id,
      recordedAt: v.recorded_at,
      proposedAt: v.proposed_at,
      rejectedAt: v.rejected_at,
      supersedesMemoryId: v.supersedes_memory_id,
      supersededByMemoryId: supersededByOf.get(v.id) ?? null,
    }));

    const transitions = this.ctx.storage.sql
      .exec<{
        id: string; memory_item_id: string; resulting_memory_id: string | null; outcome: string;
        new_authority: number | null; actor_kind: string; actor_id: string | null; revision: string | null;
        note: string | null; created_at: string;
      }>(
        // PLNR-312: `placeholders` is NUMBERED (`?1,…,?N`), so reusing the same string in both IN
        // clauses makes them read the SAME N bindings — bind `idList` ONCE. Passing it twice
        // supplies 2N bindings for N declared parameters and SQLite rejects the whole statement
        // with "Wrong number of parameter bindings for SQL query", which 500'd this endpoint for
        // every memory (even a single id with no chain: one `?1`, two bindings).
        // PLNR-323: same millisecond-tie hazard as the versions query above — add `id` so two
        // transitions logged in the same millisecond return in a fixed, reproducible order.
        `SELECT id, memory_item_id, resulting_memory_id, outcome, new_authority, actor_kind, actor_id, revision, note, created_at
         FROM memory_authority_transitions WHERE memory_item_id IN (${placeholders}) OR resulting_memory_id IN (${placeholders})
         ORDER BY created_at, id`,
        ...idList,
      )
      .toArray()
      .map((t) => ({
        id: t.id,
        memoryItemId: t.memory_item_id,
        resultingMemoryId: t.resulting_memory_id,
        outcome: t.outcome,
        newAuthority: t.new_authority,
        actorKind: t.actor_kind,
        actorId: t.actor_id,
        revision: t.revision,
        note: t.note,
        createdAt: t.created_at,
      }));

    const contradictionRows = this.ctx.storage.sql
      .exec<{ set_id: string }>(
        // Same numbered-placeholder rule as the transitions query above (PLNR-312): bind ONCE.
        `SELECT DISTINCT set_id FROM contradictions WHERE memory_item_id IN (${placeholders}) OR contradicts_memory_item_id IN (${placeholders})`,
        ...idList,
      )
      .toArray();
    const contradictions = await Promise.all(
      contradictionRows.map((r) => this.getContradictionSet(projectId, r.set_id)),
    );

    const feedback = this.ctx.storage.sql
      .exec<{ id: string; actor_id: string; vote: string; kind: string | null; reason: string | null; created_at: string }>(
        // PLNR-323: same millisecond-tie hazard — `id DESC` keeps two same-millisecond feedback
        // rows in a fixed, reproducible order (matching the primary column's DESC direction).
        `SELECT id, actor_id, vote, kind, reason, created_at FROM feedback WHERE memory_item_id = ?1 ORDER BY created_at DESC, id DESC`,
        memoryItemId,
      )
      .toArray()
      .map((f) => ({ id: f.id, actorId: f.actor_id, vote: f.vote, kind: f.kind, reason: f.reason, createdAt: f.created_at }));

    return { versions, transitions, contradictions, feedback };
  }

  // ---------------------------------------------------------------------------
  // Operational search integration (PLNR-255) — the two read RPCs search.ts's hydrate() and
  // keywordSearch() drive for memory/episode kinds. Both are read-only: no memory_revision
  // bump, no outbox row — a query is not a canonical mutation.
  // ---------------------------------------------------------------------------

  /** Fill display fields for memory/episode VECTOR matches — called once per distinct
   *  projectId a match set touches. Authority and validity are read from the canonical row
   *  HERE, at query time, never carried in vector metadata (§1/§12): a promotion or validity
   *  transition is visible immediately, with no re-index required. A ref for a row deleted
   *  since indexing (e.g. by decay) is silently absent from the result, same as D1 hydration. */
  async hydrateSearchHits(
    projectId: string,
    refs: Array<{ kind: 'memory' | 'episode'; id: string }>,
  ): Promise<Array<{ kind: 'memory' | 'episode'; id: string; title: string; snippet: string; status?: string; authority?: number; validity?: string }>> {
    await this.assertProjectId(projectId);
    const out: Array<{ kind: 'memory' | 'episode'; id: string; title: string; snippet: string; status?: string; authority?: number; validity?: string }> = [];
    const memIds = refs.filter((r) => r.kind === 'memory').map((r) => r.id);
    const epIds = refs.filter((r) => r.kind === 'episode').map((r) => r.id);
    if (memIds.length) {
      const rows = this.ctx.storage.sql
        .exec<{ id: string; kind: string; statement: string; authority: number; validity: string }>(
          `SELECT id, kind, statement, authority, validity FROM memory_items WHERE id IN (${memIds.map(() => '?').join(',')})`,
          ...memIds,
        )
        .toArray();
      for (const r of rows) out.push({ kind: 'memory', id: r.id, title: r.kind, snippet: r.statement.slice(0, 200), authority: r.authority, validity: r.validity });
    }
    if (epIds.length) {
      const rows = this.ctx.storage.sql
        .exec<{ id: string; run_id: string; landing_outcome: string; body: string }>(
          `SELECT id, run_id, landing_outcome, body FROM episodes WHERE id IN (${epIds.map(() => '?').join(',')})`,
          ...epIds,
        )
        .toArray();
      for (const r of rows) {
        out.push({
          kind: 'episode',
          id: r.id,
          title: `episode ${r.run_id} (${r.landing_outcome})`,
          snippet: summarizeEpisodeBody(r.body).slice(0, 200),
          status: r.landing_outcome,
        });
      }
    }
    return out;
  }

  /** The no-Vectorize lexical fallback (§20) — memory content never reaches D1 (§3/§4), so this
   *  LIKE scan runs INSIDE ProjectMemory rather than as a D1 query, and search.ts's
   *  keywordSearch merges it with the D1 task/doc/plan results. Same AND-every-term contract as
   *  the D1 scan; score mirrors its (matched+1)/(terms+1) shape (every returned row matched
   *  every term, so this is always 1 — ties break on recency). */
  async searchMemoryLexical(
    projectId: string,
    opts: { q: string; kinds?: Array<'memory' | 'episode'>; limit?: number },
  ): Promise<Array<{ kind: 'memory' | 'episode'; id: string; title: string; snippet: string; score: number; status?: string; authority?: number; validity?: string }>> {
    await this.assertProjectId(projectId);
    const limit = opts.limit ?? 12;
    const kinds = opts.kinds?.length ? opts.kinds : (['memory', 'episode'] as const);
    const terms = opts.q.replace(/[%_]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!terms.length) return [];
    const likes = terms.map((t) => `%${t}%`);
    const hits: Array<{ kind: 'memory' | 'episode'; id: string; title: string; snippet: string; score: number; status?: string; authority?: number; validity?: string }> = [];
    if (kinds.includes('memory')) {
      const where = likes.map(() => `statement LIKE ?`).join(' AND ');
      const rows = this.ctx.storage.sql
        .exec<{ id: string; kind: string; statement: string; authority: number; validity: string }>(
          `SELECT id, kind, statement, authority, validity FROM memory_items WHERE ${where} ORDER BY recorded_at DESC LIMIT ${limit}`,
          ...likes,
        )
        .toArray();
      for (const r of rows) hits.push({ kind: 'memory', id: r.id, title: r.kind, snippet: r.statement.slice(0, 200), score: 1, authority: r.authority, validity: r.validity });
    }
    if (kinds.includes('episode')) {
      const where = likes.map(() => `body LIKE ?`).join(' AND ');
      const rows = this.ctx.storage.sql
        .exec<{ id: string; run_id: string; landing_outcome: string; body: string }>(
          `SELECT id, run_id, landing_outcome, body FROM episodes WHERE ${where} ORDER BY created_at DESC LIMIT ${limit}`,
          ...likes,
        )
        .toArray();
      for (const r of rows) {
        hits.push({
          kind: 'episode',
          id: r.id,
          title: `episode ${r.run_id} (${r.landing_outcome})`,
          snippet: summarizeEpisodeBody(r.body).slice(0, 200),
          score: 1,
          status: r.landing_outcome,
        });
      }
    }
    return hits.slice(0, limit);
  }

  // ---------------------------------------------------------------------------
  // Hybrid retrieval (PLNR-257) — exact lookup, lexical scan, semantic candidates, and bounded
  // graph expansion, combined and reranked by memory/retrieval.ts (which never opens storage;
  // this class supplies the rows). Read-only: no memory_revision bump, no outbox row, no
  // applied_operations entry — a query is not a canonical mutation (§4).
  // ---------------------------------------------------------------------------

  /** Both halves PLNR-265's base-scoped lead reason needs, from ONE query: each citation's raw
   *  `verification_state` (unchanged contract) and, index-aligned, whether that SAME citation is
   *  `verifiedForBase` for `caller` — the retrieval-time answer to "is this verified for the
   *  branch/base THIS caller asked about", not just "was it ever found valid". */
  private evidenceVerificationInfo(memoryItemId: string, caller: CallerBaseScope): { states: string[]; verifiedForCaller: Array<boolean | null> } {
    const rows = this.ctx.storage.sql
      .exec<{ verification_state: string; last_verified_base_id: string | null; last_verified_branch: string | null }>(
        `SELECT verification_state, last_verified_base_id, last_verified_branch FROM evidence WHERE memory_item_id = ?1 ORDER BY created_at`,
        memoryItemId,
      )
      .toArray();
    return {
      states: rows.map((r) => r.verification_state),
      verifiedForCaller: rows.map((r) => caller.baseId == null && caller.branch == null
        ? null
        : verifiedForBase({ verificationState: r.verification_state, lastVerifiedBaseId: r.last_verified_base_id, lastVerifiedBranch: r.last_verified_branch }, caller)),
    };
  }

  private memoryRowToHit(
    row: { id: string; kind: string; statement: string; authority: number; validity: string; repository_key: string | null; branch: string | null },
    stage: RetrievalStage,
    score: number,
    caller: CallerBaseScope = {},
  ): RetrievalHit {
    const { states, verifiedForCaller } = this.evidenceVerificationInfo(row.id, caller);
    return {
      entityType: 'memory',
      id: row.id,
      // PLNR-283: now that `recordMemory` writes every memory's own graph node, its hit carries
      // the SAME uri that node was written under — the join key PLNR-284's constellation and
      // PLNR-286's search-to-star-map wiring both depend on (§18: "a search hit and a rendered
      // node refer to the same entity by uri equality").
      uri: buildEntityUri({ kind: 'memory', id: row.id }),
      kind: row.kind,
      title: row.kind,
      snippet: row.statement.slice(0, 200),
      stage,
      score,
      repositoryKey: row.repository_key,
      branch: row.branch,
      authority: row.authority,
      validity: row.validity,
      evidenceVerification: states,
      evidenceVerifiedForCaller: verifiedForCaller,
    };
  }

  private episodeRowToHit(
    row: { id: string; run_id: string; repository_key: string | null; landing_outcome: string; body: string },
    stage: RetrievalStage,
    score: number,
  ): RetrievalHit {
    return {
      entityType: 'episode',
      id: row.id,
      // PLNR-283: episodes have carried a graph node since PLNR-263 (`recordEpisode`'s own
      // `episode` node) — parity was simply never wired into retrieval hits. Same join-key
      // reasoning as the memory hit above.
      uri: buildEntityUri({ kind: 'episode', id: row.id }),
      title: `episode ${row.run_id} (${row.landing_outcome})`,
      snippet: summarizeEpisodeBody(row.body).slice(0, 200),
      stage,
      score,
      repositoryKey: row.repository_key,
      status: row.landing_outcome,
    };
  }

  /** Exact-id lookup for a single memory item — the 'exact' stage. */
  private lookupMemoryHit(memoryItemId: string, caller: CallerBaseScope = {}): RetrievalHit | null {
    const row = this.ctx.storage.sql
      .exec<{ id: string; kind: string; statement: string; authority: number; validity: string; repository_key: string | null; branch: string | null }>(
        `SELECT id, kind, statement, authority, validity, repository_key, branch FROM memory_items WHERE id = ?1`,
        memoryItemId,
      )
      .toArray()[0];
    return row ? this.memoryRowToHit(row, 'exact', 1, caller) : null;
  }

  /** Exact-id lookup for a single episode — the 'exact' stage. */
  private lookupEpisodeHit(episodeId: string): RetrievalHit | null {
    const row = this.ctx.storage.sql
      .exec<{ id: string; run_id: string; repository_key: string | null; landing_outcome: string; body: string }>(
        `SELECT id, run_id, repository_key, landing_outcome, body FROM episodes WHERE id = ?1`,
        episodeId,
      )
      .toArray()[0];
    return row ? this.episodeRowToHit(row, 'exact', 1) : null;
  }

  /** Term-wise LIKE scan over memory_items AND episodes, same AND-every-term contract as
   *  search.ts's keyword fallback — the 'lexical' stage, always available (§20). */
  private lexicalRetrievalRows(q: string, opts: { kind?: string; limit: number }, caller: CallerBaseScope = {}): RetrievalHit[] {
    const terms = q.replace(/[%_]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!terms.length) return [];
    const likes = terms.map((t) => `%${t}%`);
    const hits: RetrievalHit[] = [];

    const memWhere = likes.map(() => `statement LIKE ?`).join(' AND ');
    const memBinds: unknown[] = [...likes];
    let memKindFilter = '';
    if (opts.kind) {
      memKindFilter = `AND kind = ?${memBinds.length + 1}`;
      memBinds.push(opts.kind);
    }
    const memRows = this.ctx.storage.sql
      .exec<{ id: string; kind: string; statement: string; authority: number; validity: string; repository_key: string | null; branch: string | null }>(
        `SELECT id, kind, statement, authority, validity, repository_key, branch FROM memory_items WHERE ${memWhere} ${memKindFilter} ORDER BY recorded_at DESC LIMIT ${opts.limit}`,
        ...memBinds,
      )
      .toArray();
    for (const r of memRows) hits.push(this.memoryRowToHit(r, 'lexical', 1, caller));

    const epWhere = likes.map(() => `body LIKE ?`).join(' AND ');
    const epRows = this.ctx.storage.sql
      .exec<{ id: string; run_id: string; repository_key: string | null; landing_outcome: string; body: string }>(
        `SELECT id, run_id, repository_key, landing_outcome, body FROM episodes WHERE ${epWhere} ORDER BY created_at DESC LIMIT ${opts.limit}`,
        ...likes,
      )
      .toArray();
    for (const r of epRows) hits.push(this.episodeRowToHit(r, 'lexical', 1));

    return hits;
  }

  /** Semantic candidates over the operational index (PLNR-255's vectors), hydrated from the
   *  CANONICAL row here rather than trusted from vector metadata — the 'semantic' stage. Null
   *  when no embeddings backend is bound (§20 — caller falls back to exact+lexical+graph). */
  private async semanticRetrievalRows(projectId: string, q: string, limit: number, caller: CallerBaseScope = {}): Promise<RetrievalHit[]> {
    const backend = searchBackend(this.env);
    if (!backend) return [];
    const [vector] = await backend.embedder.embed([q]);
    if (!vector) return [];
    // PLNR-281: a THIRD call site sharing search.ts's exact bug shape — this is what
    // search_project_memory's/get_task_context's default limits actually run through
    // (searchProjectMemory/similarEffort both call this method), so it is fixed here too even
    // though it isn't one of the two call sites the original bug report named. Clamp the
    // PRODUCT via the shared helper — see search.ts's clampMetadataTopK doc comment.
    const { matches } = await backend.store.query(vector, { topK: clampMetadataTopK(limit * 5), filter: { projectId: { $eq: projectId } } });
    const hits: RetrievalHit[] = [];
    for (const m of matches) {
      const kind = String(m.id).split(':')[0];
      // Belt-and-suspenders project check, matching search.ts's own isolation contract — the
      // server-side filter above already scopes the query, this guards a filter that silently
      // failed to apply.
      if (String(m.metadata?.projectId ?? '') !== projectId) continue;
      if (kind === 'memory') {
        const entityId = (m.metadata?.entityId as string) ?? String(m.id).slice('memory:'.length);
        const hit = this.lookupMemoryHit(entityId, caller);
        if (hit) hits.push({ ...hit, stage: 'semantic', score: m.score });
      } else if (kind === 'episode') {
        const entityId = (m.metadata?.entityId as string) ?? String(m.id).slice('episode:'.length);
        const hit = this.lookupEpisodeHit(entityId);
        if (hit) hits.push({ ...hit, stage: 'semantic', score: m.score });
      }
    }
    return hits;
  }

  /** Bounded recursive-CTE traversal from a seed node set (this is the FIRST use of
   *  WITH RECURSIVE against Durable Object SQLite in this repo, rather than D1 — verified to
   *  execute here by memory-retrieval.test.ts). Depth is capped structurally
   *  (`WHERE depth < maxDepth` bounds the recursion itself, not just the output) and the
   *  final row count is capped by `maxResults` — both from named constants, never a literal at
   *  the call site. Deduped in JS by nodeId, keeping the SHALLOWEST occurrence (`ORDER BY depth
   *  ASC` guarantees the first-seen row per id is the shortest path). */
  /**
   * Bounded recursive-CTE traversal, `direction`-aware (PLNR-258 grows PLNR-257's
   * forward-only original into both directions): 'downstream' follows `from_node_id → to_node_id`
   * (what this node points AT); 'upstream' follows the SAME edges backward, `to_node_id →
   * from_node_id` (what points AT this node) — the recorded edge path always shows the edge's
   * REAL direction regardless of which way it was walked. Fetches one row past `maxResults` to
   * report `truncated` honestly (a bounded result may not be the whole neighborhood) rather than
   * guessing from a suspiciously-round row count.
   */
  private rawTraverseGraph(
    seedNodeIds: string[],
    opts: { edgeTypes?: string[]; maxDepth?: number; maxResults?: number; direction?: 'downstream' | 'upstream' },
  ): { rows: Array<{ nodeId: string; uri: string; type: string; label: string; depth: number; edgePath: string }>; truncated: boolean } {
    if (!seedNodeIds.length) return { rows: [], truncated: false };
    const maxDepth = Math.min(Math.max(opts.maxDepth ?? RETRIEVAL_DEFAULTS.maxDepth, 1), RETRIEVAL_DEFAULTS.maxDepthCeiling);
    const maxResults = Math.min(Math.max(opts.maxResults ?? RETRIEVAL_DEFAULTS.maxGraphResults, 1), RETRIEVAL_DEFAULTS.maxGraphResultsCeiling);
    const [startCol, nextCol] = (opts.direction ?? 'downstream') === 'downstream' ? ['from_node_id', 'to_node_id'] : ['to_node_id', 'from_node_id'];

    const binds: unknown[] = [...seedNodeIds];
    const seedPlaceholders = seedNodeIds.map((_, i) => `?${i + 1}`).join(',');
    let edgeFilterSql = '';
    if (opts.edgeTypes?.length) {
      const start = binds.length + 1;
      edgeFilterSql = `AND e.type IN (${opts.edgeTypes.map((_, i) => `?${start + i}`).join(',')})`;
      binds.push(...opts.edgeTypes);
    }
    const depthPh = binds.length + 1;
    binds.push(maxDepth);
    const expansionLimitPh = binds.length + 1;
    binds.push(RETRIEVAL_DEFAULTS.maxGraphExpansionRows);
    const limitPh = binds.length + 1;
    binds.push(maxResults + 1); // +1 so truncation is detected, not guessed

    const rows = this.ctx.storage.sql
      .exec<{ nodeId: string; uri: string; type: string; label: string; depth: number; edgePath: string; reachCount: number }>(
        `WITH RECURSIVE reach(node_id, depth, path) AS (
           SELECT id, 0, '' FROM nodes WHERE id IN (${seedPlaceholders})
           UNION
           SELECT e.${nextCol}, r.depth + 1,
                  CASE WHEN r.path = '' THEN (e.from_node_id || '>' || e.type || '>' || e.to_node_id)
                       ELSE (r.path || ';' || e.from_node_id || '>' || e.type || '>' || e.to_node_id) END
           FROM reach r JOIN edges e ON e.${startCol} = r.node_id
           WHERE r.depth < ?${depthPh} ${edgeFilterSql}
           LIMIT ?${expansionLimitPh}
         )
         SELECT n.id AS nodeId, n.uri AS uri, n.type AS type, n.label AS label, reach.depth AS depth,
                reach.path AS edgePath, COUNT(*) OVER () AS reachCount
         FROM reach JOIN nodes n ON n.id = reach.node_id
         WHERE reach.depth > 0
         ORDER BY reach.depth ASC
         LIMIT ?${limitPh}`,
        ...binds,
      )
      .toArray();

    // `LIMIT` on the recursive SELECT bounds work done while populating the CTE. The window
    // count is evaluated before the final result limit, so reaching that ceiling remains
    // visible to callers as incomplete coverage even when duplicate paths dedupe below the
    // requested result count.
    const recursiveRows = rows[0]?.reachCount ?? 0;
    const recursiveBudgetReached = recursiveRows >= RETRIEVAL_DEFAULTS.maxGraphExpansionRows - seedNodeIds.length;
    const truncated = rows.length > maxResults || recursiveBudgetReached;
    const seen = new Set<string>();
    const deduped: typeof rows = [];
    for (const r of rows.slice(0, maxResults)) {
      if (seen.has(r.nodeId)) continue;
      seen.add(r.nodeId);
      deduped.push(r);
    }
    return { rows: deduped, truncated };
  }

  /** The general graph-traversal read API (replaces the old `_traverseFrom` test shim — this
   *  IS the general query surface it was deliberately narrow to avoid preempting). Bounded
   *  multi-hop expansion from one or more seed nodes, each hit carrying the edge path back to
   *  its seed. */
  async traverseGraph(
    projectId: string,
    input: { seedNodeIds: string[]; edgeTypes?: string[]; maxDepth?: number; maxResults?: number },
  ): Promise<Array<{ nodeId: string; uri: string; type: string; label: string; depth: number; edgePath: string }>> {
    await this.assertProjectId(projectId);
    return this.rawTraverseGraph(input.seedNodeIds, input).rows;
  }

  /** Resolve one node by its stable entity URI — the seed-lookup every PLNR-258 primitive
   *  starts from. Null when the URI has no matching node (e.g. a file/symbol URI before
   *  Phase 5's ingest has ever run). */
  private resolveNodeByUri(uri: string): { nodeId: string; uri: string; type: string; label: string } | null {
    const row = this.ctx.storage.sql
      .exec<{ id: string; uri: string; type: string; label: string }>(`SELECT id, uri, type, label FROM nodes WHERE uri = ?1`, uri)
      .toArray()[0];
    return row ? { nodeId: row.id, uri: row.uri, type: row.type, label: row.label } : null;
  }

  /** Which of `candidateTypes` have NEVER been written as an edge anywhere in this project —
   *  the concrete "why" behind a completeness marker of 'no-writer-yet' (PLNR-258 §2: absence
   *  of an edge is never evidence of absence of the relationship when nothing writes that edge
   *  type at all yet). */
  private edgeTypesWithNoWriter(candidateTypes: string[]): string[] {
    if (!candidateTypes.length) return [];
    const placeholders = candidateTypes.map((_, i) => `?${i + 1}`).join(',');
    const present = new Set(
      this.ctx.storage.sql
        .exec<{ type: string }>(`SELECT DISTINCT type FROM edges WHERE type IN (${placeholders})`, ...candidateTypes)
        .toArray()
        .map((r) => r.type),
    );
    return candidateTypes.filter((t) => !present.has(t));
  }

  /** True once this project's graph holds at least one node beyond coordination's own 'task'
   *  type — i.e. Phase 5/6 ingest has populated something. Always false today (the projector is
   *  the only node writer in src/), which is exactly what makes every PLNR-258 primitive's
   *  completeness marker honest rather than a formality. */
  private isCodeGraphPopulated(): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM nodes WHERE type IN ('file', 'symbol', 'api', 'test', 'database_entity')`,
        )
        .toArray()[0]?.n ?? 0
    ) > 0;
  }

  /**
   * The hybrid retrieval entry point (§10): exact lookup + lexical scan + semantic candidates
   * + bounded graph expansion, filtered (repository/branch/kind/authority/validity), reranked,
   * and lead-labelled by memory/retrieval.ts. `taskId`/`seedEntityUri` seed graph expansion —
   * "what does the project know connected to this task/entity" — rather than acting as a
   * post-hoc filter. Cross-project leakage is guarded at the semantic stage (the shared
   * multi-project vector index is the one real leak surface — see the stage's own project
   * check) and is structurally impossible at the lexical/exact/graph stages (this DO instance
   * IS one project). Read-only throughout.
   */
  async searchProjectMemory(
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
      /** Hard filter: only return memories scoped to this branch (or unscoped memories). */
      branch?: string;
      /** The caller's current branch. Unlike `branch`, this only reranks cross-branch memories
       *  lower and scopes citation verification; it never excludes them. */
      preferBranch?: string;
      /** The caller's own opaque VCS revision (PLNR-265, §6) — string-compared only, never
       *  parsed. Purely a verification-scoping input: unlike `branch`, a `baseId` mismatch never
       *  excludes or reranks a candidate — it only stops a 'valid' citation checked against a
       *  DIFFERENT base from reading as verified FOR this caller (`classifyLead`'s
       *  `evidence-base-mismatch`). */
      baseId?: string;
      kind?: string;
      minAuthority?: number;
      validity?: string;
      limit?: number;
    },
  ): Promise<{ mode: 'semantic' | 'keyword'; results: RankedHit[] }> {
    await this.assertProjectId(projectId);
    const limit = Math.min(Math.max(opts.limit ?? RETRIEVAL_DEFAULTS.maxResults, 1), RETRIEVAL_DEFAULTS.maxResultsCeiling);
    // `branch` remains backward-compatible as a caller scope when a direct filtered search does
    // not also provide `preferBranch`. Context-pack assembly supplies only `preferBranch`, which
    // is the important distinction: its caller branch affects verification/ranking but cannot
    // hide knowledge recorded on another branch.
    const caller: CallerBaseScope = { baseId: opts.baseId ?? null, branch: opts.preferBranch ?? opts.branch ?? null };
    const candidates: RetrievalHit[] = [];
    let mode: 'semantic' | 'keyword' = 'keyword';

    if (opts.memoryItemId) {
      const hit = this.lookupMemoryHit(opts.memoryItemId, caller);
      if (hit) candidates.push(hit);
    }
    if (opts.episodeId) {
      const hit = this.lookupEpisodeHit(opts.episodeId);
      if (hit) candidates.push(hit);
    }

    if (opts.query?.trim()) {
      candidates.push(...this.lexicalRetrievalRows(opts.query, { kind: opts.kind, limit }, caller));
      const semanticHits = await this.semanticRetrievalRows(projectId, opts.query, limit, caller);
      if (semanticHits.length || searchBackend(this.env)) mode = 'semantic';
      candidates.push(...semanticHits);
    }

    const seedNodeIds: string[] = [];
    const resolveSeed = (uri: string) => this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE uri = ?1`, uri).toArray()[0]?.id;
    if (opts.taskId) {
      const id = resolveSeed(buildEntityUri({ kind: 'task', id: opts.taskId }));
      if (id) seedNodeIds.push(id);
    }
    if (opts.seedEntityUri) {
      const id = resolveSeed(opts.seedEntityUri);
      if (id) seedNodeIds.push(id);
    }
    if (seedNodeIds.length) {
      const graphRows = this.rawTraverseGraph(seedNodeIds, { edgeTypes: opts.edgeTypes, maxDepth: opts.maxDepth, maxResults: RETRIEVAL_DEFAULTS.maxGraphResults }).rows;
      for (const g of graphRows) {
        candidates.push({
          entityType: 'node',
          id: g.nodeId,
          uri: g.uri,
          kind: g.type,
          title: g.label,
          snippet: g.label,
          stage: 'graph',
          score: 1 / (1 + g.depth),
          seedNodeId: seedNodeIds[0],
          edgePath: g.edgePath,
          depth: g.depth,
        });
      }
    }

    // PLNR-282: collapse a candidate matched by more than one stage (or an explicit
    // memoryItemId/episodeId that ALSO matches `query`) into one, BEFORE filtering/ranking — see
    // dedupeCandidates' own doc comment for why order matters. Without this, `rankCandidates`
    // saw two entries for one memory and both survived into `limit`, each numbered separately by
    // evidenceFrame as if they were independent corroborating items.
    const deduped = dedupeCandidates(candidates);
    const filtered = applyMemoryFilters(deduped, {
      repositoryKey: opts.repositoryKey,
      branch: opts.branch,
      kind: opts.kind,
      minAuthority: opts.minAuthority,
      validity: opts.validity,
    });
    const results = rankCandidates(filtered, { limit, preferBranch: opts.preferBranch });
    return { mode, results };
  }

  /**
   * PLNR-264: has this task's likely area of work already been attempted? Gathers episode
   * candidates the SAME way `searchProjectMemory` does — `lexicalRetrievalRows` +
   * `semanticRetrievalRows` over the task's own title/body, plus bounded graph expansion from
   * the task's own node when one already exists (an earlier episode/memory linked it) — then
   * hands them to `memory/similar-effort.ts`'s pure classifier/gate/summarizer rather than
   * forking a second ranking pipeline. Read-only throughout (locked decision): no row written,
   * no validity transition, no outbox event. Callers (`can_claim`/`claim_task` in mcp.ts) call
   * this AFTER ProjectRoom returns and swallow a failure into "no priorEffort block" — never let
   * it touch the claim itself (§19).
   */
  async similarEffort(
    projectId: string,
    input: TaskEffortInput & {
      taskId: string; limit?: number; repositoryKey?: string;
      branch?: string; preferBranch?: string; baseId?: string;
      cursor?: string; includeCrossBranch?: boolean; includeStaleEvidence?: boolean;
    },
  ): Promise<{
    warnings: DuplicateWarning[]; cases: PriorEffortCase[]; summary: EffortSummary; consideredCount: number;
    page: { limit: number; offset: number; total: number; nextCursor: string | null };
    coverage: { complete: boolean; candidatesConsidered: number; eligibleCases: number; reasons: string[] };
  }> {
    await this.assertProjectId(projectId);
    const pageLimit = Math.min(Math.max(input.limit ?? RETRIEVAL_DEFAULTS.maxResults, 1), RETRIEVAL_DEFAULTS.maxResultsCeiling);
    const candidateLimit = RETRIEVAL_DEFAULTS.maxResultsCeiling;
    const signals = effortSignals(input);

    // episodeId -> best-known provenance across every stage that found it. A graph hit's
    // edgePath is never discarded in favor of a later text hit — it is the ONLY source of the
    // graph-neighborhood/shared-decision support kinds (memory/similar-effort.ts) — otherwise
    // the higher raw score wins.
    //
    // PLNR-282: this is the same rule `memory/retrieval.ts`'s `dedupeCandidates` now applies for
    // `searchProjectMemory`, deliberately NOT consolidated here (discretion, not an oversight):
    // this map is keyed on bare episode id with `entityType` assumed constant, and its graph rows
    // are pre-resolved to the episode's OWN id via `parseEntityUri` before `consider` ever sees
    // them — a shape `dedupeCandidates`'s `RetrievalHit[]` (graph hits carry a synthetic node id
    // in `entityType: 'node'`) doesn't accept without first re-deriving that resolution here
    // anyway. Two call sites implementing one documented rule beats forcing a shape mismatch.
    const provenance = new Map<string, { stage: RetrievalStage; score: number; edgePath?: string }>();
    const retrievalCoverageReasons: string[] = [];
    const consider = (id: string, stage: RetrievalStage, score: number, edgePath?: string) => {
      const prev = provenance.get(id);
      if (!prev) { provenance.set(id, { stage, score, edgePath }); return; }
      if (edgePath && !prev.edgePath) { provenance.set(id, { stage, score: Math.max(prev.score, score), edgePath }); return; }
      if (score > prev.score) provenance.set(id, { ...prev, score });
    };

    if (signals.queryText.trim()) {
      const lexicalHits = this.lexicalRetrievalRows(signals.queryText, { limit: candidateLimit });
      if (lexicalHits.length >= candidateLimit) retrievalCoverageReasons.push('lexical candidate scan reached its bounded ceiling');
      for (const hit of lexicalHits) {
        if (hit.entityType === 'episode') consider(hit.id, hit.stage, hit.score);
      }
      const semanticHits = await this.semanticRetrievalRows(projectId, signals.queryText, candidateLimit);
      if (semanticHits.length >= candidateLimit) retrievalCoverageReasons.push('semantic candidate scan reached its bounded ceiling');
      for (const hit of semanticHits) {
        if (hit.entityType === 'episode') consider(hit.id, hit.stage, hit.score);
      }
    }
    // Graph expansion seeded at the TASK's own node — reachable only once something has already
    // linked this task into the graph (recordEpisode's own related_to edge, most commonly). A
    // brand-new task with no prior episode of its own simply contributes no graph candidates,
    // same "absence is not an error" posture as the rest of this file.
    const taskNode = this.resolveNodeByUri(buildEntityUri({ kind: 'task', id: input.taskId }));
    if (taskNode) {
      const seedIds = [taskNode.nodeId];
      const graphOpts = { maxResults: RETRIEVAL_DEFAULTS.maxGraphResults };
      const down = this.rawTraverseGraph(seedIds, { ...graphOpts, direction: 'downstream' });
      const up = this.rawTraverseGraph(seedIds, { ...graphOpts, direction: 'upstream' });
      if (down.truncated || up.truncated) retrievalCoverageReasons.push('graph candidate traversal reached its bounded ceiling');
      const rows = [...down.rows, ...up.rows];
      for (const row of rows) {
        if (row.type !== 'episode') continue;
        const ref = parseEntityUri(row.uri);
        if (ref.kind === 'episode') consider(ref.id, 'graph', 1 / (1 + row.depth), row.edgePath);
      }
    }

    const episodeIds = [...provenance.keys()];
    if (!episodeIds.length) return {
      warnings: [], cases: [], summary: summarizeEffort([]), consideredCount: 0,
      page: { limit: pageLimit, offset: 0, total: 0, nextCursor: null },
      coverage: { complete: true, candidatesConsidered: 0, eligibleCases: 0, reasons: [] },
    };

    const placeholders = episodeIds.map((_, i) => `?${i + 1}`).join(',');
    const rows = this.ctx.storage.sql
      .exec<{
        id: string; run_id: string; sitting: number; task_id: string | null; repository_key: string | null;
        base_id: string | null; landing_outcome: string; review_rounds: number; created_at: string;
        cost_usd: number; body: string; run_kind: string | null; outcome: string | null;
        started_at: string | null; finished_at: string | null;
      }>(
        `SELECT id, run_id, sitting, task_id, repository_key, base_id, landing_outcome, review_rounds,
                cost_usd, body, run_kind, outcome, started_at, finished_at, created_at
         FROM episodes WHERE id IN (${placeholders})`,
        ...episodeIds,
      )
      .toArray();

    // Batch-resolve display keys for each candidate's anchor task — ProjectMemory holds no task
    // rows of its own (coordination lives in D1); the same "plain D1 read, not a coordination
    // mutation" precedent `resolveProjectKey` already sets.
    const taskIds = [...new Set(rows.map((r) => r.task_id).filter((t): t is string => !!t))];
    const taskKeyById = new Map<string, string>();
    if (taskIds.length) {
      const tphs = taskIds.map((_, i) => `?${i + 1}`).join(',');
      const { results } = await this.env.DB.prepare(`SELECT id, key FROM tasks WHERE id IN (${tphs})`).bind(...taskIds).all<{ id: string; key: string }>();
      for (const r of results) taskKeyById.set(r.id, r.key);
    }

    const candidates: EffortCandidate[] = rows.map((row) => {
      // Same tolerance `summarizeEpisodeBody` already applies — an unreadable body degrades to
      // empty fields rather than dropping the candidate (its deterministic columns are still
      // real evidence: run id, task, landing outcome, cost, review rounds).
      let body: Partial<EffortEpisode> = {};
      try { body = EffortEpisode.parse(JSON.parse(row.body)); } catch { /* degrade to empty fields below */ }
      const prov = provenance.get(row.id)!;
      return {
        episodeId: row.id,
        runId: row.run_id,
        taskId: row.task_id,
        taskKey: row.task_id ? (taskKeyById.get(row.task_id) ?? null) : null,
        runKind: row.run_kind ?? 'build',
        outcome: row.outcome ?? 'done',
        landingOutcome: (row.landing_outcome as EpisodeLandingOutcome) ?? 'pending',
        filesTouched: body.filesTouched ?? [],
        failures: body.failures ?? [],
        findings: body.findings ?? [],
        approachSummary: body.selfSummary?.approachSummary || null,
        unresolvedQuestions: body.selfSummary?.unresolvedQuestions ?? [],
        reviewRounds: row.review_rounds,
        costUSD: row.cost_usd,
        tokenUsage: body.tokenUsage ?? {},
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        stage: prov.stage,
        score: prov.score,
        edgePath: prov.edgePath,
        sitting: row.sitting,
        repositoryKey: row.repository_key,
        baseId: row.base_id,
        createdAt: row.created_at,
        intelligence: body.intelligence ?? null,
      };
    });

    // Current memory validity/authority stays distinct from the quoted historical episode.
    // Resolve the bounded episode -> memory graph links in bulk, then read each memory's live
    // authority/validity and citation scope. This never rewrites the episode or treats current
    // task text as historical evidence.
    const candidateById = new Map(candidates.map((candidate) => [candidate.episodeId, candidate]));
    const episodeUris = candidates.map((candidate) => buildEntityUri({ kind: 'episode', id: candidate.episodeId }));
    const episodeNodeByUri = new Map<string, string>();
    if (episodeUris.length) {
      const ephs = episodeUris.map((_, i) => `?${i + 1}`).join(',');
      for (const node of this.ctx.storage.sql.exec<{ id: string; uri: string }>(
        `SELECT id, uri FROM nodes WHERE uri IN (${ephs})`, ...episodeUris,
      ).toArray()) episodeNodeByUri.set(node.uri, node.id);
    }
    const nodeToEpisode = new Map([...episodeNodeByUri.entries()].map(([uri, id]) => {
      const ref = parseEntityUri(uri);
      return [id, ref.kind === 'episode' ? ref.id : ''] as const;
    }));
    const episodeNodeIds = [...nodeToEpisode.keys()];
    const supportEdgeLimit = 2_000;
    const supportEdges = episodeNodeIds.length ? this.ctx.storage.sql.exec<{
      episode_node_id: string; memory_uri: string;
    }>(
      `SELECT e.from_node_id AS episode_node_id, m.uri AS memory_uri
         FROM edges e JOIN nodes m ON m.id = e.to_node_id
        WHERE e.type = 'related_to' AND m.type = 'memory'
          AND e.from_node_id IN (${episodeNodeIds.map((_, i) => `?${i + 1}`).join(',')})
        ORDER BY e.from_node_id, m.uri LIMIT ${supportEdgeLimit + 1}`,
      ...episodeNodeIds,
    ).toArray() : [];
    const supportTruncated = supportEdges.length > supportEdgeLimit;
    const usableSupportEdges = supportEdges.slice(0, supportEdgeLimit);
    const supportMemoryIds = [...new Set(usableSupportEdges.map((edge) => {
      const ref = parseEntityUri(edge.memory_uri);
      return ref.kind === 'memory' ? ref.id : null;
    }).filter((id): id is string => !!id))];
    const supportById = new Map<string, PriorEffortMemorySupport>();
    if (supportMemoryIds.length) {
      const mphs = supportMemoryIds.map((_, i) => `?${i + 1}`).join(',');
      const memoryRows = this.ctx.storage.sql.exec<{
        id: string; kind: string; authority: number; validity: 'active' | 'stale' | 'invalid';
        repository_key: string | null; branch: string | null; base_id: string | null;
      }>(
        `SELECT m.id, m.kind, m.authority, m.validity,
                e.repository_key, e.branch, e.base_id
           FROM memory_items m LEFT JOIN evidence e ON e.memory_item_id = m.id
          WHERE m.id IN (${mphs})
          ORDER BY m.id,
            CASE WHEN e.branch IS ?${supportMemoryIds.length + 1} THEN 0 ELSE 1 END,
            CASE WHEN e.base_id IS ?${supportMemoryIds.length + 2} THEN 0 ELSE 1 END,
            e.id`,
        ...supportMemoryIds, input.branch ?? null, input.baseId ?? null,
      ).toArray();
      for (const row of memoryRows) if (!supportById.has(row.id)) supportById.set(row.id, {
        memoryId: row.id, kind: row.kind, authority: row.authority, validity: row.validity,
        repositoryKey: row.repository_key, branch: row.branch, baseId: row.base_id,
      });
    }
    for (const edge of usableSupportEdges) {
      const episodeId = nodeToEpisode.get(edge.episode_node_id);
      const ref = parseEntityUri(edge.memory_uri);
      const support = ref.kind === 'memory' ? supportById.get(ref.id) : null;
      const candidate = episodeId ? candidateById.get(episodeId) : null;
      if (candidate && support && !(candidate.supportingMemories ?? []).some((item) => item.memoryId === support.memoryId)) {
        candidate.supportingMemories = [...(candidate.supportingMemories ?? []), support];
      }
    }

    const eligibleCandidates = candidates.filter((candidate) => {
      const repositoryKey = candidate.intelligence?.identity.repositoryKey ?? candidate.repositoryKey ?? null;
      const branch = candidate.intelligence?.identity.branch ?? null;
      const baseId = candidate.intelligence?.identity.baseId ?? candidate.baseId ?? null;
      const currentSupport = candidate.supportingMemories ?? [];
      const onlyStaleSupport = currentSupport.length > 0 && currentSupport.every((memory) => memory.validity !== 'active');
      return (!input.repositoryKey || repositoryKey == null || repositoryKey === input.repositoryKey)
        && (!input.branch || branch == null || branch === input.branch || input.includeCrossBranch === true)
        && (!input.baseId || baseId == null || baseId === input.baseId)
        && (!onlyStaleSupport || input.includeStaleEvidence === true);
    });
    const allWarnings = duplicateWarnings(eligibleCandidates, signals, {
      limit: RETRIEVAL_DEFAULTS.maxResultsCeiling, preferBranch: input.preferBranch,
    });
    const cursorIndex = input.cursor ? allWarnings.findIndex((warning) => warning.episodeId === input.cursor) : -1;
    if (input.cursor && cursorIndex < 0) throw new Error('similar-effort cursor is not present in the eligible result');
    const start = cursorIndex < 0 ? 0 : cursorIndex + 1;
    const warnings = allWarnings.slice(start, start + pageLimit);
    // The summary always covers EXACTLY the episodes the warnings above it cite — never a
    // silently broader "everything considered" set (memory/similar-effort.ts's own contract).
    const warnedIds = new Set(warnings.map((w) => w.episodeId));
    const summary = summarizeEffort(eligibleCandidates.filter((c) => warnedIds.has(c.episodeId)));
    const cases = warnings.map((warning) => priorEffortCase(candidateById.get(warning.episodeId)!, warning, input));
    const eligibleOrderByRun = new Map<string, EffortCandidate[]>();
    for (const warning of allWarnings) {
      const candidate = candidateById.get(warning.episodeId)!;
      const list = eligibleOrderByRun.get(candidate.runId) ?? [];
      list.push(candidate);
      eligibleOrderByRun.set(candidate.runId, list);
    }
    for (const list of eligibleOrderByRun.values()) list.sort((a, b) => (a.sitting ?? 1) - (b.sitting ?? 1));
    for (const item of cases) {
      const linked = eligibleOrderByRun.get(item.runId) ?? [];
      const index = linked.findIndex((candidate) => candidate.episodeId === item.episodeId);
      item.continuation = {
        previousEpisodeId: index > 0 ? linked[index - 1]!.episodeId : null,
        nextEpisodeId: index >= 0 && index + 1 < linked.length ? linked[index + 1]!.episodeId : null,
      };
    }
    const pageEnd = start + warnings.length;
    const reasons: string[] = [...retrievalCoverageReasons];
    if (supportTruncated) reasons.push(`supporting-memory edge scan exceeded ${supportEdgeLimit} rows`);
    if (allWarnings.length >= RETRIEVAL_DEFAULTS.maxResultsCeiling) reasons.push('eligible cases reached the bounded retrieval ceiling');
    return {
      warnings, cases, summary, consideredCount: eligibleCandidates.length,
      page: {
        limit: pageLimit, offset: start, total: allWarnings.length,
        nextCursor: pageEnd < allWarnings.length ? warnings.at(-1)?.episodeId ?? null : null,
      },
      coverage: {
        complete: reasons.length === 0, candidatesConsidered: candidates.length,
        eligibleCases: allWarnings.length, reasons,
      },
    };
  }

  /** PLNR-301: bounded terminal episode facts for D1 shadow-snapshot comparison. The request is
   * keyed only by run+sitting; execution stages are never returned as observations. */
  async comparisonEpisodes(
    projectId: string,
    input: { cases: Array<{ runId: string; sitting: number }>; limit?: number },
  ): Promise<{
    episodes: Array<{ episodeId: string; runId: string; sitting: number; body: string }>;
    coverage: { complete: boolean; reasons: string[] };
  }> {
    await this.assertProjectId(projectId);
    const limit = Math.min(2_000, Math.max(1, Math.trunc(input.limit ?? 1_000)));
    const requested = input.cases.slice(0, limit);
    const episodes: Array<{ episodeId: string; runId: string; sitting: number; body: string }> = [];
    for (let offset = 0; offset < requested.length; offset += 40) {
      const chunk = requested.slice(offset, offset + 40);
      const predicate = chunk.map((_, index) => `(run_id = ?${index * 2 + 1} AND sitting = ?${index * 2 + 2})`).join(' OR ');
      const values = chunk.flatMap((item) => [item.runId, item.sitting]);
      episodes.push(...this.ctx.storage.sql.exec<{
        episodeId: string; runId: string; sitting: number; body: string;
      }>(
        `SELECT id AS episodeId, run_id AS runId, sitting, body FROM episodes WHERE ${predicate}`,
        ...values,
      ).toArray());
    }
    const reasons = input.cases.length > limit ? [`comparison episode request exceeded ${limit} cases`] : [];
    return { episodes, coverage: { complete: reasons.length === 0, reasons } };
  }

  // ---------------------------------------------------------------------------
  // Named graph-query primitives (PLNR-258) — dependency neighborhoods, validating tests,
  // implementing work, decision lineage, and change impact. Each executes bounded traversals
  // over this project's own SQLite (never the embedder/Vectorize — §20/task acceptance: these
  // are pure graph facts) and hands the raw rows to memory/graph-queries.ts to shape into
  // addressable entities with an honest completeness marker. Read-only, same as PLNR-257.
  // ---------------------------------------------------------------------------

  private edgeCoverageInputs(seed: { nodeId: string } | null, edgeTypes: string[], truncated: boolean): {
    codeGraphPopulated: boolean; edgeTypesWithNoWriter: string[]; truncated: boolean; seedMissing: boolean;
  } {
    return {
      codeGraphPopulated: this.isCodeGraphPopulated(),
      edgeTypesWithNoWriter: this.edgeTypesWithNoWriter(edgeTypes),
      truncated,
      seedMissing: !seed,
    };
  }

  /** A file/symbol/schema-entity's upstream/downstream neighborhood via depends_on/imports/
   *  calls (default) — bounded by the SAME depth/row constants PLNR-257's retrieval uses. */
  async dependencyNeighborhood(
    projectId: string,
    input: { entityUri: string; edgeTypes?: string[]; maxDepth?: number; maxResults?: number },
  ): Promise<DependencyNeighborhoodResult> {
    await this.assertProjectId(projectId);
    const edgeTypes = input.edgeTypes?.length ? input.edgeTypes : ['depends_on', 'imports', 'calls'];
    const seed = this.resolveNodeByUri(input.entityUri);
    const seedIds = seed ? [seed.nodeId] : [];
    const down = this.rawTraverseGraph(seedIds, { edgeTypes, maxDepth: input.maxDepth, maxResults: input.maxResults, direction: 'downstream' });
    const up = this.rawTraverseGraph(seedIds, { edgeTypes, maxDepth: input.maxDepth, maxResults: input.maxResults, direction: 'upstream' });
    return dependencyNeighborhood(seed, down.rows, up.rows, this.edgeCoverageInputs(seed, edgeTypes, down.truncated || up.truncated));
  }

  /** Tests connected to an entity via tests/validated_by (either direction — no writer has
   *  established a convention yet, see graph-queries.ts's module comment). */
  async validatingTests(
    projectId: string,
    input: { entityUri: string; maxDepth?: number; maxResults?: number },
  ): Promise<ValidatingTestsResult> {
    await this.assertProjectId(projectId);
    const edgeTypes = ['tests', 'validated_by'];
    const seed = this.resolveNodeByUri(input.entityUri);
    const seedIds = seed ? [seed.nodeId] : [];
    const fwd = this.rawTraverseGraph(seedIds, { edgeTypes, maxDepth: input.maxDepth, maxResults: input.maxResults, direction: 'downstream' });
    const bwd = this.rawTraverseGraph(seedIds, { edgeTypes, maxDepth: input.maxDepth, maxResults: input.maxResults, direction: 'upstream' });
    return validatingTests(seed, fwd.rows, bwd.rows, this.edgeCoverageInputs(seed, edgeTypes, fwd.truncated || bwd.truncated));
  }

  /** Tasks implementing an entity (requirement, decision, procedure, …) via `implements`,
   *  either direction merged. */
  async implementingWork(
    projectId: string,
    input: { entityUri: string; maxDepth?: number; maxResults?: number },
  ): Promise<ImplementingWorkResult> {
    await this.assertProjectId(projectId);
    const edgeTypes = ['implements'];
    const seed = this.resolveNodeByUri(input.entityUri);
    const seedIds = seed ? [seed.nodeId] : [];
    const fwd = this.rawTraverseGraph(seedIds, { edgeTypes, maxDepth: input.maxDepth, maxResults: input.maxResults, direction: 'downstream' });
    const bwd = this.rawTraverseGraph(seedIds, { edgeTypes, maxDepth: input.maxDepth, maxResults: input.maxResults, direction: 'upstream' });
    return implementingWork(seed, fwd.rows, bwd.rows, this.edgeCoverageInputs(seed, edgeTypes, fwd.truncated || bwd.truncated));
  }

  /** A decision's implementing tasks, the code entities those tasks touch (`implements` then
   *  `modifies` — composing existing edges rather than inventing an "affects" one), and any
   *  decision that supersedes it. `decisionUri` is `noriq://decision/<memoryItemId>` (§18) —
   *  its backing memory's evidence rides the answer per §1's contract. */
  async decisionLineage(
    projectId: string,
    input: { decisionUri: string; maxDepth?: number; maxResults?: number },
  ): Promise<DecisionLineageResult> {
    await this.assertProjectId(projectId);
    const implementsTypes = ['implements'];
    const supersedesTypes = ['supersedes'];
    const seed = this.resolveNodeByUri(input.decisionUri);
    const seedIds = seed ? [seed.nodeId] : [];

    const implFwd = this.rawTraverseGraph(seedIds, { edgeTypes: implementsTypes, maxDepth: 1, maxResults: input.maxResults, direction: 'downstream' });
    const implBwd = this.rawTraverseGraph(seedIds, { edgeTypes: implementsTypes, maxDepth: 1, maxResults: input.maxResults, direction: 'upstream' });
    const implementingTaskIds = [...new Set([...implFwd.rows, ...implBwd.rows].map((r) => r.nodeId))];
    const affected = this.rawTraverseGraph(implementingTaskIds, { edgeTypes: ['modifies'], maxDepth: 1, maxResults: input.maxResults, direction: 'downstream' });

    const superFwd = this.rawTraverseGraph(seedIds, { edgeTypes: supersedesTypes, maxDepth: input.maxDepth, maxResults: input.maxResults, direction: 'downstream' });
    const superBwd = this.rawTraverseGraph(seedIds, { edgeTypes: supersedesTypes, maxDepth: input.maxDepth, maxResults: input.maxResults, direction: 'upstream' });

    // §18: a decision node's uri IS noriq://decision/<memoryItemId> — the backing memory's
    // evidence rides the graph claim, same contract PLNR-257's retrieval results carry.
    let evidence: DecisionLineageResult['evidence'] = [];
    const decisionIdMatch = /^noriq:\/\/decision\/(.+)$/.exec(input.decisionUri);
    if (decisionIdMatch) {
      const backing = await this.getMemoryItem(projectId, decisionIdMatch[1]!);
      if (backing) evidence = backing.evidence.map((e) => ({ repositoryKey: e.repositoryKey, branch: e.branch, baseId: e.baseId, path: e.path, verificationState: e.verificationState }));
    }

    const truncated = implFwd.truncated || implBwd.truncated || affected.truncated || superFwd.truncated || superBwd.truncated;
    return decisionLineage(
      seed,
      implFwd.rows,
      implBwd.rows,
      affected.rows,
      superFwd.rows,
      superBwd.rows,
      evidence,
      this.edgeCoverageInputs(seed, [...implementsTypes, 'modifies', ...supersedesTypes], truncated),
    );
  }

  /** Impacted tests for a proposed set of changed entities (by stable URI) — an unresolved URI
   *  (no matching node, e.g. a file never indexed) becomes an UNCERTAIN edge, never a silent
   *  "no impact". */
  async changeImpact(
    projectId: string,
    input: { entityUris: string[]; maxDepth?: number; maxResults?: number },
  ): Promise<ChangeImpactResult> {
    await this.assertProjectId(projectId);
    const edgeTypes = ['tests', 'validated_by'];
    const resolved: GraphEntityRef[] = [];
    const unresolved: string[] = [];
    for (const uri of input.entityUris) {
      const node = this.resolveNodeByUri(uri);
      if (node) resolved.push(node);
      else unresolved.push(uri);
    }
    const seedIds = resolved.map((r) => r.nodeId);
    const fwd = this.rawTraverseGraph(seedIds, { edgeTypes, maxDepth: input.maxDepth, maxResults: input.maxResults, direction: 'downstream' });
    const bwd = this.rawTraverseGraph(seedIds, { edgeTypes, maxDepth: input.maxDepth, maxResults: input.maxResults, direction: 'upstream' });
    return changeImpact(resolved, unresolved, fwd.rows, bwd.rows, {
      codeGraphPopulated: this.isCodeGraphPopulated(),
      edgeTypesWithNoWriter: this.edgeTypesWithNoWriter(edgeTypes),
      truncated: fwd.truncated || bwd.truncated,
      seedMissing: resolved.length === 0,
    });
  }

  /**
   * PLNR-284: the bounded constellation feeding the memory star map (§5) — reads this project's
   * ENTIRE node/edge/memory_items/episodes rows (unsorted, unfiltered — see graph-queries.ts's
   * `constellation` doc comment for why sampling fairly needs the whole population) and hands
   * them to memory/graph-queries.ts's `constellation` to score, sample under hard ceilings, and
   * classify coverage. Read-only: no memory_revision bump, no outbox row, same discipline as
   * every other PLNR-257/258 query above. `memory_revision` rides the response so a client can
   * cheaply detect an unchanged map (locked decision: exposed as a body field here, not an ETag —
   * this DO has no HTTP layer of its own to attach one to; index.ts's route is free to ALSO turn
   * it into an ETag if a future task wants that).
   */
  private readConstellationRows(eligibleOnly = false): ConstellationInputRows {
    const nodes = this.ctx.storage.sql
      .exec<{ id: string; type: string; uri: string; label: string; created_at: string }>(
        `SELECT id, type, uri, label, created_at FROM nodes${eligibleOnly ? ` WHERE type != 'symbol'` : ''}`,
      )
      .toArray()
      .map((r) => ({ nodeId: r.id, type: r.type, uri: r.uri, label: r.label, createdAt: r.created_at }));
    const edges = this.ctx.storage.sql
      .exec<{ id: string; type: string; from_node_id: string; to_node_id: string; provenance: string | null }>(
        eligibleOnly
          ? `SELECT e.id, e.type, e.from_node_id, e.to_node_id, e.provenance
             FROM edges e JOIN nodes f ON f.id = e.from_node_id JOIN nodes t ON t.id = e.to_node_id
             WHERE f.type != 'symbol' AND t.type != 'symbol'`
          : `SELECT id, type, from_node_id, to_node_id, provenance FROM edges`,
      )
      .toArray()
      .map((r) => ({ edgeId: r.id, type: r.type, fromNodeId: r.from_node_id, toNodeId: r.to_node_id, provenance: r.provenance }));
    const memoryItems = this.ctx.storage.sql
      .exec<{ id: string; kind: string; authority: number; validity: string }>(`SELECT id, kind, authority, validity FROM memory_items`)
      .toArray();
    const episodes = this.ctx.storage.sql
      .exec<{ id: string; landing_outcome: string }>(`SELECT id, landing_outcome FROM episodes`)
      .toArray()
      .map((r) => ({ id: r.id, landingOutcome: r.landing_outcome }));

    return { nodes, edges, memoryItems, episodes };
  }

  async constellation(projectId: string, options: ConstellationOptions = {}): Promise<ConstellationResult> {
    await this.assertProjectId(projectId);
    return constellation(this.readMemoryRevision(), this.readConstellationRows(), { codeGraphPopulated: this.isCodeGraphPopulated() }, options);
  }

  /** PLNR-339: ordered, cursor-paginated companion to the bounded canvas. This intentionally reads
   *  the same canonical rows and applies the same eligibility/degree rules as constellation(). */
  async listGraphEntities(projectId: string, input: GraphEntityPageInput = {}): Promise<GraphEntityPage> {
    await this.assertProjectId(projectId);
    // The catalogue never reports excluded-symbol coverage, so avoid loading the usually much
    // larger symbol population and its incident edges for every 50-row page.
    return listGraphEntities(this.readMemoryRevision(), this.readConstellationRows(true), input);
  }

  // ---------------------------------------------------------------------------
  // Proposed-decision approval and authority promotion (PLNR-253)
  //
  // Neither path ever mutates an existing memory_items row's authority in place — that column,
  // once written by recordMemory, never changes again. A promotion instead creates a NEW row
  // (authority 5 for human approval, 4 for merge evidence) linked back via
  // supersedes_memory_id — the SAME versioning mechanism PLNR-251 uses for a plain correction —
  // and records one immutable memory_authority_transitions row as the durable "who/when/why".
  // Authority 5 is reachable ONLY from approveDecision, which only userAuth REST calls (never an
  // MCP tool); nothing here trusts a caller-supplied authority value.
  // ---------------------------------------------------------------------------

  /** Every kind='decision' memory still awaiting a human's accept/reject — the human governance
   *  queue. Visible, but (being authority <= 2, per recordMemory's agent clamp) never
   *  authoritative until acted on. */
  async listProposedDecisions(projectId: string): Promise<
    Array<{ id: string; statement: string; authority: number; recordedByAgentId: string | null; recordedAt: string; proposedAt: string }>
  > {
    await this.assertProjectId(projectId);
    return this.ctx.storage.sql
      .exec<{
        id: string;
        statement: string;
        authority: number;
        recorded_by_agent_id: string | null;
        recorded_at: string;
        proposed_at: string;
      }>(
        // PLNR-323: same millisecond-tie hazard — `id` keeps two decisions proposed in the same
        // millisecond in a fixed, reproducible queue order for the human reviewing them.
        `SELECT id, statement, authority, recorded_by_agent_id, recorded_at, proposed_at
         FROM memory_items WHERE kind = 'decision' AND proposed_at IS NOT NULL ORDER BY proposed_at, id`,
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        statement: r.statement,
        authority: r.authority,
        recordedByAgentId: r.recorded_by_agent_id,
        recordedAt: r.recorded_at,
        proposedAt: r.proposed_at,
      }));
  }

  /** Canonical human-governance queue. Only current leaf memories are actionable: an item that
   * has already been superseded, or a decision a human already rejected, remains in history but
   * does not keep paging the review desk forever. Classification lives here so every human sees
   * the same reasons and counts regardless of client version. */
  async reviewMemoryQueue(
    projectId: string,
    input: { reason?: MemoryReviewReason; limit?: number; offset?: number } = {},
  ): Promise<MemoryReviewQueue> {
    await this.assertProjectId(projectId);
    type Reason = MemoryReviewReason;
    type Row = {
      id: string; kind: string; statement: string; authority: number; validity: string;
      recorded_at: string; recorded_by_agent_id: string | null; proposed_at: string | null;
      repository_key: string | null; branch: string | null; base_id: string | null;
    };
    const rows = this.ctx.storage.sql.exec<Row>(
      `SELECT m.id, m.kind, m.statement, m.authority, m.validity, m.recorded_at,
              m.recorded_by_agent_id, m.proposed_at, m.repository_key, m.branch, m.base_id
       FROM memory_items m
       WHERE m.rejected_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM memory_items newer WHERE newer.supersedes_memory_id = m.id)`,
    ).toArray();
    const contradictionSets = new Map<string, Set<string>>();
    for (const row of this.ctx.storage.sql.exec<{ memory_item_id: string; contradicts_memory_item_id: string; set_id: string }>(
      `SELECT c.memory_item_id, c.contradicts_memory_item_id, c.set_id
       FROM contradictions c JOIN contradiction_sets s ON s.id = c.set_id
       WHERE s.resolved_at IS NULL`,
    ).toArray()) {
      for (const id of [row.memory_item_id, row.contradicts_memory_item_id]) {
        const sets = contradictionSets.get(id) ?? new Set<string>();
        sets.add(row.set_id);
        contradictionSets.set(id, sets);
      }
    }
    const negativeFeedback = new Map<string, { count: number; latest: string }>();
    const recentCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString();
    for (const row of this.ctx.storage.sql.exec<{ memory_item_id: string; count: number; latest: string }>(
      `SELECT memory_item_id, COUNT(*) AS count, MAX(created_at) AS latest
       FROM feedback
       WHERE vote = 'down' AND created_at >= ?1
       GROUP BY memory_item_id`,
      recentCutoff,
    ).toArray()) negativeFeedback.set(row.memory_item_id, { count: Number(row.count), latest: row.latest });

    const priority: Record<Reason, number> = {
      proposed_decision: 0, contradiction: 1, stale_invalid: 2,
      recent_negative_feedback: 3, low_authority: 4,
    };
    const classified = rows.flatMap((row) => {
      const reasons: Reason[] = [];
      if (row.proposed_at) reasons.push('proposed_decision');
      if (contradictionSets.has(row.id)) reasons.push('contradiction');
      if (row.validity !== 'active') reasons.push('stale_invalid');
      if (negativeFeedback.has(row.id)) reasons.push('recent_negative_feedback');
      if (row.authority <= 2) reasons.push('low_authority');
      if (!reasons.length) return [];
      const feedback = negativeFeedback.get(row.id);
      return [{
        id: row.id, kind: row.kind, statement: row.statement, authority: row.authority,
        validity: row.validity, recordedAt: row.recorded_at, recordedByAgentId: row.recorded_by_agent_id,
        proposedAt: row.proposed_at, repositoryKey: row.repository_key, branch: row.branch,
        baseId: row.base_id, reasons, contradictionSetIds: [...(contradictionSets.get(row.id) ?? [])].sort(),
        recentNegativeFeedbackCount: feedback?.count ?? 0, latestNegativeFeedbackAt: feedback?.latest ?? null,
      }];
    });
    const reasons = Object.keys(priority) as Reason[];
    const counts = Object.fromEntries(reasons.map((reason) => [reason, classified.filter((item) => item.reasons.includes(reason)).length])) as Record<Reason, number>;
    const filtered = input.reason ? classified.filter((item) => item.reasons.includes(input.reason!)) : classified;
    filtered.sort((a, b) => {
      const aPriority = Math.min(...a.reasons.map((reason) => priority[reason]));
      const bPriority = Math.min(...b.reasons.map((reason) => priority[reason]));
      return aPriority - bPriority || b.recordedAt.localeCompare(a.recordedAt) || a.id.localeCompare(b.id);
    });
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 50)));
    const items = filtered.slice(offset, offset + limit);
    return { items, counts, overallTotal: classified.length, total: filtered.length, offset, nextOffset: offset + items.length < filtered.length ? offset + items.length : null };
  }

  private loadMemoryRow(memoryId: string): { id: string; kind: string; proposed_at: string | null; authority: number } | undefined {
    return this.ctx.storage.sql
      .exec<{ id: string; kind: string; proposed_at: string | null; authority: number }>(
        `SELECT id, kind, proposed_at, authority FROM memory_items WHERE id = ?1`,
        memoryId,
      )
      .toArray()[0];
  }

  /** Copy a memory item's evidence rows onto a NEW memory item id — used by both promotion
   *  paths so the superseding version carries the same citations as the one it replaces,
   *  rather than reading as unevidenced. */
  private copyEvidence(fromMemoryId: string, toMemoryId: string, now: string): void {
    const rows = this.ctx.storage.sql
      .exec<{ repository_key: string; branch: string; base_id: string; path: string; symbol: string | null; content_hash: string | null; evidence_hash: string | null; verification_state: string }>(
        `SELECT repository_key, branch, base_id, path, symbol, content_hash, evidence_hash, verification_state FROM evidence WHERE memory_item_id = ?1`,
        fromMemoryId,
      )
      .toArray();
    for (const r of rows) {
      this.ctx.storage.sql.exec(
        `INSERT INTO evidence (id, memory_item_id, repository_key, branch, base_id, path, symbol, content_hash, evidence_hash, verification_state, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
        newId('ev'),
        toMemoryId,
        r.repository_key,
        r.branch,
        r.base_id,
        r.path,
        r.symbol,
        r.content_hash,
        r.evidence_hash,
        r.verification_state,
        now,
      );
    }
  }

  /** Human-only (userAuth REST calls this; no MCP tool ever does) approval of a proposed
   *  decision — the ONLY path to authority 5 (§12). Creates a new authority-5 version
   *  superseding the proposed one, an immutable transition record, and clears proposed_at on
   *  the original (which itself is never otherwise touched — its authority column stays
   *  whatever it was recorded at). */
  async approveDecision(
    projectId: string,
    input: { memoryItemId: string; actorUserId: string; note?: string | null; revision?: string | null },
  ): Promise<{ approvedMemoryId: string; transitionId: string }> {
    await this.assertProjectId(projectId);
    const row = this.loadMemoryRow(input.memoryItemId);
    if (!row) throw new Error(`memory item ${input.memoryItemId} not found`);
    if (row.kind !== 'decision') throw new Error(`memory item ${input.memoryItemId} is not a decision`);
    if (!row.proposed_at) throw new Error(`memory item ${input.memoryItemId} is not a pending proposed decision`);

    const original = await this.getMemoryItem(projectId, input.memoryItemId);
    if (!original) throw new Error(`memory item ${input.memoryItemId} not found`);
    const graphProjectKey = original.evidence.length ? await this.resolveProjectKey(projectId) : null;
    const approvedMemoryId = newId('mem');
    const transitionId = newId('atr');
    const operationId = newId('op');
    const now = nowIso();
    this.ctx.storage.transactionSync(() => {
      if (this._forceWriteFailure) throw new Error('injected write failure (test)');
      this.ctx.storage.sql.exec(
        `INSERT INTO memory_items
           (id, kind, statement, authority, confidence, content_hash, repository_key, branch, base_id, supersedes_memory_id, recorded_by_agent_id, recorded_at)
         VALUES (?1,'decision',?2,?3,?4,?5,?6,?7,?8,?9,NULL,?10)`,
        approvedMemoryId,
        original.statement,
        AUTHORITY_HUMAN_APPROVED,
        original.confidence,
        original.contentHash,
        original.repositoryKey,
        original.branch,
        original.baseId,
        input.memoryItemId,
        now,
      );
      this.copyEvidence(input.memoryItemId, approvedMemoryId, now);
      this.projectStoredMemoryItem(approvedMemoryId, graphProjectKey, now);
      this.ctx.storage.sql.exec(`UPDATE memory_items SET proposed_at = NULL WHERE id = ?1`, input.memoryItemId);
      this.ctx.storage.sql.exec(
        `INSERT INTO memory_authority_transitions (id, memory_item_id, resulting_memory_id, outcome, new_authority, actor_kind, actor_id, revision, note, created_at)
         VALUES (?1,?2,?3,'approved',?4,'human',?5,?6,?7,?8)`,
        transitionId,
        input.memoryItemId,
        approvedMemoryId,
        AUTHORITY_HUMAN_APPROVED,
        input.actorUserId,
        input.revision ?? null,
        input.note ?? null,
        now,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO outbox (id, operation_id, verb, subject_type, subject_id, payload, created_at) VALUES (?1,?2,'memory.changed','memory',?3,?4,?5)`,
        newId('obx'),
        operationId,
        transitionId,
        JSON.stringify({ operationId, entityType: 'authority_transition', outcome: 'approved', memoryItemId: input.memoryItemId, resultingMemoryId: approvedMemoryId, actorKind: 'human', actorId: input.actorUserId }),
        now,
      );
      this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = value + 1 WHERE id = 0`);
      this.ctx.storage.sql.exec(
        `INSERT INTO applied_operations (operation_id, applied_at, subject_type, subject_id, result) VALUES (?1,?2,'authority_transition',?3,?4)`,
        operationId,
        now,
        transitionId,
        JSON.stringify({ approvedMemoryId, transitionId }),
      );
    });
    this.ctx.storage.setAlarm(Date.now()).catch(() => {});
    // PLNR-255: index the new authority-5 version, de-index the proposed one it supersedes.
    const searchBackendForIndex = searchBackend(this.env);
    if (searchBackendForIndex) {
      void indexEntity(searchBackendForIndex, { kind: 'memory', id: approvedMemoryId, projectId, title: original.kind, body: original.statement })
        .then(() => removeEntity(searchBackendForIndex, 'memory', input.memoryItemId))
        .catch((err) => console.warn(`ProjectMemory memory-index for ${approvedMemoryId} failed: ${String(err)}`));
    }
    return { approvedMemoryId, transitionId };
  }

  /** Human-only rejection of a proposed decision. No new version, no authority change — the
   *  original row is left exactly as recorded, `proposed_at` is cleared, and `rejected_at` is
   *  set so the decision remains historically visible as rejected rather than reading like it
   *  is still awaiting review. */
  async rejectDecision(
    projectId: string,
    input: { memoryItemId: string; actorUserId: string; note?: string | null },
  ): Promise<{ ok: true; transitionId: string }> {
    await this.assertProjectId(projectId);
    const row = this.loadMemoryRow(input.memoryItemId);
    if (!row) throw new Error(`memory item ${input.memoryItemId} not found`);
    if (row.kind !== 'decision') throw new Error(`memory item ${input.memoryItemId} is not a decision`);
    if (!row.proposed_at) throw new Error(`memory item ${input.memoryItemId} is not a pending proposed decision`);

    const transitionId = newId('atr');
    const operationId = newId('op');
    const now = nowIso();
    this.ctx.storage.transactionSync(() => {
      if (this._forceWriteFailure) throw new Error('injected write failure (test)');
      this.ctx.storage.sql.exec(`UPDATE memory_items SET proposed_at = NULL, rejected_at = ?2 WHERE id = ?1`, input.memoryItemId, now);
      this.ctx.storage.sql.exec(
        `INSERT INTO memory_authority_transitions (id, memory_item_id, resulting_memory_id, outcome, new_authority, actor_kind, actor_id, revision, note, created_at)
         VALUES (?1,?2,NULL,'rejected',NULL,'human',?3,NULL,?4,?5)`,
        transitionId,
        input.memoryItemId,
        input.actorUserId,
        input.note ?? null,
        now,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO outbox (id, operation_id, verb, subject_type, subject_id, payload, created_at) VALUES (?1,?2,'memory.changed','memory',?3,?4,?5)`,
        newId('obx'),
        operationId,
        transitionId,
        JSON.stringify({ operationId, entityType: 'authority_transition', outcome: 'rejected', memoryItemId: input.memoryItemId, actorKind: 'human', actorId: input.actorUserId }),
        now,
      );
      this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = value + 1 WHERE id = 0`);
      this.ctx.storage.sql.exec(
        `INSERT INTO applied_operations (operation_id, applied_at, subject_type, subject_id, result) VALUES (?1,?2,'authority_transition',?3,?4)`,
        operationId,
        now,
        transitionId,
        JSON.stringify({ transitionId }),
      );
    });
    this.ctx.storage.setAlarm(Date.now()).catch(() => {});
    return { ok: true, transitionId };
  }

  /**
   * GitHub-merge-evidence promotion (§12, PLNR-266). Every memory below authority 4 whose
   * evidence is ENTIRELY within the given repository/branch is a CANDIDATE — but repository/
   * branch scoping alone is no longer sufficient (PLNR-253's own comment already flagged this as
   * provisional pending this task's verification gate): each candidate's citations must actually
   * VERIFY at the merged baseId before promotion, reusing PLNR-265's own verification path
   * rather than re-deriving a check. `verifyMemoryCitations` refreshes each citation against
   * the CURRENT active index generation (in the real flow, indexing has caught up to the just-
   * merged commit by the time this runs), and `verifiedForBase` — built exactly for "is this
   * genuinely valid AND scoped to the caller's own branch/base" — gates on the merged
   * (branch, baseId) specifically, not just on whatever base happened to be last checked. A
   * candidate that fails either check is SKIPPED with a recorded reason: promotion is an upgrade
   * path, and failing to earn one is not evidence of being wrong (that is PLNR-265's own
   * verification sweep's job, which has the base scope to justify a demotion — this path never
   * demotes). This never promotes past AUTHORITY_VERIFIED_MERGED (4); human approval
   * (`approveDecision`) remains the only path to 5 — see `memory-approval.test.ts`'s explicit cap
   * assertion.
   */
  async promoteMemoriesOnMerge(
    projectId: string,
    input: { repositoryKey: string; branch: string; mergedBaseId: string },
  ): Promise<{ promoted: string[]; skipped: Array<{ memoryItemId: string; reason: string }> }> {
    await this.assertProjectId(projectId);
    const graphProjectKey = await this.resolveProjectKey(projectId);
    const candidates = this.ctx.storage.sql
      .exec<{ id: string }>(`SELECT id FROM memory_items WHERE authority < ?1`, AUTHORITY_VERIFIED_MERGED)
      .toArray();
    const searchBackendForIndex = searchBackend(this.env);
    const promoted: string[] = [];
    const skipped: Array<{ memoryItemId: string; reason: string }> = [];
    for (const { id } of candidates) {
      const evidenceRows = this.ctx.storage.sql
        .exec<{ repository_key: string; branch: string }>(`SELECT repository_key, branch FROM evidence WHERE memory_item_id = ?1`, id)
        .toArray();
      if (evidenceRows.length === 0) {
        skipped.push({ memoryItemId: id, reason: 'no repository evidence to verify' });
        continue;
      }
      if (!evidenceRows.every((e) => e.repository_key === input.repositoryKey && e.branch === input.branch)) {
        skipped.push({ memoryItemId: id, reason: 'evidence cites a different repository or branch than the merged PR' });
        continue;
      }
      // Refresh this memory's citations against the current active graph (PLNR-265's own RPC —
      // not a re-derived check) before judging them: a candidate's evidence rows may still carry
      // a PRE-merge verification state from an earlier sweep, and this is what brings them
      // current before the merged-base gate below reads them.
      await this.verifyMemoryCitations(projectId, { memoryItemId: id });
      const verifiedRows = this.ctx.storage.sql
        .exec<{ verification_state: string; last_verified_base_id: string | null; last_verified_branch: string | null }>(
          `SELECT verification_state, last_verified_base_id, last_verified_branch FROM evidence WHERE memory_item_id = ?1`,
          id,
        )
        .toArray();
      const verifiedAtMergedBase = verifiedRows.every((r) =>
        verifiedForBase(
          { verificationState: r.verification_state, lastVerifiedBaseId: r.last_verified_base_id, lastVerifiedBranch: r.last_verified_branch },
          { baseId: input.mergedBaseId, branch: input.branch },
        ),
      );
      if (!verifiedAtMergedBase) {
        skipped.push({ memoryItemId: id, reason: `citations do not verify at the merged base ${input.mergedBaseId}` });
        continue;
      }
      const original = await this.getMemoryItem(projectId, id);
      if (!original) {
        skipped.push({ memoryItemId: id, reason: 'memory item vanished between candidate selection and promotion' });
        continue;
      }
      const promotedId = newId('mem');
      const transitionId = newId('atr');
      const operationId = newId('op');
      const now = nowIso();
      this.ctx.storage.transactionSync(() => {
        if (this._forceWriteFailure) throw new Error('injected write failure (test)');
        this.ctx.storage.sql.exec(
          `INSERT INTO memory_items
             (id, kind, statement, authority, confidence, content_hash, repository_key, branch, base_id, supersedes_memory_id, recorded_by_agent_id, recorded_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,NULL,?11)`,
          promotedId,
          original.kind,
          original.statement,
          AUTHORITY_VERIFIED_MERGED,
          original.confidence,
          original.contentHash,
          original.repositoryKey,
          original.branch,
          original.baseId,
          id,
          now,
        );
        this.copyEvidence(id, promotedId, now);
        this.projectStoredMemoryItem(promotedId, graphProjectKey, now);
        this.ctx.storage.sql.exec(
          `INSERT INTO memory_authority_transitions (id, memory_item_id, resulting_memory_id, outcome, new_authority, actor_kind, actor_id, revision, note, created_at)
           VALUES (?1,?2,?3,'merge_promoted',?4,'system',NULL,?5,NULL,?6)`,
          transitionId,
          id,
          promotedId,
          AUTHORITY_VERIFIED_MERGED,
          input.mergedBaseId,
          now,
        );
        this.ctx.storage.sql.exec(
          `INSERT INTO outbox (id, operation_id, verb, subject_type, subject_id, payload, created_at) VALUES (?1,?2,'memory.changed','memory',?3,?4,?5)`,
          newId('obx'),
          operationId,
          transitionId,
          JSON.stringify({ operationId, entityType: 'authority_transition', outcome: 'merge_promoted', memoryItemId: id, resultingMemoryId: promotedId, actorKind: 'system', actorId: null, revision: input.mergedBaseId }),
          now,
        );
        this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = value + 1 WHERE id = 0`);
        this.ctx.storage.sql.exec(
          `INSERT INTO applied_operations (operation_id, applied_at, subject_type, subject_id, result) VALUES (?1,?2,'authority_transition',?3,?4)`,
          operationId,
          now,
          transitionId,
          JSON.stringify({ promotedId, transitionId }),
        );
      });
      // PLNR-255: index the new authority-4 version, de-index the one it supersedes.
      if (searchBackendForIndex) {
        void indexEntity(searchBackendForIndex, { kind: 'memory', id: promotedId, projectId, title: original.kind, body: original.statement })
          .then(() => removeEntity(searchBackendForIndex, 'memory', id))
          .catch((err) => console.warn(`ProjectMemory memory-index for ${promotedId} failed: ${String(err)}`));
      }
      promoted.push(promotedId);
    }
    if (promoted.length > 0) this.ctx.storage.setAlarm(Date.now()).catch(() => {});
    return { promoted, skipped };
  }

  // ---------------------------------------------------------------------------
  // PLNR-266: guidance-drift scanning. `memory/guidance-drift.ts`'s `compareSurfaces` is
  // storage-free and rule-driven; this DO only supplies persistence. It deliberately never reads
  // INSTRUCTIONS/GET_BRIEFING_PLAYBOOK/SKILL_MD/DOC_SKILL_MD itself — those live in mcp.ts/
  // skill.ts/skill-docs.ts, one layer up, and ProjectMemory has no business importing the MCP
  // surface; the caller (index.ts) gathers the live text and passes it in. A finding is a
  // maintenance defect report about NORIQ'S OWN guidance surfaces, never project knowledge — see
  // 0009_guidance_drift.sql's own comment for why it is a dedicated table, not a memory_items row.
  // ---------------------------------------------------------------------------

  /**
   * Compare the given surface texts against the fixed rule table and persist any findings,
   * deduplicated by `findingHash` (ruleId + sorted present/missing surfaces + quotes). Hashes are
   * computed BEFORE the transaction (they need `crypto.subtle`, which is async and cannot run
   * inside `transactionSync`'s synchronous callback); the transaction itself only reads/writes
   * SQLite. A finding whose hash already exists has its `last_seen_at` touched instead of being
   * re-inserted — a re-scan of an unchanged repository therefore adds zero rows (stated
   * acceptance: "running the same scan twice produces the same finding set and adds no duplicate
   * rows"), while a genuinely NEW finding (a rule that just started/stopped drifting) still gets
   * its own row alongside any still-open older ones.
   */
  async recordGuidanceDriftScan(
    projectId: string,
    surfaces: Partial<Record<SurfaceId, string | null>>,
  ): Promise<{ findings: number; newFindings: number }> {
    await this.assertProjectId(projectId);
    const findings = compareSurfaces(surfaces);
    const withHashes = await Promise.all(findings.map(async (f) => ({ finding: f, hash: await findingHash(f) })));
    const now = nowIso();
    let newFindings = 0;
    this.ctx.storage.transactionSync(() => {
      if (this._forceWriteFailure) throw new Error('injected write failure (test)');
      for (const { finding, hash } of withHashes) {
        const existing = this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM guidance_drift_findings WHERE hash = ?1`, hash).toArray()[0];
        if (existing) {
          this.ctx.storage.sql.exec(`UPDATE guidance_drift_findings SET last_seen_at = ?2 WHERE id = ?1`, existing.id, now);
          continue;
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO guidance_drift_findings
             (id, hash, rule_id, description, present_surfaces, missing_surfaces, unavailable_surfaces, quotes, recommended_edit, first_seen_at, last_seen_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
          newId('gdf'),
          hash,
          finding.ruleId,
          finding.description,
          JSON.stringify(finding.presentSurfaces),
          JSON.stringify(finding.missingSurfaces),
          JSON.stringify(finding.unavailableSurfaces),
          JSON.stringify(finding.quotes),
          finding.recommendedEdit,
          now,
          now,
        );
        newFindings++;
      }
    });
    return { findings: withHashes.length, newFindings };
  }

  /** The stored, deduplicated guidance-drift findings for this project — read-only; nothing in
   *  this codebase writes to a guidance file, doc, or task from this data (locked decision). */
  async listGuidanceDriftFindings(projectId: string): Promise<
    Array<{
      id: string; ruleId: string; description: string; presentSurfaces: SurfaceId[]; missingSurfaces: SurfaceId[];
      unavailableSurfaces: SurfaceId[]; quotes: Partial<Record<SurfaceId, string>>; recommendedEdit: string;
      firstSeenAt: string; lastSeenAt: string;
    }>
  > {
    await this.assertProjectId(projectId);
    return this.ctx.storage.sql
      .exec<{
        id: string; rule_id: string; description: string; present_surfaces: string; missing_surfaces: string;
        unavailable_surfaces: string; quotes: string; recommended_edit: string; first_seen_at: string; last_seen_at: string;
      }>(
        `SELECT id, rule_id, description, present_surfaces, missing_surfaces, unavailable_surfaces, quotes, recommended_edit, first_seen_at, last_seen_at
         FROM guidance_drift_findings ORDER BY first_seen_at`,
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        ruleId: r.rule_id,
        description: r.description,
        presentSurfaces: JSON.parse(r.present_surfaces) as SurfaceId[],
        missingSurfaces: JSON.parse(r.missing_surfaces) as SurfaceId[],
        unavailableSurfaces: JSON.parse(r.unavailable_surfaces) as SurfaceId[],
        quotes: JSON.parse(r.quotes) as Partial<Record<SurfaceId, string>>,
        recommendedEdit: r.recommended_edit,
        firstSeenAt: r.first_seen_at,
        lastSeenAt: r.last_seen_at,
      }));
  }

  /**
   * Deliver every undelivered outbox row to ProjectRoom, oldest first. At-least-once and
   * idempotent to retry: ProjectRoom's `memory_event_dedup` recognizes an already-applied
   * operation id and acknowledges it without a second event, so calling this again after a
   * partial run (or a full success) is always safe. A delivery failure stops that row from
   * being marked delivered and this simply returns — the row is retried on the next drain.
   */
  async drainOutbox(projectId: string): Promise<{ delivered: number; failed: number }> {
    await this.assertProjectId(projectId);
    const pending = this.ctx.storage.sql
      .exec<{ id: string; operation_id: string; verb: string; subject_type: string; subject_id: string; payload: string }>(
        `SELECT id, operation_id, verb, subject_type, subject_id, payload FROM outbox
         WHERE delivered_at IS NULL ORDER BY created_at ASC`,
      )
      .toArray();
    let delivered = 0;
    let failed = 0;
    for (const row of pending) {
      try {
        if (this._forceDeliveryFailure) throw new Error('injected delivery failure (test)');
        await this.env.PROJECT_ROOM.get(this.env.PROJECT_ROOM.idFromName(projectId)).receiveMemoryEvent(projectId, {
          operationId: row.operation_id,
          verb: row.verb,
          subjectType: row.subject_type,
          subjectId: row.subject_id,
          payload: JSON.parse(row.payload) as Record<string, unknown>,
        });
        this.ctx.storage.sql.exec(`UPDATE outbox SET delivered_at = ?1 WHERE id = ?2`, nowIso(), row.id);
        delivered++;
      } catch (err) {
        failed++;
        console.warn(`ProjectMemory outbox delivery failed for ${projectId}/${row.operation_id}: ${String(err)}`);
      }
    }
    return { delivered, failed };
  }

  private readProjectorCursor(): number {
    const row = this.ctx.storage.sql.exec<{ global_seq: number }>(`SELECT global_seq FROM projector_cursor WHERE id = 0`).toArray()[0];
    return row?.global_seq ?? 0;
  }

  /**
   * PLNR-247's `task.created`-only projection, widened by PLNR-283 to `plan.created`/
   * `doc.created`/`milestone.created`, then by PLNR-316 to draw EDGES too (`task.claimed`/
   * `task.released`) — see `mapCoordinationEvent` (memory/projection.ts, the pure decision of
   * what to write) for which verbs project what, and why `dependency.added`/`dependency.removed`/
   * `run.created` still project nothing despite naming real relationships. `upsertGraphNode`'s
   * `ON CONFLICT (uri) DO UPDATE` and `linkGraphEdge`'s `ON CONFLICT (type, from, to) DO NOTHING`
   * make a re-applied event a no-op rather than a duplicate, which matters because the cursor
   * advance and this write commit in the SAME transaction — replaying a range this already
   * consumed must stay side-effect-free. Every edge endpoint is upserted (never just referenced)
   * before the edge is linked — PLNR-316's locked decision that a missing endpoint is stubbed,
   * never a reason to skip the edge; an `unlink` edge's endpoints are looked up instead (nothing
   * to stub when the write is a removal).
   */
  private applyCoordinationEvent(ev: ProjectedEvent): void {
    const projected = mapCoordinationEvent({ verb: ev.verb, subjectId: ev.subjectId, payload: ev.payload });
    if (!projected) return;
    if (projected.node) {
      this.upsertGraphNode(projected.node.type, projected.node.uri, projected.node.label, ev.createdAt);
    }
    for (const edge of projected.edges) {
      this.applyCoordinationEdge(edge, ev.createdAt);
    }
    // PLNR-317: mutually exclusive with node/edges above (a delete verb sets ONLY this) — removes
    // the node and every edge incident on it. Ordering within one event never matters here since
    // no verb sets both, but this runs last so a future verb that DID project edges alongside a
    // removal (none does today) could not have those edges silently survive the removal.
    if (projected.removeNodeUri) {
      this.removeGraphNode(projected.removeNodeUri);
    }
  }

  /** PLNR-316: one edge from a coordination event's projection — see `ProjectedEdgeDescriptor`'s
   *  own doc comment for the link/unlink split. Factored out of `applyCoordinationEvent` because
   *  a single event may project more than one edge (none do yet, but the shape is per-edge, not
   *  per-event, to keep it that way when one does). */
  private applyCoordinationEdge(edge: ProjectedEdgeDescriptor, now: string): void {
    if (edge.op === 'link') {
      const fromId = this.upsertGraphNode(edge.from.type, edge.from.uri, edge.from.label, now);
      const toId = this.upsertGraphNode(edge.to.type, edge.to.uri, edge.to.label, now);
      this.linkGraphEdge(edge.type, fromId, toId, now, edge.provenance);
    } else {
      const fromId = this.findGraphNodeId(edge.from.uri);
      const toId = this.findGraphNodeId(edge.to.uri);
      if (fromId && toId) this.unlinkGraphEdge(edge.type, fromId, toId);
    }
  }

  /**
   * Project this project's D1 coordination events past the durable `global_seq` cursor into
   * the graph, one event at a time — each projection write and its cursor advance commit in
   * ONE SQLite transaction, so a crash between them is impossible by construction, and
   * re-running over an already-consumed range applies nothing new (the cursor predicate and
   * the projection's own idempotent write both guarantee it).
   */
  async runProjector(projectId: string): Promise<{ applied: number; cursor: number }> {
    await this.assertProjectId(projectId);
    const events = await projectCoordinationEvents(this.env, projectId, this.readProjectorCursor());
    for (const ev of events) {
      this.ctx.storage.transactionSync(() => {
        this.applyCoordinationEvent(ev);
        this.ctx.storage.sql.exec(`UPDATE projector_cursor SET global_seq = ?1 WHERE id = 0`, ev.globalSeq);
      });
    }
    return { applied: events.length, cursor: this.readProjectorCursor() };
  }

  /** Test-only: rewind the projector cursor so a test can force `runProjector` to RE-CONSUME an
   *  already-applied range — the only way to prove replay idempotency (PLNR-317's acceptance:
   *  "replaying an already-applied delete event is a no-op") without a second production RPC. */
  async _rewindProjectorCursorForTest(projectId: string, globalSeq: number): Promise<void> {
    await this.assertProjectId(projectId);
    this.ctx.storage.sql.exec(`UPDATE projector_cursor SET global_seq = ?1 WHERE id = 0`, globalSeq);
  }

  /** The explicit reconciliation entry point (§19/§20 — no Queues/Workflows binding exists in
   *  this repo, so this plus the alarm below are the whole delivery mechanism): drains any
   *  outbox backlog, then catches this project's memory up on any coordination events it
   *  missed. Safe to call any time, from anywhere — both halves are independently idempotent. */
  async reconcile(projectId: string): Promise<{ delivered: number; failed: number; applied: number; cursor: number }> {
    const drain = await this.drainOutbox(projectId);
    const project = await this.runProjector(projectId);
    return { ...drain, ...project };
  }

  /**
   * The live D1 coordination state `rebuildProjection` and `projectionDrift` (PLNR-320) both
   * need — factored out so the two can never silently disagree on what "expected" means (the
   * exact bug wrinkle-1/wrinkle-3 style drift would otherwise invite: a drift counter built from
   * a SEPARATE, hand-copied query could diverge from the rebuild's own query without anyone
   * noticing). `dependencies` has no `project_id` (an edge is owned by the DEPENDENT task's
   * project, CLAUDE.md) — the query joins through `tasks` on the dependent side to select this
   * project's rows, the same way `externalDependentsOf`/`addDependency` do. A CROSS-PROJECT
   * blocker needs no special case in the SQL itself: `dependsOnId` for a foreign blocker simply
   * never appears in `tasks.results` (this project only), so every caller's own node-id map
   * lookup naturally skips it — the identical choice `mapCoordinationEvent`'s
   * `dependency.added`/`.removed` arms make explicitly (see that function's doc comment), reached
   * here by construction instead of a second check, so no writer or reader of this data can
   * silently drift on which edges are cross-project.
   */
  private async loadCoordinationRelationships(projectId: string): Promise<CoordinationRelationships> {
    // PLNR-325: every run this project has ever created, regardless of status — nothing prunes
    // individual `runs` rows short of `deleteProject` (checked: only that cascade touches this
    // table), and `run.created`/`recordEpisode` project a run node unconditionally too, so a
    // terminal/cancelled run is projected the same as a live one. `anchorType`/`anchorId` are
    // read straight off the soft ref (migration 0018's CHECK keeps them null-together); whether
    // the anchor still resolves is decided by the caller against the `tasks`/`plans` rows above,
    // never here.
    const [tasks, plans, docs, milestones, agents, taskPlanLinks, taskDocLinks, taskDependencies, taskClaims, runs] = await Promise.all([
      this.env.DB.prepare('SELECT id, title FROM tasks WHERE project_id = ?').bind(projectId).all<{ id: string; title: string }>(),
      this.env.DB.prepare('SELECT id, title FROM plans WHERE project_id = ?').bind(projectId).all<{ id: string; title: string }>(),
      this.env.DB.prepare('SELECT id, name FROM docs WHERE project_id = ?').bind(projectId).all<{ id: string; name: string }>(),
      this.env.DB.prepare('SELECT id, title FROM milestones WHERE project_id = ?').bind(projectId).all<{ id: string; title: string }>(),
      this.env.DB.prepare('SELECT id, name FROM agents WHERE project_id = ?').bind(projectId).all<{ id: string; name: string }>(),
      this.env.DB.prepare(
        `SELECT DISTINCT pt.task_id AS taskId, ph.plan_id AS planId FROM phase_tasks pt
         JOIN phases ph ON ph.id = pt.phase_id JOIN plans pl ON pl.id = ph.plan_id WHERE pl.project_id = ?`,
      ).bind(projectId).all<{ taskId: string; planId: string }>(),
      this.env.DB.prepare(
        `SELECT td.task_id AS taskId, td.doc_id AS docId FROM task_docs td
         JOIN tasks t ON t.id = td.task_id WHERE t.project_id = ?`,
      ).bind(projectId).all<{ taskId: string; docId: string }>(),
      this.env.DB.prepare(
        `SELECT d.task_id AS taskId, d.depends_on_task_id AS dependsOnId FROM dependencies d
         JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ?`,
      ).bind(projectId).all<{ taskId: string; dependsOnId: string }>(),
      this.env.DB.prepare(
        `SELECT id AS taskId, claimed_by AS agentId FROM tasks
         WHERE project_id = ? AND claimed_by IS NOT NULL`,
      ).bind(projectId).all<{ taskId: string; agentId: string }>(),
      this.env.DB.prepare(
        `SELECT id, kind, anchor_type AS anchorType, anchor_id AS anchorId FROM runs WHERE project_id = ?`,
      ).bind(projectId).all<{ id: string; kind: string; anchorType: string | null; anchorId: string | null }>(),
    ]);
    return { tasks, plans, docs, milestones, agents, taskPlanLinks, taskDocLinks, taskDependencies, taskClaims, runs };
  }

  /** The exact relationship triples the live D1 state expects. Both rebuild and drift consume
   *  this one derivation so their add/remove sides cannot disagree. */
  private expectedProjectionEdges(state: CoordinationRelationships): ExpectedProjectionEdge[] {
    const taskIds = new Set(state.tasks.results.map((t) => t.id));
    const planIds = new Set(state.plans.results.map((p) => p.id));
    const agentIds = new Set(state.agents.results.map((a) => a.id));
    const edges: ExpectedProjectionEdge[] = [];
    for (const link of state.taskPlanLinks.results) {
      edges.push({
        category: 'phaseTasks', type: 'related_to',
        fromUri: buildEntityUri({ kind: 'task', id: link.taskId }),
        toUri: buildEntityUri({ kind: 'plan', id: link.planId }),
        provenance: 'coordination:phase_tasks',
      });
    }
    for (const link of state.taskDocLinks.results) {
      edges.push({
        category: 'taskDocs', type: 'related_to',
        fromUri: buildEntityUri({ kind: 'task', id: link.taskId }),
        toUri: buildEntityUri({ kind: 'artifact', id: link.docId }),
        provenance: 'coordination:task_docs',
      });
    }
    for (const dep of state.taskDependencies.results) {
      if (!taskIds.has(dep.dependsOnId)) continue;
      edges.push({
        category: 'dependencies', type: 'depends_on',
        fromUri: buildEntityUri({ kind: 'task', id: dep.taskId }),
        toUri: buildEntityUri({ kind: 'task', id: dep.dependsOnId }),
        provenance: 'coordination:dependencies',
      });
    }
    for (const run of state.runs.results) {
      const anchorResolves =
        (run.anchorType === 'task' && !!run.anchorId && taskIds.has(run.anchorId)) ||
        (run.anchorType === 'plan' && !!run.anchorId && planIds.has(run.anchorId));
      if (!anchorResolves) continue;
      edges.push({
        category: 'runs', type: 'related_to',
        fromUri: buildEntityUri({ kind: 'run', id: run.id }),
        toUri: buildEntityUri({ kind: run.anchorType as 'task' | 'plan', id: run.anchorId! }),
        provenance: 'coordination:runs',
      });
    }
    for (const claim of state.taskClaims.results) {
      if (!taskIds.has(claim.taskId) || !agentIds.has(claim.agentId)) continue;
      edges.push({
        category: 'ownership', type: 'owned_by',
        fromUri: buildEntityUri({ kind: 'task', id: claim.taskId }),
        toUri: buildEntityUri({ kind: 'agent', id: claim.agentId }),
        provenance: 'coordination:task_claims',
      });
    }
    return edges;
  }

  /** Only edges whose provenance proves they came from the coordination projector/rebuilder.
   *  A null/unknown provenance may be user-authored through `writeEdge` and is never repaired
   *  away merely because D1 has no matching coordination row. */
  private storedProjectedEdges(): StoredProjectedEdge[] {
    const rows = this.ctx.storage.sql.exec<{
      id: string; type: string; provenance: string | null; from_uri: string; to_uri: string;
    }>(
      `SELECT e.id, e.type, e.provenance, nf.uri AS from_uri, nt.uri AS to_uri
       FROM edges e JOIN nodes nf ON nf.id = e.from_node_id JOIN nodes nt ON nt.id = e.to_node_id
       WHERE e.provenance IS NOT NULL`,
    ).toArray();
    const projected: StoredProjectedEdge[] = [];
    for (const row of rows) {
      const category = projectionCategoryForProvenance(row.provenance);
      if (!category || !row.provenance) continue;
      projected.push({
        id: row.id, category, type: row.type, fromUri: row.from_uri, toUri: row.to_uri,
        provenance: row.provenance,
      });
    }
    return projected;
  }

  /**
   * PLNR-283's backfill, now also PLNR-320's REPAIR tool: an idempotent full-state graph
   * rebuild, sourced from this project's LIVE D1 coordination tables — never event replay — so a
   * project whose event log predates this task (or that the incremental projector never fully
   * caught up on, or that diverged because of a projector bug) still gains a connected, correct
   * graph without hand-replaying its cursor from zero. Projects every task/plan/doc/milestone/
   * agent this project currently has, plus the task<->plan (`phase_tasks`), task<->doc
   * (`task_docs`), task<->task (`dependencies`, PLNR-322), and live task->agent ownership
   * relationships the board already knows. It also reconstructs every historical memory node
   * and exact relationship still supported by stored evidence, correction lineage,
   * contradictions, or episode-agent identity; statement text is never used to guess an edge.
   * `applyCoordinationEvent` cannot draw the first two
   * from a single event's payload (a
   * `plan.created` event carries phase task COUNTS, not ids; there is no event at all for "this
   * task was added to a plan/doc"), and a `ctx.storage.transactionSync` block cannot await a
   * second D1 read mid-transaction, so this reads everything up front (`loadCoordinationRelationships`),
   * then writes it all in ONE transaction.
   *
   * PLNR-325 closed the gap PLNR-320 left open here: this method now also projects a `run` node
   * per row in this project's `runs` table, plus the `related_to` run -> anchor edge for every
   * ANCHORED run whose anchor still resolves against the live `tasks`/`plans` rows loaded above
   * (`anchor_id` is a soft ref, migration 0018 — a run anchored to a since-deleted task/plan gets
   * its node and no edge, same as a genuinely unanchored run; fabricating an edge to a node that
   * should not exist would be worse than the gap this closes). This is exactly the case that
   * matters in production: the one-time backfill (`backfillProjectionOnce` below) IS the
   * rebuild-from-empty case, and a `run.created` event that fired before the projector cursor
   * ever reached it will otherwise never draw its node/edge any other way. All runs are
   * projected regardless of `status` — nothing prunes a terminal/cancelled run's row short of
   * `deleteProject` (checked), and neither `run.created` nor `recordEpisode` filter by status
   * either, so matching them here keeps all three writers converging on the same shape. The
   * label mirrors `recordEpisode`'s existing run-node convention (`"<kind> run"`); the edge's
   * provenance follows the `coordination:<table>` grammar every other rebuild-drawn edge already
   * uses (`coordination:runs`).
   *
   * Deliberately does NOT touch `projector_cursor` — that stays `runProjector`'s own concern.
   * Rebuild also removes stale edges carrying a recognized coordination/event provenance; edges
   * with null or unknown provenance may be user-authored and are preserved. Node upserts and edge
   * triples remain idempotent, so re-running converges on the same projected graph.
   */
  async rebuildProjection(projectId: string): Promise<{ nodesWritten: number; edgesWritten: number }> {
    await this.assertProjectId(projectId);
    const now = nowIso();
    const state = await this.loadCoordinationRelationships(projectId);
    const hasStoredEvidence = this.ctx.storage.sql.exec<{ one: number }>(`SELECT 1 AS one FROM evidence LIMIT 1`).toArray().length > 0;
    const graphProjectKey = hasStoredEvidence ? await this.resolveProjectKey(projectId) : null;
    const { tasks, plans, docs, milestones, agents, runs } = state;
    const expectedEdges = this.expectedProjectionEdges(state);

    let nodesWritten = 0;
    let edgesWritten = 0;
    this.ctx.storage.transactionSync(() => {
      if (this._forceWriteFailure) throw new Error('injected write failure (test)');

      // Repair is bidirectional: remove only edges whose provenance proves this projector owns
      // them and whose backing relationship no longer exists. Unknown/null provenance is a
      // user-authored graph fact and remains untouched.
      const expectedKeysByCategory = new Map<ProjectionRelationshipCategory, Set<string>>();
      for (const edge of expectedEdges) {
        const keys = expectedKeysByCategory.get(edge.category) ?? new Set<string>();
        keys.add(projectionEdgeKey(edge));
        expectedKeysByCategory.set(edge.category, keys);
      }
      for (const edge of this.storedProjectedEdges()) {
        if (!(expectedKeysByCategory.get(edge.category)?.has(projectionEdgeKey(edge)) ?? false)) {
          this.ctx.storage.sql.exec(`DELETE FROM edges WHERE id = ?1`, edge.id);
        }
      }

      for (const t of tasks.results) {
        this.upsertGraphNode('task', buildEntityUri({ kind: 'task', id: t.id }), t.title, now);
        nodesWritten++;
      }
      for (const p of plans.results) {
        this.upsertGraphNode('plan', buildEntityUri({ kind: 'plan', id: p.id }), p.title, now);
        nodesWritten++;
      }
      for (const d of docs.results) {
        this.upsertGraphNode('artifact', buildEntityUri({ kind: 'artifact', id: d.id }), d.name, now);
        nodesWritten++;
      }
      for (const m of milestones.results) {
        this.upsertGraphNode('unknown', buildEntityUri({ kind: 'unknown', id: m.id }), m.title, now);
        nodesWritten++;
      }
      for (const a of agents.results) {
        this.upsertGraphNode('agent', buildEntityUri({ kind: 'agent', id: a.id }), a.name, now);
        nodesWritten++;
      }
      for (const r of runs.results) {
        this.upsertGraphNode('run', buildEntityUri({ kind: 'run', id: r.id }), `${r.kind} run`, now);
        nodesWritten++;
      }
      const memoryProjection = this.projectStoredMemoryRelationships(graphProjectKey, now);
      nodesWritten += memoryProjection.nodesWritten;
      edgesWritten += memoryProjection.edgesWritten;
      for (const edge of expectedEdges) {
        const fromId = this.findGraphNodeId(edge.fromUri);
        const toId = this.findGraphNodeId(edge.toUri);
        if (fromId && toId) {
          this.linkGraphEdge(edge.type, fromId, toId, now, edge.provenance);
          edgesWritten++;
        }
      }

      // ONE summary outbox event for the whole rebuild — never one per node/edge (the same
      // discipline `recordEpisode` and `projectActiveGeneration` already establish).
      const operationId = newId('op');
      this.ctx.storage.sql.exec(
        `INSERT INTO outbox (id, operation_id, verb, subject_type, subject_id, payload, created_at) VALUES (?1,?2,'memory.changed','memory',?3,?4,?5)`,
        newId('obx'),
        operationId,
        projectId,
        JSON.stringify({ operationId, entityType: 'projection-rebuild', nodesWritten, edgesWritten }),
        now,
      );
      this.ctx.storage.sql.exec(`UPDATE memory_revision SET value = value + 1 WHERE id = 0`);
      this.ctx.storage.sql.exec(
        `INSERT INTO applied_operations (operation_id, applied_at, subject_type, subject_id, result) VALUES (?1,?2,'projection-rebuild',?3,?4)`,
        operationId,
        now,
        projectId,
        JSON.stringify({ nodesWritten, edgesWritten }),
      );
    });
    this.ctx.storage.setAlarm(Date.now()).catch(() => {});
    return { nodesWritten, edgesWritten };
  }

  /**
   * PLNR-320: how far the graph has drifted from what `rebuildProjection` currently expects,
   * broken down by relationship kind. Missing edges are matched by triple regardless of their
   * stored provenance; unexpected edges are limited to recognized projector provenance so
   * user-authored graph facts are not reported as stale. Read-only — never repairs anything; a
   * human runs the manual `rebuildProjection` route once drift is non-zero.
   *
   * Wrinkle 1 (why missing-edge detection does NOT filter by `edges.provenance`): `linkGraphEdge` writes
   * provenance only on a triple's FIRST insert, and the incremental path's `event:<verb>` and
   * this method's own `coordination:<table>` are two names for the SAME converged edge — a
   * healthy graph's edges mostly carry `event:*` provenance because the incremental path
   * usually gets there first. Counting "how many `coordination:*`-provenance edges exist" would
   * read a perfectly healthy project as 100% drifted. The only correct check is existence of the
   * `(type, from, to)` triple itself, regardless of which provenance string it happens to carry
   * — exactly what `driftCategory` below does via `edgeExists`.
   *
   * Wrinkle 3 (cross-project dependencies): `loadCoordinationRelationships`'s `taskDependencies`
   * query is NOT scoped to same-project blockers — same as `rebuildProjection` itself, expected
   * edges are filtered by "is `dependsOnId` one of THIS project's own tasks" (the `taskIds` set
   * below), so a cross-project blocker is excluded from `expected` entirely, never counted as
   * missing. `mapCoordinationEvent`'s `dependency.added`/`.removed` arms make the identical
   * choice (CLAUDE.md).
   *
   * Wrinkle 2 (run edges, PLNR-325): now covered, deliberately, now that `rebuildProjection` can
   * actually draw them — drift's whole purpose is to detect a writer falling behind what the
   * repair tool can fix, and reporting nothing here once the repair path exists would itself be
   * misleading. Expected run edges are filtered the same way wrinkle 3 filters cross-project
   * dependency blockers: only ANCHORED runs whose anchor still resolves against this project's
   * live `tasks`/`plans` rows (the `taskIds`/`planIds` sets below) are expected to have an edge —
   * an unanchored run, or one anchored to a since-deleted task/plan, contributes nothing to
   * `expected`, never a false "missing".
   */
  async projectionDrift(projectId: string): Promise<ProjectionDriftReport> {
    await this.assertProjectId(projectId);
    const expected = this.expectedProjectionEdges(await this.loadCoordinationRelationships(projectId));
    const actual = this.storedProjectedEdges();
    const forCategory = (category: ProjectionRelationshipCategory) => ({
      expected: expected.filter((e) => e.category === category),
      actual: actual.filter((e) => e.category === category),
    });
    const phaseTasks = this.driftCategory(forCategory('phaseTasks'));
    const taskDocs = this.driftCategory(forCategory('taskDocs'));
    const dependencies = this.driftCategory(forCategory('dependencies'));
    const runEdges = this.driftCategory(forCategory('runs'));
    const ownership = this.driftCategory(forCategory('ownership'));
    return {
      phaseTasks, taskDocs, dependencies, runs: runEdges, ownership,
      totalMissing: phaseTasks.missing + taskDocs.missing + dependencies.missing + runEdges.missing + ownership.missing,
      totalUnexpected: phaseTasks.unexpected + taskDocs.unexpected + dependencies.unexpected + runEdges.unexpected + ownership.unexpected,
    };
  }

  /** One category's drift subtotal: for each expected (type, fromUri, toUri) triple, missing
   *  when either endpoint node does not exist yet OR the edge triple itself is absent — matched
   *  by identity, never by provenance (wrinkle 1, see `projectionDrift`'s doc comment). */
  private driftCategory(input: {
    expected: ExpectedProjectionEdge[];
    actual: StoredProjectedEdge[];
  }): ProjectionDriftCategory {
    let missing = 0;
    for (const e of input.expected) {
      const from = this.resolveNodeByUri(e.fromUri);
      const to = this.resolveNodeByUri(e.toUri);
      if (!from || !to || !this.edgeExists(e.type, from.nodeId, to.nodeId)) missing++;
    }
    const expectedKeys = new Set(input.expected.map(projectionEdgeKey));
    const unexpected = input.actual.filter((edge) => !expectedKeys.has(projectionEdgeKey(edge))).length;
    return { expected: input.expected.length, missing, unexpected };
  }

  private edgeExists(type: string, fromNodeId: string, toNodeId: string): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ one: number }>(`SELECT 1 AS one FROM edges WHERE type = ?1 AND from_node_id = ?2 AND to_node_id = ?3 LIMIT 1`, type, fromNodeId, toNodeId)
        .toArray().length > 0
    );
  }

  /**
   * PLNR-320: the automatic counterpart to the manual `/memory/graph/rebuild` route — runs
   * `rebuildProjection` EXACTLY ONCE per project, gated by the durable `_meta.backfill_version`
   * marker (see `BACKFILL_VERSION`'s own doc comment for why it is an integer, not a boolean).
   * Called from `sweepProjectDebrisForProject` (memory/lifecycle.ts) — the SAME daily
   * per-project cron sweep (and its on-demand `/memory/lifecycle-sweep` twin) that already
   * prunes staged generations and decays low-authority memories, so "automatic, once per
   * project" rides an existing, deliberate, once-a-day trigger rather than a new one. Two
   * deployment triggers were considered and rejected: `alarm()` and DO construction. Both fire
   * far more often and far less predictably than a daily sweep (any read OR write can wake a DO,
   * and — verified against the real workerd test runtime, not just in theory — a `setAlarm`,
   * even one scheduled seconds out, genuinely fires in the background whenever enough real
   * wall-clock time elapses, independent of whether the caller that scheduled it is done). Since
   * `rebuildProjection` is not a pure no-op the SECOND-plus time it runs in a given moment — it
   * always appends one outbox row and bumps `memory_revision`, by design, so a human watching
   * `health()` can see a rebuild actually happened — an unpredictable background trigger would
   * make outbox/revision counts observably nondeterministic to anything else touching that
   * project's memory around the same time. A daily sweep has no such surprise: it is already the
   * place a human expects "occasional per-project bookkeeping" to happen.
   *
   * This method itself calls `reconcile()` FIRST, before deciding whether to rebuild — never the
   * other way around, regardless of which caller reaches it. `reconcile()` catches the
   * incremental projector up to the current event log, so any edge the incremental path can draw
   * keeps its `event:<verb>` provenance. `linkGraphEdge`'s `ON CONFLICT … DO NOTHING` only writes
   * provenance on a triple's FIRST insert — running the backfill BEFORE the incremental path
   * catches up would let its `coordination:<table>` provenance win that race for a triple the
   * incremental path was about to draw anyway. The actual EDGE would be identical either way
   * (that is the whole point of convergence), but the audit trail would lie about which writer
   * actually drew it — so the order is load-bearing, not cosmetic, and living INSIDE this method
   * (not left to each caller to remember) is what makes that true regardless of caller.
   *
   * Concurrent callers are serialized with `blockConcurrencyWhile`, so the marker check,
   * reconciliation, rebuild, and marker write act as one gate and only one caller can report
   * `ran: true` for a generation.
   *
   * Idempotent beyond the marker too: `rebuildProjection`'s own graph writes are uri/triple
   * idempotent, so a crash between the rebuild committing and the marker committing just means
   * the NEXT sweep repeats a rebuild whose nodes/edges are unchanged, never a wrong one — only
   * the bookkeeping (outbox row, revision) would double up, and only in that narrow crash window.
   */
  async backfillProjectionOnce(projectId: string): Promise<{ ran: boolean; nodesWritten?: number; edgesWritten?: number }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.assertProjectId(projectId);
      const marker = this.ctx.storage.sql.exec<{ value: string }>(`SELECT value FROM _meta WHERE key = 'backfill_version'`).toArray()[0];
      if (Number(marker?.value ?? '0') >= BACKFILL_VERSION) return { ran: false };
      await this.reconcile(projectId);
      const { nodesWritten, edgesWritten } = await this.rebuildProjection(projectId);
      this.ctx.storage.sql.exec(
        `INSERT INTO _meta (key, value) VALUES ('backfill_version', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1`,
        String(BACKFILL_VERSION),
      );
      return { ran: true, nodesWritten, edgesWritten };
    });
  }

  override async alarm(): Promise<void> {
    const pid = this._pid ?? (await this.ctx.storage.get<string>('pid'));
    if (!pid) return;
    try {
      // This is the automatic bridge in both directions: memory outbox -> ProjectRoom and D1
      // coordination events -> the memory graph. Calling only drainOutbox left runProjector with
      // no production caller and made every coordination node depend on a manual admin rebuild.
      const result = await this.reconcile(pid);
      // drainOutbox reports per-row failures instead of throwing so one bad delivery does not
      // block later rows. Rearm explicitly whenever any remain; otherwise a quiet project would
      // leave the failed row pending forever because no later mutation would set another alarm.
      if (result.failed > 0) await this.ctx.storage.setAlarm(Date.now() + 5_000);
    } catch (err) {
      await this.ctx.storage.setAlarm(Date.now() + 5_000).catch(() => {});
      console.warn(`ProjectMemory alarm reconcile failed for ${pid}: ${String(err)}`);
      throw err;
    }
  }

  async _countNodes(projectId: string): Promise<number> {
    await this.assertProjectId(projectId);
    return this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM nodes`).toArray()[0]?.n ?? 0;
  }

  async _countEdges(projectId: string): Promise<number> {
    await this.assertProjectId(projectId);
    return this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM edges`).toArray()[0]?.n ?? 0;
  }

  /** Test-only: an edge's stored `provenance` (0010, PLNR-283), resolved by its `(type,
   *  from-uri, to-uri)` triple — so provenance-tagging tests can assert without a wider query
   *  surface. `null` both when the edge carries no provenance and when either endpoint/the edge
   *  itself does not exist — callers that need to tell those apart assert existence separately. */
  async _edgeProvenance(projectId: string, type: string, fromUri: string, toUri: string): Promise<string | null> {
    await this.assertProjectId(projectId);
    const from = this.resolveNodeByUri(fromUri);
    const to = this.resolveNodeByUri(toUri);
    if (!from || !to) return null;
    return (
      this.ctx.storage.sql
        .exec<{ provenance: string | null }>(
          `SELECT provenance FROM edges WHERE type = ?1 AND from_node_id = ?2 AND to_node_id = ?3`,
          type,
          from.nodeId,
          to.nodeId,
        )
        .toArray()[0]?.provenance ?? null
    );
  }

  /** Test-only: a table's stored CREATE TABLE text. Exists so a restore test can assert the
   *  live SCHEMA is unchanged, not just the row counts — the original rename-based activation
   *  corrupted FK clauses and quoted table names while leaving every count correct. */
  async _tableDdl(projectId: string, table: string): Promise<string> {
    await this.assertProjectId(projectId);
    return (
      this.ctx.storage.sql
        .exec<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1`, table)
        .toArray()[0]?.sql ?? '(no such table)'
    );
  }

  /** Test-only: a staged (never activated) index generation with a caller-chosen created_at,
   *  so PLNR-250's staged-generation pruning can be tested without waiting out its real max
   *  age. Seeds the repository row too if it doesn't already exist (the FK target). */
  async _seedStagedIndexGeneration(projectId: string, repositoryKey: string, createdAt: string): Promise<string> {
    await this.assertProjectId(projectId);
    const id = newId('gen');
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO repositories (repository_key, created_at) VALUES (?1, ?2) ON CONFLICT (repository_key) DO NOTHING`,
        repositoryKey,
        createdAt,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO index_generations (id, repository_key, branch, base_id, indexer_version, batch_count, file_count, content_hash, status, created_at)
         VALUES (?1, ?2, 'main', 'deadbeef', 'test', 1, 1, 'sha256:test', 'staged', ?3)`,
        id,
        repositoryKey,
        createdAt,
      );
    });
    return id;
  }

  async _countIndexGenerations(projectId: string): Promise<number> {
    await this.assertProjectId(projectId);
    return this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM index_generations`).toArray()[0]?.n ?? 0;
  }

  /** Test-only: a 'superseded' index generation with a caller-chosen `activatedAt`, so
   *  PLNR-256's `pruneSupersededGenerations` can be tested without waiting out its real max
   *  age — same reason as `_seedStagedIndexGeneration`. */
  async _seedSupersededIndexGenerationForTest(projectId: string, repositoryKey: string, activatedAt: string): Promise<string> {
    await this.assertProjectId(projectId);
    const id = newId('gen');
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO repositories (repository_key, created_at) VALUES (?1, ?2) ON CONFLICT (repository_key) DO NOTHING`,
        repositoryKey,
        activatedAt,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO index_generations (id, repository_key, branch, base_id, indexer_version, batch_count, file_count, content_hash, status, created_at, activated_at)
         VALUES (?1, ?2, 'main', 'deadbeef', 'test', 1, 1, 'sha256:test', 'superseded', ?3, ?3)`,
        id,
        repositoryKey,
        activatedAt,
      );
    });
    return id;
  }

  /** Test-only: this generation's current status — so PLNR-256's activation tests can assert
   *  the transition (active → superseded, new → active) without a wider query surface. */
  async _getIndexGenerationStatusForTest(projectId: string, generationId: string): Promise<string | null> {
    await this.assertProjectId(projectId);
    return (
      this.ctx.storage.sql.exec<{ status: string }>(`SELECT status FROM index_generations WHERE id = ?1`, generationId).toArray()[0]?.status ?? null
    );
  }

  /** Test-only: return one episode body so merge regressions can assert fields that the public
   * retrieval projection intentionally does not expose. */
  async _getEpisodeForTest(projectId: string, runId: string, sitting = 1): Promise<EffortEpisodeData | null> {
    await this.assertProjectId(projectId);
    const row = this.ctx.storage.sql
      .exec<{ body: string }>(`SELECT body FROM episodes WHERE run_id = ?1 AND sitting = ?2`, runId, sitting)
      .toArray()[0];
    return row ? EffortEpisode.parse(JSON.parse(row.body)) : null;
  }

  /** Test-only visibility for generation activation/rebuild invariants. */
  async _getAnalyticsForTest(projectId: string): Promise<{
    activeGenerationId: string | null;
    generations: Array<{
      id: string; status: string; baseGenerationId: string | null;
      checksum: string | null; rowCount: number; error: string | null;
    }>;
    rows: Array<{ generationId: string; runId: string; sitting: number; normalized: Record<string, unknown> }>;
  }> {
    await this.assertProjectId(projectId);
    const activeGenerationId = this.ctx.storage.sql.exec<{ generation_id: string | null }>(
      `SELECT generation_id FROM analytics_active_generation WHERE id = 0`,
    ).toArray()[0]?.generation_id ?? null;
    const generations = this.ctx.storage.sql.exec<{
      id: string; status: string; baseGenerationId: string | null;
      checksum: string | null; rowCount: number; error: string | null;
    }>(
      `SELECT id, status, base_generation_id AS baseGenerationId, checksum, row_count AS rowCount, error
         FROM analytics_generations ORDER BY created_at, id`,
    ).toArray();
    const rows = this.ctx.storage.sql.exec<{
      generationId: string; runId: string; sitting: number; normalized: string;
    }>(
      `SELECT generation_id AS generationId, run_id AS runId, sitting, normalized
         FROM analytics_rows ORDER BY generation_id, run_id, sitting`,
    ).toArray().map((row) => ({ ...row, normalized: JSON.parse(row.normalized) as Record<string, unknown> }));
    return { activeGenerationId, generations, rows };
  }

  /** Test-only simulation of disposable read-model loss. Canonical episodes are untouched. */
  async _clearAnalyticsForTest(projectId: string): Promise<void> {
    await this.assertProjectId(projectId);
    this.ctx.storage.transactionSync(() => {
      this.clearAnalyticsDerived();
    });
  }

  /** Test-only: overwrite a `_meta` value directly — used to backdate
   *  `prior_generation_created_at` so retained-generation pruning can be tested without waiting
   *  out its real rollback window. Deliberately narrow (one table, key/value only), not a
   *  general query surface. */
  async _setMetaForTest(projectId: string, key: string, value: string): Promise<void> {
    await this.assertProjectId(projectId);
    this.ctx.storage.sql.exec(
      `INSERT INTO _meta (key, value) VALUES (?1, ?2)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  /** Test-only: remove the graph projection while preserving every durable source row. This
   *  models a project whose memories/episodes predate graph projection so the versioned
   *  backfill can be exercised against the real reconstruction inputs. */
  async _clearGraphForTest(projectId: string): Promise<void> {
    await this.assertProjectId(projectId);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`DELETE FROM edges`);
      this.ctx.storage.sql.exec(`DELETE FROM nodes`);
    });
  }

  /** Test-only: backdate a memory item's `recorded_at` — so decay-age eligibility (PLNR-254)
   *  can be tested without waiting out the real retention window. Same reason as
   *  `_setMetaForTest`/`_seedStagedIndexGeneration`'s custom `createdAt`. */
  async _setMemoryRecordedAtForTest(projectId: string, memoryId: string, recordedAt: string): Promise<void> {
    await this.assertProjectId(projectId);
    this.ctx.storage.sql.exec(`UPDATE memory_items SET recorded_at = ?1 WHERE id = ?2`, recordedAt, memoryId);
  }

  /** Test-only: a node's stored type/label, resolved by uri — thin public wrapper over
   *  `resolveNodeByUri` so PLNR-314's label-excerpt fix can be asserted without a wider query
   *  surface. */
  async _nodeByUriForTest(projectId: string, uri: string): Promise<{ nodeId: string; type: string; label: string } | null> {
    await this.assertProjectId(projectId);
    const node = this.resolveNodeByUri(uri);
    return node ? { nodeId: node.nodeId, type: node.type, label: node.label } : null;
  }

  /** Test-only: force a node's label directly, bypassing every real writer — simulates a row
   *  written by pre-PLNR-314 code (label == bare `kind`), which a fresh test DO can never
   *  otherwise produce since `recordMemory` already writes the fixed label and migrations only
   *  run once, at construction. Paired with `_reapplyMemoryNodeLabelBackfillForTest` below to
   *  exercise the 0011 backfill's SQL against exactly that corrupted state. */
  async _setNodeLabelForTest(projectId: string, uri: string, label: string): Promise<void> {
    await this.assertProjectId(projectId);
    this.ctx.storage.sql.exec(`UPDATE nodes SET label = ?1 WHERE uri = ?2`, label, uri);
  }

  /** Test-only: re-run memory-migration 0011's backfill SQL directly (PLNR-314). The real
   *  migration only runs once, at construction, gated by `_meta.schema_version` — a fresh test
   *  DO lands on the latest schema immediately and never observes 0011 transform a genuinely
   *  pre-fix row. This runs the SAME SQL text (looked up from `MEMORY_MIGRATIONS`, never a
   *  hand-copied duplicate that could drift from the shipped file) against whatever `nodes.label`
   *  currently holds, proving the backfill itself — not just `recordMemory`'s write path — derives
   *  a statement excerpt. Safe to call more than once: the backfill re-derives the same label
   *  from the same `memory_items` row every time. */
  async _reapplyMemoryNodeLabelBackfillForTest(projectId: string): Promise<void> {
    await this.assertProjectId(projectId);
    const migration = MEMORY_MIGRATIONS.find((m) => m.name === '0011_memory_node_labels');
    if (!migration) throw new Error('memory-migration 0011_memory_node_labels not found in MEMORY_MIGRATIONS');
    this.ctx.storage.sql.exec(migration.sql);
  }

  /** Test-only: every edge in this project's graph as a (type, fromUri, toUri, provenance)
   *  tuple, resolved through `nodes` and sorted for a stable diff — PLNR-320's centrepiece
   *  convergence assertion snapshots this before and after `rebuildProjection` and expects it
   *  BYTE-IDENTICAL, which a bare count could not catch (same length, different membership, or
   *  the same triples with a changed provenance would both slip past a count-only check). */
  async _allEdgesForTest(projectId: string): Promise<Array<{ type: string; fromUri: string; toUri: string; provenance: string | null }>> {
    await this.assertProjectId(projectId);
    const rows = this.ctx.storage.sql
      .exec<{ type: string; from_uri: string; to_uri: string; provenance: string | null }>(
        `SELECT e.type AS type, nf.uri AS from_uri, nt.uri AS to_uri, e.provenance AS provenance
         FROM edges e JOIN nodes nf ON nf.id = e.from_node_id JOIN nodes nt ON nt.id = e.to_node_id
         ORDER BY e.type, nf.uri, nt.uri`,
      )
      .toArray();
    return rows.map((r) => ({ type: r.type, fromUri: r.from_uri, toUri: r.to_uri, provenance: r.provenance }));
  }

}
