import type {
  DormancyConfig,
  ReviewCause,
  SubjectFreshness,
  ValidationBaselines,
  ValidationSubjectType,
} from '@noriq-dev/shared';
import { parseDormancyQuietSeconds } from '@noriq-dev/shared';
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
  type DocPinRow,
  type ReviewInboxItem,
  type StoredCauseRow,
  type SubjectFreshnessOptions,
  type ValidationRow,
} from './entity-validation';

type Actor = { kind: 'agent' | 'human' | 'system'; id: string; name: string };

export type { SubjectFreshnessOptions };

/**
 * D1 allows at most 100 bound parameters per statement. Chunk IN-lists so
 * projectId (+ optional subject_type) leave headroom.
 */
const D1_IN_CHUNK = 90;

/**
 * Freshness considers only this many most-recent validations per subject
 * (individual `latestValidations` and batched inbox must stay aligned).
 */
const VALIDATION_LOOKBACK = 20;

function chunkIds(ids: string[], size = D1_IN_CHUNK): string[][] {
  if (!ids.length) return [];
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/**
 * SQL predicate using LEFT JOIN alias `edo` (entity_dormancy_overrides) and two
 * bound `?` placeholders for the project-level quiet seconds (may be NULL).
 * Approximation only — computeFreshness still derives the real dormant cause (incl. lastValidated).
 */
function dormancyCandidateSql(alias: string): string {
  return `(
    COALESCE(edo.quiet_seconds, ?) IS NOT NULL
    AND (julianday('now') - julianday(COALESCE(${alias}.content_activity_at, ${alias}.created_at))) * 86400.0
      >= COALESCE(edo.quiet_seconds, ?)
  )`;
}

type InboxCandidate = {
  id: string;
  key: string | null;
  title: string;
  subjectType: ValidationSubjectType;
  contentActivityAt: string | null;
  createdAt: string | null;
  overrideQuiet: number | null;
  body: string | null;
  executionSpec: string | null;
  currentVersion: number | null;
};

async function batchValidationsBySubject(
  db: D1Database,
  projectId: string,
  subjectType: ValidationSubjectType,
  subjectIds: string[],
): Promise<Map<string, ValidationRow[]>> {
  const map = new Map<string, ValidationRow[]>();
  for (const chunk of chunkIds(subjectIds)) {
    // Same selection policy as latestValidations: newest VALIDATION_LOOKBACK per
    // subject_id — not all history, and not a global LIMIT across subjects.
    const { results } = await db.prepare(
      `SELECT id, project_id, subject_type, subject_id, content_fingerprint, validated_at,
              actor_kind, actor_id, actor_name, baselines_json, note
         FROM (
           SELECT id, project_id, subject_type, subject_id, content_fingerprint, validated_at,
                  actor_kind, actor_id, actor_name, baselines_json, note,
                  ROW_NUMBER() OVER (
                    PARTITION BY subject_id ORDER BY validated_at DESC
                  ) AS rn
             FROM entity_validations
            WHERE project_id = ? AND subject_type = ? AND subject_id IN (${chunk.map(() => '?').join(',')})
         )
        WHERE rn <= ?
        ORDER BY validated_at DESC`,
    ).bind(projectId, subjectType, ...chunk, VALIDATION_LOOKBACK).all();
    for (const raw of results ?? []) {
      const row = validationFromRow(raw as Parameters<typeof validationFromRow>[0]);
      const list = map.get(row.subjectId) ?? [];
      list.push(row);
      map.set(row.subjectId, list);
    }
  }
  return map;
}

async function batchTaskDocPins(
  db: D1Database,
  taskIds: string[],
): Promise<Map<string, DocPinRow[]>> {
  const map = new Map<string, DocPinRow[]>();
  for (const chunk of chunkIds(taskIds)) {
    const { results } = await db.prepare(
      `SELECT td.task_id AS subjectId, td.doc_id AS docId, td.pinned_version AS pinnedVersion,
              d.current_version AS currentVersion, d.name AS name
         FROM task_docs td JOIN docs d ON d.id = td.doc_id
        WHERE td.task_id IN (${chunk.map(() => '?').join(',')}) AND d.archived_at IS NULL`,
    ).bind(...chunk).all<DocPinRow & { subjectId: string }>();
    for (const r of results ?? []) {
      const list = map.get(r.subjectId) ?? [];
      list.push({ docId: r.docId, pinnedVersion: r.pinnedVersion, currentVersion: r.currentVersion, name: r.name });
      map.set(r.subjectId, list);
    }
  }
  return map;
}

async function batchPlanDocPins(
  db: D1Database,
  planIds: string[],
): Promise<Map<string, DocPinRow[]>> {
  const map = new Map<string, DocPinRow[]>();
  for (const chunk of chunkIds(planIds)) {
    const { results } = await db.prepare(
      `SELECT pdr.plan_id AS subjectId, pdr.doc_id AS docId, pdr.pinned_version AS pinnedVersion,
              d.current_version AS currentVersion, d.name AS name
         FROM plan_doc_refs pdr JOIN docs d ON d.id = pdr.doc_id
        WHERE pdr.plan_id IN (${chunk.map(() => '?').join(',')}) AND d.archived_at IS NULL`,
    ).bind(...chunk).all<DocPinRow & { subjectId: string }>();
    for (const r of results ?? []) {
      const list = map.get(r.subjectId) ?? [];
      list.push({ docId: r.docId, pinnedVersion: r.pinnedVersion, currentVersion: r.currentVersion, name: r.name });
      map.set(r.subjectId, list);
    }
  }
  return map;
}

async function batchSupersededBy(
  db: D1Database,
  subjectType: ValidationSubjectType,
  subjectIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!subjectIds.length) return map;
  const col =
    subjectType === 'task' ? 'supersedes_task_id'
      : subjectType === 'plan' ? 'supersedes_plan_id'
        : 'supersedes_doc_id';
  const table = subjectType === 'task' ? 'tasks' : subjectType === 'plan' ? 'plans' : 'docs';
  for (const chunk of chunkIds(subjectIds)) {
    const { results } = await db.prepare(
      `SELECT id AS replacerId, ${col} AS priorId FROM ${table}
        WHERE ${col} IN (${chunk.map(() => '?').join(',')})`,
    ).bind(...chunk).all<{ replacerId: string; priorId: string }>();
    for (const r of results ?? []) {
      // First replacer wins — matches LIMIT 1 in per-subject supersededById.
      if (!map.has(r.priorId)) map.set(r.priorId, r.replacerId);
    }
  }
  return map;
}

