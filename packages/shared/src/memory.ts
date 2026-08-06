import { z } from 'zod';
import { RepoPath } from './execution-spec';
import { RunModelUsage } from './runner';

// ---------------------------------------------------------------------------
// Project Memory — shared entities, stable URIs, and wire contracts (PLNR-244,
// Phase 1 of the Project Memory plan; see the "Project Memory — settled
// architecture decisions" doc, referenced below by section as "§n").
//
// SCOPE OF THIS FILE: runtime-neutral zod schemas + types + the entity-URI
// helpers every later phase builds on. No ProjectMemory Durable Object, no D1
// registry, no outbox, no MCP tool, no Vectorize wiring, no Runner code lives
// here — those are PLNR-245 through PLNR-277. This is the one wire shape both
// the server and the (future, vendoring) Runner agree on before either is
// built against it.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Repository and revision identity (§6, §16)
// ---------------------------------------------------------------------------

/**
 * The canonical, project-local repository identity — committed in
 * `.noriq/project.toml`. Stable across re-clones, machine changes, and
 * multiple checkouts of the same repo, which is exactly what a runner-local
 * checkout id is NOT (see `RunnerCheckoutId` below). A short slug, not a path.
 */
export const RepositoryKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9._-]*$/, {
    message: 'must be a short slug (letters, digits, `.`, `_`, `-`), starting with a letter',
  })
  .refine((k) => !k.startsWith('ckt_'), {
    message: 'looks like a runner-local checkout id (§6/§16), not a canonical repository key',
  });
export type RepositoryKey = z.infer<typeof RepositoryKey>;

/**
 * A runner-local checkout/machine identity (§6, §16) — RepoIntel's own key space.
 * Branded so passing one where a `RepositoryKey` is expected is a TYPE ERROR, not
 * a convention someone has to remember; the `ckt_` prefix also makes the two
 * distinguishable at runtime, so a checkout id handed to `RepositoryKey.parse`
 * fails loudly instead of silently validating as a canonical key.
 */
export const RunnerCheckoutId = z
  .string()
  .regex(/^ckt_[A-Za-z0-9]+$/, {
    message: 'a runner-local checkout id is opaque and prefixed `ckt_` — never a canonical repository key',
  })
  .brand('RunnerCheckoutId');
export type RunnerCheckoutId = z.infer<typeof RunnerCheckoutId>;

/**
 * A revision identity in its OWNING VCS backend's own id space (§6) — a Git SHA,
 * a Perforce changelist number, a Diversion commit id. Deliberately just a
 * non-empty string, compared only for equality: parsing this as a Git hash
 * would silently break every non-Git backend. No shared code may format-check,
 * shorten, or normalize a `baseId`.
 */
export const BaseId = z.string().min(1);
export type BaseId = z.infer<typeof BaseId>;

/**
 * A concrete branch name, or a symbolic branch class ("default", "integration")
 * when no single branch applies to the evidence being cited (§1). One field
 * because a consumer treats both the same way: a scope to validate `baseId`
 * freshness against.
 */
export const BranchRef = z.string().min(1);
export type BranchRef = z.infer<typeof BranchRef>;

// ---------------------------------------------------------------------------
// Evidence, authority, and validity (§1, §12, §15)
// ---------------------------------------------------------------------------

export const VerificationState = z.enum(['valid', 'moved', 'changed', 'missing', 'unverifiable']);
export type VerificationState = z.infer<typeof VerificationState>;

/**
 * A repository citation backing a memory (§1). Retrieval verifies this against
 * the best current source available before presenting the memory it belongs
 * to; an evidence set that fails verification demotes its memory to a lead,
 * never an instruction (§13).
 */
