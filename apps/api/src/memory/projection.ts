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

export interface CoordinationEventForProjection {
  verb: string;
  subjectId: string;
  payload: Record<string, unknown>;
}

/**
 * Which coordination verbs create a graph node, and what node they create (§4/§5) — the D1
 * event log's payload alone must carry everything needed; there is no second D1 read from inside
 * `applyCoordinationEvent`'s transaction (its projection write and cursor advance commit
 * together, and a `ctx.storage.transactionSync` block cannot await one). `task.created` is the
 * pre-existing arm (PLNR-247); `plan.created`/`doc.created`/`milestone.created` are new here.
 * `agent.registered` is deliberately ABSENT — no code anywhere in this repo ever emits it (see
 * this task's execution spec: "project ... milestones/agents WHERE AN EVENT EXISTS"), so there is
 * nothing to hook. Agents still gain graph nodes through `rebuildProjection`'s live D1 read,
 * which needs no event at all. Every other verb returns null — acknowledged (the cursor still
 * advances past it), no projection — exactly the original task.created-only projector's posture,
 * widened rather than replaced (discretion: "cover what the constellation needs to be legible,
 * not the whole verb catalogue").
 *
 * A project doc rides the `artifact` node type, not a new `doc` type (locked decision — the
 * `nodes.type` CHECK constraint permits no such value); a milestone has neither a dedicated node
 * type nor an `EntityRef` arm, so it rides the generic `unknown` catch-all, which — unlike
 * `EXEMPT_NODE_TYPES`'s project/branch/revision/error — DOES have an addressable EntityRef arm
 * (`kind: 'unknown'`), so a milestone node stays independently retrievable by uri.
 */
export function mapCoordinationEvent(ev: CoordinationEventForProjection): ProjectedNodeDescriptor | null {
  const label = (key: string): string => {
    const v = ev.payload[key];
    return typeof v === 'string' && v.trim() ? v : ev.subjectId;
  };
  switch (ev.verb) {
    case 'task.created':
      return { type: 'task', uri: buildEntityUri({ kind: 'task', id: ev.subjectId }), label: label('title') };
    case 'plan.created':
      return { type: 'plan', uri: buildEntityUri({ kind: 'plan', id: ev.subjectId }), label: label('title') };
    case 'doc.created':
      return { type: 'artifact', uri: buildEntityUri({ kind: 'artifact', id: ev.subjectId }), label: label('name') };
    case 'milestone.created':
      return { type: 'unknown', uri: buildEntityUri({ kind: 'unknown', id: ev.subjectId }), label: label('title') };
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
