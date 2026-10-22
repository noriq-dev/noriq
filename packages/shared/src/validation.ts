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

/** Optional code assessment baseline (P0 stores shape; agent-declared staleness is P1). */
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