export const EvidenceRef = z.object({
  repositoryKey: RepositoryKey,
  branch: BranchRef,
  baseId: BaseId,
  path: RepoPath,
  symbol: z.string().min(1).nullable().default(null),
  contentHash: z.string().min(1).nullable().default(null),
  verificationState: VerificationState.default('unverifiable'),
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

/**
 * The five-level authority scale (§12). Higher is stronger; promotion between
 * levels is PLNR-253/266's job, not this schema's — this only fixes the wire
 * values every later phase transitions between.
 *
 *   5 — human-approved decision
 *   4 — verified against merged code or passing tests
 *   3 — repeated successful observation
 *   2 — single-agent observation
 *   1 — hypothesis or unverified inference
 */
export const AuthorityLevel = z.number().int().min(1).max(5);
export type AuthorityLevel = z.infer<typeof AuthorityLevel>;

export const AUTHORITY_HUMAN_APPROVED = 5;
export const AUTHORITY_VERIFIED_MERGED = 4;
export const AUTHORITY_REPEATED_OBSERVATION = 3;
export const AUTHORITY_SINGLE_OBSERVATION = 2;
export const AUTHORITY_HYPOTHESIS = 1;

// ---------------------------------------------------------------------------
// Memory — the one kind-driven recording surface (§11)
// ---------------------------------------------------------------------------

/**
 * What an agent (or a human) is recording. Feedback, correction, contradiction,
 * and supersession are OPERATIONS on a `MemoryItem` (see `supersedesMemoryId`
 * below), not separate kinds or record types — the agent-facing tool catalogue
 * must not multiply (§11, PLNR-252).
 */
export const MemoryKind = z.enum([
  'learning',
  'decision',
  'failed_approach',
  'procedure',
  'requirement',
  'hazard',
  'unknown',
]);
export type MemoryKind = z.infer<typeof MemoryKind>;

/**
 * A recorded memory candidate. `statement` is untrusted model output the
 * moment it is written by anyone but a human (§13) — every consumer renders it
 * inside a bounded quoted-evidence frame, never in instruction position.
 * Versioning is `supersedesMemoryId`: a new version links back rather than
 * overwriting, so history is never destructively erased (§12).
 */
export const MemoryItem = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: MemoryKind,
  statement: z.string().min(1),
  authority: AuthorityLevel.default(AUTHORITY_HYPOTHESIS),
  confidence: z.number().min(0).max(1).nullable().default(null),
  evidence: z.array(EvidenceRef).default([]),
  supersedesMemoryId: z.string().nullable().default(null),
  recordedByAgentId: z.string().nullable().default(null),
  recordedAt: z.string().datetime(),
});
export type MemoryItem = z.infer<typeof MemoryItem>;

// ---------------------------------------------------------------------------
// The project knowledge graph (§5)
// ---------------------------------------------------------------------------

/**
 * The fixed graph node vocabulary. Broader than the entity-URI kinds below —
 * it also covers internal graph-only nodes (branch, revision, agent, error,
 * API, database entity, project) that are not independently addressable
 * top-level entities.
 */
export const MemoryNodeType = z.enum([
  'project',
  'repository',
  'branch',
  'revision',
  'file',
  'symbol',
  'api',
  'database_entity',
  'test',
  'task',
  'plan',
  'run',
  'agent',
  'decision',
  'memory',
  'error',
  'requirement',
  'procedure',
  'episode',
  'artifact',
  'unknown',
]);
export type MemoryNodeType = z.infer<typeof MemoryNodeType>;

export const MemoryEdgeType = z.enum([
  'declares',
  'calls',
  'imports',
  'depends_on',
  'tests',
  'implements',
  'modifies',
  'observed_in',
  'decided_by',
  'supersedes',
  'contradicts',
  'blocks',
  'related_to',
  'failed_because',
  'validated_by',
  'owned_by',
  'commonly_changes_with',
  'derived_from',
]);
export type MemoryEdgeType = z.infer<typeof MemoryEdgeType>;

