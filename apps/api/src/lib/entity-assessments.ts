import { projectValidationPolicy, unresolvedDirections } from './validation-policy';
import { AssessmentInput, type AssessmentRecord, type AssessmentState, ReadinessOverrideInput, type ReadinessOverrideRecord, type ValidationSubjectType } from '@noriq-dev/shared';
import { newId, nowIso, sha256Hex } from './util';

type Actor = { kind: string; id: string; name: string };

/** Includes dependency state and doc versions, never comment/title/claim activity. */
export async function assessmentContext(db: D1Database, projectId: string, type: ValidationSubjectType, id: string, fingerprint: string) {
  const facts: unknown[] = [fingerprint];
  const policy = await projectValidationPolicy(db, projectId);
  let required = policy.mode === 'strict';
  if (type === 'task') {
    const direction = await db.prepare('SELECT direction_generation AS generation FROM tasks WHERE id = ? AND project_id = ?').bind(id, projectId).first<{generation:number}>();
    if (policy.generation || direction?.generation) facts.push({ policyGeneration: policy.generation, directionGeneration: direction?.generation ?? 0 });
    const deps = await db.prepare(`SELECT t.id, t.status, t.content_activity_at, t.readiness_generation,
      (SELECT group_concat(ref) FROM (SELECT ref FROM task_refs WHERE task_id = t.id AND kind = 'commit' ORDER BY ref)) AS commits
      FROM dependencies d JOIN tasks t ON t.id = d.depends_on_task_id WHERE d.task_id = ? ORDER BY t.id`).bind(id).all();
    const docs = await db.prepare(`SELECT d.id, td.pinned_version, d.current_version, d.archived_at
      FROM task_docs td JOIN docs d ON d.id = td.doc_id WHERE td.task_id = ? ORDER BY d.id`).bind(id).all();
    const membership = await db.prepare(`SELECT p.id AS planId, p.body AS planBody, p.readiness_required,
      ph.id, ph.title, ph.body, ph."order" FROM phase_tasks pt JOIN phases ph ON ph.id = pt.phase_id
      JOIN plans p ON p.id = ph.plan_id WHERE pt.task_id = ? AND p.status != 'rejected'
      ORDER BY p.id, ph."order", ph.id`).bind(id).all<any>();
    const previous = await db.prepare(`SELECT DISTINCT p.id AS planId, prev.id AS phaseId, prev.title, prev.body,
      t.id, t.status, t.readiness_generation,
      (SELECT group_concat(ref) FROM (SELECT ref FROM task_refs WHERE task_id = t.id AND kind = 'commit' ORDER BY ref)) AS commits
      FROM phase_tasks mine JOIN phases ph ON ph.id = mine.phase_id JOIN plans p ON p.id = ph.plan_id
      JOIN phases prev ON prev.plan_id = p.id AND prev."order" < ph."order"
      JOIN phase_tasks pt ON pt.phase_id = prev.id JOIN tasks t ON t.id = pt.task_id
      WHERE mine.task_id = ? AND p.status != 'rejected' ORDER BY p.id, prev.id, t.id`).bind(id).all();
    required = required || membership.results.some(p => !!p.readiness_required);
    facts.push(deps.results, docs.results, membership.results, previous.results);
  }
  if (type === 'plan') {
    const docs = await db.prepare(`SELECT d.id, r.pinned_version, d.current_version, d.archived_at
      FROM plan_doc_refs r JOIN docs d ON d.id = r.doc_id WHERE r.plan_id = ? ORDER BY d.id`).bind(id).all();
    facts.push(docs.results);
  }
  return { fingerprint: await sha256Hex(JSON.stringify(facts)), required, projectPolicy: policy.mode };
}

