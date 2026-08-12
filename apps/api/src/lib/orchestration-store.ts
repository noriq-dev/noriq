import type { Env } from '../env';
import { newId, nowIso, sha256Hex } from './util';
import type {
  ExecutionAssignment,
  ExecutionReportAck,
  RunnerExecutionDeclaration,
  RunnerExecutionEventReport,
  RunnerExecutionReconciliation,
  RunnerExecutionRelationReport,
} from '@noriq-dev/shared';

export const EXECUTION_KINDS = ['copilot_session', 'run', 'sitting', 'stage', 'step', 'gate'] as const;
export const EXECUTION_ROLES = ['orchestrator', 'planner', 'worker', 'reviewer', 'verifier', 'repair', 'system'] as const;
export const EXECUTION_STATUSES = ['pending', 'running', 'parked', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const;
export const EXECUTION_RELATIONS = ['continues', 'verifies', 'repairs', 'hands_off_to', 'depends_on'] as const;
export const EXECUTION_EVENTS = ['started', 'parked', 'resumed', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const;

export type ExecutionKind = typeof EXECUTION_KINDS[number];
export type ExecutionRole = typeof EXECUTION_ROLES[number];
export type ExecutionStatus = typeof EXECUTION_STATUSES[number];
export type ExecutionRelationType = typeof EXECUTION_RELATIONS[number];
export type ExecutionEventType = typeof EXECUTION_EVENTS[number];
export type LineageStatus = 'complete' | 'partial' | 'unknown';
export type ActorRef = { id: string; kind: 'human' | 'copilot' | 'agent' | 'runner' | 'system' };

export type ExecutionSubject = {
  taskId?: string | null;
  planId?: string | null;
  runId?: string | null;
  sitting?: number | null;
  stage?: string | null;
  step?: string | null;
  gateId?: string | null;
};

export type DeclareExecutionInput = {
  projectId: string;
  orchestrationId: string;
  parentExecutionId?: string | null;
  localNodeKey: string;
  producerScope: string;
  kind: ExecutionKind;
  role: ExecutionRole;
  actor?: ActorRef | null;
  presenceId?: string | null;
  subject?: ExecutionSubject;
  completeness?: { status: LineageStatus; missing?: string[]; reason?: string | null };
  /** Explicit terminal continuation. The new node points to the terminal predecessor with a
   * `continues` relation; structural parentage is still declared independently and immutable. */
  continuesExecutionId?: string;
  /** Internal accepting-server exception: a plan pump or verifier may append a new immutable
   * child to its durable work envelope. Public clients cannot set this through REST/MCP schemas. */
  allowTerminalExtension?: boolean;
  observedAt: string;
};

type ExecutionRow = {
  id: string;
  orchestrationId: string;
  projectId: string;
  parentExecutionId: string | null;
  declarationHash: string | null;
  status: ExecutionStatus;
  lastRevision: number;
  finishedAt: string | null;
};

const terminal = new Set<ExecutionStatus>(['succeeded', 'failed', 'cancelled', 'interrupted']);
const MAX_METADATA_BYTES = 8_192;

function normalizedJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(normalizedJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${normalizedJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function iso(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be an ISO date-time`);
  return new Date(parsed).toISOString();
}

function boundedMetadata(value: Record<string, unknown> | undefined): string {
  const encoded = normalizedJson(value ?? {});
  if (new TextEncoder().encode(encoded).byteLength > MAX_METADATA_BYTES) {
    throw new Error(`execution metadata exceeds ${MAX_METADATA_BYTES} bytes`);
  }
  return encoded;
}

async function assertSubjectScope(db: D1Database, projectId: string, subject: ExecutionSubject): Promise<void> {
  const checks: Array<Promise<unknown>> = [];
  if (subject.taskId) checks.push(db.prepare('SELECT 1 FROM tasks WHERE id = ? AND project_id = ?').bind(subject.taskId, projectId).first());
  if (subject.planId) checks.push(db.prepare('SELECT 1 FROM plans WHERE id = ? AND project_id = ?').bind(subject.planId, projectId).first());
  if (subject.runId) checks.push(db.prepare('SELECT 1 FROM runs WHERE id = ? AND project_id = ?').bind(subject.runId, projectId).first());
  if ((await Promise.all(checks)).some((row) => !row)) throw new Error('execution subject is outside the orchestration project');
}

async function actorExists(db: D1Database, actor: ActorRef | null | undefined): Promise<boolean> {
  if (!actor || actor.kind === 'human' || actor.kind === 'system') return true;
  if (actor.kind === 'runner') return Boolean(await db.prepare('SELECT 1 FROM runners WHERE id = ?').bind(actor.id).first());
  return Boolean(await db.prepare('SELECT 1 FROM agents WHERE id = ? AND kind = ?')
    .bind(actor.id, actor.kind === 'agent' ? 'agent' : 'copilot').first());
}

async function actorUserId(db: D1Database, actor: ActorRef): Promise<string | null> {
  if (actor.kind === 'human') return actor.id;
  if (actor.kind === 'agent' || actor.kind === 'copilot') {
    return (await db.prepare('SELECT user_id AS userId FROM agents WHERE id = ? AND kind = ?')
      .bind(actor.id, actor.kind).first<{ userId: string }>())?.userId ?? null;
  }
  if (actor.kind === 'runner') {
    return (await db.prepare('SELECT owner_user_id AS userId FROM runners WHERE id = ?')
      .bind(actor.id).first<{ userId: string }>())?.userId ?? null;
  }
  return null;
}

export async function createOrchestration(env: Env, input: {
  projectId: string;
  anchor: { type: 'task' | 'plan' | 'run' | 'chat'; id: string } | { type: 'none' };
  createdBy: ActorRef;
  completeness?: { status: LineageStatus; missing?: string[]; reason?: string | null };
  createdAt?: string;
}): Promise<{ id: string }> {
  if (!await actorExists(env.DB, input.createdBy)) throw new Error('orchestration creator does not exist');
  const anchorId = input.anchor.type === 'none' ? null : input.anchor.id;
  if (input.anchor.type !== 'none') {
    const table = input.anchor.type === 'task' ? 'tasks' : input.anchor.type === 'plan' ? 'plans' : input.anchor.type === 'run' ? 'runs' : null;
    const ownerUserId = input.anchor.type === 'chat' ? await actorUserId(env.DB, input.createdBy) : null;
    const found = table
      ? await env.DB.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND project_id = ?`).bind(anchorId, input.projectId).first()
      : ownerUserId
        ? await env.DB.prepare('SELECT 1 FROM ask_threads WHERE id = ? AND user_id = ?').bind(anchorId, ownerUserId).first()
        : null;
    if (!found) throw new Error('orchestration anchor is outside the project');
  }
  const id = newId('orc');
  const at = input.createdAt ? iso(input.createdAt, 'createdAt') : nowIso();
  const completeness = input.completeness ?? { status: 'complete' as const, missing: [], reason: null };
  await env.DB.prepare(
    `INSERT INTO orchestrations (
       id, project_id, anchor_type, anchor_id, status, completeness_status,
       completeness_missing, completeness_reason, created_by_kind, created_by_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, input.projectId, input.anchor.type, anchorId, completeness.status,
    JSON.stringify(completeness.missing ?? []), completeness.reason ?? null,
    input.createdBy.kind, input.createdBy.id, at, at,
  ).run();
  return { id };
}

export async function declareExecution(env: Env, input: DeclareExecutionInput): Promise<{ id: string; created: boolean }> {
  const observedAt = iso(input.observedAt, 'observedAt');
  const orchestration = await env.DB.prepare(
    'SELECT project_id AS projectId, status FROM orchestrations WHERE id = ?',
  ).bind(input.orchestrationId).first<{ projectId: string; status: ExecutionStatus }>();
  if (!orchestration || orchestration.projectId !== input.projectId) throw new Error('orchestration is outside the authorized project');
  if (!input.localNodeKey || !input.producerScope) throw new Error('producerScope and localNodeKey are required');
  if (!await actorExists(env.DB, input.actor)) throw new Error('execution actor does not exist or has the wrong kind');
  const subject = input.subject ?? {};
  await assertSubjectScope(env.DB, input.projectId, subject);
  const completeness = input.completeness ?? { status: 'complete' as const, missing: [], reason: null };
  const canonical = {
    orchestrationId: input.orchestrationId,
    projectId: input.projectId,
    parentExecutionId: input.parentExecutionId ?? null,
    producerScope: input.producerScope,
    localNodeKey: input.localNodeKey,
    kind: input.kind,
    role: input.role,
    actor: input.actor ?? null,
    presenceId: input.presenceId ?? null,
    subject,
    completeness,
    continuesExecutionId: input.continuesExecutionId ?? null,
  };
  const declarationHash = await sha256Hex(normalizedJson(canonical));
  const existing = await env.DB.prepare(
    `SELECT id, declaration_hash AS declarationHash FROM execution_nodes
      WHERE producer_scope = ? AND local_node_key = ?`,
  ).bind(input.producerScope, input.localNodeKey).first<{ id: string; declarationHash: string | null }>();
  if (existing) {
    if (existing.declarationHash !== declarationHash) throw new Error('local execution key conflicts with its canonical declaration');
    return { id: existing.id, created: false };
  }
  if (terminal.has(orchestration.status) && !input.continuesExecutionId && !input.allowTerminalExtension) {
    throw new Error('orchestration is terminal; declare an authorized continuation instead');
  }

  let parent: ExecutionRow | null = null;
  let continued: ExecutionRow | null = null;
  if (input.continuesExecutionId) {
    continued = await env.DB.prepare(
      `SELECT id, orchestration_id AS orchestrationId, project_id AS projectId,
              parent_execution_id AS parentExecutionId, declaration_hash AS declarationHash,
              status, last_revision AS lastRevision, finished_at AS finishedAt
         FROM execution_nodes WHERE id = ?`,
    ).bind(input.continuesExecutionId).first<ExecutionRow>();
    if (!continued || continued.orchestrationId !== input.orchestrationId || continued.projectId !== input.projectId) {
      throw new Error('continued execution is outside the orchestration scope');
    }
    if (!terminal.has(continued.status)) throw new Error('only a terminal execution can be continued');
  }
  if (input.parentExecutionId) {
    parent = await env.DB.prepare(
      `SELECT id, orchestration_id AS orchestrationId, project_id AS projectId,
              parent_execution_id AS parentExecutionId, declaration_hash AS declarationHash,
              status, last_revision AS lastRevision, finished_at AS finishedAt
         FROM execution_nodes WHERE id = ?`,
    ).bind(input.parentExecutionId).first<ExecutionRow>();
    if (!parent || parent.orchestrationId !== input.orchestrationId || parent.projectId !== input.projectId) {
      throw new Error('execution parent is outside the orchestration scope');
    }
    if (!continued && parent.finishedAt && Date.parse(observedAt) > Date.parse(parent.finishedAt)) {
      throw new Error('cannot create a child observed after its parent finished');
    }
  }

  const id = newId('exe');
  const statements = [
    env.DB.prepare(
      `INSERT INTO execution_nodes (
         id, orchestration_id, project_id, parent_execution_id, local_node_key, producer_scope,
         declaration_hash, kind, role, actor_kind, actor_id, presence_id,
         task_id, plan_id, run_id, sitting, stage, step, gate_id, status,
         completeness_status, completeness_missing, completeness_reason, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    ).bind(
      id, input.orchestrationId, input.projectId, input.parentExecutionId ?? null,
      input.localNodeKey, input.producerScope, declarationHash, input.kind, input.role,
      input.actor?.kind ?? null, input.actor?.id ?? null, input.presenceId ?? null,
      subject.taskId ?? null, subject.planId ?? null, subject.runId ?? null, subject.sitting ?? null,
      subject.stage ?? null, subject.step ?? null, subject.gateId ?? null,
      completeness.status, JSON.stringify(completeness.missing ?? []), completeness.reason ?? null,
      observedAt, observedAt,
    ),
    env.DB.prepare(
      `UPDATE orchestrations SET root_execution_id = ?, updated_at = ?
        WHERE id = ? AND root_execution_id IS NULL AND ? IS NULL`,
    ).bind(id, observedAt, input.orchestrationId, input.parentExecutionId ?? null),
  ];
  if (continued) {
    statements.push(env.DB.prepare(
      `INSERT INTO execution_relations (
         id, orchestration_id, project_id, from_execution_id, to_execution_id, type, metadata, created_at
       ) VALUES (?, ?, ?, ?, ?, 'continues', ?, ?)`,
    ).bind(
      newId('rel'), input.orchestrationId, input.projectId, id, continued.id,
      JSON.stringify({ source: 'explicit_continuation' }), observedAt,
    ));
  }
  await env.DB.batch(statements);
  if (continued) await refreshOrchestrationStatus(env.DB, input.orchestrationId, observedAt);
  return { id, created: true };
}

export async function addExecutionRelation(env: Env, input: {
  projectId: string;
  orchestrationId: string;
  fromExecutionId: string;
  toExecutionId: string;
  type: ExecutionRelationType;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}): Promise<{ id: string; created: boolean }> {
  if (input.fromExecutionId === input.toExecutionId) throw new Error('execution relation cannot reference itself');
  const { results } = await env.DB.prepare(
    `SELECT id, project_id AS projectId, orchestration_id AS orchestrationId
       FROM execution_nodes WHERE id IN (?, ?)`,
  ).bind(input.fromExecutionId, input.toExecutionId).all<{ id: string; projectId: string; orchestrationId: string }>();
  if (results.length !== 2 || results.some((row) => row.projectId !== input.projectId || row.orchestrationId !== input.orchestrationId)) {
    throw new Error('execution relation endpoints are outside the orchestration scope');
  }
  const metadata = boundedMetadata(input.metadata);
  const existing = await env.DB.prepare(
    `SELECT id, metadata FROM execution_relations
      WHERE from_execution_id = ? AND to_execution_id = ? AND type = ?`,
  ).bind(input.fromExecutionId, input.toExecutionId, input.type).first<{ id: string; metadata: string }>();
  if (existing) {
    if (existing.metadata !== metadata) throw new Error('execution relation conflicts with its canonical metadata');
    return { id: existing.id, created: false };
  }
  if (input.type === 'continues' || input.type === 'depends_on') {
    const cycle = await env.DB.prepare(
      `WITH RECURSIVE reachable(id) AS (
         SELECT to_execution_id FROM execution_relations WHERE from_execution_id = ? AND type = ?
         UNION
         SELECT r.to_execution_id FROM execution_relations r JOIN reachable q ON r.from_execution_id = q.id
          WHERE r.type = ?
       ) SELECT 1 FROM reachable WHERE id = ? LIMIT 1`,
    ).bind(input.toExecutionId, input.type, input.type, input.fromExecutionId).first();
    if (cycle) throw new Error(`${input.type} relation would create a cycle`);
  }
  const id = newId('rel');
  await env.DB.prepare(
    `INSERT INTO execution_relations (
       id, orchestration_id, project_id, from_execution_id, to_execution_id, type, metadata, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, input.orchestrationId, input.projectId, input.fromExecutionId, input.toExecutionId,
    input.type, metadata, input.createdAt ? iso(input.createdAt, 'createdAt') : nowIso(),
  ).run();
  return { id, created: true };
}

export async function applyExecutionEvent(env: Env, input: {
  projectId: string;
  orchestrationId: string;
  executionId: string;
  eventId: string;
  revision: number;
  type: ExecutionEventType;
  observedAt: string;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<{ applied: boolean; status: ExecutionStatus; expectedRevision: number }> {
  const observedAt = iso(input.observedAt, 'observedAt');
  const metadata = boundedMetadata(input.metadata);
  const canonical = {
    orchestrationId: input.orchestrationId, executionId: input.executionId,
    revision: input.revision, type: input.type, observedAt,
    reason: input.reason ?? null, metadata: JSON.parse(metadata) as Record<string, unknown>,
  };
  const payloadHash = await sha256Hex(normalizedJson(canonical));
  const repeated = await env.DB.prepare(
    'SELECT payload_hash AS payloadHash FROM execution_lifecycle_events WHERE event_id = ?',
  ).bind(input.eventId).first<{ payloadHash: string }>();
  const node = await env.DB.prepare(
    `SELECT id, orchestration_id AS orchestrationId, project_id AS projectId,
            parent_execution_id AS parentExecutionId, declaration_hash AS declarationHash,
            status, last_revision AS lastRevision, finished_at AS finishedAt
       FROM execution_nodes WHERE id = ?`,
  ).bind(input.executionId).first<ExecutionRow>();
  if (!node || node.projectId !== input.projectId || node.orchestrationId !== input.orchestrationId) {
    throw new Error('execution is outside the authorized orchestration');
  }
  if (repeated) {
    if (repeated.payloadHash !== payloadHash) throw new Error('eventId conflicts with its accepted payload');
    return { applied: false, status: node.status, expectedRevision: node.lastRevision + 1 };
  }
  const revisionConflict = await env.DB.prepare(
    'SELECT payload_hash AS payloadHash FROM execution_lifecycle_events WHERE execution_id = ? AND revision = ?',
  ).bind(input.executionId, input.revision).first<{ payloadHash: string }>();
  if (revisionConflict) {
    if (revisionConflict.payloadHash !== payloadHash) throw new Error('execution revision conflicts with its accepted event');
    return { applied: false, status: node.status, expectedRevision: node.lastRevision + 1 };
  }
  if (input.revision !== node.lastRevision + 1) {
    throw new Error(`execution revision gap: expected ${node.lastRevision + 1}`);
  }
  const acceptedAt = nowIso();
  await env.DB.prepare(
    `INSERT INTO execution_lifecycle_events (
       event_id, orchestration_id, execution_id, revision, event_type, payload_hash,
       observed_at, reason, metadata, accepted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.eventId, input.orchestrationId, input.executionId, input.revision, input.type,
    payloadHash, observedAt, input.reason ?? null, metadata, acceptedAt,
  ).run();
  const updated = await env.DB.prepare(
    'SELECT status, last_revision AS lastRevision FROM execution_nodes WHERE id = ?',
  ).bind(input.executionId).first<{ status: ExecutionStatus; lastRevision: number }>();
  await refreshOrchestrationStatus(env.DB, input.orchestrationId, acceptedAt);
  return { applied: true, status: updated!.status, expectedRevision: updated!.lastRevision + 1 };
}

export async function refreshOrchestrationStatus(db: D1Database, orchestrationId: string, at = nowIso()): Promise<ExecutionStatus> {
  const { results } = await db.prepare(
    `SELECT n.status, COUNT(*) AS count FROM execution_nodes n
      WHERE n.orchestration_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM execution_nodes child WHERE child.parent_execution_id = n.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM execution_relations r
           WHERE r.orchestration_id = n.orchestration_id
             AND r.type = 'continues' AND r.to_execution_id = n.id
        )
      GROUP BY n.status`,
  ).bind(orchestrationId).all<{ status: ExecutionStatus; count: number }>();
  const counts = new Map(results.map((row) => [row.status, Number(row.count)]));
  const total = results.reduce((sum, row) => sum + Number(row.count), 0);
  let status: ExecutionStatus = 'pending';
  if (counts.get('failed')) status = 'failed';
  else if (counts.get('cancelled')) status = 'cancelled';
  else if (counts.get('interrupted')) status = 'interrupted';
  else if (counts.get('running')) status = 'running';
  else if (counts.get('parked')) status = 'parked';
  else if (total > 0 && (counts.get('succeeded') ?? 0) === total) status = 'succeeded';
  const finishedAt = terminal.has(status) ? at : null;
  await db.prepare(
    'UPDATE orchestrations SET status = ?, updated_at = ?, finished_at = ? WHERE id = ?',
  ).bind(status, at, finishedAt, orchestrationId).run();
  return status;
}

type RunExecutionFacts = {
  id: string;
  projectId: string;
  runnerId: string | null;
  agentId: string | null;
  kind: 'scope' | 'build' | 'verify';
  taskId: string | null;
  planId: string | null;
  verifiesRunId: string | null;
  planDispatchId: string | null;
  sitting: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

async function loadRunExecutionFacts(db: D1Database, runId: string): Promise<RunExecutionFacts> {
  const run = await db.prepare(
    `SELECT r.id, r.project_id AS projectId, r.runner_id AS runnerId, r.agent_id AS agentId,
            r.kind,
            CASE WHEN r.anchor_type = 'task' AND EXISTS (
              SELECT 1 FROM tasks t WHERE t.id = r.anchor_id AND t.project_id = r.project_id
            ) THEN r.anchor_id END AS taskId,
            CASE
              WHEN r.plan_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM plans p WHERE p.id = r.plan_id AND p.project_id = r.project_id
              ) THEN r.plan_id
              WHEN r.anchor_type = 'plan' AND EXISTS (
                SELECT 1 FROM plans p WHERE p.id = r.anchor_id AND p.project_id = r.project_id
              ) THEN r.anchor_id
            END AS planId,
            r.verifies_run_id AS verifiesRunId, r.plan_dispatch_id AS planDispatchId,
            r.sitting, r.created_by AS createdBy, r.created_at AS createdAt, r.updated_at AS updatedAt
       FROM runs r WHERE r.id = ?`,
  ).bind(runId).first<RunExecutionFacts>();
  if (!run) throw new Error('run not found');
  return run;
}

const runRole = (kind: RunExecutionFacts['kind']): ExecutionRole => (
  kind === 'scope' ? 'planner' : kind === 'verify' ? 'verifier' : 'worker'
);

async function runCreator(db: D1Database, id: string): Promise<ActorRef> {
  const agent = await db.prepare('SELECT kind FROM agents WHERE id = ?').bind(id).first<{ kind: 'copilot' | 'agent' }>();
  if (agent) return { id, kind: agent.kind };
  if (await db.prepare('SELECT 1 FROM runners WHERE id = ?').bind(id).first()) return { id, kind: 'runner' };
  return { id, kind: 'human' };
}

async function assignmentForRun(db: D1Database, runId: string, sitting?: number): Promise<ExecutionAssignment | null> {
  const row = await db.prepare(
    `SELECT n.id AS executionId, n.orchestration_id AS orchestrationId,
            n.parent_execution_id AS parentExecutionId, n.role,
            n.completeness_status AS lineageStatus
       FROM execution_nodes n
      WHERE n.run_id = ? AND n.kind = 'sitting' AND (? IS NULL OR n.sitting = ?)
      ORDER BY n.sitting DESC LIMIT 1`,
  ).bind(runId, sitting ?? null, sitting ?? null).first<Omit<ExecutionAssignment, 'schemaVersion'>>();
  return row ? { schemaVersion: 1, ...row } : null;
}

/** Ensure the server-authored Run and current-sitting nodes exist, then return the assignment a
 * capable Runner receives. Server-side Run facts win; the caller supplies no project, role,
 * actor, plan, task, or sitting claims. */
export async function ensureRunExecution(env: Env, runId: string): Promise<ExecutionAssignment> {
  const run = await loadRunExecutionFacts(env.DB, runId);
  const existing = await assignmentForRun(env.DB, run.id, run.sitting);
  if (existing) return existing;

  const storedRunNode = await env.DB.prepare(
    `SELECT id, orchestration_id AS orchestrationId, parent_execution_id AS parentExecutionId
       FROM execution_nodes WHERE producer_scope = ? AND local_node_key = 'run'`,
  ).bind(`run/${run.id}`).first<{ id: string; orchestrationId: string; parentExecutionId: string | null }>();
  let orchestrationId = storedRunNode?.orchestrationId ?? '';
  let parentExecutionId: string | null = storedRunNode?.parentExecutionId ?? null;
  let verifiedRunNodeId: string | null = null;
  if (storedRunNode) {
    const scoped = await env.DB.prepare(
      'SELECT 1 FROM execution_nodes WHERE id = ? AND project_id = ? AND run_id = ?',
    ).bind(storedRunNode.id, run.projectId, run.id).first();
    if (!scoped) throw new Error('stored run execution has invalid scope');
  } else if (run.planDispatchId) {
    const scope = `plan-dispatch/${run.planDispatchId}`;
    let root = await env.DB.prepare(
      `SELECT id, orchestration_id AS orchestrationId FROM execution_nodes
        WHERE producer_scope = ? AND local_node_key = 'root'`,
    ).bind(scope).first<{ id: string; orchestrationId: string }>();
    if (!root) {
      const orchestration = await createOrchestration(env, {
        projectId: run.projectId,
        anchor: run.planId ? { type: 'plan', id: run.planId } : { type: 'none' },
        createdBy: { kind: 'system', id: 'system' },
        completeness: { status: 'complete' },
        createdAt: run.createdAt,
      });
      const declared = await declareExecution(env, {
        projectId: run.projectId, orchestrationId: orchestration.id,
        producerScope: scope, localNodeKey: 'root', kind: 'stage', role: 'orchestrator',
        actor: { kind: 'system', id: 'system' }, subject: { planId: run.planId, stage: 'plan_dispatch' },
        observedAt: run.createdAt,
      });
      root = { id: declared.id, orchestrationId: orchestration.id };
    }
    orchestrationId = root.orchestrationId;
    parentExecutionId = root.id;
  } else if (run.verifiesRunId) {
    const target = await ensureRunExecution(env, run.verifiesRunId);
    orchestrationId = target.orchestrationId;
    verifiedRunNodeId = target.parentExecutionId;
  } else {
    const orchestration = await createOrchestration(env, {
      projectId: run.projectId,
      anchor: { type: 'run', id: run.id },
      createdBy: await runCreator(env.DB, run.createdBy),
      completeness: { status: 'complete' },
      createdAt: run.createdAt,
    });
    orchestrationId = orchestration.id;
  }

  const role = runRole(run.kind);
  const runNode = storedRunNode ?? await declareExecution(env, {
      projectId: run.projectId, orchestrationId, parentExecutionId,
      producerScope: `run/${run.id}`, localNodeKey: 'run', kind: 'run', role,
      actor: run.runnerId ? { kind: 'runner', id: run.runnerId } : null,
      subject: { taskId: run.taskId, planId: run.planId, runId: run.id },
      allowTerminalExtension: run.planDispatchId !== null || (run.kind === 'verify' && verifiedRunNodeId !== null),
      observedAt: run.createdAt,
    });
  if (!storedRunNode && verifiedRunNodeId) {
    await addExecutionRelation(env, {
      projectId: run.projectId, orchestrationId,
      fromExecutionId: runNode.id, toExecutionId: verifiedRunNodeId,
      type: 'verifies', metadata: { source: 'runs.verifies_run_id' }, createdAt: run.createdAt,
    });
  }
  const previous = await assignmentForRun(env.DB, run.id);
  const previousStatus = previous ? await env.DB.prepare('SELECT status FROM execution_nodes WHERE id = ?')
    .bind(previous.executionId).first<{ status: ExecutionStatus }>() : null;
  const canContinue = previous && previousStatus && terminal.has(previousStatus.status);
  const sitting = await declareExecution(env, {
    projectId: run.projectId, orchestrationId, parentExecutionId: runNode.id,
    producerScope: `run/${run.id}`, localNodeKey: `sitting/${run.sitting}`,
    kind: 'sitting', role,
    actor: run.agentId ? { kind: 'agent', id: run.agentId }
      : run.runnerId ? { kind: 'runner', id: run.runnerId } : null,
    subject: { taskId: run.taskId, planId: run.planId, runId: run.id, sitting: run.sitting },
    continuesExecutionId: canContinue ? previous.executionId : undefined,
    allowTerminalExtension: run.planDispatchId !== null || (run.kind === 'verify' && verifiedRunNodeId !== null),
    observedAt: run.updatedAt,
  });
  return (await assignmentForRun(env.DB, run.id, run.sitting)) ?? {
    schemaVersion: 1, orchestrationId, executionId: sitting.id,
    parentExecutionId: runNode.id, role, lineageStatus: 'complete',
  };
}

async function assertRunnerExecutionScope(db: D1Database, run: RunExecutionFacts, executionId: string, orchestrationId: string) {
  const found = await db.prepare(
    'SELECT 1 FROM execution_nodes WHERE id = ? AND orchestration_id = ? AND project_id = ? AND run_id = ?',
  ).bind(executionId, orchestrationId, run.projectId, run.id).first();
  if (!found) throw new Error('execution is outside the server-derived run scope');
}

export async function declareRunnerExecution(
  env: Env, runId: string, input: RunnerExecutionDeclaration,
): Promise<{ id: string; created: boolean }> {
  const run = await loadRunExecutionFacts(env.DB, runId);
  const assignment = await ensureRunExecution(env, runId);
  await assertRunnerExecutionScope(env.DB, run, input.parentExecutionId, assignment.orchestrationId);
  return declareExecution(env, {
    projectId: run.projectId, orchestrationId: assignment.orchestrationId,
    parentExecutionId: input.parentExecutionId,
    producerScope: `runner/${run.runnerId ?? 'unassigned'}/run/${run.id}/sitting/${run.sitting}`,
    localNodeKey: input.localNodeKey, kind: input.kind, role: input.role,
    actor: run.agentId ? { kind: 'agent', id: run.agentId }
      : run.runnerId ? { kind: 'runner', id: run.runnerId } : null,
    subject: {
      taskId: run.taskId, planId: run.planId, runId: run.id, sitting: run.sitting,
      stage: input.stage, step: input.step, gateId: input.gateId,
    },
    continuesExecutionId: input.continuesExecutionId ?? undefined,
    observedAt: input.observedAt,
  });
}

export async function reportRunnerExecutionRelation(
  env: Env, runId: string, input: RunnerExecutionRelationReport,
): Promise<{ id: string; created: boolean }> {
  const run = await loadRunExecutionFacts(env.DB, runId);
  const assignment = await ensureRunExecution(env, runId);
  await assertRunnerExecutionScope(env.DB, run, input.fromExecutionId, assignment.orchestrationId);
  await assertRunnerExecutionScope(env.DB, run, input.toExecutionId, assignment.orchestrationId);
  return addExecutionRelation(env, {
    projectId: run.projectId, orchestrationId: assignment.orchestrationId,
    fromExecutionId: input.fromExecutionId, toExecutionId: input.toExecutionId,
    type: input.relation, metadata: input.metadata, createdAt: input.observedAt,
  });
}

export async function reportRunnerExecutionEvent(
  env: Env, runId: string, input: RunnerExecutionEventReport,
): Promise<ReturnType<typeof applyExecutionEvent> extends Promise<infer T> ? T : never> {
  const run = await loadRunExecutionFacts(env.DB, runId);
  const assignment = await ensureRunExecution(env, runId);
  await assertRunnerExecutionScope(env.DB, run, input.executionId, assignment.orchestrationId);
  return applyExecutionEvent(env, {
    projectId: run.projectId, orchestrationId: assignment.orchestrationId,
    executionId: input.executionId, eventId: input.reportId, revision: input.revision,
    type: input.event, observedAt: input.observedAt, reason: input.reason, metadata: input.metadata,
  });
}

export async function reconcileRunnerExecution(
  env: Env, runId: string, input: RunnerExecutionReconciliation,
): Promise<{ assignment: ExecutionAssignment; acknowledgements: ExecutionReportAck[] }> {
  const assignment = await ensureRunExecution(env, runId);
  const acknowledgements: ExecutionReportAck[] = [];
  for (const declaration of input.declarations) {
    try {
      const result = await declareRunnerExecution(env, runId, declaration);
      acknowledgements.push({ reportId: declaration.reportId, accepted: true, executionId: result.id, status: null, expectedRevision: null, error: null });
    } catch (error) {
      acknowledgements.push({ reportId: declaration.reportId, accepted: false, executionId: null, status: null, expectedRevision: null, error: String(error) });
    }
  }
  for (const relation of input.relations) {
    try {
      await reportRunnerExecutionRelation(env, runId, relation);
      acknowledgements.push({ reportId: relation.reportId, accepted: true, executionId: relation.fromExecutionId, status: null, expectedRevision: null, error: null });
    } catch (error) {
      acknowledgements.push({ reportId: relation.reportId, accepted: false, executionId: null, status: null, expectedRevision: null, error: String(error) });
    }
  }
  for (const event of input.events) {
    try {
      const result = await reportRunnerExecutionEvent(env, runId, event);
      acknowledgements.push({ reportId: event.reportId, accepted: true, executionId: event.executionId, status: result.status, expectedRevision: result.expectedRevision, error: null });
    } catch (error) {
      acknowledgements.push({ reportId: event.reportId, accepted: false, executionId: event.executionId, status: null, expectedRevision: null, error: String(error) });
    }
  }
  const rejected = acknowledgements.filter((ack) => !ack.accepted).length;
  acknowledgements.push({
    reportId: input.reportId, accepted: rejected === 0, executionId: assignment.executionId,
    status: null, expectedRevision: null,
    error: rejected ? `${rejected} reconciliation report(s) were rejected` : null,
  });
  return { assignment, acknowledgements };
}

/** Mirror the server-authoritative Run transition into its current sitting. Older Runners gain
 * truthful execution history without knowing the new protocol; capable Runners use explicit
 * execution reports only for child stages/steps/gates. */
export async function mirrorRunTransition(env: Env, input: {
  runId: string;
  from: string;
  to: string;
  observedAt: string;
  reason?: string | null;
}): Promise<void> {
  const event = input.to === 'running'
    ? (input.from === 'blocked' ? 'resumed' : 'started')
    : input.to === 'blocked' ? 'parked'
      : input.to === 'done' ? 'succeeded'
        : input.to === 'failed' || input.to === 'gated' ? 'failed'
          : input.to === 'cancelled' ? 'cancelled' : null;
  if (!event) return;
  const assignment = await ensureRunExecution(env, input.runId);
  const node = await env.DB.prepare('SELECT last_revision AS revision FROM execution_nodes WHERE id = ?')
    .bind(assignment.executionId).first<{ revision: number }>();
  if (!node) throw new Error('run execution assignment disappeared');
  await applyExecutionEvent(env, {
    projectId: (await loadRunExecutionFacts(env.DB, input.runId)).projectId,
    orchestrationId: assignment.orchestrationId,
    executionId: assignment.executionId,
    eventId: `evt_run_${input.runId}_${assignment.executionId}_${node.revision + 1}`,
    revision: node.revision + 1,
    type: event,
    observedAt: input.observedAt,
    reason: input.reason,
    metadata: { source: 'server_run_transition', runStatus: input.to },
  });
}

type OrchestrationCursor = { updatedAt: string; id: string };
type TimelineCursor = { observedAt: string; eventId: string };

const encodeReadCursor = (value: object) => btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
function decodeReadCursor<T>(raw: string | undefined, fields: string[]): T | null {
  if (!raw) return null;
  try {
    const padded = raw.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - raw.length % 4) % 4);
    const value = JSON.parse(atob(padded)) as Record<string, unknown>;
    if (fields.some((field) => typeof value[field] !== 'string' || !value[field])) throw new Error('invalid cursor');
    return value as T;
  } catch { throw new Error('cursor is invalid or expired'); }
}

export async function listOrchestrations(db: D1Database, projectId: string, options: {
  view?: 'active' | 'history'; cursor?: string; limit?: number;
} = {}) {
  const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 40)));
  const cursor = decodeReadCursor<OrchestrationCursor>(options.cursor, ['updatedAt', 'id']);
  const statuses = options.view === 'history'
    ? "o.status IN ('succeeded','failed','cancelled','interrupted')"
    : "o.status IN ('pending','running','parked')";
  const cursorSql = cursor ? ' AND (o.updated_at < ? OR (o.updated_at = ? AND o.id < ?))' : '';
  const binds: unknown[] = [projectId];
  if (cursor) binds.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
  binds.push(limit + 1);
  const rows = await db.prepare(
    `SELECT o.id, o.anchor_type AS anchorType, o.anchor_id AS anchorId, o.root_execution_id AS rootExecutionId,
            o.status, o.completeness_status AS completenessStatus,
            o.completeness_missing AS completenessMissing, o.completeness_reason AS completenessReason,
            o.created_by_kind AS createdByKind, o.created_by_id AS createdById,
            CASE o.created_by_kind
              WHEN 'human' THEN (SELECT name FROM users WHERE id = o.created_by_id)
              WHEN 'runner' THEN (SELECT label FROM runners WHERE id = o.created_by_id)
              WHEN 'agent' THEN (SELECT COALESCE(label, name) FROM agents WHERE id = o.created_by_id)
              WHEN 'copilot' THEN (SELECT COALESCE(label, name) FROM agents WHERE id = o.created_by_id)
              ELSE 'system' END AS createdByName,
            CASE o.anchor_type
              WHEN 'task' THEN (SELECT key || ' · ' || title FROM tasks WHERE id = o.anchor_id)
              WHEN 'plan' THEN (SELECT title FROM plans WHERE id = o.anchor_id)
              WHEN 'run' THEN (SELECT kind || ' run · ' || id FROM runs WHERE id = o.anchor_id)
              WHEN 'chat' THEN (SELECT title FROM ask_threads WHERE id = o.anchor_id)
              ELSE 'Unanchored orchestration' END AS anchorLabel,
            (SELECT COUNT(*) FROM execution_nodes n WHERE n.orchestration_id = o.id) AS nodeCount,
            (SELECT COUNT(*) FROM execution_nodes n WHERE n.orchestration_id = o.id
              AND n.status IN ('pending','running','parked')) AS liveNodeCount,
            (SELECT COUNT(*) FROM execution_nodes n WHERE n.orchestration_id = o.id
              AND n.completeness_status != 'complete') AS incompleteNodeCount,
            o.created_at AS createdAt, o.updated_at AS updatedAt, o.finished_at AS finishedAt
       FROM orchestrations o
      WHERE o.project_id = ? AND ${statuses}${cursorSql}
      ORDER BY o.updated_at DESC, o.id DESC LIMIT ?`,
  ).bind(...binds).all<Record<string, unknown> & { id: string; updatedAt: string }>();
  const hasMore = rows.results.length > limit;
  const orchestrations = rows.results.slice(0, limit).map((row) => ({
    ...row,
    completenessMissing: (() => { try { return JSON.parse(String(row.completenessMissing)); } catch { return []; } })(),
  }));
  const last = orchestrations.at(-1);
  const counts = await db.prepare(
    `SELECT SUM(status IN ('pending','running','parked')) AS active,
            SUM(status IN ('succeeded','failed','cancelled','interrupted')) AS history,
            COUNT(*) AS total FROM orchestrations WHERE project_id = ?`,
  ).bind(projectId).first<{ active: number; history: number; total: number }>();
  return {
    orchestrations,
    counts: { active: Number(counts?.active ?? 0), history: Number(counts?.history ?? 0), total: Number(counts?.total ?? 0) },
    page: { limit, hasMore, nextCursor: hasMore && last ? encodeReadCursor({ updatedAt: String(last.updatedAt), id: last.id }) : null },
  };
}

