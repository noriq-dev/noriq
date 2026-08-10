import type { Env } from './env';
import { newId, nowIso } from './lib/util';
import { isMaintenanceMode, MAINTENANCE_MESSAGE } from './lib/maintenance';
import { projectRoleAllows, resolveAccountCapabilities, resolveProjectAccess, type ProjectAction } from './lib/authorization';
import type { Actor } from './do/ProjectRoom';

export type AskActionStatus = 'pending' | 'executing' | 'approved' | 'rejected' | 'failed';

export interface StoredAskAction {
  id: string;
  threadId: string;
  messageId: string;
  generationId: string | null;
  userId: string;
  projectId: string;
  type: string;
  summary: string;
  arguments: Record<string, unknown>;
  expected: Record<string, unknown>;
  requiredAction: ProjectAction;
  operationKey: string;
  status: AskActionStatus;
  result: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
}

export interface AskActionExecutor {
  /** Validate current target state, then execute the already-normalized arguments as this actor. */
  execute(input: {
    env: Env;
    action: StoredAskAction;
    actor: Actor;
    arguments: Record<string, unknown>;
    expected: Record<string, unknown>;
  }): Promise<unknown>;
}

export type AskActionExecutors = Record<string, AskActionExecutor>;

export class AskActionNotFoundError extends Error {}
export class AskActionDeniedError extends Error {}
export class AskActionConflictError extends Error {}
export class AskActionMaintenanceError extends Error {}

const MAX_ACTION_JSON_CHARS = 16_000;

const normalizeValue = (value: unknown): unknown => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Ask action values must be finite JSON numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, item]) => [key, normalizeValue(item)]));
  }
  throw new Error('Ask action values must be JSON-compatible');
};

export function normalizeAskActionPayload(value: unknown): { value: Record<string, unknown>; json: string } {
  const normalized = normalizeValue(value);
  if (!normalized || Array.isArray(normalized) || typeof normalized !== 'object') {
    throw new Error('Ask action payload must be an object');
  }
  const json = JSON.stringify(normalized);
  if (json.length > MAX_ACTION_JSON_CHARS) throw new Error('Ask action payload is too large');
  return { value: normalized as Record<string, unknown>, json };
}

