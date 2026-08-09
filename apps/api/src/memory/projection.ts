// PLNR-262: storage-free mapping from an activated generation's staged entities/edges into
// graph nodes/edges — the same split as ingest.ts/backup.ts/restore.ts/graph-queries.ts: this
// module never opens ctx.storage. ProjectMemory reads staged rows, calls these pure functions to
// decide what's valid and what correlates, and does the actual SQL writes itself (bulk, one
// transaction, one summary outbox event — never per-entity writeNode/writeEdge calls).
//
// PLNR-283 adds two more pure mappings, same discipline: a coordination event -> the ONE graph
// node it projects (`mapCoordinationEvent`), and a classified evidence citation -> the node(s) it
// names plus the edge type linking a memory to them (`evidenceCitationNodes`). ProjectMemory
// still owns every actual `nodes`/`edges` write — these functions only decide WHAT to write.
import { MemoryNode, MemoryEdgeType, buildEntityUri, type EntityRef } from '@noriq-dev/shared';
import type { EvidenceCitation } from './writes';

export interface StagedEntityForProjection {
  uri: string;
  type: string;
  label: string;
  content: string | null;
}

export interface StagedEdgeForProjection {
  type: string;
  fromUri: string;
  toUri: string;
}

export interface ProjectionPlan {
  validEntities: StagedEntityForProjection[];
  invalidEntities: Array<{ uri: string; reason: string }>;
  validEdges: StagedEdgeForProjection[];
  invalidEdges: Array<{ edge: StagedEdgeForProjection; reason: string }>;
}

/**
 * Validate staged rows BEFORE any SQL write. `MemoryNode`'s cross-project URI refinement is
 * otherwise dead code — `writeNode` performs no zod validation on its loose string inputs — so
 * this is the first real enforcement of "a uri's embedded projectKey must match this project."
 * An invalid entity is skipped, not thrown: one malformed staged row must not abort projecting
 * everything else a generation validated cleanly. Only the EXISTING MemoryEdgeType vocabulary
 * may ever be written — an edge type outside it is skipped the same way.
 */
export function planProjection(
  projectKey: string,
  entities: StagedEntityForProjection[],
  edges: StagedEdgeForProjection[],
): ProjectionPlan {
  const validEntities: StagedEntityForProjection[] = [];
  const invalidEntities: Array<{ uri: string; reason: string }> = [];
  for (const e of entities) {
    const parsed = MemoryNode.safeParse({ id: 'validate', projectKey, type: e.type, uri: e.uri, label: e.label });
    if (parsed.success) validEntities.push(e);
    else invalidEntities.push({ uri: e.uri, reason: parsed.error.issues[0]?.message ?? 'invalid staged entity' });
  }
  const validEntityUris = new Set(validEntities.map((e) => e.uri));
  const validEdgeTypes = new Set<string>(MemoryEdgeType.options);
  const validEdges: StagedEdgeForProjection[] = [];
  const invalidEdges: Array<{ edge: StagedEdgeForProjection; reason: string }> = [];
  for (const e of edges) {
    if (!validEdgeTypes.has(e.type)) {
      invalidEdges.push({ edge: e, reason: `edge type "${e.type}" is not in MemoryEdgeType` });
    } else if (!validEntityUris.has(e.fromUri) || !validEntityUris.has(e.toUri)) {
      // Referential integrity was already checked at stage time (PLNR-261's
      // indexStagingIntegrityProblems) against ALL staged entities — this narrower check is
      // against only the entities that passed validation ABOVE, since an entity can fail
      // projection validation (bad type/uri) independently of staging validation.
      invalidEdges.push({ edge: e, reason: 'endpoint entity failed projection validation' });
    } else {
      validEdges.push(e);
    }
  }
  return { validEntities, invalidEntities, validEdges, invalidEdges };
}

/**
 * Index-derived co-change (§ discretion, no episodes exist yet — PLNR-263 adds the run-evidence
 * half): files whose presence changed (added to, or removed from, the repository) together
 * between two CONSECUTIVE generations of the same repository are observed to have "changed
 * together" in that reindex — the only correlation signal available before real episodes exist.
 */
