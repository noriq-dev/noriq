import type { Env } from './env';
import type { AgentIdentity } from './auth';

/**
 * Agent-scoped delta sync (ROADMAP Phase 1).
 *
 * Cursor model: the global events-table rowid, stored server-side in the agent's
 * AgentSession DO. No ack — the cursor auto-advances on delivery. Open comments
 * are STATE, not events: they are returned sticky on every call until resolved.
 */

export interface AgentUpdates {
  notices: string[];
  openComments: Array<{
    id: string; taskId: string; taskKey: string; kind: string; body: string; status: string; author: string;
  }>;
  heldTasks: Array<{ id: string; key: string; title: string; status: string; claimExpiresAt: string | null }>;
  /** Open comments on tasks NOBODY holds — visible to every agent so questions can't vanish. */
  unassignedComments: Array<{ id: string; taskId: string; taskKey: string; kind: string; body: string }>;
  claimable: Array<{ id: string; key: string; title: string; projectId: string; priority: number }>;
  messages: Array<{ id: string; from: string; body: string; refTaskId: string | null; createdAt: string }>;
}

export async function computeUpdates(env: Env, agent: AgentIdentity, opts: { advanceCursor?: boolean } = {}): Promise<AgentUpdates> {
  const session = env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(agent.id));
  const cursor = await session.cursor();

  // New events since the cursor that concern this agent.
  const { results: rawEvents } = await env.DB.prepare(
    `SELECT e.rowid AS rid, e.verb, e.payload, e.actor_id AS actorId, e.subject_id AS subjectId
     FROM events e WHERE e.rowid > ? ORDER BY e.rowid LIMIT 500`,
  ).bind(cursor).all<{ rid: number; verb: string; payload: string; actorId: string; subjectId: string }>();

  const heldTaskIds = new Set<string>();
  const heldRows = await env.DB.prepare(
    `SELECT id, key, title, status, claim_expires_at AS claimExpiresAt FROM tasks WHERE claimed_by = ?`,
  ).bind(agent.id).all<{ id: string; key: string; title: string; status: string; claimExpiresAt: string | null }>();
  for (const t of heldRows.results) heldTaskIds.add(t.id);

  const notices: string[] = [];
  let maxRid = cursor;
  for (const e of rawEvents) {
    maxRid = Math.max(maxRid, e.rid);
    if (e.actorId === agent.id) continue; // own actions aren't news
    const p = JSON.parse(e.payload) as Record<string, unknown>;
    if (e.verb === 'comment.posted' && typeof p.taskId === 'string' && heldTaskIds.has(p.taskId)) {
      notices.push(`New ${p.kind} on ${p.taskKey} (your task): "${p.body}"`);
    } else if (e.verb === 'message.sent' && (p.to === agent.id || p.to === 'broadcast')) {
      notices.push(`Message from ${p.actorName ?? e.actorId}${p.refTaskId ? ` re ${p.refTaskId}` : ''}: "${p.body}"`);
    } else if (e.verb === 'task.requeued' && p.previousHolder === agent.id) {
      notices.push(`Your claim on ${p.key} expired — the task was requeued (${p.reason}).`);
    } else if (e.verb === 'task.released' && p.previousHolder === agent.id) {
      notices.push(`Your claim on ${p.key} was force-released by ${p.actorName ?? 'a supervisor'}.`);
    } else if (e.verb === 'task.status_changed' && p.to === 'done') {
      // A completed task may unblock work — cheap signal, claimables below give truth.
      notices.push(`${p.key} is done — dependent tasks may now be claimable.`);
    }
  }

  // Sticky open comments on held tasks (state, not events — never cursor-gated).
  const openComments = heldTaskIds.size
    ? (
        await env.DB.prepare(
          `SELECT c.id, c.task_id AS taskId, t.key AS taskKey, c.kind, c.body, c.status, c.author_id AS author
           FROM comments c JOIN tasks t ON t.id = c.task_id
           WHERE t.claimed_by = ? AND c.status IN ('open','acknowledged') ORDER BY c.created_at`,
        ).bind(agent.id).all<AgentUpdates['openComments'][number]>()
      ).results
    : [];

  // Open comments on unclaimed tasks — sticky for everyone, so a question posted
  // to a task nobody holds still reaches an agent (dogfooding find, 2026-07-13).
  const unassignedComments = (
    await env.DB.prepare(
      `SELECT c.id, c.task_id AS taskId, t.key AS taskKey, c.kind, c.body
       FROM comments c JOIN tasks t ON t.id = c.task_id
       WHERE t.claimed_by IS NULL AND c.status IN ('open','acknowledged') AND c.author_kind != 'agent'
       ORDER BY c.created_at LIMIT 10`,
    ).all<AgentUpdates['unassignedComments'][number]>()
  ).results;

  // Dependency-unblocked, unclaimed tasks across active projects.
  const claimable = (
    await env.DB.prepare(
      `SELECT t.id, t.key, t.title, t.project_id AS projectId, t.priority
       FROM tasks t JOIN projects p ON p.id = t.project_id AND p.status = 'active'
       WHERE t.status = 'todo' AND t.claimed_by IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM dependencies d JOIN tasks dt ON dt.id = d.depends_on_task_id
           WHERE d.task_id = t.id AND dt.status NOT IN ('done','cancelled'))
       ORDER BY t.priority DESC, t."order" LIMIT 20`,
    ).all<AgentUpdates['claimable'][number]>()
  ).results;

  // Recent direct/broadcast messages (last 10, regardless of cursor, for context).
  const messages = (
    await env.DB.prepare(
      `SELECT m.id, m.from_name AS "from", m.body, m.ref_task_id AS refTaskId, m.created_at AS createdAt
       FROM messages m
       WHERE (m.to_agent_id = ? OR m.to_agent_id IS NULL) AND m.from_id != ?
       ORDER BY m.created_at DESC LIMIT 10`,
    ).bind(agent.id, agent.id).all<AgentUpdates['messages'][number]>()
  ).results;

  if (opts.advanceCursor !== false && maxRid > cursor) {
    await session.advanceCursor(maxRid);
  }
  await session.touch();

  return { notices, openComments, unassignedComments, heldTasks: heldRows.results, claimable, messages };
}

/** Compact notices block appended to every MCP tool result (pushed-feeling updates without polling). */
export function formatNotices(u: AgentUpdates): string | null {
  const lines: string[] = [];
  for (const n of u.notices.slice(0, 5)) lines.push(`• ${n}`);
  if (u.openComments.length) {
    lines.push(`• ${u.openComments.length} unresolved comment(s) on your task(s) — resolve with resolve_comment before finishing.`);
  }
  for (const c of u.unassignedComments.slice(0, 3)) {
    lines.push(`• Unassigned ${c.kind} on ${c.taskKey} (no holder): "${c.body.slice(0, 90)}" — answer via resolve_comment if you can.`);
  }
  if (!lines.length) return null;
  return `--- notices ---\n${lines.join('\n')}`;
}
