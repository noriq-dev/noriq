import type { Env } from './env';
import type { AgentIdentity } from './auth';
import { TASK_NOT_IN_PROPOSED_PLAN, TASK_NOT_PHASE_BLOCKED, TASK_NOT_PROPOSED_SPINOFF, USER_PROJECT_WHERE, tokenProjectWhere } from './lib/visibility';
import type { ProjectMemoryStub, MemoryItemRecord } from './lib/project-memory';
import { nowIso } from './lib/util';
import { allocateBudget, fillGreedy, type SectionSpec } from './memory/context-pack';
import { classifyLead } from './memory/retrieval';
import { verifiedForBase, type CallerBaseScope } from './memory/verification';
import type {
  AuthorityLevel,
  ContextPackCitation,
  ContextPackMemoryExcerpt,
  ContextPackNotice,
  MemoryKind,
  ProjectMemoryChangeSummary,
  ProjectMemoryNearbyWork,
  ProjectMemoryPulse,
  ProjectMemoryPulseSectionId,
  ProjectMemoryStaleWarning,
} from '@noriq-dev/shared';

/**
 * Agent-scoped delta sync (ROADMAP Phase 1).
 *
 * Cursor model: events.global_seq — a monotonic counter that only ever climbs
 * (PLNR-111), stored server-side in the agent's AgentSession DO. No ack — the cursor
 * auto-advances on delivery. (The table's rowid is NOT usable here: events.id is a
 * TEXT PK so rowid is non-AUTOINCREMENT and gets REUSED after deleteProject removes the
 * max row, which would silently exclude a later event from an agent already past it.)
 * Open comments
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
  /** PLNR-268: this agent's own localized project — the SAME scoping computeUpdates already
   *  applies internally to claimable/messages/comments above, exposed so get_briefing can scope
   *  its separately-bounded memory pulse (`assembleProjectMemoryPulse`) to it without a second
   *  query. `null` for a copilot that has never localized (roams every accessible project) — a
   *  memory pulse genuinely has no single project to be about then, not a failed fetch. */
  agentProjectId: string | null;
  /** PLNR-268: memory-subsystem changes since this agent's OWN cursor — the SAME events.global_seq
   *  cursor every notice above already advances on (CLAUDE.md: never a second cursor). Compact
   *  metadata only (entityType/kind/memoryItemId/timestamp) — no memory STATEMENT text ever rides
   *  this field (§13): it sits next to `notices`, close enough to plain status prose that
   *  untrusted memory content must stay out of it. get_briefing's separately-assembled `memory`
   *  block carries the full, clearly-evidence-framed excerpt instead. */
  memoryChanges: ProjectMemoryChangeSummary[];
}

/** Bounded — mirrors how many other-verb notices already cap themselves (e.g. unassignedComments
 *  LIMIT 10 below); a burst of memory activity should not crowd out the rest of this delta. */
const MEMORY_CHANGES_LIMIT = 10;

