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
 * Stored review-cause lifecycle (P2-C / PLNR-594).
 * - open: surface in inbox / freshness
 * - dismissed: permanently hide this cause instance (does not invent validity)
 * - snoozed: omit until `snoozedUntil`; after expiry the cause resurfaces without a new validation
 */
export const ReviewCauseStatus = z.enum(['open', 'dismissed', 'snoozed']);
export type ReviewCauseStatus = z.infer<typeof ReviewCauseStatus>;

/** Minimum / maximum snooze duration (1 minute … 1 year). */
export const SNOOZE_DURATION_SECONDS_MIN = 60;
export const SNOOZE_DURATION_SECONDS_MAX = 365 * 24 * 3600;

/**
 * Resolve absolute snooze-until from either an ISO timestamp or a duration.
 * Requires status=snoozed callers to pass one of the two; returns null for open/dismissed.
 */
export function resolveSnoozedUntil(input: {
  status: ReviewCauseStatus;
  snoozedUntil?: string | null;
  durationSeconds?: number | null;
  now?: string | Date;
}): string | null {
  if (input.status !== 'snoozed') return null;
  const nowMs = input.now instanceof Date
    ? input.now.getTime()
    : Date.parse(input.now ?? new Date().toISOString());
  if (!Number.isFinite(nowMs)) {
    throw new Error('Invalid now clock for snooze resolution');
  }

  if (input.snoozedUntil != null && String(input.snoozedUntil).trim() !== '') {
    const untilMs = Date.parse(input.snoozedUntil);
    if (!Number.isFinite(untilMs)) {
      throw new Error('snoozedUntil must be a valid ISO-8601 timestamp');
    }
    if (untilMs <= nowMs) {
      throw new Error('snoozedUntil must be in the future');
    }
    return new Date(untilMs).toISOString();
  }

  const duration = input.durationSeconds;
  if (duration == null || !Number.isFinite(duration)) {
    throw new Error('snoozed status requires snoozedUntil or durationSeconds');
  }
  const seconds = Math.round(duration);
  if (seconds < SNOOZE_DURATION_SECONDS_MIN || seconds > SNOOZE_DURATION_SECONDS_MAX) {
    throw new Error(
      `durationSeconds must be between ${SNOOZE_DURATION_SECONDS_MIN} and ${SNOOZE_DURATION_SECONDS_MAX}`,
    );
  }
  return new Date(nowMs + seconds * 1000).toISOString();
}

/** True while a snooze is still active (status=snoozed and until > now). */
export function isSnoozeActive(
  status: ReviewCauseStatus | string,
  snoozedUntil: string | null | undefined,
  now?: string | Date,
): boolean {
  if (status !== 'snoozed') return false;
  if (!snoozedUntil) return false;
  const untilMs = Date.parse(snoozedUntil);
  if (!Number.isFinite(untilMs)) return false;
  const nowMs = now instanceof Date
    ? now.getTime()
    : Date.parse(now ?? new Date().toISOString());
  if (!Number.isFinite(nowMs)) return false;
  return untilMs > nowMs;
}

/**
 * True when a stored cause should surface: open, or snoozed past expiry.
 * Dismissed never resurfaces for that cause instance.
 */
export function isReviewCauseEffectivelyOpen(
  status: ReviewCauseStatus | string,
  snoozedUntil: string | null | undefined,
  now?: string | Date,
): boolean {
  if (status === 'open') return true;
  if (status === 'dismissed') return false;
  if (status === 'snoozed') return !isSnoozeActive(status, snoozedUntil, now);
  return false;
}

/** True when a stored cause should suppress derived/inbox surfacing (dismissed or active snooze). */
export function isReviewCauseSuppressed(
  status: ReviewCauseStatus | string,
  snoozedUntil: string | null | undefined,
  now?: string | Date,
): boolean {
  if (status === 'dismissed') return true;
  return isSnoozeActive(status, snoozedUntil, now);
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
