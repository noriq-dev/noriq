import { z } from 'zod';

/** Subject kinds that carry entity-level validation records (P0 decay/validation). */
export const ValidationSubjectType = z.enum(['task', 'plan', 'doc']);
export type ValidationSubjectType = z.infer<typeof ValidationSubjectType>;

/**
 * Stable review-cause codes. Inbox groups by these.
 * Critical causes hard-block claim; advisory causes surface in context only.
 */
export const ReviewCause = z.enum([
  'never_validated',
  'content_changed',
  'doc_baseline_moved',
  'code_assessment_stale',
  'impact_unknown',
  'superseded',
  'dormant',
  'human_flagged',
]);
export type ReviewCause = z.infer<typeof ReviewCause>;

export const CRITICAL_REVIEW_CAUSES: ReadonlySet<ReviewCause> = new Set([
  'content_changed',
  'doc_baseline_moved',
]);

export function isCriticalReviewCause(cause: string): boolean {
  return CRITICAL_REVIEW_CAUSES.has(cause as ReviewCause);
}

export const ReviewCauseSeverity = z.enum(['critical', 'advisory']);
export type ReviewCauseSeverity = z.infer<typeof ReviewCauseSeverity>;

export function reviewCauseSeverity(cause: ReviewCause): ReviewCauseSeverity {
  return isCriticalReviewCause(cause) ? 'critical' : 'advisory';
}

/**
 * Agent-declared code assessment baseline. Noriq stores these; it does not index repos
 * or fetch git. Staleness (`code_assessment_stale`) is derived when a later call declares
 * a current baseId that differs from a stored assessment's baseId.
 */
export const CodeAssessmentBaseline = z.object({
  repositoryKey: z.string().min(1),
  branch: z.string().min(1),
  baseId: z.string().min(1),
  summary: z.string().max(2000).optional(),
  paths: z.array(z.string().min(1)).max(200).optional(),
});
export type CodeAssessmentBaseline = z.infer<typeof CodeAssessmentBaseline>;

/** Pinned settled-doc baseline recorded with a validation. */
export const DocVersionPin = z.object({
  docId: z.string().min(1),
  version: z.number().int().positive(),
});
export type DocVersionPin = z.infer<typeof DocVersionPin>;

export const ValidationBaselines = z.object({
  docPins: z.array(DocVersionPin).default([]),
  codeAssessments: z.array(CodeAssessmentBaseline).default([]),
});
export type ValidationBaselines = z.infer<typeof ValidationBaselines>;

export const ValidationRecord = z.object({
  id: z.string(),
  projectId: z.string(),
  subjectType: ValidationSubjectType,
  subjectId: z.string(),
  contentFingerprint: z.string(),
  validatedAt: z.string().datetime(),
  actorKind: z.enum(['agent', 'human', 'system']),
  actorId: z.string().nullable(),
  actorName: z.string(),
  baselines: ValidationBaselines,
  note: z.string().default(''),
});
export type ValidationRecord = z.infer<typeof ValidationRecord>;

export const FreshnessCause = z.object({
  code: ReviewCause,
  severity: ReviewCauseSeverity,
  detail: z.string().optional(),
});
export type FreshnessCause = z.infer<typeof FreshnessCause>;

export const SubjectFreshness = z.object({
  subjectType: ValidationSubjectType,
  subjectId: z.string(),
  contentFingerprint: z.string(),
  lastValidatedAt: z.string().datetime().nullable(),
  matchingValidationId: z.string().nullable(),
  causes: z.array(FreshnessCause),
  criticalCauses: z.array(ReviewCause),
  impactUnknown: z.boolean(),
  baselines: ValidationBaselines.nullable(),
  docPins: z.array(DocVersionPin.extend({
    currentVersion: z.number().int().positive().nullable(),
    drifted: z.boolean(),
  })).default([]),
});
export type SubjectFreshness = z.infer<typeof SubjectFreshness>;

/** Parse `docId` or `docId@version` (P0-B pin form). */
export function parseDocRef(raw: string): { docId: string; version: number | null } {
  const trimmed = raw.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return { docId: trimmed, version: null };
  const versionPart = trimmed.slice(at + 1);
  if (!/^\d+$/.test(versionPart)) return { docId: trimmed, version: null };
  const version = Number(versionPart);
  if (!Number.isInteger(version) || version < 1) return { docId: trimmed, version: null };
  return { docId: trimmed.slice(0, at), version };
}

export function formatDocRef(docId: string, version: number | null | undefined): string {
  return version != null ? `${docId}@${version}` : docId;
}

/**
 * Opt-in dormancy (P1-G / PLNR-585).
 * `quietSeconds: null` (or omitted) = OFF — no dormant cause is ever derived.
 * When set (>0), quiet since lastValidated / content activity opens advisory `dormant` only.
 */
export const DormancyConfig = z.object({
  quietSeconds: z.number().int().positive().nullable(),
  source: z.enum(['off', 'project', 'entity']),
});
export type DormancyConfig = z.infer<typeof DormancyConfig>;

/** Minimum / maximum allowed quiet thresholds (1 hour … 10 years). */
export const DORMANCY_QUIET_SECONDS_MIN = 3600;
export const DORMANCY_QUIET_SECONDS_MAX = 10 * 365 * 24 * 3600;

export function parseDormancyQuietSeconds(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}