export async function getOrchestrationTree(db: D1Database, projectId: string, orchestrationId: string, options: {
  timelineCursor?: string; timelineLimit?: number;
} = {}) {
  const orchestration = await db.prepare(
    `SELECT id, project_id AS projectId, anchor_type AS anchorType, anchor_id AS anchorId,
            root_execution_id AS rootExecutionId, status, completeness_status AS completenessStatus,
            completeness_missing AS completenessMissing, completeness_reason AS completenessReason,
            created_by_kind AS createdByKind, created_by_id AS createdById,
            CASE created_by_kind
              WHEN 'human' THEN (SELECT name FROM users WHERE id = orchestrations.created_by_id)
              WHEN 'runner' THEN (SELECT label FROM runners WHERE id = orchestrations.created_by_id)
              WHEN 'agent' THEN (SELECT COALESCE(label, name) FROM agents WHERE id = orchestrations.created_by_id)
              WHEN 'copilot' THEN (SELECT COALESCE(label, name) FROM agents WHERE id = orchestrations.created_by_id)
              ELSE 'system' END AS createdByName,
            CASE anchor_type
              WHEN 'task' THEN (SELECT key || ' · ' || title FROM tasks WHERE id = orchestrations.anchor_id)
              WHEN 'plan' THEN (SELECT title FROM plans WHERE id = orchestrations.anchor_id)
              WHEN 'run' THEN (SELECT kind || ' run · ' || id FROM runs WHERE id = orchestrations.anchor_id)
              WHEN 'chat' THEN (SELECT title FROM ask_threads WHERE id = orchestrations.anchor_id)
              ELSE 'Unanchored orchestration' END AS anchorLabel,
            (SELECT COUNT(*) FROM execution_nodes n WHERE n.orchestration_id = orchestrations.id) AS nodeCount,
            (SELECT COUNT(*) FROM execution_nodes n WHERE n.orchestration_id = orchestrations.id
              AND n.status IN ('pending','running','parked')) AS liveNodeCount,
            (SELECT COUNT(*) FROM execution_nodes n WHERE n.orchestration_id = orchestrations.id
              AND n.completeness_status != 'complete') AS incompleteNodeCount,
            created_at AS createdAt, updated_at AS updatedAt, finished_at AS finishedAt
       FROM orchestrations WHERE id = ? AND project_id = ?`,
  ).bind(orchestrationId, projectId).first<Record<string, unknown>>();
  if (!orchestration) throw new Error('orchestration not found');
  const timelineLimit = Math.min(200, Math.max(1, Math.trunc(options.timelineLimit ?? 100)));
  const timelineCursor = decodeReadCursor<TimelineCursor>(options.timelineCursor, ['observedAt', 'eventId']);
  const [nodes, relations, events] = await Promise.all([
    db.prepare(
      `SELECT id, parent_execution_id AS parentExecutionId, kind, role, actor_kind AS actorKind,
              actor_id AS actorId, presence_id AS presenceId, task_id AS taskId, plan_id AS planId,
              run_id AS runId, sitting, stage, step, gate_id AS gateId, status,
              CASE actor_kind
                WHEN 'human' THEN (SELECT name FROM users WHERE id = execution_nodes.actor_id)
                WHEN 'runner' THEN (SELECT label FROM runners WHERE id = execution_nodes.actor_id)
                WHEN 'agent' THEN (SELECT COALESCE(label, name) FROM agents WHERE id = execution_nodes.actor_id)
                WHEN 'copilot' THEN (SELECT COALESCE(label, name) FROM agents WHERE id = execution_nodes.actor_id)
                ELSE CASE WHEN actor_kind = 'system' THEN 'system' END END AS actorName,
              (SELECT key FROM tasks WHERE id = execution_nodes.task_id) AS taskKey,
              (SELECT title FROM tasks WHERE id = execution_nodes.task_id) AS taskTitle,
              (SELECT title FROM plans WHERE id = execution_nodes.plan_id) AS planTitle,
              completeness_status AS completenessStatus, completeness_missing AS completenessMissing,
              completeness_reason AS completenessReason, last_revision AS lastRevision,
              started_at AS startedAt, parked_at AS parkedAt, finished_at AS finishedAt,
              outcome_reason AS outcomeReason, created_at AS createdAt, updated_at AS updatedAt
         FROM execution_nodes WHERE orchestration_id = ? ORDER BY created_at, id`,
    ).bind(orchestrationId).all<Record<string, unknown> & { id: string; parentExecutionId: string | null }>(),
    db.prepare(
      `SELECT id, from_execution_id AS fromExecutionId, to_execution_id AS toExecutionId,
              type, metadata, created_at AS createdAt
         FROM execution_relations WHERE orchestration_id = ? ORDER BY created_at, id`,
    ).bind(orchestrationId).all<Record<string, unknown>>(),
    db.prepare(
      `WITH audit AS (
         SELECT event_id AS eventId, execution_id AS executionId, revision, event_type AS eventType,
                NULL AS targetExecutionId, observed_at AS observedAt, reason, metadata, accepted_at AS acceptedAt
           FROM execution_lifecycle_events WHERE orchestration_id = ?
         UNION ALL
         SELECT id AS eventId, from_execution_id AS executionId, 0 AS revision,
                type AS eventType, to_execution_id AS targetExecutionId, created_at AS observedAt, NULL AS reason, metadata,
                created_at AS acceptedAt
           FROM execution_relations WHERE orchestration_id = ?
       ) SELECT * FROM audit
        WHERE 1 = 1 ${timelineCursor ? 'AND (observedAt < ? OR (observedAt = ? AND eventId < ?))' : ''}
        ORDER BY observedAt DESC, eventId DESC LIMIT ?`,
    ).bind(
      orchestrationId, orchestrationId,
      ...(timelineCursor ? [timelineCursor.observedAt, timelineCursor.observedAt, timelineCursor.eventId] : []),
      timelineLimit + 1,
    ).all<Record<string, unknown> & { eventId: string; observedAt: string }>(),
  ]);
  const parse = (value: unknown) => { try { return JSON.parse(String(value)); } catch { return value; } };
  const hasMoreTimeline = events.results.length > timelineLimit;
  const timeline = events.results.slice(0, timelineLimit).map((event) => ({ ...event, metadata: parse(event.metadata) }));
  const lastEvent = timeline.at(-1);
  const nodeIds = new Set(nodes.results.map((node) => String(node.id)));
  const rootExecutionIds = nodes.results
    .filter((node) => node.parentExecutionId == null || !nodeIds.has(String(node.parentExecutionId)))
    .map((node) => String(node.id));
  return {
    orchestration: {
      ...orchestration,
      completenessMissing: parse(orchestration.completenessMissing),
    },
    nodes: nodes.results.map((node) => ({ ...node, completenessMissing: parse(node.completenessMissing) })),
    rootExecutionIds,
    relations: relations.results.map((relation) => ({ ...relation, metadata: parse(relation.metadata) })),
    timeline,
    timelinePage: {
      limit: timelineLimit,
      hasMore: hasMoreTimeline,
      nextCursor: hasMoreTimeline && lastEvent
        ? encodeReadCursor({ observedAt: String(lastEvent.observedAt), eventId: String(lastEvent.eventId) }) : null,
    },
  };
}
