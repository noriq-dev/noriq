/**
 * Entity validation / freshness (PLNR-576..580).
 * Fingerprints and review causes for tasks, plans, and docs — separate from Project Memory validity.
 */
import {
  type ReviewCause,
  type SubjectFreshness,
  type ValidationBaselines,
  type ValidationSubjectType,
  ValidationBaselines as ValidationBaselinesSchema,
  isCriticalReviewCause,
  reviewCauseSeverity,
  parseDocRef,
} from '@noriq-dev/shared';
import { sha256Hex } from './util';

export type DocPinRow = {
  docId: string;
  pinnedVersion: number | null;
  currentVersion: number | null;
  name?: string;
};

export type ValidationRow = {
  id: string;
  projectId: string;
  subjectType: ValidationSubjectType;
  subjectId: string;
  contentFingerprint: string;
  validatedAt: string;
  actorKind: 'agent' | 'human' | 'system';
  actorId: string | null;
  actorName: string;
  baselinesJson: string;
  note: string;
};

export function parseBaselines(raw: string | null | undefined): ValidationBaselines {
  if (!raw) return { docPins: [], codeAssessments: [] };
  try {
    return ValidationBaselinesSchema.parse(JSON.parse(raw));
  } catch {
    return { docPins: [], codeAssessments: [] };
  }
}

export function serializeBaselines(baselines: ValidationBaselines | null | undefined): string {
  const parsed = ValidationBaselinesSchema.parse(baselines ?? {});
  return JSON.stringify(parsed);
}

/** Canonical task fingerprint payload: body + executionSpec JSON text (or empty). */
export function taskFingerprintPayload(body: string | null | undefined, executionSpecJson: string | null | undefined): string {
  return JSON.stringify({
    body: body ?? '',
    executionSpec: executionSpecJson ?? null,
  });
}

/** Plan fingerprint: body + ordered phase intent (order, title, body). */
export function planFingerprintPayload(
  body: string | null | undefined,
  phases: Array<{ order: number; title: string; body: string | null }>,
): string {
  const sorted = [...phases].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  return JSON.stringify({
    body: body ?? '',
    phases: sorted.map((p) => ({
      order: p.order,
      title: p.title,
      body: p.body ?? '',
    })),
  });
}

/** Doc fingerprint is the immutable version number, not a content hash. */
export function docFingerprint(version: number): string {
  return `v:${version}`;
}

export async function hashFingerprint(payload: string): Promise<string> {
  return sha256Hex(payload);
}

export async function taskContentFingerprint(
  body: string | null | undefined,
  executionSpecJson: string | null | undefined,
): Promise<string> {
  return hashFingerprint(taskFingerprintPayload(body, executionSpecJson));
}

export async function planContentFingerprint(
  body: string | null | undefined,
  phases: Array<{ order: number; title: string; body: string | null }>,
): Promise<string> {
  return hashFingerprint(planFingerprintPayload(body, phases));
}

export type StoredCauseRow = {
  cause: string;
  status: 'open' | 'dismissed';
  detail: string;
};

/**
 * Options bag for subjectFreshness / computeFreshness.
 * Single object so P1-F (#19 declaredRevision) and P1-G (dormancy `now`) merge cleanly —
 * do not reintroduce a positional 5th arg that would clobber either shape.
 */
export type SubjectFreshnessOptions = {
  /** Injectable clock for dormancy comparison (PLNR-585). */
  now?: string | null;
  /**
   * Agent-declared code revision for code_assessment_stale (PLNR-584 / P1-F).
   * Accepted here for merge compatibility with #19; wiring lives in that PR.
   */
  declaredRevision?: {
    repositoryKey?: string | null;
    branch?: string | null;
    baseId?: string | null;
  } | null;
};

/** Later of ISO timestamps; ignores null/invalid. */
export function laterIso(...candidates: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const c of candidates) {
    if (!c) continue;
    const ms = Date.parse(c);
    if (!Number.isFinite(ms)) continue;
    if (ms >= bestMs) {
      bestMs = ms;
      best = c;
    }
  }
  return best;
}

