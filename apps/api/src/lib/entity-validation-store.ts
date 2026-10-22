import type {
  ReviewCause,
  SubjectFreshness,
  ValidationBaselines,
  ValidationSubjectType,
} from '@noriq-dev/shared';
import { newId, nowIso } from './util';
import {
  computeFreshness,
  docFingerprint,
  normalizeDocPinInputs,
  parseBaselines,
  planContentFingerprint,
  serializeBaselines,
  taskContentFingerprint,
  validationFromRow,
  wireValidation,
  type DeclaredCodeRevision,
  type DocPinRow,
  type ReviewInboxItem,
  type StoredCauseRow,
  type ValidationRow,
} from './entity-validation';

type Actor = { kind: 'agent' | 'human' | 'system'; id: string; name: string };

async function latestValidations(
  db: D1Database,
  projectId: string,
  subjectType: ValidationSubjectType,
  subjectId: string,
): Promise<{ latestAny: ValidationRow | null; latestMatching: ValidationRow | null; fingerprint: string }> {
  const fingerprint = await currentFingerprint(db, projectId, subjectType, subjectId);
  const { results } = await db.prepare(
    `SELECT id, project_id, subject_type, subject_id, content_fingerprint, validated_at,
            actor_kind, actor_id, actor_name, baselines_json, note
       FROM entity_validations
      WHERE project_id = ? AND subject_type = ? AND subject_id = ?
      ORDER BY validated_at DESC LIMIT 20`,
  ).bind(projectId, subjectType, subjectId).all();
  const rows = (results ?? []).map((r) => validationFromRow(r as Parameters<typeof validationFromRow>[0]));
  const latestAny = rows[0] ?? null;
  const latestMatching = rows.find((r) => r.contentFingerprint === fingerprint) ?? null;
  return { latestAny, latestMatching, fingerprint };
}

export async function currentFingerprint(
  db: D1Database,
  projectId: string,
  subjectType: ValidationSubjectType,
  subjectId: string,
): Promise<string> {
  if (subjectType === 'task') {
    const row = await db.prepare(
      'SELECT body, execution_spec AS spec FROM tasks WHERE id = ? AND project_id = ?',
    ).bind(subjectId, projectId).first<{ body: string; spec: string | null }>();
    if (!row) throw new Error(`task ${subjectId} not found`);
    return taskContentFingerprint(row.body, row.spec);
  }
  if (subjectType === 'plan') {
    const plan = await db.prepare(
      'SELECT body FROM plans WHERE id = ? AND project_id = ?',
    ).bind(subjectId, projectId).first<{ body: string | null }>();
    if (!plan) throw new Error(`plan ${subjectId} not found`);
    const { results } = await db.prepare(
      'SELECT "order" AS "order", title, body FROM phases WHERE plan_id = ? ORDER BY "order"',
    ).bind(subjectId).all<{ order: number; title: string; body: string | null }>();
    return planContentFingerprint(plan.body, results ?? []);
  }
  const doc = await db.prepare(
    'SELECT current_version AS version FROM docs WHERE id = ? AND project_id = ?',
  ).bind(subjectId, projectId).first<{ version: number }>();
  if (!doc) throw new Error(`doc ${subjectId} not found`);
  return docFingerprint(doc.version);
}

async function loadDocPins(
  db: D1Database,
  subjectType: ValidationSubjectType,
  subjectId: string,
): Promise<DocPinRow[]> {
  if (subjectType === 'task') {
    const { results } = await db.prepare(
      `SELECT td.doc_id AS docId, td.pinned_version AS pinnedVersion, d.current_version AS currentVersion, d.name
         FROM task_docs td JOIN docs d ON d.id = td.doc_id
        WHERE td.task_id = ? AND d.archived_at IS NULL`,
    ).bind(subjectId).all<DocPinRow>();
    return results ?? [];
  }
  if (subjectType === 'plan') {
    const { results } = await db.prepare(
      `SELECT pdr.doc_id AS docId, pdr.pinned_version AS pinnedVersion, d.current_version AS currentVersion, d.name
         FROM plan_doc_refs pdr JOIN docs d ON d.id = pdr.doc_id
        WHERE pdr.plan_id = ? AND d.archived_at IS NULL`,
    ).bind(subjectId).all<DocPinRow>();
    return results ?? [];
  }
  return [];
}

