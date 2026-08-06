// PLNR-251: pure, storage-free helpers the ProjectMemory DO's write RPCs drive — content and
// evidence hashing, scope-consistency validation, and the actor-authority clamp. Same split as
// backup.ts/restore.ts/lifecycle.ts: this file never opens `ctx.storage` — only the DO can.
import { z } from 'zod';
import { RepositoryKey, BranchRef, BaseId, EvidenceRef, AUTHORITY_SINGLE_OBSERVATION, type EvidenceRef as EvidenceRefT } from '@noriq-dev/shared';
import { sha256HexBytes } from './backup';

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

async function canonicalHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return sha256HexBytes(bytes);
}

/** sha256 over a canonical serialization of what makes a memory's recorded content distinct —
 *  kind, statement, and scope. Two independently-recorded memories with identical content hash
 *  identically; nothing in this task's write path acts on that fact yet (retrieval, Phase 4, is
 *  what will), but the column exists from the first write onward. */
export function memoryContentHash(kind: string, statement: string, scope: MemoryScope): Promise<string> {
  return canonicalHash({ kind, statement, scope });
}

/** sha256 over a canonical serialization of one evidence citation's identity (repository,
 *  branch, baseId, path, symbol) — deliberately excludes `contentHash`/`verificationState`,
 *  which describe the CITED artifact's freshness, not the citation's own identity. */
export function evidenceHash(ref: EvidenceRefT): Promise<string> {
  return canonicalHash({
    repositoryKey: ref.repositoryKey,
    branch: ref.branch,
    baseId: ref.baseId,
    path: ref.path,
    symbol: ref.symbol,
  });
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