export function changedFileUris(prevFileUris: ReadonlySet<string>, newFileUris: ReadonlySet<string>): string[] {
  const changed = new Set<string>();
  for (const u of prevFileUris) if (!newFileUris.has(u)) changed.add(u);
  for (const u of newFileUris) if (!prevFileUris.has(u)) changed.add(u);
  return [...changed];
}

/** Bounded: beyond the cap this returns NO pairs rather than a partial, silently-truncated set —
 *  the caller logs why (a changed set this large is not a "these files are related" signal, it's
 *  a full reindex or a mass rename). */
export const CO_CHANGE_PAIR_CAP = 20;

export function coChangePairs(changed: string[]): Array<[string, string]> {
  if (changed.length < 2 || changed.length > CO_CHANGE_PAIR_CAP) return [];
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < changed.length; i++) {
    for (let j = i + 1; j < changed.length; j++) pairs.push([changed[i]!, changed[j]!]);
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// PLNR-283: coordination projector + evidence-citation graph mapping
// ---------------------------------------------------------------------------

/** What `ProjectMemory.upsertGraphNode` needs to write one node — never the DO's own row shape
 *  (no minted id, no `created_at`): the caller decides those at write time. */
export interface ProjectedNodeDescriptor {
  type: string;
  uri: string;
  label: string;
}

/**
 * One graph edge `applyCoordinationEvent` draws (or removes) from a single event's payload —
 * PLNR-316. Both endpoints carry a FULL node descriptor, never a bare node id (locked decision):
 * the projector cannot read D1 mid-transaction to discover a node it has not seen, so each
 * endpoint is upserted-or-stubbed in the SAME `transactionSync` block the edge itself is written
 * in — a missing endpoint is never a reason to skip the edge, and `upsertGraphNode`'s
 * `ON CONFLICT (uri)` refines the stub's label the moment a better-labelled event for that same
 * uri lands. `op: 'unlink'` is a removal: its endpoints are only LOOKED UP, never created —
 * stubbing a node purely to immediately delete an edge that references it would be pointless
 * churn, and finding neither endpoint just means there is nothing to unlink (already-idempotent
 * no-op). `provenance` names the verb that produced the edge (locked decision: e.g.
 * `event:task.claimed`) — the same mechanism `linkGraphEdge` already gives `recordMemory`'s
 * evidence edges (`evidence:<id>`) and `rebuildProjection`'s backfill edges
 * (`coordination:phase_tasks` etc.), so a later drift check can tell which source wrote which
 * edge.
 */
export interface ProjectedEdgeDescriptor {
  type: MemoryEdgeType;
  from: ProjectedNodeDescriptor;
  to: ProjectedNodeDescriptor;
  op: 'link' | 'unlink';
  provenance: string;
}

/**
 * What one coordination event projects (PLNR-316 widens PLNR-283's node-only shape): its own
 * node — non-null only for a `*.created` arm, since an edge-only verb like `task.claimed` names
 * no NEW entity, only a relationship between entities that already have (or get stubbed) nodes —
 * plus zero or more edges. `node` and `edges` are independent so a verb can project a node with
 * no edges (unchanged from before this task), edges with no new top-level node (the edge's own
 * endpoint descriptors already carry `upsertGraphNode` everything it needs), or, in principle,
 * both.
 */
export interface CoordinationProjection {
  node: ProjectedNodeDescriptor | null;
  edges: ProjectedEdgeDescriptor[];
}

export interface CoordinationEventForProjection {
  verb: string;
  subjectId: string;
  payload: Record<string, unknown>;
}

/**
 * Which coordination verbs project a node and/or edges, and what they project (§4/§5) — the D1
 * event log's payload alone must carry everything needed; there is no second D1 read from inside
 * `applyCoordinationEvent`'s transaction (its projection write and cursor advance commit
 * together, and a `ctx.storage.transactionSync` block cannot await one). `task.created` is the
 * pre-existing arm (PLNR-247); `plan.created`/`doc.created`/`milestone.created` are PLNR-283;
 * `task.claimed`/`task.released` are PLNR-316. `agent.registered` is deliberately ABSENT — no
 * code anywhere in this repo ever emits it (see this task's execution spec: "project ...
 * milestones/agents WHERE AN EVENT EXISTS"), so there is nothing to hook. Agents still gain graph
 * nodes through `rebuildProjection`'s live D1 read, which needs no event at all; a `task.claimed`/
 * `task.released` edge's agent endpoint is stubbed (labelled with its own id — no display name
 * rides either payload) until that reconciliation corrects it, same as any other stub. Every
 * other verb returns null — acknowledged (the cursor still advances past it), no projection —
 * exactly the original task.created-only projector's posture, widened rather than replaced
 * (discretion: "cover what the constellation needs to be legible, not the whole verb catalogue").
 *
 * A project doc rides the `artifact` node type, not a new `doc` type (locked decision — the
 * `nodes.type` CHECK constraint permits no such value); a milestone has neither a dedicated node
 * type nor an `EntityRef` arm, so it rides the generic `unknown` catch-all, which — unlike
 * `EXEMPT_NODE_TYPES`'s project/branch/revision/error — DOES have an addressable EntityRef arm
 * (`kind: 'unknown'`), so a milestone node stays independently retrievable by uri.
 *
 * PLNR-316 deliberately projects NO edge for `dependency.added`/`dependency.removed` or
 * `run.created`, despite this task's own body naming all three as verbs "already fully described
 * by payloads the system emits TODAY" — verifying each payload at its ProjectRoom.ts emit site
 * (as the execution spec directs) shows that assumption is false for both:
 *   - `dependency.added`/`dependency.removed` (ProjectRoom.ts's `addDependency`/`removeDependency`)
 *     emit `{ key: task.key, dependsOn: dep.key, dependsOnProjectId? }` — the blocker is named
 *     ONLY by its display key. `getBlockerTask` has `dep.id` in scope at the emit call site; it is
 *     simply never serialized into the payload.
 *   - `run.created` (ProjectRoom.ts's `insertRun`) emits `{ kind, agentTool, repoRef, anchor:
 *     anchorType }` — `anchor` is the STRING 'task'|'plan', not the anchor's id. `anchorId` is
 *     likewise in scope at the emit call site and not serialized.
 * A `task`/`plan` node's uri is `noriq://{kind}/{id}` (see `buildEntityUri`) — built from the
 * entity's real D1 id, the same id every `*.created` event's `subjectId` already carries. Building
 * an edge endpoint from a KEY instead would mint a DIFFERENT uri (`noriq://task/{key}`) that can
 * never converge with the canonical id-keyed node `task.created`/`rebuildProjection` write for the
 * same task — a permanent orphan duplicate star, i.e. reintroducing this exact task's own bug
 * one level down, not fixing it. Rather than invent a field or silently skip with no trace, this
 * is a stated decision: both payloads need widening (an id alongside the existing key) before
 * their edges can be projected, and that widening is out of scope here (ProjectRoom.ts is owned
 * by a concurrent change in this tree, PLNR-318, widening `EventVerb`/`emit()` typing — payload
 * shape is a separate, deliberate follow-up).
 */
export function mapCoordinationEvent(ev: CoordinationEventForProjection): CoordinationProjection | null {
  const label = (key: string): string => {
    const v = ev.payload[key];
    return typeof v === 'string' && v.trim() ? v : ev.subjectId;
  };
  switch (ev.verb) {
    case 'task.created':
      return { node: { type: 'task', uri: buildEntityUri({ kind: 'task', id: ev.subjectId }), label: label('title') }, edges: [] };
    case 'plan.created':
      return { node: { type: 'plan', uri: buildEntityUri({ kind: 'plan', id: ev.subjectId }), label: label('title') }, edges: [] };
    case 'doc.created':
      return { node: { type: 'artifact', uri: buildEntityUri({ kind: 'artifact', id: ev.subjectId }), label: label('name') }, edges: [] };
    case 'milestone.created':
      return { node: { type: 'unknown', uri: buildEntityUri({ kind: 'unknown', id: ev.subjectId }), label: label('title') }, edges: [] };
    case 'task.claimed': {
      // Both run-minted claims (ProjectRoom.ts's `claimAnchorTaskForRun`, payload `{ agentId,
      // expiresAt, by: 'run' }`, no title) and human/agent `claim_task` claims (payload adds
      // `key`/`title`) share this one verb — `label('title')` falls back to the task's own id
      // when title is absent, same fallback every other arm here already uses.
      const agentId = ev.payload.agentId;
      if (typeof agentId !== 'string' || !agentId) return null;
      const task: ProjectedNodeDescriptor = { type: 'task', uri: buildEntityUri({ kind: 'task', id: ev.subjectId }), label: label('title') };
      const agent: ProjectedNodeDescriptor = { type: 'agent', uri: buildEntityUri({ kind: 'agent', id: agentId }), label: agentId };
      return { node: null, edges: [{ type: 'owned_by', from: task, to: agent, op: 'link', provenance: 'event:task.claimed' }] };
    }
    case 'task.released': {
      // `previousHolder` is `task.claimed_by` READ BEFORE `releaseTask`'s own UPDATE clears it
      // (ProjectRoom.ts), so it names the agent whose claim is ending — never `by` (the actor
      // performing the release, which may be a human overriding another agent's claim, PLNR-116).
      // Discretion: released UNLINKS rather than leaving a stale "still held" edge — `owned_by`
      // here means "currently holds", a live coordination fact, not a historical one (that record
      // already exists, permanently, as the task's effort episode's own `owned_by` edge to the
      // agent that worked it — PLNR-263).
      const agentId = ev.payload.previousHolder;
      if (typeof agentId !== 'string' || !agentId) return null;
      const task: ProjectedNodeDescriptor = { type: 'task', uri: buildEntityUri({ kind: 'task', id: ev.subjectId }), label: label('title') };
      const agent: ProjectedNodeDescriptor = { type: 'agent', uri: buildEntityUri({ kind: 'agent', id: agentId }), label: agentId };
      return { node: null, edges: [{ type: 'owned_by', from: task, to: agent, op: 'unlink', provenance: 'event:task.released' }] };
    }
    default:
      return null;
  }
}

// `hazard` is an `EntityRef` kind with NO `MemoryNodeType` arm (see shared/memory.ts's own
// comment on the asymmetry: a hazard is projected, if at all, as a `memory` graph node, never a
// distinct node type) — every other global entity-citation kind's literal IS already a valid
// node type, so this is the one translation needed.
function nodeTypeForEntityKind(kind: EntityRef['kind']): string {
  return kind === 'hazard' ? 'memory' : kind;
}

/** Every edge `recordMemory` draws from a memory to something its evidence cites — one edge
 *  type, uniformly (discretion: "pick the one that reads truthfully and use it consistently").
 *  `observed_in` reads truthfully whether the cited thing is a file, a task, or a doc: "this
 *  memory was observed in the context of X". */
export const EVIDENCE_EDGE_TYPE: MemoryEdgeType = 'observed_in';

/**
 * A classified evidence citation (`memory/writes.ts`'s `classifyEvidenceCitation`) -> the node(s)
 * it names (§11: "recording writes the memory's node and its typed edges to every entity its
 * evidence cites"). An entity citation (task/plan/run/decision/episode/artifact/agent/…) yields
 * exactly one node, the entity itself. A repository citation yields ONE node for its file, plus a
 * SECOND for its symbol when the citation named one — a symbol-level citation is evidence about
 * the file it lives in too, whether or not the caller also cited the file bare.
 */
export function evidenceCitationNodes(projectKey: string, citation: EvidenceCitation): ProjectedNodeDescriptor[] {
  if (citation.source === 'entity') {
    return [{ type: nodeTypeForEntityKind(citation.ref.kind), uri: buildEntityUri(citation.ref), label: citation.ref.id }];
  }
  const nodes: ProjectedNodeDescriptor[] = [
    {
      type: 'file',
      uri: buildEntityUri({ kind: 'file', projectKey, repositoryKey: citation.ref.repositoryKey, path: citation.ref.path }),
      label: citation.ref.path,
    },
  ];
  if (citation.ref.symbol) {
    nodes.push({
      type: 'symbol',
      uri: buildEntityUri({ kind: 'symbol', projectKey, repositoryKey: citation.ref.repositoryKey, path: citation.ref.path, name: citation.ref.symbol }),
      label: citation.ref.symbol,
    });
  }
  return nodes;
}
