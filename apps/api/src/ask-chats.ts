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
  createdAt: string;
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
             ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1) AS lastMessage
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
    `SELECT id, role, content, sources_json AS sourcesJson, reasoning, trace_json AS traceJson,
            retrieval_mode AS mode, model, created_at AS createdAt
       FROM ask_messages WHERE thread_id = ? ORDER BY created_at, id`,
  ).bind(threadId).all<{
    id: string; role: 'user' | 'assistant'; content: string; sourcesJson: string; reasoning: string;
    traceJson: string; mode: 'semantic' | 'keyword' | null; model: string | null; createdAt: string;
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
    db.prepare('DELETE FROM ask_messages WHERE thread_id = ?').bind(threadId),
    db.prepare('DELETE FROM ask_threads WHERE id = ? AND user_id = ?').bind(threadId, userId),
  ]);
  return true;
}