const parseObject = (json: string): Record<string, unknown> => {
  try {
    const value = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
};

const fromRow = (row: {
  id: string; threadId: string; messageId: string; generationId: string | null; userId: string;
  projectId: string; type: string; summary: string; argumentsJson: string; expectedJson: string;
  requiredAction: ProjectAction; operationKey: string; status: AskActionStatus; resultJson: string | null;
  error: string | null; createdAt: string; updatedAt: string; settledAt: string | null;
}): StoredAskAction => ({
  id: row.id,
  threadId: row.threadId,
  messageId: row.messageId,
  generationId: row.generationId,
  userId: row.userId,
  projectId: row.projectId,
  type: row.type,
  summary: row.summary,
  arguments: parseObject(row.argumentsJson),
  expected: parseObject(row.expectedJson),
  requiredAction: row.requiredAction,
  operationKey: row.operationKey,
  status: row.status,
  result: row.resultJson ? JSON.parse(row.resultJson) : null,
  error: row.error,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  settledAt: row.settledAt,
});

const ACTION_SELECT = `SELECT id, thread_id AS threadId, message_id AS messageId, generation_id AS generationId,
  user_id AS userId, project_id AS projectId, type, summary, arguments_json AS argumentsJson,
  expected_json AS expectedJson, required_action AS requiredAction, operation_key AS operationKey,
  status, result_json AS resultJson, error, created_at AS createdAt, updated_at AS updatedAt,
  settled_at AS settledAt FROM ask_actions`;

export async function createAskAction(db: D1Database, input: {
  userId: string;
  threadId: string;
  messageId: string;
  generationId?: string | null;
  projectId: string;
  type: string;
  summary: string;
  arguments: unknown;
  expected?: unknown;
  requiredAction?: ProjectAction;
  operationKey: string;
}): Promise<StoredAskAction> {
  const args = normalizeAskActionPayload(input.arguments);
  const expected = normalizeAskActionPayload(input.expected ?? {});
  const summary = input.summary.trim().slice(0, 300);
  const type = input.type.trim().slice(0, 80);
  const operationKey = input.operationKey.trim().slice(0, 200);
  if (!summary || !type || !operationKey || !input.projectId) throw new Error('Ask action type, summary, project, and operation key are required');
  const requiredAction = input.requiredAction ?? 'contribute';
  if (!['view', 'contribute', 'manage', 'own'].includes(requiredAction)) throw new Error('Ask action permission is invalid');
  const owned = await db.prepare(
    `SELECT t.id FROM ask_threads t JOIN ask_messages m ON m.thread_id = t.id
     LEFT JOIN ask_generations g ON g.id = ?
     WHERE t.id = ? AND t.user_id = ? AND m.id = ? AND m.thread_id = t.id
       AND (? IS NULL OR (g.user_id = t.user_id AND g.thread_id = t.id AND g.message_id = m.id))`,
  ).bind(input.generationId ?? null, input.threadId, input.userId, input.messageId, input.generationId ?? null).first();
  if (!owned) throw new AskActionNotFoundError('chat message not found');
  const existing = await db.prepare(`${ACTION_SELECT} WHERE user_id = ? AND operation_key = ?`)
    .bind(input.userId, operationKey).first<Parameters<typeof fromRow>[0]>();
  if (existing) return fromRow(existing);
  const id = newId('askact');
  const now = nowIso();
  try {
    await db.prepare(
      `INSERT INTO ask_actions
        (id, thread_id, message_id, generation_id, user_id, project_id, type, summary, arguments_json,
         expected_json, required_action, operation_key, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).bind(
      id, input.threadId, input.messageId, input.generationId ?? null, input.userId, input.projectId,
      type, summary, args.json, expected.json, requiredAction, operationKey, now, now,
    ).run();
  } catch (error) {
    const raced = await db.prepare(`${ACTION_SELECT} WHERE user_id = ? AND operation_key = ?`)
      .bind(input.userId, operationKey).first<Parameters<typeof fromRow>[0]>();
    if (raced) return fromRow(raced);
    throw error;
  }
  if (input.generationId) {
    await db.prepare('UPDATE ask_generations SET revision = revision + 1, updated_at = ? WHERE id = ? AND user_id = ?')
      .bind(now, input.generationId, input.userId).run();
  }
  return (await getAskAction(db, input.userId, id))!;
}

export async function getAskAction(db: D1Database, userId: string, actionId: string): Promise<StoredAskAction | null> {
  const row = await db.prepare(`${ACTION_SELECT} WHERE id = ? AND user_id = ?`)
    .bind(actionId, userId).first<Parameters<typeof fromRow>[0]>();
  return row ? fromRow(row) : null;
}

export async function listAskActions(
  db: D1Database,
  userId: string,
  input: { threadId?: string; generationId?: string; messageId?: string } = {},
): Promise<StoredAskAction[]> {
  const where = ['user_id = ?'];
  const binds: unknown[] = [userId];
  if (input.threadId) { where.push('thread_id = ?'); binds.push(input.threadId); }
  if (input.generationId) { where.push('generation_id = ?'); binds.push(input.generationId); }
  if (input.messageId) { where.push('message_id = ?'); binds.push(input.messageId); }
  const { results } = await db.prepare(`${ACTION_SELECT} WHERE ${where.join(' AND ')} ORDER BY created_at, id`)
    .bind(...binds).all<Parameters<typeof fromRow>[0]>();
  return results.map(fromRow);
}

const bumpGeneration = async (db: D1Database, actionId: string, now: string) => {
  await db.prepare(
    `UPDATE ask_generations SET revision = revision + 1, updated_at = ?
     WHERE id = (SELECT generation_id FROM ask_actions WHERE id = ?)`,
  ).bind(now, actionId).run();
};

export async function rejectAskAction(db: D1Database, userId: string, actionId: string): Promise<StoredAskAction> {
  const now = nowIso();
  const changed = await db.prepare(
    `UPDATE ask_actions SET status = 'rejected', updated_at = ?, settled_at = ?
     WHERE id = ? AND user_id = ? AND status = 'pending'`,
  ).bind(now, now, actionId, userId).run();
  const action = await getAskAction(db, userId, actionId);
  if (!action) throw new AskActionNotFoundError('Ask action not found');
  if ((changed.meta.changes ?? 0) > 0) await bumpGeneration(db, actionId, now);
  if (action.status === 'executing') throw new AskActionConflictError('Ask action is already executing');
  return action;
}

export async function approveAskAction(
  env: Env,
  user: { id: string; name: string },
  actionId: string,
  executors: AskActionExecutors,
): Promise<StoredAskAction> {
  if (isMaintenanceMode(env)) throw new AskActionMaintenanceError(MAINTENANCE_MESSAGE);
  let action = await getAskAction(env.DB, user.id, actionId);
  if (!action) throw new AskActionNotFoundError('Ask action not found');
  if (action.status === 'approved' || action.status === 'rejected' || action.status === 'failed') return action;
  if (action.status === 'executing') throw new AskActionConflictError('Ask action is already executing');
  const account = await resolveAccountCapabilities(env.DB, user.id);
  if (account.disabled || account.accessMode !== 'read_write') {
    throw new AskActionDeniedError(account.disabled ? 'account is disabled' : 'account is read-only');
  }
  const access = await resolveProjectAccess(env.DB, user.id, action.projectId, { allowAdminOverride: true });
  if (!access.exists || !projectRoleAllows(access.role, 'view')) throw new AskActionNotFoundError('Ask action target not found');
  if (!projectRoleAllows(access.role, action.requiredAction)) {
    throw new AskActionDeniedError(`project ${action.requiredAction} role required`);
  }
  const executor = executors[action.type];
  if (!executor) {
    const now = nowIso();
    await env.DB.prepare(
      `UPDATE ask_actions SET status = 'failed', error = ?, updated_at = ?, settled_at = ?
       WHERE id = ? AND user_id = ? AND status = 'pending'`,
    ).bind('action type is no longer available', now, now, action.id, user.id).run();
    await bumpGeneration(env.DB, action.id, now);
    return (await getAskAction(env.DB, user.id, action.id))!;
  }
  const claimedAt = nowIso();
  const claimed = await env.DB.prepare(
    `UPDATE ask_actions SET status = 'executing', updated_at = ?
     WHERE id = ? AND user_id = ? AND status = 'pending'`,
  ).bind(claimedAt, action.id, user.id).run();
  if ((claimed.meta.changes ?? 0) < 1) {
    action = (await getAskAction(env.DB, user.id, action.id))!;
    if (action.status === 'approved' || action.status === 'rejected' || action.status === 'failed') return action;
    throw new AskActionConflictError('Ask action is already executing');
  }
  await bumpGeneration(env.DB, action.id, claimedAt);
  action = (await getAskAction(env.DB, user.id, action.id))!;
  try {
    const result = await executor.execute({
      env,
      action,
      actor: { kind: 'human', id: user.id, name: user.name },
      arguments: action.arguments,
      expected: action.expected,
    });
    const settledAt = nowIso();
    const encodedResult = JSON.stringify(result ?? null);
    const resultJson = encodedResult.length <= MAX_ACTION_JSON_CHARS
      ? encodedResult
      : JSON.stringify({ truncated: true, message: 'Action completed; result exceeded the storage limit.' });
    await env.DB.prepare(
      `UPDATE ask_actions SET status = 'approved', result_json = ?, error = NULL, updated_at = ?, settled_at = ?
       WHERE id = ? AND user_id = ? AND status = 'executing'`,
    ).bind(resultJson, settledAt, settledAt, action.id, user.id).run();
    await bumpGeneration(env.DB, action.id, settledAt);
  } catch (error) {
    const settledAt = nowIso();
    const message = error instanceof Error ? error.message : 'Ask action failed';
    await env.DB.prepare(
      `UPDATE ask_actions SET status = 'failed', error = ?, updated_at = ?, settled_at = ?
       WHERE id = ? AND user_id = ? AND status = 'executing'`,
    ).bind(message.slice(0, 1000), settledAt, settledAt, action.id, user.id).run();
    await bumpGeneration(env.DB, action.id, settledAt);
  }
  return (await getAskAction(env.DB, user.id, action.id))!;
}