/**
 * Quiet-period anchor: later of matching lastValidated and last fingerprint-affecting
 * content activity. `createdAt` is fallback only when both are missing (should not win
 * over an older explicit content_activity_at). Age alone never invalidates.
 */
export function dormancyActivityAt(input: {
  lastValidatedAt: string | null;
  contentActivityAt: string | null;
  createdAt?: string | null;
}): string {
  return laterIso(input.lastValidatedAt, input.contentActivityAt)
    ?? input.createdAt
    ?? new Date(0).toISOString();
}

/**
 * Compute freshness for a subject given its current fingerprint, latest matching
 * validation, doc pins, supersession, and stored cause rows (human_flagged / dismissals).
 *
 * Dormancy (P1-G): when `dormancyQuietSeconds` is null/≤0 the clock is OFF. When set,
 * quiet since lastValidated/content activity opens advisory `dormant` only — never auto-close.
 */
export function computeFreshness(input: {
  subjectType: ValidationSubjectType;
  subjectId: string;
  contentFingerprint: string;
  latestMatching: ValidationRow | null;
  latestAny: ValidationRow | null;
  docPins: DocPinRow[];
  supersededById: string | null;
  storedCauses: StoredCauseRow[];
  /** null / ≤0 = dormancy OFF (default). */
  dormancyQuietSeconds?: number | null;
  /** Last fingerprint-affecting content write (not claim/title/tag churn). */
  contentActivityAt?: string | null;
  /** Fallback when content_activity_at is unset (legacy rows). */
  createdAt?: string | null;
  /** Clock for dormancy comparison (injectable in tests). */
  now?: string | null;
}): SubjectFreshness {
  const causes: SubjectFreshness['causes'] = [];
  const dismissed = new Set(
    input.storedCauses.filter((c) => c.status === 'dismissed').map((c) => c.cause),
  );
  const push = (code: ReviewCause, detail?: string) => {
    if (dismissed.has(code) && code !== 'human_flagged') return;
    // human_flagged only surfaces when open
    if (code === 'human_flagged') {
      const row = input.storedCauses.find((c) => c.cause === 'human_flagged' && c.status === 'open');
      if (!row) return;
      causes.push({ code, severity: reviewCauseSeverity(code), detail: row.detail || detail });
      return;
    }
    causes.push({ code, severity: reviewCauseSeverity(code), detail });
  };

  if (!input.latestAny) {
    push('never_validated');
  } else if (!input.latestMatching) {
    push('content_changed', 'Subject content moved past the last validation fingerprint');
  }

  const pinViews = input.docPins.map((pin) => {
    const drifted =
      pin.pinnedVersion != null &&
      pin.currentVersion != null &&
      pin.pinnedVersion !== pin.currentVersion;
    return {
      docId: pin.docId,
      version: pin.pinnedVersion ?? 0,
      currentVersion: pin.currentVersion,
      drifted,
    };
  }).filter((p) => p.version > 0 || p.currentVersion != null);

  const driftedPins = input.docPins.filter(
    (p) => p.pinnedVersion != null && p.currentVersion != null && p.pinnedVersion !== p.currentVersion,
  );
  if (driftedPins.length) {
    push(
      'doc_baseline_moved',
      driftedPins.map((p) => `${p.docId}@${p.pinnedVersion}→v${p.currentVersion}`).join(', '),
    );
  }

  if (input.supersededById) {
    push('superseded', `Replaced by ${input.supersededById}`);
  }

  const quietSeconds = input.dormancyQuietSeconds != null && input.dormancyQuietSeconds > 0
    ? input.dormancyQuietSeconds
    : null;
  if (quietSeconds != null) {
    const activityAt = dormancyActivityAt({
      lastValidatedAt: input.latestMatching?.validatedAt ?? null,
      contentActivityAt: input.contentActivityAt ?? null,
      createdAt: input.createdAt ?? null,
    });
    const nowMs = Date.parse(input.now ?? new Date().toISOString());
    const activityMs = Date.parse(activityAt);
    if (Number.isFinite(nowMs) && Number.isFinite(activityMs) && nowMs - activityMs >= quietSeconds * 1000) {
      const quietFor = Math.floor((nowMs - activityMs) / 1000);
      push('dormant', `Quiet for ${quietFor}s (threshold ${quietSeconds}s since lastValidated/content activity)`);
    }
  }

  for (const row of input.storedCauses) {
    if (row.status !== 'open') continue;
    if (row.cause === 'human_flagged') push('human_flagged', row.detail);
    // code_assessment_stale remains P1-F stub: only if explicitly stored open.
    // dormant may also be force-opened via set_review_cause; derived path above is primary.
    if (row.cause === 'code_assessment_stale' || row.cause === 'dormant') {
      push(row.cause as ReviewCause, row.detail);
    }
  }

  const baselines = input.latestMatching
    ? parseBaselines(input.latestMatching.baselinesJson)
    : input.latestAny
      ? parseBaselines(input.latestAny.baselinesJson)
      : null;

  const hasAssessment = (baselines?.codeAssessments?.length ?? 0) > 0;
  const impactUnknown = !hasAssessment;
  if (impactUnknown) push('impact_unknown');

  // Deduplicate by code (first wins)
  const seen = new Set<string>();
  const unique = causes.filter((c) => {
    if (seen.has(c.code)) return false;
    seen.add(c.code);
    return true;
  });

  const criticalCauses = unique
    .filter((c) => isCriticalReviewCause(c.code))
    .map((c) => c.code);

  return {
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    contentFingerprint: input.contentFingerprint,
    lastValidatedAt: input.latestMatching?.validatedAt ?? null,
    matchingValidationId: input.latestMatching?.id ?? null,
    causes: unique,
    criticalCauses,
    impactUnknown,
    baselines,
    docPins: pinViews.map((p) => ({
      docId: p.docId,
      version: p.version,
      currentVersion: p.currentVersion,
      drifted: p.drifted,
    })),
  };
}