/**
 * A durable typed node (§5). `uri` is this node's stable entity URI
 * (`buildEntityUri`) — the `.refine` below rejects a malformed URI and a URI
 * whose own embedded project (for repository-scoped kinds) disagrees with
 * this node's `projectKey`, so a graph edge can never silently cross projects
 * through a bad reference.
 */
export const MemoryNode = z
  .object({
    id: z.string(),
    projectKey: z.string().min(1).max(8),
    type: MemoryNodeType,
    uri: z.string().min(1),
    label: z.string().min(1),
  })
  .refine(
    (node) => {
      const parsed = safeParseEntityUri(node.uri);
      if (!parsed) return false;
      if ('projectKey' in parsed && parsed.projectKey !== node.projectKey) return false;
      return true;
    },
    { message: 'uri must be a well-formed entity URI belonging to this node\'s project' },
  );
export type MemoryNode = z.infer<typeof MemoryNode>;

export const MemoryEdge = z.object({
  projectKey: z.string().min(1).max(8),
  type: MemoryEdgeType,
  fromNodeId: z.string(),
  toNodeId: z.string(),
});
export type MemoryEdge = z.infer<typeof MemoryEdge>;

// ---------------------------------------------------------------------------
// Effort episodes (§14)
// ---------------------------------------------------------------------------

export const EpisodeTimelineEntry = z.object({
  at: z.string().datetime(),
  label: z.string().min(1),
});
export type EpisodeTimelineEntry = z.infer<typeof EpisodeTimelineEntry>;

export const EpisodeFinding = z.object({
  summary: z.string().min(1),
  severity: z.enum(['info', 'low', 'medium', 'high']).default('info'),
});
export type EpisodeFinding = z.infer<typeof EpisodeFinding>;

/**
 * The optional final agent self-summary (§14) — enrichment only. Deliberately
 * NOT load-bearing: `EffortEpisode.selfSummary` below catches a malformed
 * value rather than rejecting the whole episode, because a model's own
 * summary can never be a validity dependency for telemetry the daemon and
 * server already captured deterministically.
 */
export const EpisodeSelfSummary = z.object({
  approachSummary: z.string().default(''),
  rejectedHypotheses: z.array(z.string()).default([]),
  durableLearnings: z.array(z.string()).default([]),
  unresolvedQuestions: z.array(z.string()).default([]),
});
export type EpisodeSelfSummary = z.infer<typeof EpisodeSelfSummary>;

export const EpisodeLandingOutcome = z.enum(['landed', 'not_landed', 'failed', 'pending']);
export type EpisodeLandingOutcome = z.infer<typeof EpisodeLandingOutcome>;

/**
 * Every terminal run produces one of these (§14). The skeleton
 * (everything but `selfSummary`) is REQUIRED and built entirely from
 * deterministic Runner/server telemetry — a failed run that disproves an
 * approach is useful project progress and remains retrievable.
 */
export const EffortEpisode = z.object({
  id: z.string(),
  projectId: z.string(),
  runId: z.string(),
  taskId: z.string().nullable().default(null),
  repositoryKey: RepositoryKey.nullable().default(null),
  baseId: BaseId.nullable().default(null),
  timeline: z.array(EpisodeTimelineEntry).default([]),
  filesTouched: z.array(RepoPath).default([]),
  commands: z.array(z.string()).default([]),
  testsRun: z.array(z.string()).default([]),
  failures: z.array(z.string()).default([]),
  findings: z.array(EpisodeFinding).default([]),
  reviewRounds: z.number().int().nonnegative().default(0),
  tokenUsage: RunModelUsage.default({}),
  costUSD: z.number().nonnegative().default(0),
  acceptanceCoverage: z.number().min(0).max(1).nullable().default(null),
  steeringEvents: z.array(z.string()).default([]),
  landingOutcome: EpisodeLandingOutcome.default('pending'),
  remainingWork: z.array(z.string()).default([]),
  // Absent OR malformed both leave the episode valid (§14) — `.catch(null)` swallows a bad
  // self-summary rather than failing the whole record's parse.
  selfSummary: EpisodeSelfSummary.nullable().default(null).catch(null),
  createdAt: z.string().datetime(),
});
export type EffortEpisode = z.infer<typeof EffortEpisode>;

