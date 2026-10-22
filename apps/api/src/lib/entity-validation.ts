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

/**
 * Compare agent-declared current baseId to stored assessments.
 * Returns detail when stale; null when fresh or not evaluable (no declaration / no match scope).
 */
export function codeAssessmentStaleDetail(
  assessments: ValidationBaselines['codeAssessments'],
  declared: DeclaredCodeRevision | null | undefined,
): string | null {
  if (!declared) return null;
  const declaredBaseId = declared.baseId?.trim();
  if (!declaredBaseId || !assessments.length) return null;

  const repoKey = declared.repositoryKey?.trim() || null;
  const branch = declared.branch?.trim() || null;
  const scoped = assessments.filter((a) => {
    if (repoKey && a.repositoryKey !== repoKey) return false;
    if (branch && a.branch !== branch) return false;
    return true;
  });
  // Declared a repo/branch with no matching assessment → not "stale"; caller still sees impact_unknown
  // only when *no* assessments exist at all. Scoped miss is not code_assessment_stale.
  if (!scoped.length) return null;

  const drifted = scoped.filter((a) => a.baseId !== declaredBaseId);
  if (!drifted.length) return null;

  return drifted
    .map((a) => `${a.repositoryKey}@${a.branch} assessed=${a.baseId} declared=${declaredBaseId}`)
    .join(', ');
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

  const baselines = input.latestMatching
    ? parseBaselines(input.latestMatching.baselinesJson)
    : input.latestAny
      ? parseBaselines(input.latestAny.baselinesJson)
      : null;

  const assessments = baselines?.codeAssessments ?? [];
  const hasAssessment = assessments.length > 0;
  const impactUnknown = !hasAssessment;
  if (impactUnknown) push('impact_unknown');

  // P1-F: agent-declared baseId drift vs stored assessments (advisory; no repo fetch).
  const staleDetail = codeAssessmentStaleDetail(assessments, input.declaredRevision);
  let assessedStaleDerived = false;
  if (staleDetail) {
    push('code_assessment_stale', staleDetail);
    assessedStaleDerived = true;
  }

  for (const row of input.storedCauses) {
    if (row.status !== 'open') continue;
    if (row.cause === 'human_flagged') push('human_flagged', row.detail);
    // dormant: only if explicitly stored open (P1-G later)
    if (row.cause === 'dormant') push('dormant', row.detail);
    // Manual code_assessment_stale only when we could not evaluate declaration (no baseId passed).
    // When declaration matches assessments, derived freshness wins over a leftover stored flag.
    if (row.cause === 'code_assessment_stale' && !assessedStaleDerived && !input.declaredRevision?.baseId) {
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
