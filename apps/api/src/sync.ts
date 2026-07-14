import type { Env } from './env';
import type { AgentIdentity } from './auth';
import { USER_PROJECT_WHERE } from './lib/visibility';

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
  /** Input requests this agent raised that are still awaiting a human decision. */
  pendingInputRequests: Array<{ id: string; taskKey: string | null; title: string; createdAt: string }>;
}

export async function computeUpdates(env: Env, agent: AgentIdentity, opts: { advanceCursor?: boolean } = {}): Promise<AgentUpdates> {
  const session = env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(agent.id));
  let cursor = await session.cursor();

  // A brand-new session (cursor 0) must NOT replay the whole event history as "new"
  // notices — start it at the current tip so it only hears about things going forward.
  if (cursor === 0) {
    const tip = await env.DB.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM events').first<{ m: number }>();
    cursor = tip?.m ?? 0;
    if (opts.advanceCursor !== false) await session.advanceCursor(cursor);
  }

  // New events since the cursor that concern this agent.
  const { results: rawEvents } = await env.DB.prepare(
    `SELECT e.rowid AS rid, e.verb, e.payload, e.actor_id AS actorId, e.subject_id AS subjectId, e.project_id AS projectId
     FROM events e WHERE e.rowid > ? ORDER BY e.rowid LIMIT 500`,
  ).bind(cursor).all<{ rid: number; verb: string; payload: string; actorId: string; subjectId: string; projectId: string }>();

  const heldTaskIds = new Set<string>();
  const heldRows = await env.DB.prepare(
    `SELECT id, key, title, status, claim_expires_at AS claimExpiresAt FROM tasks WHERE claimed_by = ?`,
  ).bind(agent.id).all<{ id: string; key: string; title: string; status: string; claimExpiresAt: string | null }>();
  for (const t of heldRows.results) heldTaskIds.add(t.id);

  // Dependency-unblocked, unclaimed tasks across active projects. Computed up front so
  // the "new task available" notice (PLNR-90) can confirm a freshly-created task is
  // actually claimable right now (not gated behind unfinished dependencies).
  const claimable = (
    await env.DB.prepare(
      `SELECT t.id, t.key, t.title, t.project_id AS projectId, t.priority
       FROM tasks t JOIN projects p ON p.id = t.project_id AND p.status = 'active'
       WHERE t.status = 'todo' AND t.claimed_by IS NULL
         AND ${USER_PROJECT_WHERE}
         AND NOT EXISTS (
           SELECT 1 FROM dependencies d JOIN tasks dt ON dt.id = d.depends_on_task_id
           WHERE d.task_id = t.id AND dt.status NOT IN ('done','cancelled'))
       ORDER BY t.priority DESC, t."order" LIMIT 20`,
    ).bind(agent.userId).all<AgentUpdates['claimable'][number]>()
  ).results;
  const claimableIds = new Set(claimable.map((t) => t.id));

  // Projects the agent's USER can reach — scopes broadcast messages/notices so an
  // agent never hears cross-tenant chatter (PLNR-96).
  const accessibleProjectIds = new Set(
    (await env.DB.prepare(`SELECT p.id FROM projects p WHERE ${USER_PROJECT_WHERE}`)
      .bind(agent.userId).all<{ id: string }>()).results.map((r) => r.id),
  );

  // Steers already delivered to this agent over the runtime channel (RUN-7): skip
  // them here so a daemon-injected steer isn't ALSO surfaced via notices (dedup).
  const runtimeDelivered = new Set(
    (await env.DB.prepare('SELECT message_id FROM runtime_deliveries WHERE agent_id = ?')
      .bind(agent.id).all<{ message_id: string }>()).results.map((r) => r.message_id),
  );

  const notices: string[] = [];
  let maxRid = cursor;
  for (const e of rawEvents) {
    maxRid = Math.max(maxRid, e.rid);
    if (e.actorId === agent.id) continue; // own actions aren't news
    const p = JSON.parse(e.payload) as Record<string, unknown>;
    if (e.verb === 'comment.posted' && typeof p.taskId === 'string' && heldTaskIds.has(p.taskId)) {
      notices.push(`New ${p.kind} on ${p.taskKey} (your task): "${p.body}"`);
    } else if (e.verb === 'message.sent' && !runtimeDelivered.has(e.subjectId) && (p.to === agent.id || (p.to === 'broadcast' && accessibleProjectIds.has(e.projectId)))) {
      notices.push(`Message from ${p.actorName ?? e.actorId}${p.refTaskId ? ` re ${p.refTaskId}` : ''}: "${p.body}"`);
    } else if (e.verb === 'task.requeued' && p.previousHolder === agent.id) {
      notices.push(`Your claim on ${p.key} expired — the task was requeued (${p.reason}).`);
    } else if (e.verb === 'task.released' && p.previousHolder === agent.id) {
      notices.push(`Your claim on ${p.key} was force-released by ${p.actorName ?? 'a supervisor'}.`);
    } else if (e.verb === 'signal.answered' && p.agentId === agent.id) {
      const where = p.taskKey ? ` (${p.taskKey} is back in the queue — re-claim to resume)` : '';
      notices.push(`Your input request "${p.title}" was answered: "${p.response}"${where}`);
    } else if (e.verb === 'task.created' && heldTaskIds.size === 0 && claimableIds.has(e.subjectId)) {
      // PLNR-90: nudge AVAILABLE agents (holding nothing — i.e. not heads-down draining
      // a plan) about a new, immediately-claimable task, so ad-hoc work gets picked up
      // dynamically instead of waiting for someone to poll. Heads-down agents aren't
      // distracted; the claimable list stays the authoritative queue for them.
      notices.push(`New task ${p.key} is up for grabs: "${p.title}" — claim_task it if you can take it on.`);
    }
    // NB (PLNR-25): we deliberately do NOT notice every task.done here. It fired for
    // every completed task to every agent — noise — and the claimable list is the
    // authoritative signal for "what can I pick up now". Relevance over volume.
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
       FROM comments c JOIN tasks t ON t.id = c.task_id JOIN projects p ON p.id = t.project_id
       WHERE t.claimed_by IS NULL AND c.status IN ('open','acknowledged') AND c.author_kind != 'agent'
         AND ${USER_PROJECT_WHERE}
       ORDER BY c.created_at LIMIT 10`,
    ).bind(agent.userId).all<AgentUpdates['unassignedComments'][number]>()
  ).results;

  // Recent direct/broadcast messages (last 10, regardless of cursor, for context).
  const messages = (
    await env.DB.prepare(
      `SELECT m.id, m.from_name AS "from", m.body, m.ref_task_id AS refTaskId, m.created_at AS createdAt
       FROM messages m JOIN projects p ON p.id = m.project_id
       WHERE (m.to_agent_id = ?2 OR (m.to_agent_id IS NULL AND ${USER_PROJECT_WHERE})) AND m.from_id != ?2
       ORDER BY m.created_at DESC LIMIT 10`,
    ).bind(agent.userId, agent.id).all<AgentUpdates['messages'][number]>()
  ).results;

  // Input requests this agent is still waiting on (so it doesn't re-ask or forget).
  const pendingInputRequests = (
    await env.DB.prepare(
      `SELECT s.id, t.key AS taskKey, s.title, s.created_at AS createdAt
       FROM signals s LEFT JOIN tasks t ON t.id = s.task_id
       WHERE s.agent_id = ? AND s.type = 'input_request' AND s.status = 'open'
       ORDER BY s.created_at`,
    ).bind(agent.id).all<AgentUpdates['pendingInputRequests'][number]>()
  ).results;

  if (opts.advanceCursor !== false && maxRid > cursor) {
    await session.advanceCursor(maxRid);
  }
  await session.touch();

  return { notices, openComments, unassignedComments, heldTasks: heldRows.results, claimable, messages, pendingInputRequests };
}

/**
 * Compact notices block appended to every MCP tool result (pushed-feeling updates
 * without polling). Policy (PLNR-25) — piggyback only what's URGENT to *this* agent:
 *  - direct messages / broadcasts, comments on tasks it holds, and its own claim
 *    being requeued or force-released (the `notices` list, cursor-gated so each
 *    fires once);
 *  - a nudge if it has unresolved comments blocking a finish.
 * Everything lower-urgency (the full claimable list, recent-message history, and —
 * for a heads-down agent — questions on tasks nobody holds) stays in my_updates so
 * an actively-working agent's context isn't padded on every call. Unassigned
 * questions still piggyback for IDLE agents (no held task), so they never vanish.
 */
export function formatNotices(u: AgentUpdates): string | null {
  const lines: string[] = [];
  for (const n of u.notices.slice(0, 5)) lines.push(`• ${n}`);
  if (u.openComments.length) {
    lines.push(`• ${u.openComments.length} unresolved comment(s) on your task(s) — resolve with resolve_comment before finishing.`);
  }
  // Only surface unheld-task questions on the piggyback to agents that aren't
  // already heads-down; working agents still see them via my_updates.
  if (u.heldTasks.length === 0) {
    for (const c of u.unassignedComments.slice(0, 3)) {
      lines.push(`• Unassigned ${c.kind} on ${c.taskKey} (no holder): "${c.body.slice(0, 90)}" — answer via resolve_comment if you can.`);
    }
  }
  if (!lines.length) return null;
  return `--- notices ---\n${lines.join('\n')}`;
}