// ---------------------------------------------------------------------------
// Repository ingest — index generations and batches (§7, §8)
// ---------------------------------------------------------------------------

/**
 * The manifest for one staged index generation (§8). Stays staged — queryable
 * only as "pending" — until its counts, hashes, and deletions validate; only
 * then does one atomic activation transaction select it as the project's
 * active generation for this repository.
 */
export const IndexGenerationManifest = z.object({
  generationId: z.string().min(1),
  projectId: z.string(),
  repositoryKey: RepositoryKey,
  branch: BranchRef,
  baseId: BaseId,
  indexerVersion: z.string().min(1),
  batchCount: z.number().int().positive(),
  fileCount: z.number().int().nonnegative(),
  contentHash: z.string().min(1),
  deletions: z.array(RepoPath).default([]),
  createdAt: z.string().datetime(),
});
export type IndexGenerationManifest = z.infer<typeof IndexGenerationManifest>;

/**
 * One idempotent unit of a generation's ingest (§8) — idempotency key is
 * (project, repository, branch, baseId, indexer version, batch number), i.e.
 * `generationId` (which already encodes the first five) plus `batchNumber`.
 */
export const IndexBatch = z.object({
  generationId: z.string().min(1),
  batchNumber: z.number().int().nonnegative(),
  batchHash: z.string().min(1),
});
export type IndexBatch = z.infer<typeof IndexBatch>;

// ---------------------------------------------------------------------------
// Context packs (§10)
// ---------------------------------------------------------------------------

/**
 * The assembled result of `get_task_context(taskId, branch, baseId,
 * tokenBudget)` (§10) — bounded working memory for one task, not a bag of
 * disconnected vector chunks. Entities are referenced by their stable URIs so
 * a consumer can re-fetch or cite them.
 */
export const ContextPack = z.object({
  taskId: z.string(),
  projectId: z.string(),
  branch: BranchRef.nullable().default(null),
  baseId: BaseId.nullable().default(null),
  tokenBudget: z.number().int().positive().nullable().default(null),
  verifiedDecisions: z.array(MemoryItem).default([]),
  relevantEntities: z.array(z.string().min(1)).default([]), // entity URIs
  similarEpisodes: z.array(z.string().min(1)).default([]), // episode ids
  knownHazards: z.array(MemoryItem).default([]),
  affectedTests: z.array(z.string().min(1)).default([]), // entity URIs (kind: 'test')
  activeNeighboringWork: z.array(z.string().min(1)).default([]), // task ids
  staleWarnings: z.array(z.string().min(1)).default([]),
  generatedAt: z.string().datetime(),
});
export type ContextPack = z.infer<typeof ContextPack>;

// ---------------------------------------------------------------------------
// Backup manifests (§17)
// ---------------------------------------------------------------------------

/**
 * A portable logical snapshot's manifest (§17). Restore imports into a new
 * dataset generation, validates `tableCounts`/`checksums` against what was
 * actually imported, and only then atomically switches the active generation.
 */
export const MemoryBackupManifest = z.object({
  formatVersion: z.number().int().positive(),
  projectMemorySchemaVersion: z.number().int().positive(),
  projectId: z.string(),
  memoryRevision: z.number().int().nonnegative(),
  exportedAt: z.string().datetime(),
  // core = authored/historical memory, evidence, decisions, episodes, feedback, graph, cursors,
  // and the index-generation REGISTRY rows. full additionally includes active code-index
  // generation CONTENT (§17) — which does not exist before Phase 5, so `full` today carries
  // exactly what `core` does; the flag exists so the manifest format never has to change shape
  // when Phase 5 fills that tier in.
  tier: z.enum(['core', 'full']).default('core'),
  tableCounts: z.record(z.string(), z.number().int().nonnegative()),
  checksums: z.record(z.string(), z.string()),
  activeIndexGenerations: z
    .array(z.object({ repositoryKey: RepositoryKey, generationId: z.string().min(1) }))
    .default([]),
  r2EvidenceRefs: z.array(z.string().min(1)).default([]),
});
export type MemoryBackupManifest = z.infer<typeof MemoryBackupManifest>;