async function supersededById(
  db: D1Database,
  subjectType: ValidationSubjectType,
  subjectId: string,
): Promise<string | null> {
  if (subjectType === 'task') {
    const row = await db.prepare(
      'SELECT id FROM tasks WHERE supersedes_task_id = ? LIMIT 1',
    ).bind(subjectId).first<{ id: string }>();
    return row?.id ?? null;
  }
  if (subjectType === 'plan') {
    const row = await db.prepare(
      'SELECT id FROM plans WHERE supersedes_plan_id = ? LIMIT 1',
    ).bind(subjectId).first<{ id: string }>();
    return row?.id ?? null;
  }
  const row = await db.prepare(
    'SELECT id FROM docs WHERE supersedes_doc_id = ? LIMIT 1',
  ).bind(subjectId).first<{ id: string }>();
  return row?.id ?? null;
}

async function loadStoredCauses(
  db: D1Database,
  projectId: string,
  subjectType: ValidationSubjectType,
  subjectId: string,
): Promise<StoredCauseRow[]> {
  const { results } = await db.prepare(
    `SELECT cause, status, detail FROM entity_review_causes
      WHERE project_id = ? AND subject_type = ? AND subject_id = ?`,
  ).bind(projectId, subjectType, subjectId).all<StoredCauseRow>();
  return results ?? [];
}

export async function subjectFreshness(
  db: D1Database,
  projectId: string,
  subjectType: ValidationSubjectType,
  subjectId: string,
  declaredRevision?: DeclaredCodeRevision | null,
): Promise<SubjectFreshness> {
  const { latestAny, latestMatching, fingerprint } = await latestValidations(db, projectId, subjectType, subjectId);
  const [docPins, replacedBy, storedCauses] = await Promise.all([
    loadDocPins(db, subjectType, subjectId),
    supersededById(db, subjectType, subjectId),
    loadStoredCauses(db, projectId, subjectType, subjectId),
  ]);
  return computeFreshness({
    subjectType,
    subjectId,
    contentFingerprint: fingerprint,
    latestMatching,
    latestAny,
    docPins,
    supersededById: replacedBy,
    storedCauses,
    declaredRevision: declaredRevision ?? null,
  });
}