export function validationFromRow(row: {
  id: string;
  project_id: string;
  subject_type: string;
  subject_id: string;
  content_fingerprint: string;
  validated_at: string;
  actor_kind: string;
  actor_id: string | null;
  actor_name: string;
  baselines_json: string;
  note: string;
}): ValidationRow {
  return {
    id: row.id,
    projectId: row.project_id,
    subjectType: row.subject_type as ValidationSubjectType,
    subjectId: row.subject_id,
    contentFingerprint: row.content_fingerprint,
    validatedAt: row.validated_at,
    actorKind: row.actor_kind as ValidationRow['actorKind'],
    actorId: row.actor_id,
    actorName: row.actor_name,
    baselinesJson: row.baselines_json,
    note: row.note,
  };
}

export function wireValidation(row: ValidationRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    contentFingerprint: row.contentFingerprint,
    validatedAt: row.validatedAt,
    actorKind: row.actorKind,
    actorId: row.actorId,
    actorName: row.actorName,
    baselines: parseBaselines(row.baselinesJson),
    note: row.note,
  };
}

/** Normalize doc id inputs: strings (`id` or `id@version`) or `{docId, version?}`. */
export function normalizeDocPinInputs(
  raw: Array<string | { docId: string; version?: number | null }> | undefined,
): Array<{ docId: string; version: number | null }> {
  if (!raw?.length) return [];
  const out: Array<{ docId: string; version: number | null }> = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const parsed = typeof item === 'string'
      ? parseDocRef(item)
      : { docId: item.docId, version: item.version ?? null };
    if (!parsed.docId || seen.has(parsed.docId)) continue;
    seen.add(parsed.docId);
    out.push(parsed);
  }
  return out;
}

export type ReviewInboxItem = {
  subjectType: ValidationSubjectType;
  subjectId: string;
  key: string | null;
  title: string;
  primaryCause: ReviewCause;
  causes: ReviewCause[];
  lastValidatedAt: string | null;
  ageSinceValidationSeconds: number | null;
};

export function claimBlockedByFreshnessMessage(taskKey: string, critical: ReviewCause[]): string {
  return `${taskKey} cannot be claimed — critical freshness causes: ${critical.join(', ')}. Mark validated (or resolve doc pins / supersession) before claiming.`;
}