// ---------------------------------------------------------------------------
// Stable entity URIs (§18)
//
// Identity never embeds an index generation, a baseId, or a runner-local id —
// that is the scaling seam §18 reserves for moving large repository code
// intelligence to its own store without changing agent-facing identities.
// Two shapes:
//
//   noriq://{kind}/{id}                                        — global kinds,
//     for entities Noriq already mints a globally-unique id for.
//   noriq://{kind}/{projectKey}/{repositoryKey}[/{path}][#{name}] — repository-
//     scoped kinds, project-local by construction.
// ---------------------------------------------------------------------------

// A project key as it appears embedded in a URI. Deliberately re-declared here
// rather than imported from `./manifest` — manifest.ts imports `RepositoryKey`
// FROM this file (it hosts the committed `[index]`/`repositoryKey` fields), so
// importing manifest's `ProjectKey` back would be a cycle. Same shape as
// `ProjectKey` there (`z.string().min(1).max(8)`) by construction, not by import.
const EntityProjectKey = z.string().min(1).max(8);
const GlobalEntityId = z.string().min(1);

/**
 * Every addressable entity kind (§18, task body): 11 global kinds — Noriq
 * already mints a globally-unique id for each — plus 4 repository-scoped
 * kinds that are project-local by construction. One explicit literal per
 * kind, rather than building the union from an array, so the discriminated
 * union's per-branch typing stays exact with no cast.
 */
export const EntityRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), id: GlobalEntityId }),
  z.object({ kind: z.literal('plan'), id: GlobalEntityId }),
  z.object({ kind: z.literal('run'), id: GlobalEntityId }),
  z.object({ kind: z.literal('decision'), id: GlobalEntityId }),
  z.object({ kind: z.literal('memory'), id: GlobalEntityId }),
  z.object({ kind: z.literal('episode'), id: GlobalEntityId }),
  z.object({ kind: z.literal('requirement'), id: GlobalEntityId }),
  z.object({ kind: z.literal('procedure'), id: GlobalEntityId }),
  z.object({ kind: z.literal('hazard'), id: GlobalEntityId }),
  z.object({ kind: z.literal('artifact'), id: GlobalEntityId }),
  z.object({ kind: z.literal('unknown'), id: GlobalEntityId }),
  z.object({ kind: z.literal('repository'), projectKey: EntityProjectKey, repositoryKey: RepositoryKey }),
  z.object({
    kind: z.literal('file'),
    projectKey: EntityProjectKey,
    repositoryKey: RepositoryKey,
    path: RepoPath,
  }),
  z.object({
    kind: z.literal('symbol'),
    projectKey: EntityProjectKey,
    repositoryKey: RepositoryKey,
    path: RepoPath,
    name: z.string().min(1),
  }),
  z.object({
    kind: z.literal('test'),
    projectKey: EntityProjectKey,
    repositoryKey: RepositoryKey,
    path: RepoPath,
    name: z.string().min(1),
  }),
  // api/database_entity (PLNR-278) — added so PLNR-262 can project CodeEntityType's api and
  // database_entity kinds; `nodes.type`'s CHECK constraint already permits both (0001), so this
  // is a pure schema widening with no migration. An API endpoint is declared at a path like a
  // symbol, so it takes the same {path}#{name} shape; a database entity (a table, a schema
  // object) is not reliably one-file-one-entity, so it stays path-free — a repository-scoped
  // name only. The first stored URI locks the shape, so this is a deliberate choice, not a
  // placeholder: revisit only by adding a NEW kind, never by editing these arms once anything
  // has stored a URI built from them.
  z.object({
    kind: z.literal('api'),
    projectKey: EntityProjectKey,
    repositoryKey: RepositoryKey,
    path: RepoPath,
    name: z.string().min(1),
  }),
  z.object({
    kind: z.literal('database_entity'),
    projectKey: EntityProjectKey,
    repositoryKey: RepositoryKey,
    name: z.string().min(1),
  }),
]);
export type EntityRef = z.infer<typeof EntityRef>;

