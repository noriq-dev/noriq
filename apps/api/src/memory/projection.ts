// PLNR-262: storage-free mapping from an activated generation's staged entities/edges into
// graph nodes/edges — the same split as ingest.ts/backup.ts/restore.ts/graph-queries.ts: this
// module never opens ctx.storage. ProjectMemory reads staged rows, calls these pure functions to
// decide what's valid and what correlates, and does the actual SQL writes itself (bulk, one
// transaction, one summary outbox event — never per-entity writeNode/writeEdge calls).
import { MemoryNode, MemoryEdgeType } from '@noriq-dev/shared';

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
