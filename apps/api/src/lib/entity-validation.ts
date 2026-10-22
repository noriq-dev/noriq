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
 * Agent-declared current VCS revision for comparing stored code assessments.
 * Noriq does not fetch or index repos — staleness is declared, not discovered.
 */
export type DeclaredCodeRevision = {
  repositoryKey?: string | null;
  branch?: string | null;
  baseId?: string | null;
};

/** Result of comparing agent-declared revision to stored code assessments. */
export type CodeAssessmentEval =
  | { status: 'unevaluable'; reason: 'no_declaration' | 'no_base_id' | 'no_assessments' | 'scope_miss' }
  | { status: 'fresh' }
  | { status: 'stale'; detail: string };

function filterAssessmentsForScope(
  assessments: ValidationBaselines['codeAssessments'],
  declared: DeclaredCodeRevision | null | undefined,
): ValidationBaselines['codeAssessments'] {
  if (!declared) return assessments;
  const repoKey = declared.repositoryKey?.trim() || null;
  const branch = declared.branch?.trim() || null;
  if (!repoKey && !branch) return assessments;
  return assessments.filter((a) => {
    if (repoKey && a.repositoryKey !== repoKey) return false;
    if (branch && a.branch !== branch) return false;
    return true;
  });
}

/**
 * True when the caller's scope has no usable assessment: no assessments at all, or a
 * declared repositoryKey/branch that matches none of the stored assessments.
 */
export function callerScopeUnassessed(
  assessments: ValidationBaselines['codeAssessments'],
  declared: DeclaredCodeRevision | null | undefined,
): boolean {
  if (!assessments.length) return true;
  const repoKey = declared?.repositoryKey?.trim() || null;
  const branch = declared?.branch?.trim() || null;
  if (!repoKey && !branch) return false;
  return filterAssessmentsForScope(assessments, declared).length === 0;
}

/**
 * Compare agent-declared current baseId to stored assessments.
 * Distinguishes unevaluable (no baseId / no matching scope) from fresh vs stale so
 * stored open warnings are only superseded when a matching scope was successfully evaluated.
 */
export function evaluateCodeAssessment(
  assessments: ValidationBaselines['codeAssessments'],
  declared: DeclaredCodeRevision | null | undefined,
): CodeAssessmentEval {
  if (!declared) return { status: 'unevaluable', reason: 'no_declaration' };
  const declaredBaseId = declared.baseId?.trim();
  if (!declaredBaseId) return { status: 'unevaluable', reason: 'no_base_id' };
  if (!assessments.length) return { status: 'unevaluable', reason: 'no_assessments' };

  const scoped = filterAssessmentsForScope(assessments, declared);
  // Declared a repo/branch with no matching assessment → not "stale"; caller gets impact_unknown.
  if (!scoped.length) return { status: 'unevaluable', reason: 'scope_miss' };

  const drifted = scoped.filter((a) => a.baseId !== declaredBaseId);
  if (!drifted.length) return { status: 'fresh' };

  return {
    status: 'stale',
    detail: drifted
      .map((a) => `${a.repositoryKey}@${a.branch} assessed=${a.baseId} declared=${declaredBaseId}`)
      .join(', '),
  };
}

/**
 * Compare agent-declared current baseId to stored assessments.
 * Returns detail when stale; null when fresh or not evaluable (no declaration / no match scope).
 */
export function codeAssessmentStaleDetail(
  assessments: ValidationBaselines['codeAssessments'],
  declared: DeclaredCodeRevision | null | undefined,
): string | null {
  const ev = evaluateCodeAssessment(assessments, declared);
  return ev.status === 'stale' ? ev.detail : null;
}

/**
 * Compute freshness for a subject given its current fingerprint, latest matching
 * validation, doc pins, supersession, and stored cause rows (human_flagged / dismissals).
 * Pass `declaredRevision` (agent-reported baseId) to derive `code_assessment_stale`.
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
  declaredRevision?: DeclaredCodeRevision | null;
}): SubjectFreshness {
  const causes: SubjectFreshness['causes'] = [];
  const dismissed = new Set(
    input.storedCauses.filter((c) => c.status === 'dismissed').map((c) => c.cause),
  );
  const push = (code: ReviewCause, detail?: string) => {
    // code_assessment_stale is derived from declared baseId; a dismissed sentinel must not
    // forever-suppress later B→C drift (revalidation clears open rows instead of dismissing).
    if (dismissed.has(code) && code !== 'human_flagged' && code !== 'code_assessment_stale') return;
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

  const baselines = input.latestMatching
    ? parseBaselines(input.latestMatching.baselinesJson)
    : input.latestAny
      ? parseBaselines(input.latestAny.baselinesJson)
      : null;

  const assessments = baselines?.codeAssessments ?? [];
  const impactUnknown = callerScopeUnassessed(assessments, input.declaredRevision);
  if (impactUnknown) push('impact_unknown');

  // P1-F: agent-declared baseId drift vs stored assessments (advisory; no repo fetch).
  const assessmentEval = evaluateCodeAssessment(assessments, input.declaredRevision);
  // Only a successfully evaluated matching scope may supersede a stored open warning.
  const assessedScopeEvaluated =
    assessmentEval.status === 'fresh' || assessmentEval.status === 'stale';
  if (assessmentEval.status === 'stale') {
    push('code_assessment_stale', assessmentEval.detail);
  }

  for (const row of input.storedCauses) {
    if (row.status !== 'open') continue;
    if (row.cause === 'human_flagged') push('human_flagged', row.detail);
    // dormant: only if explicitly stored open (P1-G later)
    if (row.cause === 'dormant') push('dormant', row.detail);
    // Preserve stored open code_assessment_stale when declaration cannot be evaluated
    // (no baseId, no assessments, or mismatched repo/branch). Matching-scope eval wins.
    if (row.cause === 'code_assessment_stale' && !assessedScopeEvaluated) {
      push('code_assessment_stale', row.detail);
    }
  }

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