export async function prepareAssessment(db: D1Database, projectId: string, actor: Actor,
  type: ValidationSubjectType, id: string, fingerprint: string, raw: AssessmentInput) {
  const input = AssessmentInput.parse(raw);
  if (type === 'task' && input.purpose === 'document') throw new Error('Task assessments use readiness or implementation');
  if (type !== 'task' && input.purpose !== 'document') throw new Error('Plan/doc assessments use document; plan approval remains separate');
  const context = await assessmentContext(db, projectId, type, id, fingerprint);
  const record: AssessmentRecord = {
    ...input, id: newId('asm'), subjectType: type, subjectId: id, contentFingerprint: fingerprint,
    contextFingerprint: context.fingerprint, actorKind: actor.kind, actorId: actor.id, actorName: actor.name,
    createdAt: nowIso(), provenance: 'actor_reported',
  };
  const statement = db.prepare(`INSERT INTO entity_assessments
    (id, project_id, subject_type, subject_id, purpose, content_fingerprint, context_fingerprint,
     assessment_json, actor_kind, actor_id, actor_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(record.id, projectId, type, id, input.purpose, fingerprint, context.fingerprint,
      JSON.stringify(input), actor.kind, actor.id, actor.name, record.createdAt);
  return { record, statement };
}

export async function recordAssessment(db: D1Database, projectId: string, actor: Actor,
  type: ValidationSubjectType, id: string, fingerprint: string, raw: AssessmentInput) {
  const prepared = await prepareAssessment(db, projectId, actor, type, id, fingerprint, raw);
  const statements = [prepared.statement];
  if (raw.reconciliation) {
    if (type !== 'task' || raw.purpose !== 'readiness' || raw.outcome !== 'passed') throw new Error('Direction reconciliation requires passing task readiness evidence');
    const pending = await unresolvedDirections(db, projectId, id);
    const ids = [...new Set(raw.reconciliation.directionIds)].sort();
    if (JSON.stringify(ids) !== JSON.stringify(pending.map(m => m.id).sort())) throw new Error('Reconciliation must cover every current unresolved direction marker; refresh task context');
    statements.push(db.prepare(`UPDATE task_direction_markers SET resolved_assessment_id = ?, resolved_at = ?
      WHERE project_id = ? AND task_id = ? AND resolved_at IS NULL`).bind(prepared.record.id, prepared.record.createdAt, projectId, id));
  }
  await db.batch(statements);
  return prepared.record;
}

export async function assessmentState(db: D1Database, projectId: string, type: ValidationSubjectType, id: string,
  fingerprint: string, revision?: { repositoryKey?: string | null; branch?: string | null; baseId?: string | null } | null): Promise<AssessmentState> {
  const context = await assessmentContext(db, projectId, type, id, fingerprint);
  const { results } = await db.prepare(`SELECT * FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY purpose ORDER BY created_at DESC, rowid DESC) AS rn
    FROM entity_assessments WHERE project_id = ? AND subject_type = ? AND subject_id = ?
  ) WHERE rn = 1`).bind(projectId, type, id).all<any>();
  const records: AssessmentRecord[] = results.map(row => ({
    ...AssessmentInput.parse(JSON.parse(row.assessment_json)), id: row.id, subjectType: type, subjectId: id,
    contentFingerprint: row.content_fingerprint, contextFingerprint: row.context_fingerprint,
    actorKind: row.actor_kind, actorId: row.actor_id, actorName: row.actor_name,
    createdAt: row.created_at, provenance: 'actor_reported' as const,
  }));
  const view = (purpose: string): AssessmentState['readiness'] => {
    const record = records.find(r => r.purpose === purpose) ?? null;
    if (!record) return { state: 'missing', record };
    const revisionMismatch = revision?.baseId && record.scope === 'repository' &&
      (record.baseId !== revision.baseId || (revision.repositoryKey && record.repositoryKey !== revision.repositoryKey) ||
       (revision.branch && record.branch !== revision.branch));
    const stale = record.contentFingerprint !== fingerprint || record.contextFingerprint !== context.fingerprint || revisionMismatch;
    return { state: stale ? 'stale' : record.outcome, record };
  };
  return { required: context.required, projectPolicy: context.projectPolicy, directionMarkers: type === 'task' ? await unresolvedDirections(db, projectId, id) : [], contextFingerprint: context.fingerprint,
    readiness: view(type === 'task' ? 'readiness' : 'document'), implementation: view('implementation') };
}

/** An override is bounded to the facts AND latest evidence; a new failed check revokes it. */
export async function overrideContext(state: AssessmentState): Promise<string> {
  return sha256Hex(JSON.stringify([state.contextFingerprint, state.readiness.record?.id ?? null, state.implementation.record?.id ?? null]));
}
export async function activeOverrides(db: D1Database, projectId: string, subjectId: string, state: AssessmentState,
  revision?: { repositoryKey?: string | null; branch?: string | null; baseId?: string | null } | null): Promise<ReadinessOverrideRecord[]> {
  const context = await overrideContext(state);
  const { results } = await db.prepare(`SELECT * FROM entity_readiness_overrides WHERE project_id = ? AND subject_id = ?
    AND actor_kind = 'human' AND context_fingerprint = ? AND expires_at > ? ORDER BY created_at DESC, rowid DESC LIMIT 20`)
    .bind(projectId, subjectId, context, nowIso()).all<any>();
  return results.filter(row => {
    const expected = row.revision_json ? JSON.parse(row.revision_json) : null;
    // A declaration of a different revision must never reuse an old override.
    return !revision?.baseId || (expected?.baseId === revision.baseId &&
      (!revision.repositoryKey || expected.repositoryKey === revision.repositoryKey) &&
      (!revision.branch || expected.branch === revision.branch));
  }).map(row => ({ id: row.id, scope: row.scope, reason: row.reason, actorKind: row.actor_kind,
    actorId: row.actor_id, actorName: row.actor_name, createdAt: row.created_at, expiresAt: row.expires_at,
    contextFingerprint: row.context_fingerprint, revision: row.revision_json ? JSON.parse(row.revision_json) : null }));
}
export async function recordOverride(db: D1Database, projectId: string, actor: Actor, state: AssessmentState, raw: ReadinessOverrideInput) {
  const input = ReadinessOverrideInput.parse(raw);
  const prior = input.scope === 'implementation' ? state.implementation.record : state.readiness.record;
  const record = { id: newId('ovr'), scope: input.scope, reason: input.reason,
    contextFingerprint: await overrideContext(state), actorKind: actor.kind, actorId: actor.id, actorName: actor.name,
    createdAt: nowIso(), expiresAt: new Date(Date.now() + input.durationSeconds * 1000).toISOString(),
    revision: input.baseId ? { repositoryKey: input.repositoryKey ?? prior?.repositoryKey, branch: input.branch ?? prior?.branch, baseId: input.baseId }
      : prior?.baseId ? { repositoryKey: prior.repositoryKey, branch: prior.branch, baseId: prior.baseId } : null,
  };
  await db.prepare(`INSERT INTO entity_readiness_overrides (id, project_id, subject_id, scope, context_fingerprint,
    reason, revision_json, actor_kind, actor_id, actor_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(record.id, projectId, input.subjectId, input.scope, record.contextFingerprint, input.reason,
      JSON.stringify(record.revision), actor.kind, actor.id, actor.name, record.createdAt, record.expiresAt).run();
  return record;
}

