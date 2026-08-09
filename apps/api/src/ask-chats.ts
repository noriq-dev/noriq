// Durable user-owned Ask threads. This module contains no routing or inference logic: routes
// establish the signed-in user, then these helpers enforce ownership in every query.

import type { AskHistoryMessage, AskSource } from './ask';
import { newId, nowIso } from './lib/util';

export interface AskThreadSummary {
  id: string;
  title: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessage: string | null;
}

export interface StoredAskMessage extends AskHistoryMessage {
  id: string;
  sources: AskSource[];
  reasoning: string;
  trace: string[];
  mode: 'semantic' | 'keyword' | null;
  model: string | null;
  generationId: string | null;
  generationStatus: AskGenerationStatus | null;
  generationError: string | null;
  createdAt: string;
}

export type AskGenerationStatus = 'pending' | 'searching' | 'generating' | 'completed' | 'failed';
export const ASK_GENERATION_CANCELLED = 'generation cancelled by user';

export interface StoredAskGeneration {
  id: string;
  threadId: string;
  messageId: string;
  userId: string;
  question: string;
  history: AskHistoryMessage[];
  status: AskGenerationStatus;
  answer: string;
  reasoning: string;
  sources: AskSource[];
  trace: string[];
  mode: 'semantic' | 'keyword' | null;
  model: string | null;
  graphEnhanced: boolean;
  finishReason: string | null;
  truncated: boolean;
  error: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface AskThreadDetail extends AskThreadSummary {
  messages: StoredAskMessage[];
}

const titleFrom = (value: string): string => value.trim().replace(/\s+/g, ' ').slice(0, 100) || 'New chat';

const jsonArray = <T>(value: string | null): T[] => {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
};

export async function createAskThread(db: D1Database, userId: string, title: string): Promise<AskThreadSummary> {
  const id = newId('chat');
  const now = nowIso();
  const normalizedTitle = titleFrom(title);
  await db.prepare(
    'INSERT INTO ask_threads (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(id, userId, normalizedTitle, now, now).run();
  return { id, title: normalizedTitle, archivedAt: null, createdAt: now, updatedAt: now, messageCount: 0, lastMessage: null };
}

export async function listAskThreads(db: D1Database, userId: string, archived: boolean): Promise<AskThreadSummary[]> {
  const archivedClause = archived ? 'IS NOT NULL' : 'IS NULL';
  const { results } = await db.prepare(
    `SELECT t.id, t.title, t.archived_at AS archivedAt, t.created_at AS createdAt, t.updated_at AS updatedAt,
            COUNT(m.id) AS messageCount,
            (SELECT content FROM ask_messages latest WHERE latest.thread_id = t.id
             ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1) AS lastMessage
       FROM ask_threads t
       LEFT JOIN ask_messages m ON m.thread_id = t.id
      WHERE t.user_id = ? AND t.archived_at ${archivedClause}
      GROUP BY t.id, t.title, t.archived_at, t.created_at, t.updated_at
      ORDER BY t.updated_at DESC
      LIMIT 100`,
  ).bind(userId).all<Omit<AskThreadSummary, 'messageCount'> & { messageCount: number | string }>();
  return results.map((row) => ({ ...row, messageCount: Number(row.messageCount) }));
}

export async function getAskThread(db: D1Database, userId: string, threadId: string): Promise<AskThreadDetail | null> {
  const thread = await db.prepare(
    `SELECT id, title, archived_at AS archivedAt, created_at AS createdAt, updated_at AS updatedAt
       FROM ask_threads WHERE id = ? AND user_id = ?`,
  ).bind(threadId, userId).first<Omit<AskThreadSummary, 'messageCount' | 'lastMessage'>>();
  if (!thread) return null;
  const { results } = await db.prepare(
    `SELECT m.id, m.role, m.content, m.sources_json AS sourcesJson, m.reasoning, m.trace_json AS traceJson,
            m.retrieval_mode AS mode, m.model, m.created_at AS createdAt,
            g.id AS generationId, g.status AS generationStatus, g.error AS generationError
       FROM ask_messages m
       LEFT JOIN ask_generations g ON g.message_id = m.id
      WHERE m.thread_id = ? ORDER BY m.created_at, m.rowid`,
  ).bind(threadId).all<{
    id: string; role: 'user' | 'assistant'; content: string; sourcesJson: string; reasoning: string;
    traceJson: string; mode: 'semantic' | 'keyword' | null; model: string | null; createdAt: string;
    generationId: string | null; generationStatus: AskGenerationStatus | null; generationError: string | null;
  }>();
  const messages = results.map((row): StoredAskMessage => ({
    id: row.id,
    role: row.role,
    content: row.content,
    sources: jsonArray<AskSource>(row.sourcesJson),
    reasoning: row.reasoning,
    trace: jsonArray<string>(row.traceJson).filter((item): item is string => typeof item === 'string'),
    mode: row.mode,
    model: row.model,
    generationId: row.generationId,
    generationStatus: row.generationStatus,
    generationError: row.generationError,
    createdAt: row.createdAt,
  }));
  return {
    ...thread,
    messageCount: messages.length,
    lastMessage: messages.at(-1)?.content ?? null,
    messages,
  };
}

export async function askThreadHistory(
  db: D1Database,
  userId: string,
  threadId: string,
  limit = 12,
): Promise<{ thread: AskThreadSummary; history: AskHistoryMessage[] } | null> {
  const detail = await getAskThread(db, userId, threadId);
  if (!detail) return null;
  return {
    thread: detail,
    history: detail.messages.slice(-limit).map(({ role, content }) => ({ role, content })),
  };
}

export async function appendAskMessage(
  db: D1Database,
  userId: string,
  threadId: string,
  message: AskHistoryMessage & {
    sources?: AskSource[];
    reasoning?: string;
    trace?: string[];
    mode?: 'semantic' | 'keyword' | null;
    model?: string | null;
  },
): Promise<string> {
  const id = newId('msg');
  const now = nowIso();
  const owned = await db.prepare('SELECT id FROM ask_threads WHERE id = ? AND user_id = ?').bind(threadId, userId).first();
  if (!owned) throw new Error('chat not found');
  await db.batch([
    db.prepare(
      `INSERT INTO ask_messages
        (id, thread_id, role, content, sources_json, reasoning, trace_json, retrieval_mode, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, threadId, message.role, message.content, JSON.stringify(message.sources ?? []), message.reasoning ?? '',
      JSON.stringify(message.trace ?? []), message.mode ?? null, message.model ?? null, now,
    ),
    db.prepare('UPDATE ask_threads SET updated_at = ? WHERE id = ? AND user_id = ?').bind(now, threadId, userId),
  ]);
  return id;
}

/** Atomically append the user's prompt, reserve exactly one assistant message, and create the
 * durable generation record that an alarm worker and reconnecting clients share. */
export async function createAskGeneration(
  db: D1Database,
  userId: string,
  threadId: string,
  question: string,
  history: AskHistoryMessage[],
): Promise<StoredAskGeneration> {
  const id = newId('askgen');
  const userMessageId = newId('msg');
  const messageId = newId('msg');
  const now = nowIso();
  // The pair used to share a timestamp and reload ordered timestamp ties by randomized ids,
  // which could put the reserved assistant row before its prompt. Keep rowid as the legacy tie
  // breaker above, and make every newly-created pair unambiguous on its own.
  const assistantAt = new Date(Date.parse(now) + 1).toISOString();
  const owned = await db.prepare('SELECT id FROM ask_threads WHERE id = ? AND user_id = ?').bind(threadId, userId).first();
  if (!owned) throw new Error('chat not found');
  await db.batch([
    db.prepare(
      `INSERT INTO ask_messages
        (id, thread_id, role, content, sources_json, reasoning, trace_json, retrieval_mode, model, created_at)
       VALUES (?, ?, 'user', ?, '[]', '', '[]', NULL, NULL, ?)`,
    ).bind(userMessageId, threadId, question, now),
    db.prepare(
      `INSERT INTO ask_messages
        (id, thread_id, role, content, sources_json, reasoning, trace_json, retrieval_mode, model, created_at)
       VALUES (?, ?, 'assistant', '', '[]', '', '[]', NULL, NULL, ?)`,
    ).bind(messageId, threadId, assistantAt),
    db.prepare(
      `INSERT INTO ask_generations
        (id, thread_id, message_id, user_id, question, history_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).bind(id, threadId, messageId, userId, question, JSON.stringify(history), now, now),
    db.prepare('UPDATE ask_threads SET updated_at = ? WHERE id = ? AND user_id = ?').bind(now, threadId, userId),
  ]);
  return {
    id, threadId, messageId, userId, question, history, status: 'pending', answer: '', reasoning: '',
    sources: [], trace: [], mode: null, model: null, graphEnhanced: false, finishReason: null,
    truncated: false, error: null, revision: 0, createdAt: now, updatedAt: now,
  };
}

const generationFromRow = (row: {
  id: string; threadId: string; messageId: string; userId: string; question: string; historyJson: string;
  status: AskGenerationStatus; answer: string; reasoning: string; sourcesJson: string; traceJson: string;
  mode: 'semantic' | 'keyword' | null; model: string | null; graphEnhanced: number; finishReason: string | null;
  truncated: number; error: string | null; revision: number; createdAt: string; updatedAt: string;
}): StoredAskGeneration => ({
  id: row.id,
  threadId: row.threadId,
  messageId: row.messageId,
  userId: row.userId,
  question: row.question,
  history: jsonArray<AskHistoryMessage>(row.historyJson),
  status: row.status,
  answer: row.answer,
  reasoning: row.reasoning,
  sources: jsonArray<AskSource>(row.sourcesJson),
  trace: jsonArray<string>(row.traceJson),
  mode: row.mode,
  model: row.model,
  graphEnhanced: row.graphEnhanced === 1,
  finishReason: row.finishReason,
  truncated: row.truncated === 1,
  error: row.error,
  revision: Number(row.revision),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export async function getAskGeneration(
  db: D1Database,
  generationId: string,
  userId?: string,
): Promise<StoredAskGeneration | null> {
  const owner = userId ? ' AND user_id = ?' : '';
  const row = await db.prepare(
    `SELECT id, thread_id AS threadId, message_id AS messageId, user_id AS userId, question,
            history_json AS historyJson, status, answer, reasoning, sources_json AS sourcesJson,
            trace_json AS traceJson, retrieval_mode AS mode, model, graph_enhanced AS graphEnhanced,
            finish_reason AS finishReason, truncated, error, revision,
            created_at AS createdAt, updated_at AS updatedAt
       FROM ask_generations WHERE id = ?${owner}`,
  ).bind(...(userId ? [generationId, userId] : [generationId])).first<Parameters<typeof generationFromRow>[0]>();
  return row ? generationFromRow(row) : null;
}

export async function updateAskGeneration(
  db: D1Database,
  generationId: string,
  patch: Pick<StoredAskGeneration, 'status' | 'answer' | 'reasoning' | 'sources' | 'trace' | 'mode' | 'model' | 'graphEnhanced'>,
): Promise<boolean> {
  const now = nowIso();
  const result = await db.prepare(
    `UPDATE ask_generations
        SET status = ?, answer = ?, reasoning = ?, sources_json = ?, trace_json = ?,
            retrieval_mode = ?, model = ?, graph_enhanced = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND status NOT IN ('completed', 'failed')`,
  ).bind(
    patch.status, patch.answer, patch.reasoning, JSON.stringify(patch.sources), JSON.stringify(patch.trace),
    patch.mode, patch.model, patch.graphEnhanced ? 1 : 0, now, generationId,
  ).run();
  if ((result.meta.changes ?? 0) < 1) return false;
  await db.prepare(
    `UPDATE ask_messages
        SET content = ?, sources_json = ?, reasoning = ?, trace_json = ?, retrieval_mode = ?, model = ?
      WHERE id = (SELECT message_id FROM ask_generations WHERE id = ?)`,
  ).bind(
    patch.answer, JSON.stringify(patch.sources), patch.reasoning, JSON.stringify(patch.trace), patch.mode, patch.model,
    generationId,
  ).run();
  return true;
}

export async function completeAskGeneration(
  db: D1Database,
  generationId: string,
  finishReason: string | null,
  truncated: boolean,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE ask_generations
        SET status = 'completed', finish_reason = ?, truncated = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND status NOT IN ('completed', 'failed')`,
  ).bind(finishReason, truncated ? 1 : 0, nowIso(), generationId).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function failAskGeneration(db: D1Database, generationId: string, error: string): Promise<void> {
  await db.prepare(
    `UPDATE ask_generations
        SET status = 'failed', error = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND status NOT IN ('completed', 'failed')`,
  ).bind(error.slice(0, 1000), nowIso(), generationId).run();
}

/** Stop one user-owned generation while preserving its partial assistant message. A cancelled
 * generation uses the existing terminal `failed` state so this remains compatible with the
 * additive-only D1 schema; the sentinel lets streams and clients present cancellation normally. */
export async function cancelAskGeneration(db: D1Database, userId: string, generationId: string): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE ask_generations
        SET status = 'failed', error = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND user_id = ? AND status NOT IN ('completed', 'failed')`,
  ).bind(ASK_GENERATION_CANCELLED, nowIso(), generationId, userId).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function setAskThreadArchived(
  db: D1Database,
  userId: string,
  threadId: string,
  archived: boolean,
): Promise<boolean> {
  const result = await db.prepare(
    'UPDATE ask_threads SET archived_at = ?, updated_at = ? WHERE id = ? AND user_id = ?',
  ).bind(archived ? nowIso() : null, nowIso(), threadId, userId).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteAskThread(db: D1Database, userId: string, threadId: string): Promise<boolean> {
  const owned = await db.prepare('SELECT id FROM ask_threads WHERE id = ? AND user_id = ?').bind(threadId, userId).first();
  if (!owned) return false;
  await db.batch([
    db.prepare('DELETE FROM ask_generations WHERE thread_id = ?').bind(threadId),
    db.prepare('DELETE FROM ask_messages WHERE thread_id = ?').bind(threadId),
    db.prepare('DELETE FROM ask_threads WHERE id = ? AND user_id = ?').bind(threadId, userId),
  ]);
  return true;
}