const GLOBAL_KIND_SET: ReadonlySet<string> = new Set([
  'task',
  'plan',
  'run',
  'decision',
  'memory',
  'episode',
  'requirement',
  'procedure',
  'hazard',
  'artifact',
  'unknown',
]);

/**
 * Build a stable entity URI from a ref. The inverse of `parseEntityUri`.
 *
 * Fragment convention (settled here for PLNR-262 to respect, PLNR-278): the FIRST `#` in the
 * rest-of-URI separates a repository-scoped kind's `path` from its `name` — `symbol`, `test`,
 * and now `api` all use it. This is a PRE-EXISTING collision the code index's chunk ids must
 * not make worse: `code-index.ts`'s `vecId` appends `#<n>` to a chunk-0-elided uri, so a
 * multi-chunk symbol/test/api entity's vector id already looks like `…#name#3`, and
 * `entityRefCandidate` (splitting on the FIRST `#`) reads that back as `name: "name#3"`. Fixing
 * that chunk-id/name collision is PLNR-262's job (it must use a separator its own chunk suffix
 * cannot produce, e.g. one that never appears in a `#name` fragment) — this file only fixes the
 * kind-segment regex so an UNDERSCORED kind can be parsed at all; it does not change what `#`
 * itself means.
 */
export function buildEntityUri(ref: EntityRef): string {
  switch (ref.kind) {
    case 'repository':
      return `noriq://repository/${ref.projectKey}/${ref.repositoryKey}`;
    case 'file':
      return `noriq://file/${ref.projectKey}/${ref.repositoryKey}/${ref.path}`;
    case 'symbol':
    case 'test':
    case 'api':
      return `noriq://${ref.kind}/${ref.projectKey}/${ref.repositoryKey}/${ref.path}#${ref.name}`;
    case 'database_entity':
      return `noriq://database_entity/${ref.projectKey}/${ref.repositoryKey}/${ref.name}`;
    default:
      return `noriq://${ref.kind}/${ref.id}`;
  }
}

// `[a-z_]+` (not `[a-z]+`) — the ORIGINAL blocker for `database_entity`: an arm alone is not
// enough, because this regex captured the kind segment and a non-matching URI silently became
// `{ kind: '__malformed__' }` rather than failing at the actual bug (a missing underscore).
const ENTITY_URI_RE = /^noriq:\/\/([a-z_]+)\/(.*)$/;

/**
 * Decompose a URI string into a candidate object for `EntityRef.parse` — never
 * throws, never validates; an unrecognized shape becomes `{ kind:
 * '__malformed__' }`, a discriminator no variant matches, so the one call site
 * that actually parses (`EntityRef.parse`/`.safeParse`) produces zod's own
 * "invalid discriminator" error instead of this function hand-rolling one.
 */