/** Audit history, including superseded/expired exceptions. No read mutates validity. */
export async function assessmentHistory(db: D1Database, projectId: string, type: ValidationSubjectType, id: string, limit = 20) {
  const take = Math.max(1, Math.min(100, Math.trunc(limit) || 20));
  const [assessments, overrides] = await Promise.all([
    db.prepare(`SELECT * FROM entity_assessments WHERE project_id = ? AND subject_type = ? AND subject_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`).bind(projectId, type, id, take).all<any>(),
    db.prepare(`SELECT * FROM entity_readiness_overrides WHERE project_id = ? AND subject_id = ? AND ? = 'task' ORDER BY created_at DESC, rowid DESC LIMIT ?`).bind(projectId, id, type, take).all<any>(),
  ]);
  return {
    assessments: assessments.results.map(row => ({ ...AssessmentInput.parse(JSON.parse(row.assessment_json)), id: row.id,
      subjectType: type, subjectId: id, contentFingerprint: row.content_fingerprint, contextFingerprint: row.context_fingerprint,
      actorKind: row.actor_kind, actorId: row.actor_id, actorName: row.actor_name, createdAt: row.created_at, provenance: 'actor_reported' as const })) as AssessmentRecord[],
    overrides: overrides.results.map(row => ({ id: row.id, scope: row.scope, reason: row.reason, actorKind: row.actor_kind,
      actorId: row.actor_id, actorName: row.actor_name, createdAt: row.created_at, expiresAt: row.expires_at,
      contextFingerprint: row.context_fingerprint, revision: row.revision_json ? JSON.parse(row.revision_json) : null })) as ReadinessOverrideRecord[],
    limit: take,
  };
}