async function batchStoredCauses(
  db: D1Database,
  projectId: string,
  subjectType: ValidationSubjectType,
  subjectIds: string[],
): Promise<Map<string, StoredCauseRow[]>> {
  const map = new Map<string, StoredCauseRow[]>();
  for (const chunk of chunkIds(subjectIds)) {
    const { results } = await db.prepare(
      `SELECT subject_id AS subjectId, cause, status, detail FROM entity_review_causes
        WHERE project_id = ? AND subject_type = ? AND subject_id IN (${chunk.map(() => '?').join(',')})`,
    ).bind(projectId, subjectType, ...chunk).all<StoredCauseRow & { subjectId: string }>();
    for (const r of results ?? []) {
      const list = map.get(r.subjectId) ?? [];
      list.push({ cause: r.cause, status: r.status, detail: r.detail });
      map.set(r.subjectId, list);
    }
  }
  return map;
}

async function batchPlanPhases(
  db: D1Database,
  planIds: string[],
): Promise<Map<string, Array<{ order: number; title: string; body: string | null }>>> {
  const map = new Map<string, Array<{ order: number; title: string; body: string | null }>>();
  for (const chunk of chunkIds(planIds)) {
    const { results } = await db.prepare(
      `SELECT plan_id AS planId, "order" AS "order", title, body FROM phases
        WHERE plan_id IN (${chunk.map(() => '?').join(',')})
        ORDER BY "order"`,
    ).bind(...chunk).all<{ planId: string; order: number; title: string; body: string | null }>();
    for (const r of results ?? []) {
      const list = map.get(r.planId) ?? [];
      list.push({ order: r.order, title: r.title, body: r.body });
      map.set(r.planId, list);
    }
  }
  return map;
}

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
      ORDER BY validated_at DESC LIMIT ?`,
  ).bind(projectId, subjectType, subjectId, VALIDATION_LOOKBACK).all();
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

/** Resolve effective dormancy quiet seconds: entity override → project → off (null). */
export async function resolveDormancyConfig(
  db: D1Database,
  projectId: string,
  subjectType?: ValidationSubjectType,
  subjectId?: string,
): Promise<DormancyConfig> {
  if (subjectType && subjectId) {
    const override = await db.prepare(
      `SELECT quiet_seconds AS quietSeconds FROM entity_dormancy_overrides
        WHERE project_id = ? AND subject_type = ? AND subject_id = ?`,
    ).bind(projectId, subjectType, subjectId).first<{ quietSeconds: number }>();
    if (override?.quietSeconds != null && override.quietSeconds > 0) {
      return { quietSeconds: override.quietSeconds, source: 'entity' };
    }
  }
  const proj = await db.prepare(
    'SELECT dormancy_quiet_seconds AS quietSeconds FROM projects WHERE id = ?',
  ).bind(projectId).first<{ quietSeconds: number | null }>();
  const quiet = parseDormancyQuietSeconds(proj?.quietSeconds);
  if (quiet != null) return { quietSeconds: quiet, source: 'project' };
  return { quietSeconds: null, source: 'off' };
}

async function loadContentActivity(
  db: D1Database,
  projectId: string,
  subjectType: ValidationSubjectType,
  subjectId: string,
): Promise<{ contentActivityAt: string | null; createdAt: string | null }> {
  if (subjectType === 'task') {
    const row = await db.prepare(
      `SELECT content_activity_at AS contentActivityAt, created_at AS createdAt
         FROM tasks WHERE id = ? AND project_id = ?`,
    ).bind(subjectId, projectId).first<{ contentActivityAt: string | null; createdAt: string }>();
    return { contentActivityAt: row?.contentActivityAt ?? null, createdAt: row?.createdAt ?? null };
  }
  if (subjectType === 'plan') {
    const row = await db.prepare(
      `SELECT content_activity_at AS contentActivityAt, created_at AS createdAt
         FROM plans WHERE id = ? AND project_id = ?`,
    ).bind(subjectId, projectId).first<{ contentActivityAt: string | null; createdAt: string }>();
    return { contentActivityAt: row?.contentActivityAt ?? null, createdAt: row?.createdAt ?? null };
  }
  const row = await db.prepare(
    `SELECT content_activity_at AS contentActivityAt, created_at AS createdAt
       FROM docs WHERE id = ? AND project_id = ?`,
  ).bind(subjectId, projectId).first<{ contentActivityAt: string | null; createdAt: string }>();
  return { contentActivityAt: row?.contentActivityAt ?? null, createdAt: row?.createdAt ?? null };
}

export async function setProjectDormancyQuietSeconds(
  db: D1Database,
  projectId: string,
  quietSeconds: number | null,
): Promise<{ ok: true; dormancyQuietSeconds: number | null }> {
  await db.prepare('UPDATE projects SET dormancy_quiet_seconds = ? WHERE id = ?')
    .bind(quietSeconds, projectId).run();
  return { ok: true, dormancyQuietSeconds: quietSeconds };
}

export async function setEntityDormancyOverride(
  db: D1Database,
  projectId: string,
  subjectType: ValidationSubjectType,
  subjectId: string,
  quietSeconds: number | null,
): Promise<{ ok: true; dormancy: DormancyConfig }> {
  if (quietSeconds == null) {
    await db.prepare(
      `DELETE FROM entity_dormancy_overrides
        WHERE project_id = ? AND subject_type = ? AND subject_id = ?`,
    ).bind(projectId, subjectType, subjectId).run();
  } else {
    await db.prepare(
      `INSERT INTO entity_dormancy_overrides
        (project_id, subject_type, subject_id, quiet_seconds, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project_id, subject_type, subject_id) DO UPDATE SET
         quiet_seconds = excluded.quiet_seconds,
         updated_at = excluded.updated_at`,
    ).bind(projectId, subjectType, subjectId, quietSeconds, nowIso()).run();
  }
  return { ok: true, dormancy: await resolveDormancyConfig(db, projectId, subjectType, subjectId) };
}

export async function subjectFreshness(
  db: D1Database,
  projectId: string,
  subjectType: ValidationSubjectType,
  subjectId: string,
  opts?: SubjectFreshnessOptions,
): Promise<SubjectFreshness> {
  const { latestAny, latestMatching, fingerprint } = await latestValidations(db, projectId, subjectType, subjectId);
  const [docPins, replacedBy, storedCauses, dormancy, activity] = await Promise.all([
    loadDocPins(db, subjectType, subjectId),
    supersededById(db, subjectType, subjectId),
    loadStoredCauses(db, projectId, subjectType, subjectId),
    resolveDormancyConfig(db, projectId, subjectType, subjectId),
    loadContentActivity(db, projectId, subjectType, subjectId),
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
    dormancyQuietSeconds: dormancy.quietSeconds,
    contentActivityAt: activity.contentActivityAt,
    createdAt: activity.createdAt,
    now: opts?.now ?? null,
    // declaredRevision reserved for P1-F (#19) merge — optional field on the same bag.
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
    // those are derived. Clear human_flagged when validating.
    db.prepare(
      `UPDATE entity_review_causes SET status = 'dismissed', updated_at = ?, actor_kind = ?, actor_name = ?
        WHERE project_id = ? AND subject_type = ? AND subject_id = ? AND cause = 'human_flagged' AND status = 'open'`,
    ).bind(validatedAt, actor.kind, actor.name, projectId, input.subjectType, input.subjectId),
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
 * Derives causes live via computeFreshness (same evaluator as subjectFreshness) —
 * no denormalized queue table. Related facts are batch-loaded (D1 ≤100 binds/statement)
 * so pagination after evaluation stays exact without an N×queries-per-candidate loop.
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

  // Project dormancy once — entity overrides come in on the candidate rows.
  const projectRow = await db.prepare(
    'SELECT dormancy_quiet_seconds AS quietSeconds FROM projects WHERE id = ?',
  ).bind(projectId).first<{ quietSeconds: number | null }>();
  const projectQuiet = parseDormancyQuietSeconds(projectRow?.quietSeconds);

  // Candidate subjects: validation / open cause / supersession / drifted pins —
  // OR dormancy-eligible (effective threshold + quiet clock exceeded). never_validated alone
  // is still omitted unless another actionable cause (e.g. dormant) surfaces.
  // Content timestamps + override quiet + fingerprint fields ride along so evaluation
  // needs no per-subject subject/activity round-trips.
  const taskCandidates = await db.prepare(
    `SELECT DISTINCT t.id AS id, t.key AS key, t.title AS title, 'task' AS subjectType,
            t.content_activity_at AS contentActivityAt, t.created_at AS createdAt,
            edo.quiet_seconds AS overrideQuiet,
            t.body AS body, t.execution_spec AS executionSpec, NULL AS currentVersion
       FROM tasks t
       LEFT JOIN entity_dormancy_overrides edo
         ON edo.project_id = t.project_id AND edo.subject_type = 'task' AND edo.subject_id = t.id
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
          OR ${dormancyCandidateSql('t')}
        )`,
  ).bind(projectId, projectQuiet, projectQuiet).all<InboxCandidate>();

  const planCandidates = await db.prepare(
    `SELECT DISTINCT p.id AS id, NULL AS key, p.title AS title, 'plan' AS subjectType,
            p.content_activity_at AS contentActivityAt, p.created_at AS createdAt,
            edo.quiet_seconds AS overrideQuiet,
            p.body AS body, NULL AS executionSpec, NULL AS currentVersion
       FROM plans p
       LEFT JOIN entity_dormancy_overrides edo
         ON edo.project_id = p.project_id AND edo.subject_type = 'plan' AND edo.subject_id = p.id
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
          OR ${dormancyCandidateSql('p')}
        )`,
  ).bind(projectId, projectQuiet, projectQuiet).all<InboxCandidate>();

  const docCandidates = await db.prepare(
    `SELECT DISTINCT d.id AS id, NULL AS key, d.name AS title, 'doc' AS subjectType,
            d.content_activity_at AS contentActivityAt, d.created_at AS createdAt,
            edo.quiet_seconds AS overrideQuiet,
            NULL AS body, NULL AS executionSpec, d.current_version AS currentVersion
       FROM docs d
       LEFT JOIN entity_dormancy_overrides edo
         ON edo.project_id = d.project_id AND edo.subject_type = 'doc' AND edo.subject_id = d.id
      WHERE d.project_id = ? AND d.archived_at IS NULL
        AND (
          EXISTS (SELECT 1 FROM entity_validations ev WHERE ev.subject_id = d.id AND ev.subject_type = 'doc')
          OR EXISTS (SELECT 1 FROM entity_review_causes erc WHERE erc.subject_id = d.id AND erc.subject_type = 'doc' AND erc.status = 'open')
          OR EXISTS (SELECT 1 FROM docs s WHERE s.supersedes_doc_id = d.id)
          OR ${dormancyCandidateSql('d')}
        )`,
  ).bind(projectId, projectQuiet, projectQuiet).all<InboxCandidate>();

  const candidates = [
    ...(taskCandidates.results ?? []),
    ...(planCandidates.results ?? []),
    ...(docCandidates.results ?? []),
  ].filter((c) => !opts.subjectType || c.subjectType === opts.subjectType);

  const taskIds = candidates.filter((c) => c.subjectType === 'task').map((c) => c.id);
  const planIds = candidates.filter((c) => c.subjectType === 'plan').map((c) => c.id);
  const docIds = candidates.filter((c) => c.subjectType === 'doc').map((c) => c.id);

  const [
    taskValidations,
    planValidations,
    docValidations,
    taskPins,
    planPins,
    taskSuperseded,
    planSuperseded,
    docSuperseded,
    taskCauses,
    planCauses,
    docCauses,
    planPhases,
  ] = await Promise.all([
    batchValidationsBySubject(db, projectId, 'task', taskIds),
    batchValidationsBySubject(db, projectId, 'plan', planIds),
    batchValidationsBySubject(db, projectId, 'doc', docIds),
    batchTaskDocPins(db, taskIds),
    batchPlanDocPins(db, planIds),
    batchSupersededBy(db, 'task', taskIds),
    batchSupersededBy(db, 'plan', planIds),
    batchSupersededBy(db, 'doc', docIds),
    batchStoredCauses(db, projectId, 'task', taskIds),
    batchStoredCauses(db, projectId, 'plan', planIds),
    batchStoredCauses(db, projectId, 'doc', docIds),
    batchPlanPhases(db, planIds),
  ]);

  const items: ReviewInboxItem[] = [];
  const counts: Record<string, number> = {};

  for (const c of candidates) {
    let fingerprint: string;
    if (c.subjectType === 'task') {
      fingerprint = await taskContentFingerprint(c.body, c.executionSpec);
    } else if (c.subjectType === 'plan') {
      fingerprint = await planContentFingerprint(c.body, planPhases.get(c.id) ?? []);
    } else {
      fingerprint = docFingerprint(c.currentVersion ?? 0);
    }

    const vals =
      c.subjectType === 'task' ? (taskValidations.get(c.id) ?? [])
        : c.subjectType === 'plan' ? (planValidations.get(c.id) ?? [])
          : (docValidations.get(c.id) ?? []);
    const latestAny = vals[0] ?? null;
    const latestMatching = vals.find((r) => r.contentFingerprint === fingerprint) ?? null;
    const docPins =
      c.subjectType === 'task' ? (taskPins.get(c.id) ?? [])
        : c.subjectType === 'plan' ? (planPins.get(c.id) ?? [])
          : [];
    const replacedBy =
      c.subjectType === 'task' ? (taskSuperseded.get(c.id) ?? null)
        : c.subjectType === 'plan' ? (planSuperseded.get(c.id) ?? null)
          : (docSuperseded.get(c.id) ?? null);
    const storedCauses =
      c.subjectType === 'task' ? (taskCauses.get(c.id) ?? [])
        : c.subjectType === 'plan' ? (planCauses.get(c.id) ?? [])
          : (docCauses.get(c.id) ?? []);
    const quietSeconds = parseDormancyQuietSeconds(c.overrideQuiet) ?? projectQuiet;

    const freshness = computeFreshness({
      subjectType: c.subjectType,
      subjectId: c.id,
      contentFingerprint: fingerprint,
      latestMatching,
      latestAny,
      docPins,
      supersededById: replacedBy,
      storedCauses,
      dormancyQuietSeconds: quietSeconds,
      contentActivityAt: c.contentActivityAt,
      createdAt: c.createdAt,
    });

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