function entityRefCandidate(uri: string): unknown {
  const match = ENTITY_URI_RE.exec(uri);
  if (!match) return { kind: '__malformed__' };
  const kind = match[1] ?? '';
  const rest = match[2] ?? '';
  if (GLOBAL_KIND_SET.has(kind)) return { kind, id: rest };
  if (kind === 'repository') {
    const [projectKey, repositoryKey] = rest.split('/');
    return { kind, projectKey, repositoryKey };
  }
  if (kind === 'file') {
    const [projectKey, repositoryKey, ...pathParts] = rest.split('/');
    return { kind, projectKey, repositoryKey, path: pathParts.join('/') };
  }
  if (kind === 'symbol' || kind === 'test' || kind === 'api') {
    const hashIndex = rest.indexOf('#');
    const withoutName = hashIndex === -1 ? rest : rest.slice(0, hashIndex);
    const name = hashIndex === -1 ? undefined : rest.slice(hashIndex + 1);
    const [projectKey, repositoryKey, ...pathParts] = withoutName.split('/');
    return { kind, projectKey, repositoryKey, path: pathParts.join('/'), name };
  }
  if (kind === 'database_entity') {
    const [projectKey, repositoryKey, ...nameParts] = rest.split('/');
    return { kind, projectKey, repositoryKey, name: nameParts.join('/') };
  }
  return { kind: '__malformed__' };
}

/**
 * Parse a stable entity URI. Throws a `ZodError` on anything malformed —
 * wrong scheme, unknown kind, a repository-scoped URI missing a segment, a
 * symbol/test URI missing its `#name`.
 */
export function parseEntityUri(uri: string): EntityRef {
  return EntityRef.parse(entityRefCandidate(uri));
}

/** `parseEntityUri`, returning `null` instead of throwing — for refinements
 *  (see `MemoryNode` above) that need to react to a bad URI without a try/catch. */
function safeParseEntityUri(uri: string): EntityRef | null {
  const result = EntityRef.safeParse(entityRefCandidate(uri));
  return result.success ? result.data : null;
}

// ---------------------------------------------------------------------------
// MemoryNodeType <-> EntityRef drift guard (PLNR-278)
//
// The two vocabularies had silently diverged: MemoryNodeType had 21 values, EntityRef only 15
// arms, and `hazard` was an EntityRef kind that isn't a node type at all. A node type with
// neither an EntityRef arm nor a recorded exemption below now fails at MODULE LOAD (the first
// request on any server that imports this file), rather than being rediscovered as a bug later.
// ---------------------------------------------------------------------------

/**
 * Node types that are graph-only internal nodes with no addressable EntityRef arm YET.
 * Deliberately not designed speculatively: the first URI ever built from a new arm locks its
 * shape forever (byte-identical, no migration path — see `buildEntityUri`'s doc comment), so
 * each of these gets a shape only when a real writer exists to need one:
 *   - `agent`, `error` — projected from episodes, Phase 6 onward (PLNR-263+).
 *   - `branch`, `revision` — no writer anywhere in this codebase yet.
 *   - `project` — the project itself is addressed by its D1 id/key everywhere else in this
 *     system; nothing needs it as a graph-addressable entity today.
 * Adding an arm removes the exemption in the SAME change — do not carry both.
 */
export const EXEMPT_NODE_TYPES: ReadonlySet<MemoryNodeType> = new Set(['project', 'branch', 'revision', 'agent', 'error']);

/**
 * The mirror-image asymmetry, recorded rather than "fixed": `hazard` is an EntityRef kind (a
 * `memory_items` row addressable as an entity) but deliberately NOT a MemoryNodeType — a hazard
 * is projected, if at all, as a `memory` graph node, not a distinct node type. Adding it to
 * MemoryNodeType would need a `nodes.type` CHECK migration for a node type nothing needs.
 */
const ENTITY_REF_KINDS: ReadonlySet<string> = new Set(EntityRef.options.map((option) => option.shape.kind.value));

for (const nodeType of MemoryNodeType.options) {
  if (!ENTITY_REF_KINDS.has(nodeType) && !EXEMPT_NODE_TYPES.has(nodeType)) {
    throw new Error(
      `MemoryNodeType "${nodeType}" has neither an EntityRef arm nor a recorded EXEMPT_NODE_TYPES entry — ` +
      'the entity-URI and graph-node vocabularies have drifted (PLNR-278)',
    );
  }
}
