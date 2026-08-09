// PLNR-251: pure, storage-free helpers the ProjectMemory DO's write RPCs drive — content and
// evidence hashing, scope-consistency validation, and the actor-authority clamp. Same split as
// backup.ts/restore.ts/lifecycle.ts: this file never opens `ctx.storage` — only the DO can.
import { z } from 'zod';
import { RepositoryKey, BranchRef, BaseId, EvidenceRef, canonicalHash, AUTHORITY_SINGLE_OBSERVATION, type EvidenceRef as EvidenceRefT } from '@noriq-dev/shared';

/** A memory's own repository/branch/baseId scope (§6, §16) — validated with the SAME shared
 *  primitives evidence citations use, never a re-derived rule. All optional: a project-wide
 *  decision or procedure has no repository scope at all. */
export const MemoryScope = z.object({
  repositoryKey: RepositoryKey.optional(),
  branch: BranchRef.optional(),
  baseId: BaseId.optional(),
});
export type MemoryScope = z.infer<typeof MemoryScope>;

/** Throws (zod's own message) on a malformed scope field — a `ckt_`-prefixed repositoryKey,
 *  an empty branch/baseId. Never re-implements what RepositoryKey/BranchRef/BaseId already
 *  reject. */
export function validateMemoryScope(scope: unknown): MemoryScope {
  const parsed = MemoryScope.parse(scope ?? {});
  if ((parsed.branch !== undefined || parsed.baseId !== undefined) && parsed.repositoryKey === undefined) {
    throw new Error('a memory scope with a branch or baseId must also carry a repositoryKey');
  }
  return parsed;
}

/** Throws on a malformed evidence citation — the same shared `EvidenceRef` schema every other
 *  evidence-consuming surface uses, so a `ckt_` checkout id or a missing path is rejected here
 *  exactly once, not re-checked ad hoc at each call site. */
export function validateEvidenceRef(ref: unknown): EvidenceRefT {
  return EvidenceRef.parse(ref);
}

/**
 * PLNR-283: the GLOBAL (id-only) arms of `EntityRef` this task's evidence-citation path
 * accepts — task/plan/run/decision/memory/episode/requirement/procedure/hazard/artifact/
 * unknown/agent, each `{kind, id}` with no further shape. Repository-scoped kinds (repository/
 * file/symbol/test/api/database_entity) are deliberately excluded: they already have a richer,
 * purpose-built citation shape below (`EvidenceRef`'s repositoryKey/branch/baseId/path/symbol,
 * carrying verification state a bare entity ref cannot) — accepting them a second way here would
 * create two citation shapes for the same fact with no way to prefer one.
 *
 * Written out one literal at a time (rather than derived from `EntityRef.options`) so the
 * inferred type is a real discriminated union assignable to shared's `EntityRef` with no cast —
 * `memory/projection.ts`'s `evidenceCitationNodes` passes `citation.ref` straight into
 * `buildEntityUri`. Mirrors `EntityRef`'s own global arms (packages/shared/src/memory.ts)
 * exactly; a NEW global arm added there needs the same literal added here to become citable.
 */
const GlobalEntityCitation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), id: z.string().min(1) }),
  z.object({ kind: z.literal('plan'), id: z.string().min(1) }),
  z.object({ kind: z.literal('run'), id: z.string().min(1) }),
  z.object({ kind: z.literal('decision'), id: z.string().min(1) }),
  z.object({ kind: z.literal('memory'), id: z.string().min(1) }),
  z.object({ kind: z.literal('episode'), id: z.string().min(1) }),
  z.object({ kind: z.literal('requirement'), id: z.string().min(1) }),
  z.object({ kind: z.literal('procedure'), id: z.string().min(1) }),
  z.object({ kind: z.literal('hazard'), id: z.string().min(1) }),
  z.object({ kind: z.literal('artifact'), id: z.string().min(1) }),
  z.object({ kind: z.literal('unknown'), id: z.string().min(1) }),
  z.object({ kind: z.literal('agent'), id: z.string().min(1) }),
]);
export type GlobalEntityRef = z.infer<typeof GlobalEntityCitation>;

/**
 * One `recordMemory` evidence-array entry, classified. A repository citation (existing shape —
 * verified per branch/baseId, written to the `evidence` table) or an ENTITY citation — a bare
 * reference to a durable coordination or memory entity ("I looked at this task", "this claim is
 * about this doc"), which is a graph fact, not a repository fact, and gets no `evidence` row
 * (there is nothing to re-verify against a worktree).
 */
export type EvidenceCitation =
  | { source: 'repository'; ref: EvidenceRefT }
  | { source: 'entity'; ref: GlobalEntityRef };

/**
 * Classify one raw `evidence[]` item. `GlobalEntityCitation` is a discriminated union on `kind`;
 * a repository citation object carries no `kind` field at all, so it can never accidentally
 * match — tried first, no ambiguity either way. Throws (zod's own message, via
 * `validateEvidenceRef`) when neither shape fits.
 */
export function classifyEvidenceCitation(input: unknown): EvidenceCitation {
  const asEntity = GlobalEntityCitation.safeParse(input);
  if (asEntity.success) return { source: 'entity', ref: asEntity.data };
  return { source: 'repository', ref: validateEvidenceRef(input) };
}

/** sha256 over a canonical serialization of what makes a memory's recorded content distinct —
 *  kind, statement, and scope. Two independently-recorded memories with identical content hash
 *  identically; nothing in this task's write path acts on that fact yet (retrieval, Phase 4, is
 *  what will), but the column exists from the first write onward. */
export function memoryContentHash(kind: string, statement: string, scope: MemoryScope): Promise<string> {
  return canonicalHash({ kind, statement, scope });
}

/** Authority is clamped SERVER-SIDE by actor, never trusted from the caller (§12): an 'agent'
 *  actor — any AI-driven write reaching this RPC layer, whether a human's copilot session or a
 *  runner-spawned agent — cannot request above AUTHORITY_SINGLE_OBSERVATION (2). Authority 5 is
 *  unreachable through this path by construction; it exists only via PLNR-253's human approval
 *  RPCs, which never call through here. */
export function clampAuthority(requested: number, actorKind: string): number {
  if (actorKind === 'agent') return Math.min(requested, AUTHORITY_SINGLE_OBSERVATION);
  return requested;
}