export async function computeUpdates(
  env: Env,
  agent: AgentIdentity,
  opts: { advanceCursor?: boolean; oauthTokenId?: string | null } = {},
): Promise<AgentUpdates> {
  // The token's own project scope (RUN-38). This feed is what an agent is TOLD exists —
  // claimable work, notices, broadcast chatter — so leaving it unscoped would advertise
  // projects the credential cannot actually touch: the agent would see the work, try it, and
  // be refused by the tool guard. Narrow the offer, not just the action.
  const tokenId = opts.oauthTokenId ?? null;
  const session = env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(agent.id));
  let cursor = await session.cursor();

  // A brand-new session (cursor 0) must NOT replay the whole event history as "new"
  // notices — start it at the current tip so it only hears about things going forward.
  if (cursor === 0) {
    const tip = await env.DB.prepare('SELECT COALESCE(MAX(global_seq), 0) AS m FROM events').first<{ m: number }>();
    cursor = tip?.m ?? 0;
    if (opts.advanceCursor !== false) await session.advanceCursor(cursor);
  }

  // New events since the cursor that concern this agent.
  const { results: rawEvents } = await env.DB.prepare(
    `SELECT e.global_seq AS rid, e.verb, e.payload, e.actor_id AS actorId, e.subject_id AS subjectId, e.project_id AS projectId, e.created_at AS createdAt
     FROM events e WHERE e.global_seq > ? ORDER BY e.global_seq LIMIT 500`,
  ).bind(cursor).all<{ rid: number; verb: string; payload: string; actorId: string; subjectId: string; projectId: string; createdAt: string }>();

  const heldTaskIds = new Set<string>();
  const heldRows = await env.DB.prepare(
    `SELECT id, key, title, status, claim_expires_at AS claimExpiresAt FROM tasks WHERE claimed_by = ?`,
  ).bind(agent.id).all<{ id: string; key: string; title: string; status: string; claimExpiresAt: string | null }>();
  for (const t of heldRows.results) heldTaskIds.add(t.id);

  // The agent's LOCAL project (set when it scopes via set_agent_identity or its first
  // claim). my_updates is scoped to it so an agent working one project doesn't see
  // other projects' claimable tasks / questions / broadcasts (PLNR-142) — even ones the
  // same user owns. NULL for a not-yet-localized agent → fall back to the user-wide view
  // (via `?2 IS NULL`) so a fresh agent can still discover work to pick up.
  const agentProjectId = (
    await env.DB.prepare('SELECT project_id AS pid FROM agents WHERE id = ?').bind(agent.id).first<{ pid: string | null }>()
  )?.pid ?? null;

  // Dependency-unblocked, unclaimed tasks in the agent's project (user-wide if it has
  // none yet). Computed up front so the "new task available" notice (PLNR-90) can
  // confirm a freshly-created task is actually claimable now (not dependency-gated).
  const claimable = (
    await env.DB.prepare(
      `SELECT t.id, t.key, t.title, t.project_id AS projectId, t.priority
       FROM tasks t JOIN projects p ON p.id = t.project_id AND p.status = 'active'
       WHERE t.status = 'todo' AND t.claimed_by IS NULL AND t.failed_at IS NULL
         AND ${USER_PROJECT_WHERE}
         AND ${tokenProjectWhere('?3')}
         AND (?2 IS NULL OR t.project_id = ?2)
         AND NOT EXISTS (
           SELECT 1 FROM dependencies d JOIN tasks dt ON dt.id = d.depends_on_task_id
           WHERE d.task_id = t.id AND dt.status NOT IN ('done','cancelled'))
         AND ${TASK_NOT_IN_PROPOSED_PLAN}
         AND ${TASK_NOT_PROPOSED_SPINOFF}
         AND ${TASK_NOT_PHASE_BLOCKED}
       -- ASC is most-urgent-first: priority 0 is P0 (PLNR-231), not the bottom of the scale.
       ORDER BY t.priority ASC, t."order" LIMIT 20`,
    ).bind(agent.userId, agentProjectId, tokenId).all<AgentUpdates['claimable'][number]>()
  ).results;

  // Nudge eligibility for freshly-created tasks (PLNR-90) is checked against the REAL
  // claimability predicate, not the top-20 display list above — a new task that 20
  // higher-priority ones outrank is still claimable, and an idle agent still wants to
  // hear about it. Only the ids in this event window are checked, so it stays cheap.
  const newTaskIds = [...new Set(rawEvents.filter((e) => e.verb === 'task.created' && e.actorId !== agent.id).map((e) => e.subjectId))];
  const nudgeableIds = new Set<string>();
  if (heldTaskIds.size === 0 && newTaskIds.length) {
    const { results } = await env.DB.prepare(
      `SELECT t.id
       FROM tasks t JOIN projects p ON p.id = t.project_id AND p.status = 'active'
       WHERE t.id IN (${newTaskIds.map((_, i) => `?${i + 4}`).join(',')})
         AND t.status = 'todo' AND t.claimed_by IS NULL AND t.failed_at IS NULL
         AND ${USER_PROJECT_WHERE}
         AND ${tokenProjectWhere('?3')}
         AND (?2 IS NULL OR t.project_id = ?2)
         AND NOT EXISTS (
           SELECT 1 FROM dependencies d JOIN tasks dt ON dt.id = d.depends_on_task_id
           WHERE d.task_id = t.id AND dt.status NOT IN ('done','cancelled'))
         AND ${TASK_NOT_IN_PROPOSED_PLAN}
         AND ${TASK_NOT_PROPOSED_SPINOFF}
         AND ${TASK_NOT_PHASE_BLOCKED}`,
    ).bind(agent.userId, agentProjectId, tokenId, ...newTaskIds).all<{ id: string }>();
    for (const r of results) nudgeableIds.add(r.id);
  }

  // Projects the agent's USER can reach — scopes broadcast messages/notices so an
  // agent never hears cross-tenant chatter (PLNR-96).
  const accessibleProjectIds = new Set(
    (await env.DB.prepare(
      `SELECT p.id FROM projects p WHERE ${USER_PROJECT_WHERE} AND ${tokenProjectWhere('?3')} AND (?2 IS NULL OR p.id = ?2)`,
    ).bind(agent.userId, agentProjectId, tokenId).all<{ id: string }>()).results.map((r) => r.id),
  );

  // Steers already delivered to this agent over the runtime channel (RUN-7): skip
  // them here so a daemon-injected steer isn't ALSO surfaced via notices (dedup).
  const runtimeDelivered = new Set(
    (await env.DB.prepare('SELECT message_id FROM runtime_deliveries WHERE agent_id = ?')
      .bind(agent.id).all<{ message_id: string }>()).results.map((r) => r.message_id),
  );

  const notices: string[] = [];
  const memoryChanges: ProjectMemoryChangeSummary[] = [];
  let maxRid = cursor;
  for (const e of rawEvents) {
    maxRid = Math.max(maxRid, e.rid);
    if (e.actorId === agent.id) continue; // own actions aren't news
    const p = JSON.parse(e.payload) as Record<string, unknown>;
    if (e.verb === 'comment.posted' && !runtimeDelivered.has(e.subjectId) && typeof p.taskId === 'string' && heldTaskIds.has(p.taskId)) {
      notices.push(`New ${p.kind} on ${p.taskKey} (your task): "${p.body}"`);
    } else if (e.verb === 'message.sent' && !runtimeDelivered.has(e.subjectId) && (p.to === agent.id || (p.to === 'broadcast' && accessibleProjectIds.has(e.projectId)))) {
      notices.push(`Message from ${p.actorName ?? e.actorId}${p.refTaskId ? ` re ${p.refTaskId}` : ''}: "${p.body}"`);
    } else if (e.verb === 'task.handed_off' && p.toAgentId === agent.id) {
      // PLNR-122: directed handoff — the target must hear even mid-work, so this rides
      // the notices channel like a comment does (not the idle-only nudge path).
      notices.push(`${p.actorName ?? 'An agent'} handed you ${p.key}: "${p.title}"${p.note ? ` — ${p.note}` : ''}. It is claimed under your name — work it, or release it if you can't.`);
    } else if (e.verb === 'task.requeued' && p.previousHolder === agent.id) {
      notices.push(`Your claim on ${p.key} expired — the task was requeued (${p.reason}).`);
    } else if (e.verb === 'task.released' && p.previousHolder === agent.id) {
      notices.push(`Your claim on ${p.key} was force-released by ${p.actorName ?? 'a supervisor'}.`);
    } else if (e.verb === 'signal.answered' && p.agentId === agent.id) {
      const where = p.taskKey ? ` (${p.taskKey} is back in the queue — re-claim to resume)` : '';
      notices.push(`Your input request "${p.title}" was answered: "${p.response}"${where}`);
    } else if (e.verb === 'lock.denied' && Array.isArray(p.conflicts)) {
      // PLNR-207: a peer was blocked on a file YOU hold. Surface it to the holder (the event
      // actor is the requester, already skipped above) so they can coordinate or release.
      const mine = (p.conflicts as Array<{ holderAgentId?: string; path?: string; taskKey?: string | null }>).filter((c) => c.holderAgentId === agent.id);
      if (mine.length) {
        const paths = [...new Set(mine.map((c) => c.path))].join(', ');
        const tk = mine.find((c) => c.taskKey)?.taskKey;
        notices.push(`${p.actorName ?? 'Another agent'} is blocked on ${paths} — file(s) you hold a lock on${tk ? ` for ${tk}` : ''}. Coordinate (send_message / handoff_task) or release_lock when you're done.`);
      }
    } else if (e.verb === 'lock.force_released' && p.previousHolder === agent.id) {
      notices.push(`Your file lock on ${p.path} was force-released by ${p.actorName ?? 'a supervisor'}.`);
    } else if (e.verb === 'lock.expired' && Array.isArray(p.holders) && (p.holders as string[]).includes(agent.id)) {
      const paths = Array.isArray(p.paths) ? (p.paths as string[]).filter((_, i) => (p.holders as string[])[i] === agent.id) : [];
      notices.push(`Your file lock${paths.length === 1 ? '' : 's'} on ${paths.join(', ')} expired (idle past the lock TTL) — re-acquire before editing again.`);
    } else if (e.verb === 'task.created' && heldTaskIds.size === 0 && nudgeableIds.has(e.subjectId)) {
      // PLNR-90: nudge AVAILABLE agents (holding nothing — i.e. not heads-down draining
      // a plan) about a new, immediately-claimable task, so ad-hoc work gets picked up
      // dynamically instead of waiting for someone to poll. Heads-down agents aren't
      // distracted; the claimable list stays the authoritative queue for them.
      notices.push(`New task ${p.key} is up for grabs: "${p.title}" — claim_task it if you can take it on.`);
    } else if (
      e.verb === 'memory.changed' && memoryChanges.length < MEMORY_CHANGES_LIMIT
      && accessibleProjectIds.has(e.projectId) && (agentProjectId === null || e.projectId === agentProjectId)
    ) {
      // PLNR-268: per-agent memory-change cursoring, reusing this SAME events.global_seq cursor
      // (CLAUDE.md: never a second one) — the memory outbox already delivers every canonical
      // change here (PLNR-247), so this is compact metadata only, NOT the `notices` prose channel
      // (§13: no memory statement text belongs anywhere close to instruction-adjacent status text).
      const entityType = typeof p.entityType === 'string' ? p.entityType : 'unknown';
      memoryChanges.push({
        entityType,
        kind: typeof p.kind === 'string' ? p.kind : null,
        // `memory_item` creation carries the new memory's id as the outbox row's OWN subject_id
        // (do/ProjectMemory.ts's recordMemory), never in its payload — every other entityType that
        // names one at all (validity_transition/authority_transition/feedback) puts it in the
        // payload instead.
        memoryItemId: entityType === 'memory_item' ? e.subjectId : (typeof p.memoryItemId === 'string' ? p.memoryItemId : null),
        at: e.createdAt,
      });
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
         AND ${tokenProjectWhere('?3')}
         AND (?2 IS NULL OR t.project_id = ?2)
       ORDER BY c.created_at LIMIT 10`,
    ).bind(agent.userId, agentProjectId, tokenId).all<AgentUpdates['unassignedComments'][number]>()
  ).results;

  // Recent direct/broadcast messages (last 10, regardless of cursor, for context).
  const messages = (
    await env.DB.prepare(
      `SELECT m.id, m.from_name AS "from", m.body, m.ref_task_id AS refTaskId, m.created_at AS createdAt
       FROM messages m JOIN projects p ON p.id = m.project_id
       WHERE (m.to_agent_id = ?2 OR (m.to_agent_id IS NULL AND ${USER_PROJECT_WHERE} AND ${tokenProjectWhere('?4')} AND (?3 IS NULL OR m.project_id = ?3))) AND m.from_id != ?2
       ORDER BY m.created_at DESC LIMIT 10`,
    ).bind(agent.userId, agent.id, agentProjectId, tokenId).all<AgentUpdates['messages'][number]>()
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

  return {
    notices, openComments, unassignedComments, heldTasks: heldRows.results, claimable, messages, pendingInputRequests,
    agentProjectId, memoryChanges,
  };
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

// ---------------------------------------------------------------------------------------------
// PLNR-268: get_briefing's bounded, project-scoped "memory pulse" — recent project-memory
// activity surfaced at session start, ALONGSIDE (never instead of) the coordination facts
// `computeUpdates` above already returns. Reuses context-pack.ts's (PLNR-267) section/budget
// machinery rather than re-deriving it, but this is NOT a small ContextPack: get_briefing has no
// task to anchor a graph seed or a similarity search to (it is the FIRST call of a session,
// before any task is claimed), so this composes a project-WIDE "what changed / what's active /
// what's still unresolved" pulse from the `events` table's own `memory.changed` deliveries
// (PLNR-247) instead.
//
// WHY EVENTS, NOT A NEW ProjectMemory RPC (discretion, resolved): `searchProjectMemory` only
// returns candidates for a query/seed/id it is given (see its own source in do/ProjectMemory.ts)
// — there is no "list current decisions" RPC, and this task's own anticipatedFiles deliberately
// exclude do/ProjectMemory.ts. The `events` table already carries every `memory.changed` outbox
// delivery with the SAME global_seq cursor `computeUpdates` reads above — a bounded recency query
// against it is real retrieval composed from what already ships, not a heuristic and not a new
// store or cursor.
// ---------------------------------------------------------------------------------------------

// Small and FIXED, unlike context-pack.ts's caller-tunable `tokenBudget`: get_briefing takes no
// arguments (it must stay a zero-friction "call this first"), and runs once per SESSION rather
// than once per task, so there is no per-call budget to honor — a smaller fixed cap is right.
export const BRIEFING_PULSE_CHAR_BUDGET = 4_000;
// Recent `memory.changed` rows scanned for candidates — bounded regardless of a project's total
// history, and deliberately larger than any one section's own item cap (below) so a run of
// same-kind events (e.g. a burst of hazards) doesn't starve every other section's candidates.
const PULSE_EVENT_WINDOW = 40;
// Distinct memoryItemIds enriched via getMemoryItem before section caps and the character budget
// trim further — the SAME "candidate ceiling distinct from the character budget" split
// context-pack.ts's MAX_CANDIDATES_PER_SECTION uses, sized for the whole pulse (one small event
// window feeds every section here, unlike context-pack's per-section retrieval calls).
const PULSE_MAX_CANDIDATES = 20;
// Fixed per-section item ceiling, enforced BEFORE the character budget trims further (locked
// decision: "a fixed maximum item count per section and a fixed character budget ... before
// assembly rather than trimmed after").
const PULSE_MAX_ITEMS_PER_SECTION = 5;

const PULSE_SECTION_ORDER: readonly SectionSpec<ProjectMemoryPulseSectionId>[] = [
  { id: 'active_decisions', weight: 3 },
  { id: 'known_hazards', weight: 2 },
  { id: 'unresolved_unknowns', weight: 2 },
  { id: 'stale_warnings', weight: 2 },
  { id: 'active_nearby_work', weight: 1 },
  { id: 'recent_changes', weight: 1 },
];

/** Which memoryItemId(s), if any, a `memory.changed` event's own (entityType, payload) names —
 *  read straight from the outbox row's own fields (see do/ProjectMemory.ts's outbox INSERTs),
 *  never guessed. `contradiction`/`node`/`edge`/`episode`/`generation-projection` carry no single
 *  memory-item id worth re-fetching here and are simply not candidates. */
function candidateMemoryIds(entityType: string, subjectId: string, payload: Record<string, unknown>): string[] {
  switch (entityType) {
    case 'memory_item':
      return [subjectId]; // recordMemory's outbox row uses the new memory's own id as subject_id
    case 'validity_transition':
    case 'authority_transition':
    case 'feedback':
      return typeof payload.memoryItemId === 'string' ? [payload.memoryItemId] : [];
    case 'decay':
      return Array.isArray(payload.decayedIds) ? (payload.decayedIds as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    default:
      return [];
  }
}

/** `MemoryItemRecord` (the stub's own live-read shape) -> `ContextPackMemoryExcerpt` (the shared,
 *  self-contained wire shape §13 renders memory in) — the SAME conversion context-pack.ts's
 *  `buildMemoryExcerpt` performs, reusing the SAME `classifyLead`/`verifiedForBase` primitives
 *  rather than a second judgment of what counts as a lead. get_briefing has no caller
 *  branch/baseId of its own (it takes no arguments) — `{ baseId: null, branch: null }` is the same
 *  "no scoping penalty, no scoping credit either" default `verifiedForBase` already documents for
 *  a plain query with no worktree behind it. */
function toMemoryExcerpt(row: MemoryItemRecord): ContextPackMemoryExcerpt {
  const caller: CallerBaseScope = { baseId: null, branch: null };
  const evidence: ContextPackCitation[] = row.evidence.map((e) => ({
    repositoryKey: e.repositoryKey,
    branch: e.branch,
    baseId: e.baseId,
    path: e.path,
    symbol: e.symbol,
    verificationState: e.verificationState as ContextPackCitation['verificationState'],
    lastVerifiedAt: e.lastVerifiedAt,
    lastVerifiedBaseId: e.lastVerifiedBaseId,
    lastVerifiedBranch: e.lastVerifiedBranch,
    verifiedForCaller: verifiedForBase(
      { verificationState: e.verificationState, lastVerifiedBaseId: e.lastVerifiedBaseId, lastVerifiedBranch: e.lastVerifiedBranch },
      caller,
    ),
  }));
  const { isLead, leadReasons } = classifyLead({
    authority: row.authority,
    validity: row.validity,
    evidenceVerification: row.evidence.map((e) => e.verificationState),
    evidenceVerifiedForCaller: evidence.map((e) => e.verifiedForCaller),
  });
  return {
    excerptKind: 'memory',
    id: row.id,
    memoryKind: row.kind as MemoryKind,
    statement: row.statement,
    authority: row.authority as AuthorityLevel,
    confidence: row.confidence,
    validity: row.validity,
    isLead,
    leadReasons,
    recordedByAgentId: row.recordedByAgentId,
    recordedAt: row.recordedAt,
    supersedesMemoryId: row.supersedesMemoryId,
    evidence,
  };
}

/**
 * Assemble get_briefing's bounded `memory` block for `projectId` (locked decision: exactly ONE
 * project — the caller's own localized one, never every project an agent can reach, which is what
 * keeps this bounded regardless of how many projects a copilot roams). NEVER THROWS: every
 * failure mode — a D1 error, the ProjectMemory DO throwing or being unreachable, a malformed event
 * payload — degrades to `null`, "no memory block", exactly like `loadPriorEffort` (lib/project-
 * memory.ts, §19) degrades `claim_task`'s `priorEffort`. get_briefing therefore needs NO try/catch
 * of its own around this call — this function's own contract already is one.
 *
 * "Active nearby work" is a plain D1 read (another agent's current claim), not memory retrieval —
 * it is assembled inside this SAME try/catch anyway (locked decision: "the whole memory block is
 * skipped if the ProjectMemory call fails", read here as one predictable degrade-together unit
 * rather than a partially-degraded one a client would have to reason about field by field).
 */
export async function assembleProjectMemoryPulse(env: Env, projectId: string, agentId: string): Promise<ProjectMemoryPulse | null> {
  try {
    const stub = env.PROJECT_MEMORY.get(env.PROJECT_MEMORY.idFromName(projectId)) as unknown as ProjectMemoryStub;

    // 1. Recent `memory.changed` events for this project — a bounded RECENCY window, not the
    // agent's own cursor (unlike `computeUpdates`'s `memoryChanges` delta above): get_briefing is
    // an orientation snapshot, the same for a brand-new agent as one resuming a long session.
    const { results: rawEvents } = await env.DB.prepare(
      `SELECT subject_id AS subjectId, payload, created_at AS createdAt
       FROM events WHERE project_id = ? AND verb = 'memory.changed'
       ORDER BY global_seq DESC LIMIT ?`,
    ).bind(projectId, PULSE_EVENT_WINDOW).all<{ subjectId: string; payload: string; createdAt: string }>();

    const recentChanges: ProjectMemoryChangeSummary[] = [];
    const candidateIds: string[] = [];
    const seenCandidates = new Set<string>();
    const transitionReasons = new Map<string, string | null>();

    for (const e of rawEvents) {
      let p: Record<string, unknown>;
      try { p = JSON.parse(e.payload) as Record<string, unknown>; } catch { continue; } // malformed row — skip, don't fail the pulse
      const entityType = typeof p.entityType === 'string' ? p.entityType : 'unknown';
      if (recentChanges.length < PULSE_MAX_ITEMS_PER_SECTION) {
        recentChanges.push({
          entityType,
          kind: typeof p.kind === 'string' ? p.kind : null,
          memoryItemId: entityType === 'memory_item' ? e.subjectId : (typeof p.memoryItemId === 'string' ? p.memoryItemId : null),
          at: e.createdAt,
        });
      }
      if (entityType === 'validity_transition' && typeof p.memoryItemId === 'string' && !transitionReasons.has(p.memoryItemId)) {
        transitionReasons.set(p.memoryItemId, typeof p.reason === 'string' ? p.reason : null);
      }
      for (const id of candidateMemoryIds(entityType, e.subjectId, p)) {
        if (seenCandidates.has(id) || seenCandidates.size >= PULSE_MAX_CANDIDATES) continue;
        seenCandidates.add(id);
        candidateIds.push(id);
      }
    }

    // 2. Enrich the bounded candidate set from the CANONICAL row — never from the event's own
    // (possibly stale-by-now) snapshot, same discipline as context-pack.ts's `buildMemoryExcerpt`.
    const rows = await Promise.all(candidateIds.map((id) => stub.getMemoryItem(projectId, id)));

    const decisionCandidates: ContextPackMemoryExcerpt[] = [];
    const hazardCandidates: ContextPackMemoryExcerpt[] = [];
    const unknownCandidates: ContextPackMemoryExcerpt[] = [];
    const staleCandidates: ProjectMemoryStaleWarning[] = [];
    for (const row of rows) {
      if (!row) continue; // decayed/erased between the event firing and this read — degrade, don't fail
      if (row.validity !== 'active') {
        // A memory that fell off 'active' surfaces ONLY as a stale warning — showing it again in
        // its kind-bucket as if still current would contradict the very label this section exists
        // to carry (locked decision: canonical validity, one truth, never two).
        staleCandidates.push({
          memoryItemId: row.id,
          kind: row.kind as MemoryKind,
          statement: row.statement,
          validity: row.validity,
          reason: transitionReasons.get(row.id) ?? null,
          at: row.recordedAt,
        });
        continue;
      }
      const excerpt = toMemoryExcerpt(row);
      if (row.kind === 'decision') decisionCandidates.push(excerpt);
      else if (row.kind === 'hazard') hazardCandidates.push(excerpt);
      else if (row.kind === 'unknown') unknownCandidates.push(excerpt);
      // learning/procedure/requirement/failed_approach: not surfaced in the briefing pulse today
      // (discretion: "fewer, genuinely useful sections beat all seven thin ones") — fully
      // available via search_project_memory/get_task_context once real work starts on a task.
    }

    // 3. Active nearby work — plain D1 (see this function's own doc comment for why it lives
    // inside this same try/catch rather than being unconditionally available).
    const { results: activeNearbyWorkRows } = await env.DB.prepare(
      `SELECT t.id AS taskId, t.key AS taskKey, t.title, t.claimed_by AS claimedByAgentId, t.status
       FROM tasks t WHERE t.project_id = ? AND t.claimed_by IS NOT NULL AND t.claimed_by != ?
       ORDER BY t.claim_expires_at DESC LIMIT ?`,
    ).bind(projectId, agentId, PULSE_MAX_ITEMS_PER_SECTION).all<ProjectMemoryNearbyWork>();

    // 4. Character-budget the sections — the SAME greedy, order-preserving fill context-pack.ts
    // uses (reused via its exports, not re-derived): a fixed per-section item cap first, then a
    // fixed character budget, and unused characters roll forward to the NEXT section in
    // PULSE_SECTION_ORDER so an empty early section doesn't waste its share.
    const allotments = allocateBudget(BRIEFING_PULSE_CHAR_BUDGET, PULSE_SECTION_ORDER);
    const notices: ContextPackNotice[] = [];
    let pool = 0;
    let charsUsed = 0;

    function fit<T>(id: ProjectMemoryPulseSectionId, candidates: T[]): T[] {
      const cap = (allotments[id] ?? 0) + pool;
      const { taken, used, truncated } = fillGreedy(candidates.slice(0, PULSE_MAX_ITEMS_PER_SECTION), cap);
      if (truncated) {
        notices.push({ kind: 'truncated', reason: `${id}: ${candidates.length - taken.length} more item(s) did not fit in ${cap} characters` });
      }
      pool = Math.max(0, cap - used);
      charsUsed += used;
      return taken;
    }

    // Fixed order (locked-decision-adjacent: "declared as data", context-pack.ts's own framing) —
    // matches PULSE_SECTION_ORDER exactly, so the rolling `pool` above lands on the section that
    // actually comes next.
    const activeDecisions = fit('active_decisions', decisionCandidates);
    const knownHazards = fit('known_hazards', hazardCandidates);
    const unresolvedUnknowns = fit('unresolved_unknowns', unknownCandidates);
    const staleWarnings = fit('stale_warnings', staleCandidates);
    const activeNearbyWork = fit('active_nearby_work', activeNearbyWorkRows);
    const recentChangesFit = fit('recent_changes', recentChanges);

    return {
      projectId,
      generatedAt: nowIso(),
      charBudget: BRIEFING_PULSE_CHAR_BUDGET,
      charsUsed,
      activeDecisions,
      knownHazards,
      unresolvedUnknowns,
      staleWarnings,
      activeNearbyWork,
      recentChanges: recentChangesFit,
      notices,
    };
  } catch (err) {
    console.warn(`assembleProjectMemoryPulse failed for project ${projectId}: ${String(err)}`);
    return null;
  }
}