export async function recordValidation(
  db: D1Database,
  projectId: string,
  actor: Actor,
  input: {
    subjectType: ValidationSubjectType;
    subjectId: string;
    note?: string;
    baselines?: ValidationBaselines | null;
  },
) {
  // Resolve subject existence + fingerprint
  const fingerprint = await currentFingerprint(db, projectId, input.subjectType, input.subjectId);
  const id = newId('val');
  const validatedAt = nowIso();
  const baselinesJson = serializeBaselines(input.baselines);

  // Auto-capture current doc pins into baselines when caller omitted them
  let baselines = parseBaselines(baselinesJson);
  if (!input.baselines?.docPins?.length) {
    const pins = await loadDocPins(db, input.subjectType, input.subjectId);
    baselines = {
      ...baselines,
      docPins: pins
        .filter((p) => p.pinnedVersion != null)
        .map((p) => ({ docId: p.docId, version: p.pinnedVersion! })),
    };
  }

  await db.batch([
    db.prepare(
      `INSERT INTO entity_validations
        (id, project_id, subject_type, subject_id, content_fingerprint, validated_at,
         actor_kind, actor_id, actor_name, baselines_json, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, projectId, input.subjectType, input.subjectId, fingerprint, validatedAt,
      actor.kind, actor.id, actor.name, serializeBaselines(baselines), input.note ?? '',
    ),
    // Clear open content_changed / never_validated / doc_baseline_moved dismissals aren't needed —
    // those are derived. Dismiss human_flagged on revalidation.
    db.prepare(
      `UPDATE entity_review_causes SET status = 'dismissed', updated_at = ?, actor_kind = ?, actor_name = ?
        WHERE project_id = ? AND subject_type = ? AND subject_id = ?
          AND cause = 'human_flagged' AND status = 'open'`,
    ).bind(validatedAt, actor.kind, actor.name, projectId, input.subjectType, input.subjectId),
    // Resolve prior code_assessment_stale by DELETE (not dismiss). A dismissed sentinel would
    // forever-suppress push() for that cause and hide later B→C drift after revalidation at B.
    db.prepare(
      `DELETE FROM entity_review_causes
        WHERE project_id = ? AND subject_type = ? AND subject_id = ?
          AND cause = 'code_assessment_stale'`,
    ).bind(projectId, input.subjectType, input.subjectId),
  ]);

  return wireValidation({
    id,
    projectId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    contentFingerprint: fingerprint,
    validatedAt,
    actorKind: actor.kind,
    actorId: actor.id,
    actorName: actor.name,
    baselinesJson: serializeBaselines(baselines),
    note: input.note ?? '',
  });
}

export async function listValidations(
  db: D1Database,
  projectId: string,
  subjectType: ValidationSubjectType,
  subjectId: string,
  limit = 20,
) {
  const { results } = await db.prepare(
    `SELECT id, project_id, subject_type, subject_id, content_fingerprint, validated_at,
            actor_kind, actor_id, actor_name, baselines_json, note
       FROM entity_validations
      WHERE project_id = ? AND subject_type = ? AND subject_id = ?
      ORDER BY validated_at DESC LIMIT ?`,
  ).bind(projectId, subjectType, subjectId, Math.min(100, Math.max(1, limit))).all();
  return (results ?? []).map((r) => wireValidation(validationFromRow(r as Parameters<typeof validationFromRow>[0])));
}

export async function setReviewCause(
  db: D1Database,
  projectId: string,
  actor: Actor,
  input: {
    subjectType: ValidationSubjectType;
    subjectId: string;
    cause: ReviewCause;
    status: 'open' | 'dismissed';
    detail?: string;
  },
) {
  await db.prepare(
    `INSERT INTO entity_review_causes
      (project_id, subject_type, subject_id, cause, status, detail, updated_at, actor_kind, actor_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, subject_type, subject_id, cause) DO UPDATE SET
       status = excluded.status,
       detail = excluded.detail,
       updated_at = excluded.updated_at,
       actor_kind = excluded.actor_kind,
       actor_name = excluded.actor_name`,
  ).bind(
    projectId, input.subjectType, input.subjectId, input.cause, input.status,
    input.detail ?? '', nowIso(), actor.kind, actor.name,
  ).run();
  return { ok: true as const };
}

/** Pin docs on a task. Versions null → pin to current_version at write time. */
export async function setTaskDocPins(
  db: D1Database,
  projectId: string,
  taskId: string,
  docs: Array<{ id: string; name: string; version: number | null }>,
  mode: 'replace' | 'add',
) {
  const stmts = [];
  if (mode === 'replace') {
    stmts.push(db.prepare('DELETE FROM task_docs WHERE task_id = ?').bind(taskId));
  }
  for (const d of docs) {
    let version = d.version;
    if (version == null) {
      const cur = await db.prepare(
        'SELECT current_version AS v FROM docs WHERE id = ? AND project_id = ?',
      ).bind(d.id, projectId).first<{ v: number }>();
      version = cur?.v ?? null;
    }
    stmts.push(
      db.prepare(
        `INSERT INTO task_docs (task_id, doc_id, pinned_version) VALUES (?, ?, ?)
         ON CONFLICT (task_id, doc_id) DO UPDATE SET pinned_version = excluded.pinned_version`,
      ).bind(taskId, d.id, version),
    );
  }
  if (stmts.length) await db.batch(stmts);
}

export async function setPlanDocPins(
  db: D1Database,
  projectId: string,
  planId: string,
  raw: Array<string | { docId: string; version?: number | null }> | undefined,
  mode: 'replace' | 'add' = 'replace',
) {
  const pins = normalizeDocPinInputs(raw);
  if (!pins.length && mode === 'add') return;
  const ids = pins.map((p) => p.docId);
  if (ids.length) {
    const { results } = await db.prepare(
      `SELECT id, current_version AS version FROM docs
        WHERE project_id = ? AND archived_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`,
    ).bind(projectId, ...ids).all<{ id: string; version: number }>();
    const found = new Map((results ?? []).map((r) => [r.id, r.version]));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw new Error(`doc(s) not found in this project: ${missing.join(', ')}`);
  }
  const stmts = [];
  if (mode === 'replace') {
    stmts.push(db.prepare('DELETE FROM plan_doc_refs WHERE plan_id = ?').bind(planId));
  }
  for (const pin of pins) {
    const cur = await db.prepare(
      'SELECT current_version AS v FROM docs WHERE id = ? AND project_id = ?',
    ).bind(pin.docId, projectId).first<{ v: number }>();
    const version = pin.version ?? cur?.v ?? null;
    stmts.push(
      db.prepare(
        `INSERT INTO plan_doc_refs (plan_id, doc_id, pinned_version) VALUES (?, ?, ?)
         ON CONFLICT (plan_id, doc_id) DO UPDATE SET pinned_version = excluded.pinned_version`,
      ).bind(planId, pin.docId, version),
    );
  }
  if (stmts.length) await db.batch(stmts);
}

export async function setSupersedes(
  db: D1Database,
  projectId: string,
  subjectType: ValidationSubjectType,
  subjectId: string,
  priorId: string | null,
) {
  if (subjectType === 'task') {
    if (priorId) {
      const prior = await db.prepare(
        'SELECT id FROM tasks WHERE id = ? AND project_id = ?',
      ).bind(priorId, projectId).first();
      if (!prior) throw new Error(`prior task ${priorId} not found in this project`);
      if (priorId === subjectId) throw new Error('a task cannot supersede itself');
    }
    await db.prepare('UPDATE tasks SET supersedes_task_id = ?, updated_at = ? WHERE id = ? AND project_id = ?')
      .bind(priorId, nowIso(), subjectId, projectId).run();
    return { ok: true as const };
  }
  if (subjectType === 'plan') {
    if (priorId) {
      const prior = await db.prepare(
        'SELECT id FROM plans WHERE id = ? AND project_id = ?',
      ).bind(priorId, projectId).first();
      if (!prior) throw new Error(`prior plan ${priorId} not found in this project`);
      if (priorId === subjectId) throw new Error('a plan cannot supersede itself');
    }
    await db.prepare('UPDATE plans SET supersedes_plan_id = ? WHERE id = ? AND project_id = ?')
      .bind(priorId, subjectId, projectId).run();
    return { ok: true as const };
  }
  if (priorId) {
    const prior = await db.prepare(
      'SELECT id FROM docs WHERE id = ? AND project_id = ?',
    ).bind(priorId, projectId).first();
    if (!prior) throw new Error(`prior doc ${priorId} not found in this project`);
    if (priorId === subjectId) throw new Error('a doc cannot supersede itself');
  }
  await db.prepare('UPDATE docs SET supersedes_doc_id = ?, updated_at = ? WHERE id = ? AND project_id = ?')
    .bind(priorId, nowIso(), subjectId, projectId).run();
  return { ok: true as const };
}

export async function getSupersession(
  db: D1Database,
  projectId: string,
  subjectType: ValidationSubjectType,
  subjectId: string,
) {
  let supersedesId: string | null = null;
  if (subjectType === 'task') {
    const row = await db.prepare(
      'SELECT supersedes_task_id AS id FROM tasks WHERE id = ? AND project_id = ?',
    ).bind(subjectId, projectId).first<{ id: string | null }>();
    supersedesId = row?.id ?? null;
  } else if (subjectType === 'plan') {
    const row = await db.prepare(
      'SELECT supersedes_plan_id AS id FROM plans WHERE id = ? AND project_id = ?',
    ).bind(subjectId, projectId).first<{ id: string | null }>();
    supersedesId = row?.id ?? null;
  } else {
    const row = await db.prepare(
      'SELECT supersedes_doc_id AS id FROM docs WHERE id = ? AND project_id = ?',
    ).bind(subjectId, projectId).first<{ id: string | null }>();
    supersedesId = row?.id ?? null;
  }
  const replacedBy = await supersededById(db, subjectType, subjectId);
  return { supersedesId, supersededById: replacedBy };
}

/**
 * Project review inbox spanning tasks + plans + docs, grouped by primary cause.
 * Derives causes live (same as subjectFreshness) — no denormalized queue table.
 */
export async function reviewInbox(
  db: D1Database,
  projectId: string,
  opts: { cause?: ReviewCause; subjectType?: ValidationSubjectType; limit?: number; offset?: number } = {},
): Promise<{
  items: ReviewInboxItem[];
  counts: Record<string, number>;
  overallTotal: number;
  total: number;
  offset: number;
  nextOffset: number | null;
  groupBy: 'cause';
}> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  const now = Date.now();

  // Candidate subjects: anything with a validation, a pin, a supersession edge, or a stored cause —
  // plus never_validated is too broad for "all tasks". Inbox focuses on subjects that already
  // participated in validation OR have stored flags / supersession / drifted pins.
  const taskCandidates = await db.prepare(
    `SELECT DISTINCT t.id AS id, t.key AS key, t.title AS title, 'task' AS subjectType
       FROM tasks t
      WHERE t.project_id = ? AND t.archived_at IS NULL
        AND (
          EXISTS (SELECT 1 FROM entity_validations ev WHERE ev.subject_id = t.id AND ev.subject_type = 'task')
          OR EXISTS (SELECT 1 FROM entity_review_causes erc WHERE erc.subject_id = t.id AND erc.subject_type = 'task' AND erc.status = 'open')
          OR EXISTS (SELECT 1 FROM tasks s WHERE s.supersedes_task_id = t.id)
          OR EXISTS (
            SELECT 1 FROM task_docs td JOIN docs d ON d.id = td.doc_id
             WHERE td.task_id = t.id AND td.pinned_version IS NOT NULL
               AND d.current_version IS NOT NULL AND td.pinned_version != d.current_version
          )
        )`,
  ).bind(projectId).all<{ id: string; key: string; title: string; subjectType: 'task' }>();

  const planCandidates = await db.prepare(
    `SELECT DISTINCT p.id AS id, NULL AS key, p.title AS title, 'plan' AS subjectType
       FROM plans p
      WHERE p.project_id = ? AND p.archived_at IS NULL
        AND (
          EXISTS (SELECT 1 FROM entity_validations ev WHERE ev.subject_id = p.id AND ev.subject_type = 'plan')
          OR EXISTS (SELECT 1 FROM entity_review_causes erc WHERE erc.subject_id = p.id AND erc.subject_type = 'plan' AND erc.status = 'open')
          OR EXISTS (SELECT 1 FROM plans s WHERE s.supersedes_plan_id = p.id)
          OR EXISTS (
            SELECT 1 FROM plan_doc_refs pdr JOIN docs d ON d.id = pdr.doc_id
             WHERE pdr.plan_id = p.id AND pdr.pinned_version IS NOT NULL
               AND d.current_version IS NOT NULL AND pdr.pinned_version != d.current_version
          )
        )`,
  ).bind(projectId).all<{ id: string; key: string | null; title: string; subjectType: 'plan' }>();

  const docCandidates = await db.prepare(
    `SELECT DISTINCT d.id AS id, NULL AS key, d.name AS title, 'doc' AS subjectType
       FROM docs d
      WHERE d.project_id = ? AND d.archived_at IS NULL
        AND (
          EXISTS (SELECT 1 FROM entity_validations ev WHERE ev.subject_id = d.id AND ev.subject_type = 'doc')
          OR EXISTS (SELECT 1 FROM entity_review_causes erc WHERE erc.subject_id = d.id AND erc.subject_type = 'doc' AND erc.status = 'open')
          OR EXISTS (SELECT 1 FROM docs s WHERE s.supersedes_doc_id = d.id)
        )`,
  ).bind(projectId).all<{ id: string; key: string | null; title: string; subjectType: 'doc' }>();

  const candidates = [
    ...(taskCandidates.results ?? []),
    ...(planCandidates.results ?? []),
    ...(docCandidates.results ?? []),
  ].filter((c) => !opts.subjectType || c.subjectType === opts.subjectType);

  const items: ReviewInboxItem[] = [];
  const counts: Record<string, number> = {};

  for (const c of candidates) {
    const freshness = await subjectFreshness(db, projectId, c.subjectType, c.id);
    // Inbox excludes pure never_validated+impact_unknown with no other signal — those flood.
    // Keep subjects that have content_changed, doc_baseline_moved, superseded, human_flagged,
    // or code_assessment_stale/dormant. never_validated alone is omitted unless human_flagged.
    const actionable = freshness.causes.filter((x) =>
      x.code !== 'never_validated' && x.code !== 'impact_unknown');
    if (!actionable.length) continue;

    for (const cause of actionable) {
      counts[cause.code] = (counts[cause.code] ?? 0) + 1;
    }
    const primary = (actionable.find((x) => x.severity === 'critical') ?? actionable[0])!;
    if (opts.cause && !actionable.some((x) => x.code === opts.cause)) continue;

    items.push({
      subjectType: c.subjectType,
      subjectId: c.id,
      key: c.key,
      title: c.title,
      primaryCause: primary.code,
      causes: actionable.map((x) => x.code),
      lastValidatedAt: freshness.lastValidatedAt,
      ageSinceValidationSeconds: freshness.lastValidatedAt
        ? Math.max(0, Math.floor((now - Date.parse(freshness.lastValidatedAt)) / 1000))
        : null,
    });
  }

  // Sort: critical primary first, then by age
  const severityRank = (c: ReviewCause) => (c === 'content_changed' || c === 'doc_baseline_moved' ? 0 : 1);
  items.sort((a, b) =>
    severityRank(a.primaryCause) - severityRank(b.primaryCause)
    || (b.ageSinceValidationSeconds ?? 0) - (a.ageSinceValidationSeconds ?? 0)
    || a.title.localeCompare(b.title),
  );

  const overallTotal = items.length;
  const page = items.slice(offset, offset + limit);
  return {
    items: page,
    counts,
    overallTotal,
    total: opts.cause ? page.length : overallTotal,
    offset,
    nextOffset: offset + limit < overallTotal ? offset + limit : null,
    groupBy: 'cause',
  };
}
